// The AI organizer: Claude request options, error handling, per-user reorganizing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { openDb } from '../server/db.js';
import { Organizer } from '../server/organizer.js';

const quiet = { error() {} };
const analysis = { title: 'T', summary: 's', group: 'Home', priority: 'high', priority_reason: 'r', tags: [], due_date: null };

/** Fake Claude client whose answers are scripted per call. */
function scripted(...answers) {
  const calls = [];
  const next = async (p) => {
    calls.push(p);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(p) : a;
  };
  return { calls, beta: { messages: { parse: next, stream: (p) => ({ finalMessage: () => next(p) }) } } };
}

const ok = (parsed = analysis) => ({ stop_reason: 'end_turn', parsed_output: parsed });
const badRequest = (msg) => Anthropic.APIError.generate(400, { error: { message: msg } }, msg, new Headers());

function setup(client, env = {}) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-ai-org-'));
  const store = openDb(dir);
  const a = store.createUser({ email: 'a@example.com', name: 'A', pwHash: 'x' });
  const b = store.createUser({ email: 'b@example.com', name: 'B', pwHash: 'x' });
  const organizer = new Organizer({ store, imagesDir: dir, onChange() {}, client, log: quiet });
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return { store, organizer, a, b, restore };
}

const note = (t, user, id, text = 'pay the bill') => t.store.upsertFromClient(user.id, { id, text, edited_at: 1 });

test('Claude: refusal fallback is requested, and dropped if the API rejects it', async () => {
  const client = scripted(badRequest('fallbacks: unknown parameter'), ok());
  const t = setup(client);
  try {
    note(t, t.a, 'note-org-0001');
    await t.organizer.organizeNote('note-org-0001');
    assert.equal(t.store.get('note-org-0001').ai_status, 'done');
    assert.equal(client.calls[0].fallbacks, 'default');
    assert.deepEqual(client.calls[0].betas, ['server-side-fallback-2026-07-01']);
    assert.equal(client.calls[1].fallbacks, undefined, 'retried without the fallback parameter');
    assert.equal(client.calls[0].model, 'claude-opus-5-5');
    assert.equal(client.calls[0].output_config.effort, 'low');
  } finally {
    t.restore();
  }
});

test('Claude: no credit is not retried and is explained in plain words', async () => {
  const client = scripted(badRequest('Your credit balance is too low to access the Anthropic API.'));
  const t = setup(client);
  try {
    note(t, t.a, 'note-org-0002');
    await t.organizer.organizeNote('note-org-0002');
    const n = t.store.get('note-org-0002');
    assert.equal(n.ai_status, 'error');
    assert.match(n.ai_error, /no credit/);
    assert.equal(n.group, 'Inbox', 'the note stays usable');
    assert.equal(client.calls.length, 1);
  } finally {
    t.restore();
  }
});

test('Claude Haiku: sent without the fallback parameter', async () => {
  const client = scripted(ok());
  const t = setup(client, { CLAUDE_MODEL: 'claude-haiku-5-5' });
  try {
    note(t, t.a, 'note-org-0003');
    await t.organizer.organizeNote('note-org-0003');
    assert.equal(client.calls[0].model, 'claude-haiku-5-5');
    assert.equal(client.calls[0].fallbacks, undefined);
    assert.equal(t.organizer.status.model, 'claude-haiku-5-5');
  } finally {
    t.restore();
  }
});

test('Claude: refusals and cut-off answers become clear errors', async () => {
  for (const [stop, words] of [['refusal', /declined/], ['max_tokens', /cut off/]]) {
    const t = setup(scripted({ stop_reason: stop, parsed_output: null }));
    try {
      note(t, t.a, 'note-org-0004');
      await t.organizer.organizeNote('note-org-0004');
      assert.equal(t.store.get('note-org-0004').ai_status, 'error');
      assert.match(t.store.get('note-org-0004').ai_error, words);
    } finally {
      t.restore();
    }
  }
});

