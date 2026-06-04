/**
 * Real-time push layer (Phase 4) — WebSockets via `ws`.
 *
 * Scope (per the agreed decisions): the socket is SERVER → CLIENT push only.
 * All mutating actions stay on the validated, transactional HTTP endpoints; the
 * socket just notifies clients so they can re-fetch instantly instead of polling.
 * Currently pushed: trade-lobby changes (live offers/confirmations) + a
 * "you're logged in elsewhere" notice for a second connection.
 *
 * Auth: the connection carries the existing bearer token as `?token=`. Reconnect
 * is the client's job (it re-fetches authoritative state on open) — since no
 * actions flow over the socket, a dropped connection never loses progress.
 */
import { WebSocketServer } from 'ws';
import { queries } from './db.js';

/** userId → Set<WebSocket> (a user may have several tabs/devices). */
const sockets = new Map();
let wss = null;
let heartbeat = null;

const isLiveToken = (user) => user && user.token_expires && user.token_expires >= Date.now();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ } }
}
function addSocket(userId, ws) {
  if (!sockets.has(userId)) sockets.set(userId, new Set());
  sockets.get(userId).add(ws);
}
function removeSocket(userId, ws) {
  const set = sockets.get(userId);
  if (set) { set.delete(ws); if (set.size === 0) sockets.delete(userId); }
}

/** Push a message to every live socket of a user. */
export function pushToUser(userId, msg) {
  const set = sockets.get(userId);
  if (set) for (const ws of set) send(ws, msg);
}

/** Notify a lobby's participants that it changed → they re-fetch via HTTP. */
export function pushLobby(lobbyId) {
  const lobby = queries.getLobby(lobbyId);
  if (!lobby) return;
  for (const uid of [lobby.creator_id, lobby.joiner_id]) if (uid) pushToUser(uid, { type: 'lobby:changed', id: lobbyId });
}

/** True if the given user currently has at least one open socket. */
export function isOnline(userId) { return (sockets.get(userId)?.size ?? 0) > 0; }

/** Attach the WS server to an existing HTTP server (shares the port, path /api/ws). */
export function attach(server) {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    if (url.pathname !== '/api/ws') { socket.destroy(); return; }
    const user = queries.getUserByToken(url.searchParams.get('token') ?? '');
    if (!isLiveToken(user)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = user.id;
      ws.isAlive = true;
      // A second connection for the same account → notify the existing ones.
      if (isOnline(user.id)) pushToUser(user.id, { type: 'session:elsewhere' });
      addSocket(user.id, ws);
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('close', () => removeSocket(user.id, ws));
      ws.on('error', () => { try { ws.close(); } catch { /* ignore */ } });
      send(ws, { type: 'hello' });
    });
  });

  // Heartbeat: drop sockets that stopped answering pings (dead connections).
  heartbeat = setInterval(() => {
    for (const set of sockets.values()) for (const ws of set) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30_000);
  if (heartbeat.unref) heartbeat.unref();

  return wss;
}

/** For tests: close the WS server + all sockets. */
export function close() {
  if (heartbeat) clearInterval(heartbeat);
  for (const set of sockets.values()) for (const ws of set) { try { ws.terminate(); } catch { /* ignore */ } }
  sockets.clear();
  if (wss) wss.close();
}
