// Reminders and the morning briefing, as notifications on the person's
// devices (Web Push: the installed web app on iPhone, Android, Mac and PC).
//
// A note with a date can have a reminder: at its time, or some minutes
// before (a note with only a day counts from 09:00). The briefing comes once
// a day at the time the person picks: what is due today, and what is overdue.
// Free accounts get FREE_REMINDERS reminders a month; Premium, any number.
import webpush from 'web-push';
import { utcOf, wallTime } from './calendars.js';

export const FREE_REMINDERS = 3;
const LATE = 6 * 3600e3; // a reminder missed (server down) by more than this is skipped

// The few words a notification needs, in the person's language.
const WORDS = {
  en: { day: 'Your day', overdue: (n) => `${n} overdue`, nothing: 'Nothing due today.' },
  it: { day: 'La tua giornata', overdue: (n) => `${n} in ritardo`, nothing: 'Niente in scadenza oggi.' },
  fr: { day: 'Votre journée', overdue: (n) => `${n} en retard`, nothing: "Rien de prévu aujourd'hui." },
  es: { day: 'Tu día', overdue: (n) => `${n} atrasadas`, nothing: 'Nada para hoy.' },
  pt: { day: 'O seu dia', overdue: (n) => `${n} atrasadas`, nothing: 'Nada para hoje.' },
  de: { day: 'Dein Tag', overdue: (n) => `${n} überfällig`, nothing: 'Heute steht nichts an.' },
  pl: { day: 'Twój dzień', overdue: (n) => `${n} zaległe`, nothing: 'Na dziś nic.' },
};

const titleOf = (n) => n.title || n.text.split('\n').find((l) => l.trim())?.trim().slice(0, 80) || 'Note';
const month = (ms) => new Date(ms).toISOString().slice(0, 7);

export class Reminders {
  constructor({ store, env = process.env, send, now = () => Date.now(), tzOf }) {
    this.store = store;
    this.db = store.db;
    this.env = env;
    this.now = now;
    this.tzOf = tzOf;
    this.vapid = this.keys();
    this.send = send || ((sub, payload) => webpush.sendNotification(sub, JSON.stringify(payload), {
      TTL: 3600,
      vapidDetails: { subject: `mailto:${(env.MAIL_FROM || '').match(/[^<\s]+@[^>\s]+/)?.[0] || 'support@record.ai'}`, ...this.vapid },
    }));
  }

  /** The server's own key pair for Web Push: from the settings, or made once and kept. */
  keys() {
    if (this.env.VAPID_PUBLIC_KEY && this.env.VAPID_PRIVATE_KEY) return { publicKey: this.env.VAPID_PUBLIC_KEY, privateKey: this.env.VAPID_PRIVATE_KEY };
    const saved = this.store.getMeta('vapid');
    if (saved) return JSON.parse(saved);
    const made = webpush.generateVAPIDKeys();
    this.store.setMeta('vapid', JSON.stringify(made));
    return made;
  }

  subscribe(userId, sub) {
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return false;
    this.db.prepare('INSERT OR REPLACE INTO push_subscriptions (endpoint, user_id, keys, created_at) VALUES (?, ?, ?, ?)')
      .run(sub.endpoint, userId, JSON.stringify({ p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }), this.now());
    return true;
  }

  unsubscribe(userId, endpoint) {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(String(endpoint || ''), userId);
  }