test('the AI sees the existing groups of the same user only', async () => {
  const client = scripted(ok());
  const t = setup(client);
  try {
    t.store.upsertFromClient(t.b.id, { id: 'note-org-b001', text: 'b', user_group: 'SecretGroupOfB', edited_at: 1 });
    note(t, t.a, 'note-org-0005');
    await t.organizer.organizeNote('note-org-0005');
    const prompt = client.calls[0].messages[0].content.at(-1).text;
    assert.doesNotMatch(prompt, /SecretGroupOfB/);
  } finally {
    t.restore();
  }
});

test('reorganize runs automatically after N notes, for that user only', async () => {
  const client = scripted((p) => {
    if (p.max_tokens > 10000) {
      const ids = [...p.messages[0].content.at(-1).text.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
      return ok({ notes: ids.map((id) => ({ id, group: 'Tidy', priority: 'low', priority_reason: 'r' })) });
    }
    return ok();
  });
  const t = setup(client, { REORGANIZE_EVERY: '2' });
  try {
    t.store.upsertFromClient(t.b.id, { id: 'note-org-b002', text: 'b', edited_at: 1 });
    note(t, t.a, 'note-org-0006');
    note(t, t.a, 'note-org-0007');
    await t.organizer.organizeNote('note-org-0006');
    await t.organizer.organizeNote('note-org-0007');
    for (let i = 0; i < 100 && t.store.get('note-org-0006').ai_group !== 'Tidy'; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(t.store.get('note-org-0006').ai_group, 'Tidy');
    assert.equal(t.store.get('note-org-0007').ai_group, 'Tidy');
    assert.notEqual(t.store.get('note-org-b002').ai_group, 'Tidy', "another user's notes are untouched");
    const reorgPrompt = client.calls.find((c) => c.max_tokens > 10000).messages[0].content.at(-1).text;
    assert.doesNotMatch(reorgPrompt, /note-org-b002/);
  } finally {
    t.restore();
  }
});

test('local AI: missing model and server errors are explained', async () => {
  let status = 404;
  const server = http.createServer((req, res) => {
    req.resume();
    res.statusCode = status;
    res.end(JSON.stringify({ error: status === 404 ? 'model "gemma3:4b" not found' : 'out of memory' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const t = setup(undefined, { AI_PROVIDER: 'ollama', OLLAMA_URL: `http://127.0.0.1:${server.address().port}` });
  try {
    note(t, t.a, 'note-org-0008');
    await t.organizer.organizeNote('note-org-0008');
    assert.match(t.store.get('note-org-0008').ai_error, /not downloaded yet/);
    status = 500;
    t.store.applyAi('note-org-0008', { status: 'pending' });
    await t.organizer.organizeNote('note-org-0008');
    assert.match(t.store.get('note-org-0008').ai_error, /out of memory/);
  } finally {
    t.restore();
    server.close();
  }
});

test('"My groups" are given to the AI, for single notes and for reorganizing', async () => {
  const client = scripted(ok({ ...analysis, group: 'Baby' }), (p) => ({
    stop_reason: 'end_turn',
    parsed_output: { notes: [{ id: 'note-baby-0001', group: 'Baby', priority: 'high', priority_reason: 'r' }] },
  }));
  const t = setup(client);
  try {
    t.store.setMyGroups(t.a.id, ['Baby', 'Work']);
    note(t, t.a, 'note-baby-0001', 'buy a jacket for the baby');
    await t.organizer.organizeNote('note-baby-0001');
    const prompt = JSON.stringify(client.calls[0].messages);
    assert.match(prompt, /own groups \(use these exact names whenever a note fits one\): Baby, Work/);
    assert.equal(t.store.get('note-baby-0001').group, 'Baby');

    await t.organizer.reorganizeAll(t.a.id);
    assert.match(JSON.stringify(client.calls[1].messages), /Baby, Work[\s\S]*Never rename, merge or split these groups/);

    // B has no groups of their own: nothing extra in their prompt.
    note(t, t.b, 'note-b-000001');
    await t.organizer.organizeNote('note-b-000001');
    assert.doesNotMatch(JSON.stringify(client.calls[2].messages), /own groups/);
  } finally {
    t.restore();
  }
});
