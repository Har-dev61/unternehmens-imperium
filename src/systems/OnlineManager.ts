import type { EventBus } from './EventBus.js';
import type { OnlineSession, LeaderboardEntry, SaveState } from '../types.js';

interface OnlineOptions {
  storageKey?: string;
  serverUrl?: string | null;
}

interface Competitor {
  name: string;
  base: number;
  growth: number;
  prestige: number;
}

interface Board {
  seededAt: number;
  competitors: Competitor[];
  player: LeaderboardEntry | null;
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
}

type HttpError = Error & { http?: number };

interface ScorePayload {
  name: string;
  valuation: number;
  prestige: number;
}

/**
 * Online layer with two interchangeable transports behind one API:
 *   1. Real server  — the Express + SQLite backend (via fetch).
 *   2. Simulation   — localStorage fallback with living AI rivals.
 *
 * Every method tries the server first (when a serverUrl is configured) and
 * transparently falls back to the simulation on any network error.
 */
export class OnlineManager {
  bus: EventBus;
  storageKey: string;
  serverUrl: string;
  token: string | null;
  session: OnlineSession = { mode: 'offline', username: null, lastSync: 0 };
  /** True after a successful authenticated server call. */
  usingServer = false;
  /** null = untried, true/false after the first request. */
  serverReachable: boolean | null = null;

  // --- Realtime (Phase 4): server→client push over a WebSocket ---
  private ws: WebSocket | null = null;
  private wsWantOpen = false;
  private wsAttempts = 0;
  private wsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(bus: EventBus, opts: OnlineOptions | string = {}) {
    if (typeof opts === 'string') opts = { storageKey: opts }; // back-compat
    const { storageKey = 'ui-online', serverUrl = null } = opts;

    this.bus = bus;
    this.storageKey = storageKey;
    this.serverUrl = (serverUrl ?? localStorage.getItem(storageKey + '-server') ?? '').replace(/\/$/, '');
    this.token = localStorage.getItem(storageKey + '-token') || null;
    this.seedCompetitors();
  }

  get isOnline(): boolean { return this.session.mode !== 'offline'; }
  hasServer(): boolean { return !!this.serverUrl; }

  setServerUrl(url: string): void {
    this.serverUrl = (url || '').replace(/\/$/, '');
    localStorage.setItem(this.storageKey + '-server', this.serverUrl);
    this.serverReachable = null;
  }

  // === Sessions ===========================================================
  async loginAsGuest(): Promise<OnlineSession> {
    if (this.serverUrl) {
      try { return this.applyAuth(await this.api('/api/auth/guest', { method: 'POST', body: {} })); }
      catch (e) { this.serverFailed(e as Error); }
    }
    return this.simSession('guest');
  }

  /** Create a new account (username + e-mail + password). */
  async register(username: string, email: string, password: string): Promise<OnlineSession> {
    if (this.serverUrl) {
      try { return this.applyAuth(await this.api('/api/auth/register', { method: 'POST', body: { username, email, password } })); }
      catch (e) { this.bubbleOrFallback(e as HttpError); }
    }
    return this.simSession('account', username, email);
  }

  /** Sign in with a username OR e-mail plus password. */
  async login(identifier: string, password = ''): Promise<OnlineSession> {
    if (this.serverUrl) {
      try { return this.applyAuth(await this.api('/api/auth/login', { method: 'POST', body: { identifier, password } })); }
      catch (e) { this.bubbleOrFallback(e as HttpError); }
    }
    return this.simSession(password ? 'account' : 'guest', identifier);
  }

  /**
   * Restore a session on boot from a stored token (no password needed).
   * Verifies the token against the server; on success we're authoritative again.
   * Returns the session, or null if there's no token / the server rejected it.
   */
  async restoreSession(): Promise<OnlineSession | null> {
    if (!this.serverUrl || !this.token) return null;
    try {
      const me = await this.api('/api/auth/me', { auth: true });
      this.session = {
        mode: me.mode ?? 'account', username: me.username,
        email: me.email ?? null, emailVerified: !!me.emailVerified, lastSync: 0,
      };
      this.usingServer = true;
      this.serverReachable = true;
      this.bus.emit('online:session', this.session);
      this.connectSocket();
      return this.session;
    } catch {
      // 401 → api() already cleared the token via handleExpiredToken.
      // Network error → leave things untouched; the gate offers a retry.
      return null;
    }
  }

