/**
 * Server-authoritative resource economy (Phase 2).
 *
 * Design (per the agreed decisions):
 *  - Lazy settlement: we store owned buildings, a per-player lastTick and the
 *    current stock per resource type. On every relevant event we accrue
 *    `stock += rate × min(elapsed, CAP)` and reset the tick. Rates are derived
 *    ONLY from server-owned buildings — never trusted from the client.
 *  - Resources are global per player (one shared bag), but every resource TYPE
 *    is produced by exactly one world. Worlds dock in purely via their rates.
 *  - Buildings are bought with RESOURCES (cross-resource costs) — a closed,
 *    trustworthy economy independent of the client-authoritative money.
 *  - Each world has a small base rate (> 0), so resources trickle in from the
 *    start and the first buildings are always reachable without clicks.
 *  - Offline progress is capped (default 8 h); the cap is config-driven.
 *
 * Adding a world = add entries to WORLDS + BUILDINGS. No settlement changes.
 */
import { queries } from './db.js';

/** Offline accrual cap in seconds (config-driven; later unlockable as an upgrade). */
export const CAP_SECONDS = Number(process.env.RESOURCE_OFFLINE_CAP_SECONDS ?? 8 * 3600);

/** World → resource types it produces, with a small always-on base rate (/s). */
export const WORLDS = [
  { world: 'local',     name: 'Lokaler Markt',        resources: [
    { type: 'wood',     name: 'Holz',          icon: '🪵', baseRate: 0.50 },
    { type: 'stone',    name: 'Stein',         icon: '🪨', baseRate: 0.30 }] },
  { world: 'national',  name: 'Nationale Wirtschaft', resources: [
    { type: 'iron',     name: 'Eisen',         icon: '⛓️', baseRate: 0.08 },
    { type: 'coal',     name: 'Kohle',         icon: '⚫', baseRate: 0.08 }] },
  { world: 'global',    name: 'Globaler Markt',       resources: [
    { type: 'oil',      name: 'Öl',            icon: '🛢️', baseRate: 0.04 },
    { type: 'goods',    name: 'Waren',         icon: '📦', baseRate: 0.04 }] },
  { world: 'tech',      name: 'Tech-Welt',            resources: [
    { type: 'silicon',  name: 'Silizium',      icon: '🔌', baseRate: 0.02 },
    { type: 'data',     name: 'Daten',         icon: '💾', baseRate: 0.03 }] },
  { world: 'finance',   name: 'Finanzwelt',           resources: [
    { type: 'gold',     name: 'Gold',          icon: '🥇', baseRate: 0.010 },
    { type: 'credit',   name: 'Kredit',        icon: '💳', baseRate: 0.020 }] },
  { world: 'space',     name: 'Weltraumkolonien',     resources: [
    { type: 'titanium', name: 'Titan',         icon: '🛰️', baseRate: 0.008 },
    { type: 'helium3',  name: 'Helium-3',      icon: '⚛️', baseRate: 0.005 }] },
  { world: 'metaverse', name: 'Metaverse',            resources: [
    { type: 'pixels',   name: 'Pixel',         icon: '🟦', baseRate: 0.020 },
    { type: 'tokens',   name: 'Token',         icon: '🪙', baseRate: 0.010 }] },
  { world: 'biotech',   name: 'Biotech-Welt',         resources: [
    { type: 'biomass',  name: 'Biomasse',      icon: '🌿', baseRate: 0.010 },
    { type: 'genes',    name: 'Gen-Daten',     icon: '🧬', baseRate: 0.006 }] },
  { world: 'ai',        name: 'KI-Singularität',      resources: [
    { type: 'compute',  name: 'Rechenleistung', icon: '🖥️', baseRate: 0.004 },
    { type: 'models',   name: 'Modelle',        icon: '🧠', baseRate: 0.002 }] },
];

