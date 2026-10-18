// "Continue with Google / Apple / Microsoft / Facebook / LinkedIn / X / GitHub".
//
// A provider appears on the login screens once its keys are in the settings
// (.env), e.g. GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET. See docs/SOCIAL_LOGIN.md.
//
// Web:   /api/auth/oauth/<provider>/start → the provider's page → .../callback,
//        which logs the browser in (cookie) and goes back to the app.
// Phone: the app opens .../start?app=<challenge> in a browser sheet. The callback
//        sends it back to recordai://auth?code=…, and the app trades that code,
//        plus the secret behind <challenge>, for a login token at /oauth/exchange.
//        So a stolen code is useless to anyone but the app that started.
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const decodeJwt = (jwt) => JSON.parse(Buffer.from(String(jwt).split('.')[1] || '', 'base64url').toString() || 'null');

const STATE_TTL = 10 * 60e3;
// Ties a web sign-in to the browser that started it, so nobody can slip
// their own sign-in into someone else's browser (login CSRF).
const FLOW_COOKIE = 'oauth_flow';
const flowCookie = (req) => (req.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${FLOW_COOKIE}=([^;]+)`))?.[1];
const APP_CODE_TTL = 2 * 60e3;
export const APP_SCHEME = 'recordai';

/**
 * Each provider: where to send people, how to trade the code for a token, and
 * how to read who they are. `verified` = the provider confirmed the email, so
 * it may be matched to an existing account with that email.
 */
export const PROVIDERS = {
  google: {
    name: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    extra: { prompt: 'select_account' },
    profile: (u) => ({ id: u.sub, email: u.email, verified: u.email_verified === true, name: u.name }),
  },
  apple: {
    name: 'Apple',
    authorize: 'https://appleid.apple.com/auth/authorize',
    token: 'https://appleid.apple.com/auth/token',
    scope: 'name email',
    // Apple posts the answer back as a form when name or email are asked for.
    extra: { response_mode: 'form_post' },
    pkce: false,
    keys: ['CLIENT_ID', 'TEAM_ID', 'KEY_ID', 'PRIVATE_KEY'],
  },
  microsoft: {
    name: 'Microsoft',
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userinfo: 'https://graph.microsoft.com/oidc/userinfo',
    scope: 'openid email profile',
    extra: { prompt: 'select_account' },
    // Microsoft lets organisations set any email, so it is never trusted for matching.
    profile: (u) => ({ id: u.sub, email: u.email, verified: false, name: u.name }),
  },
  facebook: {
    name: 'Facebook',
    authorize: 'https://www.facebook.com/v21.0/dialog/oauth',
    token: 'https://graph.facebook.com/v21.0/oauth/access_token',
    userinfo: 'https://graph.facebook.com/v21.0/me?fields=id,name,email',
    scope: 'public_profile,email',
    profile: (u) => ({ id: u.id, email: u.email, verified: false, name: u.name }),
  },
  linkedin: {
    name: 'LinkedIn',
    authorize: 'https://www.linkedin.com/oauth/v2/authorization',
    token: 'https://www.linkedin.com/oauth/v2/accessToken',
    userinfo: 'https://api.linkedin.com/v2/userinfo',
    scope: 'openid profile email',
    pkce: false,
    profile: (u) => ({ id: u.sub, email: u.email, verified: u.email_verified === true, name: u.name }),
  },
  x: {
    name: 'X (Twitter)',
    env: 'X',
    authorize: 'https://x.com/i/oauth2/authorize',
    token: 'https://api.x.com/2/oauth2/token',
    userinfo: 'https://api.x.com/2/users/me',
    scope: 'users.read tweet.read',
    basicAuth: true,
    // X does not share email addresses.
    profile: (u) => ({ id: u.data?.id, email: null, verified: false, name: u.data?.name || u.data?.username }),
  },
  github: {
    name: 'GitHub',
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    userinfo: 'https://api.github.com/user',
    emails: 'https://api.github.com/user/emails',
    scope: 'read:user user:email',
    profile: (u) => ({ id: u.id != null ? String(u.id) : undefined, email: null, verified: false, name: u.name || u.login }),
  },
};

const envPrefix = (id) => PROVIDERS[id].env || id.toUpperCase();

/** The providers whose keys are set, in display order. */
export function configuredProviders(env = process.env) {
  return Object.entries(PROVIDERS)
    .filter(([id, p]) => (p.keys || ['CLIENT_ID', 'CLIENT_SECRET'])
      .every((k) => env[`${envPrefix(id)}_${k}`] || (k === 'PRIVATE_KEY' && env[`${envPrefix(id)}_PRIVATE_KEY_FILE`])))
    .map(([id, p]) => ({ id, name: p.name }));
}

/** Apple's "client secret" is a short-lived token signed with the .p8 key from the Apple developer site. */
export function appleClientSecret(env, now = Date.now()) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: env.APPLE_KEY_ID }));
  const iat = Math.floor(now / 1000);
  const payload = b64url(JSON.stringify({
    iss: env.APPLE_TEAM_ID, iat, exp: iat + 300, aud: 'https://appleid.apple.com', sub: env.APPLE_CLIENT_ID,
  }));
  // The key itself, or (easier) the path of the .p8 file downloaded from Apple.
  const key = env.APPLE_PRIVATE_KEY
    ? String(env.APPLE_PRIVATE_KEY).replace(/\\n/g, '\n')
    : fs.readFileSync(env.APPLE_PRIVATE_KEY_FILE, 'utf8');
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64url(sig)}`;
}

