// A note's history: when it was made, changed and ticked off, and by whom.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { start } from './helpers.js';

const T0 = Date.UTC(2026, 10, 10, 8, 0);
const min = 60e3;

test('created, edited (typing merges), date, group, done, reopened, deleted: newest first', async () => {
  const t = await start();
  try {
    const me = t.user.id;
    const id = crypto.randomUUID();
    const put = (body, at) => t.store.upsertFromClient(me, { id, edited_at: at, ...body });
    put({ text: 'Dentist', created_at: T0 }, T0);
    put({ text: 'Dentist for Leo' }, T0 + 1 * min);
    put({ text: 'Dentist for Leo, bring the card' }, T0 + 3 * min); // within 10 minutes: one "edited" line
    put({ user_due: '2026-11-12T09:00' }, T0 + 4 * min);
    put({ user_group: 'Kids' }, T0 + 5 * min);
    put({ text: 'Dentist for Leo, bring the card!' }, T0 + 30 * min); // later: a second "edited" line
    put({ done: true }, T0 + 60 * min);
    put({ done: false }, T0 + 61 * min);
    put({ deleted: true }, T0 + 62 * min);

    const h = t.store.history(id);
    assert.deepEqual(h.map((e) => e.kind), ['deleted', 'reopened', 'done', 'edited', 'group', 'date', 'edited', 'created']);
    assert.equal(h.at(-1).at, T0);
    assert.equal(h.at(-2).at, T0 + 3 * min, 'typing within 10 minutes is one line, at the last change');
    assert.deepEqual(h.find((e) => e.kind === 'date').detail, { date: '2026-11-12', time: '09:00' });
    assert.deepEqual(h.find((e) => e.kind === 'group').detail, { group: 'Kids' });
    assert.deepEqual(h[0].by, { id: me, name: 'Nina' });
  } finally {
    t.close();
  }
});

test('list items are told on their list: added, ticked, removed', async () => {
  const t = await start();
  try {
    const me = t.user.id;
    const list = crypto.randomUUID();
    t.store.upsertFromClient(me, { id: list, text: 'School bag', created_at: T0, edited_at: T0 });
    const item = crypto.randomUUID();
    t.store.upsertFromClient(me, { id: item, parent_id: list, text: 'Swim kit', created_at: T0 + min, edited_at: T0 + min });
    t.store.upsertFromClient(me, { id: item, done: true, edited_at: T0 + 2 * min });
    t.store.upsertFromClient(me, { id: item, deleted: true, edited_at: T0 + 3 * min });
    const h = t.store.history(list);
    assert.deepEqual(h.map((e) => [e.kind, e.detail?.text]), [['item_removed', 'Swim kit'], ['item_done', 'Swim kit'], ['item_added', 'Swim kit'], ['created', undefined]]);
    assert.deepEqual(t.store.history(item), [], 'items have no history of their own');
  } finally {
    t.close();
  }
});

test('the AI sorting is a line too, by nobody in particular', async () => {
  const t = await start();
  try {
    const id = crypto.randomUUID();
    t.store.upsertFromClient(t.user.id, { id, text: 'Pay the plumber', created_at: T0, edited_at: T0 });
    t.store.applyAi(id, { status: 'done', title: 'Pay the plumber', group: 'Home', priority: 'high', due_date: null, due_time: null });
    const [sorted] = t.store.history(id);
    assert.equal(sorted.kind, 'sorted');
    assert.equal(sorted.by, null);
    assert.deepEqual(sorted.detail, { group: 'Home', priority: 'high', date: null, time: null });
  } finally {
    t.close();
  }
});

test('GET /api/notes/:id/history, and nothing left once the account is deleted', async () => {
  const t = await start();
  try {
    const id = crypto.randomUUID();
    const now = Date.now();
    assert.equal((await t.api(`notes/${id}`, { method: 'PUT', body: JSON.stringify({ text: 'Buy milk', created_at: now, edited_at: now }) })).status, 200);
    const r = await t.api(`notes/${id}/history`);
    assert.equal(r.status, 200);
    assert.equal(r.body.created_at, now);
    assert.equal(r.body.events.at(-1).kind, 'created');
    assert.equal((await t.api(`notes/${crypto.randomUUID()}/history`)).status, 404);
    t.store.deleteUser(t.user.id);
    assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM note_history').get().n, 0);
  } finally {
    t.close();
  }
});
