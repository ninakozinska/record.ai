// Alpha testers: one invite link each, used once, with the plan chosen for them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

const json = (method, body) => ({ method, body: JSON.stringify(body) });
function person(s) {
  let cookie = '';
  return async (p, init = {}) => {
    const res = await fetch(s.base + p, { ...init, headers: { 'Content-Type': 'application/json', cookie } });
    cookie = res.headers.get('set-cookie')?.split(';')[0] || cookie;
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const signup = (api, name, email, code) => api('auth/signup', json('POST', { name, email, password: 'correct horse', code }));

test('invite links: invite only, once each, with the Family plan; the owner sees who joined', async () => {
  const s = await start();
  try {
    const visitor = person(s);
    assert.equal((await visitor('auth/state')).body.signup.open, false, 'closed before any invite');

    const made = await s.api('admin/invites', json('POST', { labels: ['Anna', 'Marco', 'Zofia'], plan: 'family' }));
    assert.equal(made.body.invites.length, 3);
    const [anna, marco, zofia] = made.body.invites;
    assert.match(anna.link, /\/#invite=[A-Za-z0-9_-]{12}$/);
    assert.deepEqual((await visitor('auth/state')).body.signup, { open: true, needsCode: true, firstAccount: false });

    assert.equal((await signup(visitor, 'Anna', 'anna@example.com', 'wrong')).status, 403);
    assert.equal((await signup(visitor, 'Anna', 'anna@example.com', anna.code)).status, 200);
    const annaId = s.store.findUserByEmail('anna@example.com').id;
    assert.equal(s.store.planOf(annaId), 'family', 'alpha testers get the plan chosen for them');

    const other = person(s);
    assert.equal((await signup(other, 'Someone', 'someone@example.com', anna.code)).status, 403, 'a link works once');
    assert.equal((await signup(other, 'Marco', 'marco@example.com', marco.code)).status, 200);

    await s.api(`admin/invites/${zofia.code}`, { method: 'DELETE' });
    assert.equal((await signup(person(s), 'Zofia', 'zofia@example.com', zofia.code)).status, 403, 'withdrawn');

    const list = (await s.api('admin/invites')).body.invites;
    assert.deepEqual(list.map((i) => [i.label, i.user?.name ?? null, i.revoked]), [['Anna', 'Anna', false], ['Marco', 'Marco', false], ['Zofia', null, true]]);
    assert.equal((await visitor('admin/invites')).status, 404, 'only the owner');
  } finally {
    s.close();
  }
});
