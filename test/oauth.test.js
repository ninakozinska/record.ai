// "Continue with Google / Apple / …". The providers are replaced by a fake
// that answers like each real one, so no real accounts are needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { start, tmpDir } from './helpers.js';
import { appleClientSecret, configuredProviders } from '../server/oauth.js';

const b64url = (b) => Buffer.from(b).toString('base64url');
const sha = (s) => b64url(crypto.createHash('sha256').update(s).digest());

const appleKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ENV = {
  GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret',
  FACEBOOK_CLIENT_ID: 'f-id', FACEBOOK_CLIENT_SECRET: 'f-secret',
  X_CLIENT_ID: 'x-id', X_CLIENT_SECRET: 'x-secret',
  GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret',
  APPLE_CLIENT_ID: 'ai.record.web', APPLE_TEAM_ID: 'TEAM123', APPLE_KEY_ID: 'KEY123',
  APPLE_PRIVATE_KEY: appleKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n'),
};

/**
 * Fake provider. `who[provider]` = the profile the next sign-in returns.
 * Checks what the server sends, like the real token endpoints do.
 */
function fakeProviders() {
  const who = {};
  const codes = new Map(); // code -> { provider, challenge }
  const calls = [];
  const issue = (provider, challenge) => {
    const code = `code-${crypto.randomUUID()}`;
    codes.set(code, { provider, challenge });
    return code;
  };
  async function fetch(url, init = {}) {
    url = String(url);
    calls.push({ url, init });
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const form = init.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    if (init.method === 'POST') {
      const entry = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      if (!entry) return reply(400, { error: 'invalid_grant' });
      if (entry.challenge && sha(form.get('code_verifier') || '') !== entry.challenge) return reply(400, { error: 'invalid_grant', error_description: 'PKCE' });
      if (entry.provider === 'apple') {
        const p = who.apple;
        const idToken = `${b64url('{}')}.${b64url(JSON.stringify({ iss: 'https://appleid.apple.com', aud: ENV.APPLE_CLIENT_ID, sub: p.sub, email: p.email, email_verified: 'true' }))}.sig`;
        return reply(200, { access_token: 'a', id_token: idToken, client_secret_seen: form.get('client_secret') });
      }
      return reply(200, { access_token: `token-${entry.provider}` });
    }
    const token = String(init.headers?.Authorization || '').replace('Bearer token-', '');
    if (url.startsWith('https://openidconnect.googleapis.com/') && token === 'google') return reply(200, who.google);
    if (url.startsWith('https://graph.facebook.com/') && token === 'facebook') return reply(200, who.facebook);
    if (url.startsWith('https://api.x.com/2/users/me') && token === 'x') return reply(200, { data: who.x });
    if (url === 'https://api.github.com/user' && token === 'github') return reply(200, who.github);
    if (url === 'https://api.github.com/user/emails' && token === 'github') return reply(200, who.githubEmails);
    return reply(401, { error: 'unauthorized' });
  }
  return { fetch, who, issue, calls };
}

/** A browser: keeps its cookies and does not follow redirects. */
function browser(origin) {
  const jar = new Map();
  const b = async (url, init = {}) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(url.startsWith('http') ? url : origin + url, {
      ...init, redirect: 'manual', headers: { cookie, ...init.headers },
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const [k, v] = pair.split('=');
      if (/Max-Age=0/.test(sc)) jar.delete(k); else jar.set(k, v);
    }
    return res;
  };
  b.jar = jar;
  return b;
}

async function setup(opts = {}) {
  const fake = fakeProviders();
  const s = await start({ ...opts, oauth: { env: ENV, fetch: fake.fetch } });
  const origin = s.base.replace(/\/api\/$/, '');
  return { s, fake, origin };
}

