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
import { queries, tx, seedRivalsIfEmpty } from './db.js';
import { sendVerification, sendPasswordReset, DEV_RETURN_TOKENS } from './mailer.js';
import * as resources from './resources.js';
import * as trade from './trade.js';
import * as realtime from './realtime.js';

const PORT = process.env.PORT ?? 3000;
// In production bind to 127.0.0.1 so the backend is only reachable through the
// reverse proxy (nginx); default 0.0.0.0 keeps local dev convenient.
const HOST = process.env.HOST ?? '0.0.0.0';

/** Bearer-Token-Lebensdauer (danach ist eine erneute Anmeldung nötig). */
const TOKEN_TTL = 7 * 24 * 3600 * 1000; // 7 Tage
const VERIFY_TTL = 24 * 3600 * 1000;    // E-Mail-Bestätigungslink: 24 h
const RESET_TTL = 60 * 60 * 1000;       // Passwort-Reset-Link: 1 h

// --- Eingabevalidierung (gegen Müll-/Injection-Eingaben; SQL ist ohnehin
// durch Prepared Statements geschützt) -------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
function registrationError({ username, email, password }) {
  if (!username || !USERNAME_RE.test(String(username))) return 'Benutzername: 3–20 Zeichen (Buchstaben, Zahlen, _ und -).';
  if (!email || !EMAIL_RE.test(String(email)) || String(email).length > 254) return 'Bitte eine gültige E-Mail-Adresse angeben.';
  if (!password || String(password).length < 8) return 'Das Passwort muss mindestens 8 Zeichen lang sein.';
  if (String(password).length > 200) return 'Das Passwort ist zu lang (max. 200 Zeichen).';
  return null;
}

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
  limit: Number(process.env.API_RATE_LIMIT ?? 120), // pro IP und Minute
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen – bitte kurz warten.' },
});
// Striktes Limit gegen Brute-Force auf die Anmelde-Endpunkte.
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: Number(process.env.AUTH_RATE_LIMIT ?? 20), // pro IP und 15 Minuten
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
const accountPayload = (user, token) => ({
  username: user.username,
  email: user.email ?? null,
  emailVerified: !!user.email_verified,
  mode: 'account',
  token,
  expiresIn: TOKEN_TTL,
});

app.post('/api/auth/guest', authLimiter, (req, res) => {
  const username = 'Gast-' + randomBytes(2).toString('hex').toUpperCase();
  const token = makeToken();
  queries.createUser({ username, token, tokenExpires: tokenExpiry(), isGuest: 1 });
  res.json({ username, token, mode: 'guest', expiresIn: TOKEN_TTL });
});

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { username, email, password } = req.body ?? {};
  const err = registrationError({ username, email, password });
  if (err) return res.status(400).json({ error: err });
  const uname = String(username).slice(0, 40);
  const mail = String(email).toLowerCase();
  if (queries.getUserByName(uname)) return res.status(409).json({ error: 'Benutzername bereits vergeben' });
  if (queries.getUserByEmail(mail)) return res.status(409).json({ error: 'E-Mail ist bereits registriert' });

  const { salt, hash } = hashPassword(password);
  const token = makeToken();
  const verifyToken = makeToken();
  let user;
  try {
    user = queries.createUser({
      username: uname, email: mail, passwordHash: hash, salt,
      token, tokenExpires: tokenExpiry(),
      verifyToken, verifyExpires: Date.now() + VERIFY_TTL, isGuest: 0,
    });
  } catch {
    // Unique-Index-Verletzung (Race) → generische Meldung.
    return res.status(409).json({ error: 'Benutzername oder E-Mail bereits vergeben' });
  }
  try { await sendVerification(mail, verifyToken, { username: uname }); } catch { /* mail best-effort */ }
  res.json({ ...accountPayload(user, token), emailVerified: false,
    ...(DEV_RETURN_TOKENS ? { devVerifyToken: verifyToken } : {}) });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { username, email, identifier, password } = req.body ?? {};
  const id = String(identifier ?? username ?? email ?? '').trim();
  if (!id || !password) return res.status(400).json({ error: 'Bitte Benutzername/E-Mail und Passwort angeben.' });
  const user = id.includes('@') ? queries.getUserByEmail(id.toLowerCase()) : queries.getUserByName(id);
  // Generic message — never reveal which half was wrong.
  if (!user || user.is_guest || !user.password_hash || !verifyPassword(String(password), user.salt, user.password_hash)) {
    return res.status(401).json({ error: 'Falscher Benutzername/E-Mail oder Passwort' });
  }
  const token = makeToken();
  queries.setToken(user.id, token, tokenExpiry());
  res.json(accountPayload(user, token));
});

// Confirm e-mail ownership via the token from the verification mail.
app.post('/api/auth/verify', authLimiter, (req, res) => {
  const token = String(req.body?.token ?? '');
  const user = token && queries.getUserByVerifyToken(token);
  if (!user || !user.verify_expires || user.verify_expires < Date.now()) {
    return res.status(400).json({ error: 'Ungültiger oder abgelaufener Bestätigungslink.' });
  }
  queries.markEmailVerified(user.id);
  res.json({ ok: true, emailVerified: true });
});

// Re-issue a verification mail for the logged-in account.
app.post('/api/auth/resend-verification', authLimiter, requireAuth, async (req, res) => {
  const user = req.user;
  if (!user.email) return res.status(400).json({ error: 'Dieses Konto hat keine E-Mail-Adresse.' });
  if (user.email_verified) return res.json({ ok: true, emailVerified: true });
  const verifyToken = makeToken();
  queries.setVerifyToken(user.id, verifyToken, Date.now() + VERIFY_TTL);
  try { await sendVerification(user.email, verifyToken, { username: user.username }); } catch { /* best-effort */ }
  res.json({ ok: true, ...(DEV_RETURN_TOKENS ? { devVerifyToken: verifyToken } : {}) });
});

