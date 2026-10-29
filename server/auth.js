// Accounts: sign up, log in, log out, change password.
//
// Who may sign up:
//  - the very first account can always be created (it becomes the owner and
//    takes over notes made before accounts existed);
//  - after that only with ALLOW_SIGNUP=true, or with the invite code in
//    SIGNUP_CODE.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { configuredProviders, oauthRoutes, OAuthError, PROVIDERS } from './oauth.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'notes_session';
const COOKIE_MAX_AGE = 400 * 24 * 3600;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD = 8;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [kind, n, r, p, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p });
  return crypto.timingSafeEqual(key, expected);
}

// A dummy hash so that unknown emails take as long as wrong passwords.
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

/** Slows down password guessing: 10 failures per 15 minutes per IP and per email. */
class Throttle {
  constructor(limit = 10, windowMs = 15 * 60e3) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  blocked(...keys) {
    const now = Date.now();
    return keys.some((k) => {
      const h = this.hits.get(k);
      return h && now - h.start < this.windowMs && h.count >= this.limit;
    });
  }
  fail(...keys) {
    const now = Date.now();
    for (const k of keys) {
      const h = this.hits.get(k);
      if (!h || now - h.start >= this.windowMs) this.hits.set(k, { start: now, count: 1 });
      else h.count++;
    }
  }
  clear(...keys) {
    for (const k of keys) this.hits.delete(k);
  }
}

export function getToken(req) {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const m = (req.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m?.[1];
}

export function signupPolicy(store) {
  if (store.userCount() === 0) return { open: true, needsCode: false, firstAccount: true };
  if (process.env.ALLOW_SIGNUP === 'true') return { open: true, needsCode: false, firstAccount: false };
  if (process.env.SIGNUP_CODE) return { open: true, needsCode: true, firstAccount: false };
  return { open: false, needsCode: false, firstAccount: false };
}

// Accounts made with a provider that shares no email (X) get a placeholder
// address that can never receive mail; it is never shown.
const NO_EMAIL = '@no-email.invalid';
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email.endsWith(NO_EMAIL) ? '' : u.email });

