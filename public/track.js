// Measuring what works: A/B test variants and events (what people do, never
// what they write). Works before logging in with a random id kept on this
// device; once logged in, the server links it to the account.
const KEY = 'anonId';
let fallbackId = null;
export function anonId() {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return (fallbackId ||= crypto.randomUUID());
  }
}

let variants = {};
export async function loadVariants() {
  try {
    const res = await fetch(`api/public/experiments?anon=${anonId()}&platform=web`, { credentials: 'same-origin' });
    if (res.ok) variants = (await res.json()).variants || {};
  } catch {
    // Offline: everyone sees the first variant, nothing breaks.
  }
  return variants;
}
/** The variant of an A/B test this person sees, or `fallback` before it is known. */
export const variant = (key, fallback) => variants[key] ?? fallback;

const queue = [];
// Events that decide a test (a click on "Get Premium") are sent at once;
// the rest go in batches every 10 seconds.
const URGENT = new Set(['upgrade_click', 'feature_interest', 'invite_sent', 'signup_start']);
export function track(name, props = {}) {
  queue.push({ name, props, ts: Date.now() });
  if (queue.length >= 20 || URGENT.has(name)) flush();
}
export function flush() {
  if (!queue.length) return;
  const events = queue.splice(0, 50);
  fetch('api/public/events', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ anon: anonId(), platform: 'web', events }),
  }).catch(() => queue.unshift(...events));
}
setInterval(flush, 10000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
