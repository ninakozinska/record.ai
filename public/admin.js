// The owner's dashboard: daily numbers, A/B tests, optimizer decisions, plans.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (x) => (x == null ? '–' : `${(x * 100).toFixed(1)}%`);
const usd = (x) => `$${Number(x || 0).toFixed(4)}`;

async function api(path, opts = {}) {
  const res = await fetch('api/' + path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

const KPI = [
  ['active', 'Active people'], ['signups', 'Sign-ups'], ['notesCreated', 'Notes written'], ['shares', 'Shares'],
  ['aiCalls', 'AI calls'], ['aiWasted', 'AI calls wasted'], ['aiCostUsd', 'AI cost', usd], ['aiCostPerActiveUsd', 'AI cost per active person', usd],
  ['corrections', 'AI corrected by people'], ['upgradeClicks', '"Get Premium" clicks'], ['premiumUsers', 'Premium people'], ['users', 'Accounts'],
];

function render(o) {
  const today = o.kpis.at(-1) || {};
  $('#tiles').innerHTML = KPI.map(([k, label, f]) => `<div class="card tile"><div class="v">${esc((f || String)(today[k] ?? 0))}</div><div class="k">${esc(label)}</div></div>`).join('');
  $('#kpis').innerHTML = `<tr><th>Day</th>${KPI.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr>` +
    [...o.kpis].reverse().map((d) => `<tr><td>${esc(d.day)}</td>${KPI.map(([k, , f]) => `<td>${esc((f || String)(d[k] ?? 0))}</td>`).join('')}</tr>`).join('');
  $('#experiments').innerHTML = o.experiments.map((e) => `
    <div class="stack">
      <p><strong>${esc(e.key)}</strong> · ${esc(e.status)}${e.winner ? ` · <span class="win">winner: ${esc(e.winner)}</span>` : ''}${e.auto ? ' · optimizer on' : ''}<br>
      <span class="muted">${esc(e.description)} Success = <code>${esc(e.metric)}</code>${e.guardrails?.length ? `; must not hurt <code>${esc(e.guardrails.join(', '))}</code>` : ''}.</span></p>
      <div class="scroll"><table class="data"><tr><th>Variant</th><th>Traffic</th><th>People</th><th>Successes</th><th>Rate</th><th>vs first</th><th>p-value</th><th>Chance best</th></tr>
      ${e.variants.map((v) => `<tr><td>${esc(v.key)}</td><td>${v.weight}%</td><td>${v.subjects}</td><td>${v.conversions}</td><td>${pct(v.rate)}</td>
        <td>${v.liftVsControl == null ? '–' : `${v.liftVsControl > 0 ? '+' : ''}${pct(v.liftVsControl)}`}</td><td>${v.pValue == null ? '–' : v.pValue.toFixed(3)}</td><td>${pct(v.probabilityBest)}</td></tr>`).join('')}
      </table></div>
    </div>`).join('') || '<p class="muted">No tests yet.</p>';
  const q = o.optimizer.quality;
  $('#optState').textContent = `Waiting ${(o.optimizer.debounceMs / 1000).toFixed(1)} s before sorting a note that is being typed. ` +
    `AI corrected by people in the last 7 days: ${pct(q.rate)} (${q.corrected} of ${q.sorted} notes).`;
  $('#log').innerHTML = o.log.length
    ? `<tr><th>When</th><th>Loop</th><th>Decision</th><th>Details</th></tr>` + o.log.map((l) => `<tr><td>${esc(new Date(l.ts).toLocaleString())}</td><td>${esc(l.loop)}</td><td>${esc(l.decision)}</td><td>${esc(JSON.stringify(l.detail))}</td></tr>`).join('')
    : '<tr><td class="muted">Nothing yet: the loops act once there is enough data.</td></tr>';
  $('#users').innerHTML = `<tr><th>Person</th><th>Email</th><th>Since</th><th>Plan</th></tr>` + o.users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(new Date(u.created_at).toLocaleDateString())}</td>
    <td><select data-email="${esc(u.email)}">${['free', 'solo', 'family'].map((p) => `<option ${p === u.plan ? 'selected' : ''}>${p}</option>`).join('')}</select></td></tr>`).join('');
  const FEATURE = { reminders: '⏰ Smart reminders', family_hub: '👨‍👩‍👧 Give tasks to family', letter_to_tasks: '📸 School letter → tasks' };
  $('#interest').innerHTML = o.featureInterest.length
    ? `<tr><th>Feature</th><th>People who want it</th></tr>` + o.featureInterest.map((f) => `<tr><td>${esc(FEATURE[f.feature] || f.feature)}</td><td>${f.people}</td></tr>`).join('')
    : '<tr><td class="muted">No votes yet.</td></tr>';
  $('#feedback').innerHTML = o.feedback.length
    ? o.feedback.map((f) => `<p><strong>${esc(f.email)}</strong> <span class="muted">· ${esc(new Date(f.ts).toLocaleString())} · ${esc(f.platform)}</span><br>${esc(f.text)}</p>`).join('')
    : '<p class="muted">No feedback yet.</p>';
  $('#status').textContent = `Updated ${new Date().toLocaleTimeString()}.`;
}

async function load() {
  try {
    render(await api('admin/overview'));
  } catch (err) {
    $('#status').textContent = err.status === 404 || err.status === 401 ? 'This page is only for the owner. Log in first.' : err.message;
  }
}
$('#users').addEventListener('change', async (e) => {
  const sel = e.target.closest('select[data-email]');
  if (!sel) return;
  try {
    await api('admin/plan', { method: 'POST', body: JSON.stringify({ email: sel.dataset.email, plan: sel.value }) });
    $('#status').textContent = `${sel.dataset.email} is now on ${sel.value}.`;
  } catch (err) {
    $('#status').textContent = err.message;
  }
});
$('#optimizeNow').onclick = async () => {
  await api('admin/optimize', { method: 'POST' }).catch(() => {});
  load();
};
load();
setInterval(load, 60000);
