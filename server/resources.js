/**
 * Server-authoritative, rarity-based RESOURCE DROPS (overhaul of Phase 2).
 *
 * Model (per the agreed decisions):
 *  - No more passive accumulation. The player actively "collects" in a world;
 *    each collect is ONE server-side roll that costs 1 ENERGY.
 *  - Energy is a per-world pool that regenerates slowly (lazy, timestamp-based).
 *    A hard token-bucket rate-limit additionally blocks scripted bursts.
 *  - Every roll uses a cryptographically secure RNG (node:crypto.randomInt):
 *    first a RARITY by weight, then the world's resource of that rarity, then a
 *    tier-dependent quantity. The client only learns the result — it cannot
 *    predict, repeat or influence the roll.
 *  - Resources are global per player (one bag); each type belongs to one world.
 *  - Buildings are repurposed as BOOSTERS (bought with resources) that raise a
 *    world's energy cap / regen.
 *
 * Everything balance-relevant lives in the config blocks below; a new world is
 * just another WORLD_RES entry + booster.
 */
import { randomInt } from 'node:crypto';
import { queries } from './db.js';

// --- Energy + anti-spam (config) -------------------------------------------
export const ENERGY = {
  max: Number(process.env.ROLL_ENERGY_MAX ?? 50),            // base cap per world
  regenPerSec: 1 / Number(process.env.ROLL_ENERGY_REGEN_SECONDS ?? 36), // +1 every 36 s
  offlineCapSeconds: Number(process.env.ROLL_ENERGY_OFFLINE_CAP ?? 8 * 3600),
  rollCost: 1,
};
export const ROLL_LIMIT = { ratePerSec: 5, burst: 10 }; // hard token-bucket per player

// --- Rarity tiers (weights are relative; normalized for display) ------------
export const RARITIES = [
  { id: 'common',    name: 'Häufig',       color: '#9ca3af', weight: 60, qty: [1, 3] },
  { id: 'uncommon',  name: 'Ungewöhnlich', color: '#4ade80', weight: 25, qty: [1, 2] },
  { id: 'rare',      name: 'Selten',       color: '#3b82f6', weight: 10, qty: [1, 1] },
  { id: 'epic',      name: 'Episch',       color: '#a855f7', weight: 5,  qty: [1, 1] },
  { id: 'legendary', name: 'Legendär',     color: '#f59e0b', weight: 2,  qty: [1, 1] },
  { id: 'mythic',    name: 'Mythisch',     color: '#ef4444', weight: 1,  qty: [1, 1] },
];
const RARITY_IDS = RARITIES.map((r) => r.id);
const RARITY_BY_ID = Object.fromEntries(RARITIES.map((r) => [r.id, r]));
const WEIGHT_TOTAL = RARITIES.reduce((s, r) => s + r.weight, 0);

