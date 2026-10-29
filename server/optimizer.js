// Optimization loops: run every hour, read what happened, and adjust the app
// within safe limits. Every decision is written to optimizer_log, so the
// owner's dashboard shows what changed and why. See docs/OPTIMIZATION.md.
//
//  1. Cost:     wait a moment before sorting a note that is still being typed
//               (fewer wasted AI calls), and reorganize each person's notes
//               only as often as it actually moves something.
//  2. Quality:  watch how often people correct the AI (change a group or a
//               priority it chose). If that rises, undo the cost savings.
//  3. Revenue:  A/B tests send more people to the variant that is winning,
//               and declare a winner once it is clear and no guardrail
//               (e.g. people still writing notes) got worse.
//  4. Report:   one row of key numbers per day.

const HOUR = 3600e3;
const DAY = 24 * HOUR;

// Limits the loops never cross.
export const LIMITS = {
  debounceMs: { min: 0, max: 20000, start: 1500 },
  reorganizeEvery: { min: 10, max: 80 },
  minCallsToJudge: 40,      // AI calls in the window before the cost loop acts
  wastedHigh: 0.1,          // > 10% stale results: wait longer
  wastedLow: 0.02,          // < 2%: wait less
  correctionRise: 0.03,     // +3 points in the correction rate: quality guardrail trips
  winProbability: 0.95,
  guardrailDrop: 0.1,       // a winner may not lose more than 10% on a guardrail
  explore: 0.1,             // every variant keeps at least 10% of new traffic while testing
};

export class Optimizer {
  constructor({ store, insights, organizer, log = console }) {
    this.store = store;
    this.insights = insights;
    this.organizer = organizer;
    this.log = log;
    const saved = Number(store.getMeta('opt:debounce_ms'));
    if (organizer && Number.isFinite(saved) && store.getMeta('opt:debounce_ms') !== null) organizer.debounceMs = saved;
  }

  record(loop, decision, detail = {}) {
    this.store.db.prepare('INSERT INTO optimizer_log (ts, loop, decision, detail) VALUES (?, ?, ?, ?)')
      .run(Date.now(), loop, decision, JSON.stringify(detail));
  }

  logEntries(limit = 50) {
    return this.store.db.prepare('SELECT * FROM optimizer_log ORDER BY id DESC LIMIT ?').all(limit)
      .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  }

  start(every = HOUR) {
    const tick = () => {
      try {
        this.runAll();
      } catch (err) {
        this.log.error('[optimizer]', err.message);
      }
    };
    setTimeout(tick, 60e3).unref();
    setInterval(tick, every).unref();
  }

  runAll(now = Date.now()) {
    return {
      cost: this.costLoop(now),
      quality: this.qualityLoop(now),
      revenue: this.revenueLoop(now),
      report: this.dailyReport(now),
    };
  }

  // --- 1. cost ------------------------------------------------------------------

  aiWindow(since, until = Date.now()) {
    const r = this.store.db.prepare(
      `SELECT COUNT(*) AS calls, SUM(outcome = 'stale') AS stale, SUM(outcome = 'error') AS errors,
              SUM(cost_usd) AS cost, SUM(input_tokens) AS input, SUM(output_tokens) AS output
       FROM ai_calls WHERE ts >= ? AND ts < ?`,
    ).get(since, until);
    return { calls: r.calls, stale: r.stale || 0, errors: r.errors || 0, cost: r.cost || 0, input: r.input || 0, output: r.output || 0 };
  }

