/**
 * Database layer for the Unternehmens-Imperium backend.
 *
 * Uses Node's built-in SQLite (node:sqlite, Node ≥ 22) — no native npm
 * dependency to compile. Exposes small, prepared-statement-backed helpers so
 * the route layer never writes SQL inline.
 */
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? join(__dirname, 'imperium.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    salt          TEXT,
    token         TEXT,
    is_guest      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
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
`);

// --- Prepared statements ---------------------------------------------------
const stmts = {
  userByToken: db.prepare('SELECT * FROM users WHERE token = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  insertUser: db.prepare(
    `INSERT INTO users (username, password_hash, salt, token, is_guest, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ),
  setToken: db.prepare('UPDATE users SET token = ? WHERE id = ?'),
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
  getUserByToken: (token) => stmts.userByToken.get(token),
  getUserByName: (name) => stmts.userByName.get(name),
  createUser: ({ username, passwordHash = null, salt = null, token, isGuest = 0 }) => {
    const info = stmts.insertUser.run(username, passwordHash, salt, token, isGuest, Date.now());
    return stmts.userByName.get(username) ?? { id: info.lastInsertRowid, username };
  },
  setToken: (userId, token) => stmts.setToken.run(token, userId),
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
