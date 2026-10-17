// HTTP API + static PWA hosting.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb, PRIORITIES } from './db.js';
import { Organizer } from './organizer.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const IMAGE_NAME = /^[a-zA-Z0-9-]{8,64}\.(jpg|jpeg|png|webp|gif)$/;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export function createApp({ dataDir, password = process.env.APP_PASSWORD, organizer: makeOrganizer } = {}) {
  const store = openDb(dataDir);
  const imagesDir = path.join(dataDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  // --- live updates (Server-Sent Events) -----------------------------------
  const clients = new Set();
  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  const onChange = (note) => broadcast('note', note);

  const organizer = makeOrganizer
    ? makeOrganizer({ store, imagesDir, onChange })
    : new Organizer({ store, imagesDir, onChange });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '25mb' }));

  // --- auth -----------------------------------------------------------------
  // Single-owner app: one shared password (APP_PASSWORD) gives a long-lived
  // session cookie. With no password set the app is open (local use only).
  const COOKIE = 'notes_session';
  const getToken = (req) => {
    const header = req.get('authorization');
    if (header?.startsWith('Bearer ')) return header.slice(7);
    const cookie = req.get('cookie') || '';
    const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    return m?.[1];
  };
  const authed = (req) => !password || (getToken(req) && store.hasSession(getToken(req)));

  app.post('/api/login', (req, res) => {
    const given = String(req.body?.password ?? '');
    const ok =
      !password ||
      (given.length === password.length &&
        crypto.timingSafeEqual(Buffer.from(given), Buffer.from(password)));
    if (!ok) return res.status(401).json({ error: 'Wrong password' });
    const token = crypto.randomBytes(32).toString('hex');
    store.addSession(token);
    const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 400}${secure}`,
    );
    res.json({ token });
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.use('/api', (req, res, next) => {
    if (authed(req)) return next();
    res.status(401).json({ error: 'Login required', passwordRequired: true });
  });

  // --- notes ----------------------------------------------------------------
  app.get('/api/status', (req, res) => {
    res.json({ ai: organizer.status, rev: store.rev, groups: store.groups() });
  });

  // Incremental sync: everything that changed after `since` (including deletions).
  app.get('/api/notes', (req, res) => {
    const since = Number(req.query.since) || 0;
    res.json({ rev: store.rev, notes: store.changesSince(since) });
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
    const { note, stale, contentChanged } = store.upsertFromClient(input);
    if (!stale) {
      onChange(note);
      if (contentChanged && !note.deleted) organizer.enqueue(id);
    }
    res.json({ note, stale: !!stale });
  });

  // Ask the AI to analyse one note again.
  app.post('/api/notes/:id/reanalyze', (req, res) => {
    const note = store.get(req.params.id);
    if (!note) return res.status(404).json({ error: 'Not found' });
    onChange(store.applyAi(note.id, { status: 'pending' }));
    organizer.enqueue(note.id);
    res.json({ ok: true });
  });

  app.post('/api/reorganize', async (req, res) => {
    broadcast('status', { ...organizer.status, reorganizing: true });
    try {
      res.json(await organizer.reorganizeAll());
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      broadcast('status', organizer.status);
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
      const file = path.join(imagesDir, name);
      const existed = fs.existsSync(file);
      fs.writeFileSync(file, req.body);
      // A note may have been analysed before its photo arrived; redo it.
      if (!existed) for (const n of store.active()) {
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
    res.write(`event: hello\ndata: ${JSON.stringify({ rev: store.rev, ai: organizer.status })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });

  // --- static PWA -------------------------------------------------------------
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
