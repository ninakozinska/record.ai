// Suggested to-dos: from meetings and notes once a day, from AI chats on
// request. They wait for review; nothing becomes a note on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { start } from './helpers.js';
import { chatText } from '../server/suggestions.js';

function fakeClient(make) {
  const calls = [];
  const respond = (p) => {
    calls.push(p);
    const parsed = /propose the few things they should DO/.test(p.system)
      ? { suggestions: make(p) }
      : { title: p.messages[0].content.at(-1).text.match(/<note[^>]*>\n?([^\n]*)/)?.[1]?.slice(0, 40) || 'Note', summary: 's', group: 'Work', priority: 'normal', priority_reason: 'r', tags: [], due_date: null, due_time: null };
    return { stop_reason: 'end_turn', parsed_output: parsed };
  };
  return { calls, beta: { messages: { parse: async (p) => respond(p), stream: (p) => ({ finalMessage: async () => respond(p) }) } } };
}
const waitFor = async (fn, ms = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (await fn()) return;
  throw new Error('timeout');
};
const day = (n = 0) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const put = async (t, body) => {
  const id = crypto.randomUUID();
  await t.api(`notes/${id}`, { method: 'PUT', body: JSON.stringify({ created_at: Date.now(), edited_at: Date.now(), ...body }) });
  return id;
};
const meeting = async (t, text, due) => {
  const id = await put(t, { text, user_due: due });
  t.store.db.prepare("UPDATE notes SET source = 'google' WHERE id = ?").run(id);
  return id;
};
const SUGGESTED = (p) => [
  { title: 'Bring the budget to the governors', due_date: day(1), due_time: '16:00', priority: 'high', reason: 'the agenda asks for it', source: '[m1]', top: true },
  { title: 'Buy milk', due_date: null, due_time: null, priority: 'normal', reason: 'already a note', source: 'notes', top: false },
  { title: 'Book the dentist', due_date: 'next week', due_time: '99:99', priority: 'nonsense', reason: 'r', source: 'notes', top: true },
  { title: '', due_date: null, due_time: null, priority: 'low', reason: 'empty', source: 'notes', top: false },
];

