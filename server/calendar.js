// Calendar files (iCalendar, .ics) for notes with a date: one note to add to
// a calendar, or a feed of all of them that a calendar app subscribes to.

const escape = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Lines longer than 75 bytes continue on the next line, starting with a space. */
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let n = 74;
    while (Buffer.byteLength(rest.slice(0, n)) > 74) n--;
    out.push(rest.slice(0, n));
    rest = ' ' + rest.slice(n);
  }
  out.push(rest);
  return out.join('\r\n');
}

const compact = (date) => date.replaceAll('-', '');
const utcStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** The wall-clock date and time `minutes` later, as YYYYMMDD / YYYYMMDDTHHMM00. */
function shift(date, time, minutes) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, hh, mm) + minutes * 60e3).toISOString();
  return time ? `${t.slice(0, 10).replaceAll('-', '')}T${t.slice(11, 13)}${t.slice(14, 16)}00` : t.slice(0, 10).replaceAll('-', '');
}

export const noteTitle = (n) => n.title || n.text.split('\n').find((l) => l.trim())?.slice(0, 80) || 'Note';

/**
 * One VEVENT per note: all day, or one hour from its time. `tz` is the
 * person's time zone (e.g. Europe/Rome); without it, times are read in the
 * calendar's own time zone.
 */
function event(n, { tz, link, items = [] }) {
  const lines = ['BEGIN:VEVENT', `UID:${n.id}@record.ai`, `DTSTAMP:${utcStamp(n.edited_at)}`, `LAST-MODIFIED:${utcStamp(n.edited_at)}`];
  if (n.due_time) {
    const zone = tz ? `;TZID=${tz}` : '';
    lines.push(`DTSTART${zone}:${shift(n.due_date, n.due_time, 0)}`, `DTEND${zone}:${shift(n.due_date, n.due_time, 60)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${compact(n.due_date)}`, `DTEND;VALUE=DATE:${shift(n.due_date, null, 24 * 60)}`);
  }
  const body = n.text.trim() === noteTitle(n) ? '' : n.text.trim();
  const list = items.map((i) => `${i.done ? '☑' : '☐'} ${i.text}`).join('\n');
  lines.push(`SUMMARY:${escape(noteTitle(n))}`);
  const description = [body, list, link].filter(Boolean).join('\n\n');
  if (description) lines.push(`DESCRIPTION:${escape(description)}`);
  if (link) lines.push(`URL:${link}`);
  lines.push('END:VEVENT');
  return lines;
}

export function toIcs(notes, { name = 'record.ai', tz, link, itemsOf = () => [] } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//record.ai//Notes//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escape(name)}`,
    ...(tz ? [`X-WR-TIMEZONE:${tz}`] : []),
    // Ask subscribed calendars to check for changes about every hour.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...notes.filter((n) => n.due_date).flatMap((n) => event(n, { tz, link, items: itemsOf(n.id) })),
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}
