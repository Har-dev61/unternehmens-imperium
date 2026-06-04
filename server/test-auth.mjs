/**
 * Integration test for the account system. Boots the real Express app against a
 * throwaway SQLite DB, with DEV token return + relaxed rate limits, and exercises
 * register / login / verify / forgot / reset plus security cases.
 *
 *   Run:  node server/test-auth.mjs   (needs Node ≥ 22 for node:sqlite)
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const PORT = 3987;
const DB = join(tmpdir(), `imperium-test-${Date.now()}.db`);
process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';
process.env.DB_PATH = DB;
process.env.MAIL_DEV_RETURN_TOKENS = '1';
process.env.AUTH_RATE_LIMIT = '100000';
process.env.API_RATE_LIMIT = '100000';

await import('./server.js'); // starts listening

const base = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } };
const api = async (path, { method = 'GET', body, token } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = {}; try { json = await res.json(); } catch {}
  return { status: res.status, json };
};

// Wait for the server to be ready.
for (let i = 0; i < 50; i++) {
  try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

try {
  const U = 'alice', E = 'alice@example.com', P = 'sup3rsecret';

  // --- Registration ---
  let r = await api('/api/auth/register', { method: 'POST', body: { username: U, email: E, password: P } });
  ok(r.status === 200 && r.json.token, 'register returns a session token');
  ok(r.json.emailVerified === false, 'new account starts unverified');
  ok(typeof r.json.devVerifyToken === 'string', 'dev verify token returned');
  const verifyToken = r.json.devVerifyToken;
  const firstToken = r.json.token;

  r = await api('/api/auth/register', { method: 'POST', body: { username: U, email: 'other@x.com', password: P } });
  ok(r.status === 409, 'duplicate username rejected');
  r = await api('/api/auth/register', { method: 'POST', body: { username: 'bob', email: E, password: P } });
  ok(r.status === 409, 'duplicate email rejected');
  r = await api('/api/auth/register', { method: 'POST', body: { username: 'bob', email: 'bob@x.com', password: 'short' } });
  ok(r.status === 400, 'weak password rejected');
  r = await api('/api/auth/register', { method: 'POST', body: { username: 'bob', email: 'not-an-email', password: P } });
  ok(r.status === 400, 'invalid email rejected');

  // --- Login (username and email) ---
  r = await api('/api/auth/login', { method: 'POST', body: { identifier: U, password: P } });
  ok(r.status === 200 && r.json.token, 'login by username works');
  r = await api('/api/auth/login', { method: 'POST', body: { identifier: E, password: P } });
  ok(r.status === 200 && r.json.token, 'login by email works');
  const sessionToken = r.json.token;
  r = await api('/api/auth/login', { method: 'POST', body: { identifier: U, password: 'wrong' } });
  ok(r.status === 401, 'wrong password rejected');

  // --- SQL-injection attempt must NOT authenticate ---
  r = await api('/api/auth/login', { method: 'POST', body: { identifier: "alice' OR '1'='1", password: "x' OR '1'='1" } });
  ok(r.status === 401, 'SQL-injection login attempt rejected (prepared statements)');

  // --- Email verification ---
  r = await api('/api/auth/verify', { method: 'POST', body: { token: 'garbage' } });
  ok(r.status === 400, 'bogus verification token rejected');
  r = await api('/api/auth/verify', { method: 'POST', body: { token: verifyToken } });
  ok(r.status === 200 && r.json.emailVerified === true, 'email verifies with valid token');
  r = await api('/api/auth/me', { token: sessionToken });
  ok(r.status === 200 && r.json.emailVerified === true, '/me reflects verified status');

  // --- Forgot + reset password ---
  r = await api('/api/auth/forgot', { method: 'POST', body: { email: 'nobody@nowhere.com' } });
  ok(r.status === 200 && r.json.devResetToken === undefined, 'forgot for unknown email reveals nothing');
  r = await api('/api/auth/forgot', { method: 'POST', body: { email: E } });
  ok(r.status === 200 && typeof r.json.devResetToken === 'string', 'forgot for known email issues a reset token');
  const resetToken = r.json.devResetToken;

  const NEWP = 'brandNewPass9';
  r = await api('/api/auth/reset', { method: 'POST', body: { token: resetToken, password: NEWP } });
  ok(r.status === 200 && r.json.token, 'reset succeeds and returns a fresh session token');

  r = await api('/api/auth/login', { method: 'POST', body: { identifier: U, password: P } });
  ok(r.status === 401, 'old password no longer works after reset');
  r = await api('/api/auth/login', { method: 'POST', body: { identifier: U, password: NEWP } });
  ok(r.status === 200, 'new password works after reset');

  // Old session tokens are invalidated by the reset (token rotation).
  r = await api('/api/auth/me', { token: firstToken });
  ok(r.status === 401, 'pre-reset session token is revoked');

  // --- Cloud save round-trip is account-scoped ---
  const freshLogin = await api('/api/auth/login', { method: 'POST', body: { identifier: U, password: NEWP } });
  const tok = freshLogin.json.token;
  r = await api('/api/save', { method: 'PUT', token: tok, body: { data: { hello: 'world', n: 42 } } });
  ok(r.status === 200, 'save PUT works');
  r = await api('/api/save', { token: tok });
  ok(r.status === 200 && r.json.data && r.json.data.n === 42, 'save GET returns the stored blob');

  // --- Guest still works ---
  r = await api('/api/auth/guest', { method: 'POST', body: {} });
  ok(r.status === 200 && r.json.mode === 'guest' && r.json.token, 'guest login still works');
} catch (err) {
  fail++; console.error('  ✗ unexpected error:', err);
} finally {
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(DB + ext); } catch {} }
  console.log(`\n${fail === 0 ? '✅' : '❌'} auth test: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
