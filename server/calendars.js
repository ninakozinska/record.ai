// Calendars both ways: Google Calendar, Outlook / Microsoft 365, Calendly and
// iCloud. Setup steps for each service: docs/CALENDARS.md.
//
// Every connected calendar is synced every few minutes, and soon after a note
// with a date changes:
// - meetings in the next 30 days come in as notes (source = the provider), and
//   follow the calendar when they move or are cancelled;
// - notes with a date go out as events to the one calendar chosen for writing,
//   and follow the note when it changes or is deleted;
// - moving either side moves the other. When both changed, the calendar wins.
// The tokens (or the iCloud app password) are kept encrypted with CALENDAR_KEY.
import crypto from 'node:crypto';
import express from 'express';

const DAY = 864e5;
const PAST = DAY;
const AHEAD = 30 * DAY;
const SYNC_EVERY = 10 * 60e3;
const CALENDLY_EVERY = 15 * 60e3;
const STATE_TTL = 10 * 60e3;

export class CalendarError extends Error {
  constructor(message, { status = 0, reconnect = false } = {}) {
    super(message);
    this.status = status;
    this.reconnect = reconnect;
  }
}

// --- time zones ---------------------------------------------------------------

/** The wall-clock time in `tz` at `ms`: 'YYYY-MM-DDTHH:MM'. */
export function wallTime(ms, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** The moment a wall-clock time in `tz` happens, in ms. */
export function utcOf(wall, tz) {
  const asUtc = (w) => Date.UTC(+w.slice(0, 4), +w.slice(5, 7) - 1, +w.slice(8, 10), +w.slice(11, 13) || 0, +w.slice(14, 16) || 0);
  const target = asUtc(wall);
  let ms = target;
  for (let i = 0; i < 2; i++) ms += target - asUtc(wallTime(ms, tz));
  return ms;
}

/** 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM', `minutes` later (whole days for a date). */
function later(start, minutes) {
  const t = new Date(Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10), +start.slice(11, 13) || 0, +start.slice(14, 16) || 0) + minutes * 60e3).toISOString();
  return start.length === 10 ? t.slice(0, 10) : t.slice(0, 16);
}
const minutesBetween = (a, b) => Math.max(1, Math.round((Date.parse(b.length === 10 ? b : b + 'Z') - Date.parse(a.length === 10 ? a : a + 'Z')) / 60e3));

// --- the secrets --------------------------------------------------------------

export function sealer(keyHex) {
  if (!/^[0-9a-f]{64}$/i.test(keyHex || '')) return null;
  const key = Buffer.from(keyHex, 'hex');
  return {
    seal(value) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
      return [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
    },
    open(text) {
      const [iv, tag, data] = String(text).split('.').map((s) => Buffer.from(s, 'base64url'));
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString());
    },
  };
}

// --- iCalendar (for iCloud) ---------------------------------------------------

const icsEscape = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsUnescape = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const xmlUnescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#13;/g, '\r').replace(/&amp;/g, '&');