test('the daily suggestions: checked, one top to-do, from the meetings; add and dismiss', async () => {
  const client = fakeClient(SUGGESTED);
  const t = await start({ client });
  try {
    const m1 = await meeting(t, 'School governors\nAgenda: please bring the budget', `${day(1)}T16:00`);
    await put(t, { text: 'Buy milk' });
    await waitFor(() => t.store.db.prepare("SELECT COUNT(*) AS n FROM notes WHERE ai_status = 'done'").get().n >= 2);

    const r = await t.api('suggestions/run', { method: 'POST' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const prompt = client.calls.at(-1).messages[0].content.at(-1).text;
    assert.match(prompt, /<meetings>\n\[m1\] .+ School governors/);
    assert.match(prompt, /<open_notes>\n- .*Buy milk/);
    assert.ok(!prompt.includes('nina@example.com'), 'never the email');

    const list = r.body.suggestions;
    assert.deepEqual(list.map((s) => s.title), ['Bring the budget to the governors', 'Book the dentist'], 'duplicates of open notes and empty titles are dropped');
    assert.deepEqual(list.map((s) => s.top), [true, false], 'exactly one top to-do');
    const [budget, dentist] = list;
    assert.deepEqual([budget.source, budget.source_label, budget.due_date, budget.due_time], ['calendar', 'School governors', day(1), '16:00']);
    assert.deepEqual([dentist.due_date, dentist.due_time, dentist.priority], [null, null, 'normal'], 'impossible dates and values are dropped');
    assert.ok(!t.store.db.prepare("SELECT id FROM notes WHERE text LIKE 'Bring the budget%'").get(), 'nothing becomes a note on its own');

    // Add (edited): a normal note with its date. Dismiss: gone, and never suggested again.
    const added = await t.api(`suggestions/${budget.id}/add`, { method: 'POST', body: JSON.stringify({ title: 'Bring the budget (printed)' }) });
    assert.equal(added.status, 200);
    const note = t.store.get(added.body.note.id);
    assert.deepEqual([note.text, note.user_due], ['Bring the budget (printed)', `${day(1)}T16:00`]);
    assert.equal((await t.api(`suggestions/${dentist.id}/dismiss`, { method: 'POST' })).status, 200);
    assert.deepEqual((await t.api('suggestions')).body.suggestions, []);
    assert.equal((await t.api(`suggestions/${dentist.id}/add`, { method: 'POST' })).status, 404, 'a decided suggestion cannot be added');

    await t.api('suggestions/run', { method: 'POST' });
    assert.deepEqual((await t.api('suggestions')).body.suggestions.map((s) => s.title), [], 'added and dismissed ones never come back');
    assert.match(client.calls.at(-1).messages[0].content.at(-1).text, /<dismissed_before>\n- Book the dentist/, 'the AI learns what was dismissed');

    // A suggestion from a meeting that goes away (calendar disconnected) goes too.
    t.store.db.prepare("DELETE FROM suggestions").run();
    t.suggestions.keep(t.user.id, [{ title: 'Print the agenda', source: '[m1]' }], { source: 'daily', refs: new Map([['m1', t.store.get(m1)]]) });
    assert.equal((await t.api('suggestions')).body.suggestions.length, 1);
    t.store.db.prepare('UPDATE notes SET deleted = 1 WHERE id = ?').run(m1);
    assert.equal((await t.api('suggestions')).body.suggestions.length, 0);
  } finally {
    t.close();
  }
});

test('every morning at the chosen time, once, with a notification for the top to-do', async () => {
  const t = await start({ client: fakeClient(SUGGESTED) });
  try {
    await meeting(t, 'School governors', `${day(1)}T16:00`);
    const sent = [];
    Object.assign(t.suggestions, { tzOf: () => 'UTC', push: async (userId, p) => sent.push(p) });
    t.store.db.prepare('INSERT INTO events (ts, name, user_id, props) VALUES (?, ?, ?, ?)').run(Date.now(), 'app_open', t.user.id, '{}');
    assert.equal((await t.api('suggestions/settings', { method: 'PUT', body: JSON.stringify({ time: '25:00' }) })).status, 400);
    assert.equal((await t.api('suggestions/settings', { method: 'PUT', body: JSON.stringify({ time: '07:00' }) })).status, 200);

    const at = (hhmm) => Date.parse(`${day(0)}T${hhmm}:00Z`);
    t.suggestions.now = () => at('06:55');
    await t.suggestions.tick();
    assert.equal(sent.length, 0, 'not before the time');
    t.suggestions.now = () => at('07:02');
    await t.suggestions.tick();
    await t.suggestions.tick();
    assert.equal(sent.length, 1, 'once a day');
    assert.deepEqual([sent[0].title, sent[0].body], ['⭐ Your top to-do today', 'Bring the budget to the governors']);

    // Off: no suggestions, no notification.
    await t.api('suggestions/settings', { method: 'PUT', body: JSON.stringify({ on: false }) });
    t.suggestions.now = () => at('07:02') + 864e5;
    await t.suggestions.tick();
    assert.equal(sent.length, 1);
  } finally {
    t.close();
  }
});

test('AI chats: an assistant sends to-dos, and a chat export is read; both are Premium and wait for review', async () => {
  const client = fakeClient(() => [{ title: 'Email the landlord about the boiler', due_date: null, due_time: null, priority: 'high', reason: 'agreed in the chat', source: 'chat', top: true }]);
  const t = await start({ client });
  try {
    const mcp = async (token, name, args) => {
      const res = await fetch(`${t.base.replace(/api\/$/, '')}mcp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: name ? 'tools/call' : 'tools/list', params: name ? { name, arguments: args } : {} }),
      });
      return (await res.json()).result;
    };
    const writer = (await t.api('assistants', { method: 'POST', body: JSON.stringify({ name: 'Claude', write: true }) })).body.token;
    const reader = (await t.api('assistants', { method: 'POST', body: JSON.stringify({ name: 'ChatGPT' }) })).body.token;
    assert.ok((await mcp(writer)).tools.some((x) => x.name === 'suggest_todos'));
    assert.ok(!(await mcp(reader)).tools.some((x) => x.name === 'suggest_todos'), 'a read-only key cannot send');

    const sent = await mcp(writer, 'suggest_todos', { todos: [{ title: 'Renew the passport', due: '2030-02-01' }, { title: 'Call the plumber', due: 'soon' }] });
    assert.match(sent.content[0].text, /Sent 2 to-dos to the Suggested inbox/);
    const inbox = (await t.api('suggestions')).body.suggestions;
    const rows = inbox.map((s) => [s.title, s.due_date, s.source, s.source_label]).sort();
    assert.deepEqual(rows, [['Call the plumber', null, 'assistant', 'Claude'], ['Renew the passport', '2030-02-01', 'assistant', 'Claude']]);
    assert.ok(inbox.every((s) => !s.top), 'only the daily run picks the top to-do');
    assert.match((await mcp(writer, 'suggest_todos', { todos: [{ title: 'Renew the passport' }] })).content[0].text, /Nothing new/);

    // A ChatGPT export: the conversation's text reaches the AI, the result waits in the inbox.
    const exportFile = JSON.stringify([{ title: 'Boiler', mapping: { a: { message: { content: { parts: ['The boiler is broken again.', 'Then email the landlord today.'] } } } } }]);
    const r = await t.api('suggestions/chat', { method: 'POST', body: JSON.stringify({ text: exportFile, name: 'ChatGPT: Boiler' }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.added, 1);
    assert.match(client.calls.at(-1).messages[0].content.at(-1).text, /<chat name="ChatGPT: Boiler">\n[\s\S]*Then email the landlord today\./);
    assert.ok(r.body.suggestions.some((s) => s.source === 'chat' && s.source_label === 'ChatGPT: Boiler'));

    // Someone on the free plan: neither.
    process.env.ALLOW_SIGNUP = 'true';
    let cookie = '';
    const api = async (p, init = {}) => {
      const res = await fetch(t.base + p, { ...init, headers: { 'Content-Type': 'application/json', cookie } });
      cookie = res.headers.get('set-cookie')?.split(';')[0] || cookie;
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    await api('auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Tom', email: 'tom@example.com', password: 'correct horse' }) });
    assert.equal((await api('suggestions/chat', { method: 'POST', body: JSON.stringify({ text: 'hi' }) })).status, 402);
    const tomKey = (await api('assistants', { method: 'POST', body: JSON.stringify({ name: 'Claude', write: true }) })).body.token;
    const refused = await fetch(`${t.base.replace(/api\/$/, '')}mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tomKey}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'suggest_todos', arguments: { todos: [{ title: 'x' }] } } }),
    }).then((x) => x.json());
    assert.match(JSON.stringify(refused), /part of SortNotes Premium/);
  } finally {
    delete process.env.ALLOW_SIGNUP;
    t.close();
  }
});

test('the free plan gets 3 suggestions a day, Premium 5; deleting the account removes them', async () => {
  const five = () => ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((w, i) => ({ title: `Task number ${w}`, due_date: null, due_time: null, priority: 'normal', reason: 'r', source: 'notes', top: i === 0 }));
  const t = await start({ client: fakeClient(five) });
  try {
    await put(t, { text: 'Something to do' });
    assert.equal(t.suggestions.perDay(t.user.id), 5, 'the owner has Premium features');
    t.suggestions.premium = () => false;
    assert.equal(t.suggestions.perDay(t.user.id), 3);
    assert.equal((await t.suggestions.run(t.user.id)).length, 3);
    assert.equal((await t.suggestions.run(t.user.id)).length, 0, 'the day\'s allowance is used');
    t.store.deleteUser(t.user.id);
    assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM suggestions').get().n, 0);
  } finally {
    t.close();
  }
});

test('chat exports: the text of ChatGPT and Claude files, or plain text', () => {
  assert.equal(chatText('just text'), 'just text');
  assert.equal(chatText(JSON.stringify([{ chat_messages: [{ text: 'Hello' }, { content: [{ type: 'text', text: 'Book the hall' }] }] }])), 'Hello\nBook the hall');
});
