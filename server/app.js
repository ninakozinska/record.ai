// HTTP API + static web app hosting.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import { openDb, PRIORITIES } from './db.js';
import { Organizer } from './organizer.js';
import { authRoutes, requireUser } from './auth.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const IMAGE_NAME = /^[a-zA-Z0-9-]{8,64}\.(jpg|jpeg|png|webp|gif)$/;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const NOTE_ID = /^[a-zA-Z0-9-]{8,64}$/;
const MAX_BATCH = 500;
const MAX_MY_GROUPS = 30;
const NOTE_FIELDS = ['text', 'images', 'done', 'deleted', 'created_at', 'edited_at', 'user_group', 'user_priority', 'parent_id'];

/** Checks one note change from a client. Returns an error message, or null when it is valid. */
function invalidChange(id, body) {
  if (!NOTE_ID.test(String(id))) return 'Bad id';
  if (typeof body.edited_at !== 'number') return 'edited_at required';
  if (body.user_priority != null && !PRIORITIES.includes(body.user_priority)) return 'Bad priority';
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

  const organizer = makeOrganizer
    ? makeOrganizer({ store, imagesDir, onChange })
    : new Organizer({ store, imagesDir, onChange });

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
  app.use('/api/auth', authRoutes({ store, imagesDir, oauth }));
  app.use('/api', requireUser(store));

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
    res.json({ ai: organizer.status, rev: store.rev, groups: store.groups(req.user.id), myGroups: store.myGroups(req.user.id) });
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
    if ('text' in input) input.text = String(input.text);
    if (input.user_group != null) input.user_group = String(input.user_group).trim().slice(0, 60) || null;
    const { note, stale, contentChanged, forbidden } = store.upsertFromClient(userId, input);
    if (forbidden) return { status: 'forbidden', error: 'Not your note' };
    const mine = note.user_id === userId;
    if (!stale) {
      onChange(note);
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
      res.status(500).json({ error: err.message });
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
  return { app, store, organizer };
}
