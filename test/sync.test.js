// Efficient sync: one batched request, compressed answers, photo thumbnails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { start } from './helpers.js';

const sync = (s, body) => s.api('sync', { method: 'POST', body: JSON.stringify(body) });

test('one /api/sync request sends all changes and returns everything new', async () => {
  const s = await start();
  try {
    // Something saved earlier (e.g. from another device).
    await s.api('notes/note-sync-0000', { method: 'PUT', body: JSON.stringify({ text: 'from the web', edited_at: 1 }) });
    const r = await sync(s, {
      since: 0,
      changes: [
        { id: 'note-sync-0001', text: 'buy milk', created_at: 10, edited_at: 10 },
        { id: 'note-sync-0002', text: 'call mum', edited_at: 11, user_priority: 'high' },
        { id: 'bad id', text: 'x', edited_at: 12 },
        { id: 'note-sync-0003', text: 'no time' },
      ],
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results.map((x) => x.status), ['ok', 'ok', 'invalid', 'invalid']);
    assert.deepEqual(r.body.notes.map((n) => n.id).sort(), ['note-sync-0000', 'note-sync-0001', 'note-sync-0002']);
    assert.equal(r.body.notes.find((n) => n.id === 'note-sync-0002').priority, 'high');

    // Next rounds return only what changed since (here: the AI's results), then nothing.
    for (let i = 0; i < 100 && s.store.pendingIds().length; i++) await new Promise((ok) => setTimeout(ok, 10));
    const ai = await sync(s, { since: r.body.rev, changes: [] });
    assert.ok(ai.body.notes.every((n) => n.ai_status !== 'pending'));
    const again = await sync(s, { since: ai.body.rev, changes: [] });
    assert.deepEqual(again.body.notes, []);

    // An older offline edit is reported as stale, not applied.
    const stale = await sync(s, { since: r.body.rev, changes: [{ id: 'note-sync-0001', text: 'old', edited_at: 5 }] });
    assert.equal(stale.body.results[0].status, 'stale');
    assert.equal(s.store.get('note-sync-0001').text, 'buy milk');

    assert.equal((await sync(s, { changes: 'nope' })).status, 400);
    assert.equal((await sync(s, { changes: Array.from({ length: 501 }, () => ({})) })).status, 400);
  } finally {
    s.close();
  }
});

test("a batch can't touch another user's notes", async () => {
  process.env.ALLOW_SIGNUP = 'true';
  const s = await start();
  try {
    await s.api('notes/note-sync-a001', { method: 'PUT', body: JSON.stringify({ text: 'mine', edited_at: 1 }) });
    const res = await fetch(`${s.base}auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'B', email: 'b@example.com', password: 'long enough' }),
    });
    const { token } = await res.json();
    const r = await (await fetch(`${s.base}sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ since: 0, changes: [{ id: 'note-sync-a001', text: 'hacked', edited_at: 99 }] }),
    })).json();
    assert.equal(r.results[0].status, 'forbidden');
    assert.deepEqual(r.notes, []);
    assert.equal(s.store.get('note-sync-a001').text, 'mine');
  } finally {
    delete process.env.ALLOW_SIGNUP;
    s.close();
  }
});

/** Raw request, to see the bytes and headers on the wire. */
function raw(url, headers) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ headers: res.headers, bytes: Buffer.concat(chunks).length }));
    }).on('error', reject);
  });
}

test('answers are compressed, live updates and photos are not', async () => {
  const s = await start();
  try {
    for (let i = 0; i < 40; i++) {
      await s.api(`notes/note-gzip-${String(i).padStart(4, '0')}`, {
        method: 'PUT',
        body: JSON.stringify({ text: `Note number ${i}: remember to compare prices before buying`, edited_at: i + 1 }),
      });
    }
    const token = s.store.createSession(s.user.id);
    const auth = { Authorization: `Bearer ${token}` };
    const plain = await raw(`${s.base}notes?since=0`, auth);
    const zipped = await raw(`${s.base}notes?since=0`, { ...auth, 'Accept-Encoding': 'gzip' });
    assert.equal(zipped.headers['content-encoding'], 'gzip');
    assert.ok(zipped.bytes * 4 < plain.bytes, `gzip ${zipped.bytes} B vs plain ${plain.bytes} B`);

    await s.api('images/aaaaaaaa-gzip.jpg', { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.alloc(4000, 1) });
    const img = await raw(`${s.base}images/aaaaaaaa-gzip.jpg`, { ...auth, 'Accept-Encoding': 'gzip' });
    assert.equal(img.headers['content-encoding'], undefined);

    const events = await new Promise((resolve) => {
      http.get(`${s.base}events`, { headers: { ...auth, 'Accept-Encoding': 'gzip' } }, (res) => {
        res.once('data', (chunk) => {
          resolve({ headers: res.headers, first: chunk.toString() });
          res.destroy();
        });
      });
    });
    assert.equal(events.headers['content-encoding'], undefined);
    assert.match(events.first, /event: hello/);
  } finally {
    s.close();
  }
});

test('photo thumbnails: uploaded separately, served on request, full size otherwise', async () => {
  process.env.ALLOW_SIGNUP = 'true';
  const s = await start();
  try {
    const name = 'aaaaaaaa-thumb.jpg';
    const put = (variant, bytes) =>
      s.api(`images/${name}${variant ? '?variant=thumb' : ''}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.alloc(bytes, 7) });
    assert.equal((await put(false, 5000)).status, 200);
    // No thumbnail yet: the full photo is served.
    assert.equal((await s.api(`images/${name}?variant=thumb`)).status, 200);
    assert.equal((await put(true, 300)).status, 200);
    const token = s.store.createSession(s.user.id);
    const size = async (q) => (await (await fetch(`${s.base}images/${name}${q}`, { headers: { Authorization: `Bearer ${token}` } })).arrayBuffer()).byteLength;
    assert.equal(await size('?variant=thumb'), 300);
    assert.equal(await size(''), 5000);

    // Someone else can't upload a thumbnail for your photo.
    const other = await (await fetch(`${s.base}auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'B', email: 'b2@example.com', password: 'long enough' }),
    })).json();
    const steal = await fetch(`${s.base}images/${name}?variant=thumb`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${other.token}` },
      body: Buffer.alloc(10),
    });
    assert.equal(steal.status, 403);
  } finally {
    delete process.env.ALLOW_SIGNUP;
    s.close();
  }
});
