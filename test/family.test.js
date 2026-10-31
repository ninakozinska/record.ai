// Family hub: give a task to someone you share with, and see who did what.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

const json = (method, body) => ({ method, body: JSON.stringify(body) });
const put = (api, id, body) => api(`notes/${id}`, json('PUT', { edited_at: Date.now() + Math.random(), ...body }));
function person(s) {
  let cookie = '';
  const api = async (p, init = {}) => {
    const res = await fetch(s.base + p, { ...init, headers: { 'Content-Type': 'application/json', cookie, ...init.headers } });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { api, signup: (name, email) => api('auth/signup', json('POST', { name, email, password: 'correct horse' })) };
}

test('tasks for someone in the family, a notification for them, and who ticked what', async () => {
  process.env.ALLOW_SIGNUP = 'true';
  const pushed = [];
  const s = await start({ reminders: { send: async (sub, payload) => pushed.push({ sub, payload }) } });
  try {
    const tom = person(s);
    const tomId = (await tom.signup('Tom', 'tom@example.com')).body.user.id;
    await tom.api('push/subscribe', json('POST', { subscription: { endpoint: 'https://push.example/tom', keys: { p256dh: 'p', auth: 'a' } } }));
    await put(s.api, 'list-groceries', { text: 'Groceries' });
    await put(s.api, 'item-milk0001', { text: 'milk', parent_id: 'list-groceries' });

    // Not shared yet: Tom is not someone tasks can be for.
    assert.deepEqual((await s.api('people')).body.people.map((p) => p.name), ['Nina']);
    assert.equal((await put(s.api, 'item-milk0001', { assigned_to: tomId })).status, 400);

    await s.api('shares', json('POST', { kind: 'note', target: 'list-groceries', email: 'tom@example.com' }));
    const people = (await s.api('people')).body;
    assert.deepEqual(people.people.map((p) => [p.name, p.me]), [['Nina', true], ['Tom', false]]);
    assert.deepEqual((await tom.api('people')).body.people.map((p) => p.name), ['Tom', 'Nina'], 'Tom sees Nina too');

    // The owner of the server has everything, so Nina can give tasks.
    assert.equal((await put(s.api, 'item-milk0001', { assigned_to: tomId })).status, 200);
    assert.equal(s.store.get('item-milk0001').assigned_to, tomId);
    assert.equal(pushed.length, 1);
    assert.deepEqual([pushed[0].sub.endpoint, pushed[0].payload.title, pushed[0].payload.body, pushed[0].payload.url],
      ['https://push.example/tom', '👤 Nina', 'milk', './?open=list-groceries']);

    // Tom ticks it: it says who.
    assert.equal((await put(tom.api, 'item-milk0001', { done: true })).status, 200);
    assert.equal(s.store.get('item-milk0001').done_by, tomId);
    await put(s.api, 'item-milk0001', { text: 'milk (2 litres)' });
    assert.equal(s.store.get('item-milk0001').done_by, tomId, 'an edit keeps who did it');
    await put(s.api, 'item-milk0001', { done: false });
    assert.equal(s.store.get('item-milk0001').done_by, null);

    // Tom is on the free plan: he can take tasks himself, not give them.
    await put(tom.api, 'tom-own-note', { text: 'Fix the bike' });
    const ninaId = s.user.id;
    const r = await put(tom.api, 'tom-own-note', { assigned_to: ninaId });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /Family plan/);
    assert.equal((await put(tom.api, 'tom-own-note', { assigned_to: tomId })).status, 200, 'for himself is fine');
    s.store.setPlan(tomId, 'family');
    assert.equal((await put(tom.api, 'tom-own-note', { assigned_to: ninaId })).status, 200);
  } finally {
    delete process.env.ALLOW_SIGNUP;
    s.close();
  }
});
