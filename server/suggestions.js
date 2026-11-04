// Suggested to-dos: once a day, at the person's morning time, the AI looks at
// their meetings for the coming week and their open notes and proposes the
// few things to do, one of them "the top to-do of the day". AI assistants can
// send to-dos from a chat, and a chat export can be uploaded. Nothing becomes
// a note on its own: suggestions wait in the Suggested inbox until the person
// adds or dismisses them. Docs: the plan "connectors and AI-suggested to-dos".
import crypto from 'node:crypto';
import express from 'express';
import { wallTime } from './calendars.js';
import { premium } from './backups.js';

export const FREE_PER_DAY = 3;
export const PREMIUM_PER_DAY = 5;
const KEEP = 3 * 864e5; // an open suggestion fades out after three days
const DEFAULT_TIME = '07:00';
const MAX_CHAT = 30_000; // characters of a chat export the AI reads (the most recent part)

// The notification's title, in the person's language.
const TOP = {
  en: 'Your top to-do today',
  it: 'La cosa più importante di oggi',
  fr: 'Votre priorité du jour',
  es: 'Tu prioridad de hoy',
  pt: 'A sua prioridade de hoje',
  de: 'Deine wichtigste Aufgabe heute',
  pl: 'Twoje najważniejsze zadanie na dziś',
};

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().startsWith(d);
const isTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t || '');
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const fingerprint = (title) => crypto.createHash('sha1').update(norm(title)).digest('hex');
const titleOf = (n) => n.title || n.text.split('\n').find((l) => l.trim())?.trim().slice(0, 100) || 'Note';
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const PRIORITIES = ['urgent', 'high', 'normal', 'low'];

/** The strings of a chat export (ChatGPT, Claude or plain text), oldest first. */
export function chatText(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return String(raw);
  }
  const out = [];
  const walk = (v, key) => {
    if (typeof v === 'string') {
      if (['text', 'parts', 'content', 'title'].includes(key) && v.trim()) out.push(v.trim());
    } else if (Array.isArray(v)) for (const x of v) walk(x, key);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(data, '');
  return out.join('\n');
}

export class Suggestions {
  constructor({ store, organizer, onChange = () => {}, tzOf = () => 'UTC', push = async () => {}, track = () => {}, now = () => Date.now(), isOwner }) {
    this.store = store;
    this.db = store.db;
    this.organizer = organizer;
    this.onChange = onChange;
    this.tzOf = tzOf;
    this.push = push;
    this.track = track;
    this.now = now;
    this.isOwner = isOwner || ((userId) => store.firstUserId() === userId);
  }

  // --- settings and limits -------------------------------------------------------

  settings(userId) {
    try {
      return { on: true, time: DEFAULT_TIME, ...JSON.parse(this.store.getMeta(`suggest:${userId}`) || '{}') };
    } catch {
      return { on: true, time: DEFAULT_TIME };
    }
  }

  setSettings(userId, { on, time } = {}) {
    const s = this.settings(userId);
    if (on !== undefined) s.on = !!on;
    if (time !== undefined) {
      if (!isTime(time)) return null;
      s.time = time;
    }
    this.store.setMeta(`suggest:${userId}`, JSON.stringify(s));
    return s;
  }

  premium(userId) {
    return premium(this.store.planOf(userId)) || this.isOwner(userId);
  }

  perDay(userId) {
    return this.premium(userId) ? PREMIUM_PER_DAY : FREE_PER_DAY;
  }

  // --- the inbox ----------------------------------------------------------------

  row(r) {
    return {
      id: r.id, title: r.title, details: r.details, due_date: r.due_date, due_time: r.due_time, priority: r.priority,
      reason: r.reason, source: r.source, source_label: r.source_label, top: !!r.top, created_at: r.created_at,
    };
  }

  /** Open suggestions, the top one first. Old ones fade out; ones whose meeting is gone go too. */
  open(userId) {
    const now = this.now();
    this.db.prepare("UPDATE suggestions SET status = 'expired', decided_at = ? WHERE user_id = ? AND status = 'open' AND created_at < ?")
      .run(now, userId, now - KEEP);
    const rows = this.db.prepare("SELECT * FROM suggestions WHERE user_id = ? AND status = 'open' ORDER BY top DESC, created_at DESC").all(userId);
    const keep = [];
    for (const r of rows) {
      const meeting = r.source === 'calendar' && r.source_ref ? this.store.get(r.source_ref) : null;
      if (r.source === 'calendar' && r.source_ref && (!meeting || meeting.deleted || meeting.user_id !== userId)) {
        this.db.prepare("UPDATE suggestions SET status = 'gone', decided_at = ? WHERE id = ?").run(now, r.id);
        continue;
      }
      keep.push(this.row(r));
    }
    return keep;
  }

