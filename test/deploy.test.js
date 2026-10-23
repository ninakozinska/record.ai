// Running online (Fly.io): visitor addresses behind the proxy, and moving notes over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { start, tmpDir } from './helpers.js';
import { createApp, trustProxy } from '../server/app.js';
import { importArchive } from '../server/import.js';
import { openDb } from '../server/db.js';

test('TRUST_PROXY setting', () => {
  assert.equal(trustProxy(undefined), 'loopback');
  assert.equal(trustProxy('1'), 1);
  assert.equal(trustProxy('true'), true);
  assert.equal(trustProxy('10.0.0.0/8'), '10.0.0.0/8');
  // On Fly.io the proxy is not this machine, so the app must be told to trust it.
  process.env.TRUST_PROXY = '1';
  try {
    const { app, organizer } = createApp({ dataDir: tmpDir() });
    assert.equal(app.get('trust proxy'), 1);
    organizer.stop?.();
  } finally {
    delete process.env.TRUST_PROXY;
  }
  assert.equal(createApp({ dataDir: tmpDir() }).app.get('trust proxy'), 'loopback');
});

test('behind a proxy, one person\'s wrong passwords do not lock out everyone', async () => {
  process.env.TRUST_PROXY = '1';
  const s = await start();
  try {
    const login = (ip, password) => fetch(`${s.base}auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify({ email: `someone-${ip}@example.com`, password }),
    });
    for (let i = 0; i < 10; i++) await login('203.0.113.7', 'wrong');
    assert.equal((await login('203.0.113.7', 'wrong')).status, 429, 'the guesser is slowed down');
    // Nina, from another address, can still log in.
    const ok = await fetch(`${s.base}auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.9', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ email: 'nina@example.com', password: 'correct horse' }),
    });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('set-cookie'), /Secure/, 'https is recognised behind the proxy');
  } finally {
    delete process.env.TRUST_PROXY;
    s.close();
  }
});

test('notes and photos move to a new server with import.tar.gz', async () => {
  // The old server (your Mac): one account, one note, one photo.
  const old = await start();
  await old.api('notes/note-0000001', { method: 'PUT', body: JSON.stringify({ text: 'moved note', edited_at: Date.now() }) });
  await fetch(`${old.base}images/aaaaaaaa-photo.jpg`, { method: 'PUT', headers: { cookie: old.cookie(), 'Content-Type': 'image/jpeg' }, body: Buffer.from('jpeg') });
  old.close();
  const archive = path.join(tmpDir(), 'data.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', old.dataDir, '.']);

  // The new server already has an empty database of its own.
  const fresh = tmpDir();
  openDb(fresh).db?.close?.();
  fs.copyFileSync(archive, path.join(fresh, 'import.tar.gz'));
  assert.equal(importArchive(fresh, { log() {} }), true);
  assert.equal(fs.existsSync(path.join(fresh, 'import.tar.gz')), false, 'archive removed after import');
  assert.equal(importArchive(fresh, { log() {} }), false, 'nothing to do the second time');

  const store = openDb(fresh);
  const user = store.findUserByEmail('nina@example.com');
  assert.ok(user, 'the account came along');
  assert.deepEqual(store.active(user.id).map((n) => n.text), ['moved note']);
  assert.ok(fs.existsSync(path.join(fresh, 'images', 'aaaaaaaa-photo.jpg')));
});

test('online, the account menu offers only the public address, not the host\'s internal ones', async () => {
  process.env.PUBLIC_URL = 'https://record-ai-nina.fly.dev/';
  const s = await start();
  try {
    assert.deepEqual((await s.api('server-info')).body.addresses, ['https://record-ai-nina.fly.dev']);
  } finally {
    delete process.env.PUBLIC_URL;
    s.close();
  }
});
