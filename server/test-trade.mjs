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
const economy = await import('./economy.js');

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
const seed = (uid, res) => tx(() => { for (const [k, v] of Object.entries(res)) queries.setResource(uid, k, v); });
const wallet = (uid) => Object.fromEntries(queries.getResources(uid).map((r) => [r.type, r.amount]));

try {
  const alice = mkUser('t_alice'), bob = mkUser('t_bob');
  seed(alice, { local_common: 1000, local_uncommon: 500 });
  seed(bob, { national_common: 800, national_uncommon: 200 });

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
  ok(tx(() => trade.setOffer(alice, lid, { local_common: 200 }, T)).ok, 'alice offers 200 local_common');
  ok(near(wallet(alice).local_common, 800), 'alice local_common escrowed (1000 → 800)');
  ok(tx(() => trade.setOffer(bob, lid, { national_common: 100 }, T)).ok, 'bob offers 100 national_common');
  ok(near(wallet(bob).national_common, 700), 'bob national_common escrowed (800 → 700)');
  ok(tx(() => trade.setOffer(alice, lid, { local_common: 1e9 }, T)).error, 'cannot offer more than owned');

  // --- Confirming, then changing an offer, resets confirmations ---
  tx(() => trade.confirm(alice, lid, true, T));
  ok(tx(() => trade.getLobbyState(alice, lid, T)).you.confirmed, 'alice is confirmed');
  tx(() => trade.setOffer(bob, lid, { national_common: 120 }, T)); // change → reset both
  ok(!tx(() => trade.getLobbyState(alice, lid, T)).you.confirmed, 'changing an offer reset alice’s confirmation');
  ok(near(wallet(bob).national_common, 680), 'raising the offer escrows more (700 → 680)');

  // --- Both confirm → atomic swap ---
  tx(() => trade.confirm(alice, lid, true, T));
  ok(tx(() => trade.confirm(bob, lid, true, T)).completed, 'trade executes when both confirm');
  ok(near(wallet(alice).national_common, 120), 'alice received 120 national_common');
  ok(near(wallet(bob).local_common, 200), 'bob received 200 local_common');
  ok(near(wallet(alice).local_common, 800), 'alice keeps her remaining 800 local_common');
  ok(tx(() => trade.getLobbyState(alice, lid, T)).status === 'completed', 'lobby marked completed');
  ok(trade.history(alice).length === 1 && trade.history(bob).length === 1, 'trade is in both histories');

  // --- Leaving refunds escrow ---
  const dave = mkUser('t_dave');
  seed(dave, { local_common: 300 });
  const l2 = tx(() => trade.createLobby(dave)).id;
  tx(() => trade.setOffer(dave, l2, { local_common: 150 }, T));
  ok(near(wallet(dave).local_common, 150), 'dave escrowed 150 local_common');
  tx(() => trade.leaveLobby(dave, l2, T));
  ok(near(wallet(dave).local_common, 300), 'leaving refunds the escrow (back to 300)');
  ok(tx(() => trade.getLobbyState(dave, l2, T)).status === 'cancelled', 'lobby cancelled on leave');

  // --- Double-spend across lobbies is impossible (escrow already removed) ---
  const frank = mkUser('t_frank');
  seed(frank, { local_common: 100 });
  const la = tx(() => trade.createLobby(frank)).id;
  const lb = tx(() => trade.createLobby(frank)).id;
  ok(tx(() => trade.setOffer(frank, la, { local_common: 100 }, T)).ok, 'frank escrows all 100 local_common in lobby A');
  ok(tx(() => trade.setOffer(frank, lb, { local_common: 50 }, T)).error, 'cannot offer the same local_common again in lobby B');

  // --- Money in trades (Part 2c): server-authoritative € + resources combo ---
  const mona = mkUser('t_mona'), nick = mkUser('t_nick');
  economy.addMoney(mona, 5000, T);                 // server-authoritative balance
  seed(mona, { local_common: 50 });
  seed(nick, { national_common: 10 });
  const ml = tx(() => trade.createLobby(mona, 'Geld+Holz')).id;
  tx(() => trade.joinLobby(nick, ml));
  // Mona offers 1000 € + 10 local_common; the money leaves her balance into escrow.
  ok(tx(() => trade.setOffer(mona, ml, { resources: { local_common: 10 }, money: 1000 }, T)).ok, 'offer with money + resources accepted');
  ok(Math.abs(economy.peekMoney(mona) - 4000) < 1, 'offered money moved into escrow (5000 → 4000)');
  ok(tx(() => trade.setOffer(mona, ml, { money: 999999999 }, T)).error === 'Nicht genug Geld.', 'cannot offer more money than owned');
  tx(() => trade.setOffer(nick, ml, { resources: { national_common: 5 } }, T));
  tx(() => trade.confirm(mona, ml, true, T));
  ok(tx(() => trade.confirm(nick, ml, true, T)).completed, 'money+resource trade executes');
  ok(Math.abs(economy.getMoney(nick, T) - 1000) < 1, 'nick received the 1000 €');
  ok(Math.abs(economy.getMoney(mona, T) - 4000) < 1, 'mona keeps her remaining 4000 € (1000 went to nick)');
  ok(near(wallet(nick).local_common, 10), 'nick received the 10 local_common');
  ok(near(wallet(mona).national_common, 5), 'mona received the 5 national_common');

  // Leaving refunds escrowed money too.
  const owen = mkUser('t_owen');
  economy.addMoney(owen, 800, T);
  const ol = tx(() => trade.createLobby(owen)).id;
  tx(() => trade.setOffer(owen, ol, { money: 500 }, T));
  ok(Math.abs(economy.peekMoney(owen) - 300) < 1, 'owen escrowed 500 € (800 → 300)');
  tx(() => trade.leaveLobby(owen, ol, T));
  ok(Math.abs(economy.getMoney(owen, T) - 800) < 1, 'leaving refunded the escrowed money (back to 800)');

  // --- Access control ---
  ok(tx(() => trade.getLobbyState(mkUser('t_outsider'), lid, T)).error, 'non-participant cannot view a lobby');

  // --- Expiry sweep refunds stale lobbies ---
  const gus = mkUser('t_gus');
  seed(gus, { local_common: 200 });
  const l3 = tx(() => trade.createLobby(gus)).id;
  tx(() => trade.setOffer(gus, l3, { local_common: 80 }, T));
  db.prepare('UPDATE lobbies SET updated_at = ? WHERE id = ?').run(1, l3); // backdate → stale
  trade.sweepExpired(T);
  ok(near(wallet(gus).local_common, 200), 'sweep refunded the stale lobby’s escrow');
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