  costLoop(now = Date.now()) {
    const out = [];
    // a) Waiting before sorting: results thrown away because the note changed meanwhile.
    const w = this.aiWindow(now - DAY, now);
    const cur = this.organizer?.debounceMs ?? 0;
    if (this.organizer && w.calls >= LIMITS.minCallsToJudge) {
      const wasted = w.stale / w.calls;
      let next = cur;
      if (wasted > LIMITS.wastedHigh) next = Math.min(LIMITS.debounceMs.max, cur ? cur * 2 : LIMITS.debounceMs.start);
      else if (wasted < LIMITS.wastedLow && cur > 0) next = cur / 2 < 500 ? 0 : Math.round(cur / 2);
      if (next !== cur) {
        this.setDebounce(next);
        this.record('cost', next > cur ? 'wait longer before sorting' : 'wait less before sorting', { from: cur, to: next, wasted: round(wasted), calls: w.calls });
        out.push({ debounceMs: next });
      }
    }
    // b) How often each person's notes are fully reorganized.
    for (const u of this.store.allUsers()) {
      const recent = this.store.db.prepare(
        "SELECT props FROM events WHERE user_id = ? AND name = 'ai_reorganized' ORDER BY ts DESC LIMIT 3",
      ).all(u.id).map((r) => JSON.parse(r.props));
      if (recent.length < 3) continue;
      const moved = recent.reduce((s, r) => s + (r.moved || 0), 0) / Math.max(1, recent.reduce((s, r) => s + (r.total || 0), 0));
      const every = this.organizer.reorganizeEvery(u.id);
      let next = every;
      if (moved < 0.05) next = Math.min(LIMITS.reorganizeEvery.max, every * 2);
      else if (moved > 0.25) next = Math.max(LIMITS.reorganizeEvery.min, Math.round(every / 2));
      if (next !== every) {
        this.store.setMeta(`opt:reorg_every:${u.id}`, next);
        this.record('cost', next > every ? 'reorganize less often' : 'reorganize more often', { user: u.id, from: every, to: next, moved: round(moved) });
        out.push({ user: u.id, reorganizeEvery: next });
      }
    }
    return out;
  }

  setDebounce(ms) {
    this.organizer.debounceMs = ms;
    this.store.setMeta('opt:debounce_ms', ms);
  }

  // --- 2. quality -----------------------------------------------------------------

  /** Share of AI-sorted notes whose group or priority the person changed afterwards. */
  correctionRate(since, until = Date.now()) {
    const sorted = this.store.db.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE kind = 'note' AND outcome = 'used' AND ts >= ? AND ts < ?").get(since, until).n;
    const corrected = this.insights.count('ai_corrected', since, until);
    return { sorted, corrected, rate: sorted ? corrected / sorted : 0 };
  }

  qualityLoop(now = Date.now()) {
    const week = this.correctionRate(now - 7 * DAY, now);
    const before = this.correctionRate(now - 14 * DAY, now - 7 * DAY);
    if (week.sorted < LIMITS.minCallsToJudge || before.sorted < LIMITS.minCallsToJudge) return null;
    if (week.rate - before.rate <= LIMITS.correctionRise) return null;
    // Quality slipped: give back the savings that could cost quality.
    let changed = 0;
    for (const u of this.store.allUsers()) {
      const every = this.organizer.reorganizeEvery(u.id);
      if (every > 20) {
        this.store.setMeta(`opt:reorg_every:${u.id}`, Math.max(LIMITS.reorganizeEvery.min, Math.round(every / 2)));
        changed++;
      }
    }
    this.record('quality', 'corrections rose: reorganize more often again', { before: round(before.rate), now: round(week.rate), users: changed });
    return { tripped: true, before: before.rate, now: week.rate };
  }

  // --- 3. revenue ------------------------------------------------------------------

  revenueLoop() {
    const out = [];
    for (const exp of this.insights.experiments()) {
      if (exp.status !== 'running' || !exp.auto) continue;
      const res = this.insights.results(exp);
      const total = res.variants.reduce((s, v) => s + v.subjects, 0);
      if (total < exp.minSubjects) continue;
      const control = res.variants[0];
      const best = res.variants.reduce((a, b) => (b.probabilityBest > a.probabilityBest ? b : a));
      const guardrailsOk = (exp.guardrails || []).every((g) => {
        const c = control.guardrails[g]?.rate ?? 0;
        return best.guardrails[g]?.rate >= c * (1 - LIMITS.guardrailDrop);
      });
      const enough = res.variants.every((v) => v.subjects >= exp.minSubjects / res.variants.length / 2);
      if (best.probabilityBest >= LIMITS.winProbability && guardrailsOk && enough) {
        this.insights.saveExperiment({ ...exp, status: 'won', winner: best.key });
        this.record('revenue', `winner: ${exp.key} = ${best.key}`, { probability: round(best.probabilityBest), rate: round(best.rate), control: round(control.rate) });
        out.push({ key: exp.key, winner: best.key });
        continue;
      }
      // Still testing: more new people to likely winners, some exploration kept.
      const n = res.variants.length;
      const weights = res.variants.map((v) => Math.round(100 * (LIMITS.explore / n + (1 - LIMITS.explore) * v.probabilityBest)));
      const changedWeights = weights.some((w, i) => Math.abs(w - exp.variants[i].weight) >= 5);
      if (changedWeights) {
        this.insights.saveExperiment({ ...exp, variants: exp.variants.map((v, i) => ({ ...v, weight: Math.max(1, weights[i]) })) });
        this.record('revenue', `traffic shifted in ${exp.key}`, { weights: Object.fromEntries(exp.variants.map((v, i) => [v.key, weights[i]])) });
        out.push({ key: exp.key, weights });
      }
    }
    return out;
  }