/** Buildings: produce one resource at `rate`/unit; cost RESOURCES (geometric). */
export const BUILDINGS = [
  { id: 'sawmill',     world: 'local',     name: 'Sägewerk',       produces: 'wood',     rate: 1.00, growth: 1.15, cost: { wood: 20 } },
  { id: 'quarry',      world: 'local',     name: 'Steinbruch',     produces: 'stone',    rate: 0.70, growth: 1.15, cost: { stone: 25 } },
  { id: 'foundry',     world: 'national',  name: 'Eisenhütte',     produces: 'iron',     rate: 0.50, growth: 1.16, cost: { wood: 60, stone: 45 } },
  { id: 'coal_mine',   world: 'national',  name: 'Kohlemine',      produces: 'coal',     rate: 0.50, growth: 1.16, cost: { wood: 50, stone: 55 } },
  { id: 'refinery',    world: 'global',    name: 'Raffinerie',     produces: 'oil',      rate: 0.40, growth: 1.17, cost: { iron: 40, coal: 40 } },
  { id: 'factory',     world: 'global',    name: 'Fabrik',         produces: 'goods',    rate: 0.45, growth: 1.17, cost: { iron: 35, coal: 45 } },
  { id: 'fab',         world: 'tech',      name: 'Chip-Fab',       produces: 'silicon',  rate: 0.35, growth: 1.18, cost: { oil: 30, goods: 35 } },
  { id: 'datacenter',  world: 'tech',      name: 'Rechenzentrum',  produces: 'data',     rate: 0.50, growth: 1.18, cost: { oil: 40, goods: 30 } },
  { id: 'vault',       world: 'finance',   name: 'Tresor',         produces: 'gold',     rate: 0.20, growth: 1.19, cost: { silicon: 30, data: 40 } },
  { id: 'bank',        world: 'finance',   name: 'Bank',           produces: 'credit',   rate: 0.40, growth: 1.19, cost: { silicon: 40, data: 35 } },
  { id: 'ti_refinery', world: 'space',     name: 'Titan-Raffinerie', produces: 'titanium', rate: 0.18, growth: 1.20, cost: { gold: 25, credit: 40 } },
  { id: 'collector',   world: 'space',     name: 'He-3-Kollektor', produces: 'helium3',  rate: 0.12, growth: 1.20, cost: { gold: 30, credit: 45 } },
  { id: 'renderfarm',  world: 'metaverse', name: 'Render-Farm',    produces: 'pixels',   rate: 0.40, growth: 1.20, cost: { titanium: 20, helium3: 25 } },
  { id: 'mint',        world: 'metaverse', name: 'Mint-Werk',      produces: 'tokens',   rate: 0.25, growth: 1.20, cost: { titanium: 25, helium3: 20 } },
  { id: 'biolab',      world: 'biotech',   name: 'Biolabor',       produces: 'biomass',  rate: 0.30, growth: 1.20, cost: { pixels: 30, tokens: 35 } },
  { id: 'sequencer',   world: 'biotech',   name: 'Sequenzierer',   produces: 'genes',    rate: 0.20, growth: 1.20, cost: { pixels: 35, tokens: 30 } },
  { id: 'cluster',     world: 'ai',        name: 'GPU-Cluster',    produces: 'compute',  rate: 0.25, growth: 1.21, cost: { biomass: 30, genes: 40 } },
  { id: 'trainer',     world: 'ai',        name: 'Trainings-Werk', produces: 'models',   rate: 0.15, growth: 1.21, cost: { biomass: 40, genes: 35 } },
];

// --- Derived lookups -------------------------------------------------------
const RESOURCE_DEFS = WORLDS.flatMap((w) => w.resources.map((r) => ({ ...r, world: w.world })));
export const RESOURCE_TYPES = RESOURCE_DEFS.map((r) => r.type);
const BASE_RATES = Object.fromEntries(RESOURCE_DEFS.map((r) => [r.type, r.baseRate]));
const RESOURCE_NAMES = Object.fromEntries(RESOURCE_DEFS.map((r) => [r.type, r.name]));
const BUILDING_MAP = Object.fromEntries(BUILDINGS.map((b) => [b.id, b]));

const amountMap = (rows) => Object.fromEntries(rows.map((r) => [r.type, r.amount]));

