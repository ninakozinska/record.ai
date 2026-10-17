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
const NOTE_FIELDS = ['text', 'images', 'done', 'deleted', 'created_at', 'edited_at', 'user_group', 'user_priority'];

/** Checks one note change from a client. Returns an error message, or null when it is valid. */
function invalidChange(id, body) {
  if (!NOTE_ID.test(String(id))) return 'Bad id';
  if (typeof body.edited_at !== 'number') return 'edited_at required';
  if (body.user_priority != null && !PRIORITIES.includes(body.user_priority)) return 'Bad priority';
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

export function createApp({ dataDir, organizer: makeOrganizer } = {}) {
  const store = openDb(dataDir);
  const imagesDir = path.join(dataDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  // --- live updates (Server-Sent Events), one channel per user ---------------
  const clients = new Map(); // userId -> Set<res>
  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const onChange = (note) => {
    for (const res of clients.get(note.user_id) || []) send(res, 'note', note);
  };
  const broadcastStatus = (status) => {
    for (const set of clients.values()) for (const res of set) send(res, 'status', status);
  };

  const organizer = makeOrganizer
    ? makeOrganizer({ store, imagesDir, onChange })
    : new Organizer({ store, imagesDir, onChange });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
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
  app.use('/api/auth', authRoutes({ store, imagesDir }));
  app.use('/api', requireUser(store));

  // --- notes ----------------------------------------------------------------
  app.get('/api/status', (req, res) => {
    res.json({ ai: organizer.status, rev: store.rev, groups: store.groups(req.user.id) });
  });

  // Where other devices on the same network can reach this server.
  app.get('/api/server-info', (req, res) => {
    const port = req.socket.localPort;
    res.json({ port, addresses: lanAddresses().map((a) => `http://${a}:${port}`) });
  });

  // Incremental sync: everything that changed after `since` (including deletions).
  app.get('/api/notes', (req, res) => {
    const since = Number(req.query.since) || 0;
    res.json({ rev: store.rev, notes: store.changesSince(req.user.id, since) });
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
    if (!stale) {
      onChange(note);
      if (contentChanged && !note.deleted) organizer.enqueue(id);
    }
    return { status: stale ? 'stale' : 'ok', note };
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
    const { since = 0, changes = [] } = req.body || {};
    if (!Array.isArray(changes) || changes.length > MAX_BATCH) {
      return res.status(400).json({ error: `changes must be a list of at most ${MAX_BATCH}` });
    }
    const results = changes.map((c) => {
      const { status, error } = applyChange(req.user.id, c?.id, c || {});
      return error ? { id: c?.id, status, error } : { id: c?.id, status };
    });
    res.json({ rev: store.rev, results, notes: store.changesSince(req.user.id, Number(since) || 0) });
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
    if (store.imageOwner(name) !== req.user.id) return res.status(404).end();
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
