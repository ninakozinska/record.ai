// Uses Claude to title, prioritize and group notes.
//
// Two jobs:
//  - organizeNote: runs on every new/edited note (title, summary, group,
//    priority, tags, due date), reusing existing group names where they fit.
//  - reorganizeAll: looks at every note at once and tidies the group list
//    (merges near-duplicates, splits overloaded groups) and re-ranks priorities.
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { PRIORITIES } from './db.js';

// Read lazily so values from a .env file (loaded at startup) apply.
const model = () => process.env.CLAUDE_MODEL || 'claude-opus-5-5';
// Re-run the whole-collection tidy-up after this many newly organized notes.
const reorganizeEvery = () => Number(process.env.REORGANIZE_EVERY || 20);

const NoteAnalysis = z.object({
  title: z.string().describe('Short title, max ~8 words, in the language of the note'),
  summary: z.string().describe('One sentence summary of the note'),
  group: z.string().describe('Topic group name; reuse an existing group name when it fits'),
  priority: z.enum(PRIORITIES),
  priority_reason: z.string().describe('A few words explaining the priority'),
  tags: z.array(z.string()).describe('0-5 short lowercase tags'),
  due_date: z.string().nullable().describe('ISO date YYYY-MM-DD if the note implies a deadline, else null'),
});

const Reorganization = z.object({
  notes: z.array(
    z.object({
      id: z.string(),
      group: z.string(),
      priority: z.enum(PRIORITIES),
      priority_reason: z.string(),
    }),
  ),
});

const SYSTEM = `You organize a person's personal notes (typed, dictated, or photos).
Priorities:
- urgent: needs action today or is time-critical / has a deadline within ~2 days
- high: important action item or deadline within ~2 weeks
- normal: useful info or tasks without pressure
- low: reference material, someday/maybe, idle thoughts
Groups are short topic names (1-3 words, Title Case) like "Work", "Shopping", "Health", "Ideas", "Travel".
Prefer reusing an existing group. Create a new group only when none fits. Keep the total number of groups small (ideally under 12).
Dictated notes may contain speech-recognition errors; infer the intended meaning.
For photos, describe what matters (e.g. receipt total, whiteboard content, document type) in the summary.`;

