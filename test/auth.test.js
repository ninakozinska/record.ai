import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { start } from './helpers.js';
import { openDb } from '../server/db.js';

const json = (body) => ({ method: 'POST', body: JSON.stringify(body) });

/** A second, independent client (own cookie jar) against the same server. */
function client(base) {
  let cookie = '';
  return async (p, init = {}) => {
    const res = await fetch(base + p, { ...init, headers: { 'Content-Type': 'application/json', cookie, ...init.headers } });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

test('first account can sign up; later sign-ups need permission', async () => {
  const s = await start({ noSignup: true });
  try {
    let state = (await s.api('auth/state')).body;
    assert.equal(state.user, null);
    assert.equal(state.signup.firstAccount, true);
    assert.equal((await s.api('notes')).status, 401, 'API is closed before login');

    assert.equal((await s.api('auth/signup', json({ name: 'N', email: 'bad', password: 'long enough' }))).status, 400);
    assert.equal((await s.api('auth/signup', json({ name: 'N', email: 'n@x.io', password: 'short' }))).status, 400);
    const ok = await s.api('auth/signup', json({ name: 'Nina', email: 'Nina@Example.com', password: 'correct horse' }));
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token);
    assert.equal((await s.api('notes')).status, 200, 'signed in after sign-up');

    const other = client(s.base);
    state = (await other('auth/state')).body;
    assert.equal(state.signup.open, false);
    assert.equal((await other('auth/signup', json({ name: 'Eve', email: 'eve@x.io', password: 'long enough' }))).status, 403);

    process.env.SIGNUP_CODE = 'family-2026';
    assert.equal((await other('auth/state')).body.signup.needsCode, true);
    assert.equal((await other('auth/signup', json({ name: 'Bruno', email: 'b@x.io', password: 'long enough', code: 'nope' }))).status, 403);
    assert.equal((await other('auth/signup', json({ name: 'Bruno', email: 'b@x.io', password: 'long enough', code: 'family-2026' }))).status, 200);
    assert.equal((await other('auth/signup', json({ name: 'Again', email: 'NINA@example.com', password: 'long enough', code: 'family-2026' }))).status, 409, 'email is unique, any case');
  } finally {
    delete process.env.SIGNUP_CODE;
    s.close();
  }
});

test('log in, wrong password, throttling, log out', async () => {
  const s = await start();
  try {
    const c = client(s.base);
    assert.equal((await c('auth/login', json({ email: 'nina@example.com', password: 'wrong one' }))).status, 401);
    assert.equal((await c('auth/login', json({ email: 'nobody@example.com', password: 'whatever' }))).status, 401);
    const ok = await c('auth/login', json({ email: 'NINA@example.com', password: 'correct horse' }));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.name, 'Nina');
    assert.equal((await c('auth/me')).body.devices, 2, 'sign-up session + this one');

    // Bearer tokens work too (used by the iPhone app).
    const bearer = await fetch(s.base + 'notes', { headers: { authorization: `Bearer ${ok.body.token}` } });
    assert.equal(bearer.status, 200);

    assert.equal((await c('auth/logout', json({}))).status, 200);
    assert.equal((await c('notes')).status, 401);
    const stillBearer = await fetch(s.base + 'notes', { headers: { authorization: `Bearer ${ok.body.token}` } });
    assert.equal(stillBearer.status, 401, 'logout ends the session everywhere it is used');

    const bad = client(s.base);
    for (let i = 0; i < 10; i++) await bad('auth/login', json({ email: 'nina@example.com', password: `guess ${i}` }));
    const blocked = await bad('auth/login', json({ email: 'nina@example.com', password: 'correct horse' }));
    assert.equal(blocked.status, 429, 'too many attempts');
  } finally {
    s.close();
  }
});

test('changing the password logs out other devices', async () => {
  const s = await start();
  try {
    const phone = client(s.base);
    await phone('auth/login', json({ email: 'nina@example.com', password: 'correct horse' }));
    assert.equal((await s.api('auth/password', json({ current: 'wrong', next: 'new password!' }))).status, 403);
    assert.equal((await s.api('auth/password', json({ current: 'correct horse', next: 'short' }))).status, 400);
    assert.equal((await s.api('auth/password', json({ current: 'correct horse', next: 'new password!' }))).status, 200);
    assert.equal((await s.api('notes')).status, 200, 'this device stays logged in');
    assert.equal((await phone('notes')).status, 401, 'other device is logged out');
    assert.equal((await phone('auth/login', json({ email: 'nina@example.com', password: 'new password!' }))).status, 200);

    await phone('auth/login', json({ email: 'nina@example.com', password: 'new password!' }));
    assert.equal((await s.api('auth/logout-others', json({}))).body.devices, 1);
    assert.equal((await phone('notes')).status, 401);
  } finally {
    s.close();
  }
});

