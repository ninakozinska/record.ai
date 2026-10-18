// Local-first storage (IndexedDB) and the sync engine.
//
// Every edit is applied locally first and queued in an "outbox". The outbox
// is flushed to the server whenever we're online; the server pushes changes
// from other devices over Server-Sent Events, and we also pull incrementally
// by revision number when reconnecting.

const DB_NAME = 'record-ai';
const AI_FIELDS = ['title', 'summary', 'ai_group', 'ai_priority', 'priority_reason', 'tags', 'due_date', 'ai_status', 'ai_error', 'rev'];

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function openIdb() {
  const open = indexedDB.open(DB_NAME, 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    db.createObjectStore('notes', { keyPath: 'id' });
    db.createObjectStore('outbox', { keyPath: 'key' });
    db.createObjectStore('blobs');
    db.createObjectStore('meta');
  };
  return req(open);
}

export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
}

export function effective(note) {
  return {
    ...note,
    group: note.user_group || note.ai_group || 'Inbox',
    priority: note.user_priority || note.ai_priority || 'normal',
  };
}

export class Local extends EventTarget {
  async init() {
    this.db = await openIdb();
    this.notes = new Map();
    for (const n of await this.all('notes')) this.notes.set(n.id, n);
    this.rev = (await this.metaGet('rev')) || 0;
    this.pending = new Set((await this.all('outbox')).filter((o) => o.kind === 'note').map((o) => o.id));
    this.blobUrls = new Map();
    this.online = false;
    this.needsLogin = false;
  }

  tx(store, mode = 'readonly') {
    return this.db.transaction(store, mode).objectStore(store);
  }
  all(store) {
    return req(this.tx(store).getAll());
  }
  metaGet(k) {
    return req(this.tx('meta').get(k));
  }
  metaSet(k, v) {
    return req(this.tx('meta', 'readwrite').put(v, k));
  }

  changed() {
    this.dispatchEvent(new Event('change'));
  }
  setStatus(patch) {
    Object.assign(this, patch);
    this.dispatchEvent(new Event('status'));
  }

  list() {
    return [...this.notes.values()].filter((n) => !n.deleted).map(effective);
  }

  // ---- local edits -----------------------------------------------------------

  /** Create or update a note. `patch` contains only user-owned fields. */
  async save(id, patch) {
    const now = Date.now();
    const prev = this.notes.get(id);
    const note = {
      id,
      text: '',
      images: [],
      done: false,
      deleted: false,
      created_at: now,
      tags: [],
      ai_status: 'pending',
      ...prev,
      ...patch,
      edited_at: Math.max(now, (prev?.edited_at || 0) + 1),
    };
    const contentChanged = !prev || prev.text !== note.text || JSON.stringify(prev.images) !== JSON.stringify(note.images);
    if (contentChanged && !note.deleted) note.ai_status = 'pending';
    this.notes.set(id, note);
    await req(this.tx('notes', 'readwrite').put(note));

    const box = this.tx('outbox', 'readwrite');
    const key = 'note:' + id;
    const existing = await req(box.get(key));
    const body = { ...(existing?.body || { created_at: note.created_at }), ...patch, edited_at: note.edited_at };
    await req(this.tx('outbox', 'readwrite').put({ key, kind: 'note', id, body }));
    this.pending.add(id);
    this.changed();
    this.flush();
    return note;
  }

  /** Stores a photo (and its small preview) on the device and queues the upload. */
  async addImage(blob, thumb) {
    const ext = blob.type === 'image/png' ? 'png' : 'jpg';
    const name = `${uuid()}.${ext}`;
    await req(this.tx('blobs', 'readwrite').put(blob, name));
    if (thumb) await req(this.tx('blobs', 'readwrite').put(thumb, name + '#thumb'));
    await req(this.tx('outbox', 'readwrite').put({ key: 'img:' + name, kind: 'image', name }));
    this.flush();
    return name;
  }

  /** URL of a photo; `thumb` gives the small preview used in lists. */
  async imageUrl(name, { thumb = false } = {}) {
    const key = thumb ? name + '#thumb' : name;
    if (this.blobUrls.has(key)) return this.blobUrls.get(key);
    const blob = (await req(this.tx('blobs').get(key))) || (thumb ? await req(this.tx('blobs').get(name)) : null);
    if (!blob) return `api/images/${name}${thumb ? '?variant=thumb' : ''}`;
    const url = URL.createObjectURL(blob);
    this.blobUrls.set(key, url);
    return url;
  }

  // ---- server communication ---------------------------------------------------