  mine(userId, id) {
    const r = this.db.prepare("SELECT * FROM suggestions WHERE id = ? AND user_id = ? AND status = 'open'").get(String(id), userId);
    if (!r) throw Object.assign(new Error('Suggestion not found'), { status: 404 });
    return r;
  }

  /** Add: the suggestion becomes a normal note, sorted by the AI like any other. */
  add(userId, id, { title, due } = {}) {
    const r = this.mine(userId, id);
    const text = String(title ?? r.title).trim().slice(0, 500) || r.title;
    let userDue = r.due_date ? (r.due_time ? `${r.due_date}T${r.due_time}` : r.due_date) : null;
    if (due !== undefined) {
      if (due === null || due === '') userDue = null;
      else if (/^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d)?$/.test(String(due))) userDue = String(due);
      else throw Object.assign(new Error('due must be YYYY-MM-DD or YYYY-MM-DDTHH:MM'), { status: 400 });
    }
    const now = this.now();
    const noteId = crypto.randomUUID();
    const { note } = this.store.upsertFromClient(userId, {
      id: noteId, text: r.details ? `${text}\n${r.details}` : text, created_at: now, edited_at: now, ...(userDue ? { user_due: userDue } : {}),
    });
    this.onChange(note);
    this.organizer?.enqueue?.(noteId);
    this.db.prepare("UPDATE suggestions SET status = 'added', note_id = ?, decided_at = ? WHERE id = ?").run(noteId, now, r.id);
    this.track('suggestion_added', { userId, props: { source: r.source, top: !!r.top, edited: title !== undefined || due !== undefined } });
    return note;
  }

  dismiss(userId, id) {
    const r = this.mine(userId, id);
    this.db.prepare("UPDATE suggestions SET status = 'dismissed', decided_at = ? WHERE id = ?").run(this.now(), r.id);
    this.track('suggestion_dismissed', { userId, props: { source: r.source, top: !!r.top } });
  }

  // --- making suggestions ---------------------------------------------------------

  /** Checks and keeps the AI's (or an assistant's) suggestions. Returns the ones kept. */
  keep(userId, items, { source, label = null, refs = new Map(), max = 10, allowTop = false }) {
    const notes = this.store.changesSince(userId, 0, { items: false, shared: true }).filter((n) => !n.deleted && !n.done && !n.revoked);
    const openTitles = notes.filter((n) => !n.source).map((n) => norm(titleOf(n)));
    const seen = new Set(this.db.prepare("SELECT fingerprint FROM suggestions WHERE user_id = ? AND status IN ('open', 'dismissed', 'added')").all(userId).map((r) => r.fingerprint));
    const like = (a, b) => a === b || (a.length > 8 && b.length > 8 && (a.includes(b) || b.includes(a)));
    const now = this.now();
    const kept = [];
    let topTaken = false;
    for (const s of items) {
      if (kept.length >= max) break;
      const title = String(s.title || '').trim().slice(0, 200);
      const key = norm(title);
      if (!key) continue;
      const fp = fingerprint(title);
      if (seen.has(fp) || openTitles.some((t) => like(t, key))) continue;
      seen.add(fp);
      const due = isDate(s.due_date) ? s.due_date : null;
      const ref = refs.get(String(s.source || '').replace(/^\[|\]$/g, ''));
      const top = allowTop && !topTaken && !!s.top;
      if (top) topTaken = true;
      kept.push({
        id: crypto.randomUUID(), user_id: userId, title, details: s.details ? String(s.details).trim().slice(0, 300) : null,
        due_date: due, due_time: due && isTime(s.due_time) ? s.due_time : null,
        priority: PRIORITIES.includes(s.priority) ? s.priority : 'normal', reason: s.reason ? String(s.reason).trim().slice(0, 200) : null,
        source: ref ? 'calendar' : source, source_ref: ref?.id || null, source_label: ref ? titleOf(ref) : label,
        top: top ? 1 : 0, fingerprint: fp, created_at: now,
      });
    }
    // Exactly one top to-do a day: the AI's pick, else the first.
    if (allowTop && kept.length && !topTaken) kept[0].top = 1;
    if (kept.some((k) => k.top)) this.db.prepare("UPDATE suggestions SET top = 0 WHERE user_id = ? AND status = 'open'").run(userId);
    const insert = this.db.prepare(`INSERT INTO suggestions (id, user_id, title, details, due_date, due_time, priority, reason, source, source_ref, source_label, top, fingerprint, created_at)
      VALUES (@id, @user_id, @title, @details, @due_date, @due_time, @priority, @reason, @source, @source_ref, @source_label, @top, @fingerprint, @created_at)`);
    for (const k of kept) insert.run(k);
    return kept.map((k) => this.row(k));
  }

  /** What the AI reads: meetings this week, open notes, and what was dismissed before. */
  material(userId) {
    const tz = this.tzOf(userId);
    const today = wallTime(this.now(), tz).slice(0, 10);
    const weekday = new Date(`${today}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
    const notes = this.store.changesSince(userId, 0, { items: false, shared: true }).filter((n) => !n.deleted && !n.done && !n.revoked);
    const meetings = notes.filter((n) => n.source && n.due_date && n.due_date >= today && n.due_date <= addDays(today, 7))
      .sort((a, b) => `${a.due_date}${a.due_time || ''}`.localeCompare(`${b.due_date}${b.due_time || ''}`)).slice(0, 30);
    const rank = (n) => (n.due_date || '9999') + PRIORITIES.indexOf(n.priority || 'normal');
    const open = notes.filter((n) => !n.source).sort((a, b) => rank(a).localeCompare(rank(b))).slice(0, 60);
    const dismissed = this.db.prepare("SELECT title FROM suggestions WHERE user_id = ? AND status = 'dismissed' ORDER BY decided_at DESC LIMIT 10").all(userId);
    const refs = new Map(meetings.map((m, i) => [`m${i + 1}`, m]));
    const line = (n) => `${n.due_date || ''}${n.due_time ? ` ${n.due_time}` : ''} ${titleOf(n)}`.trim();
    const text = [
      `Today is ${today} (${weekday}). The person's language: ${this.store.languageOf?.(userId) || 'en'}.`,
      '<meetings>',
      ...meetings.map((m, i) => `[m${i + 1}] ${line(m)}${m.text && m.text.trim() !== titleOf(m) ? `\n${m.text.trim().slice(0, 600)}` : ''}`),
      '</meetings>',
      '<open_notes>',
      ...open.map((n) => `- ${line(n)}${n.priority ? ` (${n.priority})` : ''}`),
      '</open_notes>',
      '<dismissed_before>',
      ...dismissed.map((d) => `- ${d.title}`),
      '</dismissed_before>',
    ].join('\n');
    return { text, refs, empty: !meetings.length && !open.length };
  }

  /** The daily run (or "Suggest now"): up to the plan's number of suggestions, one of them the top to-do. */
  async run(userId) {
    if (!this.organizer?.enabled) return [];
    const { text, refs, empty } = this.material(userId);
    if (empty) return [];
    const already = this.db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE user_id = ? AND source IN ('daily', 'calendar') AND created_at >= ?")
      .get(userId, this.now() - 20 * 3600e3).n;
    const max = Math.max(0, this.perDay(userId) - already);
    if (!max) return [];
    const items = await this.organizer.suggest({ userId, text: `${text}\nPropose at most ${max} to-dos, one of them the top to-do of today.` });
    const kept = this.keep(userId, items, { source: 'daily', refs, max, allowTop: true });
    this.track('suggestions_made', { userId, props: { count: kept.length } });
    return kept;
  }

  /** To-dos an AI assistant sends from a chat (the suggest_todos tool). */
  fromAssistant(userId, todos, label) {
    const items = (Array.isArray(todos) ? todos : []).slice(0, 10).map((t) => {
      const due = String(t?.due || '');
      return { title: t?.title, details: t?.details, due_date: due.slice(0, 10), due_time: due.slice(11, 16), priority: t?.priority, reason: t?.reason };
    });
    return this.keep(userId, items, { source: 'assistant', label: String(label || 'AI assistant').slice(0, 60) });
  }

  /** A chat export (ChatGPT or Claude, JSON or text): the AI finds what is still to do. */
  async fromChat(userId, raw, name) {
    const chat = chatText(raw).slice(-MAX_CHAT);
    if (!chat.trim()) throw Object.assign(new Error('The file has no text the AI can read.'), { status: 400 });
    const { text } = this.material(userId);
    const label = String(name || 'AI chat').slice(0, 60);
    const items = await this.organizer.suggest({
      userId, kind: 'suggestions_chat',
      text: `${text}\n<chat name="${label.replace(/"/g, "'")}">\n${chat}\n</chat>\nPropose at most 8 to-dos that are still open in this chat. Set source to "chat" and top to false.`,
    });
    return this.keep(userId, items, { source: 'chat', label, max: 8 });
  }

  // --- the daily timer -------------------------------------------------------------

  /** Every few minutes: people active this week whose morning time has come get their suggestions once a day. */
  async tick() {
    const now = this.now();
    const people = this.db.prepare('SELECT DISTINCT user_id FROM events WHERE user_id IS NOT NULL AND ts >= ?').all(now - 7 * 864e5).map((r) => r.user_id);
    for (const userId of people) {
      if (!this.store.getUser?.(userId)) continue;
      const s = this.settings(userId);
      if (!s.on) continue;
      const local = wallTime(now, this.tzOf(userId));
      if (local.slice(11, 16) < s.time || this.store.getMeta(`suggested:${userId}`) === local.slice(0, 10)) continue;
      this.store.setMeta(`suggested:${userId}`, local.slice(0, 10));
      try {
        const kept = await this.run(userId);
        const top = kept.find((k) => k.top);
        if (top) await this.push(userId, { title: `⭐ ${TOP[this.store.languageOf?.(userId)] || TOP.en}`, body: top.title, url: './?suggested=1', tag: 'suggestions' });
      } catch (err) {
        console.error('Suggestions failed:', err.message);
      }
    }
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((err) => console.error('Suggestions failed:', err.message)), 5 * 60e3);
    this.timer.unref?.();
  }

  // --- HTTP ---------------------------------------------------------------------------

  router() {
    const r = express.Router();
    const fail = (res, err) => res.status(err.status || 500).json({ error: err.message });
    r.get('/', (req, res) => {
      res.json({ suggestions: this.open(req.user.id), settings: this.settings(req.user.id), perDay: this.perDay(req.user.id), premium: this.premium(req.user.id) });
    });
    r.put('/settings', (req, res) => {
      const s = this.setSettings(req.user.id, req.body || {});
      if (!s) return res.status(400).json({ error: 'time must be HH:MM' });
      res.json({ settings: s });
    });
    r.post('/run', async (req, res) => {
      const key = `suggest_now:${req.user.id}`;
      const last = Number(this.store.getMeta(key) || 0);
      if (!this.isOwner(req.user.id) && this.now() - last < 3600e3) return res.status(429).json({ error: 'New suggestions can be made once an hour.' });
      this.store.setMeta(key, String(this.now()));
      try {
        await this.run(req.user.id);
        res.json({ suggestions: this.open(req.user.id) });
      } catch (err) {
        fail(res, err);
      }
    });
    r.post('/chat', express.json({ limit: '5mb' }), async (req, res) => {
      if (!this.premium(req.user.id)) return res.status(402).json({ error: 'To-dos from AI chats are part of Premium.' });
      try {
        const kept = await this.fromChat(req.user.id, String(req.body?.text || ''), req.body?.name);
        res.json({ added: kept.length, suggestions: this.open(req.user.id) });
      } catch (err) {
        fail(res, err);
      }
    });
    r.post('/:id/add', (req, res) => {
      try {
        const note = this.add(req.user.id, req.params.id, req.body || {});
        res.json({ note, suggestions: this.open(req.user.id) });
      } catch (err) {
        fail(res, err);
      }
    });
    r.post('/:id/dismiss', (req, res) => {
      try {
        this.dismiss(req.user.id, req.params.id);
        res.json({ suggestions: this.open(req.user.id) });
      } catch (err) {
        fail(res, err);
      }
    });
    return r;
  }
}