// --- Per-world resources: six entries [name, icon], one per rarity tier ------
const WORLD_DEFS = {
  local:     { name: 'Lokaler Markt',        res: [['Holz', '🪵'], ['Harz', '🟩'], ['Bernstein', '🟡'], ['Edelholz', '🟪'], ['Weltbaum-Span', '🌟'], ['Urholz', '🔥']] },
  national:  { name: 'Nationale Wirtschaft', res: [['Eisen', '⛓️'], ['Kohle', '⚫'], ['Stahl', '🔩'], ['Titanstahl', '🛠️'], ['Meteoreisen', '☄️'], ['Urerz', '🌋']] },
  global:    { name: 'Globaler Markt',        res: [['Öl', '🛢️'], ['Baumwolle', '🧵'], ['Gewürze', '🌶️'], ['Seide', '🧣'], ['Perlen', '⚪'], ['Drachenöl', '🐉']] },
  tech:      { name: 'Tech-Welt',             res: [['Silizium', '🔌'], ['Kupfer', '🟧'], ['Platine', '💾'], ['Glasfaser', '🪢'], ['Quantenchip', '🔬'], ['Singularitäts-Kern', '🌀']] },
  finance:   { name: 'Finanzwelt',            res: [['Münzen', '🪙'], ['Silber', '🥈'], ['Gold', '🥇'], ['Diamant', '💎'], ['Platin', '⬜'], ['Urkristall', '🔮']] },
  space:     { name: 'Weltraumkolonien',      res: [['Eis', '🧊'], ['Titan', '🛰️'], ['Helium-3', '⚛️'], ['Iridium', '✨'], ['Antimaterie', '🌌'], ['Sternenstaub', '⭐']] },
  metaverse: { name: 'Metaverse',             res: [['Pixel', '🟦'], ['Token', '🎫'], ['Daten', '📀'], ['NFT', '🖼️'], ['Krypto-Schlüssel', '🔑'], ['Genesis-Block', '🧱']] },
  biotech:   { name: 'Biotech-Welt',          res: [['Zellen', '🦠'], ['Biomasse', '🌿'], ['Enzyme', '🧪'], ['DNA', '🧬'], ['Stammzellen', '💉'], ['Unsterblichkeits-Serum', '⏳']] },
  ai:        { name: 'KI-Singularität',       res: [['Datensatz', '📊'], ['Rechenzeit', '🖥️'], ['Modell', '🧠'], ['Neuralnetz', '🕸️'], ['AGI-Kern', '🤖'], ['Singularität', '🌟']] },
};

/** WORLDS: [{ world, name, resources:[{type,name,icon,rarity}] }] (derived). */
export const WORLDS = Object.entries(WORLD_DEFS).map(([world, def]) => ({
  world, name: def.name,
  resources: def.res.map(([name, icon], i) => ({ type: `${world}_${RARITY_IDS[i]}`, name, icon, rarity: RARITY_IDS[i] })),
}));

/** One booster per world: bought with that world's common+uncommon drops; lifts energy. */
export const BOOSTERS = Object.keys(WORLD_DEFS).map((world) => ({
  id: `boost_${world}`, world, name: 'Sammelposten',
  cost: { [`${world}_common`]: 25, [`${world}_uncommon`]: 15 }, growth: 1.6,
  effect: { energyMax: 10, regenPerSec: 0.01 }, // per owned level
}));

// --- Derived lookups -------------------------------------------------------
const RES_BY_WORLD = Object.fromEntries(WORLDS.map((w) => [w.world, Object.fromEntries(w.resources.map((r) => [r.rarity, r]))]));
export const RESOURCE_TYPES = WORLDS.flatMap((w) => w.resources.map((r) => r.type));
const RES_NAME = Object.fromEntries(WORLDS.flatMap((w) => w.resources.map((r) => [r.type, r.name])));
const WORLD_IDS = new Set(Object.keys(WORLD_DEFS));
const BOOSTER_BY_ID = Object.fromEntries(BOOSTERS.map((b) => [b.id, b]));

const amountMap = (rows) => Object.fromEntries(rows.map((r) => [r.type, r.amount]));

// --- Energy (per world, lazy regen) ----------------------------------------
function boostLevels(userId, world) {
  const id = `boost_${world}`;
  return queries.getBuildings(userId).find((b) => b.building_id === id)?.count ?? 0;
}
function energyParams(userId, world) {
  const lv = boostLevels(userId, world);
  return { max: ENERGY.max + lv * BOOSTERS[0].effect.energyMax, regenPerSec: ENERGY.regenPerSec + lv * BOOSTERS[0].effect.regenPerSec };
}

/** Current energy for a world after lazy regeneration (writes the new value). */
function settleEnergy(userId, world, now = Date.now()) {
  const { max, regenPerSec } = energyParams(userId, world);
  const row = queries.getEnergy(userId, world);
  if (!row) { queries.setEnergy(userId, world, max, now); return { energy: max, max, regenPerSec }; } // start full
  const elapsed = Math.min((now - row.last_tick) / 1000, ENERGY.offlineCapSeconds);
  const energy = Math.min(max, row.energy + Math.max(0, elapsed) * regenPerSec);
  queries.setEnergy(userId, world, energy, now);
  return { energy, max, regenPerSec };
}