  /** Confirm an e-mail with the token from the verification mail/link. */
  async verifyEmail(token: string): Promise<boolean> {
    if (!this.serverUrl) throw new Error('Kein Server konfiguriert.');
    const r = await this.api('/api/auth/verify', { method: 'POST', body: { token } });
    if (this.isOnline) { this.session.emailVerified = true; this.bus.emit('online:session', this.session); }
    return !!r.ok;
  }

  /** Re-send the verification mail for the logged-in account. */
  async resendVerification(): Promise<{ devVerifyToken?: string }> {
    if (!this.usingServer) throw new Error('Dafür musst du mit dem Server angemeldet sein.');
    return this.api('/api/auth/resend-verification', { method: 'POST', body: {}, auth: true });
  }

  /** Ask for a password-reset mail. Resolves regardless (no account enumeration). */
  async requestPasswordReset(email: string): Promise<{ devResetToken?: string }> {
    if (!this.serverUrl) throw new Error('Kein Server konfiguriert.');
    return this.api('/api/auth/forgot', { method: 'POST', body: { email } });
  }

  /** Set a new password with a reset token; logs in with a fresh session. */
  async resetPassword(token: string, password: string): Promise<OnlineSession> {
    if (!this.serverUrl) throw new Error('Kein Server konfiguriert.');
    return this.applyAuth(await this.api('/api/auth/reset', { method: 'POST', body: { token, password } }));
  }

  /** Re-surface a real server error to the caller; only swallow network failures. */
  private bubbleOrFallback(e: HttpError): void {
    if (typeof e.http === 'number') throw e; // server responded (e.g. 401/409) → let the UI show it
    this.serverFailed(e);                    // unreachable → caller falls back to simulation
  }

  // === Resources (Phase 2 — server-authoritative) =========================
  /** Static registry: which world produces what, building costs/rates. */
  async fetchResourceConfig(): Promise<any> {
    if (!this.serverUrl) throw new Error('Kein Server konfiguriert.');
    return this.api('/api/resources/config');
  }

  /** The player's settled stocks + current rates + owned buildings. */
  async fetchResources(): Promise<any> {
    if (!this.usingServer) throw new Error('Dafür musst du online angemeldet sein.');
    return this.api('/api/resources', { auth: true });
  }

  /** Active collect: one server-side rarity roll in a world (costs energy). */
  async rollResource(world: string): Promise<any> {
    if (!this.usingServer) throw new Error('Dafür musst du online angemeldet sein.');
    return this.api('/api/resources/roll', { method: 'POST', body: { world }, auth: true });
  }

  /** Buy a booster (paid with resources; raises a world's energy cap/regen). */
  async buildResource(buildingId: string): Promise<any> {
    if (!this.usingServer) throw new Error('Dafür musst du online angemeldet sein.');
    return this.api('/api/resources/build', { method: 'POST', body: { buildingId }, auth: true });
  }

  // === Server-authoritative economy (Part 2b) =============================
  // The server runs the canonical Game; the client only sends actions and
  // mirrors the returned `save`. Every call returns
  // { money, perSecond, clickValue, valuation, influence, employees, buildings, save, …extra }.

  /** Settled snapshot (passive income accrued server-side). */
  async fetchEconomy(): Promise<any> {
    this.requireServer();
    return this.api('/api/economy', { auth: true });
  }
  /** Apply up to `count` clicks (server token-bucket × server click value). */
  async econClick(count: number): Promise<any> {
    this.requireServer();
    return this.api('/api/economy/click', { method: 'POST', body: { count }, auth: true });
  }
  async econBuyAsset(id: string, quantity: number | 'max' = 1): Promise<any> {
    this.requireServer();
    return this.api('/api/economy/buy-asset', { method: 'POST', body: { assetId: id, quantity }, auth: true });
  }
  async econBuyUpgrade(id: string): Promise<any> {
    this.requireServer();
    return this.api('/api/economy/buy-upgrade', { method: 'POST', body: { id }, auth: true });
  }
  async econResearch(id: string): Promise<any> {
    this.requireServer();
    return this.api('/api/economy/research', { method: 'POST', body: { id }, auth: true });
  }
  async econPrestigeUpgrade(id: string): Promise<any> {
    this.requireServer();
    return this.api('/api/economy/prestige-upgrade', { method: 'POST', body: { id }, auth: true });
  }
  async econPrestige(): Promise<any> {
    this.requireServer();
    return this.api('/api/economy/prestige', { method: 'POST', body: {}, auth: true });
  }
  async econSetWorld(id: string): Promise<any> {
    this.requireServer();
    return this.api('/api/economy/world', { method: 'POST', body: { id }, auth: true });
  }
  async econDaily(): Promise<any> {
    this.requireServer();
    return this.api('/api/economy/daily', { method: 'POST', body: {}, auth: true });
  }
  async econClaimQuest(id: string): Promise<any> {
    this.requireServer();
    return this.api('/api/economy/quest', { method: 'POST', body: { id }, auth: true });
  }

