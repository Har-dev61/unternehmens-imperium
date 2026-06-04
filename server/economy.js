/**
 * Server-authoritative ECONOMY (Part 2a of the money migration).
 *
 * Key idea: instead of re-implementing the game's economy, the server RUNS the
 * exact same code (js/core/Game.js + data) as the authoritative instance per
 * player — one code base, no drift. The client only sends ACTIONS (click count,
 * buy, prestige …); the server applies them to its own Game and returns state.
 *
 * State is persisted as the serialized SaveState in `player_economy`; on each
 * call we load it, accrue passive income for the elapsed time (capped offline),
 * apply the action, and persist again — the lazy-settlement pattern, now for the
 * whole economy. Random events/golden deals are disabled server-side so income
 * is deterministic from state. Clicks are rate-limited × the server-known
 * click value, so a bot earns no more than a human.
 */
import { EventBus } from '../js/systems/EventBus.js';
import { EventManager } from '../js/systems/EventManager.js';
import { SaveSystem } from '../js/systems/SaveSystem.js';
import { Game } from '../js/core/Game.js';
import { queries } from './db.js';

// Defensive localStorage shim (some game classes touch it under the hood).
if (!globalThis.localStorage) {
  const m = new Map();
  globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

const OFFLINE_CAP_SEC = Number(process.env.ECON_OFFLINE_CAP ?? 8 * 3600);
const CLICK = { ratePerSec: 10, burst: 30 }; // server-side human-plausible cap

/** A fresh authoritative Game with random events/golden disabled (deterministic). */
function makeGame() {
  const bus = new EventBus();
  const em = new EventManager(bus);
  em.update = () => {}; // no random server-side events → income depends only on state
  const game = new Game({ bus, saveSystem: new SaveSystem('srv'), onlineManager: {}, eventManager: em });
  game.goldenDeal.update = () => {}; // no random golden deals server-side
  return game;
}

function load(userId) {
  const row = queries.getEconomy(userId);
  const game = makeGame();
  if (row) { try { game.applySave(JSON.parse(row.data)); } catch { /* corrupt → fresh */ } }
  return { game, lastTick: row?.last_tick ?? null };
}
function persist(userId, game, now) { queries.setEconomy(userId, JSON.stringify(game.serialize()), now); }

/** Accrue passive income for the elapsed wall-clock time (capped). */
function accrue(game, lastTick, now) {
  if (lastTick == null) return;
  let dt = (now - lastTick) / 1000;
  if (dt <= 0) return;
  if (dt > OFFLINE_CAP_SEC) dt = OFFLINE_CAP_SEC;
  game.tick(dt);
}

/** The numbers the client needs + the full save (for the client to mirror in 2b). */
function stateOf(game) {
  return {
    money: game.company.money.amount,
    perSecond: game.getPerSecond(),
    clickValue: game.getClickValue(),
    valuation: game.getValuation(),
    influence: game.player.prestigePoints,
    employees: game.getEmployeeCount(),
    buildings: game.getBuildingCount(),
    save: game.serialize(),
  };
}

/** Load → accrue → run `fn(game)` → persist → return state. The core helper. */
function withGame(userId, now, fn) {
  const { game, lastTick } = load(userId);
  accrue(game, lastTick, now);
  const extra = fn ? fn(game) : undefined;
  persist(userId, game, now);
  return { ...stateOf(game), ...(extra && typeof extra === 'object' ? extra : {}) };
}

export function snapshot(userId, now = Date.now()) { return withGame(userId, now, null); }

// --- Click rate limit (token bucket per player) ----------------------------
const clickBuckets = new Map();
function allowedClicks(userId, requested, now) {
  const b = clickBuckets.get(userId) ?? { tokens: CLICK.burst, last: now };
  b.tokens = Math.min(CLICK.burst, b.tokens + ((now - b.last) / 1000) * CLICK.ratePerSec);
  b.last = now;
  const n = Math.max(0, Math.min(Math.floor(requested) || 0, Math.floor(b.tokens)));
  b.tokens -= n; clickBuckets.set(userId, b);
  return n;
}

export function applyClicks(userId, count, now = Date.now()) {
  const n = allowedClicks(userId, count, now);
  return withGame(userId, now, (game) => { for (let i = 0; i < n; i++) game.click(); return { applied: n }; });
}

export function buyAsset(userId, assetId, quantity = 1, now = Date.now()) {
  return withGame(userId, now, (game) => ({ ok: game.buyAsset(assetId, quantity === 'max' ? 'max' : Number(quantity) || 1) }));
}
export function buyUpgrade(userId, id, now = Date.now()) {
  return withGame(userId, now, (game) => ({ ok: game.buyUpgrade(id) }));
}
export function buyResearch(userId, id, now = Date.now()) {
  return withGame(userId, now, (game) => ({ ok: game.buyResearch(id) }));
}
export function buyPrestigeUpgrade(userId, id, now = Date.now()) {
  return withGame(userId, now, (game) => ({ ok: game.buyPrestigeUpgrade(id) }));
}
export function prestige(userId, now = Date.now()) {
  return withGame(userId, now, (game) => ({ ok: game.prestige() }));
}
export function setActiveWorld(userId, id, now = Date.now()) {
  return withGame(userId, now, (game) => ({ ok: game.setActiveWorld(id) }));
}
export function claimDaily(userId, now = Date.now()) {
  return withGame(userId, now, (game) => ({ reward: game.claimDaily() }));
}
export function claimQuest(userId, id, now = Date.now()) {
  return withGame(userId, now, (game) => ({ ok: game.claimQuest(id) }));
}

// --- Money interface for the trade escrow (Part 2c) ------------------------
/** Cheap, un-accrued money read straight from the stored save (for UI display). */
export function peekMoney(userId) {
  const row = queries.getEconomy(userId);
  if (!row) return 0;
  try { return JSON.parse(row.data)?.company?.money?.amount ?? 0; } catch { return 0; }
}

/** Settled money balance. */
export function getMoney(userId, now = Date.now()) {
  const { game, lastTick } = load(userId);
  accrue(game, lastTick, now);
  persist(userId, game, now);
  return game.company.money.amount;
}
/** Deduct money if affordable (settles first). Returns true on success. */
export function spendMoney(userId, amount, now = Date.now()) {
  const { game, lastTick } = load(userId);
  accrue(game, lastTick, now);
  const ok = game.company.money.amount + 1e-6 >= amount;
  if (ok) game.company.money.amount -= amount;
  persist(userId, game, now);
  return ok;
}
/** Credit money (settles first). */
export function addMoney(userId, amount, now = Date.now()) {
  const { game, lastTick } = load(userId);
  accrue(game, lastTick, now);
  game.company.money.add(amount);
  persist(userId, game, now);
}
