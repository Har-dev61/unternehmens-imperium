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
 * Auth is a bearer token (random hex) stored on the user row with a 7-day
 * expiry; passwords are scrypt-hashed with a per-user salt. Hardening included:
 * rate-limiting (general + strict on auth), token expiry, and a server-side
 * plausibility check on submitted valuations (anti-cheat). For production also
 * terminate TLS at nginx and keep the OS/Node patched (see deploy/DEPLOY.md).
 */
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { queries, seedRivalsIfEmpty } from './db.js';

const PORT = process.env.PORT ?? 3000;
// In production bind to 127.0.0.1 so the backend is only reachable through the
// reverse proxy (nginx); default 0.0.0.0 keeps local dev convenient.
const HOST = process.env.HOST ?? '0.0.0.0';

/** Bearer-Token-Lebensdauer (danach ist eine erneute Anmeldung nötig). */
const TOKEN_TTL = 7 * 24 * 3600 * 1000; // 7 Tage

// Anti-Cheat: Plausibilitätsgrenzen für eingereichte Firmenwerte.
const HARD_CAP = 1e60;          // blockt Overflow / Unfug (Infinity, 1e308 …)
const SCORE_BASELINE = 1e7;     // Bezugsgröße der Wachstumsschranke
const MAX_GROWTH_PER_SEC = 1.5; // exponentielle Obergrenze je Sekunde Kontoalter

const app = express();
// Hinter nginx gibt es genau einen Proxy-Hop → korrekte Client-IP aus
// X-Forwarded-For, ohne IP-Spoofing für das Rate-Limiting zu erlauben.
app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));

// --- CORS (the static client runs on a different origin) -------------------
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- Rate-Limiting ---------------------------------------------------------
// Allgemeines Limit gegen Spam (normales Spiel bleibt weit darunter).
const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120, // pro IP und Minute
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen – bitte kurz warten.' },
});
// Striktes Limit gegen Brute-Force auf die Anmelde-Endpunkte.
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20, // pro IP und 15 Minuten
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Zu viele Anmeldeversuche – bitte später erneut versuchen.' },
});
app.use('/api', apiLimiter);

// --- Auth helpers ----------------------------------------------------------
const makeToken = () => randomBytes(24).toString('hex');
const tokenExpiry = () => Date.now() + TOKEN_TTL;

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}
function verifyPassword(password, salt, hash) {
  const test = scryptSync(password, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === test.length && timingSafeEqual(known, test);
}

/** Look up the user for a request's bearer token — null if missing/expired. */
function userFromRequest(req) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const user = queries.getUserByToken(token);
  if (!user) return null;
  if (!user.token_expires || user.token_expires < Date.now()) return null; // abgelaufen
  return user;
}

/** Express middleware: require a valid, unexpired bearer token. */
function requireAuth(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Nicht autorisiert oder Sitzung abgelaufen' });
  req.user = user;
  next();
}

/** Optional auth: attach req.user if a valid token is present, never reject. */
function optionalAuth(req, _res, next) {
  req.user = userFromRequest(req);
  next();
}

// --- Auth routes -----------------------------------------------------------
app.post('/api/auth/guest', authLimiter, (req, res) => {
  const username = 'Gast-' + randomBytes(2).toString('hex').toUpperCase();
  const token = makeToken();
  queries.createUser({ username, token, tokenExpires: tokenExpiry(), isGuest: 1 });
  res.json({ username, token, mode: 'guest', expiresIn: TOKEN_TTL });
});

app.post('/api/auth/register', authLimiter, (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort nötig' });
  if (String(password).length < 4) return res.status(400).json({ error: 'Passwort zu kurz (min. 4 Zeichen)' });
  if (queries.getUserByName(username)) return res.status(409).json({ error: 'Benutzername bereits vergeben' });
  const { salt, hash } = hashPassword(password);
  const token = makeToken();
  queries.createUser({ username: String(username).slice(0, 40), passwordHash: hash, salt, token, tokenExpires: tokenExpiry(), isGuest: 0 });
  res.json({ username, token, mode: 'account', expiresIn: TOKEN_TTL });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { username, password } = req.body ?? {};
  const user = username && queries.getUserByName(username);
  if (!user || user.is_guest || !verifyPassword(password ?? '', user.salt, user.password_hash)) {
    return res.status(401).json({ error: 'Falscher Benutzername oder Passwort' });
  }
  const token = makeToken();
  queries.setToken(user.id, token, tokenExpiry());
  res.json({ username: user.username, token, mode: 'account', expiresIn: TOKEN_TTL });
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

/**
 * Plausibilitätsprüfung eines eingereichten Firmenwerts (Anti-Cheat).
 * Echte Wasserdichtigkeit bräuchte eine serverseitige Spielsimulation; diese
 * Heuristik blockt aber die naheliegenden Manipulationen, ohne legitime
 * Spieler auszubremsen:
 *   1. endlich, nicht negativ, unter einem harten Maximum (kein Infinity/Overflow)
 *   2. eine exponentielle Obergrenze, die mit dem Kontoalter rasch mitwächst —
 *      so kann ein frisch erstelltes Konto keine astronomischen Werte melden,
 *      während ein länger aktives Konto praktisch unbegrenzt ist.
 * Liefert eine Fehlermeldung (string) oder null, wenn der Wert ok ist.
 */
function scoreError(user, valuation) {
  if (typeof valuation !== 'number' || !Number.isFinite(valuation) || valuation < 0) {
    return 'Ungültiger Firmenwert';
  }
  if (valuation > HARD_CAP) return 'Unrealistisch hoher Firmenwert';
  const ageSec = Math.max(1, (Date.now() - (user.created_at ?? 0)) / 1000);
  const maxByAge = SCORE_BASELINE * Math.pow(MAX_GROWTH_PER_SEC, ageSec);
  // Bei sehr altem Konto wird maxByAge zu Infinity → keine weitere Schranke.
  if (Number.isFinite(maxByAge) && valuation > maxByAge) {
    return 'Firmenwert wächst zu schnell für das Kontoalter';
  }
  return null;
}

app.post('/api/leaderboard', requireAuth, (req, res) => {
  const { name, valuation, prestige } = req.body ?? {};
  const err = scoreError(req.user, valuation);
  if (err) return res.status(400).json({ error: err });
  const safePrestige = Math.min(1_000_000, Math.max(0, Math.floor(Number(prestige) || 0)));
  queries.upsertLeaderboard(req.user.id, String(name ?? 'Unbenannt').slice(0, 40), valuation, safePrestige);
  res.json({ ok: true });
});

// --- Global events ---------------------------------------------------------
// Time-bucketed so every client in the same 5-minute window sees the SAME
// event (a genuine "server broadcast"), with the remaining duration computed
// server-side.
const EVENT_POOL = [
  { id: 'boom', name: '📈 Globaler Wirtschaftsboom', multiplier: 2, duration: 120 },
  { id: 'viral', name: '🔥 Virale Marketing-Kampagne', multiplier: 3, duration: 60 },
  { id: 'merger', name: '🤝 Fusionswelle', multiplier: 1.8, duration: 180 },
  { id: 'subsidy', name: '🏛️ Staatliche Subventionen', multiplier: 2.5, duration: 90 },
];

function currentEvents() {
  const windowMs = 5 * 60 * 1000;
  const bucket = Math.floor(Date.now() / windowMs);
  // Deterministic pseudo-random from the bucket index.
  const r = Math.abs(Math.sin(bucket * 12.9898) * 43758.5453) % 1;
  if (r > 0.3) return []; // ~30% of windows broadcast an event
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