export class Organizer {
  constructor({ store, imagesDir, onChange, client, log = console }) {
    this.store = store;
    this.imagesDir = imagesDir;
    this.onChange = onChange;
    this.log = log;
    this.enabled = !!(client || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    this.client = client || (this.enabled ? new Anthropic() : null);
    this.queue = new Set();
    this.running = false;
    this.reorganizing = false;
  }

  get status() {
    return {
      enabled: this.enabled,
      model: this.enabled ? model() : null,
      pending: this.queue.size,
      reorganizing: this.reorganizing,
    };
  }

  enqueue(id) {
    this.queue.add(id);
    queueMicrotask(() => this.drain());
  }

  resumePending() {
    for (const id of this.store.pendingIds()) this.queue.add(id);
    this.drain();
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.size) {
        const [id] = this.queue;
        this.queue.delete(id);
        await this.organizeNote(id);
      }
    } finally {
      this.running = false;
    }
  }

  async organizeNote(id) {
    const note = this.store.get(id);
    if (!note || note.deleted || note.ai_status !== 'pending') return;

    if (!this.enabled) {
      this.onChange(this.store.applyAi(id, fallbackAnalysis(note)));
      return;
    }

    const groups = this.store.groups().map((g) => `${g.name} (${g.count})`);
    const content = [];
    for (const name of note.images) {
      const img = this.readImage(name);
      if (img) content.push(img);
    }
    content.push({
      type: 'text',
      text:
        `Today is ${today()}.\n` +
        `Existing groups: ${groups.length ? groups.join(', ') : '(none yet)'}\n\n` +
        `<note created="${new Date(note.created_at).toISOString()}" images="${note.images.length}">\n` +
        `${note.text || '(no text — photo only)'}\n</note>\n\nAnalyze this note.`,
    });

    try {
      const result = await this.parse({
        max_tokens: 4000,
        system: SYSTEM,
        messages: [{ role: 'user', content }],
        output_config: { effort: 'low', format: betaZodOutputFormat(NoteAnalysis) },
      });
      // If the text/photos were edited while we were waiting, a newer run is
      // queued and this result is stale. (Changing only done/group/priority
      // doesn't invalidate it.)
      const current = this.store.get(id);
      if (!current || current.ai_status !== 'pending' || !sameContent(current, note)) return;
      this.onChange(this.store.applyAi(id, { ...result, status: 'done' }));
      this.maybeAutoReorganize();
    } catch (err) {
      this.log.error(`[organizer] note ${id}:`, err.message);
      this.onChange(this.store.applyAi(id, { ...fallbackAnalysis(note), status: 'error', error: err.message }));
    }
  }

  maybeAutoReorganize() {
    const count = Number(this.store.getMeta('organized_since_reorg') || 0) + 1;
    this.store.setMeta('organized_since_reorg', count);
    if (count >= reorganizeEvery()) {
      this.reorganizeAll().catch((err) => this.log.error('[organizer] reorganize:', err.message));
    }
  }

  async reorganizeAll() {
    if (!this.enabled) throw new Error('AI is not configured (set ANTHROPIC_API_KEY)');
    if (this.reorganizing) return { skipped: true };
    this.reorganizing = true;
    this.store.setMeta('organized_since_reorg', 0);
    try {
      const notes = this.store.active().filter((n) => !n.done);
      if (!notes.length) return { updated: 0 };
      const lines = notes.map((n) =>
        JSON.stringify({
          id: n.id,
          title: n.title,
          summary: n.summary || n.text.slice(0, 300),
          group: n.group,
          priority: n.priority,
          due: n.due_date,
          created: new Date(n.created_at).toISOString().slice(0, 10),
        }),
      );
      const result = await this.parse({
        max_tokens: 64000,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content:
              `Today is ${today()}. Here are all open notes, one JSON object per line:\n\n` +
              lines.join('\n') +
              `\n\nReorganize the whole collection: produce a clean, consistent set of groups ` +
              `(merge near-duplicates, split groups that mix unrelated topics) and re-rank ` +
              `priorities relative to each other and to today's date. Return every note id.`,
          },
        ],
        output_config: { effort: 'medium', format: betaZodOutputFormat(Reorganization) },
      }, { stream: true });

      let updated = 0;
      const ids = new Set(notes.map((n) => n.id));
      for (const r of result.notes) {
        if (!ids.has(r.id)) continue;
        const n = this.store.get(r.id);
        if (n.ai_group === r.group && n.ai_priority === r.priority) continue;
        this.onChange(
          this.store.applyAi(r.id, {
            group: r.group,
            priority: r.priority,
            priority_reason: r.priority_reason,
            status: n.ai_status === 'pending' ? 'pending' : 'done',
          }),
        );
        updated++;
      }
      return { updated };
    } finally {
      this.reorganizing = false;
    }
  }

  /**
   * Structured-output call with server-side refusal fallback. If the API
   * rejects the fallback parameter (e.g. on a proxy), retry without it.
   */
  async parse(params, { stream = false } = {}) {
    const base = { model: model(), ...params };
    const withFallback = {
      ...base,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    };
    const call = (p) =>
      stream
        ? this.client.beta.messages.stream(p).finalMessage()
        : this.client.beta.messages.parse(p);
    let msg;
    try {
      msg = await call(withFallback);
    } catch (err) {
      if (!(err instanceof Anthropic.BadRequestError)) throw err;
      msg = await call(base);
    }
    if (msg.stop_reason === 'refusal') throw new Error('Claude declined to process this note');
    if (msg.stop_reason === 'max_tokens') throw new Error('Response was cut off (max_tokens)');
    if (msg.parsed_output) return msg.parsed_output;
    throw new Error('Could not parse model output');
  }

  readImage(name) {
    try {
      const file = path.join(this.imagesDir, name);
      const data = fs.readFileSync(file).toString('base64');
      return { type: 'image', source: { type: 'base64', media_type: mediaType(name), data } };
    } catch {
      return null; // not uploaded yet; a later edit will re-trigger analysis
    }
  }
}

function sameContent(a, b) {
  return a.text === b.text && JSON.stringify(a.images) === JSON.stringify(b.images);
}

function mediaType(name) {
  const ext = path.extname(name).toLowerCase();
  return { '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'image/jpeg';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Used when no API key is configured or the call failed. */
export function fallbackAnalysis(note) {
  const firstLine = (note.text || '').split('\n').find((l) => l.trim()) || '';
  const title = firstLine.slice(0, 60) || (note.images.length ? 'Photo note' : 'Untitled');
  const urgent = /\b(urgent|asap|today|now|deadline|immediately)\b/i.test(note.text);
  return {
    title,
    summary: null,
    group: note.ai_group || 'Inbox',
    priority: note.ai_priority || (urgent ? 'high' : 'normal'),
    tags: note.tags?.length ? note.tags : null,
    status: 'off',
  };
}