  // === Lootboxes (cosmetic prestige items, server-authoritative) ==========
  /** Static catalogue: rarities, box types + odds, item registry, worlds. */
  async fetchLootboxConfig(): Promise<any> {
    if (!this.serverUrl) throw new Error('Kein Server konfiguriert.');
    return this.api('/api/lootbox/config');
  }
  /** The player's owned cosmetic items. */
  async fetchLootboxInventory(): Promise<any> {
    this.requireServer();
    return this.api('/api/lootbox/inventory', { auth: true });
  }
  /** Buy + open one box. Server spends the money and decides the item (CSPRNG). */
  async openLootbox(boxType: string, world = ''): Promise<any> {
    this.requireServer();
    return this.api('/api/lootbox/open', { method: 'POST', body: { boxType, world }, auth: true });
  }

  // === Trading lobbies (Phase 3) ==========================================
  private requireServer(): void { if (!this.usingServer) throw new Error('Dafür musst du online angemeldet sein.'); }

  async listLobbies(search = ''): Promise<any[]> {
    this.requireServer();
    return (await this.api('/api/lobbies?search=' + encodeURIComponent(search), { auth: true })).lobbies ?? [];
  }
  async createLobby(title = ''): Promise<{ id: string }> {
    this.requireServer();
    return this.api('/api/lobbies', { method: 'POST', body: { title }, auth: true });
  }
  async getLobby(id: string): Promise<any> {
    this.requireServer();
    return this.api('/api/lobbies/' + encodeURIComponent(id), { auth: true });
  }
  async joinLobby(id: string): Promise<{ id: string }> {
    this.requireServer();
    return this.api('/api/lobbies/' + encodeURIComponent(id) + '/join', { method: 'POST', body: {}, auth: true });
  }
  async setLobbyOffer(id: string, offer: Record<string, number> | { resources: Record<string, number>; money: number; items?: Record<string, number> }): Promise<any> {
    this.requireServer();
    return this.api('/api/lobbies/' + encodeURIComponent(id) + '/offer', { method: 'POST', body: { offer }, auth: true });
  }
  async confirmTrade(id: string, confirmed: boolean): Promise<any> {
    this.requireServer();
    return this.api('/api/lobbies/' + encodeURIComponent(id) + '/confirm', { method: 'POST', body: { confirmed }, auth: true });
  }
  async leaveLobby(id: string): Promise<any> {
    this.requireServer();
    return this.api('/api/lobbies/' + encodeURIComponent(id) + '/leave', { method: 'POST', body: {}, auth: true });
  }
  async tradeHistory(): Promise<any[]> {
    this.requireServer();
    return (await this.api('/api/lobbies/history', { auth: true })).history ?? [];
  }

  logout(): void {
    this.disconnectSocket();
    this.token = null;
    localStorage.removeItem(this.storageKey + '-token');
    this.usingServer = false;
    this.session = { mode: 'offline', username: null, lastSync: 0 };
    this.bus.emit('online:session', this.session);
  }

  // === Cloud saves ========================================================
  async syncSave(state: SaveState): Promise<boolean> {
    if (!this.isOnline) throw new Error('Nicht online');
    if (this.usingServer) await this.api('/api/save', { method: 'PUT', body: { data: state }, auth: true });
    else this.simCloudWrite(state);
    this.session.lastSync = Date.now();
    this.bus.emit('online:synced', { at: this.session.lastSync });
    return true;
  }

