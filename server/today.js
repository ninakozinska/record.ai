// "Hear today": the day's plan as one text to read aloud, in the person's
// language. The web app, the iPhone app (and Siri) and the Android app all
// read this same text, so a busy morning sounds the same on every device:
//
//   Good morning. Friday 6 November. At 7:30, school bag: lunch box, swim kit.
//   At 9:00, dentist for Leo. Also today: buy milk. For you: sign the trip form.
//   Top to-do: book the plumber. 2 overdue. Have a good day.
import { wallTime } from './calendars.js';

const MAX = 8; // things read one by one; the rest are counted
const MAX_ITEMS = 6; // open list items read after a list's title

// Times as people say them: "7:30" (not "07:30"), "7 h 30", "7:30 Uhr".
const clock = (t) => t.replace(/^0(\d)/, '$1');
const WORDS = {
  en: {
    hello: ['Good morning', 'Good afternoon', 'Good evening'], at: (t) => `At ${clock(t)}`, also: 'Also today',
    forYou: 'For you', top: 'Top to-do', more: (n) => `and ${n} more`, overdue: (n) => `${n} overdue`,
    nothing: 'Nothing planned for today.', bye: 'Have a good day.',
  },
  it: {
    hello: ['Buongiorno', 'Buon pomeriggio', 'Buonasera'], at: (t) => `Alle ${clock(t)}`, also: 'Sempre oggi',
    forYou: 'Per te', top: 'La cosa più importante', more: (n) => `e altre ${n}`, overdue: (n) => `${n} in ritardo`,
    nothing: 'Niente in programma per oggi.', bye: 'Buona giornata.',
  },
  fr: {
    hello: ['Bonjour', 'Bon après-midi', 'Bonsoir'], at: (t) => `À ${clock(t).replace(':', ' h ')}`, also: "Aussi aujourd'hui",
    forYou: 'Pour vous', top: 'La priorité du jour', more: (n) => `et ${n} de plus`, overdue: (n) => `${n} en retard`,
    nothing: "Rien de prévu aujourd'hui.", bye: 'Bonne journée.',
  },
  es: {
    hello: ['Buenos días', 'Buenas tardes', 'Buenas noches'], at: (t) => `A las ${clock(t)}`, also: 'También hoy',
    forYou: 'Para ti', top: 'Lo más importante', more: (n) => `y ${n} más`, overdue: (n) => `${n} atrasadas`,
    nothing: 'Nada previsto para hoy.', bye: 'Que tengas un buen día.',
  },
  pt: {
    hello: ['Bom dia', 'Boa tarde', 'Boa noite'], at: (t) => `Às ${clock(t)}`, also: 'Também hoje',
    forYou: 'Para si', top: 'O mais importante', more: (n) => `e mais ${n}`, overdue: (n) => `${n} atrasadas`,
    nothing: 'Nada previsto para hoje.', bye: 'Tenha um bom dia.',
  },
  de: {
    hello: ['Guten Morgen', 'Guten Tag', 'Guten Abend'], at: (t) => `Um ${clock(t)} Uhr`, also: 'Außerdem heute',
    forYou: 'Für dich', top: 'Das Wichtigste', more: (n) => `und ${n} weitere`, overdue: (n) => `${n} überfällig`,
    nothing: 'Heute steht nichts an.', bye: 'Einen schönen Tag.',
  },
  pl: {
    hello: ['Dzień dobry', 'Dzień dobry', 'Dobry wieczór'], at: (t) => `O ${clock(t)}`, also: 'Również dziś',
    forYou: 'Dla ciebie', top: 'Najważniejsze', more: (n) => `i ${n} więcej`, overdue: (n) => `Zaległe: ${n}`,
    nothing: 'Na dziś nic nie zaplanowano.', bye: 'Miłego dnia.',
  },
};

const titleOf = (n) => (n.title || n.text.split('\n').find((l) => l.trim()) || '').trim().slice(0, 100);
const sentence = (s) => (/[.!?…]$/.test(s) ? s : `${s}.`);

/**
 * The day's plan for one person, as text to read aloud.
 * `topTodo` is the title of today's top suggested to-do, if there is one.
 */
export function spokenToday({ store, userId, tz, now = Date.now(), topTodo = null }) {
  const lang = WORDS[store.languageOf?.(userId)] ? store.languageOf(userId) : 'en';
  const w = WORDS[lang];
  const wall = wallTime(now, tz);
  const today = wall.slice(0, 10);
  const hour = Number(wall.slice(11, 13));

  const all = store.changesSince(userId, 0, { items: true, shared: true }).filter((n) => !n.deleted && !n.revoked);
  const items = new Map();
  for (const i of all) {
    if (!i.parent_id || i.done) continue;
    if (!items.has(i.parent_id)) items.set(i.parent_id, []);
    items.get(i.parent_id).push(i);
  }
  const open = all.filter((n) => !n.parent_id && !n.done);
  const said = (n) => {
    const list = (items.get(n.id) || []).sort((a, b) => a.created_at - b.created_at).map(titleOf).filter(Boolean);
    const head = titleOf(n) || list.shift() || '';
    if (!list.length) return head;
    const more = list.length > MAX_ITEMS ? `, ${w.more(list.length - MAX_ITEMS)}` : '';
    return `${head}: ${list.slice(0, MAX_ITEMS).join(', ')}${more}`;
  };

  const due = open.filter((n) => n.due_date === today);
  const forMe = (n) => n.assigned_to === userId && n.user_id !== userId;
  const timed = due.filter((n) => n.due_time).sort((a, b) => a.due_time.localeCompare(b.due_time));
  const untimed = due.filter((n) => !n.due_time && !forMe(n));
  const mine = due.filter((n) => !n.due_time && forMe(n));
  const late = open.filter((n) => n.due_date && n.due_date < today).length;

  const date = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : lang, { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }).format(new Date(now));
  const parts = [w.hello[hour < 12 ? 0 : hour < 18 ? 1 : 2], date.charAt(0).toUpperCase() + date.slice(1)];
  let left = MAX;
  for (const n of timed.slice(0, left)) parts.push(`${w.at(n.due_time)}, ${said(n)}`);
  left -= Math.min(timed.length, left);
  if (untimed.length && left > 0) {
    parts.push(`${w.also}: ${untimed.slice(0, left).map(said).join('; ')}`);
    left -= Math.min(untimed.length, left);
  }
  if (mine.length && left > 0) {
    parts.push(`${w.forYou}: ${mine.slice(0, left).map(said).join('; ')}`);
    left -= Math.min(mine.length, left);
  }
  const unsaid = due.length - (MAX - left);
  if (unsaid > 0) parts.push(w.more(unsaid));
  if (!due.length) parts.push(w.nothing);
  if (topTodo) parts.push(`${w.top}: ${topTodo}`);
  if (late) parts.push(w.overdue(late));
  parts.push(w.bye);
  return { text: parts.map(sentence).join(' '), lang, count: due.length, overdue: late };
}
