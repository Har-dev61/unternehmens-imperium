/**
 * Server-authoritative LOOTBOX system (cosmetic prestige items).
 *
 * Design (per the agreed decisions):
 *  - Boxes are bought with the in-game company balance only (no real money).
 *    The price is server-defined; the purchase spends money atomically via the
 *    authoritative economy BEFORE any item is granted — the client never sets
 *    the price or the balance.
 *  - Several config-driven box types, each with its OWN rarity weight table.
 *    Higher tiers cost more and have far better odds for rare+ items.
 *  - Items are purely COSMETIC collectibles (status/showcase), grouped by the
 *    same rarity tiers + colours as the resource system (reused, not copied),
 *    and themed per existing game world. One item per (world, rarity) → 54.
 *  - Opening is decided ONLY here with a crypto-secure RNG (node:crypto). The
 *    client receives the finished result and can never roll, re-roll or fake it.
 *  - Items live in `player_items` (server = single source of truth) and are
 *    tradable through the existing lobby escrow (see trade.js).
 *
 * Everything balance-relevant (box types, prices, weight tables, item lists,
 * colours) lives in the config blocks below — a new world/box is just config.
 */
import { randomInt } from 'node:crypto';
import { queries } from './db.js';
import { RARITIES, WORLDS } from './resources.js';
import * as economy from './economy.js';

const RARITY_IDS = RARITIES.map((r) => r.id);
const RARITY_BY_ID = Object.fromEntries(RARITIES.map((r) => [r.id, r]));
const WORLD_NAME = Object.fromEntries(WORLDS.map((w) => [w.world, w.name]));
const WORLD_IDS = WORLDS.map((w) => w.world);
const WORLD_ID_SET = new Set(WORLD_IDS);

// --- Box catalogue (config) ------------------------------------------------
// price: fixed company-balance cost. weights: relative chance per rarity (any
// scale; floats allowed). scope 'all' = any world's item; 'world' = a chosen
// world only. active:false (or a past availableUntil) hides a box server-side.
export const BOXES = [
  {
    id: 'standard', name: 'Standard-Box', icon: '📦', scope: 'all',
    price: Number(process.env.LOOTBOX_PRICE_STANDARD ?? 25_000),
    desc: 'Günstiger Einstieg — überwiegend häufige Funde.',
    weights: { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 0.9, mythic: 0.1 },
  },
  {
    id: 'world', name: 'Welten-Box', icon: '🌍', scope: 'world',
    price: Number(process.env.LOOTBOX_PRICE_WORLD ?? 250_000),
    desc: 'Nur Items einer wählbaren Welt — gezieltes Sammeln.',
    weights: { common: 40, uncommon: 30, rare: 18, epic: 8, legendary: 3, mythic: 1 },
  },
  {
    id: 'premium', name: 'Premium-Box', icon: '💎', scope: 'all',
    price: Number(process.env.LOOTBOX_PRICE_PREMIUM ?? 2_500_000),
    desc: 'Deutlich bessere Chancen auf Episch, Legendär & Mythisch.',
    weights: { common: 20, uncommon: 30, rare: 28, epic: 15, legendary: 5, mythic: 2 },
  },
  {
    id: 'event', name: 'Event-Box', icon: '🎉', scope: 'all',
    price: Number(process.env.LOOTBOX_PRICE_EVENT ?? 10_000_000),
    desc: 'Limitiert: keine häufigen Items, Top-Verteilung.',
    weights: { uncommon: 20, rare: 35, epic: 28, legendary: 12, mythic: 5 },
    active: (process.env.LOOTBOX_EVENT_ACTIVE ?? '1') !== '0',
    // Optional time gate: set LOOTBOX_EVENT_UNTIL to an epoch-ms timestamp.
    availableUntil: process.env.LOOTBOX_EVENT_UNTIL ? Number(process.env.LOOTBOX_EVENT_UNTIL) : null,
  },
];
const BOX_BY_ID = Object.fromEntries(BOXES.map((b) => [b.id, b]));

/** A box is open for business if not explicitly disabled and not past its window. */
function boxActive(box, now = Date.now()) {
  if (box.active === false) return false;
  if (box.availableUntil != null && now > box.availableUntil) return false;
  return true;
}

