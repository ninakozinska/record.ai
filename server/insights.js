// Measuring what works: events (what people do, never what they write), A/B
// experiments with sticky assignment, and the statistics that compare variants.
//
// Subjects: a logged-in person is 'u:<user id>'; before logging in (landing
// page, sign-up form, an app's first screen) a device sends its own random
// anonymous id and is 'a:<id>'. When that device logs in, its assignments and
// events are carried over to the account, so a test that starts on the
// landing page can be measured all the way to paying.
import crypto from 'node:crypto';

export const EVENT_NAME = /^[a-z][a-z0-9_]{1,47}$/;
export const ANON_ID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_PROPS = 2000;

/** A number in [0, 1) from a string, the same every time. */
function unit(text) {
  return crypto.createHash('sha256').update(text).digest().readUInt32BE(0) / 2 ** 32;
}

export class Insights {
  constructor(db) {
    this.db = db;
  }

  // --- events -----------------------------------------------------------------

  /** Records one event. `props` holds counts and choices only, never note text. */
  track(name, { userId = null, anonId = null, platform = null, props = {}, ts = Date.now() } = {}) {
    if (!EVENT_NAME.test(name)) return false;
    let json = JSON.stringify(props ?? {});
    if (json.length > MAX_PROPS) json = '{}';
    this.db
      .prepare('INSERT INTO events (ts, user_id, anon_id, name, platform, props) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ts, userId, anonId, name, platform ? String(platform).slice(0, 16) : null, json);
    return true;
  }

  /** The first time this person did `name`, or null. */
  firstTime(userId, name) {
    return this.db.prepare('SELECT MIN(ts) AS t FROM events WHERE user_id = ? AND name = ?').get(userId, name)?.t ?? null;
  }

  count(name, since, until = Date.now()) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE name = ? AND ts >= ? AND ts < ?').get(name, since, until).n;
  }

  /** People (accounts) who did `name` in the period. */
  people(name, since, until = Date.now()) {
    return this.db
      .prepare('SELECT COUNT(DISTINCT user_id) AS n FROM events WHERE name = ? AND ts >= ? AND ts < ? AND user_id IS NOT NULL')
      .get(name, since, until).n;
  }

  /** A device that logged in: its anonymous history now belongs to the account. */
  identify(anonId, userId) {
    if (!anonId || !userId) return;
    this.db.prepare('UPDATE events SET user_id = ? WHERE anon_id = ? AND user_id IS NULL').run(userId, anonId);
    for (const a of this.db.prepare("SELECT * FROM assignments WHERE subject = ?").all(`a:${anonId}`)) {
      this.db
        .prepare('INSERT OR IGNORE INTO assignments (experiment, subject, variant, ts) VALUES (?, ?, ?, ?)')
        .run(a.experiment, `u:${userId}`, a.variant, a.ts);
    }
  }

  // --- experiments --------------------------------------------------------------

  /**
   * An experiment:
   *   { key, description, status: 'running' | 'paused' | 'won',
   *     variants: [{ key: 'control', weight: 50 }, { key: 'b', weight: 50 }],
   *     metric: 'upgrade_click',       // the event that counts as a success
   *     guardrails: ['note_created'],   // events that must not get rarer
   *     platforms: ['web', 'ios', 'android'] (optional),
   *     page: 'landing' (optional),      // shown on one page only: assigned when that page asks
   *     auto: true,                      // the optimizer may shift traffic and pick a winner
   *     winner: null, minSubjects: 200 }
   */
  experiments() {
    return this.db.prepare('SELECT config FROM experiments ORDER BY created_at').all().map((r) => JSON.parse(r.config));
  }

  experiment(key) {
    const r = this.db.prepare('SELECT config FROM experiments WHERE key = ?').get(key);
    return r ? JSON.parse(r.config) : null;
  }

  saveExperiment(exp) {
    const clean = validExperiment(exp);
    this.db
      .prepare('INSERT INTO experiments (key, config, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET config = excluded.config')
      .run(clean.key, JSON.stringify(clean), Date.now());
    return clean;
  }

  /** Adds the experiments a release ships with, without touching ones that already exist. */
  seed(list) {
    for (const exp of list) if (!this.experiment(exp.key)) this.saveExperiment(exp);
  }

  /**
   * The variant this subject sees. The first answer is stored and never
   * changes; a finished experiment shows its winner to everyone new.
   */
  variant(exp, subject) {
    const stored = this.db.prepare('SELECT variant FROM assignments WHERE experiment = ? AND subject = ?').get(exp.key, subject);
    if (stored) return stored.variant;
    if (exp.status === 'won' && exp.winner) return exp.winner;
    if (exp.status !== 'running') return exp.variants[0].key;
    const total = exp.variants.reduce((s, v) => s + v.weight, 0);
    let x = unit(`${exp.key}:${subject}`) * total;
    let chosen = exp.variants.at(-1).key;
    for (const v of exp.variants) {
      if (x < v.weight) {
        chosen = v.key;
        break;
      }
      x -= v.weight;
    }
    this.db.prepare('INSERT INTO assignments (experiment, subject, variant, ts) VALUES (?, ?, ?, ?)').run(exp.key, subject, chosen, Date.now());
    return chosen;
  }

