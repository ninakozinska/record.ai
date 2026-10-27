// Sharing a note (with its list items) or a whole group with other people.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

const json = (method, body) => ({ method, body: JSON.stringify(body) });
const put = (api, id, body) => api(`notes/${id}`, json('PUT', { edited_at: Date.now(), ...body }));

/** A second account with its own cookie, like the person's own phone. */
function person(s) {
  let cookie = '';
  const api = async (p, init = {}) => {
    const res = await fetch(s.base + p, { ...init, headers: { 'Content-Type': 'application/json', cookie, ...init.headers } });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null), res };
  };
  const signup = (name, email) => api('auth/signup', json('POST', { name, email, password: 'correct horse' }));
  return { api, signup, cookie: () => cookie };
}

async function setup() {
  process.env.ALLOW_SIGNUP = 'true';
  const s = await start();
  await put(s.api, 'list-groceries', { text: 'Groceries' });
  await put(s.api, 'item-milk0001', { text: 'milk', parent_id: 'list-groceries' });
  await put(s.api, 'item-bread001', { text: 'bread', parent_id: 'list-groceries' });
  await put(s.api, 'note-private1', { text: 'My private note' });
  return s;
}
const done = (s) => {
  delete process.env.ALLOW_SIGNUP;
  s.close();
};
const ids = (notes) => notes.map((n) => n.id).sort();

test('share a list with someone who signs up later; they see it with its items and can tick and add', async () => {
  const s = await setup();
  try {
    let r = await s.api('shares', json('POST', { kind: 'note', target: 'list-groceries', email: 'Tom@Example.com' }));
    assert.equal(r.status, 200);
    assert.equal(r.body.hasAccount, false, 'no account yet: waits for Tom');
    assert.equal(r.body.share.role, 'edit', 'can edit by default');

    const tom = person(s);
    await tom.signup('Tom', 'tom@example.com');
    let notes = (await tom.api('notes?since=0&items=1&shared=1')).body.notes;
    assert.deepEqual(ids(notes), ['item-bread001', 'item-milk0001', 'list-groceries'], 'the list and its items, not the private note');
    const list = notes.find((n) => n.id === 'list-groceries');
    assert.equal(list.role, 'edit');
    assert.equal(list.owner_name, 'Nina');
    // Apps that don't show sharing yet get nothing of it.
    assert.deepEqual((await tom.api('notes?since=0&items=1')).body.notes, []);
    assert.deepEqual((await s.api('shares')).body.mine.map((x) => [x.email, x.name]), [['tom@example.com', 'Tom']]);
    assert.equal((await tom.api('shares')).body.withMe[0].owner.name, 'Nina');

    // Tom ticks milk and adds eggs; both land in Nina's list.
    assert.equal((await put(tom.api, 'item-milk0001', { done: true })).status, 200);
    r = await put(tom.api, 'item-eggs0001', { text: 'eggs', parent_id: 'list-groceries' });
    assert.equal(r.status, 200);
    assert.equal(r.body.note.user_id, s.user.id, "a new item belongs to the list's owner");
    notes = (await s.api('notes?since=0&items=1')).body.notes;
    assert.equal(notes.find((n) => n.id === 'item-milk0001').done, true);
    assert.ok(notes.some((n) => n.id === 'item-eggs0001'));

    // Tom can't regroup or delete Nina's list, or touch her other notes.
    await put(tom.api, 'list-groceries', { user_group: 'Tom stuff', user_priority: 'low', deleted: true, text: 'Groceries for the weekend' });
    const after = s.store.get('list-groceries');
    assert.equal(after.text, 'Groceries for the weekend', 'editors change the text');
    assert.equal(after.user_group, null);
    assert.equal(after.user_priority, null);
    assert.equal(after.deleted, false, 'only the owner deletes the list');
    assert.equal((await put(tom.api, 'note-private1', { text: 'hacked' })).status, 403);
    assert.equal((await tom.api('notes/list-groceries/reanalyze', { method: 'POST' })).status, 404);
  } finally {
    done(s);
  }
});

test('view only, then stop sharing: edits are refused, then the list disappears from their devices', async () => {
  const s = await setup();
  try {
    const tom = person(s);
    await tom.signup('Tom', 'tom@example.com');
    const { share } = (await s.api('shares', json('POST', { kind: 'note', target: 'list-groceries', email: 'tom@example.com', role: 'view' }))).body;
    let sync = (await tom.api('sync', json('POST', { since: 0, items: true, shared: true, changes: [] }))).body;
    assert.equal(sync.notes.length, 3);
    assert.ok(sync.notes.every((n) => n.role === 'view'));
    sync = (await tom.api('sync', json('POST', {
      since: sync.rev, items: true, shared: true,
      changes: [{ id: 'item-milk0001', done: true, edited_at: Date.now() }],
    }))).body;
    assert.equal(sync.results[0].status, 'forbidden');
    assert.equal(s.store.get('item-milk0001').done, false);

    // Switching to "can edit" reaches Tom's next sync.
    let since = sync.rev;
    await s.api(`shares/${share.id}`, json('PATCH', { role: 'edit' }));
    let changed = (await tom.api(`notes?since=${since}&items=1&shared=1`)).body;
    assert.ok(changed.notes.length === 3 && changed.notes.every((n) => n.role === 'edit'));

    // Nina stops sharing: Tom's devices are told to remove it, without its contents.
    since = changed.rev;
    assert.equal((await s.api(`shares/${share.id}`, { method: 'DELETE' })).status, 200);
    changed = (await tom.api(`notes?since=${since}&items=1&shared=1`)).body;
    assert.deepEqual(ids(changed.notes), ['item-bread001', 'item-milk0001', 'list-groceries']);
    for (const n of changed.notes) {
      assert.equal(n.revoked, true);
      assert.equal(n.deleted, true);
      assert.equal(n.text, undefined, 'no contents in a removal notice');
    }
    assert.equal((await put(tom.api, 'item-milk0001', { done: true })).status, 403);
    // Nina's own copy is untouched, and her devices just see a new revision.
    assert.equal(s.store.get('list-groceries').deleted, false);
  } finally {
    done(s);
  }
});

