// "Hear today": the day's plan as one text to read aloud, in the person's language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spokenToday } from '../server/today.js';
import { start } from './helpers.js';

// Friday 6 November 2026, 07:10 in Rome (06:10 UTC).
const NOW = Date.UTC(2026, 10, 6, 6, 10);
const note = (o) => ({ id: crypto.randomUUID(), user_id: 'me', text: o.title || '', title: '', done: false, deleted: false, parent_id: null, due_date: null, due_time: null, created_at: 1, ...o });
const storeOf = (notes, lang = 'en') => ({ languageOf: () => lang, changesSince: () => notes });

test('the day is read in order: times first, then the rest, what is for me, the top to-do, overdue', () => {
  const bag = note({ title: 'School bag', due_date: '2026-11-06', due_time: '07:30' });
  const notes = [
    note({ title: 'Dentist for Leo', due_date: '2026-11-06', due_time: '09:00' }),
    bag,
    note({ id: 'i1', parent_id: bag.id, text: 'Lunch box', created_at: 1 }),
    note({ id: 'i2', parent_id: bag.id, text: 'Swim kit', created_at: 2 }),
    note({ id: 'i3', parent_id: bag.id, text: 'Packed already', done: true }),
    note({ title: 'Buy milk', due_date: '2026-11-06' }),
    note({ title: 'Sign the trip form', due_date: '2026-11-06', user_id: 'tom', assigned_to: 'me' }),
    note({ title: 'Call the bank', due_date: '2026-11-02' }),
    note({ title: 'Done already', due_date: '2026-11-06', done: true }),
    note({ title: 'Tomorrow', due_date: '2026-11-07' }),
    note({ title: 'Deleted', due_date: '2026-11-06', deleted: true }),
  ];
  const day = spokenToday({ store: storeOf(notes), userId: 'me', tz: 'Europe/Rome', now: NOW, topTodo: 'Book the plumber' });
  assert.equal(day.text,
    'Good morning. Friday 6 November. At 7:30, School bag: Lunch box, Swim kit. At 9:00, Dentist for Leo. '
    + 'Also today: Buy milk. For you: Sign the trip form. Top to-do: Book the plumber. 1 overdue. Have a good day.');
  assert.equal(day.count, 4);
  assert.equal(day.overdue, 1);
});

test('in the person language, with their way of saying times', () => {
  const notes = [note({ title: 'Scuola', due_date: '2026-11-06', due_time: '07:30' })];
  assert.equal(spokenToday({ store: storeOf(notes, 'it'), userId: 'me', tz: 'Europe/Rome', now: NOW }).text,
    'Buongiorno. Venerdì 6 novembre. Alle 7:30, Scuola. Buona giornata.');
  assert.match(spokenToday({ store: storeOf(notes, 'de'), userId: 'me', tz: 'Europe/Rome', now: NOW }).text, /Um 7:30 Uhr, Scuola\./);
  assert.match(spokenToday({ store: storeOf(notes, 'fr'), userId: 'me', tz: 'Europe/Rome', now: NOW }).text, /À 7 h 30, Scuola\./);
  assert.equal(spokenToday({ store: storeOf([], 'pl'), userId: 'me', tz: 'Europe/Rome', now: NOW }).text,
    'Dzień dobry. Piątek, 6 listopada. Na dziś nic nie zaplanowano. Miłego dnia.');
});

test('a long day: the first eight are read, the rest counted', () => {
  const notes = Array.from({ length: 11 }, (_, i) => note({ title: `Thing ${i}`, due_date: '2026-11-06', due_time: `1${i % 10}:00` }));
  const { text } = spokenToday({ store: storeOf(notes), userId: 'me', tz: 'Europe/Rome', now: NOW });
  assert.equal((text.match(/Thing/g) || []).length, 8);
  assert.match(text, /and 3 more\./);
});

test('GET /api/today/spoken: the day for the signed-in person', async () => {
  const t = await start();
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });
    await t.api(`notes/${crypto.randomUUID()}`, { method: 'PUT', body: JSON.stringify({ text: 'Pick up Mia', user_due: `${today}T16:00`, created_at: Date.now(), edited_at: Date.now() }) });
    const r = await t.api('today/spoken');
    assert.equal(r.status, 200);
    assert.match(r.body.text, /At 16:00, Pick up Mia\./);
    assert.equal(r.body.lang, 'en');
    assert.equal(r.body.canRead, true, 'the owner has everything');
  } finally {
    await t.close();
  }
});
