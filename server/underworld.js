/**
 * Server-authoritative UNDERWORLD (shadow economy) — purely fictional game values.
 *
 * Two separate money pots:
 *  - LEGAL money lives in the canonical Game (economy.js).
 *  - DIRTY money lives here (player_underworld) and can only become legal via
 *    the laundering pipeline (with a fee) — never directly, and (by the trade
 *    single-realm rule) not through player trades either.
 *
 * Core loop: do a JOB → earn dirty cash and/or contraband loot + gain HEAT →
 * optionally sell contraband to the fence (more dirty cash + a little heat) →
 * launder dirty cash through your legal company (lazy, capped, fee). Every
 * heat-generating action rolls a crypto-secure CATCH check whose odds rise with
 * heat; getting caught burns a big % of the (unwashed) dirty money and resets
 * heat. Laundering is the safe valve (no heat, no catch) — wash to lock in gains.
 *
 * Everything balance-relevant is config below. Heat decay + laundering convert
 * lazily by timestamp (same pattern as energy/economy accrual).
 */
import { randomInt } from 'node:crypto';
import { queries } from './db.js';
import { RARITIES } from './resources.js';
import * as economy from './economy.js';

const RARITY_IDS = RARITIES.map((r) => r.id);
const RARITY_BY_ID = Object.fromEntries(RARITIES.map((r) => [r.id, r]));

// --- Config ----------------------------------------------------------------
const HEAT = {
  max: 100,
  decayPerSec: Number(process.env.UW_HEAT_DECAY ?? 0.04), // ~40 min from 100→0 idle
  safe: 30,            // heat ≤ safe → 0 % catch
  maxCatchProb: 0.6,   // catch chance at heat = max
};
const LAUNDER = {
  feePct: Number(process.env.UW_WASH_FEE ?? 0.25),
  capFloor: 10_000, capFrac: 0.05,   // capacity = max(floor, legalValuation × frac)
  rateFloor: 5, rateFrac: 0.5,       // €/s   = max(floor, legal€/s × frac)
};
const PENALTY = {
  dirtyLossPct: Number(process.env.UW_PENALTY ?? 0.5), // share of dirty money seized on catch
  heatResetTo: 0,                                       // heat after a bust
};
const SELL_HEAT = 3;

// Jobs: pay = dirty-cash range, heat = heat gain, dropChance = chance to also
// drop one contraband item. All fictional in-game values.
const JOBS = [
  { id: 'pickpocket', name: 'Taschendiebstahl', icon: '🤏', pay: [50, 150],      heat: 5 },
  { id: 'protection', name: 'Schutzgeld',        icon: '💼', pay: [300, 800],     heat: 10 },
  { id: 'smuggle',    name: 'Schmuggel',         icon: '📦', pay: [150, 400],     heat: 14, dropChance: 1.0 },
  { id: 'heist',      name: 'Raubzug',           icon: '💣', pay: [4000, 10000],  heat: 25, dropChance: 0.35 },
];
const JOB_BY_ID = Object.fromEntries(JOBS.map((j) => [j.id, j]));

// Contraband: one fictional item per rarity, with a fence value (dirty money).
const CONTRABAND_DEFS = [
  ['Konterbande-Päckchen',    '📦', 60],
  ['Gepanschter Schnaps',     '🍾', 180],
  ['Schwarzmarkt-Ware',       '🧰', 600],
  ['Gestohlene Kollektion',   '⌚', 2_200],
  ['Diamantenschmuggel',      '💎', 9_000],
  ['Kunstraub-Meisterwerk',   '🖼️', 35_000],
];
export const CONTRABAND = CONTRABAND_DEFS.map(([name, icon, value], i) => {
  const rarity = RARITY_IDS[i];
  return { id: `uw_${rarity}`, rarity, name, icon, value, color: RARITY_BY_ID[rarity].color };
});
const ITEM_BY_ID = Object.fromEntries(CONTRABAND.map((c) => [c.id, c]));
const ITEM_BY_RARITY = Object.fromEntries(CONTRABAND.map((c) => [c.rarity, c]));
export const ITEM_IDS = new Set(CONTRABAND.map((c) => c.id));
const DROP_WEIGHTS = { common: 55, uncommon: 27, rare: 12, epic: 4, legendary: 1.6, mythic: 0.4 };

