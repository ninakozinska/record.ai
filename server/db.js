// SQLite storage using Node's built-in driver (no native deps to compile).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const PRIORITIES = ['urgent', 'high', 'normal', 'low'];

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'notes.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS notes (
      id              TEXT PRIMARY KEY,
      text            TEXT NOT NULL DEFAULT '',
      images          TEXT NOT NULL DEFAULT '[]',
      done            INTEGER NOT NULL DEFAULT 0,
      deleted         INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      edited_at       INTEGER NOT NULL,
      -- user overrides (NULL = let the AI decide)
      user_group      TEXT,
      user_priority   TEXT,
      -- AI-owned fields
      title           TEXT,
      summary         TEXT,
      ai_group        TEXT,
      ai_priority     TEXT,
      priority_reason TEXT,
      tags            TEXT NOT NULL DEFAULT '[]',
      due_date        TEXT,
      ai_status       TEXT NOT NULL DEFAULT 'pending',
      ai_error        TEXT,
      -- monotonically increasing change counter used for sync
      rev             INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notes_rev ON notes(rev);
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return new Store(db);
}

function rowToNote(r) {
  if (!r) return null;
  return {
    id: r.id,
    text: r.text,
    images: JSON.parse(r.images),
    done: !!r.done,
    deleted: !!r.deleted,
    created_at: r.created_at,
    edited_at: r.edited_at,
    user_group: r.user_group,
    user_priority: r.user_priority,
    title: r.title,
    summary: r.summary,
    ai_group: r.ai_group,
    ai_priority: r.ai_priority,
    priority_reason: r.priority_reason,
    tags: JSON.parse(r.tags),
    due_date: r.due_date,
    ai_status: r.ai_status,
    ai_error: r.ai_error,
    group: r.user_group || r.ai_group || 'Inbox',
    priority: r.user_priority || r.ai_priority || 'normal',
    rev: r.rev,
  };
}

class Store {
  constructor(db) {
    this.db = db;
    const row = db.prepare('SELECT MAX(rev) AS m FROM notes').get();
    this.rev = row.m || 0;
  }

  nextRev() {
    this.rev += 1;
    return this.rev;
  }

  get(id) {
    return rowToNote(this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id));
  }

  changesSince(rev) {
    return this.db
      .prepare('SELECT * FROM notes WHERE rev > ? ORDER BY rev')
      .all(rev)
      .map(rowToNote);
  }

  active() {
    return this.db
      .prepare('SELECT * FROM notes WHERE deleted = 0 ORDER BY created_at')
      .all()
      .map(rowToNote);
  }

  /**
   * Apply a client edit. Last write wins on `edited_at`, so an offline device
   * replaying an old edit cannot clobber a newer one from another device.
   * Returns { note, contentChanged } or { note, stale: true }.
   */
  upsertFromClient(input) {
    const existing = this.get(input.id);
    if (existing && existing.edited_at > input.edited_at) {
      return { note: existing, stale: true };
    }
    const images = JSON.stringify(input.images ?? existing?.images ?? []);
    const text = input.text ?? existing?.text ?? '';
    const contentChanged =
      !existing || existing.text !== text || JSON.stringify(existing.images) !== images;
    const rev = this.nextRev();
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO notes (id, text, images, done, deleted, created_at, edited_at,
             user_group, user_priority, ai_status, rev)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          input.id,
          text,
          images,
          input.done ? 1 : 0,
          input.deleted ? 1 : 0,
          input.created_at ?? input.edited_at,
          input.edited_at,
          input.user_group ?? null,
          input.user_priority ?? null,
          rev,
        );
    } else {
      const pick = (k) => (k in input ? input[k] : existing[k]);
      this.db
        .prepare(
          `UPDATE notes SET text = ?, images = ?, done = ?, deleted = ?, edited_at = ?,
             user_group = ?, user_priority = ?,
             ai_status = CASE WHEN ? THEN 'pending' ELSE ai_status END,
             rev = ?
           WHERE id = ?`,
        )
        .run(
          text,
          images,
          pick('done') ? 1 : 0,
          pick('deleted') ? 1 : 0,
          input.edited_at,
          pick('user_group') ?? null,
          pick('user_priority') ?? null,
          contentChanged ? 1 : 0,
          rev,
          input.id,
        );
    }
    return { note: this.get(input.id), contentChanged };
  }

  /** Write AI-owned fields. Never touches user-owned fields. */
  applyAi(id, ai) {
    const rev = this.nextRev();
    this.db
      .prepare(
        `UPDATE notes SET
           title = COALESCE(?, title), summary = COALESCE(?, summary),
           ai_group = COALESCE(?, ai_group), ai_priority = COALESCE(?, ai_priority),
           priority_reason = COALESCE(?, priority_reason),
           tags = COALESCE(?, tags), due_date = ?,
           ai_status = ?, ai_error = ?, rev = ?
         WHERE id = ?`,
      )
      .run(
        ai.title ?? null,
        ai.summary ?? null,
        ai.group ?? null,
        ai.priority ?? null,
        ai.priority_reason ?? null,
        ai.tags ? JSON.stringify(ai.tags) : null,
        ai.due_date === undefined ? this.get(id)?.due_date ?? null : ai.due_date,
        ai.status,
        ai.error ?? null,
        rev,
        id,
      );
    return this.get(id);
  }

  pendingIds() {
    return this.db
      .prepare("SELECT id FROM notes WHERE ai_status = 'pending' AND deleted = 0 ORDER BY edited_at")
      .all()
      .map((r) => r.id);
  }

  groups() {
    return this.db
      .prepare(
        `SELECT COALESCE(user_group, ai_group) AS name, COUNT(*) AS count
         FROM notes WHERE deleted = 0 AND COALESCE(user_group, ai_group) IS NOT NULL
         GROUP BY name ORDER BY count DESC`,
      )
      .all()
      .map((r) => ({ name: r.name, count: r.count }));
  }

  referencedImages() {
    const set = new Set();
    for (const r of this.db.prepare('SELECT images FROM notes').all()) {
      for (const name of JSON.parse(r.images)) set.add(name);
    }
    return set;
  }

  addSession(token) {
    this.db.prepare('INSERT INTO sessions (token, created_at) VALUES (?, ?)').run(token, Date.now());
  }

  hasSession(token) {
    return !!this.db.prepare('SELECT 1 FROM sessions WHERE token = ?').get(token);
  }

  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }
}