/** A date-time property of an event, read as wall time in `tz` ('YYYY-MM-DD' for a whole day). */
function icsTime(line, tz) {
  const [head, value] = [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()];
  const wall = (v) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}`;
  if (/VALUE=DATE(?!-)/.test(head) || /^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (value.endsWith('Z')) return wallTime(Date.parse(wall(value) + 'Z'), tz);
  const zone = head.match(/TZID=([^;:]+)/)?.[1]?.replace(/^"|"$/g, '');
  if (zone) {
    try {
      return wallTime(utcOf(wall(value), zone), tz);
    } catch { /* an unknown zone name: read it as local time */ }
  }
  return wall(value);
}

/** The events in an iCalendar text. */
export function parseIcs(text, tz) {
  const lines = String(text).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') ev = {};
    else if (line === 'END:VEVENT' && ev) {
      events.push(ev);
      ev = null;
    } else if (ev) {
      const name = line.split(/[;:]/, 1)[0].toUpperCase();
      const value = line.slice(line.indexOf(':') + 1);
      if (name === 'UID') ev.uid = value;
      else if (name === 'SUMMARY') ev.summary = icsUnescape(value);
      else if (name === 'LOCATION') ev.location = icsUnescape(value);
      else if (name === 'STATUS') ev.status = value.toUpperCase();
      else if (name === 'DTSTART') ev.start = icsTime(line, tz);
      else if (name === 'DTEND') ev.end = icsTime(line, tz);
      else if (name === 'RECURRENCE-ID') ev.recurrence = value;
      else if (name === 'DURATION') {
        const m = value.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/);
        if (m) ev.duration = (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0);
      }
    }
  }
  return events.filter((e) => e.start);
}

function icsEvent({ uid, summary, start, minutes }, tz) {
  const utc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const times = start.length === 10
    ? [`DTSTART;VALUE=DATE:${start.replaceAll('-', '')}`, `DTEND;VALUE=DATE:${later(start, Math.max(1440, minutes)).replaceAll('-', '')}`]
    : [`DTSTART:${utc(utcOf(start, tz))}`, `DTEND:${utc(utcOf(start, tz) + minutes * 60e3)}`];
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//record.ai//EN', 'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${utc(Date.now())}`,
    ...times, `SUMMARY:${icsEscape(summary)}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}

/** Each <response> of a WebDAV answer: its href and properties, whatever the namespace prefixes. */
function davResponses(xml) {
  const tag = (name) => new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i');
  return [...String(xml).matchAll(/<(?:[\w-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)].map((m) => {
    const body = m[1];
    const inner = (name) => body.match(tag(name))?.[1];
    return {
      href: xmlUnescape(inner('href')?.trim() || ''),
      inner,
      has: (name) => new RegExp(`<(?:[\\w-]+:)?${name}[\\s/>]`, 'i').test(body),
    };
  });
}
const hrefIn = (xml) => xmlUnescape(String(xml || '').match(/<(?:[\w-]+:)?href(?:\s[^>]*)?>([\s\S]*?)<\//i)?.[1]?.trim() || '');

// --- the services -------------------------------------------------------------

const GOOGLE_API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const CALENDLY = 'https://api.calendly.com';
const ICLOUD = 'https://caldav.icloud.com/';

const googleBody = ({ summary, start, minutes }, tz) => (start.length === 10
  ? { summary, start: { date: start }, end: { date: later(start, Math.max(1440, minutes)) } }
  : { summary, start: { dateTime: `${start}:00`, timeZone: tz }, end: { dateTime: `${later(start, minutes)}:00`, timeZone: tz } });

const graphBody = ({ summary, start, minutes }, tz) => (start.length === 10
  ? { subject: summary, isAllDay: true, start: { dateTime: `${start}T00:00:00`, timeZone: tz }, end: { dateTime: `${later(start, Math.max(1440, minutes))}T00:00:00`, timeZone: tz } }
  : { subject: summary, isAllDay: false, start: { dateTime: `${start}:00`, timeZone: tz }, end: { dateTime: `${later(start, minutes)}:00`, timeZone: tz } });

export const PROVIDERS = {
  google: {
    name: 'Google Calendar',
    keys: 'GOOGLE',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    writes: true,
    async account(api) {
      return (await api('GET', 'https://www.googleapis.com/calendar/v3/calendars/primary')).id || '';
    },
    async list(api, { from, to, tz }) {
      const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: '250', timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString() });
      const items = (await api('GET', `${GOOGLE_API}?${q}`)).items || [];
      return items.filter((e) => e.status !== 'cancelled' && e.start).map((e) => {
        const start = e.start.date || wallTime(Date.parse(e.start.dateTime), tz);
        const end = e.end?.date || (e.end?.dateTime ? wallTime(Date.parse(e.end.dateTime), tz) : later(start, 60));
        return { id: e.id, summary: e.summary || '', location: e.location || '', start, minutes: minutesBetween(start, end) };
      });
    },
    async create(api, ev, { tz }) {
      return (await api('POST', GOOGLE_API, { json: googleBody(ev, tz) })).id;
    },
    async update(api, id, ev, { tz }) {
      await api('PATCH', `${GOOGLE_API}/${encodeURIComponent(id)}`, { json: googleBody(ev, tz) });
    },
    async remove(api, id) {
      await api('DELETE', `${GOOGLE_API}/${encodeURIComponent(id)}`, { gone: true });
    },
  },

  microsoft: {
    name: 'Outlook',
    keys: 'MICROSOFT',
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'offline_access User.Read Calendars.ReadWrite',
    extra: { prompt: 'select_account' },
    writes: true,
    async account(api) {
      const me = await api('GET', `${GRAPH}/me`);
      return me.mail || me.userPrincipalName || '';
    },
    async list(api, { from, to, tz }) {
      const q = new URLSearchParams({ startDateTime: new Date(from).toISOString(), endDateTime: new Date(to).toISOString(), $top: '250', $select: 'id,subject,start,end,isAllDay,isCancelled,location' });
      // Times come back as wall time in the person's own time zone.
      const items = (await api('GET', `${GRAPH}/me/calendarView?${q}`, { headers: { Prefer: `outlook.timezone="${tz}"` } })).value || [];
      return items.filter((e) => !e.isCancelled && e.start?.dateTime).map((e) => {
        const start = e.isAllDay ? e.start.dateTime.slice(0, 10) : e.start.dateTime.slice(0, 16);
        const end = e.isAllDay ? e.end.dateTime.slice(0, 10) : e.end.dateTime.slice(0, 16);
        return { id: e.id, summary: e.subject || '', location: e.location?.displayName || '', start, minutes: minutesBetween(start, end) };
      });
    },
    async create(api, ev, { tz }) {
      return (await api('POST', `${GRAPH}/me/events`, { json: graphBody(ev, tz) })).id;
    },
    async update(api, id, ev, { tz }) {
      await api('PATCH', `${GRAPH}/me/events/${encodeURIComponent(id)}`, { json: graphBody(ev, tz) });
    },
    async remove(api, id) {
      await api('DELETE', `${GRAPH}/me/events/${encodeURIComponent(id)}`, { gone: true });
    },
  },

  // Calendly only sends: bookings come in, nothing is written back.
  calendly: {
    name: 'Calendly',
    keys: 'CALENDLY',
    authorize: 'https://auth.calendly.com/oauth/authorize',
    token: 'https://auth.calendly.com/oauth/token',
    scope: '',
    extra: {},
    writes: false,
    every: CALENDLY_EVERY,
    async account(api, link) {
      const me = (await api('GET', `${CALENDLY}/users/me`)).resource || {};
      link.state.userUri = me.uri;
      link.state.orgUri = me.current_organization;
      return me.email || '';
    },
    async list(api, { from, to, tz, link }) {
      const q = new URLSearchParams({ user: link.state.userUri || '', status: 'active', count: '100', min_start_time: new Date(from).toISOString(), max_start_time: new Date(to).toISOString() });
      const events = (await api('GET', `${CALENDLY}/scheduled_events?${q}`)).collection || [];
      const out = [];
      for (const e of events) {
        // Who booked it, for the title: "30 minute call with Anna".
        const known = link.state.invitees?.[e.uri];
        let who = known;
        if (known === undefined) {
          try {
            who = (await api('GET', `${e.uri}/invitees?count=1`)).collection?.[0]?.name || '';
          } catch {
            who = '';
          }
        }
        (link.state.invitees ||= {})[e.uri] = who;
        const start = wallTime(Date.parse(e.start_time), tz);
        out.push({ id: e.uri, summary: who ? `${e.name} with ${who}` : e.name || 'Calendly', location: e.location?.location || '', start, minutes: minutesBetween(start, wallTime(Date.parse(e.end_time), tz)) });
      }
      return out;
    },
  },

  // iCloud has no sign-in for apps: each person makes an app-specific password.
  icloud: {
    name: 'iCloud',
    writes: true,
    async discover(api, link) {
      const props = (p) => `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${p}</d:prop></d:propfind>`;
      const principal = hrefIn((await api('PROPFIND', ICLOUD, { xml: props('<d:current-user-principal/>'), depth: '0' })).match(/current-user-principal[\s\S]*?<\/(?:[\w-]+:)?current-user-principal>/i)?.[0]);
      if (!principal) throw new CalendarError('iCloud did not accept this Apple ID and app-specific password.', { reconnect: true });
      const principalUrl = new URL(principal, ICLOUD).href;
      const homeXml = await api('PROPFIND', principalUrl, { xml: props('<c:calendar-home-set/>'), depth: '0' });
      const home = new URL(hrefIn(homeXml.match(/calendar-home-set[\s\S]*?<\/(?:[\w-]+:)?calendar-home-set>/i)?.[0]), principalUrl).href;
      const list = await api('PROPFIND', home, { xml: props('<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/>'), depth: '1' });
      const calendars = davResponses(list)
        .filter((r) => r.has('calendar') && /VEVENT/.test(r.inner('supported-calendar-component-set') || 'VEVENT'))
        .map((r) => new URL(r.href, home).href);
      if (!calendars.length) throw new CalendarError('No calendar was found in this iCloud account.');
      link.state.calendars = calendars;
      link.state.writeUrl = calendars[0];
    },
    async account(api, link) {
      await this.discover(api, link);
      return link.state.email || '';
    },
    async list(api, { from, to, tz, link }) {
      if (!link.state.calendars) await this.discover(api, link);
      const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      const range = `start="${stamp(from)}" end="${stamp(to)}"`;
      const query = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data><c:expand ${range}/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range ${range}/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
      const out = [];
      for (const url of link.state.calendars) {
        for (const r of davResponses(await api('REPORT', url, { xml: query, depth: '1' }))) {
          const href = new URL(r.href, url).href;
          for (const e of parseIcs(xmlUnescape(r.inner('calendar-data') || ''), tz)) {
            if (e.status === 'CANCELLED') continue;
            const end = e.end || (e.duration ? later(e.start, e.duration) : later(e.start, e.start.length === 10 ? 1440 : 60));
            // A repeating event's single days can't be changed from here: they keep the # in their id.
            out.push({ id: e.recurrence ? `${href}#${e.recurrence}` : href, summary: e.summary || '', location: e.location || '', start: e.start, minutes: minutesBetween(e.start, end) });
          }
        }
      }
      return out;
    },
    async create(api, ev, { tz, link }) {
      if (!link.state.writeUrl) await this.discover(api, link);
      const uid = `${crypto.randomUUID()}@record.ai`;
      const url = new URL(`${encodeURIComponent(uid)}.ics`, link.state.writeUrl).href;
      await api('PUT', url, { body: icsEvent({ uid, ...ev }, tz), type: 'text/calendar; charset=utf-8', headers: { 'If-None-Match': '*' } });
      return url;
    },
    async update(api, id, ev, { tz }) {
      if (id.includes('#')) return;
      const current = await api('GET', id, { text: true });
      const uid = String(current).replace(/\r?\n[ \t]/g, '').match(/^UID:(.+)$/m)?.[1]?.trim() || `${crypto.randomUUID()}@record.ai`;
      await api('PUT', id, { body: icsEvent({ uid, ...ev }, tz), type: 'text/calendar; charset=utf-8' });
    },
    async remove(api, id) {
      if (id.includes('#')) return;
      await api('DELETE', id, { gone: true });
    },
  },
};