const uwMap = (userId) => Object.fromEntries(queries.getUwItems(userId).map((r) => [r.item_id, r.count]));

// --- CSPRNG helpers --------------------------------------------------------
const SCALE = 1_000_000;
/** True with probability p (crypto-secure). */
function chance(p) { return randomInt(0, SCALE) < Math.round(Math.max(0, Math.min(1, p)) * SCALE); }
function rollContraband() {
  const entries = RARITY_IDS.filter((id) => (DROP_WEIGHTS[id] ?? 0) > 0).map((id) => [id, Math.round(DROP_WEIGHTS[id] * 1000)]);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = randomInt(0, total);
  for (const [id, w] of entries) { if (r < w) return ITEM_BY_RARITY[id]; r -= w; }
  return ITEM_BY_RARITY[entries[0][0]];
}

// --- Heat / catch ----------------------------------------------------------
function catchProb(heat) {
  if (heat <= HEAT.safe) return 0;
  return Math.min(HEAT.maxCatchProb, HEAT.maxCatchProb * (heat - HEAT.safe) / (HEAT.max - HEAT.safe));
}

// --- State (lazy: heat decay + laundering pipeline) ------------------------
function defaults(now) { return { dirty_money: 0, heat: 0, heat_updated: now, wash_queue: 0, wash_updated: now }; }
function load(userId, now) { const r = queries.getUnderworld(userId); return r ? { ...r } : defaults(now); }
function washParams(userId) {
  const s = economy.peekStats(userId);
  return {
    cap: Math.max(LAUNDER.capFloor, s.valuation * LAUNDER.capFrac),
    rate: Math.max(LAUNDER.rateFloor, s.perSecond * LAUNDER.rateFrac),
  };
}
/** Apply heat decay + convert washed money to legal (minus fee). Mutates `st`. */
function settle(userId, st, now) {
  const he = Math.max(0, (now - st.heat_updated) / 1000);
  st.heat = Math.max(0, st.heat - HEAT.decayPerSec * he);
  st.heat_updated = now;

  const we = Math.max(0, (now - st.wash_updated) / 1000);
  if (st.wash_queue > 1e-9 && we > 0) {
    const { rate } = washParams(userId);
    const conv = Math.min(st.wash_queue, rate * we);
    if (conv > 0) {
      st.wash_queue -= conv;
      const legal = conv * (1 - LAUNDER.feePct);
      if (legal > 0) economy.addMoney(userId, legal, now);
    }
  }
  st.wash_updated = now;
  return st;
}
function loadSettled(userId, now) { return settle(userId, load(userId, now), now); }
function persist(userId, st) { queries.setUnderworld(userId, st); }

/** Public snapshot (settles first). */
export function snapshot(userId, now = Date.now()) {
  const st = loadSettled(userId, now);
  persist(userId, st);
  return view(userId, st);
}
function view(userId, st) {
  const have = uwMap(userId);
  const items = {};
  for (const c of CONTRABAND) items[c.id] = have[c.id] ?? 0;
  const { cap, rate } = washParams(userId);
  return {
    dirtyMoney: st.dirty_money,
    legalMoney: economy.peekMoney(userId),
    heat: st.heat, maxHeat: HEAT.max, safeHeat: HEAT.safe, catchChance: catchProb(st.heat),
    wash: { queue: st.wash_queue, capacity: cap, rate, feePct: LAUNDER.feePct },
    items,
  };
}

// --- Actions ---------------------------------------------------------------
/** Apply a heat gain + roll the crypto-secure catch. Mutates `st`; returns the bust or null. */
function heatAndCatch(st, gain) {
  st.heat = Math.min(HEAT.max, st.heat + gain);
  if (chance(catchProb(st.heat))) {
    const lost = st.dirty_money * PENALTY.dirtyLossPct;
    st.dirty_money -= lost;
    st.heat = PENALTY.heatResetTo;
    return { caught: true, lost };
  }
  return null;
}