  async api(path, opts = {}) {
    const res = await fetch('api/' + path, { credentials: 'same-origin', ...opts });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.startsWith('auth/')) this.setStatus({ needsLogin: true });
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    return data;
  }

  /** Logs in (or signs up) and makes sure local data belongs to that account. */
  async authenticate(kind, fields) {
    const { user } = await this.api(`auth/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    await this.useAccount(user);
    this.setStatus({ needsLogin: false, user });
    this.start();
    return user;
  }

  /** Notes cached on this device belong to one account; switching accounts clears them. */
  async useAccount(user) {
    const previous = await this.metaGet('userId');
    if (previous && previous !== user.id) await this.wipe();
    await this.metaSet('userId', user.id);
    await this.metaSet('user', user);
  }

  async wipe() {
    for (const store of ['notes', 'outbox', 'blobs', 'meta']) await req(this.tx(store, 'readwrite').clear());
    this.notes.clear();
    this.pending.clear();
    this.rev = 0;
    this.changed();
  }

  async unsentCount() {
    return (await this.all('outbox')).length;
  }

  /** Logs out and removes this account's notes from the device. */
  async logout() {
    this.es?.close();
    await this.api('auth/logout', { method: 'POST' }).catch(() => {});
    await this.wipe();
    this.setStatus({ user: null, needsLogin: true, online: false });
  }

  start() {
    this.connect();
    this.pull();
    this.flush();
    if (!this.started) {
      this.started = true;
      window.addEventListener('online', () => { this.connect(); this.pull(); this.flush(); });
      window.addEventListener('offline', () => this.setStatus({ online: false }));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') { this.pull(); this.flush(); }
      });
      setInterval(() => this.flush(), 30000);
    }
  }

  connect() {
    this.es?.close();
    const es = new EventSource('api/events');
    this.es = es;
    es.addEventListener('hello', (e) => {
      const { ai } = JSON.parse(e.data);
      this.setStatus({ online: true, ai });
      this.pull();
      this.flush();
    });
    es.addEventListener('note', (e) => this.merge([JSON.parse(e.data)]));
    es.addEventListener('status', (e) => this.setStatus({ ai: JSON.parse(e.data) }));
    es.onerror = async () => {
      this.setStatus({ online: false });
      // EventSource retries by itself, except after an HTTP error (e.g. 401).
      if (es.readyState === EventSource.CLOSED) {
        try {
          await this.api('status');
          setTimeout(() => this.connect(), 3000);
        } catch (err) {
          if (err.status !== 401) setTimeout(() => this.connect(), 10000);
        }
      }
    };
  }

  async pull() {
    if (this.pulling) return;
    this.pulling = true;
    try {
      const { rev, notes } = await this.api(`notes?since=${this.rev}`);
      await this.merge(notes);
      // A server whose database was reset would have a lower rev; resync fully.
      if (rev < this.rev) {
        // The server's database was replaced: drop the cached copies and load everything again.
        this.rev = 0;
        this.notes.clear();
        await req(this.tx('notes', 'readwrite').clear());
        this.pulling = false;
        return this.pull();
      }
      this.rev = rev;
      await this.metaSet('rev', rev);
      this.setStatus({ online: true });
    } catch (err) {
      if (err.status !== 401) this.setStatus({ online: false });
    } finally {
      this.pulling = false;
    }
  }

  /** Merge notes coming from the server. */
  async merge(serverNotes) {
    if (!serverNotes.length) return;
    const store = this.tx('notes', 'readwrite');
    for (const s of serverNotes) {
      const local = this.notes.get(s.id);
      // Replies and live updates can arrive out of order; never let an older
      // server state (lower revision) overwrite a newer one.
      if (local?.rev != null && s.rev != null && s.rev < local.rev) continue;
      let next = s;
      if (local && (this.pending.has(s.id) || local.edited_at > s.edited_at)) {
        // Our unsent edit wins for user fields; still take fresh AI output.
        next = { ...local };
        for (const k of AI_FIELDS) next[k] = s[k];
        // Only a change to the text or photos makes the AI work again.
        const contentDiffers = local.text !== s.text || JSON.stringify(local.images) !== JSON.stringify(s.images);
        if (contentDiffers) next.ai_status = 'pending';
      }
      this.notes.set(s.id, next);
      store.put(next);
    }
    this.changed();
  }

  /**
   * Sends everything waiting in the outbox: photos first (each with its
   * preview), then all note changes in ONE request, which also brings back
   * whatever changed on the server.
   */
  async flush() {
    if (this.needsLogin) return;
    if (this.flushing) {
      // An edit made while sending: send it as soon as this round finishes.
      this.flushAgain = true;
      return;
    }
    this.flushing = true;
    this.flushAgain = false;
    let sent = false;
    try {
      const items = await this.all('outbox');
      for (const item of items.filter((i) => i.kind === 'image')) {
        const blob = await req(this.tx('blobs').get(item.name));
        if (blob) {
          const thumb = await req(this.tx('blobs').get(item.name + '#thumb'));
          if (thumb) {
            await this.api(`images/${item.name}?variant=thumb`, { method: 'PUT', headers: { 'Content-Type': thumb.type }, body: thumb });
          }
          await this.api(`images/${item.name}`, { method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob });
        }
        await req(this.tx('outbox', 'readwrite').delete(item.key));
      }
      const notes = items.filter((i) => i.kind === 'note');
      const since = this.rev;
      const { rev, results, notes: changed } = await this.api('sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ since, changes: notes.map((i) => ({ id: i.id, ...i.body })) }),
      });
      for (const [k, item] of notes.entries()) {
        // Sent (or refused for good): clear it, unless a newer edit was queued meanwhile.
        if (!results[k]) continue;
        const current = await req(this.tx('outbox').get(item.key));
        if (current && current.body.edited_at === item.body.edited_at) {
          await req(this.tx('outbox', 'readwrite').delete(item.key));
          this.pending.delete(item.id);
        }
      }
      await this.merge(changed);
      if (rev >= this.rev && since === this.rev) {
        this.rev = rev;
        await this.metaSet('rev', rev);
      }
      sent = true;
      this.setStatus({ online: true, unsent: (await this.all('outbox')).length });
    } catch (err) {
      const unsent = (await this.all('outbox')).length;
      this.setStatus({ unsent, online: err.status ? this.online : false });
    } finally {
      this.flushing = false;
    }
    if (sent && this.flushAgain) return this.flush();
  }
}
