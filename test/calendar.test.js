// Dates and times on notes, and calendars (one note, or a subscribed feed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';
import { toIcs } from '../server/calendar.js';

const json = (method, body) => ({ method, body: JSON.stringify(body) });
const put = (s, id, body) => s.api(`notes/${id}`, json('PUT', { edited_at: Date.now(), ...body }));
const unfold = (ics) => ics.replace(/\r\n /g, '');

test("the person's own date and time win over the AI's, and can go back to Auto", async () => {
  const s = await start();
  try {
    await put(s, 'note-dentist1', { text: 'Dentist Tuesday 3pm' });
    s.store.applyAi('note-dentist1', { status: 'done', title: 'Dentist', due_date: '2026-11-03', due_time: '15:00' });
    let n = s.store.get('note-dentist1');
    assert.deepEqual([n.due_date, n.due_time, n.user_due], ['2026-11-03', '15:00', null]);

    n = (await put(s, 'note-dentist1', { user_due: '2026-11-04T09:30' })).body.note;
    assert.deepEqual([n.due_date, n.due_time, n.ai_due_date, n.ai_due_time], ['2026-11-04', '09:30', '2026-11-03', '15:00']);
    n = (await put(s, 'note-dentist1', { user_due: '2026-11-05' })).body.note;
    assert.deepEqual([n.due_date, n.due_time], ['2026-11-05', null], 'a day without a time');
    n = (await put(s, 'note-dentist1', { user_due: '' })).body.note;
    assert.deepEqual([n.due_date, n.due_time], [null, null], 'no date at all');
    // The AI re-reading the note doesn't undo the person's choice.
    s.store.applyAi('note-dentist1', { status: 'done', due_date: '2026-11-10', due_time: '10:00' });
    assert.equal(s.store.get('note-dentist1').due_date, null);
    n = (await put(s, 'note-dentist1', { user_due: null })).body.note;
    assert.deepEqual([n.due_date, n.due_time], ['2026-11-10', '10:00'], 'back to Auto');
    // A date without a time from the AI clears its old time.
    s.store.applyAi('note-dentist1', { status: 'done', due_date: null, due_time: null });
    assert.deepEqual([s.store.get('note-dentist1').due_date, s.store.get('note-dentist1').due_time], [null, null]);

    for (const bad of ['tomorrow', '2026-11-04 09:30', '2026-11-04T9:30', 5]) {
      assert.equal((await put(s, 'note-dentist1', { user_due: bad })).status, 400, `refuses ${bad}`);
    }
  } finally {
    s.close();
  }
});

