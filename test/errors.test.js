// Error reports: a plain answer to the person, and a report to Sentry (faked)
// without note text, emails or query strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorReporter, parseDsn } from '../server/errors.js';

test('the Sentry address is read from the DSN', () => {
  assert.deepEqual(parseDsn('https://abc123@o1.ingest.sentry.io/42'), {
    raw: 'https://abc123@o1.ingest.sentry.io/42', key: 'abc123', url: 'https://o1.ingest.sentry.io/api/42/envelope/',
  });
  assert.equal(parseDsn('not a dsn'), null);
  assert.equal(parseDsn(''), null);
});

test('an error is reported once, with where it happened and the account id only', async () => {
  const sent = [];
  const fetch = async (url, init) => (sent.push({ url, init }), new Response('{}'));
  const r = errorReporter({ env: { SENTRY_DSN: 'https://abc123@o1.ingest.sentry.io/42' }, fetch, log: { error() {} } });
  assert.equal(r.configured, true);
  assert.equal(await r.report(new TypeError('boom'), { route: 'POST /api/sync', userId: 'u1' }), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://o1.ingest.sentry.io/api/42/envelope/');
  assert.match(sent[0].init.headers['X-Sentry-Auth'], /sentry_key=abc123/);
  const [, type, event] = sent[0].init.body.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(type.type, 'event');
  assert.equal(event.exception.values[0].type, 'TypeError');
  assert.equal(event.exception.values[0].value, 'boom');
  assert.equal(event.tags.route, 'POST /api/sync');
  assert.deepEqual(event.user, { id: 'u1' });
  assert.ok(event.exception.values[0].stacktrace.frames.length > 0);

  // Without a DSN nothing leaves the server.
  const off = errorReporter({ env: {}, fetch, log: { error() {} } });
  assert.equal(await off.report(new Error('x')), false);
  assert.equal(sent.length, 1);
});
