// HTTP API + static web app hosting.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import { openDb, PRIORITIES } from './db.js';
import { Organizer } from './organizer.js';
import { authRoutes, requireUser, getToken } from './auth.js';
import { Insights, EVENT_NAME, ANON_ID } from './insights.js';
import { Backups, premium } from './backups.js';
import { Optimizer, costOf } from './optimizer.js';
import { EXPERIMENTS } from './experiments.js';
import { toIcs, noteTitle } from './calendar.js';
import crypto from 'node:crypto';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const IMAGE_NAME = /^[a-zA-Z0-9-]{8,64}\.(jpg|jpeg|png|webp|gif)$/;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const NOTE_ID = /^[a-zA-Z0-9-]{8,64}$/;
const MAX_BATCH = 500;
const MAX_MY_GROUPS = 30;
const NOTE_FIELDS = ['text', 'images', 'done', 'deleted', 'created_at', 'edited_at', 'user_group', 'user_priority', 'user_due', 'parent_id'];
const USER_DUE = /^(\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?)?$/;

/** Checks one note change from a client. Returns an error message, or null when it is valid. */
function invalidChange(id, body) {
  if (!NOTE_ID.test(String(id))) return 'Bad id';
  if (typeof body.edited_at !== 'number') return 'edited_at required';
  if (body.user_priority != null && !PRIORITIES.includes(body.user_priority)) return 'Bad priority';
  if (body.user_due != null && !USER_DUE.test(String(body.user_due))) return 'Bad date';
  if (body.parent_id != null && (!NOTE_ID.test(String(body.parent_id)) || body.parent_id === id)) return 'Bad parent_id';
  if (body.images && !(Array.isArray(body.images) && body.images.every((n) => IMAGE_NAME.test(n)))) {
    return 'Bad image list';
  }
  return null;
}

/** This computer's addresses on the local network, for connecting the iPhone app. */
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

/**
 * Which proxies to believe about the visitor's address and https. On your Mac
 * only the computer itself (Tailscale); behind a host such as Fly.io set
 * TRUST_PROXY=1, or every visitor looks alike and one person's wrong
 * passwords would lock everybody out.
 */