test('a calendar link shows open dated notes (also shared ones) in the right time zone; a new link turns the old one off', async () => {
  process.env.ALLOW_SIGNUP = 'true';
  const s = await start();
  try {
    await put(s, 'note-dentist1', { text: 'Dentist', user_due: '2026-11-04T09:30' });
    await put(s, 'note-birthday', { text: "Ola's birthday", user_due: '2026-12-01' });
    await put(s, 'note-donedone', { text: 'Old thing', user_due: '2026-10-01', done: true });
    await put(s, 'note-nodate01', { text: 'No date here' });
    await put(s, 'list-trip0001', { text: 'Pack for the trip', user_due: '2026-11-20' });
    await put(s, 'item-passport', { text: 'passport', parent_id: 'list-trip0001' });

    // Someone shares a dated note with Nina.
    let cookie = '';
    const tom = async (p, init = {}) => {
      const res = await fetch(s.base + p, { ...init, headers: { 'Content-Type': 'application/json', cookie } });
      cookie = res.headers.get('set-cookie')?.split(';')[0] || cookie;
      return res.json();
    };
    await tom('auth/signup', json('POST', { name: 'Tom', email: 'tom@example.com', password: 'correct horse' }));
    await tom('notes/note-tomparty', json('PUT', { text: 'Party at Tom', user_due: '2026-11-07T19:00', edited_at: Date.now() }));
    await tom('shares', json('POST', { kind: 'note', target: 'note-tomparty', email: 'nina@example.com' }));

    const { url, webcal } = (await s.api('calendar-link?tz=Europe/Rome')).body;
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/api\/calendar\/[\w-]{30,}\.ics$/);
    assert.equal(webcal, url.replace('http:', 'webcal:'));
    assert.equal((await s.api('calendar-link')).body.url, url, 'the same link every time');

    // Calendar apps fetch it without logging in.
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/calendar/);
    const ics = unfold(await res.text());
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
    assert.match(ics, /X-WR-TIMEZONE:Europe\/Rome/);
    assert.match(ics, /UID:note-dentist1@record\.ai\r\nDTSTAMP:\d{8}T\d{6}Z\r\nLAST-MODIFIED:\d{8}T\d{6}Z\r\nDTSTART;TZID=Europe\/Rome:20261104T093000\r\nDTEND;TZID=Europe\/Rome:20261104T103000\r\nSUMMARY:Dentist/);
    assert.match(ics, /DTSTART;VALUE=DATE:20261201\r\nDTEND;VALUE=DATE:20261202\r\nSUMMARY:Ola's birthday/, 'all day');
    assert.match(ics, /SUMMARY:Pack for the trip\r\nDESCRIPTION:☐ passport/, 'a list brings its items');
    assert.match(ics, /SUMMARY:Party at Tom/, 'shared with Nina');
    assert.doesNotMatch(ics, /Old thing|No date here/, 'done and undated notes are left out');

    const fresh = (await s.api('calendar-link/reset', { method: 'POST' })).body.url;
    assert.notEqual(fresh, url);
    assert.equal((await fetch(url)).status, 404, 'the old link stops working');
    assert.equal((await fetch(fresh)).status, 200);
    assert.equal((await fetch(s.base + 'calendar/not-a-real-link-at-all-0000000.ics')).status, 404);
  } finally {
    delete process.env.ALLOW_SIGNUP;
    s.close();
  }
});

test('one note as a calendar file', async () => {
  const s = await start();
  try {
    await put(s, 'note-dentist1', { text: 'Dentist\nBring the insurance card', user_due: '2026-11-04T23:30' });
    await put(s, 'note-nodate01', { text: 'No date' });
    const res = await fetch(s.base + 'notes/note-dentist1/calendar.ics', { headers: { cookie: s.cookie() } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="Dentist.ics"/);
    const ics = unfold(await res.text());
    assert.match(ics, /DTSTART:20261104T233000\r\nDTEND:20261105T003000/, 'no time zone: the phone uses its own; ends after midnight');
    assert.match(ics, /DESCRIPTION:Dentist\\nBring the insurance card/);
    assert.equal((await s.api('notes/note-nodate01/calendar.ics')).status, 404);
    assert.equal((await fetch(s.base + 'notes/note-dentist1/calendar.ics')).status, 401, 'needs a login');
  } finally {
    s.close();
  }
});

test('calendar text is escaped and long lines are folded', () => {
  const ics = toIcs([{ id: 'n1', text: 'x', title: 'Meet; Anna, Bob \\ ' + 'é'.repeat(60), due_date: '2026-11-04', due_time: null, edited_at: 0 }]);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.match(unfold(ics), /SUMMARY:Meet\\; Anna\\, Bob \\\\ é{60}/);
});

test('the AI is told to count relative dates from the day the note was written', async () => {
  const calls = [];
  const client = {
    beta: {
      messages: {
        parse: async (p) => {
          calls.push(p);
          return { stop_reason: 'end_turn', parsed_output: { title: 'Notary', summary: 's', group: 'Home', priority: 'high', priority_reason: 'r', tags: [], due_date: '2026-10-28', due_time: '10:00' } };
        },
      },
    },
  };
  const s = await start({ client });
  try {
    await put(s, 'note-notary01', { text: 'Notary next week on Wednesday at 10', created_at: Date.parse('2026-10-21T08:00:00Z') });
    await new Promise((r) => setTimeout(r, 50));
    assert.match(calls[0].system, /from the day the note was written \(its created date\), not from today/);
    assert.match(JSON.stringify(calls[0].messages), /created=\\"2026-10-21T08:00:00.000Z\\"/);
    const n = s.store.get('note-notary01');
    assert.deepEqual([n.due_date, n.due_time], ['2026-10-28', '10:00']);
  } finally {
    s.close();
  }
});