class OAuthError extends Error {}

const escHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Hands the result to the phone app: the page opens recordai://… right away
 * (the iPhone's sign-in sheet catches that), with a button for Android
 * browsers that only open an app after a tap.
 */
function backToApp(res, url) {
  const href = escHtml(url);
  res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>record.ai</title>
<meta http-equiv="refresh" content="0;url=${href}">
<body style="font:17px system-ui;text-align:center;padding:48px 16px">
<p>Returning to record.ai…</p>
<p><a id="go" href="${href}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#4f46e5;color:#fff;text-decoration:none">Open record.ai</a></p>
<script>location.href = document.getElementById('go').href;</script>
</body>`);
}

/**
 * Routes under /api/auth/oauth. `startSession(req, res, user, opts)` logs in;
 * `createAccount(profile, invite)` makes a new account (or throws OAuthError);
 * `currentUser(req)` is who is logged in already, if anyone.
 */
export function oauthRoutes({ store, env = process.env, fetch: fetchImpl = fetch, startSession, createAccount, currentUser }) {
  const router = express.Router();
  const pending = new Map(); // state -> what to do when the provider answers
  const appCodes = new Map(); // one-time code for the phone apps -> { userId, challenge, expires }

  const prune = (map) => {
    const now = Date.now();
    for (const [k, v] of map) if (v.expires < now) map.delete(k);
  };
  const enabled = (id) => configuredProviders(env).some((p) => p.id === id);
  const key = (id, k) => env[`${envPrefix(id)}_${k}`];
  const baseUrl = (req) => (env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

  router.get('/:provider/start', (req, res) => {
    const id = req.params.provider;
    if (!enabled(id)) return res.status(404).send('This sign-in option is not set up on this server.');
    const p = PROVIDERS[id];
    prune(pending);
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(32));
    const redirectUri = `${baseUrl(req)}/api/auth/oauth/${id}/callback`;
    const app = typeof req.query.app === 'string' && /^[A-Za-z0-9_-]{43}$/.test(req.query.app) ? req.query.app : null;
    // "Connect" from the account screen: add this provider to the logged-in account.
    const linkUser = req.query.link ? currentUser(req) : null;
    if (req.query.link && !linkUser) return res.status(401).send('Please log in first.');
    pending.set(state, {
      provider: id, verifier, redirectUri, app, linkUserId: linkUser?.id || null,
      invite: typeof req.query.invite === 'string' ? req.query.invite.slice(0, 200) : '',
      expires: Date.now() + STATE_TTL,
    });
    if (!app) {
      // Apple answers with a cross-site POST, which only carries SameSite=None cookies (HTTPS only).
      const secure = req.secure || req.get('x-forwarded-proto') === 'https';
      res.setHeader('Set-Cookie', `${FLOW_COOKIE}=${state}; Path=/api/auth/oauth; HttpOnly; Max-Age=${STATE_TTL / 1000}; ${secure ? 'SameSite=None; Secure' : 'SameSite=Lax'}`);
    }
    const params = new URLSearchParams({
      client_id: key(id, 'CLIENT_ID'),
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: p.scope,
      state,
      ...(p.pkce === false ? {} : { code_challenge: b64url(sha256(verifier)), code_challenge_method: 'S256' }),
      ...p.extra,
    });
    res.redirect(`${p.authorize}?${params}`);
  });

  // Apple answers with a POST; everyone else with a GET.
  const callback = async (req, res) => {
    const q = { ...req.query, ...(req.body || {}) };
    const flow = pending.get(String(q.state || ''));
    pending.delete(String(q.state || ''));
    const id = req.params.provider;
    if (!flow || flow.provider !== id || flow.expires < Date.now()) {
      return finish(res, null, { error: 'The sign-in took too long or was already used. Please try again.' });
    }
    if (!flow.app && flowCookie(req) !== q.state) {
      return finish(res, null, { error: 'This sign-in was started in another browser. Please try again here.' });
    }
    try {
      if (q.error) throw new OAuthError(q.error === 'access_denied' || q.error === 'user_cancelled_authorize'
        ? 'Sign-in was cancelled.' : `${PROVIDERS[id].name} refused the sign-in (${String(q.error).slice(0, 60)}).`);
      if (!q.code) throw new OAuthError('No sign-in code came back. Please try again.');
      const profile = await identify(id, String(q.code), flow, q.user);
      if (!profile.id) throw new OAuthError(`${PROVIDERS[id].name} did not say who you are. Please try again.`);

      const owner = store.identityUser(id, profile.id);
      if (flow.linkUserId) {
        if (owner && owner.id !== flow.linkUserId) {
          throw new OAuthError(`This ${PROVIDERS[id].name} account is already used by another record.ai account.`);
        }
        store.addIdentity(flow.linkUserId, id, profile.id, profile.email);
        return finish(res, flow, { linked: id });
      }
      let user = owner;
      if (!user && profile.email && profile.verified) {
        user = store.findUserByEmail(profile.email);
        if (user) store.addIdentity(user.id, id, profile.id, profile.email);
      }
      if (!user) {
        if (profile.email && store.findUserByEmail(profile.email)) {
          throw new OAuthError(`An account with ${profile.email} already exists. Log in the way you did before, then connect ${PROVIDERS[id].name} under your initials → Sign-in options.`);
        }
        user = await createAccount({ ...profile, provider: id }, flow.invite);
        store.addIdentity(user.id, id, profile.id, profile.email);
      }
      return finish(res, flow, { user, req });
    } catch (err) {
      if (!(err instanceof OAuthError)) console.error(`Sign-in with ${id} failed:`, err.message);
      return finish(res, flow, { error: err instanceof OAuthError ? err.message : `Sign-in with ${PROVIDERS[id]?.name || id} failed. Please try again.` });
    }
  };
  router.get('/:provider/callback', callback);
  router.post('/:provider/callback', express.urlencoded({ extended: false, limit: '20kb' }), callback);

  /** Where to go after the provider answered: back to the web app, or back to the phone app. */
  function finish(res, flow, { user, req, error, linked }) {
    if (flow?.app) {
      const q = new URLSearchParams();
      if (user) {
        prune(appCodes);
        const code = b64url(crypto.randomBytes(24));
        appCodes.set(code, { userId: user.id, challenge: flow.app, expires: Date.now() + APP_CODE_TTL });
        q.set('code', code);
      } else {
        q.set('error', error || 'Sign-in failed.');
      }
      return backToApp(res, `${APP_SCHEME}://auth?${q}`);
    }
    if (user) startSession(req, res, user, { json: false });
    const q = error ? `?login_error=${encodeURIComponent(error)}` : linked ? `?linked=${linked}` : '';
    res.redirect(303, `/${q}`);
  }

  /** The phone apps trade the one-time code (and their secret) for a login token. */
  router.post('/exchange', express.json(), (req, res) => {
    const { code, verifier } = req.body || {};
    const entry = appCodes.get(String(code || ''));
    appCodes.delete(String(code || ''));
    if (!entry || entry.expires < Date.now() || b64url(sha256(String(verifier || ''))) !== entry.challenge) {
      return res.status(400).json({ error: 'The sign-in expired. Please try again.' });
    }
    const user = store.getUser(entry.userId);
    if (!user) return res.status(400).json({ error: 'This account no longer exists.' });
    startSession(req, res, user);
  });

  /** Trades the provider's code for a token, then asks who signed in. */
  async function identify(id, code, flow, appleUser) {
    const p = PROVIDERS[id];
    const form = { grant_type: 'authorization_code', code, redirect_uri: flow.redirectUri };
    if (p.pkce !== false) form.code_verifier = flow.verifier;
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    const secret = id === 'apple' ? appleClientSecret(env) : key(id, 'CLIENT_SECRET');
    if (p.basicAuth) {
      headers.Authorization = `Basic ${Buffer.from(`${key(id, 'CLIENT_ID')}:${secret}`).toString('base64')}`;
    } else {
      Object.assign(form, { client_id: key(id, 'CLIENT_ID'), client_secret: secret });
    }
    const tokenRes = await fetchImpl(p.token, { method: 'POST', headers, body: new URLSearchParams(form) });
    const tokens = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || (!tokens.access_token && !tokens.id_token)) {
      throw new Error(`token request ${tokenRes.status}: ${tokens.error || ''} ${tokens.error_description || ''}`);
    }

    if (id === 'apple') {
      // The id_token comes straight from Apple over HTTPS in answer to our own signed request.
      const claims = decodeJwt(tokens.id_token) || {};
      if (claims.aud !== key(id, 'CLIENT_ID') || claims.iss !== 'https://appleid.apple.com') throw new Error('unexpected Apple token');
      // Apple sends the name only the very first time, as a form field.
      let name = '';
      try {
        const n = JSON.parse(appleUser || '{}').name || {};
        name = [n.firstName, n.lastName].filter(Boolean).join(' ');
      } catch { /* no name */ }
      return { id: claims.sub, email: claims.email, verified: claims.email_verified === true || claims.email_verified === 'true', name };
    }

    const get = async (url) => {
      const r = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json', 'User-Agent': 'record.ai' },
      });
      if (!r.ok) throw new Error(`profile request ${r.status}`);
      return r.json();
    };
    const profile = p.profile(await get(p.userinfo));
    if (p.emails) {
      // GitHub: use the primary email only if GitHub has verified it.
      const list = await get(p.emails).catch(() => []);
      const primary = Array.isArray(list) ? list.find((e) => e.primary && e.verified) : null;
      if (primary) Object.assign(profile, { email: primary.email, verified: true });
    }
    return profile;
  }

  return router;
}

export { OAuthError };
