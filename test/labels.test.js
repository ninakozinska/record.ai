// Labels, like Gmail's: the person defines them (Premium), several per note;
// the AI picks from the list, the person adds or removes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

const json = (method, body) => ({ method, body: JSON.stringify(body) });

test('labels: defined once, set on a note, kept through sync', async () => {
  const s = await start();
  try {
    const empty = await s.api('labels');
    assert.equal(empty.body.allowed, true, 'the owner may use labels');
    assert.deepEqual(empty.body.labels, []);
    const r = await s.api('labels', json('PUT', { labels: [{ name: ' Leo ', color: 'blue' }, { name: 'leo' }, { name: 'Bills', color: 'moon' }] }));
    assert.deepEqual(r.body.labels.map((l) => l.name), ['Leo', 'Bills'], 'trimmed, each once');
    assert.equal(r.body.labels[0].color, 'blue');
    assert.notEqual(r.body.labels[1].color, 'moon');

    const id = '11111111-1111-4111-8111-111111111111';
    await s.api('sync', json('POST', { since: 0, changes: [{ id, text: 'Pay the swim club', edited_at: 1, created_at: 1, user_labels: ['Leo', 'Bills', 'Leo'] }] }));
    const note = s.store.get(id);
    assert.deepEqual(note.labels, ['Leo', 'Bills']);
    assert.deepEqual(note.user_labels, ['Leo', 'Bills']);

    // Back to the AI's choice.
    s.store.applyAi(id, { status: 'done', labels: ['Bills'] });
    await s.api('sync', json('POST', { since: 0, changes: [{ id, edited_at: 2, user_labels: null }] }));
    assert.deepEqual(s.store.get(id).labels, ['Bills']);
  } finally {
    s.close();
  }
});

test('labels are Premium: a free account cannot define or set them', async () => {
  process.env.ALLOW_SIGNUP = 'true';
  const s = await start();
  try {
    s.store.setLabels(s.user.id, [{ name: 'Leo', color: 'blue' }]);
    // A second, free account.
    const res = await fetch(s.base + 'auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Tom', email: 'tom@example.com', password: 'correct horse' }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const tom = (p, init = {}) => fetch(s.base + p, { ...init, headers: { 'Content-Type': 'application/json', cookie } }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal((await tom('labels')).body.allowed, false);
    assert.equal((await tom('labels', json('PUT', { labels: [{ name: 'Mine' }] }))).status, 402);
    const id = '22222222-2222-4222-8222-222222222222';
    await tom('sync', json('POST', { since: 0, changes: [{ id, text: 'x', edited_at: 1, created_at: 1, user_labels: ['Mine'] }] }));
    assert.equal(s.store.get(id).user_labels, null, 'not saved for a free account');
  } finally {
    delete process.env.ALLOW_SIGNUP;
    s.close();
  }
});
