// The nightly copy of the database to Cloudflare R2 (any S3-compatible storage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.js';
import { Offsite, signV4, r2Config } from '../server/offsite.js';

const ENV = {
  R2_ACCESS_KEY_ID: 'AKID', R2_SECRET_ACCESS_KEY: 'secret',
  R2_ENDPOINT: 'https://acct.eu.r2.cloudflarestorage.com/', R2_BUCKET: 'sortmemo-backups',
};

/** A pretend R2 bucket: keeps what is uploaded, answers list and delete. */
function fakeR2({ failPut = false, corrupt = false } = {}) {
  const objects = new Map();
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, url: u, headers: init.headers });
    assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    const key = decodeURIComponent(u.pathname.replace(/^\/sortmemo-backups\/?/, ''));
    if (method === 'PUT') {
      if (failPut) return new Response('no', { status: 403 });
      objects.set(key, corrupt ? Buffer.from('x') : Buffer.from(init.body));
      return new Response(null, { status: 200 });
    }
    if (method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
    if (u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') || '';
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
      return new Response(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`);
    }
    const obj = objects.get(key);
    return obj ? new Response(obj) : new Response('missing', { status: 404 });
  };
  return { objects, calls, fetch };
}

function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offsite-'));
  const store = openDb(dir);
  const user = store.createUser({ email: 'nina@example.com', name: 'Nina', pwHash: 'x', imagesDir: path.join(dir, 'images') });
  store.upsertFromClient(user.id, { id: crypto.randomUUID(), text: 'Dentist Thursday', edited_at: Date.now() });
  const r2 = fakeR2(opts);
  let now = new Date('2026-11-27T02:00:00Z');
  const sent = [];
  const offsite = new Offsite({
    store, dataDir: dir, env: opts.env ?? ENV, fetch: r2.fetch, now: () => now,
    notify: async (text) => sent.push(text), log: { log() {}, error() {} },
  });
  return { dir, store, r2, offsite, sent, setNow: (d) => { now = new Date(d); } };
}

test('signing matches the AWS Signature Version 4 example (get-vanilla)', () => {
  const amzDate = '20150830T123600Z';
  const auth = signV4({
    method: 'GET', url: 'https://example.amazonaws.com/', amzDate,
    headers: { host: 'example.amazonaws.com', 'x-amz-date': amzDate },
    payloadHash: crypto.createHash('sha256').update('').digest('hex'),
    accessKeyId: 'AKIDEXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service',
  });
  assert.equal(auth, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

test('without the four R2 secrets, nothing happens', async () => {
  assert.equal(r2Config({ R2_ACCESS_KEY_ID: 'a', R2_BUCKET: 'b' }), null);
  const t = setup({ env: {} });
  assert.equal(t.offsite.enabled, false);
  assert.equal(await t.offsite.runNightly(), null);
  assert.equal(t.r2.calls.length, 0);
});

test('every night a whole, readable copy of the database goes to R2, once a day', async () => {
  const t = setup();
  const r = await t.offsite.runNightly();
  assert.equal(r.key, 'db/2026-11-27.db.gz');
  // The copy is a real database with the note in it.
  const file = path.join(t.dir, 'restored.db');
  fs.writeFileSync(file, zlib.gunzipSync(t.r2.objects.get('db/2026-11-27.db.gz')));
  const db = new DatabaseSync(file);
  assert.equal(db.prepare('SELECT text FROM notes').get().text, 'Dentist Thursday');
  db.close();
  // It was read back after the upload, to check it arrived whole.
  assert.ok(t.r2.calls.some((c) => c.method === 'GET' && c.url.pathname.endsWith('/db/2026-11-27.db.gz')));
  // Later the same day: nothing more.
  const calls = t.r2.calls.length;
  assert.equal(await t.offsite.runNightly(), null);
  assert.equal(t.r2.calls.length, calls);
});

test('copies older than 30 days are removed, newer ones kept', async () => {
  const t = setup();
  t.r2.objects.set('db/2026-10-20.db.gz', Buffer.from('old'));
  t.r2.objects.set('db/2026-11-01.db.gz', Buffer.from('recent'));
  const r = await t.offsite.runNightly();
  assert.deepEqual(r.removed, ['db/2026-10-20.db.gz']);
  assert.deepEqual([...t.r2.objects.keys()].sort(), ['db/2026-11-01.db.gz', 'db/2026-11-27.db.gz']);
});

test('a failed or incomplete copy sends one email a day, and is tried again', async () => {
  const t = setup({ failPut: true });
  const r = await t.offsite.runNightly();
  assert.match(r.error, /refused \(403\)/);
  await t.offsite.runNightly();
  assert.equal(t.sent.length, 1, 'one email, not one an hour');
  assert.match(t.sent[0], /R2 failed/);
  const c = setup({ corrupt: true });
  assert.match((await c.offsite.runNightly()).error, /missing or incomplete/);
  assert.equal(c.sent.length, 1);
});
