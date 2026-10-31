import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { Organizer } from '../server/organizer.js';

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'record-ai-test-'));
}

/** Starts a server on a random port; signs up a first user unless noSignup. */
export async function start(opts = {}) {
  const dataDir = tmpDir();
  const client = opts.client;
  const { app, store, organizer, insights, optimizer, backups, calendars, reminders } = createApp({
    dataDir,
    oauth: opts.oauth,
    mail: opts.mail,
    ...(opts.billing ? { billing: opts.billing } : {}),
    ...(opts.calendars ? { calendars: opts.calendars } : {}),
    ...(opts.reminders ? { reminders: opts.reminders } : {}),
    organizer: client
      ? (args) => new Organizer({ ...args, client, log: { error() {} } })
      : (args) => new Organizer({ ...args, log: { error() {} } }),
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  let cookie = '';
  const api = async (p, init = {}) => {
    const res = await fetch(base + p, {
      ...init,
      headers: { 'Content-Type': 'application/json', cookie, ...init.headers },
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  let user = null;
  if (!opts.noSignup) {
    const r = await api('auth/signup', {
      method: 'POST',
      body: JSON.stringify({ name: 'Nina', email: 'nina@example.com', password: 'correct horse' }),
    });
    user = r.body.user;
  }
  return { api, store, organizer, insights, optimizer, backups, calendars, reminders, dataDir, user, base, cookie: () => cookie, close: () => server.close() };
}