/** Runs a sign-in in `b` up to the provider's answer; returns the callback response. */
async function signIn(b, fake, provider, { query = '', method = 'GET', extra = {} } = {}) {
  const startRes = await b(`/api/auth/oauth/${provider}/start${query}`);
  assert.equal(startRes.status, 302);
  const to = new URL(startRes.headers.get('location'));
  const state = to.searchParams.get('state');
  const code = fake.issue(provider, to.searchParams.get('code_challenge'));
  const callback = new URL(to.searchParams.get('redirect_uri'));
  if (method === 'POST') {
    return b(callback.pathname, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state, code, ...extra }) });
  }
  return b(`${callback.pathname}?${new URLSearchParams({ state, code, ...extra })}`);
}

const loginError = (res) => new URL(res.headers.get('location'), 'http://x').searchParams.get('login_error');
const stateOf = async (b) => (await b('/api/auth/state')).json();

test('only providers with keys are offered', () => {
  assert.deepEqual(configuredProviders(ENV).map((p) => p.id), ['google', 'apple', 'facebook', 'x', 'github']);
  assert.deepEqual(configuredProviders({ GOOGLE_CLIENT_ID: 'only-half' }), []);
});

test('Apple key can be given as the downloaded .p8 file', () => {
  const file = path.join(tmpDir(), 'AuthKey_KEY123.p8');
  fs.writeFileSync(file, appleKey.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const env = { ...ENV, APPLE_PRIVATE_KEY: undefined, APPLE_PRIVATE_KEY_FILE: file };
  assert.ok(configuredProviders(env).some((p) => p.id === 'apple'));
  const [h, p, sig] = appleClientSecret(env).split('.');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: appleKey.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('the login screen lists the providers; the start sends people to the provider with PKCE', async () => {
  const { s, origin } = await setup({ noSignup: true });
  try {
    const b = browser(origin);
    assert.deepEqual((await stateOf(b)).providers.map((p) => p.name), ['Google', 'Apple', 'Facebook', 'X (Twitter)', 'GitHub']);
    const res = await b('/api/auth/oauth/google/start');
    const to = new URL(res.headers.get('location'));
    assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(to.searchParams.get('client_id'), 'g-id');
    assert.equal(to.searchParams.get('redirect_uri'), `${origin}/api/auth/oauth/google/callback`);
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(to.searchParams.get('state').length >= 32);
    assert.equal((await b('/api/auth/oauth/microsoft/start')).status, 404, 'not set up');
  } finally {
    s.close();
  }
});

test('Google: the first sign-in creates the account, the next one logs into it', async () => {
  const { s, fake, origin } = await setup({ noSignup: true });
  try {
    fake.who.google = { sub: 'g-1', email: 'nina@example.com', email_verified: true, name: 'Nina K' };
    const b = browser(origin);
    const res = await signIn(b, fake, 'google');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/');
    const st = await stateOf(b);
    assert.equal(st.user.name, 'Nina K');
    assert.equal(st.user.email, 'nina@example.com');

    const b2 = browser(origin);
    await signIn(b2, fake, 'google');
    assert.equal((await stateOf(b2)).user.id, st.user.id);
    assert.equal(s.store.userCount(), 1);

    // A second try with an old or made-up state is refused.
    const bad = await b(`/api/auth/oauth/google/callback?state=nope&code=x`);
    assert.match(loginError(bad), /took too long/);

    // Login CSRF: someone starts a sign-in with THEIR Google account and sends
    // the callback link to Nina. Her browser didn't start it, so it is refused.
    const attacker = browser(origin);
    const to = new URL((await attacker('/api/auth/oauth/google/start')).headers.get('location'));
    const code = fake.issue('google', to.searchParams.get('code_challenge'));
    const victim = browser(origin);
    const trap = await victim(`/api/auth/oauth/google/callback?state=${to.searchParams.get('state')}&code=${code}`);
    assert.match(loginError(trap), /another browser/);
    assert.equal((await stateOf(victim)).user, null);
  } finally {
    s.close();
  }
});

test('a verified email joins the existing password account; an unverified one does not', async () => {
  const { s, fake, origin } = await setup(); // Nina signs up with a password first
  try {
    fake.who.google = { sub: 'g-2', email: 'NINA@example.com', email_verified: true, name: 'Someone' };
    const b = browser(origin);
    await signIn(b, fake, 'google');
    assert.equal((await stateOf(b)).user.id, s.user.id, 'same account');

    // Facebook emails are not trusted for matching: no takeover, no duplicate.
    fake.who.facebook = { id: 'fb-1', email: 'nina@example.com', name: 'Nina' };
    const res = await signIn(browser(origin), fake, 'facebook');
    assert.match(loginError(res), /already exists.*connect Facebook/);
    assert.equal(s.store.userCount(), 1);
  } finally {
    s.close();
  }
});

test('new accounts follow the sign-up rules; X accounts have no email', async () => {
  const { s, fake, origin } = await setup();
  try {
    fake.who.x = { id: '777', name: 'Partner', username: 'partner' };
    let res = await signIn(browser(origin), fake, 'x');
    assert.match(loginError(res), /not allowed/);
    assert.equal(s.store.userCount(), 1);

    process.env.SIGNUP_CODE = 'family';
    try {
      res = await signIn(browser(origin), fake, 'x');
      assert.match(loginError(res), /invite code/);
      const b = browser(origin);
      res = await signIn(b, fake, 'x', { query: '?invite=family' });
      const st = await stateOf(b);
      assert.equal(st.user.name, 'Partner');
      assert.equal(st.user.email, '', 'placeholder address is hidden');
    } finally {
      delete process.env.SIGNUP_CODE;
    }
  } finally {
    s.close();
  }
});

test('GitHub uses the verified primary email', async () => {
  const { s, fake, origin } = await setup();
  try {
    fake.who.github = { id: 42, login: 'nina', name: null };
    fake.who.githubEmails = [
      { email: 'old@example.com', primary: false, verified: true },
      { email: 'nina@example.com', primary: true, verified: true },
    ];
    const b = browser(origin);
    await signIn(b, fake, 'github');
    assert.equal((await stateOf(b)).user.id, s.user.id);
    const github = fake.calls.find((c) => c.url === 'https://api.github.com/user');
    assert.equal(github.init.headers['User-Agent'], 'record.ai');
  } finally {
    s.close();
  }
});

test('Apple: signed client secret, form answer, name from the first sign-in', async () => {
  const { s, fake, origin } = await setup({ noSignup: true });
  try {
    fake.who.apple = { sub: 'apple-1', email: 'abc@privaterelay.appleid.com' };
    const b = browser(origin);
    const res = await signIn(b, fake, 'apple', {
      method: 'POST',
      extra: { user: JSON.stringify({ name: { firstName: 'Nina', lastName: 'K' } }) },
    });
    assert.equal(res.status, 303);
    assert.equal((await stateOf(b)).user.name, 'Nina K');
    const tokenCall = fake.calls.find((c) => c.url === 'https://appleid.apple.com/auth/token');
    const secret = tokenCall.init.body.get('client_secret');
    const [h, p, sig] = secret.split('.');
    assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: appleKey.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    assert.equal(claims.iss, 'TEAM123');
    assert.equal(claims.sub, 'ai.record.web');
    assert.equal(JSON.parse(Buffer.from(h, 'base64url')).kid, 'KEY123');
    assert.equal(tokenCall.init.body.get('code_verifier'), null, 'Apple gets no PKCE');
    assert.ok(appleClientSecret(ENV).split('.').length === 3);
  } finally {
    s.close();
  }
});

test('phone apps: one-time code that only the app holding the secret can use', async () => {
  const { s, fake, origin } = await setup({ noSignup: true });
  try {
    fake.who.google = { sub: 'g-9', email: 'nina@example.com', email_verified: true, name: 'Nina' };
    const verifier = b64url(crypto.randomBytes(32));
    const res = await signIn(browser(origin), fake, 'google', { query: `?app=${sha(verifier)}` });
    assert.equal(res.status, 200);
    const html = await res.text();
    const link = html.match(/href="(recordai:\/\/auth\?code=[^"]+)"/)[1];
    const code = new URL(link.replace(/&#38;/g, '&')).searchParams.get('code');
    assert.equal(res.headers.get('set-cookie'), null, 'the browser sheet is not logged in');

    const exchange = (body) => fetch(`${origin}/api/auth/oauth/exchange`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await exchange({ code, verifier: 'wrong' })).status, 400);
    // A wrong try burns the code, so a thief cannot keep guessing.
    assert.equal((await exchange({ code, verifier })).status, 400);

    const res2 = await signIn(browser(origin), fake, 'google', { query: `?app=${sha(verifier)}` });
    const code2 = new URL((await res2.text()).match(/href="(recordai:[^"]+)"/)[1].replace(/&#38;/g, '&')).searchParams.get('code');
    const ok = await exchange({ code: code2, verifier });
    assert.equal(ok.status, 200);
    const { token, user } = await ok.json();
    assert.equal(user.name, 'Nina');
    const notes = await fetch(`${origin}/api/notes`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(notes.status, 200);
    assert.equal((await exchange({ code: code2, verifier })).status, 400, 'single use');

    // Errors go back to the app too.
    const cancelled = await signIn(browser(origin), fake, 'google', { query: `?app=${sha(verifier)}`, extra: { error: 'access_denied' } });
    assert.match(await cancelled.text(), /recordai:\/\/auth\?error=Sign-in\+was\+cancelled/);
  } finally {
    s.close();
  }
});

test('connect and disconnect providers from the account screen', async () => {
  const { s, fake, origin } = await setup({ noSignup: true });
  try {
    // An account made with X only (no password, no email).
    process.env.ALLOW_SIGNUP = 'true';
    fake.who.x = { id: '5', name: 'Nina' };
    const b = browser(origin);
    await signIn(b, fake, 'x');
    delete process.env.ALLOW_SIGNUP;

    assert.equal((await b('/api/auth/oauth/facebook/start?link=1')).status, 302);
    assert.equal((await browser(origin)('/api/auth/oauth/facebook/start?link=1')).status, 401, 'must be logged in');
    fake.who.facebook = { id: 'fb-7', email: 'nina@example.com', name: 'Nina' };
    const linked = await signIn(b, fake, 'facebook', { query: '?link=1' });
    assert.equal(linked.headers.get('location'), '/?linked=facebook');

    const me = async () => (await b('/api/auth/me')).json();
    let info = await me();
    assert.equal(info.hasPassword, false);
    assert.deepEqual(info.identities.map((i) => i.provider), ['x', 'facebook']);

    // Facebook now logs into the same account.
    const b2 = browser(origin);
    await signIn(b2, fake, 'facebook');
    assert.equal((await stateOf(b2)).user.id, (await stateOf(b)).user.id);

    // The same Facebook account cannot be connected to someone else.
    process.env.ALLOW_SIGNUP = 'true';
    fake.who.google = { sub: 'g-other', email: 'other@example.com', email_verified: true, name: 'Other' };
    const other = browser(origin);
    await signIn(other, fake, 'google');
    delete process.env.ALLOW_SIGNUP;
    const steal = await signIn(other, fake, 'facebook', { query: '?link=1' });
    assert.match(loginError(steal), /already used by another/);

    const del = (p) => b(`/api/auth/identities/${p}`, { method: 'DELETE' });
    assert.equal((await del('x')).status, 200);
    assert.equal((await del('facebook')).status, 409, 'the last way to log in stays');
    // Setting a password needs no current password when there is none yet.
    const pw = await b('/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ next: 'a new password' }) });
    assert.equal(pw.status, 200);
    assert.equal((await del('facebook')).status, 200);
    info = await me();
    assert.equal(info.hasPassword, true);
    assert.deepEqual(info.identities, []);
  } finally {
    s.close();
  }
});
