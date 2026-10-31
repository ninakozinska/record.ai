// Calendars both ways, against pretend Google, Calendly and iCloud servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { start } from './helpers.js';
import { wallTime, utcOf, sealer, parseIcs, PROVIDERS } from '../server/calendars.js';

const KEY = crypto.randomBytes(32).toString('hex');
const TZ = 'Europe/Rome';
const json = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tomorrow = () => wallTime(Date.now() + 864e5, TZ).slice(0, 10);
const offset = (day) => {
  const ms = utcOf(`${day}T12:00`, TZ);
  const h = (Date.parse(`${day}T12:00Z`) - ms) / 3600e3;
  return `+${String(h).padStart(2, '0')}:00`;
};

/** A pretend Google Calendar: its events, and every call made to it. */
function fakeGoogle() {
  const events = new Map();
  const calls = [];
  let n = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, url: u, body: init.body });
    if (u.host === 'oauth2.googleapis.com') return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    if (u.pathname === '/calendar/v3/calendars/primary') return json({ id: 'nina@gmail.com' });
    const id = decodeURIComponent(u.pathname.split('/events/')[1] || '');
    if (method === 'GET') return json({ items: [...events.values()] });
    if (method === 'POST') {
      const e = { id: `ev${++n}`, ...JSON.parse(init.body) };
      events.set(e.id, e);
      return json(e);
    }
    if (method === 'PATCH') {
      events.set(id, { ...events.get(id), ...JSON.parse(init.body) });
      return json(events.get(id));
    }
    if (method === 'DELETE') {
      events.delete(id);
      return json(null, 204);
    }
    return json({}, 404);
  };
  return { events, calls, fetch };
}

async function connect(t, provider) {
  const r1 = await fetch(`${t.base}calendars/${provider}/connect?tz=${encodeURIComponent(TZ)}`, { headers: { cookie: t.cookie() }, redirect: 'manual' });
  assert.equal(r1.status, 302);
  const go = new URL(r1.headers.get('location'));
  const r2 = await fetch(`${t.base}calendars/${provider}/callback?code=c&state=${go.searchParams.get('state')}`, { headers: { cookie: t.cookie() }, redirect: 'manual' });
  return { go, back: r2.headers.get('location') };
}

const notes = (t) => t.store.changesSince(t.user.id, 0);
const N1 = crypto.randomUUID();

test('time zones: wall times and back, across summer and winter time', () => {
  assert.equal(wallTime(Date.parse('2026-07-01T08:00:00Z'), TZ), '2026-07-01T10:00');
  assert.equal(wallTime(Date.parse('2026-12-01T08:00:00Z'), TZ), '2026-12-01T09:00');
  assert.equal(new Date(utcOf('2026-07-01T10:00', TZ)).toISOString(), '2026-07-01T08:00:00.000Z');
  assert.equal(new Date(utcOf('2026-12-01T09:00', 'America/New_York')).toISOString(), '2026-12-01T14:00:00.000Z');
});

test('the secrets are encrypted, and only the right key opens them', () => {
  const box = sealer(KEY);
  const sealed = box.seal({ access: 'secret-token' });
  assert.ok(!sealed.includes('secret-token'));
  assert.deepEqual(box.open(sealed), { access: 'secret-token' });
  assert.throws(() => sealer(crypto.randomBytes(32).toString('hex')).open(sealed));
  assert.equal(sealer('short'), null, 'no key, no calendars');
});

test('nothing to connect until the key and the service keys are set', async () => {
  const t = await start({ calendars: { env: {} } });
  try {
    assert.deepEqual((await t.api('calendars')).body, { available: [], links: [] });
    const r = await fetch(`${t.base}calendars/google/connect`, { headers: { cookie: t.cookie() }, redirect: 'manual' });
    assert.equal(r.status, 404);
  } finally {
    t.close();
  }
});