const OAUTH = ['google', 'microsoft', 'calendly'];

// --- syncing ------------------------------------------------------------------

const dueOf = (n) => (n.due_date ? (n.due_time ? `${n.due_date}T${n.due_time}` : n.due_date) : null);
const titleOf = (n) => n.title || n.text.split('\n').find((l) => l.trim())?.trim().slice(0, 120) || 'Note';
const noteSig = (n) => `${titleOf(n)}|${dueOf(n) || ''}`;
const eventSig = (e) => `${e.summary}|${e.start}`;
const textOf = (e) => (e.location ? `${e.summary}\n📍 ${e.location}` : e.summary);

export class Calendars {
  /**
   * `fetch` is replaceable for tests; `onChange` tells devices about a note that
   * changed. `env` holds the keys (process.env by default).
   */
  constructor({ store, onChange, env = process.env, fetch: fetchFn = globalThis.fetch, now = () => Date.now() }) {
    this.store = store;
    this.db = store.db;
    this.onChange = onChange;
    this.env = env;
    this.fetch = fetchFn;
    this.now = now;
    this.sealer = sealer(env.CALENDAR_KEY);
    this.pending = new Map();
    this.running = new Map();
    this.soon = new Map();
  }

  /** Services that can be connected on this server. */
  available() {
    if (!this.sealer) return [];
    return Object.entries(PROVIDERS)
      .filter(([id, p]) => !p.keys || (this.env[`${p.keys}_CLIENT_ID`] && this.env[`${p.keys}_CLIENT_SECRET`]))
      .map(([id, p]) => ({ id, name: p.name, writes: p.writes }));
  }

