// Monthly AI limit per person: all AI runs on the server owner's account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { Organizer } from '../server/organizer.js';

const analysis = { title: 'T', summary: 's', group: 'Home', priority: 'high', priority_reason: 'r', tags: [], due_date: null };
function fakeClaude() {
  const calls = [];
  const answer = async (p) => {
    calls.push(p);
    return p.output_config.format && p.stream !== undefined
      ? { stop_reason: 'end_turn', parsed_output: { notes: [] } }
      : { stop_reason: 'end_turn', parsed_output: analysis };
  };
  return {
    calls,
    beta: { messages: { parse: answer, stream: (p) => ({ finalMessage: () => answer({ ...p, stream: true }) }) } },
  };
}

function setup(env) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-ai-limit-'));
  const store = openDb(dir);
  const owner = store.createUser({ email: 'nina@example.com', name: 'Nina', pwHash: 'x' });
  const tom = store.createUser({ email: 'tom@example.com', name: 'Tom', pwHash: 'x' });
  const client = fakeClaude();
  const organizer = new Organizer({ store, imagesDir: dir, onChange() {}, client, log: { error() {} } });
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  let n = 0;
  const organize = async (user) => {
    const id = `note-limit-${String(++n).padStart(3, '0')}`;
    store.upsertFromClient(user.id, { id, text: `note ${n}`, edited_at: n });
    await organizer.organizeNote(id);
    return store.get(id);
  };
  return { store, organizer, owner, tom, client, organize, restore };
}

test('after the monthly limit, notes are saved but not sent to the AI; the owner has no limit', async () => {
  const t = setup({ AI_MONTHLY_LIMIT: '2', REORGANIZE_EVERY: '100' });
  try {
    assert.equal((await t.organize(t.tom)).ai_status, 'done');
    assert.equal((await t.organize(t.tom)).ai_status, 'done');
    const calls = t.client.calls.length;
    const held = await t.organize(t.tom);
    assert.equal(held.ai_status, 'limit');
    assert.match(held.ai_error, /This month's 2 AI sortings are used up\. .* from \d{4}-\d{2}-01\./);
    assert.equal(held.title, 'note 3', 'still gets a plain title');
    assert.equal(t.client.calls.length, calls, 'no AI call made');
    assert.deepEqual(
      { used: t.organizer.usage(t.tom.id).used, limit: t.organizer.usage(t.tom.id).limit },
      { used: 2, limit: 2 },
    );
    await assert.rejects(t.organizer.reorganizeAll(t.tom.id), (err) => err.status === 429);

    // The server's owner (first account) is never held back.
    for (let i = 0; i < 4; i++) assert.equal((await t.organize(t.owner)).ai_status, 'done');
    assert.equal(t.organizer.usage(t.owner.id).limit, null);

    // A higher limit (or a new month) lets the held-back notes through on the next start.
    process.env.AI_MONTHLY_LIMIT = '10';
    t.organizer.resumePending();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.store.get(held.id).ai_status, 'done');
  } finally {
    t.restore();
  }
});

test('a full reorganize counts as 5; AI_UNLIMITED and AI_MONTHLY_LIMIT=0 lift the limit', async () => {
  let t = setup({ AI_MONTHLY_LIMIT: '6', REORGANIZE_EVERY: '100' });
  try {
    await t.organize(t.tom);
    await t.organizer.reorganizeAll(t.tom.id);
    assert.equal(t.organizer.usage(t.tom.id).used, 6);
    await assert.rejects(t.organizer.reorganizeAll(t.tom.id), /used up/);
  } finally {
    t.restore();
  }
  t = setup({ AI_MONTHLY_LIMIT: '1', AI_UNLIMITED: 'someone@example.com, TOM@example.com' });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await t.organize(t.tom)).ai_status, 'done');
  } finally {
    t.restore();
  }
  t = setup({ AI_MONTHLY_LIMIT: '0' });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await t.organize(t.tom)).ai_status, 'done');
    assert.equal(t.organizer.usage(t.tom.id).limit, null);
  } finally {
    t.restore();
  }
});