test('Google both ways: meetings come in, dated notes go out, moves and deletions follow', async () => {
  const g = fakeGoogle();
  const day = tomorrow();
  g.events.set('meet', { id: 'meet', summary: 'Team meeting', location: 'Room 2', start: { dateTime: `${day}T10:00:00${offset(day)}` }, end: { dateTime: `${day}T11:00:00${offset(day)}` } });
  const t = await start({ calendars: { env: { CALENDAR_KEY: KEY, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs' }, fetch: g.fetch } });
  try {
    assert.deepEqual((await t.api('calendars')).body.available.map((p) => p.id), ['google', 'icloud']);
    const { go, back } = await connect(t, 'google');
    assert.equal(go.host, 'accounts.google.com');
    assert.equal(go.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar.events');
    assert.equal(go.searchParams.get('access_type'), 'offline');
    assert.equal(back, '/?calendar=google');
    const token = g.calls.find((c) => c.url.host === 'oauth2.googleapis.com');
    assert.equal(new URLSearchParams(token.body).get('client_secret'), 'cs');

    const [link] = (await t.api('calendars')).body.links;
    assert.equal(link.account, 'nina@gmail.com');
    assert.equal(link.writes, true, 'the first calendar receives the notes');
    assert.ok(!JSON.stringify(t.store.db.prepare('SELECT secret FROM calendar_links').get()).includes('rt'), 'tokens are not stored in the clear');

    // The meeting is a note, with its time and place.
    let meeting = notes(t).find((n) => n.source === 'google');
    assert.equal(meeting.title, 'Team meeting');
    assert.equal(meeting.text, 'Team meeting\n📍 Room 2');
    assert.equal(meeting.due_date, day);
    assert.equal(meeting.due_time, '10:00');
    assert.equal(meeting.ai_status, 'done', 'no AI call for a meeting');

    // A note with a date goes to the calendar, in the person's time zone.
    const now = Date.now();
    await t.api(`notes/${N1}`, { method: 'PUT', body: JSON.stringify({ text: 'Dentist', user_due: `${day}T15:00`, created_at: now, edited_at: now }) });
    await t.calendars.sync(link.id);
    const sent = [...g.events.values()].find((e) => e.summary === 'Dentist');
    assert.deepEqual(sent.start, { dateTime: `${day}T15:00:00`, timeZone: TZ });
    assert.deepEqual(sent.end, { dateTime: `${day}T16:00:00`, timeZone: TZ });
    await t.calendars.sync(link.id);
    assert.equal([...g.events.values()].filter((e) => e.summary === 'Dentist').length, 1, 'sent once');
    assert.equal(notes(t).filter((n) => !n.deleted).length, 2, 'the sent event does not come back as a second note');

    // Moved in Google: the note follows.
    g.events.get('meet').start = { dateTime: `${day}T11:30:00${offset(day)}` };
    await t.calendars.sync(link.id);
    meeting = t.store.get(meeting.id);
    assert.equal(meeting.due_time, '11:30');

    // Moved in record.ai: the event follows, keeping its length.
    await t.api(`notes/${N1}`, { method: 'PUT', body: JSON.stringify({ user_due: `${day}T17:00`, edited_at: now + 1000 }) });
    await t.calendars.sync(link.id);
    assert.deepEqual(g.events.get(sent.id).start, { dateTime: `${day}T17:00:00`, timeZone: TZ });

    // Deleted in record.ai: record.ai's event goes; deleting the meeting note leaves the meeting in Google.
    await t.api(`notes/${N1}`, { method: 'PUT', body: JSON.stringify({ deleted: true, edited_at: now + 2000 }) });
    await t.api(`notes/${meeting.id}`, { method: 'PUT', body: JSON.stringify({ deleted: true, edited_at: now + 2000 }) });
    await t.calendars.sync(link.id);
    assert.ok(!g.events.has(sent.id));
    assert.ok(g.events.has('meet'));
    await t.calendars.sync(link.id);
    assert.equal(notes(t).filter((n) => !n.deleted).length, 0, 'a deleted meeting note does not come back');

    // Cancelled in Google: the note goes.
    g.events.set('call', { id: 'call', summary: 'Call with school', start: { date: day }, end: { date: day } });
    await t.calendars.sync(link.id);
    const call = notes(t).find((n) => n.title === 'Call with school');
    assert.equal(call.due_date, day);
    assert.equal(call.due_time, null, 'a whole-day event has no time');
    g.events.delete('call');
    await t.calendars.sync(link.id);
    assert.equal(t.store.get(call.id).deleted, true);

    // Meetings from a calendar stay out of the calendar link (they are already in a calendar).
    g.events.set('lunch', { id: 'lunch', summary: 'Lunch', start: { date: day }, end: { date: day } });
    await t.calendars.sync(link.id);
    const feed = await t.api('calendar-link');
    const ics = await (await fetch(feed.body.url)).text();
    assert.ok(!ics.includes('Lunch'));

    // Disconnecting takes the meetings out of record.ai.
    assert.equal((await t.api(`calendars/${link.id}`, { method: 'DELETE' })).status, 200);
    assert.equal(notes(t).filter((n) => !n.deleted).length, 0);
    assert.deepEqual((await t.api('calendars')).body.links, []);
  } finally {
    t.close();
  }
});

test('an expired Google connection is renewed once, then asks to connect again', async () => {
  const g = fakeGoogle();
  let refreshes = 0;
  let reject = false;
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'oauth2.googleapis.com' && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') {
      refreshes++;
      return reject ? json({ error: 'invalid_grant' }, 400) : json({ access_token: 'new', expires_in: 3600 });
    }
    if (u.pathname.endsWith('/events') && init.headers?.Authorization === 'Bearer at') return json({}, 401);
    return g.fetch(url, init);
  };
  const t = await start({ calendars: { env: { CALENDAR_KEY: KEY, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs' }, fetch: fetchFn } });
  try {
    await connect(t, 'google');
    const [link] = (await t.api('calendars')).body.links;
    assert.equal(link.error, null);
    assert.equal(refreshes, 1);
    reject = true;
    t.store.db.prepare('UPDATE calendar_links SET secret = ?').run(sealer(KEY).seal({ access: 'at', refresh: 'rt', expires: 0 }));
    await t.calendars.sync(link.id);
    const after = (await t.api('calendars')).body.links[0];
    assert.equal(after.reconnect, true);
    assert.match(after.error, /connect again/);
  } finally {
    t.close();
  }
});

test('Outlook gets times in the person\'s time zone, and whole days', () => {
  const calls = [];
  const api = async (method, url, opt) => {
    calls.push({ method, url, opt });
    return { id: 'x', value: [{ id: 'm1', subject: 'Board', start: { dateTime: '2026-11-05T09:00:00.0000000' }, end: { dateTime: '2026-11-05T10:30:00.0000000' }, location: { displayName: 'HQ' } }] };
  };
  return (async () => {
    const [e] = await PROVIDERS.microsoft.list(api, { from: 0, to: 864e5, tz: TZ });
    assert.equal(calls[0].opt.headers.Prefer, `outlook.timezone="${TZ}"`);
    assert.deepEqual(e, { id: 'm1', summary: 'Board', location: 'HQ', start: '2026-11-05T09:00', minutes: 90 });
    await PROVIDERS.microsoft.create(api, { summary: 'Trip', start: '2026-11-06', minutes: 1440 }, { tz: TZ });
    assert.deepEqual(calls[1].opt.json, { subject: 'Trip', isAllDay: true, start: { dateTime: '2026-11-06T00:00:00', timeZone: TZ }, end: { dateTime: '2026-11-07T00:00:00', timeZone: TZ } });
  })();
});

test('Calendly bookings come in with who booked; the webhook must be signed', async () => {
  const day = tomorrow();
  let booked = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'auth.calendly.com') return json({ access_token: 'at', refresh_token: 'rt', expires_in: 7200 });
    if (u.pathname === '/users/me') return json({ resource: { uri: 'https://api.calendly.com/users/U1', email: 'nina@example.com', current_organization: 'https://api.calendly.com/organizations/O1' } });
    if (u.pathname === '/webhook_subscriptions') return json({}, 403); // free plan
    if (u.pathname === '/scheduled_events') {
      assert.equal(u.searchParams.get('user'), 'https://api.calendly.com/users/U1');
      return json({ collection: booked });
    }
    if (u.pathname.endsWith('/invitees')) return json({ collection: [{ name: 'Anna Rossi' }] });
    return json({}, 404);
  };
  const env = { CALENDAR_KEY: KEY, CALENDLY_CLIENT_ID: 'cid', CALENDLY_CLIENT_SECRET: 'cs', CALENDLY_WEBHOOK_KEY: 'whkey', PUBLIC_URL: 'https://app.example' };
  const t = await start({ calendars: { env, fetch: fetchFn } });
  try {
    const { back } = await connect(t, 'calendly');
    assert.equal(back, '/?calendar=calendly', 'works without webhooks (free Calendly plan)');
    const [link] = (await t.api('calendars')).body.links;
    assert.equal(link.canWrite, false, 'Calendly only sends');
    assert.equal(link.writes, false);

    booked = [{ uri: 'https://api.calendly.com/scheduled_events/E1', name: '30 minute call', start_time: new Date(utcOf(`${day}T09:00`, TZ)).toISOString(), end_time: new Date(utcOf(`${day}T09:30`, TZ)).toISOString() }];
    const body = JSON.stringify({ event: 'invitee.created', created_by: 'https://api.calendly.com/users/U1', payload: {} });
    const post = (sig) => fetch(`${t.base}calendars/calendly/webhook`, { method: 'POST', headers: { 'calendly-webhook-signature': sig }, body });
    assert.equal((await post('t=1,v1=bad')).status, 400);
    const ts = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', 'whkey').update(`${ts}.${body}`).digest('hex');
    assert.equal((await post(`t=${ts},v1=${v1}`)).status, 200);
    await t.calendars.sync(link.id); // waits for the sync the webhook started
    const note = notes(t).find((n) => n.source === 'calendly');
    assert.equal(note.title, '30 minute call with Anna Rossi');
    assert.equal(note.due_time, '09:00');
  } finally {
    t.close();
  }
});

test('iCloud: an app-specific password, calendars found, events read and written', async () => {
  const day = tomorrow();
  const compact = day.replaceAll('-', '');
  const puts = [];
  const ms = (xml) => `<?xml version="1.0"?><multistatus xmlns="DAV:">${xml}</multistatus>`;
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(init.headers.Authorization, `Basic ${Buffer.from('nina@icloud.com:abcd-efgh-ijkl-mnop').toString('base64')}`);
    if (init.method === 'PROPFIND' && u.pathname === '/') return new Response(ms('<response><href>/</href><propstat><prop><current-user-principal><href>/123/principal/</href></current-user-principal></prop></propstat></response>'), { status: 207 });
    if (init.method === 'PROPFIND' && u.pathname === '/123/principal/') return new Response(ms('<response><href>/123/principal/</href><propstat><prop><C:calendar-home-set xmlns:C="urn:ietf:params:xml:ns:caldav"><href>https://p01-caldav.icloud.com/123/calendars/</href></C:calendar-home-set></prop></propstat></response>'), { status: 207 });
    if (init.method === 'PROPFIND') {
      return new Response(ms(`<response><href>/123/calendars/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>
        <response><href>/123/calendars/home/</href><propstat><prop><resourcetype><collection/><C:calendar xmlns:C="urn:ietf:params:xml:ns:caldav"/></resourcetype><displayname>Home</displayname><C:supported-calendar-component-set xmlns:C="urn:ietf:params:xml:ns:caldav"><C:comp name="VEVENT"/></C:supported-calendar-component-set></prop></propstat></response>
        <response><href>/123/calendars/tasks/</href><propstat><prop><resourcetype><collection/><C:calendar xmlns:C="urn:ietf:params:xml:ns:caldav"/></resourcetype><C:supported-calendar-component-set xmlns:C="urn:ietf:params:xml:ns:caldav"><C:comp name="VTODO"/></C:supported-calendar-component-set></prop></propstat></response>`), { status: 207 });
    }
    if (init.method === 'REPORT') {
      assert.equal(u.href, 'https://p01-caldav.icloud.com/123/calendars/home/');
      const ics = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:abc\r\nSUMMARY:Swimming &amp; lunch\r\nDTSTART;TZID=Europe/Rome:${compact}T160000\r\nDTEND;TZID=Europe/Rome:${compact}T170000\r\nEND:VEVENT\r\nEND:VCALENDAR`;
      return new Response(ms(`<response><href>/123/calendars/home/abc.ics</href><propstat><prop><C:calendar-data xmlns:C="urn:ietf:params:xml:ns:caldav">${ics}</C:calendar-data></prop></propstat></response>`), { status: 207 });
    }
    if (init.method === 'PUT') {
      puts.push({ url: u.href, body: init.body });
      return new Response(null, { status: 201 });
    }
    return new Response(null, { status: 404 });
  };
  const t = await start({ calendars: { env: { CALENDAR_KEY: KEY }, fetch: fetchFn } });
  try {
    const now = Date.now();
    await t.api(`notes/${N1}`, { method: 'PUT', body: JSON.stringify({ text: 'Pay school trip', user_due: day, created_at: now, edited_at: now }) });
    const bad = await t.api('calendars/icloud', { method: 'POST', body: JSON.stringify({ email: 'nina@icloud.com', password: 'my real password' }) });
    assert.equal(bad.status, 400, 'only an app-specific password is accepted');
    const r = await t.api('calendars/icloud', { method: 'POST', body: JSON.stringify({ email: 'nina@icloud.com', password: 'abcdefghijklmnop', tz: TZ }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.link.account, 'nina@icloud.com');
    const swim = notes(t).find((n) => n.source === 'icloud');
    assert.equal(swim.title, 'Swimming & lunch');
    assert.equal(swim.due_time, '16:00');
    assert.equal(puts.length, 1);
    assert.match(puts[0].url, /^https:\/\/p01-caldav\.icloud\.com\/123\/calendars\/home\/.+\.ics$/);
    assert.match(puts[0].body, new RegExp(`DTSTART;VALUE=DATE:${compact}`));
    assert.match(puts[0].body, /SUMMARY:Pay school trip/);
  } finally {
    t.close();
  }
});

test('iCalendar times: UTC, a named zone, a whole day, and folded lines', () => {
  const [a, b, c] = parseIcs([
    'BEGIN:VEVENT', 'SUMMARY:A', 'DTSTART:20260701T080000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:B long', ' er title', 'DTSTART;TZID=America/New_York:20260701T090000', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:C', 'DTSTART;VALUE=DATE:20260702', 'END:VEVENT',
  ].join('\r\n'), TZ);
  assert.equal(a.start, '2026-07-01T10:00');
  assert.equal(b.summary, 'B longer title');
  assert.equal(b.start, '2026-07-01T15:00');
  assert.equal(c.start, '2026-07-02');
});

test('deleting the account removes its calendar connections', async () => {
  const g = fakeGoogle();
  const t = await start({ calendars: { env: { CALENDAR_KEY: KEY, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs' }, fetch: g.fetch } });
  try {
    await connect(t, 'google');
    assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM calendar_links').get().n, 1);
    t.store.deleteUser(t.user.id);
    assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM calendar_links').get().n, 0);
  } finally {
    t.close();
  }
});
