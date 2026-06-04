/**
 * Tests for the server-authoritative economy (Part 2a). The server runs the
 * canonical Game per player; we exercise it through the economy module:
 * clicks (+rate limit), asset/upgrade purchases, passive accrual, prestige
 * guard, and persistence across calls.
 *
 *   Run:  node server/test-economy.mjs   (Node ≥ 22)
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const DB = join(tmpdir(), `imperium-econtest-${Date.now()}.db`);
process.env.DB_PATH = DB;

const { queries } = await import('./db.js');
const E = await import('./economy.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } };
const inRange = (x, lo, hi) => x >= lo && x <= hi;
const mkUser = (n) => queries.createUser({ username: n, token: 'tk-' + n, isGuest: 1 }).id;

try {
  const T = 1_700_000_000_000;

  // --- Fresh state ---
  const u = mkUser('econ');
  const s0 = E.snapshot(u, T);
  ok(s0.money === 0 && s0.clickValue === 1 && s0.perSecond === 0, 'fresh economy: €0, click 1, 0/s');

  // --- Clicks earn money (server-known click value) ---
  const c = E.applyClicks(u, 30, T);
  ok(c.applied === 30, 'all 30 clicks applied within the burst');
  ok(inRange(c.money, 29, 32), `~30 € from 30 clicks (got ${c.money.toFixed(2)})`);

  // --- Click rate limit: a huge batch is capped to the burst, not granted ---
  const u2 = mkUser('spammer');
  const spam = E.applyClicks(u2, 100000, T);
  ok(spam.applied <= 30 && spam.applied > 0, `click batch capped at the burst (applied ${spam.applied}, not 100000)`);

  // --- Buying an asset deducts money + raises €/s ---
  const buy = E.buyAsset(u, 'local-0', 1, T);
  ok(buy.ok && inRange(buy.money, 14, 18), 'asset bought, ~15 € deducted');
  ok(buy.perSecond > 0, `€/s rises after buying an asset (${buy.perSecond.toFixed(4)})`);

  // --- Passive income accrues over (capped) time ---
  const later = E.snapshot(u, T + 8 * 3600 * 1000); // +8 h
  ok(later.money > buy.money + 100, `passive income accrued offline (${later.money.toFixed(1)})`);

  // --- Buying an upgrade applies its effect (click value) ---
  const up = E.buyUpgrade(u, 'click-1', T + 8 * 3600 * 1000); // "Bessere Maus": click ×2
  ok(up.ok, 'click upgrade purchased');
  ok(up.clickValue > 1.9, `click value roughly doubled (${up.clickValue.toFixed(2)})`);

  // --- Can't afford → rejected, money unchanged ---
  const poor = mkUser('poor');
  const bad = E.buyAsset(poor, 'local-6', 1, T); // expensive asset, no money
  ok(bad.ok === false && bad.money === 0, 'unaffordable purchase rejected, money unchanged');
  ok(E.buyUpgrade(poor, 'does-not-exist', T).ok === false, 'unknown upgrade rejected');

  // --- Prestige guard: not enough lifetime earnings → no prestige ---
  ok(E.prestige(poor, T).ok === false, 'prestige refused below the threshold');

  // --- Persistence: a fresh load reflects the stored state ---
  const reload = E.snapshot(u, T + 8 * 3600 * 1000);
  ok(reload.save.upgrades.some((x) => x.id === 'click-1' && x.purchased), 'purchased upgrade persisted');
  ok((reload.save.worlds[0].assets.find((a) => a.id === 'local-0')?.count ?? 0) >= 1, 'asset count persisted');

  // --- Money interface for trades (Part 2c) ---
  const before = E.getMoney(u, T + 8 * 3600 * 1000);
  ok(E.spendMoney(u, 5, T + 8 * 3600 * 1000) === true, 'spendMoney succeeds when affordable');
  ok(Math.abs(E.getMoney(u, T + 8 * 3600 * 1000) - (before - 5)) < 1.0, 'spendMoney deducted ~5');
  ok(E.spendMoney(u, 1e30, T + 8 * 3600 * 1000) === false, 'spendMoney rejects more than owned');
} catch (err) {
  fail++; console.error('  ✗ unexpected error:', err);
} finally {
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(DB + ext); } catch {} }
  console.log(`\n${fail === 0 ? '✅' : '❌'} economy test: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
