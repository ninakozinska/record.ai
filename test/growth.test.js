// Premium backups, "download all my notes", A/B tests and the optimization loops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { start } from './helpers.js';
import { probabilityBest, twoProportionP } from '../server/insights.js';
import { costOf, LIMITS } from '../server/optimizer.js';

const json = (method, body) => ({ method, body: JSON.stringify(body) });
const put = (api, id, body) => api(`notes/${id}`, json('PUT', { edited_at: Date.now(), ...body }));

function person(s) {
  let cookie = '';
  const api = async (p, init = {}) => {
    const res = await fetch(s.base + p, { ...init, headers: { 'Content-Type': 'application/json', cookie, ...init.headers } });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null), res };
  };
  return { api, signup: (name, email, headers = {}) => api('auth/signup', { ...json('POST', { name, email, password: 'correct horse' }), headers }) };
}

/** File names inside a .tar.gz. */
function tarNames(buf) {
  const tar = zlib.gunzipSync(buf);
  const names = [];
  for (let off = 0; off + 512 <= tar.length;) {
    const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/s, ''), 8);
    names.push(name);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

test('backups are premium: free accounts are told so; the owner backs up, restores to that day, and can undo', async () => {
  process.env.ALLOW_SIGNUP = 'true';
  const s = await start();
  try {
    const tom = person(s);
    await tom.signup('Tom', 'tom@example.com');
    assert.equal((await tom.api('plan')).body.premium, false);
    assert.equal((await tom.api('backups', { method: 'POST' })).status, 402);
    assert.equal((await tom.api('backups')).body.premium, false);

    // The owner has everything.
    assert.deepEqual((await s.api('plan')).body, { plan: 'family', premium: true, admin: true, features: { backups: true, backupDays: 30 } });
    await put(s.api, 'list-groceries', { text: 'Groceries' });
    await put(s.api, 'item-milk0001', { text: 'milk', parent_id: 'list-groceries' });
    await put(s.api, 'note-keepme01', { text: 'Keep me', user_group: 'Home' });
    s.store.applyAi('note-keepme01', { status: 'done', title: 'Keep me safe', group: 'Home', priority: 'high' });
    const { backup } = (await s.api('backups', { method: 'POST' })).body;
    assert.equal(backup.notes, 3);
    assert.equal((await s.api('backups', { method: 'POST' })).status, 429, 'not twice a minute');

    // Later: a note is deleted, one is changed, one is new.
    await put(s.api, 'note-keepme01', { deleted: true });
    await put(s.api, 'item-milk0001', { text: 'oat milk', done: true });
    await put(s.api, 'note-newer001', { text: 'Written after the backup' });

    const r = await s.api(`backups/${backup.id}/restore`, { method: 'POST' });
    assert.equal(r.status, 200);
    const n = (id) => s.store.get(id);
    assert.equal(n('note-keepme01').deleted, false, 'deleted note is back');
    assert.equal(n('note-keepme01').title, 'Keep me safe', 'with what the AI had written, no AI call needed');
    assert.equal(n('note-keepme01').ai_status, 'done');
    assert.deepEqual([n('item-milk0001').text, n('item-milk0001').done], ['milk', false]);
    assert.equal(n('note-newer001').deleted, true, 'notes made since are removed');
    const kinds = (await s.api('backups')).body.backups.map((b) => b.kind).sort();
    assert.deepEqual(kinds, ['before-restore', 'manual'], 'the state before restoring was saved first');

    const dl = await s.api(`backups/${backup.id}/download`);
    assert.equal(dl.body.notes.length, 3);
    assert.equal((await tom.api(`backups/${backup.id}/download`)).status, 402);
    assert.equal((await s.api('backups/../../etc/restore', { method: 'POST' })).status, 404);
  } finally {
    delete process.env.ALLOW_SIGNUP;
    s.close();
  }
});

