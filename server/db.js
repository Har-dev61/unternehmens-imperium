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

  /* --- Server-authoritative resource economy (Phase 2) --- */
  CREATE TABLE IF NOT EXISTS player_resources (
    user_id INTEGER NOT NULL REFERENCES users(id),
    type    TEXT NOT NULL,
    amount  REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, type)
  );

  CREATE TABLE IF NOT EXISTS player_buildings (
    user_id     INTEGER NOT NULL REFERENCES users(id),
    building_id TEXT NOT NULL,
    count       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, building_id)
  );

  CREATE TABLE IF NOT EXISTS resource_state (
    user_id   INTEGER PRIMARY KEY REFERENCES users(id),
    last_tick INTEGER NOT NULL
  );

  /* Per-world collect ENERGY (lazy regen via last_tick) — drop-system overhaul. */
  CREATE TABLE IF NOT EXISTS player_energy (
    user_id   INTEGER NOT NULL REFERENCES users(id),
    world     TEXT NOT NULL,
    energy    REAL NOT NULL DEFAULT 0,
    last_tick INTEGER NOT NULL,
    PRIMARY KEY (user_id, world)
  );

  /* Small key/value table for one-off migrations/markers. */
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

  /* Server-authoritative economy: the serialized Game SaveState per player. */
  CREATE TABLE IF NOT EXISTS player_economy (
    user_id   INTEGER PRIMARY KEY REFERENCES users(id),
    data      TEXT NOT NULL,
    last_tick INTEGER NOT NULL
  );

  /* --- Trading: lobbies + escrowed offers + history (Phase 3) --- */
  CREATE TABLE IF NOT EXISTS lobbies (
    id         TEXT PRIMARY KEY,
    creator_id INTEGER NOT NULL REFERENCES users(id),
    joiner_id  INTEGER REFERENCES users(id),
    status     TEXT NOT NULL DEFAULT 'open',   -- open | active | completed | cancelled
    title      TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lobby_offers (
    lobby_id  TEXT NOT NULL REFERENCES lobbies(id),
    user_id   INTEGER NOT NULL REFERENCES users(id),
    escrow    TEXT NOT NULL DEFAULT '{}',       -- {type: amount} already deducted from the bag
    confirmed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (lobby_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS trade_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    lobby_id     TEXT NOT NULL,
    a_id         INTEGER NOT NULL,
    b_id         INTEGER NOT NULL,
    a_gave       TEXT NOT NULL,
    b_gave       TEXT NOT NULL,
    completed_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_lobbies_status ON lobbies(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_history_a ON trade_history(a_id, completed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_history_b ON trade_history(b_id, completed_at DESC);

  CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);
  CREATE INDEX IF NOT EXISTS idx_lb_valuation ON leaderboard(valuation DESC);
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

// Only NOW (after the email column is guaranteed to exist — freshly created above
// OR just added by the migration on a legacy DB) create its partial unique index.
// At most one account per e-mail, but many NULLs (guests + legacy accounts) allowed.
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL');
} catch (e) {
  console.error('[db] could not create idx_users_email:', e.message);
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
  // --- Resources (Phase 2) ---
  resTick: db.prepare('SELECT last_tick FROM resource_state WHERE user_id = ?'),
  setResTick: db.prepare(
    `INSERT INTO resource_state (user_id, last_tick) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET last_tick = excluded.last_tick`
  ),
  resAll: db.prepare('SELECT type, amount FROM player_resources WHERE user_id = ?'),
  resUpsert: db.prepare(
    `INSERT INTO player_resources (user_id, type, amount) VALUES (?, ?, ?)
     ON CONFLICT(user_id, type) DO UPDATE SET amount = excluded.amount`
  ),
  bldAll: db.prepare('SELECT building_id, count FROM player_buildings WHERE user_id = ?'),
  bldUpsert: db.prepare(
    `INSERT INTO player_buildings (user_id, building_id, count) VALUES (?, ?, ?)
     ON CONFLICT(user_id, building_id) DO UPDATE SET count = excluded.count`
  ),
  energyGet: db.prepare('SELECT energy, last_tick FROM player_energy WHERE user_id = ? AND world = ?'),
  energySet: db.prepare(
    `INSERT INTO player_energy (user_id, world, energy, last_tick) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, world) DO UPDATE SET energy = excluded.energy, last_tick = excluded.last_tick`
  ),
  metaGet: db.prepare('SELECT value FROM meta WHERE key = ?'),
  metaSet: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  econGet: db.prepare('SELECT data, last_tick FROM player_economy WHERE user_id = ?'),
  econSet: db.prepare(
    `INSERT INTO player_economy (user_id, data, last_tick) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, last_tick = excluded.last_tick`
  ),
  // --- Trading (Phase 3) ---
  createLobby: db.prepare('INSERT INTO lobbies (id, creator_id, status, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
  getLobby: db.prepare('SELECT * FROM lobbies WHERE id = ?'),
  lobbyView: db.prepare(
    `SELECT l.*, cu.username AS creator_name, ju.username AS joiner_name
     FROM lobbies l JOIN users cu ON cu.id = l.creator_id
     LEFT JOIN users ju ON ju.id = l.joiner_id WHERE l.id = ?`
  ),
  listOpen: db.prepare(
    `SELECT l.id, l.title, l.created_at, l.updated_at, cu.username AS creator_name
     FROM lobbies l JOIN users cu ON cu.id = l.creator_id
     WHERE l.status = 'open' ORDER BY l.updated_at DESC LIMIT ?`
  ),
  setLobbyStatus: db.prepare('UPDATE lobbies SET status = ?, updated_at = ? WHERE id = ?'),
  setLobbyJoiner: db.prepare('UPDATE lobbies SET joiner_id = ?, status = ?, updated_at = ? WHERE id = ?'),
  touchLobby: db.prepare('UPDATE lobbies SET updated_at = ? WHERE id = ?'),
  countOpenByCreator: db.prepare("SELECT COUNT(*) AS n FROM lobbies WHERE creator_id = ? AND status IN ('open','active')"),
  staleLobbies: db.prepare("SELECT * FROM lobbies WHERE status IN ('open','active') AND updated_at < ?"),
  getOffers: db.prepare('SELECT user_id, escrow, confirmed FROM lobby_offers WHERE lobby_id = ?'),
  upsertOffer: db.prepare(
    `INSERT INTO lobby_offers (lobby_id, user_id, escrow, confirmed) VALUES (?, ?, ?, ?)
     ON CONFLICT(lobby_id, user_id) DO UPDATE SET escrow = excluded.escrow, confirmed = excluded.confirmed`
  ),
  setConfirmed: db.prepare('UPDATE lobby_offers SET confirmed = ? WHERE lobby_id = ? AND user_id = ?'),
  resetConfirms: db.prepare('UPDATE lobby_offers SET confirmed = 0 WHERE lobby_id = ?'),
  deleteOffers: db.prepare('DELETE FROM lobby_offers WHERE lobby_id = ?'),
  insertHistory: db.prepare('INSERT INTO trade_history (lobby_id, a_id, b_id, a_gave, b_gave, completed_at) VALUES (?, ?, ?, ?, ?, ?)'),
  historyFor: db.prepare('SELECT * FROM trade_history WHERE a_id = ? OR b_id = ? ORDER BY completed_at DESC LIMIT ?'),
};

/** Run `fn` inside an immediate (write-locking) transaction; rolls back on throw. */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
}

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
  // --- Resources (Phase 2) ---
  getResourceTick: (userId) => stmts.resTick.get(userId)?.last_tick,
  setResourceTick: (userId, t) => stmts.setResTick.run(userId, t),
  getResources: (userId) => stmts.resAll.all(userId),            // [{ type, amount }]
  setResource: (userId, type, amount) => stmts.resUpsert.run(userId, type, amount),
  getBuildings: (userId) => stmts.bldAll.all(userId),            // [{ building_id, count }]
  setBuilding: (userId, buildingId, count) => stmts.bldUpsert.run(userId, buildingId, count),
  getEnergy: (userId, world) => stmts.energyGet.get(userId, world),
  setEnergy: (userId, world, energy, lastTick) => stmts.energySet.run(userId, world, energy, lastTick),
  getMeta: (key) => stmts.metaGet.get(key)?.value ?? null,
  setMeta: (key, value) => stmts.metaSet.run(key, String(value)),
  getEconomy: (userId) => stmts.econGet.get(userId),
  setEconomy: (userId, data, lastTick) => stmts.econSet.run(userId, data, lastTick),
  // --- Trading (Phase 3) ---
  createLobby: (id, creatorId, title) => stmts.createLobby.run(id, creatorId, 'open', title ?? null, Date.now(), Date.now()),
  getLobby: (id) => stmts.getLobby.get(id),
  getLobbyView: (id) => stmts.lobbyView.get(id),
  listOpenLobbies: (limit = 50) => stmts.listOpen.all(limit),
  setLobbyStatus: (id, status) => stmts.setLobbyStatus.run(status, Date.now(), id),
  setLobbyJoiner: (id, joinerId, status) => stmts.setLobbyJoiner.run(joinerId, status, Date.now(), id),
  touchLobby: (id) => stmts.touchLobby.run(Date.now(), id),
  countOpenLobbies: (creatorId) => stmts.countOpenByCreator.get(creatorId).n,
  getStaleLobbies: (beforeTs) => stmts.staleLobbies.all(beforeTs),
  getOffers: (lobbyId) => stmts.getOffers.all(lobbyId),          // [{ user_id, escrow, confirmed }]
  upsertOffer: (lobbyId, userId, escrowJson, confirmed) => stmts.upsertOffer.run(lobbyId, userId, escrowJson, confirmed ? 1 : 0),
  setOfferConfirmed: (lobbyId, userId, confirmed) => stmts.setConfirmed.run(confirmed ? 1 : 0, lobbyId, userId),
  resetLobbyConfirms: (lobbyId) => stmts.resetConfirms.run(lobbyId),
  deleteLobbyOffers: (lobbyId) => stmts.deleteOffers.run(lobbyId),
  insertTradeHistory: (lobbyId, aId, bId, aGave, bGave) => stmts.insertHistory.run(lobbyId, aId, bId, aGave, bGave, Date.now()),
  getTradeHistory: (userId, limit = 20) => stmts.historyFor.all(userId, userId, limit),
};

// One-time reset when switching to the rarity-drop system: the old passively
// accrued resource amounts + buildings are wiped so everyone starts fresh.
if (queries.getMeta('drops_v2_reset') !== '1') {
  try { db.exec('DELETE FROM player_resources; DELETE FROM player_buildings; DELETE FROM resource_state;'); }
  catch (e) { console.error('[db] drop-system reset failed:', e.message); }
  queries.setMeta('drops_v2_reset', '1');
}

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
