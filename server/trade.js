/**
 * Trading system with 1:1 lobbies (Phase 3).
 *
 * Safety model (escrow-on-offer):
 *  - Resources are server-authoritative (Phase 2). When a player sets an offer,
 *    the offered amounts are moved OUT of their bag into the lobby's escrow
 *    immediately — so the same resources can never be promised in two lobbies.
 *  - Any change to either offer resets BOTH confirmations. The trade executes
 *    only when both players have confirmed; execution just hands each escrow to
 *    the other side (the resources already exist and are locked).
 *  - Leaving / cancelling / expiry refunds every escrow back to its owner.
 *  - All money-moving steps run inside a DB transaction at the call site
 *    (endpoints wrap them in db.tx); the sweeper wraps each lobby itself.
 *
 * Only resources are tradable — they are the one thing the server truly owns.
 */
import { randomBytes } from 'node:crypto';
import { queries, tx } from './db.js';
import { RESOURCE_TYPES } from './resources.js';
import * as economy from './economy.js';

const MAX_OPEN_PER_USER = Number(process.env.TRADE_MAX_OPEN ?? 3);
const LOBBY_TTL_MS = Number(process.env.TRADE_LOBBY_TTL_MS ?? 30 * 60 * 1000);

const RES_SET = new Set(RESOURCE_TYPES);
const bag = (userId) => Object.fromEntries(queries.getResources(userId).map((r) => [r.type, r.amount]));

/** Escrow JSON → { resources:{type:amt}, money:N }. Tolerates the legacy flat format. */
function parseEscrow(json) {
  const e = JSON.parse(json || '{}');
  if (e && typeof e === 'object' && ('resources' in e || 'money' in e)) return { resources: e.resources ?? {}, money: Number(e.money ?? 0) };
  return { resources: e ?? {}, money: 0 };
}

/** Add {type: amount} resources to a player's bag (delivery + refunds). */
function credit(userId, deltas) {
  const cur = bag(userId);
  for (const [t, a] of Object.entries(deltas)) if (a) queries.setResource(userId, t, (cur[t] ?? 0) + a);
}

/** Give a player an escrowed bundle (resources + money). */
function deliver(userId, bundle, now) {
  credit(userId, bundle.resources ?? {});
  if (bundle.money > 0) economy.addMoney(userId, bundle.money, now);
}

/** Refund every escrowed offer in a lobby back to its owner, then clear them. */
function refundAll(lobbyId, now = Date.now()) {
  for (const o of queries.getOffers(lobbyId)) deliver(o.user_id, parseEscrow(o.escrow), now);
  queries.deleteLobbyOffers(lobbyId);
}

// === Lobby lifecycle =======================================================
export function createLobby(userId, title) {
  if (queries.countOpenLobbies(userId) >= MAX_OPEN_PER_USER) {
    return { error: `Du hast bereits ${MAX_OPEN_PER_USER} offene Lobbys.` };
  }
  const id = randomBytes(4).toString('hex'); // short shareable code
  queries.createLobby(id, userId, (title ?? '').toString().slice(0, 60) || null);
  queries.upsertOffer(id, userId, '{}', 0);
  return { ok: true, id };
}

export function listLobbies(search = '') {
  const q = String(search).toLowerCase().trim();
  let rows = queries.listOpenLobbies(100);
  if (q) rows = rows.filter((l) =>
    l.id.includes(q) || (l.title ?? '').toLowerCase().includes(q) || (l.creator_name ?? '').toLowerCase().includes(q));
  return rows.slice(0, 50).map((l) => ({ id: l.id, title: l.title, creator: l.creator_name, createdAt: l.created_at }));
}