export function trustProxy(value) {
  if (!value) return 'loopback';
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export function createApp({ dataDir, organizer: makeOrganizer, oauth } = {}) {
  const store = openDb(dataDir);
  const imagesDir = path.join(dataDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  // --- live updates (Server-Sent Events), one channel per user ---------------
  const clients = new Map(); // userId -> Set<res>
  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // Apps that don't show lists or sharing yet (older phone apps) don't get list
  // items or other people's notes.
  const sendNote = (userId, note) => {
    for (const res of clients.get(userId) || []) {
      if (note.parent_id && !res.wantsItems) continue;
      if (note.user_id !== userId && !res.wantsShared) continue;
      send(res, 'note', note);
    }
  };
  const sendShares = (userId) => {
    for (const res of clients.get(userId) || []) if (res.wantsShared) send(res, 'shares', {});
  };
  // A changed note goes to its owner, to everyone it is shared with, and as a
  // removal notice to anyone who could see it before but no longer can.
  const onChange = (note) => {
    sendNote(note.user_id, note);
    const audience = store.audience(note);
    for (const [userId, role] of audience) {
      const firstTime = !store.seenBy(note.id).includes(userId);
      sendNote(userId, store.forRecipient(userId, note, role));
      // A list that just became visible (e.g. moved into a shared group) brings its items.
      if (firstTime && !note.parent_id) for (const item of store.items(note.id)) sendNote(userId, store.forRecipient(userId, item, role));
    }
    for (const userId of store.seenBy(note.id)) {
      if (audience.has(userId)) continue;
      sendNote(userId, store.revoked(userId, note));
      if (!note.parent_id) {
        for (const item of store.items(note.id)) if (store.seenBy(item.id).includes(userId)) sendNote(userId, store.revoked(userId, item));
      }
    }
  };
  const broadcastStatus = (status) => {
    for (const set of clients.values()) for (const res of set) send(res, 'status', status);
  };

  // Measuring and optimizing: events, A/B tests, AI cost per call.
  const insights = new Insights(store.db);
  insights.seed(EXPERIMENTS);
  const onAiCall = (call) => {
    const u = call.usage || {};
    store.db.prepare(
      `INSERT INTO ai_calls (ts, user_id, kind, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, ms, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(Date.now(), call.userId ?? null, call.kind, call.model ?? null, u.input_tokens || 0, u.output_tokens || 0,
      u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0, costOf(call.model, u), call.ms || 0, call.outcome);
    if (call.kind === 'reorganize') insights.track('ai_reorganized', { userId: call.userId, props: { moved: call.moved, total: call.total } });
  };
  const organizer = makeOrganizer
    ? makeOrganizer({ store, imagesDir, onChange, onAiCall })
    : new Organizer({ store, imagesDir, onChange, onAiCall });
  const optimizer = new Optimizer({ store, insights, organizer });
  const backups = new Backups({ store, dataDir, imagesDir });
  if (process.env.OPTIMIZER !== 'off') {
    optimizer.start();
    // Daily backups for premium accounts: checked every hour, made once a day.
    setTimeout(() => backups.runDaily(), 30e3).unref();
    setInterval(() => backups.runDaily(), 3600e3).unref();
  }
  const isAdmin = (user) =>
    store.firstUserId() === user.id ||
    (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map((e) => e.trim()).includes(user.email.toLowerCase());

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy(process.env.TRUST_PROXY));
  // Compress JSON and pages (often 5-10x smaller on mobile networks). Live
  // updates must reach the phone at once, and photos are already compressed.
  app.use(
    compression({
      filter: (req, res) => {
        const type = String(res.getHeader('Content-Type') || '');
        if (type.startsWith('text/event-stream') || type.startsWith('image/')) return false;
        return compression.filter(req, res);
      },
    }),
  );
  app.use(express.json({ limit: '25mb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true, app: 'record.ai' }));
  app.use('/api/auth', authRoutes({
    store, imagesDir, oauth,
    onSignup: (user, { method, anonId }) => {
      insights.track('signup', { userId: user.id, props: { method } });
      if (anonId && ANON_ID.test(anonId)) insights.identify(anonId, user.id);
    },
  }));

  // --- A/B tests and events, also before logging in -----------------------------
  // The landing page and the sign-up screen are tested too, so these work with
  // an anonymous device id; once logged in, the account is used.
  const subjectOf = (req, anonId) => {
    const user = store.sessionUser(getToken(req));
    if (user && anonId) insights.identify(anonId, user.id);
    return { user, subject: user ? `u:${user.id}` : anonId ? `a:${anonId}` : null };
  };
  const PLATFORMS = ['web', 'ios', 'android'];
  app.get('/api/public/experiments', (req, res) => {
    const anonId = ANON_ID.test(String(req.query.anon || '')) ? String(req.query.anon) : null;
    const platform = PLATFORMS.includes(req.query.platform) ? req.query.platform : 'web';
    const { subject } = subjectOf(req, anonId);
    if (!subject) return res.status(400).json({ error: 'anon id needed' });
    res.json({ subject, variants: insights.assignmentsFor(subject, platform) });
  });
  // At most 600 events a minute from one address: enough for any real use, not for flooding.
  const eventBudget = new Map();
  setInterval(() => eventBudget.clear(), 60e3).unref();
  app.post('/api/public/events', (req, res) => {
    const { anon, platform = 'web', events = [] } = req.body || {};
    const spent = (eventBudget.get(req.ip) || 0) + (Array.isArray(events) ? events.length : 1);
    eventBudget.set(req.ip, spent);
    if (spent > 600) return res.status(429).json({ error: 'Too many events. Try again in a minute.' });
    const anonId = ANON_ID.test(String(anon || '')) ? String(anon) : null;
    if (!Array.isArray(events) || events.length > 50) return res.status(400).json({ error: 'Send up to 50 events' });
    const { user } = subjectOf(req, anonId);
    if (!user && !anonId) return res.status(400).json({ error: 'anon id needed' });
    let saved = 0;
    const week = Date.now() - 7 * 864e5;
    for (const e of events) {
      if (!EVENT_NAME.test(String(e?.name || ''))) continue;
      const ts = Number(e.ts) > week && Number(e.ts) <= Date.now() + 60e3 ? Number(e.ts) : Date.now();
      const props = e.props && typeof e.props === 'object' && !Array.isArray(e.props) ? e.props : {};
      if (insights.track(e.name, { userId: user?.id ?? null, anonId, platform: PLATFORMS.includes(platform) ? platform : 'web', props, ts })) saved++;
    }
    res.json({ saved });
  });

  // --- calendar ---------------------------------------------------------------
  // Dated notes as a calendar that Google Calendar, iPhone, Mac or Outlook can
  // subscribe to. Calendar apps can't log in, so the link itself carries a
  // secret; a new link turns the old one off.
  const publicUrl = (req) => process.env.PUBLIC_URL?.replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
  const validTz = (tz) => {
    try {
      return tz && tz.length < 64 && new Intl.DateTimeFormat('en', { timeZone: tz }) ? tz : null;
    } catch {
      return null;
    }
  };
  const calendarNotes = (userId) =>
    store.changesSince(userId, 0, { items: false, shared: true }).filter((n) => !n.revoked && !n.deleted && !n.done && n.due_date);
  const sendIcs = (res, ics, filename) => {
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    if (filename) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(ics);
  };
  app.get('/api/calendar/:file', (req, res) => {
    const token = req.params.file.replace(/\.ics$/, '');
    const userId = token.length > 20 ? store.getMeta(`cal_user:${token}`) : null;
    if (!userId || !store.getUser(userId)) return res.status(404).send('This calendar link is no longer active.');
    const tz = store.getMeta(`cal_tz:${userId}`);
    sendIcs(res, toIcs(calendarNotes(userId), { name: 'record.ai', tz, link: publicUrl(req), itemsOf: (id) => store.items(id) }));
  });

  app.use('/api', requireUser(store));

  const calendarLink = (req) => {
    const token = store.getMeta(`cal_token:${req.user.id}`);
    const url = `${publicUrl(req)}/api/calendar/${token}.ics`;
    return { url, webcal: url.replace(/^https?:/, 'webcal:') };
  };
  const newCalendarToken = (userId) => {
    const old = store.getMeta(`cal_token:${userId}`);
    if (old) store.setMeta(`cal_user:${old}`, '');
    const token = crypto.randomBytes(24).toString('base64url');
    store.setMeta(`cal_token:${userId}`, token);
    store.setMeta(`cal_user:${token}`, userId);
  };
  // Your calendar link (made the first time). `tz` = this device's time zone.
  app.get('/api/calendar-link', (req, res) => {
    const tz = validTz(String(req.query.tz || ''));
    if (tz) store.setMeta(`cal_tz:${req.user.id}`, tz);
    if (!store.getMeta(`cal_token:${req.user.id}`)) newCalendarToken(req.user.id);
    res.json(calendarLink(req));
  });
  app.post('/api/calendar-link/reset', (req, res) => {
    newCalendarToken(req.user.id);
    res.json(calendarLink(req));
  });
  // One note as a calendar file, to add it to any calendar.
  app.get('/api/notes/:id/calendar.ics', (req, res) => {
    const note = store.get(req.params.id);
    if (!note || note.deleted || !store.access(req.user.id, note) || !note.due_date) return res.status(404).json({ error: 'No date on this note' });
    const name = noteTitle(note).replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'note';
    sendIcs(res, toIcs([note], { link: publicUrl(req), itemsOf: (id) => store.items(id) }), `${name}.ics`);
  });

  // --- notes ----------------------------------------------------------------
  // "My groups": groups the person made, which the AI always keeps and uses.
  app.get('/api/groups/mine', (req, res) => res.json({ names: store.myGroups(req.user.id) }));
  app.put('/api/groups/mine', (req, res) => {
    const names = req.body?.names;
    if (!Array.isArray(names) || names.length > MAX_MY_GROUPS || !names.every((n) => typeof n === 'string')) {
      return res.status(400).json({ error: `Send up to ${MAX_MY_GROUPS} group names.` });
    }
    const clean = [];
    for (const raw of names) {
      const name = raw.trim().replace(/\s+/g, ' ');
      if (!name || name.length > 40) return res.status(400).json({ error: 'Group names need 1 to 40 characters.' });
      if (!clean.some((n) => n.toLowerCase() === name.toLowerCase())) clean.push(name);
    }
    store.setMyGroups(req.user.id, clean);
    res.json({ names: clean });
  });

  app.get('/api/status', (req, res) => {
    res.json({
      ai: { ...organizer.status, usage: organizer.usage?.(req.user.id) },
      rev: store.rev,
      groups: store.groups(req.user.id),
      myGroups: store.myGroups(req.user.id),
    });
  });

  // Where other devices on the same network can reach this server.
  app.get('/api/server-info', (req, res) => {
    const port = req.socket.localPort;
    // Online (PUBLIC_URL set), the machine's own network addresses are the
    // host's internal ones, which no phone can reach: offer only the public address.
    const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, '');
    const addresses = publicUrl ? [publicUrl] : lanAddresses().map((a) => `http://${a}:${port}`);
    res.json({ port, addresses });
  });

  // Incremental sync: everything that changed after `since` (including deletions).
  app.get('/api/notes', (req, res) => {
    const since = Number(req.query.since) || 0;
    const notes = store.changesSince(req.user.id, since, { items: req.query.items === '1', shared: req.query.shared === '1' });
    res.json({ rev: store.rev, notes });
  });

  /** Applies one client change: { status: 'ok' | 'stale' | 'forbidden' | 'invalid', note?, error? }. */
  const applyChange = (userId, id, body) => {
    const error = invalidChange(id, body);
    if (error) return { status: 'invalid', error };
    const input = { id };
    for (const k of NOTE_FIELDS) if (k in body) input[k] = body[k];
    const before = store.get(id);
    if ('text' in input) input.text = String(input.text);
    if (input.user_group != null) input.user_group = String(input.user_group).trim().slice(0, 60) || null;
    const { note, stale, contentChanged, forbidden } = store.upsertFromClient(userId, input);
    if (forbidden) return { status: 'forbidden', error: 'Not your note' };
    const mine = note.user_id === userId;
    if (!stale) {
      onChange(note);
      // What people do (never what they write), for the dashboard and the A/B tests.
      if (!before && !note.parent_id) insights.track('note_created', { userId, props: { list: false } });
      if (before && mine && !note.parent_id && before.ai_status === 'done') {
        if (input.user_group && before.ai_group && input.user_group !== before.ai_group && !before.user_group) insights.track('ai_corrected', { userId, props: { field: 'group' } });
        if (input.user_priority && before.ai_priority && input.user_priority !== before.ai_priority && !before.user_priority) insights.track('ai_corrected', { userId, props: { field: 'priority' } });
      }
      if (contentChanged && !note.deleted) organizer.enqueue(id);
      // Deleting a list deletes its items.
      if (note.deleted && !note.parent_id) for (const item of store.deleteItems(id)) onChange(item);
    }
    return { status: stale ? 'stale' : 'ok', note: mine ? note : store.forRecipient(userId, note, store.access(userId, note)) };
  };

  app.put('/api/notes/:id', (req, res) => {
    const r = applyChange(req.user.id, req.params.id, req.body || {});
    if (r.status === 'invalid') return res.status(400).json({ error: r.error });
    if (r.status === 'forbidden') return res.status(403).json({ error: r.error });
    res.json({ note: r.note, stale: r.status === 'stale' });
  });

  // One round trip for a whole sync: send every unsent change, get back
  // everything that changed since `since` (including your own saved changes).
  app.post('/api/sync', (req, res) => {
    const { since = 0, changes = [], items = false, shared = false } = req.body || {};
    if (!Array.isArray(changes) || changes.length > MAX_BATCH) {
      return res.status(400).json({ error: `changes must be a list of at most ${MAX_BATCH}` });
    }
    const results = changes.map((c) => {
      const { status, error } = applyChange(req.user.id, c?.id, c || {});
      return error ? { id: c?.id, status, error } : { id: c?.id, status };
    });
    const notes = store.changesSince(req.user.id, Number(since) || 0, { items: items === true, shared: shared === true });
    res.json({ rev: store.rev, results, notes });
  });

  // Ask the AI to analyse one note again.
  app.post('/api/notes/:id/reanalyze', (req, res) => {
    const note = store.get(req.params.id);
    if (!note || note.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
    onChange(store.applyAi(note.id, { status: 'pending' }));
    organizer.enqueue(note.id);
    res.json({ ok: true });
  });

  app.post('/api/reorganize', async (req, res) => {
    broadcastStatus({ ...organizer.status, reorganizing: true });
    try {
      res.json(await organizer.reorganizeAll(req.user.id));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    } finally {
      broadcastStatus(organizer.status);
    }
  });

  // --- sharing ----------------------------------------------------------------
  // Share a note (with its list items) or a whole group with someone, by email.
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const ROLES = ['edit', 'view'];
  // After a share changes: new revisions for its notes (so every device
  // syncs them), live updates, and both people's apps reload their share lists.
  const shareChanged = (share) => {
    for (const note of store.touchShare(share)) onChange(note);
    sendShares(share.owner_id);
    if (share.user_id) sendShares(share.user_id);
  };

  app.get('/api/shares', (req, res) => {
    res.json({ mine: store.sharesBy(req.user.id), withMe: store.sharesWith(req.user.id) });
  });

  app.post('/api/shares', (req, res) => {
    const { kind, role = 'edit' } = req.body || {};
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    let target = String(req.body?.target ?? '').trim();
    if (!['note', 'group'].includes(kind)) return res.status(400).json({ error: 'Share a note or a group.' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Choose "can edit" or "view only".' });
    if (!EMAIL.test(email) || email.length > 200) return res.status(400).json({ error: 'Enter the email address of the person.' });
    if (email === req.user.email.toLowerCase()) return res.status(400).json({ error: "That's your own email." });
    if (kind === 'note') {
      const note = store.get(target);
      if (!note || note.user_id !== req.user.id || note.deleted) return res.status(404).json({ error: 'Note not found' });
      if (note.parent_id) return res.status(400).json({ error: 'Share the whole list.' });
    } else if (!target || target.length > 60) {
      return res.status(400).json({ error: 'Group names need 1 to 60 characters.' });
    }
    if (store.shareCount(req.user.id) >= 200) return res.status(400).json({ error: 'You can share up to 200 things.' });
    const share = store.addShare(req.user.id, { kind, target, email, role });
    shareChanged(share);
    insights.track('share_created', { userId: req.user.id, props: { kind, role, hasAccount: !!share.user_id } });
    res.json({ share, hasAccount: !!share.user_id });
  });

  app.patch('/api/shares/:id', (req, res) => {
    const share = store.getShare(req.params.id);
    if (!share || share.owner_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
    if (!ROLES.includes(req.body?.role)) return res.status(400).json({ error: 'Choose "can edit" or "view only".' });
    const updated = store.setShareRole(share.id, req.body.role);
    shareChanged(updated);
    res.json({ share: updated });
  });

  // The owner stops sharing, or the person leaves.
  app.delete('/api/shares/:id', (req, res) => {
    const share = store.getShare(req.params.id);
    if (!share || (share.owner_id !== req.user.id && share.user_id !== req.user.id)) {
      return res.status(404).json({ error: 'Not found' });
    }
    store.removeShare(share.id);
    shareChanged(share);
    res.json({ ok: true });
  });

  // --- plans, backups (premium), download all my notes ---------------------------
  app.get('/api/plan', (req, res) => {
    const plan = store.planOf(req.user.id);
    res.json({ plan, premium: premium(plan), admin: isAdmin(req.user), features: { backups: premium(plan), backupDays: 30 } });
  });

  app.get('/api/backups', (req, res) => {
    res.json({ premium: premium(store.planOf(req.user.id)), keepDays: 30, backups: backups.list(req.user.id) });
  });
  const needPremium = (req, res) => {
    if (premium(store.planOf(req.user.id))) return false;
    res.status(402).json({ error: 'Backups are part of Premium.' });
    return true;
  };
  app.post('/api/backups', (req, res) => {
    if (needPremium(req, res)) return;
    const recent = backups.list(req.user.id).find((b) => b.kind === 'manual' && Date.now() - b.created_at < 60e3);
    if (recent) return res.status(429).json({ error: 'A backup was just made. Try again in a minute.' });
    res.json({ backup: backups.create(req.user.id, 'manual') });
  });
  app.post('/api/backups/:id/restore', (req, res) => {
    if (needPremium(req, res)) return;
    const changed = backups.restore(req.user.id, req.params.id);
    if (!changed) return res.status(404).json({ error: 'Backup not found' });
    for (const note of changed) {
      onChange(note);
      // Saved before the AI had sorted it: sort it now.
      if (note.ai_status === 'pending' && !note.deleted) organizer.enqueue(note.id);
    }
    insights.track('backup_restored', { userId: req.user.id, props: { notes: changed.length } });
    res.json({ restored: changed.length, rev: store.rev });
  });
  app.get('/api/backups/:id/download', (req, res) => {
    if (needPremium(req, res)) return;
    const data = backups.read(req.user.id, req.params.id);
    if (!data) return res.status(404).json({ error: 'Backup not found' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="record-ai-backup-${req.params.id}.json"`);
    res.send(JSON.stringify(data, null, 2));
  });
  // For everyone (GDPR): all my notes and photos in one file.
  app.get('/api/export', async (req, res) => {
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="record-ai-notes-${new Date().toISOString().slice(0, 10)}.tar.gz"`);
    insights.track('export_downloaded', { userId: req.user.id });
    await backups.exportTo(req.user.id, res);
  });

  // --- the owner's dashboard: numbers, A/B tests, what the optimizer did ---------------
  const adminOnly = (req, res, next) => (isAdmin(req.user) ? next() : res.status(404).json({ error: 'Not found' }));
  app.get('/api/admin/overview', adminOnly, (req, res) => {
    optimizer.dailyReport();
    res.json({
      kpis: optimizer.history(30),
      experiments: insights.experiments().map((e) => ({ ...insights.results(e), description: e.description, guardrails: e.guardrails, auto: e.auto })),
      optimizer: { debounceMs: organizer.debounceMs ?? 0, quality: optimizer.correctionRate(Date.now() - 7 * 864e5) },
      log: optimizer.logEntries(50),
      users: store.allUsers().map((u) => ({ email: u.email, name: u.name, plan: store.planOf(u.id), created_at: u.created_at })),
    });
  });
  app.post('/api/admin/experiments', adminOnly, (req, res) => {
    try {
      res.json({ experiment: insights.saveExperiment(req.body || {}) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  // Until payments exist, the owner gives plans by hand (beta testers, family).
  app.post('/api/admin/plan', adminOnly, (req, res) => {
    const { email, plan } = req.body || {};
    if (!['free', 'solo', 'family'].includes(plan)) return res.status(400).json({ error: 'plan: free, solo or family' });
    const user = store.findUserByEmail(String(email || ''));
    if (!user) return res.status(404).json({ error: 'No account with this email' });
    store.setPlan(user.id, plan);
    insights.track('plan_changed', { userId: user.id, props: { plan, by: 'admin' } });
    res.json({ email: user.email, plan });
  });
  app.post('/api/admin/optimize', adminOnly, (req, res) => res.json(optimizer.runAll()));

  // --- images ---------------------------------------------------------------
  // Photos. `?variant=thumb` is a small preview (about 320 px) made by the
  // client, so lists never download full-size photos.
  const imagePath = (name, variant) =>
    variant === 'thumb' ? path.join(imagesDir, 'thumbs', name) : path.join(imagesDir, name);

  app.put(
    '/api/images/:name',
    express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }),
    (req, res) => {
      const { name } = req.params;
      const thumb = req.query.variant === 'thumb';
      if (!IMAGE_NAME.test(name)) return res.status(400).json({ error: 'Bad image name' });
      if (!req.body?.length) return res.status(400).json({ error: 'Empty body' });
      const owner = store.imageOwner(name);
      if (owner && owner !== req.user.id) return res.status(403).json({ error: 'Not your image' });
      const file = imagePath(name, thumb ? 'thumb' : 'full');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const existed = fs.existsSync(file);
      fs.writeFileSync(file, req.body);
      store.addImage(name, req.user.id);
      // A note may have been analysed before its photo arrived; redo it.
      if (!existed && !thumb) for (const n of store.active(req.user.id)) {
        if (n.images.includes(name) && n.ai_status !== 'pending') {
          onChange(store.applyAi(n.id, { status: 'pending' }));
          organizer.enqueue(n.id);
        }
      }
      res.json({ ok: true });
    },
  );

  app.get('/api/images/:name', (req, res) => {
    const { name } = req.params;
    if (!IMAGE_NAME.test(name)) return res.status(400).end();
    if (!store.canSeeImage(req.user.id, name)) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    const thumb = imagePath(name, 'thumb');
    const file = req.query.variant === 'thumb' && fs.existsSync(thumb) ? thumb : imagePath(name, 'full');
    res.sendFile(file, (err) => err && !res.headersSent && res.status(404).end());
  });

  // --- live event stream ------------------------------------------------------
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.wantsItems = req.query.items === '1';
    res.wantsShared = req.query.shared === '1';
    send(res, 'hello', { rev: store.rev, ai: organizer.status });
    const uid = req.user.id;
    if (!clients.has(uid)) clients.set(uid, new Set());
    clients.get(uid).add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.get(uid)?.delete(res);
    });
  });

  // --- static web app ---------------------------------------------------------
  app.use(
    express.static(PUBLIC_DIR, {
      setHeaders(res, file) {
        if (file.endsWith('sw.js') || file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  organizer.resumePending?.();
  return { app, store, organizer, insights, optimizer, backups };
}
