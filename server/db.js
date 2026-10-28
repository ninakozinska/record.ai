// SQLite storage using Node's built-in driver (no native deps to compile).
import crypto from 'node:crypto';
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
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name       TEXT NOT NULL,
      pw_hash    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    -- uploaded photos and who owns them
    CREATE TABLE IF NOT EXISTS images (
      name       TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  migrate(db);
  return new Store(db);
}

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

/** Upgrades databases created before accounts existed. */
function migrate(db) {
  if (!columns(db, 'notes').includes('user_id')) {
    db.exec('ALTER TABLE notes ADD COLUMN user_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS notes_user_rev ON notes(user_id, rev)');
  // Lists: an item is a small note that belongs to another note (its list).
  if (!columns(db, 'notes').includes('parent_id')) {
    db.exec('ALTER TABLE notes ADD COLUMN parent_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS notes_parent ON notes(parent_id)');
  // Dates: the AI's time of day, and the person's own date/time (overrides the AI's).
  if (!columns(db, 'notes').includes('due_time')) db.exec('ALTER TABLE notes ADD COLUMN due_time TEXT');
  if (!columns(db, 'notes').includes('user_due')) db.exec('ALTER TABLE notes ADD COLUMN user_due TEXT');
  // Sessions used to be anonymous (one shared password). Start over with
  // per-user sessions that store only a hash of the token.
  if (!columns(db, 'sessions').includes('user_id')) {
    db.exec('DROP TABLE IF EXISTS sessions');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash   TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      device       TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    -- "Continue with Google" etc.: which provider account belongs to which user
    CREATE TABLE IF NOT EXISTS identities (
      provider   TEXT NOT NULL,
      subject    TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      email      TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (provider, subject)
    );
    CREATE INDEX IF NOT EXISTS identities_user ON identities(user_id);
    -- Sharing: a note (with its items) or a whole group, shared with someone by email.
    -- user_id is filled in once that email has an account.
    CREATE TABLE IF NOT EXISTS shares (
      id         TEXT PRIMARY KEY,
      owner_id   TEXT NOT NULL,
      kind       TEXT NOT NULL,              -- 'note' or 'group'
      target     TEXT NOT NULL,              -- the note id, or the group name
      email      TEXT NOT NULL COLLATE NOCASE,
      user_id    TEXT,
      role       TEXT NOT NULL,              -- 'edit' or 'view'
      created_at INTEGER NOT NULL,
      UNIQUE (owner_id, kind, target, email)
    );
    CREATE INDEX IF NOT EXISTS shares_user ON shares(user_id);
    CREATE INDEX IF NOT EXISTS shares_owner ON shares(owner_id);
    -- Shared notes a person may have on their devices, so each device can be
    -- told to remove them when sharing stops. visible = 0 once it stopped.
    CREATE TABLE IF NOT EXISTS share_seen (
      user_id TEXT NOT NULL,
      note_id TEXT NOT NULL,
      visible INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, note_id)
    ) WITHOUT ROWID;
  `);
}

// The group a note counts in for sharing: an item counts in its list's group.
const ROOT_GROUP = `CASE WHEN n.parent_id IS NULL THEN COALESCE(n.user_group, n.ai_group, 'Inbox')
  ELSE COALESCE(p.user_group, p.ai_group, 'Inbox') END`;
// Shares that cover note n (joined with its list p) for its owner.
const SHARE_MATCHES = `s.owner_id = n.user_id AND (
  (s.kind = 'note' AND s.target = COALESCE(n.parent_id, n.id))
  OR (s.kind = 'group' AND s.target = ${ROOT_GROUP} COLLATE NOCASE))`;

function rowToShare(r) {
  return r ? { id: r.id, owner_id: r.owner_id, kind: r.kind, target: r.target, email: r.email, user_id: r.user_id, role: r.role, created_at: r.created_at } : null;
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const SESSION_MAX_IDLE = 400 * 24 * 3600e3;

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
    // user_due: null = the AI decides, '' = no date, 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM'.
    user_due: r.user_due ?? null,
    ai_due_date: r.due_date,
    ai_due_time: r.due_time ?? null,
    due_date: r.user_due == null ? r.due_date : r.user_due.slice(0, 10) || null,
    due_time: r.user_due == null ? r.due_time ?? null : r.user_due.slice(11, 16) || null,
    ai_status: r.ai_status,
    ai_error: r.ai_error,
    group: r.user_group || r.ai_group || 'Inbox',
    priority: r.user_priority || r.ai_priority || 'normal',
    rev: r.rev,
    user_id: r.user_id,
    parent_id: r.parent_id ?? null,
  };
}

function rowToUser(r) {
  return r ? { id: r.id, email: r.email, name: r.name, created_at: r.created_at } : null;
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

  /**
   * Everything that changed after `rev`. `items: false` leaves out list items
   * (for apps that don't show lists yet); `shared: true` adds notes others
   * shared with this person (each with its `role`), and a removal notice
   * ({ id, deleted, revoked }) for shared notes they can no longer see.
   */
  changesSince(userId, rev, { items = true, shared = false } = {}) {
    const own = this.db
      .prepare('SELECT * FROM notes WHERE user_id = ? AND rev > ?' + (items ? '' : ' AND parent_id IS NULL') + ' ORDER BY rev')
      .all(userId, rev)
      .map(rowToNote);
    if (!shared) return own;
    const onlyLists = items ? '' : ' AND n.parent_id IS NULL';
    // An item is sent again when its list changed, e.g. when the list moved into a shared group.
    const visible = this.db
      .prepare(
        `SELECT n.*, MAX(s.role = 'edit') AS can_edit FROM notes n
         LEFT JOIN notes p ON p.id = n.parent_id
         JOIN shares s ON s.user_id = ? AND ${SHARE_MATCHES}
         WHERE n.user_id != ? AND (n.rev > ? OR p.rev > ?)${onlyLists}
         GROUP BY n.id`,
      )
      .all(userId, userId, rev, rev)
      .map((r) => this.forRecipient(userId, rowToNote(r), r.can_edit ? 'edit' : 'view'));
    const ids = new Set(visible.map((n) => n.id));
    const gone = this.db
      .prepare(
        `SELECT n.* FROM share_seen ss JOIN notes n ON n.id = ss.note_id
         LEFT JOIN notes p ON p.id = n.parent_id
         WHERE ss.user_id = ? AND (n.rev > ? OR p.rev > ?)${onlyLists}`,
      )
      .all(userId, rev, rev)
      .filter((r) => !ids.has(r.id))
      .map((r) => this.revoked(userId, rowToNote(r)));
    return [...own, ...visible, ...gone].sort((a, b) => a.rev - b.rev);
  }

  /** Open notes (not list items) of one user, or of everyone when userId is omitted. */
  active(userId) {
    const sql = 'SELECT * FROM notes WHERE deleted = 0 AND parent_id IS NULL' + (userId ? ' AND user_id = ?' : '') + ' ORDER BY created_at';
    return this.db
      .prepare(sql)
      .all(...(userId ? [userId] : []))
      .map(rowToNote);
  }

  /**
   * Apply a client edit. Last write wins on `edited_at`, so an offline device
   * replaying an old edit cannot clobber a newer one from another device.
   * Returns { note, contentChanged }, { note, stale: true } or { forbidden: true }
   * when the id belongs to someone else's note.
   */
  upsertFromClient(userId, input) {
    const existing = this.get(input.id);
    if (existing && existing.user_id !== userId) {
      // Someone it was shared with: editors change the text, photos, done and
      // the items; the owner's groups and priorities stay the owner's, and only
      // the owner deletes the list itself.
      if (this.access(userId, existing) !== 'edit') return { forbidden: true };
      delete input.user_group;
      if (!existing.parent_id) {
        delete input.user_priority;
        delete input.deleted;
      }
    }
    if (existing && existing.edited_at > input.edited_at) {
      return { note: existing, stale: true };
    }
    // A list item belongs to the list's owner (one level only); people the list
    // is shared with for editing can add items too.
    const parentId = existing ? existing.parent_id : input.parent_id ?? null;
    let ownerId = existing ? existing.user_id : userId;
    if (!existing && parentId) {
      const parent = this.get(parentId);
      if (parent) {
        if (parent.parent_id) return { forbidden: true };
        if (parent.user_id !== userId && this.access(userId, parent) !== 'edit') return { forbidden: true };
        ownerId = parent.user_id;
      }
    }
    const images = JSON.stringify(input.images ?? existing?.images ?? []);
    const text = input.text ?? existing?.text ?? '';
    const contentChanged =
      !existing || existing.text !== text || JSON.stringify(existing.images) !== images;
    const rev = this.nextRev();
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO notes (id, user_id, parent_id, text, images, done, deleted, created_at, edited_at,
             user_group, user_priority, user_due, ai_status, rev)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          ownerId,
          parentId,
          text,
          images,
          input.done ? 1 : 0,
          input.deleted ? 1 : 0,
          input.created_at ?? input.edited_at,
          input.edited_at,
          input.user_group ?? null,
          input.user_priority ?? null,
          input.user_due ?? null,
          // Items aren't sent to the AI: only their list is.
          parentId ? 'done' : 'pending',
          rev,
        );
    } else {
      const pick = (k) => (k in input ? input[k] : existing[k]);
      this.db
        .prepare(
          `UPDATE notes SET text = ?, images = ?, done = ?, deleted = ?, edited_at = ?,
             user_group = ?, user_priority = ?, user_due = ?,
             ai_status = CASE WHEN ? AND parent_id IS NULL THEN 'pending' ELSE ai_status END,
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
          pick('user_due') ?? null,
          contentChanged ? 1 : 0,
          rev,
          input.id,
        );
    }
    return { note: this.get(input.id), contentChanged: contentChanged && !parentId };
  }

  /** Items of a list, in the order they were added. */
  items(parentId) {
    return this.db
      .prepare('SELECT * FROM notes WHERE parent_id = ? AND deleted = 0 ORDER BY created_at')
      .all(parentId)
      .map(rowToNote);
  }

  /** Deleting a list deletes its items too. Returns the items it changed. */
  deleteItems(parentId) {
    const changed = [];
    for (const item of this.items(parentId)) {
      this.db.prepare('UPDATE notes SET deleted = 1, edited_at = ?, rev = ? WHERE id = ?').run(Date.now(), this.nextRev(), item.id);
      changed.push(this.get(item.id));
    }
    return changed;
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
           tags = COALESCE(?, tags), due_date = ?, due_time = ?,
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
        ai.due_date === undefined ? this.get(id)?.ai_due_date ?? null : ai.due_date,
        ai.due_time === undefined ? this.get(id)?.ai_due_time ?? null : ai.due_date ? ai.due_time : null,
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

  groups(userId) {
    return this.db
      .prepare(
        `SELECT COALESCE(user_group, ai_group) AS name, COUNT(*) AS count
         FROM notes WHERE user_id = ? AND deleted = 0 AND parent_id IS NULL AND COALESCE(user_group, ai_group) IS NOT NULL
         GROUP BY name ORDER BY count DESC`,
      )
      .all(userId)
      .map((r) => ({ name: r.name, count: r.count }));
  }

  /** Groups the person created themselves ("My groups"): always shown, kept by the AI. */
  myGroups(userId) {
    try {
      return JSON.parse(this.getMeta(`my_groups:${userId}`) || '[]');
    } catch {
      return [];
    }
  }

  setMyGroups(userId, names) {
    this.setMeta(`my_groups:${userId}`, JSON.stringify(names));
  }

  // --- sharing ----------------------------------------------------------------

  /** 'owner', 'edit', 'view' or null: what this person may do with a note. */
  access(userId, note) {
    if (!note) return null;
    if (note.user_id === userId) return 'owner';
    return this.audience(note).get(userId) ?? null;
  }

  /** Everyone a note is shared with (who has an account): Map userId -> 'edit' | 'view'. */
  audience(note) {
    const rows = this.db
      .prepare(
        `SELECT s.user_id, MAX(s.role = 'edit') AS can_edit FROM notes n
         LEFT JOIN notes p ON p.id = n.parent_id
         JOIN shares s ON s.user_id IS NOT NULL AND ${SHARE_MATCHES}
         WHERE n.id = ? GROUP BY s.user_id`,
      )
      .all(note.id);
    return new Map(rows.map((r) => [r.user_id, r.can_edit ? 'edit' : 'view']));
  }

  /** A shared note as its recipient gets it; remembers that they may have it. */
  forRecipient(userId, note, role) {
    this.db
      .prepare('INSERT INTO share_seen (user_id, note_id, visible) VALUES (?, ?, 1) ON CONFLICT DO UPDATE SET visible = 1')
      .run(userId, note.id);
    return { ...note, role, owner_name: this.getUser(note.user_id)?.name ?? '' };
  }

  /** Tells a former recipient to remove a note (without its contents). */
  revoked(userId, note) {
    this.db.prepare('UPDATE share_seen SET visible = 0 WHERE user_id = ? AND note_id = ?').run(userId, note.id);
    return { id: note.id, parent_id: note.parent_id, user_id: note.user_id, rev: note.rev, edited_at: note.edited_at, deleted: true, revoked: true };
  }

  /** People who can currently have this note on their devices. */
  seenBy(noteId) {
    return this.db.prepare('SELECT user_id FROM share_seen WHERE note_id = ? AND visible = 1').all(noteId).map((r) => r.user_id);
  }

  getShare(id) {
    return rowToShare(this.db.prepare('SELECT * FROM shares WHERE id = ?').get(id));
  }

  /** Shares I made (with the person's name once they have an account). */
  sharesBy(ownerId) {
    return this.db
      .prepare('SELECT s.*, u.name AS name FROM shares s LEFT JOIN users u ON u.id = s.user_id WHERE s.owner_id = ? ORDER BY s.created_at')
      .all(ownerId)
      .map((r) => ({ ...rowToShare(r), name: r.name ?? null }));
  }

  /** What others shared with me, and who shared it. */
  sharesWith(userId) {
    return this.db
      .prepare(
        `SELECT s.*, u.name AS owner_name, u.email AS owner_email FROM shares s JOIN users u ON u.id = s.owner_id
         WHERE s.user_id = ? ORDER BY s.created_at`,
      )
      .all(userId)
      .map((r) => ({ ...rowToShare(r), owner: { id: r.owner_id, name: r.owner_name, email: r.owner_email } }));
  }

  shareCount(ownerId) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM shares WHERE owner_id = ?').get(ownerId).n;
  }

  /** Shares a note or group with an email address; sharing again changes the role. */
  addShare(ownerId, { kind, target, email, role }) {
    const user = this.findUserByEmail(email);
    const existing = this.db
      .prepare('SELECT id FROM shares WHERE owner_id = ? AND kind = ? AND target = ? AND email = ?')
      .get(ownerId, kind, target, email);
    if (existing) {
      this.db.prepare('UPDATE shares SET role = ?, user_id = ? WHERE id = ?').run(role, user?.id ?? null, existing.id);
      return this.getShare(existing.id);
    }
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO shares (id, owner_id, kind, target, email, user_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, ownerId, kind, target, email, user?.id ?? null, role, Date.now());
    return this.getShare(id);
  }

  setShareRole(id, role) {
    this.db.prepare('UPDATE shares SET role = ? WHERE id = ?').run(role, id);
    return this.getShare(id);
  }

  removeShare(id) {
    this.db.prepare('DELETE FROM shares WHERE id = ?').run(id);
  }

  /**
   * Gives the notes a share covers a new revision, so every device of the
   * owner and of the person picks up the change (a new share, a new role, or
   * an ended one) at its next sync. Returns those notes.
   */
  touchShare(share) {
    const rows = this.db
      .prepare(
        `SELECT n.id FROM notes n LEFT JOIN notes p ON p.id = n.parent_id
         WHERE n.user_id = ? AND CASE ? WHEN 'note' THEN COALESCE(n.parent_id, n.id) = ?
           ELSE ${ROOT_GROUP} = ? COLLATE NOCASE END`,
      )
      .all(share.owner_id, share.kind, share.target, share.target);
    return rows.map(({ id }) => {
      this.db.prepare('UPDATE notes SET rev = ? WHERE id = ?').run(this.nextRev(), id);
      return this.get(id);
    });
  }

  // --- images ---------------------------------------------------------------

  imageOwner(name) {
    return this.db.prepare('SELECT user_id FROM images WHERE name = ?').get(name)?.user_id ?? null;
  }

  /** A photo can be seen by its uploader and by anyone who can see a note it is in. */
  canSeeImage(userId, name) {
    if (this.imageOwner(name) === userId) return true;
    return this.db
      .prepare('SELECT * FROM notes WHERE images LIKE ? AND deleted = 0')
      .all(`%"${name}"%`)
      .some((r) => this.access(userId, rowToNote(r)));
  }

  addImage(name, userId) {
    this.db
      .prepare('INSERT OR IGNORE INTO images (name, user_id, created_at) VALUES (?, ?, ?)')
      .run(name, userId, Date.now());
  }

  // --- users ----------------------------------------------------------------

  /** The first account: the server's owner. */
  firstUserId() {
    return this.db.prepare('SELECT id FROM users ORDER BY created_at, rowid LIMIT 1').get()?.id ?? null;
  }

  userCount() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  getUser(id) {
    return rowToUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  findUserByEmail(email) {
    const r = this.db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim());
    return r ? { ...rowToUser(r), pw_hash: r.pw_hash } : null;
  }

  /**
   * Creates an account. The very first account also takes over everything
   * created before accounts existed (notes and photos), so nothing is lost.
   */
  createUser({ email, name, pwHash, imagesDir }) {
    const id = crypto.randomUUID();
    const first = this.userCount() === 0;
    this.db
      .prepare('INSERT INTO users (id, email, name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, email.trim(), name.trim(), pwHash, Date.now());
    // Things shared with this email before the account existed.
    this.db.prepare('UPDATE shares SET user_id = ? WHERE email = ? AND user_id IS NULL').run(id, email.trim());
    if (first) {
      const legacy = this.db.prepare('SELECT id FROM notes WHERE user_id IS NULL').all();
      for (const { id: noteId } of legacy) {
        this.db.prepare('UPDATE notes SET user_id = ?, rev = ? WHERE id = ?').run(id, this.nextRev(), noteId);
      }
      if (imagesDir && fs.existsSync(imagesDir)) {
        for (const entry of fs.readdirSync(imagesDir, { withFileTypes: true })) {
          if (entry.isFile()) this.addImage(entry.name, id);
        }
      }
    }
    return this.getUser(id);
  }

  setPassword(userId, pwHash) {
    this.db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(pwHash, userId);
  }

  passwordHash(userId) {
    return this.db.prepare('SELECT pw_hash FROM users WHERE id = ?').get(userId)?.pw_hash ?? null;
  }

  // --- sign-in with Google, Apple, … ------------------------------------------

  identityUser(provider, subject) {
    const r = this.db.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?').get(provider, String(subject));
    return r ? this.getUser(r.user_id) : null;
  }

  addIdentity(userId, provider, subject, email) {
    this.db
      .prepare('INSERT OR REPLACE INTO identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(provider, String(subject), userId, email || null, Date.now());
  }

  identities(userId) {
    return this.db.prepare('SELECT provider, email FROM identities WHERE user_id = ? ORDER BY created_at').all(userId);
  }

  removeIdentity(userId, provider) {
    return this.db.prepare('DELETE FROM identities WHERE user_id = ? AND provider = ?').run(userId, provider).changes;
  }

  // --- sessions ---------------------------------------------------------------

  /** Creates a session and returns its secret token (only the hash is stored). */
  createSession(userId, device) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, device) VALUES (?, ?, ?, ?, ?)')
      .run(hashToken(token), userId, now, now, device ? String(device).slice(0, 200) : null);
    return token;
  }

  /** Returns the session's user, or null when the token is unknown or expired. */
  sessionUser(token) {
    if (!token) return null;
    const h = hashToken(token);
    const s = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(h);
    if (!s) return null;
    const now = Date.now();
    if (now - s.last_used_at > SESSION_MAX_IDLE) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h);
      return null;
    }
    if (now - s.last_used_at > 3600e3) {
      this.db.prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?').run(now, h);
    }
    const user = this.getUser(s.user_id);
    return user ? { ...user, sessionHash: h } : null;
  }

  deleteSession(token) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  /** Logs a user out everywhere, optionally keeping one session. */
  deleteUserSessions(userId, keepHash = null) {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash IS NOT ?').run(userId, keepHash);
  }

  sessionCount(userId) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId).n;
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