// Request a password reset. Always returns ok (no account enumeration).
app.post('/api/auth/forgot', authLimiter, async (req, res) => {
  const mail = String(req.body?.email ?? '').toLowerCase().trim();
  const user = EMAIL_RE.test(mail) ? queries.getUserByEmail(mail) : null;
  let devResetToken;
  if (user && !user.is_guest) {
    const resetToken = makeToken();
    queries.setResetToken(user.id, resetToken, Date.now() + RESET_TTL);
    try { await sendPasswordReset(mail, resetToken); } catch { /* best-effort */ }
    devResetToken = resetToken;
  }
  res.json({ ok: true, ...(DEV_RETURN_TOKENS && devResetToken ? { devResetToken } : {}) });
});

// Set a new password using the reset token; rotates the session (old token dies).
app.post('/api/auth/reset', authLimiter, (req, res) => {
  const token = String(req.body?.token ?? '');
  const password = req.body?.password;
  if (!token || !password) return res.status(400).json({ error: 'Token und neues Passwort nötig.' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Das Passwort muss mindestens 8 Zeichen lang sein.' });
  const user = queries.getUserByResetToken(token);
  if (!user || !user.reset_expires || user.reset_expires < Date.now()) {
    return res.status(400).json({ error: 'Ungültiger oder abgelaufener Reset-Link.' });
  }
  const { salt, hash } = hashPassword(password);
  const newToken = makeToken();
  queries.updatePassword(user.id, hash, salt, newToken, tokenExpiry());
  res.json(accountPayload({ ...user, password_hash: hash }, newToken));
});

// Current session info (used by the client to refresh verification status).
app.get('/api/auth/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({ username: u.username, email: u.email ?? null, emailVerified: !!u.email_verified, mode: u.is_guest ? 'guest' : 'account' });
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

// --- Resources (Phase 2, server-authoritative) -----------------------------
// Static registry (which world produces what, building costs/rates).
app.get('/api/resources/config', (_req, res) => res.json(resources.config()));

// The player's settled stocks + current rates + owned buildings.
app.get('/api/resources', requireAuth, (req, res) => {
  res.json(tx(() => resources.snapshot(req.user.id)));
});

// Buy a resource building (paid with resources; validated server-side).
app.post('/api/resources/build', requireAuth, (req, res) => {
  const { buildingId, quantity } = req.body ?? {};
  const result = tx(() => {
    const r = resources.purchase(req.user.id, String(buildingId ?? ''), quantity);
    return r.error ? r : { ok: true, ...resources.snapshot(req.user.id) };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// --- Trading lobbies (Phase 3) ---------------------------------------------
// NB: /history is registered before /:id so it isn't captured as an id.
app.get('/api/lobbies', requireAuth, (req, res) => res.json({ lobbies: trade.listLobbies(req.query.search ?? '') }));

app.post('/api/lobbies', requireAuth, (req, res) => {
  const r = tx(() => trade.createLobby(req.user.id, req.body?.title));
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

app.get('/api/lobbies/history', requireAuth, (req, res) => res.json({ history: trade.history(req.user.id) }));

app.get('/api/lobbies/:id', requireAuth, (req, res) => {
  const r = tx(() => trade.getLobbyState(req.user.id, req.params.id));
  if (r.error) return res.status(404).json({ error: r.error });
  res.json(r);
});

app.post('/api/lobbies/:id/join', requireAuth, (req, res) => {
  const r = tx(() => trade.joinLobby(req.user.id, req.params.id));
  if (r.error) return res.status(400).json({ error: r.error });
  realtime.pushLobby(req.params.id); // notify the creator their lobby filled
  res.json(r);
});

app.post('/api/lobbies/:id/offer', requireAuth, (req, res) => {
  const r = tx(() => trade.setOffer(req.user.id, req.params.id, req.body?.offer ?? {}));
  if (r.error) return res.status(400).json({ error: r.error });
  realtime.pushLobby(req.params.id); // push the new offer to the other side
  res.json(tx(() => trade.getLobbyState(req.user.id, req.params.id)));
});

app.post('/api/lobbies/:id/confirm', requireAuth, (req, res) => {
  const r = tx(() => trade.confirm(req.user.id, req.params.id, !!req.body?.confirmed));
  if (r.error) return res.status(400).json({ error: r.error });
  realtime.pushLobby(req.params.id); // push confirmation / completion to both
  res.json(tx(() => trade.getLobbyState(req.user.id, req.params.id)));
});

app.post('/api/lobbies/:id/leave', requireAuth, (req, res) => {
  const r = tx(() => trade.leaveLobby(req.user.id, req.params.id));
  if (r.error) return res.status(400).json({ error: r.error });
  realtime.pushLobby(req.params.id); // tell the other side it was cancelled (escrow refunded)
  res.json(r);
});

// --- Health ----------------------------------------------------------------
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// --- Start -----------------------------------------------------------------
seedRivalsIfEmpty();
// Periodically cancel idle trade lobbies and refund their escrow.
setInterval(() => { try { trade.sweepExpired(); } catch (e) { console.warn('[trade] sweep failed:', e.message); } }, 60_000);
const server = app.listen(PORT, HOST, () => {
  console.log(`🏢 Imperium-Backend läuft auf http://${HOST}:${PORT}`);
});
// Attach the WebSocket push layer (shares the port; path /api/ws).
realtime.attach(server);