// --- Anti-burst token bucket (per player, in-memory) -----------------------
const buckets = new Map();
export function rollAllowed(userId, now = Date.now()) {
  const b = buckets.get(userId) ?? { tokens: ROLL_LIMIT.burst, last: now };
  b.tokens = Math.min(ROLL_LIMIT.burst, b.tokens + ((now - b.last) / 1000) * ROLL_LIMIT.ratePerSec);
  b.last = now;
  if (b.tokens < 1) { buckets.set(userId, b); return false; }
  b.tokens -= 1; buckets.set(userId, b);
  return true;
}

// --- Rolling (CSPRNG) ------------------------------------------------------
function rollRarity() {
  let r = randomInt(0, WEIGHT_TOTAL); // crypto-secure, uniform in [0, total)
  for (const tier of RARITIES) { if (r < tier.weight) return tier; r -= tier.weight; }
  return RARITIES[0];
}

/** Spend 1 energy and roll once in `world`. Returns the drop or an {error}. */
export function roll(userId, world, now = Date.now()) {
  if (!WORLD_IDS.has(world)) return { error: 'Unbekannte Welt.' };
  const e = settleEnergy(userId, world, now);
  if (e.energy < ENERGY.rollCost) return { error: 'Nicht genug Energie.', energy: e.energy, max: e.max };
  queries.setEnergy(userId, world, e.energy - ENERGY.rollCost, now);

  const tier = rollRarity();
  const res = RES_BY_WORLD[world][tier.id];
  const qty = randomInt(tier.qty[0], tier.qty[1] + 1);
  const have = amountMap(queries.getResources(userId));
  queries.setResource(userId, res.type, (have[res.type] ?? 0) + qty);

  return {
    ok: true,
    drop: { type: res.type, name: res.name, icon: res.icon, rarity: tier.id, color: tier.color, qty },
    energy: e.energy - ENERGY.rollCost, max: e.max,
  };
}

/** Buy a booster with resources (geometric cost). Returns {ok} or {error}. */
export function buyBooster(userId, buildingId, now = Date.now()) {
  const def = BOOSTER_BY_ID[buildingId];
  if (!def) return { error: 'Unbekannter Booster.' };
  const owned = boostLevels(userId, def.world);
  const factor = Math.pow(def.growth, owned);
  const cost = Object.fromEntries(Object.entries(def.cost).map(([t, base]) => [t, base * factor]));
  const have = amountMap(queries.getResources(userId));
  for (const [t, amt] of Object.entries(cost)) if ((have[t] ?? 0) + 1e-9 < amt) return { error: `Nicht genug ${RES_NAME[t] ?? t}.` };
  for (const [t, amt] of Object.entries(cost)) queries.setResource(userId, t, (have[t] ?? 0) - amt);
  queries.setBuilding(userId, buildingId, owned + 1);
  settleEnergy(userId, def.world, now); // re-baseline energy with the new cap/regen
  return { ok: true };
}

/** Player snapshot: inventory + per-world energy + owned boosters. */
export function snapshot(userId, now = Date.now()) {
  const have = amountMap(queries.getResources(userId));
  const resources = {};
  for (const t of RESOURCE_TYPES) resources[t] = have[t] ?? 0;
  const buildings = {};
  for (const b of queries.getBuildings(userId)) buildings[b.building_id] = b.count;
  const energy = {};
  for (const w of Object.keys(WORLD_DEFS)) energy[w] = settleEnergy(userId, w, now);
  return { resources, energy, buildings };
}

/** Next-level booster cost for the UI. */
export function boosterCost(userId, buildingId) {
  const def = BOOSTER_BY_ID[buildingId];
  if (!def) return null;
  const factor = Math.pow(def.growth, boostLevels(userId, def.world));
  return Object.fromEntries(Object.entries(def.cost).map(([t, base]) => [t, base * factor]));
}

/** Static registry for the client UI (rarities, colors, worlds, boosters, config). */
export function config() {
  return { rarities: RARITIES, weightTotal: WEIGHT_TOTAL, worlds: WORLDS, boosters: BOOSTERS, energy: ENERGY };
}