  async loadCloud(): Promise<SaveState | null> {
    if (!this.isOnline) throw new Error('Nicht online');
    if (this.usingServer) return (await this.api('/api/save', { auth: true })).data ?? null;
    return this.simCloudRead();
  }

  // === Leaderboard ========================================================
  async submitScore({ name, valuation, prestige }: ScorePayload): Promise<boolean> {
    if (this.usingServer && this.token) {
      try { await this.api('/api/leaderboard', { method: 'POST', body: { name, valuation, prestige }, auth: true }); return true; }
      catch (e) { this.serverFailed(e as Error); }
    }
    this.simSubmit({ name, valuation, prestige });
    return true;
  }

  async fetchLeaderboard(limit = 20): Promise<LeaderboardEntry[]> {
    if (this.serverUrl && this.serverReachable !== false) {
      try { return (await this.api('/api/leaderboard?limit=' + limit, { auth: true })).entries as LeaderboardEntry[]; }
      catch (e) { this.serverFailed(e as Error); }
    }
    return this.simLeaderboard(limit);
  }

  async fetchEvents(): Promise<any[]> {
    if (!this.isOnline) return [];
    if (this.usingServer) {
      try { return (await this.api('/api/events')).events ?? []; }
      catch { return []; }
    }
    return this.simEvents();
  }