test('share a whole group: notes moving in and out of it follow', async () => {
  const s = await setup();
  try {
    const grandma = person(s);
    await grandma.signup('Grandma', 'grandma@example.com');
    await put(s.api, 'note-swimming', { text: 'Swimming lessons on Tuesday', user_group: 'Kids' });
    await s.api('shares', json('POST', { kind: 'group', target: 'kids', email: 'grandma@example.com' }));
    let r = (await grandma.api('notes?since=0&items=1&shared=1')).body;
    assert.deepEqual(ids(r.notes), ['note-swimming'], 'group names match whatever the case');

    // The groceries list moves into Kids: it comes with its items.
    let since = r.rev;
    await put(s.api, 'list-groceries', { user_group: 'Kids' });
    r = (await grandma.api(`notes?since=${since}&items=1&shared=1`)).body;
    assert.deepEqual(ids(r.notes), ['item-bread001', 'item-milk0001', 'list-groceries']);

    // ...and moves out again: removed, items included.
    since = r.rev;
    await put(s.api, 'list-groceries', { user_group: 'Home' });
    r = (await grandma.api(`notes?since=${since}&items=1&shared=1`)).body;
    assert.deepEqual(ids(r.notes), ['item-bread001', 'item-milk0001', 'list-groceries']);
    assert.ok(r.notes.every((n) => n.revoked));

    // Grandma leaves the group.
    const [share] = (await grandma.api('shares')).body.withMe;
    since = r.rev;
    assert.equal((await grandma.api(`shares/${share.id}`, { method: 'DELETE' })).status, 200);
    r = (await grandma.api(`notes?since=${since}&items=1&shared=1`)).body;
    assert.deepEqual(r.notes.map((n) => [n.id, n.revoked]), [['note-swimming', true]]);
    assert.deepEqual((await s.api('shares')).body.mine, []);
  } finally {
    done(s);
  }
});

test('shared changes arrive live, and photos of shared notes can be opened', async () => {
  const s = await setup();
  try {
    const tom = person(s);
    await tom.signup('Tom', 'tom@example.com');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await s.api('images/photo-0001.png', { method: 'PUT', body: png, headers: { 'Content-Type': 'image/png' } });
    await put(s.api, 'list-groceries', { images: ['photo-0001.png'] });
    assert.equal((await tom.api('images/photo-0001.png')).status, 404, 'not shared yet');

    // Tom's app listens for live updates.
    const ac = new AbortController();
    const res = await fetch(s.base + 'events?items=1&shared=1', { headers: { cookie: tom.cookie() }, signal: ac.signal });
    const reader = res.body.getReader();
    let text = '';
    const waitFor = async (re) => {
      while (!re.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    };
    await waitFor(/event: hello/);
    await s.api('shares', json('POST', { kind: 'note', target: 'list-groceries', email: 'tom@example.com' }));
    await waitFor(/event: shares/);
    await waitFor(/"id":"list-groceries"[^\n]*"role":"edit"/);
    await put(s.api, 'item-milk0001', { done: true });
    await waitFor(/"id":"item-milk0001","text":"milk","images":\[\],"done":true/);
    ac.abort();

    assert.equal((await tom.api('images/photo-0001.png')).status, 200, 'shared: the photo opens');
  } finally {
    done(s);
  }
});

test('sharing checks what is shared and with whom', async () => {
  const s = await setup();
  try {
    const share = (body) => s.api('shares', json('POST', { kind: 'note', target: 'list-groceries', email: 'tom@example.com', ...body }));
    assert.equal((await share({ email: 'nina@example.com' })).status, 400, 'not with yourself');
    assert.equal((await share({ email: 'not an email' })).status, 400);
    assert.equal((await share({ role: 'owner' })).status, 400);
    assert.equal((await share({ kind: 'folder' })).status, 400);
    assert.equal((await share({ target: 'item-milk0001' })).status, 400, 'an item alone is not shared');
    assert.equal((await share({ target: 'nope-000000' })).status, 404);
    // Sharing again changes the role instead of adding a second share.
    await share({});
    await share({ role: 'view' });
    assert.deepEqual((await s.api('shares')).body.mine.map((x) => x.role), ['view']);

    // Only the owner changes a share; someone else can't even see it.
    const eve = person(s);
    await eve.signup('Eve', 'eve@example.com');
    const [mine] = (await s.api('shares')).body.mine;
    assert.equal((await eve.api(`shares/${mine.id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await eve.api(`shares/${mine.id}`, json('PATCH', { role: 'edit' }))).status, 404);
    assert.deepEqual((await eve.api('notes?since=0&items=1&shared=1')).body.notes, []);
  } finally {
    done(s);
  }
});