  links(userId) {
    return this.db.prepare('SELECT * FROM calendar_links WHERE user_id = ? ORDER BY created_at').all(userId).map((r) => this.row(r));
  }

  link(id) {
    return this.row(this.db.prepare('SELECT * FROM calendar_links WHERE id = ?').get(id));
  }

  row(r) {
    return r ? { ...r, writes: !!r.writes, state: JSON.parse(r.state || '{}') } : null;
  }

  /** What the app shows: never the secrets. */
  view(link) {
    return {
      id: link.id, provider: link.provider, name: PROVIDERS[link.provider]?.name || link.provider, account: link.account,
      writes: link.writes, canWrite: !!PROVIDERS[link.provider]?.writes, last_sync: link.last_sync || null,
      error: link.last_error || null, reconnect: /^reconnect:/.test(link.last_error || ''),
    };
  }

  tzOf(userId) {
    const tz = this.store.getMeta(`cal_tz:${userId}`);
    try {
      if (tz) new Intl.DateTimeFormat('en', { timeZone: tz });
      return tz || 'UTC';
    } catch {
      return 'UTC';
    }
  }

  saveState(link) {
    this.db.prepare('UPDATE calendar_links SET state = ?, account = ? WHERE id = ?').run(JSON.stringify(link.state), link.account || '', link.id);
  }