  // === Realtime push (Phase 4) ============================================
  /** True while the push socket is connected. */
  get isLive(): boolean { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

  /** Open the server→client push socket (idempotent); auto-reconnects with backoff. */
  connectSocket(): void {
    if (!this.usingServer || !this.token || !this.serverUrl) return;
    this.wsWantOpen = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const url = this.serverUrl.replace(/^http/, 'ws') + '/api/ws?token=' + encodeURIComponent(this.token);
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = () => { this.wsAttempts = 0; this.bus.emit('online:live', { open: true }); };
    ws.onmessage = (e) => { try { this.bus.emit('realtime', JSON.parse(String(e.data))); } catch { /* ignore */ } };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.bus.emit('online:live', { open: false });
      if (this.wsWantOpen) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.wsWantOpen || this.wsTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.wsAttempts++, 5)); // 1s → … → 30s
    this.wsTimer = setTimeout(() => { this.wsTimer = null; this.connectSocket(); }, delay);
  }

  /** Close the push socket and stop reconnecting (on logout / expiry). */
  disconnectSocket(): void {
    this.wsWantOpen = false;
    if (this.wsTimer) { clearTimeout(this.wsTimer); this.wsTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
  }

  // === Real HTTP transport ===============================================
  private async api(path: string, { method = 'GET', body = null, auth = false }: ApiOptions = {}): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth && this.token) headers.Authorization = 'Bearer ' + this.token;
    const res = await fetch(this.serverUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    this.serverReachable = true;
    if (!res.ok) {
      // Abgelaufenes/ungültiges Token bei einem authentifizierten Aufruf →
      // Sitzung beenden, damit die UI eine erneute Anmeldung anbieten kann.
      if (res.status === 401 && auth) this.handleExpiredToken();
      let msg = 'HTTP ' + res.status;
      try { msg = (await res.json()).error ?? msg; } catch { /* keep default */ }
      const err: HttpError = new Error(msg);
      err.http = res.status;
      throw err;
    }
    return res.json();
  }

  private handleExpiredToken(): void {
    this.disconnectSocket();
    this.token = null;
    localStorage.removeItem(this.storageKey + '-token');
    this.usingServer = false;
    this.session = { mode: 'offline', username: null, lastSync: 0 };
    this.bus.emit('online:session', this.session);
    this.bus.emit('online:expired');
  }

  private applyAuth(r: any): OnlineSession {
    this.token = r.token;
    localStorage.setItem(this.storageKey + '-token', r.token);
    this.session = {
      mode: r.mode ?? 'account', username: r.username,
      email: r.email ?? null, emailVerified: !!r.emailVerified, lastSync: 0,
    };
    this.usingServer = true;
    this.serverReachable = true;
    this.bus.emit('online:session', this.session);
    this.connectSocket(); // open the realtime push channel once authenticated
    // No real e-mail delivery yet → surface dev tokens so the flow stays testable.
    if (r.devVerifyToken || r.devResetToken) {
      this.bus.emit('online:devtoken', { verify: r.devVerifyToken, reset: r.devResetToken });
    }
    return this.session;
  }

  private serverFailed(e: Error): void {
    this.serverReachable = false;
    this.usingServer = false;
    console.warn('[OnlineManager] Server nicht erreichbar – nutze Simulation:', e.message);
  }

  // === Simulation fallback (localStorage) ================================
  private simSession(mode: 'guest' | 'account', username?: string, email?: string): OnlineSession {
    this.usingServer = false;
    this.session = {
      mode,
      username: username || (mode === 'guest' ? 'Gast-' + this.shortId() : 'Spieler'),
      email: email ?? null,
      emailVerified: mode === 'account', // simulation has no e-mail infra → treat as verified
      lastSync: 0,
    };
    this.bus.emit('online:session', this.session);
    return this.session;
  }

  private cloudKey(): string { return `${this.storageKey}-cloud-${this.session.username ?? 'anon'}`; }
  private simCloudWrite(state: SaveState): void { localStorage.setItem(this.cloudKey(), JSON.stringify(state)); }
  private simCloudRead(): SaveState | null {
    const raw = localStorage.getItem(this.cloudKey());
    return raw ? (JSON.parse(raw) as SaveState) : null;
  }

  private simSubmit({ name, valuation, prestige }: ScorePayload): void {
    const board = this.readBoard();
    board.player = { name, valuation, prestige, isPlayer: true };
    this.writeBoard(board);
  }

  private simLeaderboard(limit: number): LeaderboardEntry[] {
    const board = this.readBoard();
    const now = Date.now();
    const entries: LeaderboardEntry[] = board.competitors.map((c) => {
      const minutes = Math.max(0, (now - board.seededAt) / 60000);
      const valuation = c.base * Math.pow(1 + c.growth, Math.min(minutes, 60 * 24 * 30));
      return { name: c.name, valuation, prestige: c.prestige, isPlayer: false };
    });
    if (board.player) entries.push(board.player);
    entries.sort((a, b) => b.valuation - a.valuation);
    return entries.slice(0, limit).map((e, i) => ({ ...e, rank: i + 1 }));
  }

  private simEvents(): any[] {
    if (Math.random() > 0.12) return [];
    const pool = [
      { id: 'boom', name: '📈 Globaler Wirtschaftsboom', multiplier: 3, duration: 60 },
      { id: 'viral', name: '🔥 Virale Marketing-Kampagne', multiplier: 5, duration: 30 },
      { id: 'merger', name: '🤝 Fusionswelle', multiplier: 2, duration: 120 },
    ];
    const e = pool[Math.floor(Math.random() * pool.length)]!;
    return [{ ...e, source: 'online', startedAt: Date.now() }];
  }

  private shortId(): string { return Math.random().toString(36).slice(2, 6).toUpperCase(); }

  private readBoard(): Board {
    try {
      const raw = localStorage.getItem(this.storageKey + '-board');
      if (raw) return JSON.parse(raw) as Board;
    } catch { /* reseed */ }
    return this.seedCompetitors();
  }

  private writeBoard(board: Board): void {
    localStorage.setItem(this.storageKey + '-board', JSON.stringify(board));
  }

  private seedCompetitors(): Board {
    const existing = localStorage.getItem(this.storageKey + '-board');
    if (existing) { try { return JSON.parse(existing) as Board; } catch { /* reseed */ } }
    const names = [
      'Globex Corp', 'Initech', 'Stark Industries', 'Wayne Enterprises', 'Hooli',
      'Pied Piper', 'Wonka Industries', 'Acme Co', 'Cyberdyne', 'Umbrella AG',
      'Soylent GmbH', 'Massive Dynamic', 'Aperture Science', 'Vandelay Inc', 'Gekko Capital',
    ];
    const competitors: Competitor[] = names.map((name) => ({
      name,
      base: 10 ** (3 + Math.random() * 9),
      growth: 0.002 + Math.random() * 0.01,
      prestige: Math.floor(Math.random() * 20),
    }));
    const board: Board = { seededAt: Date.now(), competitors, player: null };
    this.writeBoard(board);
    return board;
  }
}
