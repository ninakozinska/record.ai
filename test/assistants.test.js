// AI assistants (Claude, ChatGPT, Gemini…) reading notes over MCP with a personal key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { start } from './helpers.js';

const mcpCall = async (t, auth, method, params, { path = '' } = {}) => {
  const res = await fetch(`${t.base.replace(/api\/$/, '')}mcp${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const text = (r) => r.body.result.content[0].text;
const put = (t, body) => t.api(`notes/${crypto.randomUUID()}`, { method: 'PUT', body: JSON.stringify({ created_at: Date.now(), edited_at: Date.now(), ...body }) });

test('a key reads the notes over MCP; it can be revoked', async () => {
  const t = await start();
  try {
    await put(t, { text: 'Dentist for Mia', user_due: new Date().toISOString().slice(0, 10) });
    await put(t, { text: 'Quarterly report for the board', user_group: 'Work' });
    const made = await t.api('assistants', { method: 'POST', body: JSON.stringify({ name: 'Claude' }) });
    assert.match(made.body.token, /^rai_/);
    assert.match(made.body.urlWithKey, /\/mcp\/rai_/);
    assert.equal(made.body.keys.length, 1);
    assert.ok(!JSON.stringify(t.store.db.prepare('SELECT * FROM assistant_keys').all()).includes(made.body.token), 'only a fingerprint is kept');

    assert.equal((await mcpCall(t, null, 'initialize', {})).status, 401);
    assert.equal((await mcpCall(t, 'rai_wrong', 'initialize', {})).status, 401);
    const init = await mcpCall(t, made.body.token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.body.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.body.result.capabilities, { tools: {} });

    const tools = (await mcpCall(t, made.body.token, 'tools/list')).body.result.tools.map((x) => x.name);
    assert.deepEqual(tools, ['search_notes', 'list_notes', 'get_note', 'list_groups', 'today'], 'a read-only key cannot add');

    assert.match(text(await mcpCall(t, made.body.token, 'tools/call', { name: 'search_notes', arguments: { query: 'quarterly board' } })), /Quarterly report for the board \(Work/);
    assert.match(text(await mcpCall(t, made.body.token, 'tools/call', { name: 'today', arguments: {} })), /Due today:\n- \[.+\] Dentist for Mia/);
    const refused = await mcpCall(t, made.body.token, 'tools/call', { name: 'add_note', arguments: { text: 'x' } });
    assert.equal(refused.body.error.code, -32602);
    assert.equal((await mcpCall(t, made.body.token, 'nope')).body.error.code, -32601);

    // The key in the address works too, for apps that only take an address.
    assert.equal((await mcpCall(t, null, 'tools/list', {}, { path: `/${made.body.token}` })).status, 200);

    await t.api(`assistants/${made.body.id}`, { method: 'DELETE' });
    assert.equal((await mcpCall(t, made.body.token, 'tools/list')).status, 401);
  } finally {
    t.close();
  }
});

test('a key that may add notes adds them; nobody else\'s notes are visible', async () => {
  const t = await start();
  try {
    const other = t.store.createUser({ email: 'anna@example.com', name: 'Anna', pwHash: 'x' });
    t.store.upsertFromClient(other.id, { id: crypto.randomUUID(), text: 'Anna secret plan', created_at: Date.now(), edited_at: Date.now() });
    const { body } = await t.api('assistants', { method: 'POST', body: JSON.stringify({ name: 'Gemini', write: true }) });
    assert.ok((await mcpCall(t, body.token, 'tools/list')).body.result.tools.some((x) => x.name === 'add_note'));
    const added = await mcpCall(t, body.token, 'tools/call', { name: 'add_note', arguments: { text: 'Book the swimming lesson', due: '2030-01-02T17:00' } });
    const id = text(added).match(/\[([0-9a-f-]{36})\]/)[1];
    const note = t.store.get(id);
    assert.equal(note.user_id, t.user.id);
    assert.equal(note.due_time, '17:00');
    assert.match(text(await mcpCall(t, body.token, 'tools/call', { name: 'get_note', arguments: { id } })), /Book the swimming lesson/);
    assert.equal(text(await mcpCall(t, body.token, 'tools/call', { name: 'search_notes', arguments: { query: 'secret plan' } })), 'No notes match.');
    const bad = await mcpCall(t, body.token, 'tools/call', { name: 'add_note', arguments: { text: 'x', due: 'tomorrow' } });
    assert.equal(bad.body.result.isError, true);
    t.store.deleteUser(t.user.id);
    assert.equal((await mcpCall(t, body.token, 'tools/list')).status, 401, 'gone with the account');
  } finally {
    t.close();
  }
});
