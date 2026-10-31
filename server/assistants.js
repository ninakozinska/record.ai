// Notes as context for AI assistants: Claude, ChatGPT, Gemini and any app
// that speaks MCP (the Model Context Protocol). Each person makes a key in the
// account menu; the assistant connects to /mcp with it and can search and
// read their notes, and add notes if the key allows it. docs/AI_ASSISTANTS.md
// has the steps for each assistant.
//
// The endpoint speaks MCP over "Streamable HTTP" in its simplest form: each
// POST carries one JSON-RPC message and gets one JSON answer.
import crypto from 'node:crypto';
import express from 'express';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const PREFIX = 'rai_';
const MAX_KEYS = 20;
const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

const TOOLS = [
  {
    name: 'search_notes',
    description: 'Search the person\'s notes (titles, text, groups and list items) for words. Returns matching notes with id, title, group, priority, date and text.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to look for' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'] },
  },
  {
    name: 'list_notes',
    description: 'List the person\'s notes, most important first. Filter by group, by world (work or family) and by date (today, this week, overdue).',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string' },
        world: { type: 'string', enum: ['work', 'family'] },
        due: { type: 'string', enum: ['today', 'week', 'overdue', 'any'] },
        include_done: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: 'get_note',
    description: 'One note in full, with its list items, by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'list_groups',
    description: 'The person\'s groups (Work, Kids, Groceries…) with how many open notes each has.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'today',
    description: 'What is due today (with times) and what is overdue.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_note',
    description: 'Write a new note. record.ai\'s own AI gives it a title, group, priority and date. Lines starting with "- " become a checklist. Only for keys that may add notes.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The note' }, due: { type: 'string', description: 'Optional date YYYY-MM-DD or YYYY-MM-DDTHH:MM' } },
      required: ['text'],
    },
  },
];

const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };

export class Assistants {
  constructor({ store, organizer, onChange, tzOf, inWorld, track = () => {}, today = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()) }) {
    Object.assign(this, { store, organizer, onChange, tzOf, inWorld, track, today });
    this.db = store.db;
  }

  keys(userId) {
    return this.db.prepare('SELECT id, name, can_write, created_at, last_used FROM assistant_keys WHERE user_id = ? ORDER BY created_at')
      .all(userId).map((k) => ({ ...k, can_write: !!k.can_write }));
  }

  /** A new key: the secret is returned once and only its fingerprint is kept. */
  create(userId, { name, write }) {
    if (this.keys(userId).length >= MAX_KEYS) return null;
    const token = PREFIX + crypto.randomBytes(24).toString('base64url');
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO assistant_keys (id, user_id, name, token_hash, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, userId, String(name || 'AI assistant').trim().slice(0, 40) || 'AI assistant', hash(token), write ? 1 : 0, Date.now());
    return { id, token };
  }

  revoke(userId, id) {
    return this.db.prepare('DELETE FROM assistant_keys WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  /** The key behind a request: "Authorization: Bearer rai_…", or the key in the address. */
  keyFor(req) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : req.params.token || '';
    if (!token.startsWith(PREFIX)) return null;
    const key = this.db.prepare('SELECT * FROM assistant_keys WHERE token_hash = ?').get(hash(token));
    if (!key || !this.store.getUser(key.user_id)) return null;
    this.db.prepare('UPDATE assistant_keys SET last_used = ? WHERE id = ?').run(Date.now(), key.id);
    return { ...key, can_write: !!key.can_write };
  }

  // --- the notes, written for a language model ---------------------------------

  notes(userId) {
    return this.store.changesSince(userId, 0, { items: true, shared: true }).filter((n) => !n.deleted && !n.revoked);
  }

  format(n, items = []) {
    const due = n.due_date ? ` · due ${n.due_date}${n.due_time ? ' ' + n.due_time : ''}` : '';
    const head = `- [${n.id}] ${n.title || n.text.split('\n')[0].slice(0, 80) || 'Note'} (${n.group} · ${n.priority}${due}${n.done ? ' · done' : ''}${n.owner_name ? ` · shared by ${n.owner_name}` : ''})`;
    const body = n.text && n.text !== n.title ? '\n' + n.text.split('\n').map((l) => `  ${l}`).join('\n') : '';
    const list = items.length ? '\n' + items.map((i) => `  ${i.done ? '☑' : '☐'} ${i.text}`).join('\n') : '';
    return head + body + list;
  }

  run(key, name, args = {}) {
    const userId = key.user_id;
    const tz = this.tzOf(userId);
    const today = this.today(tz);
    const all = this.notes(userId);
    const lists = all.filter((n) => !n.parent_id);
    const itemsOf = (id) => all.filter((i) => i.parent_id === id);
    const sorted = (ns) => [...ns].sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2)
      || (a.due_date || '9999').localeCompare(b.due_date || '9999') || b.edited_at - a.edited_at);
    const show = (ns, empty) => (ns.length ? ns.map((n) => this.format(n, itemsOf(n.id))).join('\n') : empty);
    const limit = (v, d, max) => Math.min(max, Math.max(1, Number.isInteger(v) ? v : d));

    if (name === 'search_notes') {
      const words = String(args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) throw new Error('query is required');
      const hay = (n) => [n.title, n.text, n.group, ...itemsOf(n.id).map((i) => i.text)].join(' ').toLowerCase();
      const found = sorted(lists.filter((n) => words.every((w) => hay(n).includes(w)))).slice(0, limit(args.limit, 20, 50));
      return show(found, 'No notes match.');
    }
    if (name === 'list_notes') {
      const week = new Date(Date.parse(today) + 7 * 864e5).toISOString().slice(0, 10);
      let ns = lists.filter((n) => args.include_done || !n.done);
      if (args.group) ns = ns.filter((n) => n.group.toLowerCase() === String(args.group).toLowerCase());
      if (args.world) ns = ns.filter((n) => this.inWorld(n.group, args.world, userId));
      if (args.due === 'today') ns = ns.filter((n) => n.due_date === today);
      if (args.due === 'week') ns = ns.filter((n) => n.due_date && n.due_date >= today && n.due_date <= week);
      if (args.due === 'overdue') ns = ns.filter((n) => n.due_date && n.due_date < today && !n.done);
      return show(sorted(ns).slice(0, limit(args.limit, 30, 100)), 'No notes.');
    }
    if (name === 'get_note') {
      const n = lists.find((x) => x.id === String(args.id || ''));
      if (!n) throw new Error('No note with this id.');
      return this.format(n, itemsOf(n.id));
    }
    if (name === 'list_groups') {
      const counts = new Map();
      for (const n of lists) if (!n.done) counts.set(n.group, (counts.get(n.group) || 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1]).map(([g, c]) => `- ${g}: ${c} open`).join('\n') || 'No groups yet.';
    }
    if (name === 'today') {
      const due = lists.filter((n) => !n.done && n.due_date === today).sort((a, b) => (a.due_time || '99').localeCompare(b.due_time || '99'));
      const late = sorted(lists.filter((n) => !n.done && n.due_date && n.due_date < today));
      return `Today is ${today}.\n\nDue today:\n${show(due, 'Nothing.')}\n\nOverdue:\n${show(late, 'Nothing.')}`;
    }
    if (name === 'add_note') {
      if (!key.can_write) throw new Error('This key can only read notes. Make a key that may add notes in record.ai (your initials → AI assistants).');
      const text = String(args.text || '').trim().slice(0, 5000);
      if (!text) throw new Error('text is required');
      const due = args.due == null ? undefined : String(args.due);
      if (due !== undefined && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(due)) throw new Error('due must be YYYY-MM-DD or YYYY-MM-DDTHH:MM');
      const now = Date.now();
      const id = crypto.randomUUID();
      const { note } = this.store.upsertFromClient(userId, { id, text, created_at: now, edited_at: now, ...(due ? { user_due: due } : {}) });
      this.onChange(note);
      this.organizer.enqueue(id);
      return `Added the note [${id}]. record.ai will give it a title, group and priority in a few seconds.`;
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  // --- MCP over HTTP -------------------------------------------------------------

  /** What this key may do: reading always; adding notes only when it was made for that. */
  tools(key) {
    return key.can_write ? TOOLS : TOOLS.filter((t) => t.name !== 'add_note');
  }

  answer(key, msg) {
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request');
    if (msg.id === undefined) return null; // a notification: nothing to answer
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'record.ai', version: '1.0.0' },
          instructions: 'The person\'s notes from record.ai: work and family to-dos, lists, appointments and ideas, sorted by an AI into groups, priorities and dates. Use today or list_notes for an overview, search_notes to find something, get_note for the full note.',
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: this.tools(key) });
      case 'tools/call': {
        const name = msg.params?.name;
        if (!this.tools(key).some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
        try {
          const text = this.run(key, name, msg.params?.arguments || {});
          this.track('assistant_call', { userId: key.user_id, props: { tool: name, key: key.name } });
          return reply({ content: [{ type: 'text', text }] });
        } catch (err) {
          return reply({ content: [{ type: 'text', text: err.message }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  }

  /** The /mcp endpoint (no login cookie: the key is the login). */
  mcp() {
    const router = express.Router();
    const handle = (req, res) => {
      const key = this.keyFor(req);
      if (!key) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="record.ai"');
        return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Add your record.ai key: Authorization: Bearer rai_…, or the address with the key at the end.' } });
      }
      const body = req.body;
      const answers = (Array.isArray(body) ? body : [body]).map((m) => this.answer(key, m)).filter(Boolean);
      if (!answers.length) return res.status(202).end();
      res.json(Array.isArray(body) ? answers : answers[0]);
    };
    // This server sends no messages of its own, so there is no stream to open.
    const noStream = (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST' });
    router.post(['/', '/:token'], express.json({ limit: '1mb' }), handle);
    router.get(['/', '/:token'], noStream);
    router.delete(['/', '/:token'], (req, res) => res.status(204).end());
    return router;
  }

  /** /api/assistants for a logged-in person: keys to make, see and revoke. */
  routes() {
    const router = express.Router();
    const base = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    router.get('/', (req, res) => res.json({ keys: this.keys(req.user.id), url: `${base(req)}/mcp` }));
    router.post('/', (req, res) => {
      const made = this.create(req.user.id, { name: req.body?.name, write: req.body?.write === true });
      if (!made) return res.status(400).json({ error: `You can have up to ${MAX_KEYS} keys. Remove one first.` });
      this.track('assistant_key_made', { userId: req.user.id, props: { name: String(req.body?.name || '').slice(0, 40), write: req.body?.write === true } });
      res.json({ ...made, url: `${base(req)}/mcp`, urlWithKey: `${base(req)}/mcp/${made.token}`, keys: this.keys(req.user.id) });
    });
    router.delete('/:id', (req, res) => {
      if (!this.revoke(req.user.id, req.params.id)) return res.status(404).json({ error: 'Not found' });
      res.json({ keys: this.keys(req.user.id) });
    });
    return router;
  }
}