test('daily backups: once a day for premium accounts, kept 30 days', async () => {
  process.env.ALLOW_SIGNUP = 'true';
  const s = await start();
  try {
    const free = person(s);
    await free.signup('Free', 'free@example.com');
    const paid = person(s);
    await paid.signup('Paid', 'paid@example.com');
    s.store.setPlan(s.store.findUserByEmail('paid@example.com').id, 'solo');
    await put(paid.api, 'note-paid0001', { text: 'Paid note' });
    const day = (d) => new Date(`2026-10-${d}T03:00:00Z`);
    const bk = s.backups;
    assert.equal(bk.runDaily(day('01')).length, 2, 'owner and the solo account, not the free one');
    assert.equal(bk.runDaily(day('01')).length, 0, 'once a day');
    for (let d = 2; d <= 31; d++) bk.runDaily(day(String(d).padStart(2, '0')));
    const paidId = s.store.findUserByEmail('paid@example.com').id;
    const days = bk.list(paidId).map((x) => x.id);
    assert.equal(days.length, 30);
    assert.ok(!days.includes('2026-10-01'), 'older than 30 days is gone');
    assert.deepEqual(bk.list(s.store.findUserByEmail('free@example.com').id), []);
  } finally {
    delete process.env.ALLOW_SIGNUP;
    s.close();
  }
});