// --- Item registry: one cosmetic collectible per (world, rarity) -----------
// [common, uncommon, rare, epic, legendary, mythic] as [name, icon] per world.
const ITEM_DEFS = {
  local:     [['Verbeulter Aktenkoffer', '💼'], ['Erste-Umsatz-Urkunde', '📜'], ['Vergoldeter Kugelschreiber', '🖊️'], ['Gründer-Pokal', '🏆'], ['Diamant-Visitenkarte', '💠'], ['Goldener Gründerthron', '👑']],
  national:  [['Regional-Anstecker', '📍'], ['Handelskammer-Plakette', '🪧'], ['Silberner Filialschlüssel', '🗝️'], ['Marktführer-Trophäe', '🏆'], ['Nationalwappen aus Gold', '🦅'], ['Kronjuwel der Wirtschaft', '💎']],
  global:    [['Reisepass-Stempel', '🛂'], ['Welthandels-Kompass', '🧭'], ['Seidener Handelsbrief', '📃'], ['Goldener Globus', '🌐'], ['Perlen-Diadem', '👑'], ['Drachen-Handelssiegel', '🐉']],
  tech:      [['Retro-Platine', '🔌'], ['Hackathon-Medaille', '🥇'], ['Hologramm-Badge', '🪪'], ['Quanten-Würfel', '🧊'], ['Goldener Prototyp', '🦾'], ['Singularitäts-Kern', '🌀']],
  finance:   [['Glücks-Cent', '🪙'], ['Silberbarren-Miniatur', '🥈'], ['Goldener Stier', '🐂'], ['Diamant-Tresorschlüssel', '🔑'], ['Platin-Aktienschein', '📈'], ['Urkristall-Aktie', '🔮']],
  space:     [['Meteoriten-Splitter', '☄️'], ['Missions-Abzeichen', '🚀'], ['Orbit-Modell', '🛰️'], ['Mondgestein-Trophäe', '🌕'], ['Iridium-Sternenkompass', '✨'], ['Antimaterie-Phiole', '🌌']],
  metaverse: [['Pixel-Sticker', '🟦'], ['Avatar-Skin', '🧑‍🎤'], ['Seltenes Emote', '😎'], ['NFT-Kunstwerk', '🖼️'], ['Genesis-Token', '🎫'], ['Genesis-Block', '🧱']],
  biotech:   [['Petrischalen-Andenken', '🧫'], ['Enzym-Phiole', '🧪'], ['DNA-Modell', '🧬'], ['Goldene Doppelhelix', '🥼'], ['Stammzell-Kristall', '💠'], ['Unsterblichkeits-Serum', '⏳']],
  ai:        [['Lochkarte', '🗂️'], ['Turing-Medaille', '🥇'], ['Neuralnetz-Diagramm', '🕸️'], ['Goldener Roboterarm', '🦾'], ['AGI-Kern', '🤖'], ['Singularitäts-Krone', '👑']],
};

/** ITEMS: flat list [{ id, world, worldName, rarity, name, icon, color }]. */
export const ITEMS = WORLD_IDS.flatMap((world) =>
  (ITEM_DEFS[world] ?? []).map(([name, icon], i) => {
    const rarity = RARITY_IDS[i];
    return { id: `item_${world}_${rarity}`, world, worldName: WORLD_NAME[world] ?? world, rarity, name, icon, color: RARITY_BY_ID[rarity].color };
  })
);
const ITEM_BY_ID = Object.fromEntries(ITEMS.map((it) => [it.id, it]));
export const ITEM_IDS = new Set(ITEMS.map((it) => it.id));
// Quick lookup: world → rarity → item.
const ITEM_BY_WORLD_RARITY = {};
for (const it of ITEMS) (ITEM_BY_WORLD_RARITY[it.world] ??= {})[it.rarity] = it;

const itemMap = (rows) => Object.fromEntries(rows.map((r) => [r.item_id, r.count]));

