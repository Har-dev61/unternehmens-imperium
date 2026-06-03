/**
 * Unternehmens-Imperium — backend API (Express + node:sqlite).
 *
 * Endpoints
 *   POST /api/auth/guest                 → { username, token }
 *   POST /api/auth/register {u, p}       → { username, token }
 *   POST /api/auth/login    {u, p}       → { username, token }
 *   GET  /api/save            (auth)     → { data, updatedAt } | { data: null }
 *   PUT  /api/save  {data}    (auth)     → { ok }
 *   GET  /api/leaderboard?limit=         → { entries: [{rank,name,valuation,prestige,isPlayer}] }
 *   POST /api/leaderboard {name,...}(auth)→ { ok }
 *   GET  /api/events                     → { events: [...] }
 *   GET  /api/health                     → { ok, users }
 *
 * Auth is a simple bearer token (random hex) stored on the user row.
 * Passwords are scrypt-hashed with a per-user salt. This is a compact but
 * genuine implementation — for production add HTTPS, rate-limiting and
 * token expiry.
 */
import express from 'express';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { queries, seedRivalsIfEmpty } from './db.js';

const PORT = process.env.PORT ?? 3000;
// In production bind to 127.0.0.1 so the backend is only reachable through the
// reverse proxy (nginx); default 0.0.0.0 keeps local dev convenient.
const HOST = process.env.HOST ?? '0.0.0.0';
const app = express();
app.use(express.json({ limit: '4mb' }));

// --- CORS (the static client runs on a different origin) -------------------
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- Auth helpers ----------------------------------------------------------
const makeToken = () => randomBytes(24).toString('hex');

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}
function verifyPassword(password, salt, hash) {
  const test = scryptSync(password, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === test.length && timingSafeEqual(known, test);
}

/** Express middleware: require a valid bearer token, attach req.user. */
function requireAuth(req, res, next) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const user = token && queries.getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Nicht autorisiert' });
  req.user = user;
  next();
}

/** Optional auth: attach req.user if a token is present, but never reject. */
function optionalAuth(req, _res, next) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  req.user = token ? queries.getUserByToken(token) : null;
  next();
}

// --- Auth routes -----------------------------------------------------------
app.post('/api/auth/guest', (req, res) => {
  const username = 'Gast-' + randomBytes(2).toString('hex').toUpperCase();
  const token = makeToken();
  queries.createUser({ username, token, isGuest: 1 });
  res.json({ username, token, mode: 'guest' });
});

app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort nötig' });
  if (queries.getUserByName(username)) return res.status(409).json({ error: 'Benutzername bereits vergeben' });
  const { salt, hash } = hashPassword(password);
  const token = makeToken();
  queries.createUser({ username, passwordHash: hash, salt, token, isGuest: 0 });
  res.json({ username, token, mode: 'account' });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body ?? {};
  const user = username && queries.getUserByName(username);
  if (!user || user.is_guest || !verifyPassword(password ?? '', user.salt, user.password_hash)) {
    return res.status(401).json({ error: 'Falscher Benutzername oder Passwort' });
  }
  const token = makeToken();
  queries.setToken(user.id, token);
  res.json({ username: user.username, token, mode: 'account' });
});

// --- Cloud saves -----------------------------------------------------------
app.get('/api/save', requireAuth, (req, res) => {
  const row = queries.getSave(req.user.id);
  if (!row) return res.json({ data: null });
  res.json({ data: JSON.parse(row.data), updatedAt: row.updated_at });
});

app.put('/api/save', requireAuth, (req, res) => {
  const { data } = req.body ?? {};
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Ungültige Daten' });
  queries.putSave(req.user.id, JSON.stringify(data));
  res.json({ ok: true });
});

// --- Leaderboard -----------------------------------------------------------
app.get('/api/leaderboard', optionalAuth, (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const rows = queries.getLeaderboard(limit);
  const meId = req.user?.id ?? -1;
  const entries = rows.map((r, i) => ({
    rank: i + 1,
    name: r.name,
    valuation: r.valuation,
    prestige: r.prestige,
    isPlayer: r.user_id === meId,
  }));
  res.json({ entries });
});

app.post('/api/leaderboard', requireAuth, (req, res) => {
  const { name, valuation, prestige } = req.body ?? {};
  if (typeof valuation !== 'number' || !Number.isFinite(valuation)) {
    return res.status(400).json({ error: 'Ungültiger Firmenwert' });
  }
  queries.upsertLeaderboard(req.user.id, String(name ?? 'Unbenannt').slice(0, 40), valuation, Number(prestige) || 0);
  res.json({ ok: true });
});

// --- Global events ---------------------------------------------------------
// Time-bucketed so every client in the same 5-minute window sees the SAME
// event (a genuine "server broadcast"), with the remaining duration computed
// server-side.
const EVENT_POOL = [
  { id: 'boom', name: '📈 Globaler Wirtschaftsboom', multiplier: 3, duration: 120 },
  { id: 'viral', name: '🔥 Virale Marketing-Kampagne', multiplier: 5, duration: 60 },
  { id: 'merger', name: '🤝 Fusionswelle', multiplier: 2, duration: 180 },
  { id: 'subsidy', name: '🏛️ Staatliche Subventionen', multiplier: 4, duration: 90 },
];

function currentEvents() {
  const windowMs = 5 * 60 * 1000;
  const bucket = Math.floor(Date.now() / windowMs);
  // Deterministic pseudo-random from the bucket index.
  const r = Math.abs(Math.sin(bucket * 12.9898) * 43758.5453) % 1;
  if (r > 0.45) return []; // ~45% of windows broadcast an event
  const e = EVENT_POOL[Math.floor((r * 1000) % EVENT_POOL.length)];
  const startedAt = bucket * windowMs;
  const remaining = e.duration - (Date.now() - startedAt) / 1000;
  if (remaining <= 0) return [];
  return [{ id: `srv-${bucket}-${e.id}`, name: e.name, multiplier: e.multiplier, duration: Math.ceil(remaining), source: 'online' }];
}

app.get('/api/events', (_req, res) => res.json({ events: currentEvents() }));

// --- Health ----------------------------------------------------------------
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// --- Start -----------------------------------------------------------------
seedRivalsIfEmpty();
app.listen(PORT, HOST, () => {
  console.log(`🏢 Imperium-Backend läuft auf http://${HOST}:${PORT}`);
});