test('anyone can download all their notes with photos', async () => {
  const s = await start();
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await s.api('images/photo-0001.png', { method: 'PUT', body: png, headers: { 'Content-Type': 'image/png' } });
    await put(s.api, 'note-photo001', { text: 'Whiteboard', images: ['photo-0001.png'] });
    await put(s.api, 'list-trip0001', { text: 'Trip' });
    await put(s.api, 'item-pass0001', { text: 'passport', parent_id: 'list-trip0001' });
    const res = await fetch(s.base + 'export', { headers: { cookie: s.cookie() } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /record-ai-notes-\d{4}-\d{2}-\d{2}\.tar\.gz/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(tarNames(buf), ['record-ai/notes.json', 'record-ai/notes.md', 'record-ai/photos/photo-0001.png']);
    const md = zlib.gunzipSync(buf).toString('utf8');
    assert.match(md, /## Trip\n(\*[^\n]*\*\n)?- \[ \] passport/);
  } finally {
    s.close();
  }
});

test('A/B tests: sticky variants before and after signing up, events, results; the dashboard is the owner\'s', async () => {
  process.env.ALLOW_SIGNUP = 'true';
  const s = await start();
  try {
    const anon = 'device-test-0001';
    const pub = (p, init) => fetch(s.base + p, { headers: { 'Content-Type': 'application/json' }, ...init }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const first = await pub(`public/experiments?anon=${anon}&platform=ios`);
    assert.equal(first.body.subject, `a:${anon}`);
    const v = first.body.variants.premium_pitch;
    assert.ok(['backups', 'family'].includes(v));
    for (let i = 0; i < 3; i++) assert.equal((await pub(`public/experiments?anon=${anon}`)).body.variants.premium_pitch, v, 'sticky');
    assert.equal((await pub('public/experiments')).status, 400);
    const ev = await pub('public/events', json('POST', { anon, platform: 'ios', events: [{ name: 'landing_view' }, { name: 'Bad Name!' }, { name: 'upgrade_click', props: { from: 'test' } }] }));
    assert.equal(ev.body.saved, 2);

    // Signing up on that device keeps the variant and the history.
    const tom = person(s);
    await tom.signup('Tom', 'tom@example.com', { 'x-anon-id': anon });
    const tomId = s.store.findUserByEmail('tom@example.com').id;
    assert.equal((await tom.api('public/experiments')).body.variants.premium_pitch, v);
    assert.ok(s.insights.firstTime(tomId, 'landing_view'), 'the anonymous events now belong to Tom');
    assert.ok(s.insights.firstTime(tomId, 'signup'));

    // Results: the owner's dashboard.
    assert.equal((await tom.api('admin/overview')).status, 404, 'only the owner');
    const overview = (await s.api('admin/overview')).body;
    const exp = overview.experiments.find((e) => e.key === 'premium_pitch');
    const mine = exp.variants.find((x) => x.key === v);
    assert.ok(mine.subjects >= 1 && mine.conversions >= 1);
    assert.ok(Array.isArray(overview.kpis) && overview.kpis.at(-1).signups >= 1);
    assert.equal((await s.api('admin/experiments', json('POST', { key: 'Bad key', variants: [] }))).status, 400);
    const saved = await s.api('admin/experiments', json('POST', { key: 'onboarding_steps', metric: 'note_created', variants: [{ key: 'three', weight: 50 }, { key: 'one', weight: 50 }] }));
    assert.equal(saved.body.experiment.status, 'running');
    // Plans by hand until payments exist.
    assert.equal((await s.api('admin/plan', json('POST', { email: 'tom@example.com', plan: 'family' }))).body.plan, 'family');
    assert.equal((await tom.api('plan')).body.premium, true);
  } finally {
    delete process.env.ALLOW_SIGNUP;
    s.close();
  }
});

test('the cost loop waits longer when typing wastes AI calls, and less when it does not', async () => {
  const s = await start();
  try {
    const add = (outcome, n) => {
      for (let i = 0; i < n; i++) {
        s.store.db.prepare("INSERT INTO ai_calls (ts, user_id, kind, model, cost_usd, outcome) VALUES (?, ?, 'note', 'claude-haiku-5-5', 0.0002, ?)").run(Date.now() - 1000, s.user.id, outcome);
      }
    };
    add('used', 30);
    assert.deepEqual(s.optimizer.costLoop(), [], 'too few calls to judge');
    add('stale', 15);
    s.optimizer.costLoop();
    assert.equal(s.organizer.debounceMs, LIMITS.debounceMs.start, '33% wasted: start waiting');
    s.optimizer.costLoop();
    assert.equal(s.organizer.debounceMs, LIMITS.debounceMs.start * 2);
    assert.equal(s.store.getMeta('opt:debounce_ms'), String(LIMITS.debounceMs.start * 2), 'kept across restarts');
    s.store.db.exec("UPDATE ai_calls SET outcome = 'used'");
    add('used', 100);
    s.optimizer.costLoop();
    assert.equal(s.organizer.debounceMs, LIMITS.debounceMs.start, 'nothing wasted: wait less');
    assert.match(s.optimizer.logEntries(1)[0].decision, /wait less/);

    // Reorganizing that rarely moves anything happens less often; quality guardrail undoes it.
    for (let i = 0; i < 3; i++) s.insights.track('ai_reorganized', { userId: s.user.id, props: { moved: 0, total: 40 } });
    s.optimizer.costLoop();
    assert.equal(s.organizer.reorganizeEvery(s.user.id), 40);
    const week = 7 * 864e5;
    for (let i = 0; i < 50; i++) {
      s.store.db.prepare("INSERT INTO ai_calls (ts, kind, outcome) VALUES (?, 'note', 'used')").run(Date.now() - week - 3600e3);
    }
    for (let i = 0; i < 10; i++) s.insights.track('ai_corrected', { userId: s.user.id, props: { field: 'group' } });
    const q = s.optimizer.qualityLoop();
    assert.equal(q.tripped, true);
    assert.equal(s.organizer.reorganizeEvery(s.user.id), 20, 'back to reorganizing more often');
  } finally {
    s.close();
  }
});

test('the revenue loop shifts traffic to the likely winner and declares it once it is clear and safe', async () => {
  const s = await start();
  try {
    const exp = s.insights.saveExperiment({ key: 'pitch_test', metric: 'upgrade_click', guardrails: ['note_created'], minSubjects: 100, variants: [{ key: 'a', weight: 50 }, { key: 'b', weight: 50 }] });
    const fill = (variant, n, conv, guard) => {
      for (let i = 0; i < n; i++) {
        const anon = `${variant}-subject-${i}`;
        s.store.db.prepare('INSERT INTO assignments (experiment, subject, variant, ts) VALUES (?, ?, ?, ?)').run(exp.key, `a:${anon}`, variant, Date.now() - 5000);
        if (i < conv) s.insights.track('upgrade_click', { anonId: anon });
        if (i < guard) s.insights.track('note_created', { anonId: anon });
      }
    };
    fill('a', 60, 5, 40);
    fill('b', 60, 8, 40);
    s.optimizer.revenueLoop();
    const shifted = s.insights.experiment('pitch_test');
    assert.equal(shifted.status, 'running');
    assert.ok(shifted.variants[1].weight > shifted.variants[0].weight, 'more new people see b');
    assert.ok(shifted.variants[0].weight >= 5, 'a keeps some traffic');
    fill('b', 0, 0, 0);
    s.store.db.exec("DELETE FROM assignments WHERE experiment = 'pitch_test'");
    fill('a', 150, 6, 100);
    fill('b', 150, 30, 100);
    s.optimizer.revenueLoop();
    const done = s.insights.experiment('pitch_test');
    assert.deepEqual([done.status, done.winner], ['won', 'b']);
    assert.equal(s.insights.variant(done, 'a:someone-new-0001'), 'b', 'everyone new gets the winner');

    // A winner that hurts a guardrail is not declared.
    const risky = s.insights.saveExperiment({ key: 'risky_test', metric: 'upgrade_click', guardrails: ['note_created'], minSubjects: 100, variants: [{ key: 'a', weight: 50 }, { key: 'b', weight: 50 }] });
    for (const [variant, conv, guard] of [['a', 6, 100], ['b', 30, 50]]) {
      for (let i = 0; i < 150; i++) {
        const anon = `${risky.key}-${variant}-${i}`;
        s.store.db.prepare('INSERT INTO assignments (experiment, subject, variant, ts) VALUES (?, ?, ?, ?)').run(risky.key, `a:${anon}`, variant, Date.now() - 5000);
        if (i < conv) s.insights.track('upgrade_click', { anonId: anon });
        if (i < guard) s.insights.track('note_created', { anonId: anon });
      }
    }
    s.optimizer.revenueLoop();
    assert.equal(s.insights.experiment('risky_test').status, 'running');
  } finally {
    s.close();
  }
});

test('AI calls are recorded with their cost; statistics helpers', async () => {
  const calls = [];
  const client = { beta: { messages: { parse: async (p) => {
    calls.push(p);
    return { model: 'claude-haiku-5-5', stop_reason: 'end_turn', usage: { input_tokens: 2000, output_tokens: 300 }, parsed_output: { title: 'T', summary: 's', group: 'Home', priority: 'high', priority_reason: 'r', tags: [], due_date: null, due_time: null } };
  } } } };
  const s = await start({ client });
  try {
    await put(s.api, 'note-cost0001', { text: 'Pay the bill' });
    await new Promise((r) => setTimeout(r, 50));
    const row = s.store.db.prepare('SELECT * FROM ai_calls').get();
    assert.deepEqual([row.kind, row.outcome, row.input_tokens, row.output_tokens], ['note', 'used', 2000, 300]);
    assert.ok(Math.abs(row.cost_usd - 0.00035) < 1e-9, 'Haiku 5.5: 2000 x $0.10 + 300 x $0.50 per million');
    assert.equal(costOf('some-local-model', { input_tokens: 100 }), 0);
    assert.ok(s.insights.firstTime(s.user.id, 'note_created'));
  } finally {
    s.close();
  }
  assert.ok(twoProportionP(10, 100, 30, 100) < 0.01);
  assert.ok(twoProportionP(10, 100, 11, 100) > 0.5);
  const [pa, pb] = probabilityBest([{ conversions: 5, subjects: 100 }, { conversions: 20, subjects: 100 }]);
  assert.ok(pb > 0.99 && pa < 0.01);
});
