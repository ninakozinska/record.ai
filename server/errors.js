// Error reports to Sentry (sentry.io, free tier), when SENTRY_DSN is set.
// Without it errors are only printed in the server log, as before.
// Reports carry the error, where in the code it happened, the route
// (without query strings) and the account id: never note text, emails or keys.

import crypto from 'node:crypto';

const MAX_PER_MINUTE = 30;

export function errorReporter({ env = process.env, fetch = globalThis.fetch, log = console } = {}) {
  const dsn = parseDsn(env.SENTRY_DSN);
  if (env.SENTRY_DSN && !dsn) log.error('[errors] SENTRY_DSN is set but is not a Sentry DSN (https://<key>@<host>/<project number>): error reports are off.');
  let sentThisMinute = 0;
  setInterval(() => (sentThisMinute = 0), 60e3).unref();

  return {
    configured: !!dsn,
    /** SENTRY_DSN is there but isn't a DSN (a bad paste). */
    invalid: !!env.SENTRY_DSN && !dsn,
    /** Reports an error; never throws. Returns the promise of the delivery (for tests). */
    report(err, { route, userId, tags = {} } = {}) {
      log.error('[error]', route || '', err?.stack || err);
      if (!dsn || sentThisMinute >= MAX_PER_MINUTE) return Promise.resolve(false);
      sentThisMinute++;
      const eventId = crypto.randomUUID().replaceAll('-', '');
      const event = {
        event_id: eventId,
        timestamp: Date.now() / 1000,
        platform: 'node',
        level: 'error',
        server_name: 'SortNotes',
        // Sentry refuses a release with a slash in it, and Fly's image name has
        // one (registry.fly.io/app:deployment-…): keep the part after the colon.
        release: releaseName(env.FLY_IMAGE_REF || env.RELEASE),
        environment: env.NODE_ENV || 'production',
        tags: { route: route || 'background', ...tags },
        user: userId ? { id: userId } : undefined,
        exception: {
          values: [{
            type: err?.name || 'Error',
            value: String(err?.message || err).slice(0, 1000),
            stacktrace: { frames: frames(err?.stack) },
          }],
        },
      };
      const header = JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn: dsn.raw });
      const body = `${header}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`;
      return fetch(dsn.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${dsn.key}, sentry_client=SortNotes/1.0`,
        },
        body,
      }).then((r) => r.ok, () => false);
    },
  };
}

/** A release name Sentry accepts: no slashes, at most 200 characters. */
export function releaseName(raw) {
  if (!raw) return undefined;
  const name = String(raw).split(':').pop().replace(/[\/\\\s]/g, '-').slice(0, 200);
  return name && name !== '.' && name !== '..' ? name : undefined;
}

/** https://<key>@<host>/<project id> → where to send. */
// Forgiving about how it was pasted: quotes, spaces, line breaks or the whole
// `dsn: "…",` line from Sentry's set-up page around it all still work.
export function parseDsn(pasted) {
  const raw = String(pasted || '').replace(/\s+/g, '').match(/https?:\/\/[^"'`@/]+@[^"'`/]+\/\d+/)?.[0];
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const project = u.pathname.replace(/^\/+|\/+$/g, '');
    if (!u.username || !project) return null;
    return { raw, key: u.username, url: `${u.protocol}//${u.host}/api/${project}/envelope/` };
  } catch {
    return null;
  }
}

/** Stack lines → Sentry frames, oldest call first; file paths shortened to the project. */
function frames(stack = '') {
  return String(stack).split('\n').slice(1, 30).map((line) => {
    const m = line.match(/at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
    if (!m) return null;
    const file = m[2].replace(/^file:\/\//, '').replace(/^.*?\/(server|public|node_modules)\//, '$1/');
    return { function: m[1] || '?', filename: file, lineno: Number(m[3]), colno: Number(m[4]), in_app: !file.startsWith('node_modules') && !file.startsWith('node:') };
  }).filter(Boolean).reverse();
}
