/**
 * Tests for the server-authoritative LOOTBOX system.
 * Covers: atomic buy (money spent before grant), insufficient-funds rejection,
 * CSPRNG result validity, per-box odds skew, world-box scoping, inventory
 * persistence, and trading cosmetic items through the lobby escrow.
 *
 *   Run:  node server/test-lootbox.mjs   (Node ≥ 22)
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const DB = join(tmpdir(), `imperium-loottest-${Date.now()}.db`);
process.env.DB_PATH = DB;
// Cheap, fixed prices so we can open many boxes in the test.
process.env.LOOTBOX_PRICE_STANDARD = '100';
process.env.LOOTBOX_PRICE_WORLD = '100';
process.env.LOOTBOX_PRICE_PREMIUM = '100';
process.env.LOOTBOX_PRICE_EVENT = '100';

const { queries, tx } = await import('./db.js');
const economy = await import('./economy.js');
const lootbox = await import('./lootbox.js');
const trade = await import('./trade.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } };
const mkUser = (n) => queries.createUser({ username: n, token: 'tk-' + n, isGuest: 1 }).id;
const RARITY_IDS = new Set(lootbox.config().rarities.map((r) => r.id));
const open = (u, box, world) => tx(() => lootbox.open(u, box, world));

try {
  // --- Config is well-formed ---
  const cfg = lootbox.config();
  ok(cfg.boxes.length >= 3, `box catalogue present (got ${cfg.boxes.length})`);
  ok(cfg.items.length === 54, `54 items = 9 worlds x 6 rarities (got ${cfg.items.length})`);
  ok(cfg.items.every((it) => RARITY_IDS.has(it.rarity) && it.color), 'every item has a valid rarity + colour');
  const std = cfg.boxes.find((b) => b.id === 'standard');
  ok(Math.abs(Object.values(std.odds).reduce((s, x) => s + x, 0) - 100) < 1e-6, 'standard odds sum to 100%');

  // --- Insufficient funds → rejected, nothing granted ---
  const poor = mkUser('poor');
  const bad = open(poor, 'standard');
  ok(bad.error && bad.ok === undefined, 'open without money is rejected');
  ok(Object.values(lootbox.inventory(poor).items).every((c) => c === 0), 'no item granted on failed open');

  // --- Atomic buy: money spent before grant ---
  const u = mkUser('buyer');
  economy.addMoney(u, 1_000_000);
  const before = economy.getMoney(u);
  const r = open(u, 'standard');
  ok(r.ok && r.item && RARITY_IDS.has(r.item.rarity), 'standard open returns a valid item');
  ok(Math.abs((before - economy.getMoney(u)) - 100) < 1e-6, 'exactly the box price was deducted');
  ok(lootbox.inventory(u).items[r.item.id] === 1, 'granted item shows up in inventory');

  // --- Inventory persists + stacks across opens ---
  let opens = 0;
  for (let i = 0; i < 50; i++) { if (open(u, 'standard').ok) opens++; }
  const totalOwned = Object.values(lootbox.inventory(u).items).reduce((s, c) => s + c, 0);
  ok(totalOwned === opens + 1, `inventory stacks every grant (owned ${totalOwned}, opens ${opens + 1})`);

  // --- CSPRNG odds skew: premium yields more rare+ than standard ---
  const sampler = mkUser('sampler');
  economy.addMoney(sampler, 1e9);
  const rarePlus = new Set(['rare', 'epic', 'legendary', 'mythic']);
  const share = (box) => {
    let hi = 0; const N = 600;
    for (let i = 0; i < N; i++) { const d = open(sampler, box); if (d.ok && rarePlus.has(d.item.rarity)) hi++; }
    return hi / N;
  };
  const stdShare = share('standard');
  const premShare = share('premium');
  ok(premShare > stdShare, `premium rare+ share (${premShare.toFixed(2)}) > standard (${stdShare.toFixed(2)})`);
  ok(stdShare < 0.35, `standard is mostly common/uncommon (rare+ ${stdShare.toFixed(2)})`);

  // --- World box is scoped to the chosen world ---
  const wexplorer = mkUser('worlds');
  economy.addMoney(wexplorer, 1e7);
  let allTech = true;
  for (let i = 0; i < 30; i++) { const d = open(wexplorer, 'world', 'tech'); if (d.ok && d.item.world !== 'tech') allTech = false; }
  ok(allTech, 'world-box only drops items from the chosen world');
  ok(open(wexplorer, 'world', 'nope').error, 'world-box with an invalid world is rejected');

  // --- Event box honours its active flag ---
  ok(cfg.boxes.some((b) => b.id === 'event'), 'event box is active by default');

  // --- Trading cosmetic items through escrow (atomic swap) ---
  const A = mkUser('trader-a'), B = mkUser('trader-b');
  queries.setItem(A, 'item_tech_rare', 3);
  queries.setItem(B, 'item_ai_epic', 1);
  const lobbyId = tx(() => trade.createLobby(A, 'items')).id;
  tx(() => trade.joinLobby(B, lobbyId));

  // A escrows 2 of its 3 tech-rare items → bag drops to 1, escrow holds 2.
  ok(tx(() => trade.setOffer(A, lobbyId, { items: { item_tech_rare: 2 } })).ok, 'A offers 2 items');
  ok(lootbox.inventory(A).items['item_tech_rare'] === 1, 'offered items leave the bag (escrow)');
  const sA = tx(() => trade.getLobbyState(A, lobbyId));
  ok(sA.you.offer.items['item_tech_rare'] === 2, 'lobby state reflects A\'s item offer');

  // Over-offering more than owned is rejected.
  ok(tx(() => trade.setOffer(A, lobbyId, { items: { item_tech_rare: 99 } })).error, 'cannot offer more items than owned');

  // Both sides offer + confirm → atomic swap.
  tx(() => trade.setOffer(A, lobbyId, { items: { item_tech_rare: 2 } }));
  tx(() => trade.setOffer(B, lobbyId, { items: { item_ai_epic: 1 } }));
  tx(() => trade.confirm(A, lobbyId, true));
  const done = tx(() => trade.confirm(B, lobbyId, true));
  ok(done.completed, 'trade completes when both confirm');
  ok(lootbox.inventory(A).items['item_ai_epic'] === 1, 'A received B\'s item');
  ok(lootbox.inventory(B).items['item_tech_rare'] === 2, 'B received A\'s items');
  ok(lootbox.inventory(A).items['item_tech_rare'] === 1, 'A keeps the un-offered item');

  // Refund path: escrow returns on leave.
  const l2 = tx(() => trade.createLobby(A, 'refund')).id;
  tx(() => trade.setOffer(A, l2, { items: { item_tech_rare: 1 } }));
  ok(lootbox.inventory(A).items['item_tech_rare'] === 0, 'item moved into escrow');
  tx(() => trade.leaveLobby(A, l2));
  ok(lootbox.inventory(A).items['item_tech_rare'] === 1, 'leaving refunds the escrowed item');

  // --- Dev helpers: grant + reset (the endpoint dev-gate is enforced in server.js) ---
  const dev = mkUser('devtest');
  ok(lootbox.grantItem(dev, 'item_finance_mythic', 3).ok && lootbox.inventory(dev).items['item_finance_mythic'] === 3, 'grantItem credits items');
  ok(lootbox.grantItem(dev, 'nope', 1).error, 'grantItem rejects an unknown item');
  economy.addMoney(dev, 12345);
  ok(economy.getMoney(dev) >= 12345, 'dev has money before reset');
  queries.resetPlayer(dev);
  ok(economy.getMoney(dev) === 0, 'resetPlayer wipes economy money');
  ok(Object.values(lootbox.inventory(dev).items).every((c) => c === 0), 'resetPlayer wipes items');
} catch (err) {
  fail++; console.error('  ✗ unexpected error:', err);
} finally {
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(DB + ext); } catch {} }
  console.log(`\n${fail === 0 ? '✅' : '❌'} lootbox test: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
