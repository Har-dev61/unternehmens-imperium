/**
 * Tests for the realtime push layer (Phase 4): WebSocket auth, live lobby
 * pushes on HTTP actions, and the "logged in elsewhere" notice. Uses Node's
 * built-in WebSocket client (Node ≥ 22) against the real `ws` server.
 *
 *   Run:  node server/test-realtime.mjs
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const PORT = 3990;
const DB = join(tmpdir(), `imperium-wstest-${Date.now()}.db`);
process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';
process.env.DB_PATH = DB;
process.env.AUTH_RATE_LIMIT = '100000';
process.env.API_RATE_LIMIT = '100000';

await import('./server.js');

const http = `http://127.0.0.1:${PORT}`;
const wsBase = `ws://127.0.0.1:${PORT}/api/ws`;
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } };
const api = async (path, { method = 'GET', body, token } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(http + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = {}; try { json = await res.json(); } catch {}
  return { status: res.status, json };
};
const register = async (name) => (await api('/api/auth/register', { method: 'POST', body: { username: name, email: name + '@x.com', password: 'sup3rsecret' } })).json.token;

// Open a socket; resolves on open, rejects on error/early close.
const openWs = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  ws.onopen = () => resolve(ws);
  ws.onerror = () => reject(new Error('ws error'));
  ws.onclose = (e) => reject(new Error('closed:' + e.code));
});
// Wait for the next message matching `pred` (or null after `ms`).
const waitMsg = (ws, pred, ms = 2500) => new Promise((resolve) => {
  const to = setTimeout(() => { ws.removeEventListener('message', h); resolve(null); }, ms);
  function h(e) { let m; try { m = JSON.parse(e.data); } catch { return; } if (pred(m)) { clearTimeout(to); ws.removeEventListener('message', h); resolve(m); } }
  ws.addEventListener('message', h);
});

for (let i = 0; i < 50; i++) { try { if ((await fetch(http + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }

let wsA, wsA2, wsB;
try {
  // --- Auth on the socket ---
  let rejected = false;
  try { await openWs(`${wsBase}?token=not-a-real-token`); } catch { rejected = true; }
  ok(rejected, 'WS connection with an invalid token is rejected');

  const tokenA = await register('ws_alice');
  const tokenB = await register('ws_bob');

  wsA = await openWs(`${wsBase}?token=${tokenA}`);
  ok(true, 'WS connection with a valid token succeeds');
  const hello = await waitMsg(wsA, (m) => m.type === 'hello');
  ok(hello, 'server sends a hello on connect');

  // --- Live lobby push: B's HTTP actions reach A's socket ---
  const lobbyId = (await api('/api/lobbies', { method: 'POST', token: tokenA, body: { title: 'WS' } })).json.id;
  const joinedMsg = waitMsg(wsA, (m) => m.type === 'lobby:changed' && m.id === lobbyId);
  await api(`/api/lobbies/${lobbyId}/join`, { method: 'POST', token: tokenB }); // B joins via HTTP
  ok(await joinedMsg, 'A receives lobby:changed when B joins (HTTP → push)');

  const confirmMsg = waitMsg(wsA, (m) => m.type === 'lobby:changed' && m.id === lobbyId);
  await api(`/api/lobbies/${lobbyId}/confirm`, { method: 'POST', token: tokenB, body: { confirmed: true } });
  ok(await confirmMsg, 'A receives lobby:changed when B confirms');

  // B's own socket also gets pushes about its lobby.
  wsB = await openWs(`${wsBase}?token=${tokenB}`);
  await waitMsg(wsB, (m) => m.type === 'hello');
  const bMsg = waitMsg(wsB, (m) => m.type === 'lobby:changed' && m.id === lobbyId);
  await api(`/api/lobbies/${lobbyId}/offer`, { method: 'POST', token: tokenA, body: { offer: {} } });
  ok(await bMsg, 'B receives lobby:changed when A changes the offer');

  // --- Second session notice ---
  const elsewhere = waitMsg(wsA, (m) => m.type === 'session:elsewhere');
  wsA2 = await openWs(`${wsBase}?token=${tokenA}`); // same account, second socket
  ok(await elsewhere, 'existing session is notified when the account connects elsewhere');
} catch (err) {
  fail++; console.error('  ✗ unexpected error:', err);
} finally {
  for (const ws of [wsA, wsA2, wsB]) { try { ws?.close(); } catch {} }
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(DB + ext); } catch {} }
  console.log(`\n${fail === 0 ? '✅' : '❌'} realtime test: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
