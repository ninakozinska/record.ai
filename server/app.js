// HTTP API + static web app hosting.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb, PRIORITIES } from './db.js';
import { Organizer } from './organizer.js';
import { authRoutes, requireUser } from './auth.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const IMAGE_NAME = /^[a-zA-Z0-9-]{8,64}\.(jpg|jpeg|png|webp|gif)$/;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

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

  app.put('/api/notes/:id', (req, res) => {
    const body = req.body || {};
    const id = req.params.id;
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) return res.status(400).json({ error: 'Bad id' });
    if (typeof body.edited_at !== 'number') return res.status(400).json({ error: 'edited_at required' });
    if (body.user_priority != null && !PRIORITIES.includes(body.user_priority)) {
      return res.status(400).json({ error: 'Bad priority' });
    }
    if (body.images && !(Array.isArray(body.images) && body.images.every((n) => IMAGE_NAME.test(n)))) {
      return res.status(400).json({ error: 'Bad image list' });
    }
    if (body.user_group != null) body.user_group = String(body.user_group).trim().slice(0, 60) || null;

    const input = { id };
    for (const k of ['text', 'images', 'done', 'deleted', 'created_at', 'edited_at', 'user_group', 'user_priority']) {
      if (k in body) input[k] = body[k];
    }
    if ('text' in input) input.text = String(input.text);
    const { note, stale, contentChanged, forbidden } = store.upsertFromClient(req.user.id, input);
    if (forbidden) return res.status(403).json({ error: 'Not your note' });
    if (!stale) {
      onChange(note);
      if (contentChanged && !note.deleted) organizer.enqueue(id);
    }
    res.json({ note, stale: !!stale });
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
  app.put(
    '/api/images/:name',
    express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }),
    (req, res) => {
      const { name } = req.params;
      if (!IMAGE_NAME.test(name)) return res.status(400).json({ error: 'Bad image name' });
      if (!req.body?.length) return res.status(400).json({ error: 'Empty body' });
      const owner = store.imageOwner(name);
      if (owner && owner !== req.user.id) return res.status(403).json({ error: 'Not your image' });
      const file = path.join(imagesDir, name);
      const existed = fs.existsSync(file);
      fs.writeFileSync(file, req.body);
      store.addImage(name, req.user.id);
      // A note may have been analysed before its photo arrived; redo it.
      if (!existed) for (const n of store.active(req.user.id)) {
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
    res.sendFile(path.join(imagesDir, name), (err) => err && !res.headersSent && res.status(404).end());
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
