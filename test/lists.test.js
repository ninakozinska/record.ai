// Lists: a note with items (small notes that belong to it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

const put = (s, id, body) => s.api(`notes/${id}`, { method: 'PUT', body: JSON.stringify({ edited_at: Date.now(), ...body }) });

test('items belong to a list, skip the AI, and are only sent to apps that show lists', async () => {
  const s = await start();
  try {
    assert.equal((await put(s, 'list-000001', { text: 'Shopping' })).status, 200);
    let r = await put(s, 'item-000001', { text: 'milk', parent_id: 'list-000001' });
    assert.equal(r.status, 200);
    assert.equal(r.body.note.parent_id, 'list-000001');
    assert.equal(r.body.note.ai_status, 'done', 'items are not sent to the AI');
    await put(s, 'item-000002', { text: 'eggs', parent_id: 'list-000001', user_priority: 'urgent' });

    // Apps that show lists get the items; older apps don't.
    const withItems = (await s.api('notes?since=0&items=1')).body.notes.map((n) => n.id);
    assert.deepEqual(withItems.sort(), ['item-000001', 'item-000002', 'list-000001']);
    assert.deepEqual((await s.api('notes?since=0')).body.notes.map((n) => n.id), ['list-000001']);
    const sync = (await s.api('sync', { method: 'POST', body: JSON.stringify({ since: 0, changes: [], items: true }) })).body;
    assert.equal(sync.notes.length, 3);

    // Items don't count as groups and aren't reorganized.
    assert.deepEqual(s.store.active(s.user.id).map((n) => n.id), ['list-000001']);

    // An item's parent can't be changed, an item can't have items, and bad ids are refused.
    r = await put(s, 'item-000001', { text: 'oat milk', parent_id: 'list-other1' });
    assert.equal(r.body.note.parent_id, 'list-000001');
    assert.equal((await put(s, 'item-000003', { text: 'x', parent_id: 'item-000001' })).status, 403);
    assert.equal((await put(s, 'item-000004', { text: 'x', parent_id: 'not ok!' })).status, 400);

    // Ticking an item.
    r = await put(s, 'item-000001', { done: true });
    assert.equal(r.body.note.done, true);

    // Deleting the list deletes its items.
    await put(s, 'list-000001', { deleted: true });
    const after = (await s.api('notes?since=0&items=1')).body.notes;
    assert.ok(after.every((n) => n.deleted), 'list and items deleted');
  } finally {
    s.close();
  }
});

test('someone else cannot add items to my list', async () => {
  process.env.ALLOW_SIGNUP = 'true';
  const s = await start();
  try {
    await put(s, 'list-000009', { text: 'Mine' });
    // A second account (own cookie).
    let cookie = '';
    const other = async (p, init = {}) => {
      const res = await fetch(s.base + p, { ...init, headers: { 'Content-Type': 'application/json', cookie } });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      return res;
    };
    await other('auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Eve', email: 'eve@example.com', password: 'correct horse' }) });
    const r = await other('notes/item-eve0001', { method: 'PUT', body: JSON.stringify({ text: 'x', parent_id: 'list-000009', edited_at: Date.now() }) });
    assert.equal(r.status, 403);
  } finally {
    delete process.env.ALLOW_SIGNUP;
    s.close();
  }
});

test("the AI sees a list's items when it sorts the list", async () => {
  const calls = [];
  const client = { beta: { messages: { parse: async (p) => {
    calls.push(p);
    return { stop_reason: 'end_turn', parsed_output: { title: 'Groceries', summary: 's', group: 'Shopping', priority: 'normal', priority_reason: 'r', tags: [], due_date: null } };
  } } } };
  const s = await start({ client });
  try {
    await put(s, 'list-000020', { text: 'For the weekend' });
    for (let i = 0; i < 50 && s.store.get('list-000020').ai_status === 'pending'; i++) await new Promise((r) => setTimeout(r, 20));
    await put(s, 'item-000020', { text: 'strawberries', parent_id: 'list-000020' });
    await s.api('notes/list-000020/reanalyze', { method: 'POST' });
    for (let i = 0; i < 50 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.match(JSON.stringify(calls.at(-1).messages), /<list_items>\\n- \[ \] strawberries/);
  } finally {
    s.close();
  }
});
