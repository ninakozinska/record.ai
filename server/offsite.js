// A second copy of the whole database, outside Fly.io: every night a compressed
// copy goes to Cloudflare R2 (any S3-compatible storage works), is read back to
// check it arrived whole, and copies older than 30 days are removed.
//
// Turned on by four server secrets (see docs/BACKUPS.md):
//   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET
// Without them it does nothing. If a copy fails, the server's admins get an
// email (or, without email set up, a line in the server log).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export const OFFSITE_KEEP_DAYS = 30;
const PREFIX = 'db/';

export function r2Config(env = process.env) {
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secret = env.R2_SECRET_ACCESS_KEY;
  const endpoint = (env.R2_ENDPOINT || '').replace(/\/+$/, '');
  const bucket = env.R2_BUCKET;
  if (!accessKeyId || !secret || !endpoint || !bucket) return null;
  return { accessKeyId, secret, endpoint, bucket };
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// RFC 3986 encoding, as AWS Signature Version 4 requires.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * AWS Signature Version 4 (what R2 and every S3-compatible service accept).
 * Returns the Authorization header for a request whose headers are all signed.
 */
export function signV4({ method, url, headers, payloadHash, accessKeyId, secret, amzDate, region = 'auto', service = 's3' }) {
  const u = new URL(url);
  const date = amzDate.slice(0, 8);
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const request = [method, u.pathname || '/', query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(request)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export class Offsite {
  constructor({ store, dataDir, env = process.env, fetch = globalThis.fetch, now = () => new Date(), notify = async () => {}, log = console }) {
    this.store = store;
    this.dataDir = dataDir;
    this.config = r2Config(env);
    this.fetch = fetch;
    this.now = now;
    this.notify = notify;
    this.log = log;
  }

  get enabled() { return !!this.config; }

  async request(method, key = '', { body, query = {} } = {}) {
    const { endpoint, bucket, accessKeyId, secret } = this.config;
    const url = new URL(`${endpoint}/${enc(bucket)}${key ? `/${key.split('/').map(enc).join('/')}` : ''}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const amzDate = this.now().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const payloadHash = sha256(body || '');
    const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    const authorization = signV4({ method, url: url.toString(), headers, payloadHash, accessKeyId, secret, amzDate });
    const send = { ...headers, authorization };
    delete send.host;
    if (body) send['content-type'] = 'application/gzip';
    return this.fetch(url, { method, headers: send, body });
  }

  /** The keys of the copies in the bucket, oldest first. */
  async list() {
    const keys = [];
    let token;
    do {
      const query = { 'list-type': '2', prefix: PREFIX, ...(token ? { 'continuation-token': token } : {}) };
      const res = await this.request('GET', '', { query });
      if (!res.ok) throw new Error(`listing the bucket failed (${res.status})`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xml.match(/<NextContinuationToken>([^<]+)</)?.[1] : null;
    } while (token);
    return keys.sort();
  }

  /** A consistent copy of the database, compressed. */
  snapshot() {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sortmemo-offsite-')), 'notes.db');
    try {
      this.store.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      return zlib.gzipSync(fs.readFileSync(tmp));
    } finally {
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
  }

  /**
   * Once a day (called every hour; does nothing twice): upload today's copy,
   * read it back, remove copies older than 30 days. Returns what it did.
   */
  async runNightly() {
    if (!this.enabled) return null;
    const now = this.now();
    const day = now.toISOString().slice(0, 10);
    if (this.store.getMeta('offsite_last') === day) return null;
    const key = `${PREFIX}${day}.db.gz`;
    try {
      const body = this.snapshot();
      const put = await this.request('PUT', key, { body });
      if (!put.ok) throw new Error(`the upload was refused (${put.status})`);
      // Read it back: a copy is only a copy if it can be fetched whole.
      const back = await this.request('GET', key);
      const got = back.ok ? Buffer.from(await back.arrayBuffer()) : null;
      if (!got || got.length !== body.length) throw new Error(`the copy in R2 is missing or incomplete (${back.status})`);
      const cutoff = new Date(now.getTime() - OFFSITE_KEEP_DAYS * 86400e3).toISOString().slice(0, 10);
      const removed = [];
      for (const k of await this.list()) {
        const d = k.slice(PREFIX.length, PREFIX.length + 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) {
          const del = await this.request('DELETE', k);
          if (del.ok || del.status === 204) removed.push(k);
        }
      }
      this.store.setMeta('offsite_last', day);
      this.store.setMeta('offsite_failed', '');
      this.log.log(`offsite backup: ${key} (${body.length} bytes)${removed.length ? `, removed ${removed.length} old` : ''}`);
      return { key, bytes: body.length, removed };
    } catch (err) {
      this.log.error(`offsite backup failed: ${err.message}`);
      // One email a day, not one an hour.
      if (this.store.getMeta('offsite_failed') !== day) {
        this.store.setMeta('offsite_failed', day);
        await this.notify(`Tonight's copy of the SortMemo database to Cloudflare R2 failed: ${err.message}.\n\nThe server keeps its own backups, so nothing is lost. Ask Claude to look at the server log (fly logs) and fix it.`).catch(() => {});
      }
      return { error: err.message };
    }
  }
}