export function authRoutes({ store, imagesDir, throttle = new Throttle(), oauth = {}, onSignup = () => {} }) {
  const router = express.Router();
  const env = oauth.env || process.env;

  const startSession = (req, res, user, { json = true } = {}) => {
    const token = store.createSession(user.id, req.get('user-agent'));
    const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure}`);
    if (json) res.json({ token, user: publicUser(user) });
  };

  /** A new account from "Continue with …". Same rules as signing up with a password. */
  const createAccount = (profile, invite) => {
    const policy = signupPolicy(store);
    if (!policy.open) throw new OAuthError('New accounts are not allowed on this server. Ask its owner for an invite.');
    if (policy.needsCode && invite !== process.env.SIGNUP_CODE) {
      throw new OAuthError('This server needs an invite code. Choose "Create an account", enter the code, then use the button again.');
    }
    const email = profile.email || `${String(profile.id).replace(/[^A-Za-z0-9._-]/g, '')}.${profile.provider}${NO_EMAIL}`;
    const name = String(profile.name || '').trim() || (profile.email ? profile.email.split('@')[0] : 'record.ai user');
    const user = store.createUser({ email, name: name.slice(0, 80), pwHash: '', imagesDir });
    onSignup(user, { method: profile.provider });
    return user;
  };

  router.use('/oauth', oauthRoutes({
    store,
    env,
    fetch: oauth.fetch,
    startSession,
    createAccount: (profile, invite) => createAccount(profile, invite),
    currentUser: (req) => store.sessionUser(getToken(req)),
  }));

  const clearCookie = (res) => res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);

  // Public: what the login screen should show.
  router.get('/state', (req, res) => {
    const user = store.sessionUser(getToken(req));
    const policy = signupPolicy(store);
    res.json({ user: user ? publicUser(user) : null, signup: policy, providers: configuredProviders(env) });
  });

  router.post('/signup', async (req, res) => {
    const { name, email, password, code } = req.body || {};
    const policy = signupPolicy(store);
    if (!policy.open) return res.status(403).json({ error: 'New accounts are not allowed on this server. Ask its owner for an invite.' });
    if (policy.needsCode && String(code || '') !== process.env.SIGNUP_CODE) {
      return res.status(403).json({ error: 'The invite code is not correct.' });
    }
    if (!String(name || '').trim()) return res.status(400).json({ error: 'Please enter your name.' });
    if (!EMAIL.test(String(email || '').trim())) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (String(password || '').length < MIN_PASSWORD) {
      return res.status(400).json({ error: `The password needs at least ${MIN_PASSWORD} characters.` });
    }
    if (store.findUserByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists. Log in instead.' });
    const user = store.createUser({
      email: String(email),
      name: String(name).slice(0, 80),
      pwHash: await hashPassword(String(password)),
      imagesDir,
    });
    onSignup(user, { method: 'email', anonId: req.get('x-anon-id') });
    startSession(req, res, user);
  });

  router.post('/login', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const keys = [`ip:${req.ip}`, `email:${email}`];
    if (throttle.blocked(...keys)) {
      return res.status(429).json({ error: 'Too many attempts. Please wait 15 minutes and try again.' });
    }
    const found = store.findUserByEmail(email);
    const ok = await verifyPassword(password, found?.pw_hash ?? (await DUMMY_HASH));
    if (!found || !ok) {
      throttle.fail(...keys);
      return res.status(401).json({ error: 'Wrong email or password.' });
    }
    throttle.clear(`email:${email}`);
    startSession(req, res, found);
  });

  router.post('/logout', (req, res) => {
    const token = getToken(req);
    if (token) store.deleteSession(token);
    clearCookie(res);
    res.json({ ok: true });
  });

  // Everything below needs a logged-in user.
  router.use((req, res, next) => {
    const user = store.sessionUser(getToken(req));
    if (!user) return res.status(401).json({ error: 'Login required', loginRequired: true });
    req.user = user;
    next();
  });

  router.get('/me', (req, res) => {
    res.json({
      user: publicUser(req.user),
      devices: store.sessionCount(req.user.id),
      hasPassword: !!store.passwordHash(req.user.id),
      identities: store.identities(req.user.id).map((i) => ({ provider: i.provider, name: PROVIDERS[i.provider]?.name || i.provider, email: i.email })),
      providers: configuredProviders(env),
    });
  });

  /** Disconnect "Continue with …", as long as another way to log in is left. */
  router.delete('/identities/:provider', (req, res) => {
    const others = store.identities(req.user.id).filter((i) => i.provider !== req.params.provider).length;
    if (!others && !store.passwordHash(req.user.id)) {
      return res.status(409).json({ error: 'Set a password first, so you can still log in.' });
    }
    if (!store.removeIdentity(req.user.id, req.params.provider)) return res.status(404).json({ error: 'Not connected.' });
    res.json({ ok: true });
  });

  router.post('/logout-others', (req, res) => {
    store.deleteUserSessions(req.user.id, req.user.sessionHash);
    res.json({ ok: true, devices: store.sessionCount(req.user.id) });
  });

  router.post('/password', async (req, res) => {
    const { current, next } = req.body || {};
    // Accounts made with Google etc. have no password yet: they can set one without it.
    const stored = store.passwordHash(req.user.id);
    if (stored && !(await verifyPassword(String(current || ''), stored))) {
      return res.status(403).json({ error: 'Your current password is not correct.' });
    }
    if (String(next || '').length < MIN_PASSWORD) {
      return res.status(400).json({ error: `The new password needs at least ${MIN_PASSWORD} characters.` });
    }
    store.setPassword(req.user.id, await hashPassword(String(next)));
    // Other devices must log in again with the new password.
    store.deleteUserSessions(req.user.id, req.user.sessionHash);
    res.json({ ok: true });
  });

  return router;
}

/** Express middleware for the rest of the API. */
export function requireUser(store) {
  return (req, res, next) => {
    const user = store.sessionUser(getToken(req));
    if (!user) return res.status(401).json({ error: 'Login required', loginRequired: true });
    req.user = user;
    next();
  };
}
