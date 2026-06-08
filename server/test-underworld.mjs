/**
 * Tests for the server-authoritative UNDERWORLD (shadow economy).
 * Covers: jobs (dirty cash + heat + contraband drop), fence selling, the lazy
 * laundering pipeline (fee + conversion over time), the heat→catch→penalty loop,
 * and single-realm trading (dirty↔dirty swap; legal↔dirty blocked).
 *
 *   Run:  node server/test-underworld.mjs   (Node ≥ 22)
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const DB = join(tmpdir(), `imperium-uwtest-${Date.now()}.db`);
process.env.DB_PATH = DB;

const { queries } = await import('./db.js');
const economy = await import('./economy.js');
const uw = await import('./underworld.js');
const trade = await import('./trade.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } };
const mkUser = (n) => queries.createUser({ username: n, token: 'tk-' + n, isGuest: 1 }).id;
const T = 1_700_000_000_000;

try {
  // --- Config ---
  const cfg = uw.config();
  ok(cfg.jobs.length >= 4, `jobs present (${cfg.jobs.length})`);
  ok(cfg.contraband.length === 6 && cfg.contraband.every((c) => c.color && c.value > 0), '6 contraband items with value + colour');
  ok(cfg.heat.max === 100 && cfg.launder.feePct > 0 && cfg.penalty.dirtyLossPct > 0, 'heat/launder/penalty config present');

  // --- A safe job earns dirty money + heat, no catch below the safe threshold ---
  const u = mkUser('crook');
  const j = uw.doJob(u, 'protection', T); // heat 10 ≤ safe 30 → 0% catch
  ok(j.ok && j.cash >= 300 && j.cash <= 800, `protection pays in range (${j.cash})`);
  ok(j.dirtyMoney === j.cash && j.heat === 10 && j.caught === false, 'dirty money + heat applied, not caught');

  // --- Smuggle always drops contraband ---
  const sm = uw.doJob(u, 'smuggle', T);
  ok(sm.ok && sm.drop && uw.config().contraband.some((c) => c.id === sm.drop.id), 'smuggle drops a contraband item');
  ok(sm.items[sm.drop.id] >= 1, 'dropped contraband is in the inventory');

  // --- Fence: selling contraband adds dirty money = value × qty ---
  const dirtyBefore = sm.dirtyMoney;
  const item = uw.config().contraband.find((c) => c.id === sm.drop.id);
  const sale = uw.sellContraband(u, sm.drop.id, 1, T);
  ok(sale.ok && Math.abs((sale.dirtyMoney - dirtyBefore) - item.value) < 1e-6, `fence pays the item value (+${item.value})`);
  ok(sale.items[sm.drop.id] === (sm.items[sm.drop.id] - 1), 'sold contraband leaves the inventory');

  // --- Laundering: capped queue, converts over time minus the fee ---
  const w = mkUser('washer');
  uw.addDirty(w, 100_000, T);
  const lr = uw.launder(w, 1_000, T);
  ok(lr.ok && lr.queued > 0 && lr.wash.queue === lr.queued, 'dirty money queued into the laundromat');
  ok(uw.peekDirty(w) === 100_000 - lr.queued, 'queued amount left the dirty pot');
  const legalBefore = economy.peekMoney(w);
  // advance ~1h: rate floor 5/s → converts the whole 1000 queue, minus 25% fee.
  const after = uw.snapshot(w, T + 3_600_000);
  ok(after.wash.queue < 1e-6, 'laundromat queue fully converted over time');
  const gained = economy.peekMoney(w) - legalBefore;
  ok(Math.abs(gained - lr.queued * (1 - cfg.launder.feePct)) < 1.0, `legal money credited minus fee (+${gained.toFixed(0)})`);

  // --- Laundering is capped (can't queue beyond capacity) ---
  const capUser = mkUser('caps');
  uw.addDirty(capUser, 1e9, T);
  const big = uw.launder(capUser, 1e9, T);
  ok(big.ok && big.queued <= big.wash.capacity + 1, 'laundering is capped at capacity');

  // --- Heat → catch → penalty (only dirty money; heat resets) ---
  const r = mkUser('risky');
  uw.addDirty(r, 50_000, T);
  let caught = null;
  for (let i = 0; i < 60; i++) { const res = uw.doJob(r, 'heist', T); if (res.caught) { caught = res; break; } }
  ok(caught !== null, 'a catch eventually happens at high heat');
  ok(caught && caught.lost > 0 && caught.heat === 0, 'penalty seizes dirty money and resets heat');
  const legalSafe = mkUser('safe-legal');
  // (Sanity) legal money is a different pot entirely — never touched by uw here.
  economy.addMoney(legalSafe, 1234, T);
  ok(economy.peekMoney(legalSafe) === 1234, 'legal money pot is independent of the underworld');

  // --- Single-realm trading: dirty↔dirty swaps; legal↔dirty is blocked ---
  const A = mkUser('mob-a'), B = mkUser('mob-b');
  uw.addDirty(A, 5_000, T); queries.setUwItem(A, 'uw_rare', 2);
  uw.addDirty(B, 1_000, T); queries.setUwItem(B, 'uw_common', 3);
  economy.addMoney(B, 1_000, T); // B *has* legal money, but must not be able to cross realms
  const lobby = trade.createLobby(A, 'mafia').id;
  trade.joinLobby(B, lobby);

  ok(trade.setOffer(A, lobby, { dirtyMoney: 2_000, uwItems: { uw_rare: 1 } }, T).ok, 'A offers dirty money + contraband');
  ok(uw.peekDirty(A) === 3_000, 'offered dirty money moved into escrow');
  ok(trade.setOffer(A, lobby, { money: 50, dirtyMoney: 10 }, T).error, 'mixing legal + dirty in one offer is rejected');
  ok(trade.setOffer(B, lobby, { money: 100 }, T).error, 'legal offer is blocked when the lobby is an underworld trade');

  ok(trade.setOffer(B, lobby, { dirtyMoney: 500, uwItems: { uw_common: 2 } }, T).ok, 'B offers dirty money + contraband');
  trade.confirm(A, lobby, true, T);
  const done = trade.confirm(B, lobby, true, T);
  ok(done.completed, 'underworld trade completes when both confirm');
  ok(uw.peekDirty(A) === 3_000 + 500, 'A received B\'s dirty money');
  ok(uw.peekDirty(B) === 500 + 2_000, 'B received A\'s dirty money');
  ok(uw.snapshot(A, T).items['uw_common'] === 2 && uw.snapshot(B, T).items['uw_rare'] === 1, 'contraband swapped both ways');

  // --- Refund path: leaving returns escrowed dirty money + contraband ---
  const l2 = trade.createLobby(A, 'refund').id;
  trade.setOffer(A, l2, { dirtyMoney: 1_000, uwItems: { uw_rare: 1 } }, T);
  ok(uw.peekDirty(A) === 2_500, 'dirty money escrowed for the refund test');
  trade.leaveLobby(A, l2, T);
  ok(uw.peekDirty(A) === 3_500, 'leaving refunds the escrowed dirty money');
} catch (err) {
  fail++; console.error('  ✗ unexpected error:', err);
} finally {
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(DB + ext); } catch {} }
  console.log(`\n${fail === 0 ? '✅' : '❌'} underworld test: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