/** Pull one job: dirty cash + maybe a contraband drop, then heat + catch roll. */
export function doJob(userId, jobId, now = Date.now()) {
  const job = JOB_BY_ID[jobId];
  if (!job) return { error: 'Unbekannter Job.' };
  const st = loadSettled(userId, now);

  const cash = job.pay ? randomInt(job.pay[0], job.pay[1] + 1) : 0;
  st.dirty_money += cash;
  let drop = null;
  if (job.dropChance && chance(job.dropChance)) {
    const it = rollContraband();
    const have = uwMap(userId);
    queries.setUwItem(userId, it.id, (have[it.id] ?? 0) + 1);
    drop = { id: it.id, name: it.name, icon: it.icon, rarity: it.rarity, color: it.color, qty: 1 };
  }
  const bust = heatAndCatch(st, job.heat);
  persist(userId, st);
  return { ok: true, job: jobId, cash, drop, ...(bust ?? { caught: false }), ...view(userId, st) };
}

/** Fence: sell contraband for dirty money (+ a little heat + catch roll). */
export function sellContraband(userId, itemId, qty = 1, now = Date.now()) {
  const it = ITEM_BY_ID[itemId];
  if (!it) return { error: 'Unbekannte Ware.' };
  const have = uwMap(userId);
  const n = Math.min(Math.max(1, Math.floor(qty) || 1), have[itemId] ?? 0);
  if (n <= 0) return { error: 'Nichts zu verkaufen.' };
  const st = loadSettled(userId, now);
  queries.setUwItem(userId, itemId, (have[itemId] ?? 0) - n);
  const gain = it.value * n;
  st.dirty_money += gain;
  const bust = heatAndCatch(st, SELL_HEAT);
  persist(userId, st);
  return { ok: true, sold: { id: itemId, qty: n, gain }, ...(bust ?? { caught: false }), ...view(userId, st) };
}

/** Queue dirty money into the laundromat (safe: no heat, no catch). Capped. */
export function launder(userId, amount, now = Date.now()) {
  const st = loadSettled(userId, now);
  const amt = Math.floor(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) { persist(userId, st); return { error: 'Ungültiger Betrag.' }; }
  const { cap } = washParams(userId);
  const move = Math.min(amt, st.dirty_money, Math.max(0, cap - st.wash_queue));
  if (move <= 0) { persist(userId, st); return { error: 'Wäscherei voll oder kein schmutziges Geld.' }; }
  st.dirty_money -= move;
  st.wash_queue += move;
  persist(userId, st);
  return { ok: true, queued: move, ...view(userId, st) };
}

// --- Dirty-money interface for the trade escrow (single-realm) -------------
/** Cheap, un-settled dirty-money read for display. */
export function peekDirty(userId) { return queries.getUnderworld(userId)?.dirty_money ?? 0; }
/** Deduct dirty money if affordable (settles first). Returns true on success. */
export function spendDirty(userId, amount, now = Date.now()) {
  const st = loadSettled(userId, now);
  const ok = st.dirty_money + 1e-6 >= amount;
  if (ok) st.dirty_money -= amount;
  persist(userId, st);
  return ok;
}
/** Credit dirty money (settles first). */
export function addDirty(userId, amount, now = Date.now()) {
  const st = loadSettled(userId, now);
  st.dirty_money += amount;
  persist(userId, st);
}

// --- Anti-burst token bucket (per player) ----------------------------------
const LIMIT = { ratePerSec: 5, burst: 10 };
const buckets = new Map();
export function actionAllowed(userId, now = Date.now()) {
  const b = buckets.get(userId) ?? { tokens: LIMIT.burst, last: now };
  b.tokens = Math.min(LIMIT.burst, b.tokens + ((now - b.last) / 1000) * LIMIT.ratePerSec);
  b.last = now;
  if (b.tokens < 1) { buckets.set(userId, b); return false; }
  b.tokens -= 1; buckets.set(userId, b);
  return true;
}

/** Static registry for the client UI. */
export function config() {
  return {
    rarities: RARITIES,
    jobs: JOBS.map((j) => ({ id: j.id, name: j.name, icon: j.icon, pay: j.pay, heat: j.heat, dropChance: j.dropChance ?? 0 })),
    contraband: CONTRABAND,
    heat: { max: HEAT.max, safe: HEAT.safe, maxCatchProb: HEAT.maxCatchProb, decayPerSec: HEAT.decayPerSec },
    launder: { feePct: LAUNDER.feePct, capFloor: LAUNDER.capFloor, capFrac: LAUNDER.capFrac, rateFloor: LAUNDER.rateFloor, rateFrac: LAUNDER.rateFrac },
    penalty: { dirtyLossPct: PENALTY.dirtyLossPct },
    sellHeat: SELL_HEAT,
  };
}