test("users never see each other's notes or photos", async () => {
  process.env.ALLOW_SIGNUP = 'true';
  const s = await start();
  try {
    const bruno = client(s.base);
    await bruno('auth/signup', json({ name: 'Bruno', email: 'bruno@example.com', password: 'long enough' }));

    const img = 'aaaaaaaa-nina-0001.jpg';
    await s.api(`images/${img}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from([1, 2]) });
    await s.api('notes/note-nina-0001', { method: 'PUT', body: JSON.stringify({ text: 'secret plan', images: [img], edited_at: 1 }) });

    assert.equal((await bruno('notes?since=0')).body.notes.length, 0);
    assert.equal((await s.api('notes?since=0')).body.notes.length, 1);
    const steal = await bruno('notes/note-nina-0001', { method: 'PUT', body: JSON.stringify({ text: 'hacked', edited_at: 99 }) });
    assert.equal(steal.status, 403);
    assert.equal(s.store.get('note-nina-0001').text, 'secret plan');
    assert.equal((await bruno(`images/${img}`)).status, 404);
    assert.equal((await bruno(`images/${img}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from([9]) })).status, 403);
    assert.equal((await bruno('notes/note-nina-0001/reanalyze', json({}))).status, 404);
    assert.equal((await s.api(`images/${img}`)).status, 200);
  } finally {
    delete process.env.ALLOW_SIGNUP;
    s.close();
  }
});

test('notes and photos from before accounts go to the first account', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-ai-legacy-'));
  // A database in the old format (no accounts, shared-password sessions).
  const old = new DatabaseSync(path.join(dir, 'notes.db'));
  old.exec(`
    CREATE TABLE notes (id TEXT PRIMARY KEY, text TEXT NOT NULL DEFAULT '', images TEXT NOT NULL DEFAULT '[]',
      done INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      edited_at INTEGER NOT NULL, user_group TEXT, user_priority TEXT, title TEXT, summary TEXT, ai_group TEXT,
      ai_priority TEXT, priority_reason TEXT, tags TEXT NOT NULL DEFAULT '[]', due_date TEXT,
      ai_status TEXT NOT NULL DEFAULT 'pending', ai_error TEXT, rev INTEGER NOT NULL);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    INSERT INTO notes (id, text, images, created_at, edited_at, user_priority, rev)
      VALUES ('note-old-0001', 'prepare documents', '["aaaaaaaa-old.jpg"]', 1, 1, 'high', 5);
    INSERT INTO sessions VALUES ('old-token', 1);`);
  old.close();
  fs.mkdirSync(path.join(dir, 'images'));
  fs.writeFileSync(path.join(dir, 'images', 'aaaaaaaa-old.jpg'), 'x');

  const store = openDb(dir);
  const user = store.createUser({ email: 'nina@example.com', name: 'Nina', pwHash: 'x', imagesDir: path.join(dir, 'images') });
  const notes = store.changesSince(user.id, 0);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].priority, 'high', 'manual priority kept');
  assert.equal(store.imageOwner('aaaaaaaa-old.jpg'), user.id);
  assert.equal(store.sessionUser('old-token'), null, 'old shared-password sessions are gone');

  const second = store.createUser({ email: 'b@example.com', name: 'B', pwHash: 'x', imagesDir: path.join(dir, 'images') });
  assert.equal(store.changesSince(second.id, 0).length, 0);
});

test('session tokens are stored hashed', async () => {
  const s = await start();
  try {
    const row = s.store.db.prepare('SELECT * FROM sessions').get();
    assert.ok(row.token_hash.length === 64);
    assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get('anything').n, 0);
    const pw = s.store.db.prepare('SELECT pw_hash FROM users').get().pw_hash;
    assert.match(pw, /^scrypt\$/);
    assert.ok(!pw.includes('correct horse'));
  } finally {
    s.close();
  }
});

test('forgot password: a one-hour link by email resets it and logs out every device', async () => {
  const sent = [];
  const s = await start({ mail: { configured: true, send: async (m) => sent.push(m) } });
  try {
    const phone = client(s.base);
    await phone('auth/login', json({ email: 'nina@example.com', password: 'correct horse' }));

    // The same answer for unknown addresses: nobody can test which emails have accounts.
    assert.equal((await phone('auth/forgot', json({ email: 'nobody@example.com' }))).status, 200);
    assert.equal(sent.length, 0);
    assert.equal((await phone('auth/forgot', json({ email: 'not an email' }))).status, 400);

    assert.equal((await phone('auth/forgot', json({ email: 'Nina@Example.com' }))).status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'nina@example.com');
    const token = sent[0].text.match(/#reset=([A-Za-z0-9_-]+)/)[1];

    const fresh = client(s.base);
    assert.equal((await fresh('auth/reset', json({ token: 'made-up', password: 'brand new pw' }))).status, 400);
    assert.equal((await fresh('auth/reset', json({ token, password: 'short' }))).status, 400);
    const r = await fresh('auth/reset', json({ token, password: 'brand new pw' }));
    assert.equal(r.status, 200);
    assert.equal(r.body.user.email, 'nina@example.com');
    assert.equal((await fresh('notes')).status, 200, 'logged in with the new password');
    assert.equal((await phone('notes')).status, 401, 'other devices are logged out');
    assert.equal((await s.api('notes')).status, 401);
    assert.equal((await fresh('auth/reset', json({ token, password: 'again again' }))).status, 400, 'a link works once');
    assert.equal((await phone('auth/login', json({ email: 'nina@example.com', password: 'brand new pw' }))).status, 200);

    // An expired link does nothing.
    await phone('auth/forgot', json({ email: 'nina@example.com' }));
    const old = sent[1].text.match(/#reset=([A-Za-z0-9_-]+)/)[1];
    const key = s.store.db.prepare("SELECT key FROM meta WHERE key LIKE 'reset:%'").get().key;
    s.store.setMeta(key, JSON.stringify({ userId: s.user.id, expires: Date.now() - 1 }));
    assert.equal((await fresh('auth/reset', json({ token: old, password: 'brand new pw2' }))).status, 400);
  } finally {
    s.close();
  }
});
