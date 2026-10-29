// Work and Family worlds: guessed from group names, moved by the person, kept per account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';
import { guessWorld, worldOf, inWorld } from '../public/worlds.js';

test('groups are guessed into Work or Family by name; unclear ones show in both', () => {
  for (const g of ['Work', 'Meetings', 'Client projects', 'Office']) assert.equal(guessWorld(g), 'work', g);
  for (const g of ['Groceries', 'Kids', 'School', 'Home', 'Health', 'Family', 'Shopping']) assert.equal(guessWorld(g), 'family', g);
  for (const g of ['Ideas', 'Inbox', 'Hobbies', 'Work from home']) assert.equal(guessWorld(g), null, g);
  assert.equal(worldOf('Ideas', { ideas: 'work' }), 'work', 'the person chose');
  assert.equal(worldOf('Kids', { kids: '' }), null, 'chosen: both');
  assert.ok(inWorld('Ideas', 'work') && inWorld('Ideas', 'family'), 'both worlds');
  assert.ok(inWorld('Kids', 'all') && !inWorld('Kids', 'work'));
});

test('the choices are kept per account', async () => {
  const s = await start();
  try {
    const put = (chosen) => s.api('groups/worlds', { method: 'PUT', body: JSON.stringify({ chosen }) });
    assert.deepEqual((await s.api('groups/worlds')).body, { chosen: {} });
    assert.equal((await put([])).status, 400);
    const r = await put({ ' Ideas ': 'work', Kids: '', Bad: 'moon' });
    assert.deepEqual(r.body.chosen, { ideas: 'work', kids: '' });
    assert.deepEqual((await s.api('groups/worlds')).body.chosen, { ideas: 'work', kids: '' });
  } finally {
    s.close();
  }
});
