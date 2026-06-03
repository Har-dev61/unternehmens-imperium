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

  /** Sign in to an account; creates it if it doesn't exist yet. */
  async login(username: string, password = ''): Promise<OnlineSession> {
    if (this.serverUrl) {
      try {
        let r;
        try {
          r = await this.api('/api/auth/login', { method: 'POST', body: { username, password } });
        } catch (e) {
          if ((e as HttpError).http === 401 && password) {
            r = await this.api('/api/auth/register', { method: 'POST', body: { username, password } });
          } else throw e;
        }
        return this.applyAuth(r);
      } catch (e) { this.serverFailed(e as Error); }
    }
    return this.simSession(password ? 'account' : 'guest', username);
  }

  logout(): void {
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
    this.session = { mode: r.mode ?? 'account', username: r.username, lastSync: 0 };
    this.usingServer = true;
    this.serverReachable = true;
    this.bus.emit('online:session', this.session);
    return this.session;
  }

  private serverFailed(e: Error): void {
    this.serverReachable = false;
    this.usingServer = false;
    console.warn('[OnlineManager] Server nicht erreichbar – nutze Simulation:', e.message);
  }

  // === Simulation fallback (localStorage) ================================
  private simSession(mode: 'guest' | 'account', username?: string): OnlineSession {
    this.usingServer = false;
    this.session = {
      mode,
      username: username || (mode === 'guest' ? 'Gast-' + this.shortId() : 'Spieler'),
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
