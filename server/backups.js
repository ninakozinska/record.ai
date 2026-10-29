// Backups (a premium feature) and "download all my notes" (for everyone).
//
// A backup is one person's own notes (lists with their items, groups, dates)
// as gzip'd JSON in DATA_DIR/backups/<user id>/. Photos never change once
// uploaded and stay on the server's disk, so a backup only needs their names.
// Premium accounts get one automatically every day, kept 30 days, and can
// make more by hand. Restoring brings the account back to how it was then
// (after first saving a backup of how it is now, so a restore can be undone).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const KEEP_DAYS = 30;
const KEEP_MANUAL = 10;
const ID = /^\d{4}-\d{2}-\d{2}(T\d{2}-\d{2}-\d{2}-(manual|before-restore))?$/;
export const premium = (plan) => plan === 'solo' || plan === 'family';

export class Backups {
  constructor({ store, dataDir, imagesDir }) {
    this.store = store;
    this.dir = path.join(dataDir, 'backups');
    this.imagesDir = imagesDir;
  }

  userDir(userId) {
    return path.join(this.dir, userId.replace(/[^A-Za-z0-9-]/g, ''));
  }

  /** The person's own notes, as a backup holds them (shared-with-me notes belong to others). */
  snapshot(userId) {
    const notes = this.store.changesSince(userId, 0).filter((n) => !n.deleted);
    return {
      version: 1,
      created_at: Date.now(),
      user: { id: userId },
      myGroups: this.store.myGroups(userId),
      notes: notes.map((n) => ({
        id: n.id, parent_id: n.parent_id, text: n.text, images: n.images, done: n.done,
        created_at: n.created_at, edited_at: n.edited_at,
        user_group: n.user_group, user_priority: n.user_priority, user_due: n.user_due,
        title: n.title, summary: n.summary, ai_group: n.ai_group, ai_priority: n.ai_priority,
        priority_reason: n.priority_reason, tags: n.tags, ai_due_date: n.ai_due_date, ai_due_time: n.ai_due_time,
        ai_status: n.ai_status,
      })),
    };
  }

  /** Saves a backup now. kind: 'daily' (one per day), 'manual' or 'before-restore'. */
  create(userId, kind = 'manual', now = new Date()) {
    const day = now.toISOString().slice(0, 10);
    const id = kind === 'daily' ? day : `${day}T${now.toISOString().slice(11, 19).replaceAll(':', '-')}-${kind}`;
    const dir = this.userDir(userId);
    fs.mkdirSync(dir, { recursive: true });
    const data = zlib.gzipSync(JSON.stringify(this.snapshot(userId)));
    fs.writeFileSync(path.join(dir, `${id}.json.gz`), data);
    this.prune(userId, now);
    return this.info(userId, id);
  }

  info(userId, id) {
    const file = path.join(this.userDir(userId), `${id}.json.gz`);
    if (!ID.test(id) || !fs.existsSync(file)) return null;
    const stat = fs.statSync(file);
    const kind = id.endsWith('-manual') ? 'manual' : id.endsWith('-before-restore') ? 'before-restore' : 'daily';
    return { id, kind, created_at: stat.mtimeMs, bytes: stat.size, notes: this.read(userId, id).notes.length };
  }

