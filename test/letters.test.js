// "School letter → tasks": the tasks in a note become notes with their dates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { start } from './helpers.js';

function fakeClient() {
  const calls = [];
  const respond = (p) => {
    calls.push(p);
    const parsed = /list what the person has to do/.test(p.system)
      ? { tasks: [
          { title: 'Sign the trip form', due_date: '2030-03-06', due_time: null, details: 'Give it to the teacher' },
          { title: 'Museum trip', due_date: '2030-03-12', due_time: '08:30', details: 'Bring a packed lunch and €12' },
          { title: 'Bad date', due_date: 'next week', due_time: '25:99', details: null },
        ] }
      : { title: 'School letter', summary: 's', group: 'Kids', priority: 'high', priority_reason: 'r', tags: [], due_date: null, due_time: null };
    return { stop_reason: 'end_turn', parsed_output: parsed };
  };
  return { calls, beta: { messages: { parse: async (p) => respond(p), stream: (p) => ({ finalMessage: async () => respond(p) }) } } };
}
const waitFor = async (fn, ms = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (await fn()) return;
  throw new Error('timeout');
};

test('a letter becomes tasks with their dates, in its group', async () => {
  const client = fakeClient();
  const t = await start({ client });
  try {
    const id = crypto.randomUUID();
    await t.api(`notes/${id}`, { method: 'PUT', body: JSON.stringify({ text: 'Dear parents, the class visits the museum on 12 March…', created_at: Date.now(), edited_at: Date.now() }) });
    await waitFor(() => t.store.get(id).ai_status === 'done');
    const r = await t.api(`notes/${id}/tasks`, { method: 'POST' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ids.length, 3);
    const [form, trip, bad] = r.body.ids.map((x) => t.store.get(x));
    assert.deepEqual([form.title, form.due_date, form.due_time, form.group, form.ai_status], ['Sign the trip form', '2030-03-06', null, 'Kids', 'done']);
    assert.equal(form.text, 'Sign the trip form\nGive it to the teacher');
    assert.deepEqual([trip.due_date, trip.due_time], ['2030-03-12', '08:30']);
    assert.deepEqual([bad.due_date, bad.due_time], [null, null], 'nonsense dates are dropped');
    assert.match(client.calls.at(-1).messages[0].content.at(-1).text, /Today is \d{4}-\d{2}-\d{2}/);

    // The owner has everything: a second letter works too. Someone else's (or no) note: not found.
    assert.equal((await t.api(`notes/${id}/tasks`, { method: 'POST' })).status, 200);
    assert.equal((await t.api(`notes/${crypto.randomUUID()}/tasks`, { method: 'POST' })).status, 404);
  } finally {
    t.close();
  }
});

test('on the free plan, once a month', async () => {
  process.env.ALLOW_SIGNUP = 'true';
  const t = await start({ client: fakeClient() });
  try {
    let cookie = '';
    const api = async (p, init = {}) => {
      const res = await fetch(t.base + p, { ...init, headers: { 'Content-Type': 'application/json', cookie } });
      cookie = res.headers.get('set-cookie')?.split(';')[0] || cookie;
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    await api('auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Tom', email: 'tom@example.com', password: 'correct horse' }) });
    const id = crypto.randomUUID();
    await api(`notes/${id}`, { method: 'PUT', body: JSON.stringify({ text: 'Swimming gala on Saturday', created_at: Date.now(), edited_at: Date.now() }) });
    await waitFor(() => t.store.get(id).ai_status === 'done');
    assert.equal((await api(`notes/${id}/tasks`, { method: 'POST' })).status, 200);
    const again = await api(`notes/${id}/tasks`, { method: 'POST' });
    assert.equal(again.status, 402);
    assert.match(again.body.error, /once a month/);
  } finally {
    delete process.env.ALLOW_SIGNUP;
    t.close();
  }
});
