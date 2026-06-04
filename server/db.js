/**
 * Database layer for the Unternehmens-Imperium backend.
 *
 * Uses Node's built-in SQLite (node:sqlite, Node ≥ 22) — no native npm
 * dependency to compile. Exposes small, prepared-statement-backed helpers so
 * the route layer never writes SQL inline (which also makes SQL-injection
 * impossible: every value is bound, never string-concatenated).
 */
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? join(__dirname, 'imperium.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;'); // wait instead of failing on a brief write lock

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT UNIQUE NOT NULL,
    email          TEXT,
    password_hash  TEXT,
    salt           TEXT,
    token          TEXT,
    token_expires  INTEGER NOT NULL DEFAULT 0,
    email_verified INTEGER NOT NULL DEFAULT 0,
    verify_token   TEXT,
    verify_expires INTEGER NOT NULL DEFAULT 0,
    reset_token    TEXT,
    reset_expires  INTEGER NOT NULL DEFAULT 0,
    is_guest       INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS saves (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id),
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS leaderboard (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id),
    name       TEXT NOT NULL,
    valuation  REAL NOT NULL,
    prestige   INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);
  CREATE INDEX IF NOT EXISTS idx_lb_valuation ON leaderboard(valuation DESC);
  /* Partial unique index: at most one account per e-mail, but many NULLs
     (guests + legacy accounts) are allowed. */
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
`);

// Idempotent migrations for databases created before these columns existed.
for (const col of [
  'email TEXT',
  'email_verified INTEGER NOT NULL DEFAULT 0',
  'verify_token TEXT',
  'verify_expires INTEGER NOT NULL DEFAULT 0',
  'reset_token TEXT',
  'reset_expires INTEGER NOT NULL DEFAULT 0',
  'token_expires INTEGER NOT NULL DEFAULT 0',
]) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch { /* column already present — ok */ }
}

// --- Prepared statements ---------------------------------------------------
const stmts = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByToken: db.prepare('SELECT * FROM users WHERE token = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ? AND email IS NOT NULL'),
  userByVerifyToken: db.prepare('SELECT * FROM users WHERE verify_token = ?'),
  userByResetToken: db.prepare('SELECT * FROM users WHERE reset_token = ?'),
  insertUser: db.prepare(
    `INSERT INTO users
       (username, email, password_hash, salt, token, token_expires,
        email_verified, verify_token, verify_expires, is_guest, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  setToken: db.prepare('UPDATE users SET token = ?, token_expires = ? WHERE id = ?'),
  setVerifyToken: db.prepare('UPDATE users SET verify_token = ?, verify_expires = ? WHERE id = ?'),
  markVerified: db.prepare('UPDATE users SET email_verified = 1, verify_token = NULL, verify_expires = 0 WHERE id = ?'),
  setResetToken: db.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?'),
  updatePassword: db.prepare(
    `UPDATE users SET password_hash = ?, salt = ?, token = ?, token_expires = ?,
       reset_token = NULL, reset_expires = 0 WHERE id = ?`
  ),
  getSave: db.prepare('SELECT data, updated_at FROM saves WHERE user_id = ?'),
  putSave: db.prepare(
    `INSERT INTO saves (user_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ),
  upsertLb: db.prepare(
    `INSERT INTO leaderboard (user_id, name, valuation, prestige, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       name = excluded.name, valuation = excluded.valuation,
       prestige = excluded.prestige, updated_at = excluded.updated_at`
  ),
  topLb: db.prepare(
    'SELECT user_id, name, valuation, prestige FROM leaderboard ORDER BY valuation DESC LIMIT ?'
  ),
};

export const queries = {
  getUserById: (id) => stmts.userById.get(id),
  getUserByToken: (token) => stmts.userByToken.get(token),
  getUserByName: (name) => stmts.userByName.get(name),
  getUserByEmail: (email) => stmts.userByEmail.get(email),
  getUserByVerifyToken: (token) => stmts.userByVerifyToken.get(token),
  getUserByResetToken: (token) => stmts.userByResetToken.get(token),
  createUser: ({
    username, email = null, passwordHash = null, salt = null, token,
    tokenExpires = 0, emailVerified = 0, verifyToken = null, verifyExpires = 0, isGuest = 0,
  }) => {
    const info = stmts.insertUser.run(
      username, email, passwordHash, salt, token, tokenExpires,
      emailVerified, verifyToken, verifyExpires, isGuest, Date.now()
    );
    return stmts.userByName.get(username) ?? { id: info.lastInsertRowid, username };
  },
  setToken: (userId, token, tokenExpires) => stmts.setToken.run(token, tokenExpires, userId),
  setVerifyToken: (userId, token, expires) => stmts.setVerifyToken.run(token, expires, userId),
  markEmailVerified: (userId) => stmts.markVerified.run(userId),
  setResetToken: (userId, token, expires) => stmts.setResetToken.run(token, expires, userId),
  updatePassword: (userId, passwordHash, salt, token, tokenExpires) =>
    stmts.updatePassword.run(passwordHash, salt, token, tokenExpires, userId),
  getSave: (userId) => stmts.getSave.get(userId),
  putSave: (userId, data) => stmts.putSave.run(userId, data, Date.now()),
  upsertLeaderboard: (userId, name, valuation, prestige) =>
    stmts.upsertLb.run(userId, name, valuation, prestige, Date.now()),
  getLeaderboard: (limit = 50) => stmts.topLb.all(limit),
};

/** Seed a handful of AI rivals once, so a fresh leaderboard isn't empty. */
export function seedRivalsIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM leaderboard').get().n;
  if (count > 0) return;
  const rivals = [
    ['Globex Corp', 8.2e11], ['Initech', 4.5e10], ['Stark Industries', 9.1e12],
    ['Wayne Enterprises', 3.3e12], ['Hooli', 6.7e9], ['Wonka Industries', 1.4e11],
    ['Acme Co', 2.2e8], ['Cyberdyne', 5.6e12], ['Umbrella AG', 7.8e10],
    ['Aperture Science', 1.9e11],
  ];
  const now = Date.now();
  for (let i = 0; i < rivals.length; i++) {
    const [name, val] = rivals[i];
    const u = queries.createUser({ username: `__rival_${i}`, token: `rival-${i}`, isGuest: 1 });
    stmts.upsertLb.run(u.id, name, val, Math.floor(Math.random() * 20), now);
  }
}

export default db;
