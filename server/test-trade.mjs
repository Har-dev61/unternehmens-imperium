/**
 * Tests for the trading system (Phase 3): lobby lifecycle, escrow-on-offer,
 * confirm-reset-on-change, atomic swap, double-spend prevention, refunds on
 * leave/expiry, and access control.
 *
 *   Run:  node server/test-trade.mjs   (Node ≥ 22)
 *
 * Resource ticks are seeded into the FUTURE (T), so settle() never adds
 * production during the test — the maths stays deterministic.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const PORT = 3989;
const DB = join(tmpdir(), `imperium-ttest-${Date.now()}.db`);
process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';
process.env.DB_PATH = DB;
process.env.AUTH_RATE_LIMIT = '100000';
process.env.API_RATE_LIMIT = '100000';

await import('./server.js');
const dbMod = await import('./db.js');
const { queries, tx } = dbMod;
const db = dbMod.default;
const resources = await import('./resources.js');
const trade = await import('./trade.js');

const base = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } };
const near = (a, b, eps = 1e-6) => Math.abs((a ?? 0) - b) <= eps;
const api = async (path, { method = 'GET', body, token } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = {}; try { json = await res.json(); } catch {}
  return { status: res.status, json };
};
for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }

const T = 4_000_000_000_000; // far future → settle() is always a no-op here
const mkUser = (n) => queries.createUser({ username: n, token: 'tk-' + n, isGuest: 1 }).id;
const seed = (uid, res) => tx(() => { resources.settle(uid, T); for (const [k, v] of Object.entries(res)) queries.setResource(uid, k, v); });
const wallet = (uid) => Object.fromEntries(queries.getResources(uid).map((r) => [r.type, r.amount]));

try {
  const alice = mkUser('t_alice'), bob = mkUser('t_bob');
  seed(alice, { wood: 1000, stone: 500 });
  seed(bob, { iron: 800, coal: 200 });

  // --- Lobby lifecycle ---
  const lid = tx(() => trade.createLobby(alice, 'Holz gegen Eisen')).id;
  ok(!!lid, 'lobby created');
  ok(trade.listLobbies('').some((l) => l.id === lid), 'lobby is listed as open');
  ok(trade.listLobbies('eisen').some((l) => l.id === lid), 'search matches the title');
  ok(!trade.listLobbies('zzzz').some((l) => l.id === lid), 'search excludes non-matches');
  ok(tx(() => trade.joinLobby(bob, lid)).ok, 'bob joins the lobby');
  ok(tx(() => trade.getLobbyState(alice, lid, T)).status === 'active', 'lobby is active after join');
  ok(tx(() => trade.joinLobby(mkUser('t_carol'), lid)).error, 'a third player cannot join a full lobby');

  // --- Offers move resources into escrow ---
  ok(tx(() => trade.setOffer(alice, lid, { wood: 200 }, T)).ok, 'alice offers 200 wood');
  ok(near(wallet(alice).wood, 800), 'alice wood escrowed (1000 → 800)');
  ok(tx(() => trade.setOffer(bob, lid, { iron: 100 }, T)).ok, 'bob offers 100 iron');
  ok(near(wallet(bob).iron, 700), 'bob iron escrowed (800 → 700)');
  ok(tx(() => trade.setOffer(alice, lid, { wood: 1e9 }, T)).error, 'cannot offer more than owned');

  // --- Confirming, then changing an offer, resets confirmations ---
  tx(() => trade.confirm(alice, lid, true, T));
  ok(tx(() => trade.getLobbyState(alice, lid, T)).you.confirmed, 'alice is confirmed');
  tx(() => trade.setOffer(bob, lid, { iron: 120 }, T)); // change → reset both
  ok(!tx(() => trade.getLobbyState(alice, lid, T)).you.confirmed, 'changing an offer reset alice’s confirmation');
  ok(near(wallet(bob).iron, 680), 'raising the offer escrows more (700 → 680)');

  // --- Both confirm → atomic swap ---
  tx(() => trade.confirm(alice, lid, true, T));
  ok(tx(() => trade.confirm(bob, lid, true, T)).completed, 'trade executes when both confirm');
  ok(near(wallet(alice).iron, 120), 'alice received 120 iron');
  ok(near(wallet(bob).wood, 200), 'bob received 200 wood');
  ok(near(wallet(alice).wood, 800), 'alice keeps her remaining 800 wood');
  ok(tx(() => trade.getLobbyState(alice, lid, T)).status === 'completed', 'lobby marked completed');
  ok(trade.history(alice).length === 1 && trade.history(bob).length === 1, 'trade is in both histories');

  // --- Leaving refunds escrow ---
  const dave = mkUser('t_dave');
  seed(dave, { wood: 300 });
  const l2 = tx(() => trade.createLobby(dave)).id;
  tx(() => trade.setOffer(dave, l2, { wood: 150 }, T));
  ok(near(wallet(dave).wood, 150), 'dave escrowed 150 wood');
  tx(() => trade.leaveLobby(dave, l2, T));
  ok(near(wallet(dave).wood, 300), 'leaving refunds the escrow (back to 300)');
  ok(tx(() => trade.getLobbyState(dave, l2, T)).status === 'cancelled', 'lobby cancelled on leave');

  // --- Double-spend across lobbies is impossible (escrow already removed) ---
  const frank = mkUser('t_frank');
  seed(frank, { wood: 100 });
  const la = tx(() => trade.createLobby(frank)).id;
  const lb = tx(() => trade.createLobby(frank)).id;
  ok(tx(() => trade.setOffer(frank, la, { wood: 100 }, T)).ok, 'frank escrows all 100 wood in lobby A');
  ok(tx(() => trade.setOffer(frank, lb, { wood: 50 }, T)).error, 'cannot offer the same wood again in lobby B');

  // --- Access control ---
  ok(tx(() => trade.getLobbyState(mkUser('t_outsider'), lid, T)).error, 'non-participant cannot view a lobby');

  // --- Expiry sweep refunds stale lobbies ---
  const gus = mkUser('t_gus');
  seed(gus, { wood: 200 });
  const l3 = tx(() => trade.createLobby(gus)).id;
  tx(() => trade.setOffer(gus, l3, { wood: 80 }, T));
  db.prepare('UPDATE lobbies SET updated_at = ? WHERE id = ?').run(1, l3); // backdate → stale
  trade.sweepExpired(T);
  ok(near(wallet(gus).wood, 200), 'sweep refunded the stale lobby’s escrow');
  ok(tx(() => trade.getLobbyState(gus, l3, T)).status === 'cancelled', 'sweep cancelled the stale lobby');

  // --- HTTP wiring + auth ---
  ok((await api('/api/lobbies')).status === 401, 'lobbies require auth');
  const reg = await api('/api/auth/register', { method: 'POST', body: { username: 'trader', email: 't@x.com', password: 'sup3rsecret' } });
  const token = reg.json.token;
  const created = await api('/api/lobbies', { method: 'POST', token, body: { title: 'HTTP' } });
  ok(created.status === 200 && created.json.id, 'POST /api/lobbies creates a lobby');
  const view = await api('/api/lobbies/' + created.json.id, { token });
  ok(view.status === 200 && view.json.status === 'open', 'GET /api/lobbies/:id returns the creator’s lobby');
  ok((await api('/api/lobbies/history', { token })).status === 200, '/api/lobbies/history is reachable (not shadowed by :id)');
} catch (err) {
  fail++; console.error('  ✗ unexpected error:', err);
} finally {
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(DB + ext); } catch {} }
  console.log(`\n${fail === 0 ? '✅' : '❌'} trade test: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
