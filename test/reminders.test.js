// Reminders and the morning briefing, with a pretend clock and pretend devices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { start } from './helpers.js';
import { utcOf } from '../server/calendars.js';
import { Reminders, FREE_REMINDERS } from '../server/reminders.js';

const TZ = 'Europe/Rome';
const DAY = '2026-11-05';
const at = (wall) => utcOf(`${DAY}T${wall}`, TZ);
const SUB = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } };

async function setup() {
  const clock = { now: at('08:00') };
  const sent = [];
  let fail = null;
  const t = await start({
    reminders: {
      now: () => clock.now,
      send: async (sub, payload) => {
        if (fail) throw Object.assign(new Error('gone'), { statusCode: fail });
        sent.push({ sub, payload });
      },
    },
  });
  t.store.setMeta(`cal_tz:${t.user.id}`, TZ);
  return { t, clock, sent, failWith: (code) => { fail = code; } };
}

const put = (t, id, body) => t.api(`notes/${id}`, { method: 'PUT', body: JSON.stringify({ edited_at: Date.now() + Math.random(), ...body }) });

test('the server makes its notification keys once and keeps them', async () => {
  const { t } = await setup();
  try {
    const { body } = await t.api('push');
    assert.match(body.publicKey, /^[A-Za-z0-9_-]{80,}$/);
    assert.equal(new Reminders({ store: t.store, env: {}, tzOf: () => TZ }).vapid.publicKey, body.publicKey);
  } finally {
    t.close();
  }
});

test('a reminder goes off once, at its time, on every device; moving the note moves it', async () => {
  const { t, clock, sent } = await setup();
  try {
    assert.equal((await t.api('push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: { endpoint: 'http://insecure' } }) })).status, 400);
    const r = await t.api('push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: SUB, tz: TZ }) });
    assert.equal(r.body.devices, 1);
    const id = crypto.randomUUID();
    await put(t, id, { text: 'Dentist', user_due: `${DAY}T15:00`, remind: 15, created_at: Date.now() });
    assert.equal(t.store.get(id).remind, 15);

    clock.now = at('14:44');
    await t.reminders.tick();
    assert.equal(sent.length, 0, 'not yet');
    clock.now = at('14:45');
    await t.reminders.tick();
    await t.reminders.tick();
    assert.equal(sent.length, 1, 'once');
    assert.deepEqual(sent[0].payload, { title: 'Dentist', body: '⏰ 15:00', url: `./?open=${id}`, tag: id });

    await put(t, id, { user_due: `${DAY}T16:00` });
    clock.now = at('15:45');
    await t.reminders.tick();
    assert.equal(sent.length, 2, 'moved, so it goes off again at the new time');

    // A note with only a day: counted from 09:00. Done notes stay quiet.
    const day = crypto.randomUUID();
    await put(t, day, { text: 'Pay school trip', user_due: '2026-11-06', remind: 1440, created_at: Date.now() });
    const done = crypto.randomUUID();
    await put(t, done, { text: 'Done already', user_due: `${DAY}T16:00`, remind: 0, done: true, created_at: Date.now() });
    clock.now = at('09:00'); // the day before, at 09:00
    await t.reminders.tick();
    assert.equal(sent.at(-1).payload.title, 'Pay school trip');
    clock.now = at('16:00');
    await t.reminders.tick();
    assert.ok(!sent.some((s) => s.payload.title === 'Done already'));

    assert.equal((await put(t, crypto.randomUUID(), { text: 'x', remind: -5 })).status, 400);
  } finally {
    t.close();
  }
});

test('a device that unsubscribed is forgotten', async () => {
  const { t, failWith } = await setup();
  try {
    await t.api('push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: SUB }) });
    failWith(410);
    assert.equal(await t.reminders.push(t.user.id, { title: 'x' }), 0);
    assert.equal((await t.api('push')).body.devices, 0);
  } finally {
    t.close();
  }
});

test(`free accounts get ${FREE_REMINDERS} reminders a month; Premium and the owner any number`, async () => {
  const { t, clock } = await setup();
  try {
    const other = t.store.createUser({ email: 'anna@example.com', name: 'Anna', pwHash: 'x', imagesDir: t.dataDir });
    for (let i = 0; i < FREE_REMINDERS; i++) assert.equal(t.reminders.allow(other.id), true);
    assert.equal(t.reminders.allow(other.id), false);
    assert.deepEqual(t.reminders.quota(other.id), { limit: FREE_REMINDERS, left: 0 });
    clock.now = utcOf('2026-12-01T10:00', TZ);
    assert.equal(t.reminders.allow(other.id), true, 'a new month, a new allowance');
    t.store.setPlan(other.id, 'family');
    assert.deepEqual(t.reminders.quota(other.id), { limit: null, left: null });
    assert.deepEqual(t.reminders.quota(t.user.id), { limit: null, left: null }, 'the owner');
  } finally {
    t.close();
  }
});

test('the morning briefing: once a day at the chosen time, in the person\'s language', async () => {
  const { t, clock, sent } = await setup();
  try {
    await t.api('push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: SUB }) });
    assert.equal((await t.api('briefing', { method: 'PUT', body: JSON.stringify({ time: '25:00' }) })).status, 400);
    assert.equal((await t.api('briefing', { method: 'PUT', body: JSON.stringify({ time: '07:30' }) })).body.briefing, '07:30');
    await put(t, crypto.randomUUID(), { text: 'Pick up Mia', user_due: `${DAY}T16:00`, created_at: Date.now() });
    await put(t, crypto.randomUUID(), { text: 'Dentist', user_due: `${DAY}T09:15`, created_at: Date.now() });
    await put(t, crypto.randomUUID(), { text: 'Old bill', user_due: '2026-11-01', created_at: Date.now() });

    clock.now = at('07:29');
    await t.reminders.tick();
    assert.equal(sent.length, 0);
    clock.now = at('07:31');
    await t.reminders.tick();
    await t.reminders.tick();
    assert.equal(sent.length, 1, 'once a day');
    assert.deepEqual(sent[0].payload, { title: '☀️ Your day', body: '09:15 Dentist · 16:00 Pick up Mia · 1 overdue', url: './', tag: 'briefing', empty: false });

    t.store.setLanguage(t.user.id, 'it');
    clock.now = utcOf('2026-11-06T07:45', TZ);
    await t.reminders.tick();
    assert.deepEqual([sent[1].payload.title, sent[1].payload.body], ['☀️ La tua giornata', '3 in ritardo']);

    await t.api('briefing', { method: 'PUT', body: JSON.stringify({ time: null }) });
    clock.now = utcOf('2026-11-07T08:00', TZ);
    await t.reminders.tick();
    assert.equal(sent.length, 2, 'turned off');
  } finally {
    t.close();
  }
});

test('deleting the account removes its devices', async () => {
  const { t } = await setup();
  try {
    await t.api('push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: SUB }) });
    t.store.deleteUser(t.user.id);
    assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 0);
  } finally {
    t.close();
  }
});
