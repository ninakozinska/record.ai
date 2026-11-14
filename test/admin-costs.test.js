// The owner's dashboard: AI calls one by one, and the month's AI total.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

test('the dashboard lists the last AI calls with their cost, and the month total and average', async () => {
  const t = await start();
  try {
    const add = t.store.db.prepare('INSERT INTO ai_calls (ts, user_id, kind, model, input_tokens, output_tokens, cache_read, cost_usd, ms, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const now = Date.now();
    add.run(now - 60e3, t.user.id, 'note', 'claude-haiku', 900, 120, 2000, 0.0012, 1400, 'used');
    add.run(now, t.user.id, 'tasks', 'claude-haiku', 1500, 300, 0, 0.0028, 2600, 'used');
    const r = await t.api('admin/overview');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.aiCalls.map((a) => a.kind), ['tasks', 'note'], 'newest first');
    assert.equal(r.body.aiCalls[0].cost_usd, 0.0028);
    assert.ok(!('user_id' in r.body.aiCalls[0]), 'never whose note it was');
    assert.equal(r.body.costs.aiCalls, 2);
    assert.equal(r.body.costs.aiUsd, 0.004);
    assert.equal(r.body.costs.aiPerCallUsd, 0.002);
  } finally {
    t.close();
  }
});

test('the owner can send one harmless test error; it says when Sentry is not set up', async () => {
  const t = await start();
  try {
    const r = await t.api('admin/test-error', { method: 'POST' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { configured: false, invalid: false, sent: false });
  } finally {
    t.close();
  }
});