  /** A function that talks to the service as this link, renewing the sign-in once when needed. */
  api(link) {
    const p = PROVIDERS[link.provider];
    let secret = this.sealer.open(link.secret);
    const call = async (method, url, opt = {}, retried = false) => {
      if (p.keys && secret.expires && secret.expires < this.now() + 60e3) secret = await this.refresh(link, secret);
      const headers = { ...(opt.headers || {}) };
      if (p.keys) headers.Authorization = `Bearer ${secret.access}`;
      else headers.Authorization = `Basic ${Buffer.from(`${secret.user}:${secret.password}`).toString('base64')}`;
      let body;
      if (opt.json) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(opt.json);
      } else if (opt.xml) {
        headers['Content-Type'] = 'application/xml; charset=utf-8';
        headers.Depth = opt.depth ?? '0';
        body = opt.xml;
      } else if (opt.body != null) {
        headers['Content-Type'] = opt.type || 'text/plain';
        body = opt.body;
      }
      const res = await this.fetch(url, { method, headers, body, redirect: 'follow' });
      if (res.status === 401 && p.keys && !retried && secret.refresh) {
        secret = await this.refresh(link, secret);
        return call(method, url, opt, true);
      }
      if (res.status === 401 || res.status === 403) {
        throw new CalendarError(`${p.name} no longer accepts this connection. Please connect it again.`, { status: res.status, reconnect: res.status === 401 });
      }
      if (opt.gone && (res.status === 404 || res.status === 410)) return null;
      if (!res.ok && res.status !== 207) throw new CalendarError(`${p.name} answered ${res.status}.`, { status: res.status });
      if (opt.xml || opt.text) return res.text();
      if (res.status === 204) return {};
      const type = res.headers.get?.('content-type') || '';
      return type.includes('json') ? res.json() : res.text();
    };
    return call;
  }

  async tokenRequest(provider, params) {
    const p = PROVIDERS[provider];
    const res = await this.fetch(p.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: this.env[`${p.keys}_CLIENT_ID`],
        client_secret: this.env[`${p.keys}_CLIENT_SECRET`],
        ...params,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new CalendarError(data.error === 'invalid_grant'
        ? `${p.name} needs you to connect again.` : `${p.name} refused the connection (${data.error || res.status}).`, { reconnect: data.error === 'invalid_grant' });
    }
    return data;
  }

  async refresh(link, secret) {
    if (!secret.refresh) throw new CalendarError(`${PROVIDERS[link.provider].name} needs you to connect again.`, { reconnect: true });
    const data = await this.tokenRequest(link.provider, {
      grant_type: 'refresh_token',
      refresh_token: secret.refresh,
      ...(link.provider === 'microsoft' ? { scope: PROVIDERS.microsoft.scope } : {}),
    });
    const next = { access: data.access_token, refresh: data.refresh_token || secret.refresh, expires: this.now() + (Number(data.expires_in) || 3600) * 1000 };
    link.secret = this.sealer.seal(next);
    this.db.prepare('UPDATE calendar_links SET secret = ? WHERE id = ?').run(link.secret, link.id);
    return next;
  }

  /** Saves a new connection, makes it the writing calendar if there is none yet, and syncs it. */
  async addLink(userId, provider, secret, state = {}) {
    const p = PROVIDERS[provider];
    const link = { id: crypto.randomUUID(), user_id: userId, provider, account: '', secret: this.sealer.seal(secret), state, writes: false, last_sync: 0, last_error: null };
    link.account = await p.account(this.api(link), link);
    const same = this.links(userId).find((l) => l.provider === provider && l.account && l.account === link.account);
    if (same) {
      // Connected again (e.g. after "Connect again"): keep the link, renew its secret.
      this.db.prepare('UPDATE calendar_links SET secret = ?, state = ?, last_error = NULL WHERE id = ?').run(link.secret, JSON.stringify({ ...same.state, ...link.state }), same.id);
      return this.sync(same.id).then(() => this.link(same.id));
    }
    const writes = p.writes && !this.links(userId).some((l) => l.writes) ? 1 : 0;
    this.db.prepare(
      'INSERT INTO calendar_links (id, user_id, provider, account, secret, state, writes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(link.id, userId, provider, link.account, link.secret, JSON.stringify(link.state), writes, this.now());
    if (provider === 'calendly') await this.subscribeCalendly(this.link(link.id)).catch(() => {});
    await this.sync(link.id);
    return this.link(link.id);
  }

  /** Calendly tells us about new and cancelled bookings (paid Calendly plans). */
  async subscribeCalendly(link) {
    const base = (this.env.PUBLIC_URL || '').replace(/\/$/, '');
    if (!base || !link.state.userUri) return;
    await this.api(link)('POST', `${CALENDLY}/webhook_subscriptions`, {
      json: {
        url: `${base}/api/calendars/calendly/webhook`, events: ['invitee.created', 'invitee.canceled'],
        organization: link.state.orgUri, user: link.state.userUri, scope: 'user',
        ...(this.env.CALENDLY_WEBHOOK_KEY ? { signing_key: this.env.CALENDLY_WEBHOOK_KEY } : {}),
      },
    });
  }

  /** Only one calendar receives the notes with a date. */
  setWrites(userId, linkId) {
    const link = this.link(linkId);
    if (!link || link.user_id !== userId || !PROVIDERS[link.provider].writes) return false;
    this.db.prepare('UPDATE calendar_links SET writes = (id = ?) WHERE user_id = ?').run(linkId, userId);
    this.syncSoon(userId);
    return true;
  }

  /** Disconnects: the meetings it brought in leave record.ai; events record.ai made stay in the calendar. */
  remove(userId, linkId) {
    const link = this.link(linkId);
    if (!link || link.user_id !== userId) return false;
    for (const m of this.db.prepare("SELECT note_id FROM calendar_events WHERE link_id = ? AND origin = 'calendar'").all(linkId)) {
      const n = this.store.get(m.note_id);
      if (n && !n.deleted) this.markDeleted(n);
    }
    this.db.prepare('DELETE FROM calendar_events WHERE link_id = ?').run(linkId);
    this.db.prepare('DELETE FROM calendar_links WHERE id = ?').run(linkId);
    if (link.writes) {
      const next = this.links(userId).find((l) => PROVIDERS[l.provider].writes);
      if (next) this.db.prepare('UPDATE calendar_links SET writes = 1 WHERE id = ?').run(next.id);
    }
    return true;
  }

  // Notes changed here are sent to devices like any other change.
  writeNote(id, fields) {
    const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    this.db.prepare(`UPDATE notes SET ${sets}, edited_at = ?, rev = ? WHERE id = ?`).run(...Object.values(fields), this.now(), this.store.nextRev(), id);
    const note = this.store.get(id);
    this.onChange?.(note);
    return note;
  }

  markDeleted(note) {
    return this.writeNote(note.id, { deleted: 1 });
  }

  newNote(link, e) {
    const id = crypto.randomUUID();
    const now = this.now();
    this.db.prepare(
      `INSERT INTO notes (id, user_id, text, images, done, deleted, created_at, edited_at, user_due, title, ai_group, ai_priority,
         ai_status, source, rev)
       VALUES (?, ?, ?, '[]', 0, 0, ?, ?, ?, ?, 'Calendar', 'normal', 'done', ?, ?)`,
    ).run(id, link.user_id, textOf(e), now, now, e.start, e.summary || 'Meeting', link.provider, this.store.nextRev());
    const note = this.store.get(id);
    this.onChange?.(note);
    return note;
  }

  /** A note changed (in the app or by the AI): sync its owner's calendars shortly. */
  noteChanged(note) {
    if (!note || note.parent_id || !this.sealer) return;
    const mapped = this.db.prepare('SELECT 1 FROM calendar_events WHERE note_id = ? LIMIT 1').get(note.id);
    if (!mapped && !note.due_date) return;
    if (!this.db.prepare('SELECT 1 FROM calendar_links WHERE user_id = ? LIMIT 1').get(note.user_id)) return;
    this.syncSoon(note.user_id);
  }

  syncSoon(userId, delay = 3000) {
    clearTimeout(this.soon.get(userId));
    const t = setTimeout(() => {
      this.soon.delete(userId);
      for (const l of this.links(userId)) this.sync(l.id).catch(() => {});
    }, delay);
    t.unref?.();
    this.soon.set(userId, t);
  }

  /** Syncs one link; one sync per link at a time. */
  sync(linkId) {
    if (this.running.has(linkId)) return this.running.get(linkId);
    const run = this.syncNow(linkId).finally(() => this.running.delete(linkId));
    this.running.set(linkId, run);
    return run;
  }

  async syncNow(linkId) {
    const link = this.link(linkId);
    if (!link) return null;
    const p = PROVIDERS[link.provider];
    const tz = this.tzOf(link.user_id);
    const now = this.now();
    const from = now - PAST;
    const to = now + AHEAD;
    const inWindow = (due) => due && due >= wallTime(from, tz).slice(0, due.length) && due <= wallTime(to, tz).slice(0, due.length);
    const ctx = { tz, link, from, to };
    const api = this.api(link);
    const counts = { added: 0, updated: 0, removed: 0, sent: 0 };
    try {
      const events = await p.list(api, ctx);
      const byId = new Map(events.map((e) => [e.id, e]));
      const maps = this.db.prepare('SELECT * FROM calendar_events WHERE link_id = ?').all(linkId);
      const mapped = new Map(maps.map((m) => [m.external_id, m]));
      const keep = (m, note, e) => this.db.prepare('UPDATE calendar_events SET event_sig = ?, note_sig = ?, minutes = ? WHERE link_id = ? AND external_id = ?')
        .run(e ? eventSig(e) : m.event_sig, noteSig(note), e?.minutes ?? m.minutes, linkId, m.external_id);

      // 1. What the calendar has.
      for (const e of events) {
        const m = mapped.get(e.id);
        if (!m) {
          const note = this.newNote(link, e);
          this.db.prepare('INSERT INTO calendar_events (link_id, external_id, note_id, origin, event_sig, note_sig, minutes) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(linkId, e.id, note.id, 'calendar', eventSig(e), noteSig(note), e.minutes);
          counts.added++;
          continue;
        }
        const note = this.store.get(m.note_id);
        if (!note || note.deleted) {
          // Deleted in record.ai: an event record.ai made goes too; a meeting from the calendar stays there.
          if (m.origin === 'note' && p.remove && link.writes) {
            await p.remove(api, e.id, ctx);
            this.db.prepare('DELETE FROM calendar_events WHERE link_id = ? AND external_id = ?').run(linkId, e.id);
            counts.removed++;
          }
          continue;
        }
        if (eventSig(e) !== m.event_sig) {
          // Moved or renamed in the calendar: the calendar wins.
          const fields = m.origin === 'calendar' ? { text: textOf(e), title: e.summary || 'Meeting', user_due: e.start } : { user_due: e.start };
          keep(m, this.writeNote(note.id, fields), e);
          counts.updated++;
        } else if (noteSig(note) !== m.note_sig && p.update && dueOf(note)) {
          await p.update(api, e.id, { summary: titleOf(note), start: dueOf(note), minutes: m.minutes }, ctx);
          keep(m, note, { ...e, summary: titleOf(note), start: dueOf(note) });
          counts.sent++;
        }
      }

      // 2. What disappeared from the calendar (only judged inside the window).
      for (const m of maps) {
        if (byId.has(m.external_id) || m.event_sig === '(gone)') continue;
        const note = this.store.get(m.note_id);
        if (note && !note.deleted && !inWindow(dueOf(note)) && !inWindow(m.event_sig.split('|').pop())) continue;
        if (m.origin === 'calendar') {
          if (note && !note.deleted) this.markDeleted(note);
          this.db.prepare('DELETE FROM calendar_events WHERE link_id = ? AND external_id = ?').run(linkId, m.external_id);
          counts.removed++;
        } else {
          // Someone deleted record.ai's event in the calendar: the note stays, and isn't sent again.
          this.db.prepare("UPDATE calendar_events SET event_sig = '(gone)' WHERE link_id = ? AND external_id = ?").run(linkId, m.external_id);
        }
      }

      // 3. Notes with a date go to the writing calendar.
      if (link.writes && p.create) {
        const notes = this.db.prepare(
          `SELECT id FROM notes WHERE user_id = ? AND parent_id IS NULL AND deleted = 0 AND done = 0 AND source IS NULL
             AND ((user_due IS NOT NULL AND user_due != '') OR (user_due IS NULL AND due_date IS NOT NULL))
             AND id NOT IN (SELECT note_id FROM calendar_events)`,
        ).all(link.user_id);
        for (const { id } of notes) {
          const note = this.store.get(id);
          const due = dueOf(note);
          if (!inWindow(due)) continue;
          const ev = { summary: titleOf(note), start: due, minutes: due.length === 10 ? 1440 : 60 };
          const externalId = await p.create(api, ev, ctx);
          this.db.prepare('INSERT INTO calendar_events (link_id, external_id, note_id, origin, event_sig, note_sig, minutes) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(linkId, externalId, id, 'note', eventSig(ev), noteSig(note), ev.minutes);
          counts.sent++;
        }
      }
      this.saveState(link);
      this.db.prepare('UPDATE calendar_links SET last_sync = ?, last_error = NULL WHERE id = ?').run(this.now(), linkId);
      return counts;
    } catch (err) {
      const message = err instanceof CalendarError ? err.message : `Sync failed: ${err.message}`;
      this.db.prepare('UPDATE calendar_links SET last_sync = ?, last_error = ? WHERE id = ?').run(this.now(), (err.reconnect ? 'reconnect: ' : '') + message, linkId);
      if (!(err instanceof CalendarError)) console.error(`Calendar sync (${link.provider}) failed:`, err.message);
      return { error: message };
    }
  }

  /** Every minute, the links whose turn has come (every 10 minutes; Calendly every 15). */
  start() {
    if (!this.sealer) return;
    const tick = async () => {
      const due = this.db.prepare('SELECT id, provider, last_sync FROM calendar_links').all()
        .filter((l) => l.last_sync < this.now() - (PROVIDERS[l.provider]?.every || SYNC_EVERY));
      for (const l of due) await this.sync(l.id).catch(() => {});
    };
    this.timer = setInterval(tick, 60e3);
    this.timer.unref?.();
  }

  // --- routes -----------------------------------------------------------------

  /** Calendly's webhook: signed with the signing key; brings the booking in at once. */
  webhook() {
    return async (req, res) => {
      const raw = req.body.toString('utf8');
      const key = this.env.CALENDLY_WEBHOOK_KEY;
      if (key) {
        const sig = Object.fromEntries(String(req.get('calendly-webhook-signature') || '').split(',').map((kv) => kv.split('=')));
        const expected = crypto.createHmac('sha256', key).update(`${sig.t}.${raw}`).digest('hex');
        const ok = sig.v1 && sig.v1.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig.v1), Buffer.from(expected));
        if (!ok || Math.abs(this.now() / 1000 - Number(sig.t)) > 600) return res.status(400).json({ error: 'Bad signature' });
      }
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        return res.status(400).json({ error: 'Bad body' });
      }
      const users = new Set([body.created_by, ...(body.payload?.scheduled_event?.event_memberships || []).map((m) => m.user)].filter(Boolean));
      const links = this.db.prepare("SELECT id, state FROM calendar_links WHERE provider = 'calendly'").all()
        .filter((l) => users.has(JSON.parse(l.state).userUri));
      for (const l of links) this.sync(l.id).catch(() => {});
      res.json({ received: true });
    };
  }

  /** /api/calendars/... for a logged-in person. */
  routes() {
    const router = express.Router();
    const base = (req) => (this.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const setTz = (userId, tz) => {
      try {
        if (typeof tz === 'string' && tz) {
          new Intl.DateTimeFormat('en', { timeZone: tz });
          this.store.setMeta(`cal_tz:${userId}`, tz);
        }
      } catch { /* not a time zone */ }
    };

    router.get('/', (req, res) => {
      res.json({ available: this.available(), links: this.links(req.user.id).map((l) => this.view(l)) });
    });

    router.get('/:provider/connect', (req, res) => {
      const id = req.params.provider;
      if (!OAUTH.includes(id) || !this.available().some((p) => p.id === id)) return res.status(404).send('This calendar is not set up on this server yet.');
      const p = PROVIDERS[id];
      for (const [k, v] of this.pending) if (v.expires < this.now()) this.pending.delete(k);
      const state = crypto.randomBytes(24).toString('base64url');
      const verifier = crypto.randomBytes(32).toString('base64url');
      const redirectUri = `${base(req)}/api/calendars/${id}/callback`;
      this.pending.set(state, { userId: req.user.id, provider: id, verifier, redirectUri, expires: this.now() + STATE_TTL });
      setTz(req.user.id, req.query.tz);
      const params = new URLSearchParams({
        client_id: this.env[`${p.keys}_CLIENT_ID`], redirect_uri: redirectUri, response_type: 'code', state,
        ...(p.scope ? { scope: p.scope } : {}),
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
        ...p.extra,
      });
      res.redirect(`${p.authorize}?${params}`);
    });

    router.get('/:provider/callback', async (req, res) => {
      const flow = this.pending.get(String(req.query.state || ''));
      this.pending.delete(String(req.query.state || ''));
      const back = (q) => res.redirect(`/?${new URLSearchParams(q)}`);
      if (!flow || flow.provider !== req.params.provider || flow.userId !== req.user.id || flow.expires < this.now()) {
        return back({ calendar_error: 'The connection took too long or was already used. Please try again.' });
      }
      const p = PROVIDERS[flow.provider];
      if (req.query.error || !req.query.code) return back({ calendar_error: `${p.name} was not connected.` });
      try {
        const data = await this.tokenRequest(flow.provider, { grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: flow.redirectUri, code_verifier: flow.verifier });
        const link = await this.addLink(req.user.id, flow.provider, {
          access: data.access_token, refresh: data.refresh_token || null, expires: this.now() + (Number(data.expires_in) || 3600) * 1000,
        });
        back({ calendar: flow.provider, ...(link?.last_error ? { calendar_error: link.last_error.replace(/^reconnect: /, '') } : {}) });
      } catch (err) {
        if (!(err instanceof CalendarError)) console.error(`Connecting ${flow.provider} failed:`, err.message);
        back({ calendar_error: err instanceof CalendarError ? err.message : `${p.name} could not be connected. Please try again.` });
      }
    });

    router.post('/icloud', async (req, res) => {
      if (!this.sealer) return res.status(503).json({ error: 'Calendars are not set up on this server yet.' });
      const email = String(req.body?.email || '').trim().slice(0, 200);
      const password = String(req.body?.password || '').replace(/\s/g, '');
      if (!email || !/^[a-z]{4}-?[a-z]{4}-?[a-z]{4}-?[a-z]{4}$/i.test(password)) {
        return res.status(400).json({ error: 'Enter your Apple ID and an app-specific password (four groups of four letters).' });
      }
      setTz(req.user.id, req.body?.tz);
      try {
        const link = await this.addLink(req.user.id, 'icloud', { user: email, password: password.replace(/^(....)-?(....)-?(....)-?(....)$/, '$1-$2-$3-$4') }, { email });
        res.json({ link: this.view(link) });
      } catch (err) {
        res.status(400).json({ error: err instanceof CalendarError ? err.message : 'iCloud could not be connected. Please check the password and try again.' });
      }
    });

    router.put('/:id', (req, res) => {
      if (req.body?.writes !== true || !this.setWrites(req.user.id, req.params.id)) return res.status(400).json({ error: 'This calendar cannot receive notes.' });
      res.json({ links: this.links(req.user.id).map((l) => this.view(l)) });
    });

    router.post('/:id/sync', async (req, res) => {
      const link = this.link(req.params.id);
      if (!link || link.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
      const result = await this.sync(link.id);
      res.json({ result, link: this.view(this.link(link.id)) });
    });

    router.delete('/:id', (req, res) => {
      if (!this.remove(req.user.id, req.params.id)) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    });
    return router;
  }
}
