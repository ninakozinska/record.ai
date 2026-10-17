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

  async addImage(blob) {
    const ext = blob.type === 'image/png' ? 'png' : 'jpg';
    const name = `${uuid()}.${ext}`;
    await req(this.tx('blobs', 'readwrite').put(blob, name));
    await req(this.tx('outbox', 'readwrite').put({ key: 'img:' + name, kind: 'image', name }));
    this.flush();
    return name;
  }

  async imageUrl(name) {
    if (this.blobUrls.has(name)) return this.blobUrls.get(name);
    const blob = await req(this.tx('blobs').get(name));
    if (!blob) return `api/images/${name}`;
    const url = URL.createObjectURL(blob);
    this.blobUrls.set(name, url);
    return url;
  }

  // ---- server communication ---------------------------------------------------

  async api(path, opts = {}) {
    const res = await fetch('api/' + path, { credentials: 'same-origin', ...opts });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== 'login') this.setStatus({ needsLogin: true });
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    return data;
  }

  async login(password) {
    await this.api('login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    this.setStatus({ needsLogin: false });
    this.start();
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
        this.rev = 0;
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
      let next = s;
      if (local && (this.pending.has(s.id) || local.edited_at > s.edited_at)) {
        // Our unsent edit wins for user fields; still take fresh AI output.
        next = { ...local };
        for (const k of AI_FIELDS) next[k] = s[k];
        if (local.edited_at !== s.edited_at) next.ai_status = 'pending';
      }
      this.notes.set(s.id, next);
      store.put(next);
    }
    this.changed();
  }

  async flush() {
    if (this.flushing || this.needsLogin) return;
    this.flushing = true;
    try {
      const items = await this.all('outbox');
      // Images first so notes never reference a missing file for long.
      items.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'image' ? -1 : 1));
      for (const item of items) {
        if (item.kind === 'image') {
          const blob = await req(this.tx('blobs').get(item.name));
          if (blob) {
            await this.api(`images/${item.name}`, { method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob });
          }
          await req(this.tx('outbox', 'readwrite').delete(item.key));
        } else {
          const { note } = await this.api(`notes/${item.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item.body),
          });
          // Only clear the outbox entry if no newer edit was queued meanwhile.
          const current = await req(this.tx('outbox').get(item.key));
          if (current && current.body.edited_at === item.body.edited_at) {
            await req(this.tx('outbox', 'readwrite').delete(item.key));
            this.pending.delete(item.id);
          }
          await this.merge([note]);
        }
      }
      this.setStatus({ online: true, unsent: 0 });
    } catch (err) {
      const unsent = (await this.all('outbox')).length;
      this.setStatus({ unsent, online: err.status ? this.online : false });
    } finally {
      this.flushing = false;
    }
  }
}
