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

const MAX_OPEN_PER_USER = Number(process.env.TRADE_MAX_OPEN ?? 3);
const LOBBY_TTL_MS = Number(process.env.TRADE_LOBBY_TTL_MS ?? 30 * 60 * 1000);

const RES_SET = new Set(RESOURCE_TYPES);
const bag = (userId) => Object.fromEntries(queries.getResources(userId).map((r) => [r.type, r.amount]));

/** Add {type: amount} to a player's bag (used for delivery + refunds). */
function credit(userId, deltas) {
  const cur = bag(userId);
  for (const [t, a] of Object.entries(deltas)) if (a) queries.setResource(userId, t, (cur[t] ?? 0) + a);
}

/** Refund every escrowed offer in a lobby back to its owner, then clear them. */
function refundAll(lobbyId) {
  for (const o of queries.getOffers(lobbyId)) {
    const esc = JSON.parse(o.escrow);
    if (Object.keys(esc).length) credit(o.user_id, esc);
  }
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

  const clean = {};
  for (const [t, a] of Object.entries(offer ?? {})) {
    if (!RES_SET.has(t)) return { error: `Unbekannter Rohstoff: ${t}.` };
    const n = Number(a);
    if (!Number.isFinite(n) || n < 0) return { error: 'Ungültige Menge.' };
    if (n > 0) clean[t] = n;
  }

  const mine = queries.getOffers(lobbyId).find((o) => o.user_id === userId);
  const escrow = JSON.parse(mine?.escrow ?? '{}');
  const have = bag(userId);
  const types = new Set([...Object.keys(escrow), ...Object.keys(clean)]);

  // Validate affordability of every increase before moving anything.
  for (const t of types) {
    const delta = (clean[t] ?? 0) - (escrow[t] ?? 0);
    if (delta > 0 && (have[t] ?? 0) + 1e-9 < delta) return { error: `Nicht genug ${t}.` };
  }
  // Apply: deduct increases, refund decreases (delta > 0 ⇒ bag shrinks).
  for (const t of types) {
    const delta = (clean[t] ?? 0) - (escrow[t] ?? 0);
    if (delta !== 0) queries.setResource(userId, t, (have[t] ?? 0) - delta);
  }
  queries.upsertOffer(lobbyId, userId, JSON.stringify(clean), 0);
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
  const offers = Object.fromEntries(queries.getOffers(lobby.id).map((o) => [o.user_id, JSON.parse(o.escrow)]));
  const aId = lobby.creator_id, bId = lobby.joiner_id;
  const aGave = offers[aId] ?? {}, bGave = offers[bId] ?? {};
  credit(aId, bGave); // creator receives the joiner's escrow
  credit(bId, aGave); // joiner receives the creator's escrow
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
    queries.getOffers(lobbyId).map((o) => [o.user_id, { offer: JSON.parse(o.escrow), confirmed: !!o.confirmed }])
  );
  const partnerId = lobby.creator_id === userId ? lobby.joiner_id : lobby.creator_id;
  const nameOf = (id) => (id === lobby.creator_id ? lobby.creator_name : lobby.joiner_name);
  return {
    id: lobby.id, status: lobby.status, title: lobby.title, isCreator: lobby.creator_id === userId,
    you: {
      name: nameOf(userId), resources: bag(userId),
      offer: offers[userId]?.offer ?? {}, confirmed: offers[userId]?.confirmed ?? false,
    },
    partner: partnerId ? {
      name: nameOf(partnerId), present: true,
      offer: offers[partnerId]?.offer ?? {}, confirmed: offers[partnerId]?.confirmed ?? false,
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
