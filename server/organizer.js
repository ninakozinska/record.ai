// Uses an AI model to title, prioritize and group notes: Claude (online,
// AI_PROVIDER=anthropic) or a free local model via Ollama (AI_PROVIDER=ollama).
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
const provider = () => (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
const claudeModel = () => process.env.CLAUDE_MODEL || 'claude-opus-5-5';

/** A list's items, so the AI can title and rank the list as a whole. */
const listItemsBlock = (items) => (items.length
  ? `<list_items>\n${items.slice(0, 50).map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`).join('\n')}\n</list_items>\n`
  : '');

/** The person's own groups: the AI must use these exact names when a note fits. */
const myGroupsLine = (names) => (names.length
  ? `The person's own groups (use these exact names whenever a note fits one): ${names.join(', ')}\n`
  : '');
export const ollamaModel = () => process.env.OLLAMA_MODEL || 'gemma3:4b';
export const ollamaUrl = () => (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
// Re-run the whole-collection tidy-up after this many newly organized notes.
const reorganizeEvery = () => Number(process.env.REORGANIZE_EVERY || 20);

// Each person gets this many AI uses a month (organizing a note = 1, a full
// reorganize = 5), because all of them run on the server owner's AI account.
// The owner (the first account, plus any email in AI_UNLIMITED) has no limit.
// AI_MONTHLY_LIMIT=0 turns the limit off. The free local AI (Ollama) has none.
const monthlyLimit = () => Number(process.env.AI_MONTHLY_LIMIT ?? 300);
const REORGANIZE_COST = 5;
const thisMonth = () => new Date().toISOString().slice(0, 7);
function nextMonthStart() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

const NoteAnalysis = z.object({
  title: z.string().describe('Short title, max ~8 words, in the language of the note'),
  summary: z.string().describe('One sentence summary of the note'),
  group: z.string().describe('Topic group name; reuse an existing group name when it fits'),
  priority: z.enum(PRIORITIES),
  priority_reason: z.string().describe('A few words explaining the priority'),
  tags: z.array(z.string()).describe('0-5 short lowercase tags'),
  due_date: z.string().nullable().describe('ISO date YYYY-MM-DD of the deadline, appointment or event, else null'),
  due_time: z.string().nullable().describe('Time HH:MM (24h) if the note states one, e.g. "3pm" -> "15:00", else null'),
});

const Reorganization = z.object({
  notes: z.array(
    z.object({
      id: z.string(),
      group: z.string(),
      priority: z.enum(PRIORITIES),
      priority_reason: z.string(),
      title: z.string().nullable().describe('A better title, only when the current one is just a group name or too vague to recognize the note; else null'),
    }),
  ),
});

/** A title that says nothing about the note: empty, generic, or just a group's name ("Travel"). */
export function vagueTitle(title, groups) {
  const t = String(title || '').trim().toLowerCase();
  if (!t || ['note', 'untitled', 'list', 'photo', 'photo note', 'inbox', 'todo', 'to do', 'task'].includes(t)) return true;
  return groups.some((g) => g.toLowerCase() === t);
}

const SYSTEM = `You organize a person's personal notes (typed, dictated, or photos).
Priorities:
- urgent: needs action today or is time-critical / has a deadline within ~2 days
- high: important action item or deadline within ~2 weeks
- normal: useful info or tasks without pressure
- low: reference material, someday/maybe, idle thoughts
Groups are short topic names (1-3 words, Title Case) like "Work", "Shopping", "Health", "Ideas", "Travel".
Prefer reusing an existing group. Create a new group only when none fits. Keep the total number of groups small (ideally under 12).
Dictated notes may contain speech-recognition errors; infer the intended meaning.
Dates: work out relative dates ("tomorrow", "next week", "on Tuesday") from the day the note was written (its created date), not from today. "On Tuesday" means the next Tuesday after that day; "next week on Wednesday" means the Wednesday of the following week.
For photos, describe what matters (e.g. receipt total, whiteboard content, document type) in the summary.`;

export class Organizer {
  constructor({ store, imagesDir, onChange, client, log = console, onAiCall }) {
    this.store = store;
    // Measuring and tuning (see optimizer.js): every AI call is reported, and a
    // note that is still being typed can wait a moment before it is sorted.
    this.onAiCall = onAiCall || (() => {});
    this.debounceMs = 0;
    this.timers = new Map();
    this.imagesDir = imagesDir;
    this.onChange = onChange;
    this.log = log;
    this.provider = client ? 'anthropic' : provider();
    this.enabled =
      this.provider === 'ollama' ||
      (this.provider === 'anthropic' &&
        !!(client || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN));
    this.client = client || (this.enabled && this.provider === 'anthropic' ? new Anthropic() : null);
    this.queue = new Set();
    this.running = false;
    this.reorganizing = false;
    // Notes held back by the monthly limit get their turn once a new month starts.
    this.month = thisMonth();
    setInterval(() => {
      if (thisMonth() === this.month) return;
      this.month = thisMonth();
      for (const n of this.store.active()) if (n.ai_status === 'limit') this.enqueue(this.store.applyAi(n.id, { status: 'pending' }).id);
    }, 3600e3).unref();
  }

  /** This month's AI use of one person: { used, limit (null = no limit), resets }. */
  usage(userId) {
    const unlimited =
      this.provider !== 'anthropic' ||
      !monthlyLimit() ||
      this.store.firstUserId() === userId ||
      (process.env.AI_UNLIMITED || '').toLowerCase().split(',').map((e) => e.trim()).includes(this.store.getUser(userId)?.email.toLowerCase());
    return { used: Number(this.store.getMeta(`ai_used:${userId}:${thisMonth()}`) || 0), limit: unlimited ? null : monthlyLimit(), resets: nextMonthStart() };
  }

  /** Counts AI use against the person's monthly limit; false when it would go over. */
  charge(userId, units) {
    const { used, limit } = this.usage(userId);
    if (limit !== null && used + units > limit) return false;
    this.store.setMeta(`ai_used:${userId}:${thisMonth()}`, used + units);
    return true;
  }

  get status() {
    return {
      enabled: this.enabled,
      provider: this.enabled ? this.provider : null,
      model: !this.enabled ? null : this.provider === 'ollama' ? ollamaModel() : claudeModel(),
      pending: this.queue.size,
      reorganizing: this.reorganizing,
    };
  }

  enqueue(id) {
    if (!this.debounceMs) {
      this.queue.add(id);
      queueMicrotask(() => this.drain());
      return;
    }
    // Each new edit restarts the wait, so a note typed in bursts is sorted once.
    clearTimeout(this.timers.get(id));
    const t = setTimeout(() => {
      this.timers.delete(id);
      this.queue.add(id);
      this.drain();
    }, this.debounceMs);
    t.unref?.();
    this.timers.set(id, t);
  }

  /** After how many newly sorted notes a person's notes are reorganized (tuned per person). */
  reorganizeEvery(userId) {
    return Number(this.store.getMeta(`opt:reorg_every:${userId}`)) || reorganizeEvery();
  }

  /** On startup: finish queued work and retry notes the AI never got to. */
  resumePending() {
    if (this.enabled) {
      for (const n of this.store.active()) {
        if (['error', 'off', 'limit'].includes(n.ai_status)) this.store.applyAi(n.id, { status: 'pending' });
      }
    }
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
      this.onChange(this.store.applyAi(id, fallbackAnalysis(note, this.store.items?.(id) || [])));
      return;
    }

    if (!this.charge(note.user_id, 1)) {
      const { limit, resets } = this.usage(note.user_id);
      this.onChange(this.store.applyAi(id, {
        ...fallbackAnalysis(note, this.store.items?.(id) || []),
        status: 'limit',
        error: `This month's ${limit} AI sortings are used up. Your notes are saved and synced; the AI sorts them again from ${resets}.`,
      }));
      return;
    }

    const items = this.store.items?.(id) || [];
    const groups = this.store.groups(note.user_id).map((g) => `${g.name} (${g.count})`);
    const mine = this.store.myGroups(note.user_id);
    const images = note.images.map((name) => this.readImage(name)).filter(Boolean);
    const text =
      `Today is ${today()}.\n` +
      `Existing groups: ${groups.length ? groups.join(', ') : '(none yet)'}\n` +
      myGroupsLine(mine) +
      `\n` +
      `<note created="${new Date(note.created_at).toISOString()}" images="${note.images.length}">\n` +
      `${note.text || (items.length ? '(no text: a checklist, see its items)' : '(no text — photo only)')}\n</note>\n` +
      listItemsBlock(items) +
      `\nAnalyze this note.`;

    const meter = { kind: 'note', userId: note.user_id, started: Date.now() };
    try {
      const result = await this.ask({ text, images, schema: NoteAnalysis, effort: 'low', maxTokens: 4000, meter });
      // If the text/photos were edited while we were waiting, a newer run is
      // queued and this result is stale. (Changing only done/group/priority
      // doesn't invalidate it.)
      const current = this.store.get(id);
      if (!current || current.ai_status !== 'pending' || !sameContent(current, note)) {
        this.onAiCall({ ...meter, outcome: 'stale' });
        return;
      }
      this.onAiCall({ ...meter, outcome: 'used' });
      this.onChange(this.store.applyAi(id, { ...result, status: 'done' }));
      this.maybeAutoReorganize(note.user_id);
    } catch (err) {
      if (meter.usage) this.onAiCall({ ...meter, outcome: 'error' });
      this.log.error(`[organizer] note ${id}:`, err.message);
      this.onChange(this.store.applyAi(id, { ...fallbackAnalysis(note, this.store.items?.(id) || []), status: 'error', error: friendlyError(err, this.provider) }));
    }
  }

  maybeAutoReorganize(userId) {
    const key = `organized_since_reorg:${userId}`;
    const count = Number(this.store.getMeta(key) || 0) + 1;
    this.store.setMeta(key, count);
    const { used, limit } = this.usage(userId);
    if (count >= this.reorganizeEvery(userId) && (limit === null || used + REORGANIZE_COST <= limit)) {
      this.reorganizeAll(userId).catch((err) => this.log.error('[organizer] reorganize:', err.message));
    }
  }

  /** Re-groups and re-ranks all open notes of one user. */
  async reorganizeAll(userId) {
    if (!this.enabled) throw new Error('AI is not configured');
    if (this.reorganizing) return { skipped: true };
    if (!this.charge(userId, REORGANIZE_COST)) {
      const { limit, resets } = this.usage(userId);
      throw Object.assign(new Error(`This month's ${limit} AI uses are used up. Reorganize works again from ${resets}.`), { status: 429 });
    }
    this.reorganizing = true;
    this.store.setMeta(`organized_since_reorg:${userId}`, 0);
    try {
      const notes = this.store.active(userId).filter((n) => !n.done);
      if (!notes.length) return { updated: 0 };
      const groupNames = [...new Set([...notes.map((n) => n.group), ...this.store.myGroups(userId)])];
      const vague = new Set(notes.filter((n) => vagueTitle(n.title, groupNames)).map((n) => n.id));
      const lines = notes.map((n) =>
        JSON.stringify({
          id: n.id,
          title: n.title,
          ...(vague.has(n.id) ? { vague_title: true, text: n.text.slice(0, 300) } : {}),
          summary: n.summary || n.text.slice(0, 300),
          group: n.group,
          priority: n.priority,
          due: n.due_date,
          created: new Date(n.created_at).toISOString().slice(0, 10),
        }),
      );
      const meter = { kind: 'reorganize', userId, started: Date.now() };
      const result = await this.ask({
        meter,
        text:
          `Today is ${today()}. Here are all open notes, one JSON object per line:\n\n` +
          lines.join('\n') +
          `\n\nReorganize the whole collection: produce a clean, consistent set of groups ` +
          `(merge near-duplicates, split groups that mix unrelated topics) and re-rank ` +
          `priorities relative to each other and to today's date. Return every note id. ` +
          `For notes marked vague_title, also give a short real title from their text; for all others, title is null.` +
          (this.store.myGroups(userId).length
            ? `\n\n` + myGroupsLine(this.store.myGroups(userId)) +
              `Never rename, merge or split these groups; move notes into them whenever they fit.`
            : ''),
        schema: Reorganization,
        effort: 'medium',
        maxTokens: 64000,
        stream: true,
      });

      let updated = 0;
      const ids = new Set(notes.map((n) => n.id));
      for (const r of result.notes) {
        if (!ids.has(r.id)) continue;
        const n = this.store.get(r.id);
        // A title that is just a group name ("Travel") is replaced by a real one.
        const betterTitle = r.title && r.title.trim() && vague.has(r.id) ? r.title.trim().slice(0, 80) : null;
        if (n.ai_group === r.group && n.ai_priority === r.priority && !betterTitle) continue;
        this.onChange(
          this.store.applyAi(r.id, {
            group: r.group,
            priority: r.priority,
            priority_reason: r.priority_reason,
            ...(betterTitle ? { title: betterTitle } : {}),
            status: n.ai_status === 'pending' ? 'pending' : 'done',
          }),
        );
        updated++;
      }
      this.onAiCall({ ...meter, outcome: 'used', moved: updated, total: notes.length });
      return { updated };
    } finally {
      this.reorganizing = false;
    }
  }

  /** One structured request to whichever AI is configured. */
  async ask({ text, images = [], schema, effort, maxTokens, stream = false, meter }) {
    if (this.provider === 'ollama') return this.askOllama({ text, images, schema });
    const content = [
      ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
      { type: 'text', text },
    ];
    return this.parse(
      {
        max_tokens: maxTokens,
        system: SYSTEM,
        messages: [{ role: 'user', content }],
        output_config: { effort, format: betaZodOutputFormat(schema) },
      },
      { stream, meter },
    );
  }

  /**
   * Claude structured-output call with server-side refusal fallback. If the
   * API rejects the fallback parameter (e.g. on a proxy), retry without it.
   */
  async parse(params, { stream = false, meter } = {}) {
    const base = { model: claudeModel(), ...params };
    // Haiku has no server-side fallback; don't send the parameter there.
    const withFallback = /haiku/.test(base.model)
      ? null
      : { ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
    const call = (p) =>
      stream
        ? this.client.beta.messages.stream(p).finalMessage()
        : this.client.beta.messages.parse(p);
    let msg;
    try {
      msg = await call(withFallback || base);
    } catch (err) {
      if (!withFallback || !(err instanceof Anthropic.BadRequestError) || isBillingError(err)) throw err;
      msg = await call(base);
    }
    if (meter) Object.assign(meter, { model: msg.model || base.model, usage: msg.usage, ms: Date.now() - meter.started });
    if (msg.stop_reason === 'refusal') throw new Error('Claude declined to process this note');
    if (msg.stop_reason === 'max_tokens') throw new Error('Response was cut off (max_tokens)');
    if (msg.parsed_output) return msg.parsed_output;
    throw new Error('Could not parse model output');
  }

  /** Local model via Ollama's chat API with a JSON-schema constrained reply. */
  async askOllama({ text, images, schema }) {
    let res;
    try {
      res = await fetch(`${ollamaUrl()}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel(),
          stream: false,
          format: z.toJSONSchema(schema),
          options: { temperature: 0 },
          messages: [
            { role: 'system', content: SYSTEM + '\nReply with JSON only.' },
            { role: 'user', content: text, ...(images.length ? { images: images.map((i) => i.data) } : {}) },
          ],
        }),
      });
    } catch {
      throw new LocalAiError('not-running');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 404 || /not found/i.test(body.error || '')) throw new LocalAiError('no-model');
      throw new Error(`Local AI error: ${body.error || res.status}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(body.message?.content ?? '');
    } catch {
      throw new Error('Local AI returned an unreadable answer');
    }
    // Small models sometimes leave out a field that may be empty anyway (like the time).
    if (parsed && typeof parsed === 'object' && schema.shape) {
      for (const [key, field] of Object.entries(schema.shape)) if (!(key in parsed) && field.safeParse(null).success) parsed[key] = null;
    }
    const checked = schema.safeParse(parsed);
    if (!checked.success) throw new Error('Local AI returned an incomplete answer');
    return checked.data;
  }

  readImage(name) {
    try {
      const file = path.join(this.imagesDir, name);
      return { mediaType: mediaType(name), data: fs.readFileSync(file).toString('base64') };
    } catch {
      return null; // not uploaded yet; a later edit will re-trigger analysis
    }
  }
}

class LocalAiError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

function isBillingError(err) {
  return /credit balance|billing/i.test(err?.message || '');
}

/** Turn API errors into something a non-developer can act on. */
export function friendlyError(err, provider) {
  if (err instanceof LocalAiError) {
    return err.kind === 'not-running'
      ? 'The free local AI (Ollama) is not running. Open the Ollama app, then restart record.ai.'
      : `The local AI model "${ollamaModel()}" is not downloaded yet. Restart record.ai to download it.`;
  }
  if (provider === 'anthropic') {
    if (isBillingError(err)) return 'Your Anthropic account has no credit. Add credit at console.anthropic.com → Plans & Billing, then click Re-analyze.';
    if (err instanceof Anthropic.AuthenticationError) return 'The Claude API key is not valid. Check it in your settings.';
    if (err instanceof Anthropic.RateLimitError) return 'Too many requests to Claude right now. Click Re-analyze in a minute.';
    if (err instanceof Anthropic.APIConnectionError) return 'Could not reach Claude — check your internet connection, then click Re-analyze.';
  }
  return err?.message || String(err);
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
export function fallbackAnalysis(note, items = []) {
  const firstLine = (note.text || '').split('\n').find((l) => l.trim()) || items[0]?.text || '';
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