  // --- 4. daily report -----------------------------------------------------------------

  /** Key numbers for one day (UTC), kept as kpi:<day>. Today is recomputed every run. */
  kpis(day) {
    const since = Date.parse(`${day}T00:00:00Z`);
    const until = since + DAY;
    const active = this.store.db.prepare(
      'SELECT COUNT(DISTINCT user_id) AS n FROM events WHERE ts >= ? AND ts < ? AND user_id IS NOT NULL',
    ).get(since, until).n;
    const ai = this.aiWindow(since, until);
    const users = this.store.allUsers();
    return {
      day,
      users: users.filter((u) => u.created_at < until).length,
      signups: this.insights.count('signup', since, until),
      active,
      notesCreated: this.insights.count('note_created', since, until),
      shares: this.insights.count('share_created', since, until),
      aiCalls: ai.calls,
      aiWasted: ai.stale,
      aiCostUsd: round(ai.cost, 6),
      aiCostPerActiveUsd: active ? round(ai.cost / active, 6) : 0,
      corrections: this.insights.count('ai_corrected', since, until),
      premiumUsers: users.filter((u) => ['solo', 'family'].includes(this.store.planOf(u.id))).length,
      upgradeClicks: this.insights.count('upgrade_click', since, until),
      checkouts: this.insights.count('checkout_started', since, until),
      subscriptionsStarted: this.insights.count('subscription_started', since, until),
      subscriptionsEnded: this.insights.count('subscription_ended', since, until),
      // Monthly revenue from accounts paying through Stripe (list prices, before VAT and fees).
      mrrEur: round(users.reduce((sum, u) => {
        if (!this.store.getMeta(`stripe:customer:${u.id}`) || u.id === this.store.firstUserId()) return sum;
        return sum + (PRICE_EUR[this.store.planOf(u.id)] || 0);
      }, 0), 2),
      backupsRestored: this.insights.count('backup_restored', since, until),
    };
  }

  dailyReport(now = Date.now()) {
    const today = new Date(now).toISOString().slice(0, 10);
    const yesterday = new Date(now - DAY).toISOString().slice(0, 10);
    for (const day of [yesterday, today]) this.store.setMeta(`kpi:${day}`, JSON.stringify(this.kpis(day)));
    return today;
  }

  history(days = 30, now = Date.now()) {
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(now - i * DAY).toISOString().slice(0, 10);
      const saved = this.store.getMeta(`kpi:${day}`);
      if (saved) out.push(JSON.parse(saved));
    }
    return out;
  }
}

/** Monthly list prices in euros (docs/PAYMENTS.md). */
export const PRICE_EUR = { solo: 3.99, family: 5.99 };

const round = (x, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;

/** Anthropic list prices, US$ per million tokens (Haiku: prompts up to 100K tokens). Free local AI = 0. */
export const PRICES = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export function costOf(model, usage = {}) {
  const p = PRICES[model] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return (
    ((usage.input_tokens || 0) * p.input +
      (usage.output_tokens || 0) * p.output +
      (usage.cache_read_input_tokens || 0) * p.cacheRead +
      (usage.cache_creation_input_tokens || 0) * p.cacheWrite) / 1e6
  );
}