  devices(userId) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId).n;
  }

  /** Sends to every device of the person; devices that unsubscribed are forgotten. */
  async push(userId, payload) {
    let sent = 0;
    for (const row of this.db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId)) {
      try {
        await this.send({ endpoint: row.endpoint, keys: JSON.parse(row.keys) }, payload);
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(row.endpoint);
      }
    }
    return sent;
  }

  // --- the monthly allowance on the free plan ---------------------------------

  limited(userId) {
    return this.store.planOf(userId) === 'free' && this.store.firstUserId() !== userId;
  }

  used(userId) {
    return Number(this.store.getMeta(`reminders:${month(this.now())}:${userId}`) || 0);
  }

  quota(userId) {
    return this.limited(userId) ? { limit: FREE_REMINDERS, left: Math.max(0, FREE_REMINDERS - this.used(userId)) } : { limit: null, left: null };
  }

  /** A note gets a reminder: counts it, or says no when the free allowance is used up. */
  allow(userId) {
    if (!this.limited(userId)) return true;
    const used = this.used(userId);
    if (used >= FREE_REMINDERS) return false;
    this.store.setMeta(`reminders:${month(this.now())}:${userId}`, String(used + 1));
    return true;
  }

  // --- what to send, and when -------------------------------------------------

  /** When the note's reminder goes off (ms), or null. */
  fireAt(note, tz) {
    if (note.remind == null || !note.due_date || note.done || note.deleted) return null;
    const base = note.due_time ? `${note.due_date}T${note.due_time}` : `${note.due_date}T09:00`;
    return utcOf(base, tz) - note.remind * 60e3;
  }

  briefingTime(userId) {
    return this.store.getMeta(`briefing:${userId}`) || null;
  }

  setBriefing(userId, time) {
    if (time == null || time === '') this.store.deleteMeta(`briefing:${userId}`);
    else if (/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) this.store.setMeta(`briefing:${userId}`, time);
    else return false;
    return true;
  }

  /** The briefing text: today's notes with their times, then how many are overdue. */
  briefing(userId, tz) {
    const today = wallTime(this.now(), tz).slice(0, 10);
    const notes = this.store.changesSince(userId, 0, { items: false, shared: true }).filter((n) => !n.deleted && !n.done && !n.revoked && n.due_date);
    const due = notes.filter((n) => n.due_date === today).sort((a, b) => (a.due_time || '99').localeCompare(b.due_time || '99'));
    const late = notes.filter((n) => n.due_date < today).length;
    const w = WORDS[this.store.languageOf?.(userId)] || WORDS.en;
    const parts = due.slice(0, 5).map((n) => (n.due_time ? `${n.due_time} ${titleOf(n)}` : titleOf(n)));
    if (due.length > 5) parts.push(`+${due.length - 5}`);
    if (late) parts.push(w.overdue(late));
    return { title: `☀️ ${w.day}`, body: parts.join(' · ') || w.nothing, url: './', tag: 'briefing', empty: !due.length && !late };
  }

  /** Runs every 30 seconds: due reminders, then due briefings. */
  async tick() {
    const now = this.now();
    const rows = this.db.prepare('SELECT id FROM notes WHERE remind IS NOT NULL AND deleted = 0 AND done = 0 AND parent_id IS NULL').all();
    for (const { id } of rows) {
      const note = this.store.get(id);
      const at = this.fireAt(note, this.tzOf(note.user_id));
      if (at == null || at > now || at < now - LATE) continue;
      if (this.store.getMeta(`reminded:${id}`) === String(at)) continue;
      this.store.setMeta(`reminded:${id}`, String(at));
      const time = note.due_time ? `⏰ ${note.due_time}` : '⏰';
      await this.push(note.user_id, { title: titleOf(note), body: time, url: `./?open=${id}`, tag: id });
    }
    const people = this.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'briefing:%'").all();
    for (const { key, value } of people) {
      const userId = key.slice('briefing:'.length);
      const tz = this.tzOf(userId);
      const local = wallTime(now, tz);
      if (local.slice(11) < value || this.store.getMeta(`briefed:${userId}`) === local.slice(0, 10)) continue;
      this.store.setMeta(`briefed:${userId}`, local.slice(0, 10));
      const b = this.briefing(userId, tz);
      if (!b.empty) await this.push(userId, b);
    }
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((err) => console.error('Reminders failed:', err.message)), 30e3);
    this.timer.unref?.();
  }
}