// --- Anti-burst token bucket (per player, in-memory) -----------------------
const OPEN_LIMIT = { ratePerSec: 5, burst: 10 };
const buckets = new Map();
export function openAllowed(userId, now = Date.now()) {
  const b = buckets.get(userId) ?? { tokens: OPEN_LIMIT.burst, last: now };
  b.tokens = Math.min(OPEN_LIMIT.burst, b.tokens + ((now - b.last) / 1000) * OPEN_LIMIT.ratePerSec);
  b.last = now;
  if (b.tokens < 1) { buckets.set(userId, b); return false; }
  b.tokens -= 1; buckets.set(userId, b);
  return true;
}

// --- Rolling (CSPRNG) ------------------------------------------------------
/** Pick a rarity id from a weight table with a crypto-secure, uniform draw. */
function rollRarity(weights) {
  // Scale to integers so randomInt stays exact even with fractional weights.
  const entries = RARITY_IDS
    .filter((id) => (weights[id] ?? 0) > 0)
    .map((id) => [id, Math.round((weights[id] ?? 0) * 1000)]);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = randomInt(0, total); // uniform in [0, total)
  for (const [id, w] of entries) { if (r < w) return id; r -= w; }
  return entries[0][0];
}

/**
 * Buy + open a box. Spends the box price via the authoritative economy, then
 * grants exactly one crypto-randomly chosen item. Caller wraps this in db.tx so
 * the spend + the grant commit together (or not at all).
 */
export function open(userId, boxId, world, now = Date.now()) {
  const box = BOX_BY_ID[boxId];
  if (!box || !boxActive(box, now)) return { error: 'Unbekannte oder inaktive Box.' };
  if (box.scope === 'world' && !WORLD_ID_SET.has(world)) return { error: 'Bitte eine gültige Welt wählen.' };

  // 1) Pay first — server-authoritative, atomic. No money → no item.
  if (!economy.spendMoney(userId, box.price, now)) {
    return { error: 'Nicht genug Guthaben.', money: economy.peekMoney(userId), price: box.price };
  }
  // 2) Decide the result with a CSPRNG: rarity by weight, then world, then item.
  const rarity = rollRarity(box.weights);
  const worlds = box.scope === 'world' ? [world] : WORLD_IDS;
  const chosenWorld = worlds[randomInt(0, worlds.length)];
  const item = ITEM_BY_WORLD_RARITY[chosenWorld][rarity];

  // 3) Grant it.
  const have = itemMap(queries.getItems(userId));
  queries.setItem(userId, item.id, (have[item.id] ?? 0) + 1);

  return {
    ok: true,
    item: { id: item.id, world: item.world, worldName: item.worldName, rarity: item.rarity, name: item.name, icon: item.icon, color: item.color },
    price: box.price,
    money: economy.peekMoney(userId),
  };
}

/** The player's full cosmetic-item inventory (every known item id → count). */
export function inventory(userId) {
  const have = itemMap(queries.getItems(userId));
  const items = {};
  for (const it of ITEMS) items[it.id] = have[it.id] ?? 0;
  return { items };
}

/** Dev only: grant `count` of an item directly (caller enforces the dev gate). */
export function grantItem(userId, itemId, count = 1) {
  if (!ITEM_IDS.has(itemId)) return { error: 'Unbekanntes Item.' };
  const n = Math.max(1, Math.floor(count) || 1);
  const have = itemMap(queries.getItems(userId));
  queries.setItem(userId, itemId, (have[itemId] ?? 0) + n);
  return { ok: true, granted: { id: itemId, count: n }, ...inventory(userId) };
}

/** Normalized drop odds (%) per box, for transparent display in the client. */
function oddsOf(weights) {
  const total = RARITY_IDS.reduce((s, id) => s + (weights[id] ?? 0), 0) || 1;
  return Object.fromEntries(RARITY_IDS.map((id) => [id, ((weights[id] ?? 0) / total) * 100]));
}

/** Static registry for the client UI (rarities, boxes+odds, items, worlds). */
export function config(now = Date.now()) {
  const boxes = BOXES.filter((b) => boxActive(b, now)).map((b) => ({
    id: b.id, name: b.name, icon: b.icon, desc: b.desc, scope: b.scope,
    price: b.price, odds: oddsOf(b.weights),
    availableUntil: b.availableUntil ?? null,
  }));
  return {
    rarities: RARITIES,
    boxes,
    items: ITEMS,
    worlds: WORLD_IDS.map((world) => ({ world, name: WORLD_NAME[world] ?? world })),
  };
}