  /**
   * Every experiment's variant for this subject (only those running on this
   * platform). Tests of one page (the landing page) only when that page asks
   * for them by key, so people who never see it aren't counted in it.
   */
  assignmentsFor(subject, platform, keys = null) {
    const out = {};
    for (const exp of this.experiments()) {
      if (exp.platforms && platform && !exp.platforms.includes(platform)) continue;
      if (keys ? !keys.includes(exp.key) : exp.page) continue;
      out[exp.key] = this.variant(exp, subject);
    }
    return out;
  }

  /**
   * Per variant: people in it, how many reached the metric (and each
   * guardrail) after being assigned, the rate, and the comparison with control.
   */
  results(exp) {
    const rows = this.db.prepare('SELECT variant, subject, ts FROM assignments WHERE experiment = ?').all(exp.key);
    const reached = (subject, since, name) => {
      const [kind, id] = [subject.slice(0, 1), subject.slice(2)];
      const col = kind === 'u' ? 'user_id' : 'anon_id';
      return !!this.db.prepare(`SELECT 1 FROM events WHERE ${col} = ? AND name = ? AND ts >= ? LIMIT 1`).get(id, name, since);
    };
    const variants = exp.variants.map((v) => {
      const mine = rows.filter((r) => r.variant === v.key);
      const conv = mine.filter((r) => reached(r.subject, r.ts, exp.metric)).length;
      const guardrails = Object.fromEntries((exp.guardrails || []).map((g) => {
        const n = mine.filter((r) => reached(r.subject, r.ts, g)).length;
        return [g, { count: n, rate: mine.length ? n / mine.length : 0 }];
      }));
      return { key: v.key, weight: v.weight, subjects: mine.length, conversions: conv, rate: mine.length ? conv / mine.length : 0, guardrails };
    });
    const control = variants[0];
    for (const v of variants.slice(1)) {
      v.liftVsControl = control.rate ? v.rate / control.rate - 1 : null;
      v.pValue = twoProportionP(control.conversions, control.subjects, v.conversions, v.subjects);
    }
    const best = probabilityBest(variants);
    variants.forEach((v, i) => (v.probabilityBest = best[i]));
    return { key: exp.key, status: exp.status, metric: exp.metric, winner: exp.winner || null, variants };
  }
}

function validExperiment(exp) {
  const key = String(exp?.key || '');
  if (!/^[a-z][a-z0-9_]{1,47}$/.test(key)) throw new Error('Experiment key: lowercase letters, digits and _');
  const variants = (exp.variants || []).map((v) => ({ key: String(v.key), weight: Math.max(0, Number(v.weight) || 0) }));
  if (variants.length < 2 || variants.some((v) => !/^[a-z][a-z0-9_]{0,31}$/.test(v.key))) throw new Error('At least two variants with simple keys');
  if (!variants.some((v) => v.weight > 0)) throw new Error('At least one variant needs traffic');
  if (!EVENT_NAME.test(exp.metric || '')) throw new Error('A metric event is needed');
  const status = ['running', 'paused', 'won'].includes(exp.status) ? exp.status : 'running';
  return {
    key,
    description: String(exp.description || '').slice(0, 300),
    status,
    variants,
    metric: exp.metric,
    guardrails: (exp.guardrails || []).filter((g) => EVENT_NAME.test(g)).slice(0, 5),
    platforms: exp.platforms ? exp.platforms.filter((p) => ['web', 'ios', 'android'].includes(p)) : null,
    page: typeof exp.page === 'string' && /^[a-z]{1,20}$/.test(exp.page) ? exp.page : null,
    auto: exp.auto !== false,
    winner: status === 'won' && variants.some((v) => v.key === exp.winner) ? exp.winner : null,
    minSubjects: Math.max(20, Number(exp.minSubjects) || 200),
  };
}

/** Two-sided p-value of a difference between two rates (normal approximation). */
export function twoProportionP(c1, n1, c2, n2) {
  if (!n1 || !n2) return null;
  const p = (c1 + c2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return 1;
  const z = Math.abs(c1 / n1 - c2 / n2) / se;
  return 2 * (1 - normalCdf(z));
}

function normalCdf(z) {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - t * Math.exp(-(z * z) / 2) * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/**
 * Chance each variant has the highest true rate, from Beta(1 + successes,
 * 1 + failures) posteriors, estimated by drawing from them. A fixed seed
 * keeps the answer stable between page loads.
 */
export function probabilityBest(variants, draws = 4000) {
  const rand = mulberry32(42);
  const wins = variants.map(() => 0);
  for (let d = 0; d < draws; d++) {
    let bestI = 0;
    let bestX = -1;
    variants.forEach((v, i) => {
      const x = betaSample(1 + v.conversions, 1 + v.subjects - v.conversions, rand);
      if (x > bestX) {
        bestX = x;
        bestI = i;
      }
    });
    wins[bestI]++;
  }
  return wins.map((w) => w / draws);
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Gamma(k, 1) by Marsaglia-Tsang (k >= 1 here), Beta from two Gammas.
function gammaSample(k, rand) {
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do {
      const u1 = rand() || 1e-12;
      const u2 = rand();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function betaSample(a, b, rand) {
  const x = gammaSample(a, rand);
  return x / (x + gammaSample(b, rand));
}