/** Current production rate per resource type for a player (base + buildings). */
function ratesFor(userId) {
  const rates = { ...BASE_RATES };
  for (const b of queries.getBuildings(userId)) {
    const def = BUILDING_MAP[b.building_id];
    if (def) rates[def.produces] = (rates[def.produces] ?? 0) + def.rate * b.count;
  }
  return rates;
}

/** Total cost to buy `qty` units of `def`, starting from `fromCount` (geometric). */
function totalCost(def, fromCount, qty) {
  const g = def.growth ?? 1.15;
  const factor = g === 1 ? qty : Math.pow(g, fromCount) * (Math.pow(g, qty) - 1) / (g - 1);
  const cost = {};
  for (const [type, base] of Object.entries(def.cost)) cost[type] = base * factor;
  return cost;
}

function buildingCount(userId, buildingId) {
  return queries.getBuildings(userId).find((b) => b.building_id === buildingId)?.count ?? 0;
}

/**
 * Accrue production up to `now` (capped). MUST run inside a transaction at the
 * call site (see db.tx). First contact just starts the clock (no retro-pay).
 */
export function settle(userId, now = Date.now()) {
  const lastTick = queries.getResourceTick(userId);
  if (lastTick == null) { queries.setResourceTick(userId, now); return; }
  let elapsedMs = now - lastTick;
  if (elapsedMs <= 0) return;
  elapsedMs = Math.min(elapsedMs, CAP_SECONDS * 1000); // offline cap (excess discarded)
  const seconds = elapsedMs / 1000;
  const rates = ratesFor(userId);
  const have = amountMap(queries.getResources(userId));
  for (const type of RESOURCE_TYPES) {
    const add = (rates[type] ?? 0) * seconds;
    if (add > 0) queries.setResource(userId, type, (have[type] ?? 0) + add);
  }
  queries.setResourceTick(userId, now);
}

/** Buy `qty` of a building, paying with resources. Returns {ok} or {error}. */
export function purchase(userId, buildingId, qty = 1, now = Date.now()) {
  const def = BUILDING_MAP[buildingId];
  if (!def) return { error: 'Unbekanntes Gebäude.' };
  qty = Math.max(1, Math.min(1000, Math.floor(Number(qty) || 1)));
  settle(userId, now); // accrue before spending so the player can't be short-changed
  const owned = buildingCount(userId, buildingId);
  const cost = totalCost(def, owned, qty);
  const have = amountMap(queries.getResources(userId));
  for (const [type, amt] of Object.entries(cost)) {
    if ((have[type] ?? 0) + 1e-9 < amt) return { error: `Nicht genug ${RESOURCE_NAMES[type] ?? type}.` };
  }
  for (const [type, amt] of Object.entries(cost)) {
    queries.setResource(userId, type, (have[type] ?? 0) - amt);
  }
  queries.setBuilding(userId, buildingId, owned + qty);
  return { ok: true };
}

/** Settle, then return the player's full resource snapshot (for the API). */
export function snapshot(userId, now = Date.now()) {
  settle(userId, now);
  const have = amountMap(queries.getResources(userId));
  const rates = ratesFor(userId);
  const buildings = {};
  for (const b of queries.getBuildings(userId)) buildings[b.building_id] = b.count;
  const resources = {};
  for (const t of RESOURCE_TYPES) resources[t] = have[t] ?? 0;
  return { resources, rates, buildings, capSeconds: CAP_SECONDS };
}

/** Next-unit (and ×qty) cost for a building given the player's current count. */
export function quote(userId, buildingId, qty = 1) {
  const def = BUILDING_MAP[buildingId];
  if (!def) return null;
  qty = Math.max(1, Math.min(1000, Math.floor(Number(qty) || 1)));
  return { buildingId, qty, cost: totalCost(def, buildingCount(userId, buildingId), qty) };
}

/** Static registry for the client UI (no per-player data). */
export function config() {
  return { worlds: WORLDS, buildings: BUILDINGS, capSeconds: CAP_SECONDS };
}
