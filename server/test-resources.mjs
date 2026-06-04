/**
 * Tests for the rarity-based active drop system (resources overhaul):
 * per-world energy (regen + cap), crypto-secure rolls, rough rarity
 * distribution, boosters, and the anti-burst rate limit.
 *
 *   Run:  node server/test-resources.mjs   (Node ≥ 22)
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const DB = join(tmpdir(), `imperium-rtest-${Date.now()}.db`);
process.env.DB_PATH = DB;

const { queries } = await import('./db.js');
const R = await import('./resources.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } };
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const mkUser = (n) => queries.createUser({ username: n, token: 'tk-' + n, isGuest: 1 }).id;

try {
  const T = 1_000_000_000_000;

  // --- Config ---
  const cfg = R.config();
  ok(cfg.rarities.length === 6, 'config has 6 rarity tiers');
  ok(cfg.worlds.length === 9 && cfg.worlds.every((w) => w.resources.length === 6), 'each of 9 worlds has 6 resources');
  ok(cfg.rarities.every((r) => /^#/.test(r.color)), 'every rarity has a colour');
  ok(cfg.boosters.length === 9, 'one booster per world');

  // --- Energy starts full, a roll costs 1 ---
  const u1 = mkUser('roller');
  const snap0 = R.snapshot(u1, T);
  ok(near(snap0.energy.local.energy, R.ENERGY.max, 1e-6), 'energy starts at max on first contact');
  const r1 = R.roll(u1, 'local', T);
  ok(r1.ok && near(r1.energy, R.ENERGY.max - 1, 1e-6), 'a roll costs 1 energy');
  ok(r1.drop && r1.drop.type === `local_${r1.drop.rarity}`, 'drop type matches its world + rarity');
  ok(r1.drop.qty >= 1, 'drop quantity is at least 1');
  ok((R.snapshot(u1, T).resources[r1.drop.type] ?? 0) >= r1.drop.qty, 'drop landed in the inventory');
  ok(R.roll(u1, 'spaco', T).error, 'rolling an unknown world is rejected');

  // --- Energy depletes, then refuses, then regenerates ---
  const u2 = mkUser('drainer');
  for (let i = 0; i < R.ENERGY.max; i++) R.roll(u2, 'tech', T);     // drain to 0
  ok(R.roll(u2, 'tech', T).error === 'Nicht genug Energie.', 'roll refused when energy is 0');
  const regen = R.roll(u2, 'tech', T + 72_000);                     // +72 s ≈ +2 energy
  ok(regen.ok, 'roll works again after energy regenerates');

  // --- Rough rarity distribution over many CSPRNG rolls ---
  const u3 = mkUser('stats');
  const counts = {}; let total = 0; let now = T; let badType = 0;
  for (let batch = 0; batch < 120; batch++) {
    now += 9 * 3600 * 1000; // > offline cap → energy back to full each batch
    for (let i = 0; i < R.ENERGY.max; i++) {
      const r = R.roll(u3, 'finance', now);
      if (!r.ok) continue;
      counts[r.drop.rarity] = (counts[r.drop.rarity] ?? 0) + 1; total++;
      if (r.drop.type !== `finance_${r.drop.rarity}`) badType++;
    }
  }
  ok(total > 5000, `enough rolls for statistics (${total})`);
  ok(badType === 0, 'every drop is a valid finance resource of its rolled rarity');
  ok(Object.keys(counts).length === 6, 'all six rarities occur');
  ok(counts.common / total > 0.50 && counts.common / total < 0.66, `common ~58% (got ${(100 * counts.common / total).toFixed(1)}%)`);
  ok(counts.mythic / total > 0.002 && counts.mythic / total < 0.025, `mythic ~1% (got ${(100 * counts.mythic / total).toFixed(2)}%)`);

  // --- Boosters: bought with resources, raise the energy cap ---
  const u4 = mkUser('builder');
  queries.setResource(u4, 'local_common', 1000);
  queries.setResource(u4, 'local_uncommon', 1000);
  ok(R.snapshot(u4, T).energy.local.max === R.ENERGY.max, 'energy cap is base before any booster');
  ok(R.buyBooster(u4, 'boost_local', T).ok, 'booster purchase succeeds when affordable');
  ok(R.snapshot(u4, T).energy.local.max === R.ENERGY.max + R.BOOSTERS[0].effect.energyMax, 'booster raised the energy cap');
  ok((R.snapshot(u4, T).buildings.boost_local ?? 0) === 1, 'booster level is 1');
  const u5 = mkUser('poor');
  ok(R.buyBooster(u5, 'boost_local', T).error, 'booster rejected without resources');
  ok(R.buyBooster(u4, 'nope', T).error, 'unknown booster rejected');

  // --- Anti-burst token bucket ---
  const uid = 9999;
  let allowed = 0;
  for (let i = 0; i < 20; i++) if (R.rollAllowed(uid, T)) allowed++;   // same instant
  ok(allowed === R.ROLL_LIMIT.burst, `burst capped at ${R.ROLL_LIMIT.burst} (got ${allowed})`);
  ok(!R.rollAllowed(uid, T), 'further rolls in the same instant are blocked');
  let after = 0;
  for (let i = 0; i < 20; i++) if (R.rollAllowed(uid, T + 1000)) after++; // +1 s → +ratePerSec tokens
  ok(after === R.ROLL_LIMIT.ratePerSec, `~${R.ROLL_LIMIT.ratePerSec} tokens refilled after 1 s (got ${after})`);

  // --- The drop-system reset marker is set ---
  ok(queries.getMeta('drops_v2_reset') === '1', 'one-time reset marker recorded');
} catch (err) {
  fail++; console.error('  ✗ unexpected error:', err);
} finally {
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(DB + ext); } catch {} }
  console.log(`\n${fail === 0 ? '✅' : '❌'} resources test: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