export function joinLobby(userId, lobbyId) {
  const lobby = queries.getLobby(lobbyId);
  if (!lobby) return { error: 'Lobby nicht gefunden.' };
  if (lobby.status !== 'open') return { error: 'Diese Lobby ist nicht (mehr) offen.' };
  if (lobby.creator_id === userId) return { error: 'Das ist deine eigene Lobby.' };
  if (lobby.joiner_id) return { error: 'Die Lobby ist bereits voll.' };
  queries.setLobbyJoiner(lobbyId, userId, 'active');
  queries.upsertOffer(lobbyId, userId, '{}', 0);
  return { ok: true, id: lobbyId };
}

/** Leaving cancels the lobby and refunds both sides (simplest safe semantics). */
export function leaveLobby(userId, lobbyId, now = Date.now()) {
  const lobby = queries.getLobby(lobbyId);
  if (!lobby) return { error: 'Lobby nicht gefunden.' };
  if (lobby.creator_id !== userId && lobby.joiner_id !== userId) return { error: 'Kein Teilnehmer dieser Lobby.' };
  if (lobby.status === 'completed' || lobby.status === 'cancelled') return { ok: true, status: lobby.status };
  refundAll(lobbyId, now);
  queries.setLobbyStatus(lobbyId, 'cancelled');
  return { ok: true, cancelled: true };
}

// === Offers + confirmation =================================================
function isParticipant(lobby, userId) {
  return lobby && (lobby.creator_id === userId || lobby.joiner_id === userId);
}

/** Replace the caller's offer; moves the delta in/out of escrow and resets confirms. */
export function setOffer(userId, lobbyId, offer, now = Date.now()) {
  const lobby = queries.getLobby(lobbyId);
  if (!isParticipant(lobby, userId)) return { error: 'Kein Teilnehmer dieser Lobby.' };
  if (lobby.status !== 'open' && lobby.status !== 'active') return { error: 'Diese Lobby ist nicht mehr aktiv.' };

  // Accept either { resources:{…}, money:N } or a legacy flat resource map.
  const inc = offer ?? {};
  const hasShape = inc && typeof inc === 'object' && ('resources' in inc || 'money' in inc);
  const reqRes = hasShape ? (inc.resources ?? {}) : inc;
  const reqMoney = hasShape ? Number(inc.money ?? 0) : 0;
  if (!Number.isFinite(reqMoney) || reqMoney < 0) return { error: 'Ungültiger Geldbetrag.' };

  const clean = {};
  for (const [t, a] of Object.entries(reqRes)) {
    if (!RES_SET.has(t)) return { error: `Unbekannter Rohstoff: ${t}.` };
    const n = Number(a);
    if (!Number.isFinite(n) || n < 0) return { error: 'Ungültige Menge.' };
    if (n > 0) clean[t] = n;
  }

  const mine = queries.getOffers(lobbyId).find((o) => o.user_id === userId);
  const escrow = parseEscrow(mine?.escrow);
  const have = bag(userId);
  const types = new Set([...Object.keys(escrow.resources), ...Object.keys(clean)]);

  // 1) Validate resource affordability (pure check) before any side effects.
  for (const t of types) {
    const delta = (clean[t] ?? 0) - (escrow.resources[t] ?? 0);
    if (delta > 0 && (have[t] ?? 0) + 1e-9 < delta) return { error: `Nicht genug ${t}.` };
  }
  // 2) Money escrow delta via the authoritative economy (may fail → bail early).
  const moneyDelta = reqMoney - escrow.money;
  if (moneyDelta > 0) { if (!economy.spendMoney(userId, moneyDelta, now)) return { error: 'Nicht genug Geld.' }; }
  else if (moneyDelta < 0) economy.addMoney(userId, -moneyDelta, now);
  // 3) Apply resource deltas (deduct increases, refund decreases).
  for (const t of types) {
    const delta = (clean[t] ?? 0) - (escrow.resources[t] ?? 0);
    if (delta !== 0) queries.setResource(userId, t, (have[t] ?? 0) - delta);
  }
  queries.upsertOffer(lobbyId, userId, JSON.stringify({ resources: clean, money: reqMoney }), 0);
  queries.resetLobbyConfirms(lobbyId); // any offer change invalidates both confirmations
  queries.touchLobby(lobbyId);
  return { ok: true };
}