  list(userId) {
    const dir = this.userDir(userId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json.gz'))
      .map((f) => this.info(userId, f.slice(0, -'.json.gz'.length)))
      .filter(Boolean)
      .sort((a, b) => b.created_at - a.created_at);
  }

  read(userId, id) {
    if (!ID.test(id)) return null;
    const file = path.join(this.userDir(userId), `${id}.json.gz`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  }

  /** Daily backups older than 30 days go; the 10 newest hand-made ones stay. */
  prune(userId, now = new Date()) {
    const cutoff = now.getTime() - KEEP_DAYS * 864e5;
    const all = this.list(userId);
    const manual = all.filter((b) => b.kind !== 'daily');
    for (const b of all) {
      const tooOld = b.kind === 'daily' && Date.parse(b.id) < cutoff;
      const tooMany = b.kind !== 'daily' && manual.indexOf(b) >= KEEP_MANUAL;
      if (tooOld || tooMany) fs.rmSync(path.join(this.userDir(userId), `${b.id}.json.gz`), { force: true });
    }
  }

  /** Once a day for every premium account (called every hour; does nothing twice). */
  runDaily(now = new Date()) {
    const made = [];
    for (const u of this.store.allUsers()) {
      if (!premium(this.store.planOf(u.id))) continue;
      const day = now.toISOString().slice(0, 10);
      if (fs.existsSync(path.join(this.userDir(u.id), `${day}.json.gz`))) continue;
      made.push(this.create(u.id, 'daily', now));
    }
    return made;
  }

  /**
   * Brings the account back to the backup: its notes return as they were,
   * notes made since are deleted. Returns the notes changed (for live updates).
   */
  restore(userId, id) {
    const backup = this.read(userId, id);
    if (!backup) return null;
    this.create(userId, 'before-restore');
    const now = Date.now();
    const changed = [];
    const keep = new Set(backup.notes.map((n) => n.id));
    for (const n of this.store.changesSince(userId, 0)) {
      if (n.deleted || keep.has(n.id)) continue;
      const r = this.store.upsertFromClient(userId, { id: n.id, deleted: true, edited_at: now });
      if (r.note) changed.push(r.note);
    }
    // Lists before their items, so every item finds its list.
    const ordered = [...backup.notes].sort((a, b) => (a.parent_id ? 1 : 0) - (b.parent_id ? 1 : 0));
    for (const n of ordered) {
      const r = this.store.upsertFromClient(userId, {
        id: n.id, parent_id: n.parent_id, text: n.text, images: n.images, done: n.done, deleted: false,
        created_at: n.created_at, user_group: n.user_group, user_priority: n.user_priority, user_due: n.user_due ?? null,
        edited_at: now,
      });
      if (r.forbidden) continue;
      // The AI's work comes back too, so restoring costs no AI calls.
      changed.push(this.store.applyAi(n.id, {
        title: n.title, summary: n.summary, group: n.ai_group, priority: n.ai_priority, priority_reason: n.priority_reason,
        tags: n.tags, due_date: n.ai_due_date ?? null, due_time: n.ai_due_time ?? null,
        status: n.parent_id ? 'done' : n.ai_status === 'pending' ? 'pending' : n.ai_status || 'done',
      }));
    }
    if (Array.isArray(backup.myGroups)) this.store.setMyGroups(userId, backup.myGroups);
    return changed;
  }

  /**
   * Everything the person owns as one .tar.gz: notes.json (all fields),
   * notes.md (readable) and their photos. Written to `out` as it is built.
   */
  async exportTo(userId, out) {
    const snap = this.snapshot(userId);
    const gz = zlib.createGzip();
    gz.pipe(out);
    // Waits while the download catches up, so big photo sets don't pile up in memory.
    const write = (buf) => (gz.write(buf) ? Promise.resolve() : new Promise((r) => gz.once('drain', r)));
    const add = async (name, data) => {
      await write(tarHeader(name, data.length));
      await write(data);
      await write(Buffer.alloc((512 - (data.length % 512)) % 512));
    };
    await add('record-ai/notes.json', Buffer.from(JSON.stringify(snap, null, 2)));
    await add('record-ai/notes.md', Buffer.from(markdown(snap)));
    const images = new Set(snap.notes.flatMap((n) => n.images));
    for (const name of images) {
      const file = path.join(this.imagesDir, name);
      if (/^[a-zA-Z0-9-]{8,64}\.(jpg|jpeg|png|webp|gif)$/.test(name) && fs.existsSync(file)) {
        await add(`record-ai/photos/${name}`, fs.readFileSync(file));
      }
    }
    gz.end(Buffer.alloc(1024)); // two empty blocks end a tar file
    await new Promise((resolve) => out.on('finish', resolve).on('close', resolve));
  }
}

/** A 512-byte ustar header for one file. */
function tarHeader(name, size) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

function markdown(snap) {
  const lists = snap.notes.filter((n) => !n.parent_id);
  const itemsOf = (id) => snap.notes.filter((n) => n.parent_id === id);
  const lines = [`# My record.ai notes`, '', `Exported ${new Date(snap.created_at).toISOString().slice(0, 10)}, ${lists.length} notes.`, ''];
  for (const n of lists) {
    const heading = n.title || n.text.split('\n')[0] || 'Note';
    lines.push(`## ${n.done ? '[done] ' : ''}${heading}`);
    const meta = [n.user_group || n.ai_group, n.user_priority || n.ai_priority, n.user_due || n.ai_due_date].filter(Boolean);
    if (meta.length) lines.push(`*${meta.join(' · ')}*`);
    if (n.text.trim() && n.text.trim() !== heading) lines.push('', n.text.trim());
    for (const i of itemsOf(n.id)) lines.push(`- [${i.done ? 'x' : ' '}] ${i.text}`);
    if (n.images.length) lines.push('', ...n.images.map((i) => `![photo](photos/${i})`));
    lines.push('');
  }
  return lines.join('\n');
}
