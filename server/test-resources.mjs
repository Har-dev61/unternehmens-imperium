/**
 * Tests for the server-authoritative resource economy (Phase 2): lazy
 * settlement (base-rate accrual + 8 h cap), resource-paid building purchases
 * (deduction, rate increase, affordability), and the HTTP endpoints.
 *
 *   Run:  node server/test-resources.mjs   (Node ≥ 22)
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const PORT = 3988;
const DB = join(tmpdir(), `imperium-rtest-${Date.now()}.db`);
process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';
process.env.DB_PATH = DB;
process.env.AUTH_RATE_LIMIT = '100000';
process.env.API_RATE_LIMIT = '100000';
process.env.RESOURCE_OFFLINE_CAP_SECONDS = String(8 * 3600);

await import('./server.js');                       // starts listening + opens the DB
const { queries, tx } = await import('./db.js');   // same singletons as the server
const resources = await import('./resources.js');

const base = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const api = async (path, { method = 'GET', body, token } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = {}; try { json = await res.json(); } catch {}
  return { status: res.status, json };
};
for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }

const mkUser = (name) => queries.createUser({ username: name, token: 'tok-' + name, isGuest: 1 }).id;
const amounts = (uid) => Object.fromEntries(queries.getResources(uid).map((r) => [r.type, r.amount]));

try {
  const T0 = 1_000_000_000_000;

  // --- A) Base-rate accrual over 1 h ---
  const u1 = mkUser('settle1');
  tx(() => resources.settle(u1, T0));                 // first contact → starts the clock, no pay
  ok(Object.keys(amounts(u1)).length === 0, 'first settle does not retro-pay');
  tx(() => resources.settle(u1, T0 + 3600_000));      // +1 h
  const a1 = amounts(u1);
  ok(near(a1.wood, 0.5 * 3600, 1e-3), `wood accrues at base rate (got ${a1.wood})`);
  ok(near(a1.stone, 0.3 * 3600, 1e-3), `stone accrues at base rate (got ${a1.stone})`);

  // --- B) Offline cap at 8 h ---
  const u2 = mkUser('settle2');
  tx(() => resources.settle(u2, T0));
  tx(() => resources.settle(u2, T0 + 100 * 3600_000)); // 100 h away → capped to 8 h
  ok(near(amounts(u2).wood, 0.5 * 8 * 3600, 1e-3), `offline production capped at 8 h (got ${amounts(u2).wood})`);

  // --- C) Purchase deducts resources, adds a building, raises the rate ---
  const u3 = mkUser('buyer');
  tx(() => resources.settle(u3, T0));
  tx(() => resources.settle(u3, T0 + 3600_000));       // ~1800 wood
  const woodBefore = amounts(u3).wood;
  const r = tx(() => resources.purchase(u3, 'sawmill', 1, T0 + 3600_000));
  ok(r.ok, 'sawmill purchase succeeds when affordable');
  ok(near(amounts(u3).wood, woodBefore - 20, 1e-3), 'sawmill cost (20 wood) deducted');
  const snap = tx(() => resources.snapshot(u3, T0 + 3600_000));
  ok(snap.buildings.sawmill === 1, 'sawmill building count is 1');
  ok(near(snap.rates.wood, 0.5 + 1.0, 1e-9), `wood rate rises with the building (got ${snap.rates.wood})`);

  // second sawmill costs more (geometric 20 × 1.15)
  const r2 = tx(() => resources.purchase(u3, 'sawmill', 1, T0 + 3600_000));
  ok(r2.ok, 'second sawmill purchase succeeds');
  ok(tx(() => resources.snapshot(u3, T0 + 3600_000)).buildings.sawmill === 2, 'sawmill count is 2');

  // --- D) Can't afford / unknown building ---
  const u4 = mkUser('broke');
  tx(() => resources.settle(u4, T0));                  // ~0 resources
  ok(tx(() => resources.purchase(u4, 'foundry', 1, T0)).error, 'unaffordable purchase rejected');
  ok(tx(() => resources.purchase(u4, 'does_not_exist', 1, T0)).error, 'unknown building rejected');
  ok(queries.getBuildings(u4).length === 0, 'no building added on a failed purchase');

  // --- E) HTTP endpoints (auth + validation) ---
  const cfg = await api('/api/resources/config');
  ok(cfg.status === 200 && Array.isArray(cfg.json.worlds) && cfg.json.worlds.length === 9, 'config lists 9 worlds');
  ok(cfg.json.capSeconds === 8 * 3600, 'config exposes the 8 h cap');

  ok((await api('/api/resources')).status === 401, 'resources require auth');

  const reg = await api('/api/auth/register', { method: 'POST', body: { username: 'rich', email: 'rich@x.com', password: 'sup3rsecret' } });
  const token = reg.json.token;
  const uid = queries.getUserByName('rich').id;

  let g = await api('/api/resources', { token });
  ok(g.status === 200 && typeof g.json.resources.wood === 'number', 'GET /api/resources returns stocks');

  // Not enough yet (fresh account) → 400
  ok((await api('/api/resources/build', { method: 'POST', token, body: { buildingId: 'sawmill' } })).status === 400, 'build rejected without resources');

  // Seed wood server-side, then the HTTP build should succeed and deduct.
  tx(() => { resources.settle(uid); queries.setResource(uid, 'wood', 1000); });
  const built = await api('/api/resources/build', { method: 'POST', token, body: { buildingId: 'sawmill', quantity: 1 } });
  ok(built.status === 200 && built.json.buildings.sawmill === 1, 'HTTP build succeeds and reports the building');
  ok(built.json.resources.wood < 1000, 'HTTP build deducted resources');
} catch (err) {
  fail++; console.error('  ✗ unexpected error:', err);
} finally {
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(DB + ext); } catch {} }
  console.log(`\n${fail === 0 ? '✅' : '❌'} resources test: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