/** Set/clear the caller's confirmation. Executes the trade once both confirm. */
export function confirm(userId, lobbyId, confirmed, now = Date.now()) {
  const lobby = queries.getLobby(lobbyId);
  if (!isParticipant(lobby, userId)) return { error: 'Kein Teilnehmer dieser Lobby.' };
  if (lobby.status !== 'active') return { error: 'Beide Spieler müssen anwesend sein.' };
  queries.setOfferConfirmed(lobbyId, userId, confirmed);
  queries.touchLobby(lobbyId);
  if (confirmed) {
    const offers = queries.getOffers(lobbyId);
    if (offers.length === 2 && offers.every((o) => o.confirmed)) return executeTrade(lobby, now);
  }
  return { ok: true };
}

/** Atomic swap: each side receives what the other escrowed. Caller is in a tx. */
function executeTrade(lobby, now) {
  const offers = Object.fromEntries(queries.getOffers(lobby.id).map((o) => [o.user_id, parseEscrow(o.escrow)]));
  const aId = lobby.creator_id, bId = lobby.joiner_id;
  const aGave = offers[aId] ?? { resources: {}, money: 0 }, bGave = offers[bId] ?? { resources: {}, money: 0 };
  deliver(aId, bGave, now); // creator receives the joiner's escrow (resources + money)
  deliver(bId, aGave, now); // joiner receives the creator's escrow
  queries.deleteLobbyOffers(lobby.id);
  queries.setLobbyStatus(lobby.id, 'completed');
  queries.insertTradeHistory(lobby.id, aId, bId, JSON.stringify(aGave), JSON.stringify(bGave));
  return { ok: true, completed: true };
}

// === Views =================================================================
export function getLobbyState(userId, lobbyId, now = Date.now()) {
  const lobby = queries.getLobbyView(lobbyId);
  if (!isParticipant(lobby, userId)) return { error: 'Kein Teilnehmer dieser Lobby.' };
  const offers = Object.fromEntries(
    queries.getOffers(lobbyId).map((o) => [o.user_id, { offer: parseEscrow(o.escrow), confirmed: !!o.confirmed }])
  );
  const partnerId = lobby.creator_id === userId ? lobby.joiner_id : lobby.creator_id;
  const nameOf = (id) => (id === lobby.creator_id ? lobby.creator_name : lobby.joiner_name);
  const empty = { resources: {}, money: 0 };
  return {
    id: lobby.id, status: lobby.status, title: lobby.title, isCreator: lobby.creator_id === userId,
    you: {
      name: nameOf(userId), resources: bag(userId), money: economy.peekMoney(userId),
      offer: offers[userId]?.offer ?? empty, confirmed: offers[userId]?.confirmed ?? false,
    },
    partner: partnerId ? {
      name: nameOf(partnerId), present: true,
      offer: offers[partnerId]?.offer ?? empty, confirmed: offers[partnerId]?.confirmed ?? false,
    } : null,
  };
}

export function history(userId, limit = 20) {
  return queries.getTradeHistory(userId, limit).map((h) => {
    const mineIsA = h.a_id === userId;
    const partnerId = mineIsA ? h.b_id : h.a_id;
    return {
      id: h.id, completedAt: h.completed_at,
      partner: queries.getUserById(partnerId)?.username ?? 'Unbekannt',
      youGave: JSON.parse(mineIsA ? h.a_gave : h.b_gave),
      youGot: JSON.parse(mineIsA ? h.b_gave : h.a_gave),
    };
  });
}

/** Cancel + refund lobbies idle for longer than the TTL. Wraps each in a tx. */
export function sweepExpired(now = Date.now()) {
  for (const lobby of queries.getStaleLobbies(now - LOBBY_TTL_MS)) {
    tx(() => { refundAll(lobby.id, now); queries.setLobbyStatus(lobby.id, 'cancelled'); });
  }
}
