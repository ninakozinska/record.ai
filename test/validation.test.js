// Bad input is refused; status endpoints; sessions expire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

const put = (s, id, body) => s.api(`notes/${id}`, { method: 'PUT', body: JSON.stringify(body) });

test('the API refuses malformed notes and image names', async () => {
  const s = await start();
  try {
    assert.equal((await put(s, 'bad id!', { text: 'x', edited_at: 1 })).status, 400);
    assert.equal((await put(s, 'short', { text: 'x', edited_at: 1 })).status, 400);
    assert.equal((await put(s, 'note-val-0001', { text: 'x' })).status, 400, 'edited_at is required');
    assert.equal((await put(s, 'note-val-0001', { text: 'x', edited_at: 1, user_priority: 'whenever' })).status, 400);
    assert.equal((await put(s, 'note-val-0001', { text: 'x', edited_at: 1, images: ['../../etc/passwd'] })).status, 400);
    assert.equal((await put(s, 'note-val-0001', { text: 'x', edited_at: 1, images: 'nope' })).status, 400);
    const long = await put(s, 'note-val-0001', { text: 42, edited_at: 1, user_group: `  ${'g'.repeat(100)}  ` });
    assert.equal(long.status, 200);
    assert.equal(long.body.note.text, '42', 'text is stored as text');
    assert.equal(long.body.note.user_group.length, 60, 'group names are trimmed and capped');
    assert.equal((await s.api('images/not-an-image.exe', { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from([1]) })).status, 400);
    assert.equal((await s.api('images/aaaaaaaa-empty.jpg', { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.alloc(0) })).status, 400);
    assert.equal((await s.api('images/..%2F..%2Fnotes.db')).status, 400);
    assert.equal((await s.api('notes/note-val-9999/reanalyze', { method: 'POST' })).status, 404);
  } finally {
    s.close();
  }
});

test('status, server info and reorganize without AI', async () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const s = await start();
  try {
    await put(s, 'note-val-0002', { text: 'x', edited_at: 1, user_group: 'Home' });
    const status = (await s.api('status')).body;
    assert.equal(status.ai.enabled, false);
    assert.deepEqual(status.groups, [{ name: 'Home', count: 1 }]);
    const info = (await s.api('server-info')).body;
    assert.equal(typeof info.port, 'number');
    assert.ok(Array.isArray(info.addresses));
    for (const a of info.addresses) assert.match(a, /^http:\/\/[\d.]+:\d+$/);
    const r = await s.api('reorganize', { method: 'POST' });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /not configured/);
  } finally {
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
    s.close();
  }
});

test('sessions expire after 400 days without use, and record their last use', async () => {
  const s = await start();
  try {
    const token = s.store.createSession(s.user.id, 'test');
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 2 * 3600e3; // two hours later: still valid, last use updated
      assert.ok(s.store.sessionUser(token));
      const row = s.store.db.prepare('SELECT last_used_at FROM sessions ORDER BY last_used_at DESC').get();
      assert.ok(row.last_used_at > realNow() + 3600e3);
      Date.now = () => realNow() + 500 * 24 * 3600e3;
      assert.equal(s.store.sessionUser(token), null);
      assert.equal(s.store.sessionUser(token), null, 'and it is gone');
    } finally {
      Date.now = realNow;
    }
  } finally {
    s.close();
  }
});
