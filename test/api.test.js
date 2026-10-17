import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

/** Fake Claude client: returns canned structured output and records requests. */
function fakeClient(analysis) {
  const calls = [];
  const respond = (params) => {
    calls.push(params);
    return { stop_reason: 'end_turn', parsed_output: typeof analysis === 'function' ? analysis(params) : analysis };
  };
  return {
    calls,
    beta: {
      messages: {
        parse: async (p) => respond(p),
        stream: (p) => ({ finalMessage: async () => respond(p) }),
      },
    },
  };
}

const waitFor = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timeout');
};

test('notes sync incrementally by revision and resolve conflicts by edit time', async () => {
  const s = await start();
  try {
    const put = (id, body) => s.api(`notes/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    const r1 = await put('note-aaaa-1', { text: 'buy milk', edited_at: 1000, created_at: 1000 });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.note.text, 'buy milk');

    const { body: first } = await s.api('notes?since=0');
    assert.equal(first.notes.length, 1);

    await put('note-aaaa-1', { text: 'buy oat milk', edited_at: 2000 });
    // An older offline edit arriving late must not win.
    const stale = await put('note-aaaa-1', { text: 'old text', edited_at: 1500 });
    assert.equal(stale.body.stale, true);
    assert.equal(stale.body.note.text, 'buy oat milk');

    const { body: delta } = await s.api(`notes?since=${first.rev}`);
    assert.ok(delta.notes.every((n) => n.rev > first.rev));
    assert.equal(delta.notes.at(-1).text, 'buy oat milk');

    await put('note-aaaa-1', { deleted: true, edited_at: 3000 });
    const { body: after } = await s.api(`notes?since=${delta.rev}`);
    assert.equal(after.notes[0].deleted, true);
  } finally {
    s.close();
  }
});

test('without an API key notes still get a basic title and Inbox group', async () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const s = await start();
  try {
    await s.api('notes/note-bbbb-1', { method: 'PUT', body: JSON.stringify({ text: 'Call dentist ASAP\nabout the crown', edited_at: 1 }) });
    const note = await waitFor(() => {
      const n = s.store.get('note-bbbb-1');
      return n.ai_status !== 'pending' && n;
    });
    assert.equal(note.ai_status, 'off');
    assert.equal(note.title, 'Call dentist ASAP');
    assert.equal(note.group, 'Inbox');
    assert.equal(note.priority, 'high');
  } finally {
    s.close();
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
  }
});

test('AI organizes notes, sends photos, and user overrides win', async () => {
  const client = fakeClient({
    title: 'Pay electricity bill',
    summary: 'Electricity bill due Friday.',
    group: 'Home',
    priority: 'urgent',
    priority_reason: 'due in 2 days',
    tags: ['bills'],
    due_date: '2026-10-10',
  });
  const s = await start({ client });
  try {
    const img = 'aaaaaaaa-bbbb-cccc.jpg';
    const up = await s.api(`images/${img}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    assert.equal(up.status, 200);
    await s.api('notes/note-cccc-1', { method: 'PUT', body: JSON.stringify({ text: 'electricity bill', images: [img], edited_at: 1 }) });
    const note = await waitFor(() => {
      const n = s.store.get('note-cccc-1');
      return n.ai_status === 'done' && n;
    });
    assert.equal(note.title, 'Pay electricity bill');
    assert.equal(note.group, 'Home');
    assert.equal(note.priority, 'urgent');
    assert.equal(note.due_date, '2026-10-10');

    const req = client.calls[0];
    assert.equal(req.model, 'claude-opus-5-5');
    assert.equal(req.messages[0].content[0].type, 'image');
    assert.match(req.messages[0].content.at(-1).text, /electricity bill/);

    // User pins a group and priority; AI fields are kept but user's win.
    const r = await s.api('notes/note-cccc-1', { method: 'PUT', body: JSON.stringify({ user_group: 'Finance', user_priority: 'low', edited_at: 2 }) });
    assert.equal(r.body.note.group, 'Finance');
    assert.equal(r.body.note.priority, 'low');
    assert.equal(r.body.note.ai_group, 'Home');
    assert.equal(client.calls.length, 1, 'changing only overrides does not re-run the AI');
  } finally {
    s.close();
  }
});

test('reorganize re-groups all open notes', async () => {
  let n = 0;
  const client = fakeClient((params) => {
    if (params.max_tokens > 10000) {
      const ids = [...params.messages[0].content.at(-1).text.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
      return { notes: ids.map((id) => ({ id, group: 'Everything', priority: 'high', priority_reason: 'test' })) };
    }
    n++;
    return { title: `t${n}`, summary: 's', group: `G${n}`, priority: 'normal', priority_reason: 'r', tags: [], due_date: null };
  });
  const s = await start({ client });
  try {
    for (const id of ['note-dddd-1', 'note-dddd-2']) {
      await s.api(`notes/${id}`, { method: 'PUT', body: JSON.stringify({ text: id, edited_at: 1 }) });
    }
    await waitFor(() => s.store.pendingIds().length === 0);
    const r = await s.api('reorganize', { method: 'POST' });
    assert.equal(r.body.updated, 2);
    assert.deepEqual(s.store.groups(s.user.id), [{ name: 'Everything', count: 2 }]);
  } finally {
    s.close();
  }
});

test('changing priority while the AI is working does not lose the AI result', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const client = fakeClient(() => ({ title: 'T', summary: 's', group: 'G', priority: 'low', priority_reason: 'r', tags: [], due_date: null }));
  const parse = client.beta.messages.parse;
  client.beta.messages.parse = async (p) => (await gate, parse(p));
  const s = await start({ client });
  try {
    await s.api('notes/note-eeee-1', { method: 'PUT', body: JSON.stringify({ text: 'x', edited_at: 1 }) });
    await waitFor(() => client.calls.length === 0 && s.organizer.running);
    await s.api('notes/note-eeee-1', { method: 'PUT', body: JSON.stringify({ user_priority: 'high', edited_at: 2 }) });
    release();
    const n = await waitFor(() => s.store.get('note-eeee-1').ai_status === 'done' && s.store.get('note-eeee-1'));
    assert.equal(n.title, 'T');
    assert.equal(n.priority, 'high');
  } finally {
    s.close();
  }
});
