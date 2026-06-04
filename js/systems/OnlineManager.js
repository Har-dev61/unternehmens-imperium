/**
 * Online layer with two interchangeable transports behind one API:
 *   1. Real server  — the Express + SQLite backend (via fetch).
 *   2. Simulation   — localStorage fallback with living AI rivals.
 *
 * Every method tries the server first (when a serverUrl is configured) and
 * transparently falls back to the simulation on any network error.
 */
export class OnlineManager {
    bus;
    storageKey;
    serverUrl;
    token;
    session = { mode: 'offline', username: null, lastSync: 0 };
    /** True after a successful authenticated server call. */
    usingServer = false;
    /** null = untried, true/false after the first request. */
    serverReachable = null;
    // --- Realtime (Phase 4): server→client push over a WebSocket ---
    ws = null;
    wsWantOpen = false;
    wsAttempts = 0;
    wsTimer = null;
    constructor(bus, opts = {}) {
        if (typeof opts === 'string')
            opts = { storageKey: opts }; // back-compat
        const { storageKey = 'ui-online', serverUrl = null } = opts;
        this.bus = bus;
        this.storageKey = storageKey;
        this.serverUrl = (serverUrl ?? localStorage.getItem(storageKey + '-server') ?? '').replace(/\/$/, '');
        this.token = localStorage.getItem(storageKey + '-token') || null;
        this.seedCompetitors();
    }
    get isOnline() { return this.session.mode !== 'offline'; }
    hasServer() { return !!this.serverUrl; }
    setServerUrl(url) {
        this.serverUrl = (url || '').replace(/\/$/, '');
        localStorage.setItem(this.storageKey + '-server', this.serverUrl);
        this.serverReachable = null;
    }
    // === Sessions ===========================================================
    async loginAsGuest() {
        if (this.serverUrl) {
            try {
                return this.applyAuth(await this.api('/api/auth/guest', { method: 'POST', body: {} }));
            }
            catch (e) {
                this.serverFailed(e);
            }
        }
        return this.simSession('guest');
    }
    /** Create a new account (username + e-mail + password). */
    async register(username, email, password) {
        if (this.serverUrl) {
            try {
                return this.applyAuth(await this.api('/api/auth/register', { method: 'POST', body: { username, email, password } }));
            }
            catch (e) {
                this.bubbleOrFallback(e);
            }
        }
        return this.simSession('account', username, email);
    }
    /** Sign in with a username OR e-mail plus password. */
    async login(identifier, password = '') {
        if (this.serverUrl) {
            try {
                return this.applyAuth(await this.api('/api/auth/login', { method: 'POST', body: { identifier, password } }));
            }
            catch (e) {
                this.bubbleOrFallback(e);
            }
        }
        return this.simSession(password ? 'account' : 'guest', identifier);
    }
    /** Confirm an e-mail with the token from the verification mail/link. */
    async verifyEmail(token) {
        if (!this.serverUrl)
            throw new Error('Kein Server konfiguriert.');
        const r = await this.api('/api/auth/verify', { method: 'POST', body: { token } });
        if (this.isOnline) {
            this.session.emailVerified = true;
            this.bus.emit('online:session', this.session);
        }
        return !!r.ok;
    }
    /** Re-send the verification mail for the logged-in account. */
    async resendVerification() {
        if (!this.usingServer)
            throw new Error('Dafür musst du mit dem Server angemeldet sein.');
        return this.api('/api/auth/resend-verification', { method: 'POST', body: {}, auth: true });
    }
    /** Ask for a password-reset mail. Resolves regardless (no account enumeration). */
    async requestPasswordReset(email) {
        if (!this.serverUrl)
            throw new Error('Kein Server konfiguriert.');
        return this.api('/api/auth/forgot', { method: 'POST', body: { email } });
    }
    /** Set a new password with a reset token; logs in with a fresh session. */
    async resetPassword(token, password) {
        if (!this.serverUrl)
            throw new Error('Kein Server konfiguriert.');
        return this.applyAuth(await this.api('/api/auth/reset', { method: 'POST', body: { token, password } }));
    }
    /** Re-surface a real server error to the caller; only swallow network failures. */
    bubbleOrFallback(e) {
        if (typeof e.http === 'number')
            throw e; // server responded (e.g. 401/409) → let the UI show it
        this.serverFailed(e); // unreachable → caller falls back to simulation
    }
    // === Resources (Phase 2 — server-authoritative) =========================
    /** Static registry: which world produces what, building costs/rates. */
    async fetchResourceConfig() {
        if (!this.serverUrl)
            throw new Error('Kein Server konfiguriert.');
        return this.api('/api/resources/config');
    }
    /** The player's settled stocks + current rates + owned buildings. */
    async fetchResources() {
        if (!this.usingServer)
            throw new Error('Dafür musst du online angemeldet sein.');
        return this.api('/api/resources', { auth: true });
    }
    /** Buy a resource building (paid with resources; validated server-side). */
    async buildResource(buildingId, quantity = 1) {
        if (!this.usingServer)
            throw new Error('Dafür musst du online angemeldet sein.');
        return this.api('/api/resources/build', { method: 'POST', body: { buildingId, quantity }, auth: true });
    }
    // === Trading lobbies (Phase 3) ==========================================
    requireServer() { if (!this.usingServer)
        throw new Error('Dafür musst du online angemeldet sein.'); }
    async listLobbies(search = '') {
        this.requireServer();
        return (await this.api('/api/lobbies?search=' + encodeURIComponent(search), { auth: true })).lobbies ?? [];
    }
    async createLobby(title = '') {
        this.requireServer();
        return this.api('/api/lobbies', { method: 'POST', body: { title }, auth: true });
    }
    async getLobby(id) {
        this.requireServer();
        return this.api('/api/lobbies/' + encodeURIComponent(id), { auth: true });
    }
    async joinLobby(id) {
        this.requireServer();
        return this.api('/api/lobbies/' + encodeURIComponent(id) + '/join', { method: 'POST', body: {}, auth: true });
    }
    async setLobbyOffer(id, offer) {
        this.requireServer();
        return this.api('/api/lobbies/' + encodeURIComponent(id) + '/offer', { method: 'POST', body: { offer }, auth: true });
    }
    async confirmTrade(id, confirmed) {
        this.requireServer();
        return this.api('/api/lobbies/' + encodeURIComponent(id) + '/confirm', { method: 'POST', body: { confirmed }, auth: true });
    }
    async leaveLobby(id) {
        this.requireServer();
        return this.api('/api/lobbies/' + encodeURIComponent(id) + '/leave', { method: 'POST', body: {}, auth: true });
    }
    async tradeHistory() {
        this.requireServer();
        return (await this.api('/api/lobbies/history', { auth: true })).history ?? [];
    }
    logout() {
        this.disconnectSocket();
        this.token = null;
        localStorage.removeItem(this.storageKey + '-token');
        this.usingServer = false;
        this.session = { mode: 'offline', username: null, lastSync: 0 };
        this.bus.emit('online:session', this.session);
    }
    // === Cloud saves ========================================================
    async syncSave(state) {
        if (!this.isOnline)
            throw new Error('Nicht online');
        if (this.usingServer)
            await this.api('/api/save', { method: 'PUT', body: { data: state }, auth: true });
        else
            this.simCloudWrite(state);
        this.session.lastSync = Date.now();
        this.bus.emit('online:synced', { at: this.session.lastSync });
        return true;
    }
    async loadCloud() {
        if (!this.isOnline)
            throw new Error('Nicht online');
        if (this.usingServer)
            return (await this.api('/api/save', { auth: true })).data ?? null;
        return this.simCloudRead();
    }
    // === Leaderboard ========================================================
    async submitScore({ name, valuation, prestige }) {
        if (this.usingServer && this.token) {
            try {
                await this.api('/api/leaderboard', { method: 'POST', body: { name, valuation, prestige }, auth: true });
                return true;
            }
            catch (e) {
                this.serverFailed(e);
            }
        }
        this.simSubmit({ name, valuation, prestige });
        return true;
    }
    async fetchLeaderboard(limit = 20) {
        if (this.serverUrl && this.serverReachable !== false) {
            try {
                return (await this.api('/api/leaderboard?limit=' + limit, { auth: true })).entries;
            }
            catch (e) {
                this.serverFailed(e);
            }
        }
        return this.simLeaderboard(limit);
    }
    async fetchEvents() {
        if (!this.isOnline)
            return [];
        if (this.usingServer) {
            try {
                return (await this.api('/api/events')).events ?? [];
            }
            catch {
                return [];
            }
        }
        return this.simEvents();
    }
    // === Realtime push (Phase 4) ============================================
    /** True while the push socket is connected. */
    get isLive() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }
    /** Open the server→client push socket (idempotent); auto-reconnects with backoff. */
    connectSocket() {
        if (!this.usingServer || !this.token || !this.serverUrl)
            return;
        this.wsWantOpen = true;
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING))
            return;
        const url = this.serverUrl.replace(/^http/, 'ws') + '/api/ws?token=' + encodeURIComponent(this.token);
        let ws;
        try {
            ws = new WebSocket(url);
        }
        catch {
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;
        ws.onopen = () => { this.wsAttempts = 0; this.bus.emit('online:live', { open: true }); };
        ws.onmessage = (e) => { try {
            this.bus.emit('realtime', JSON.parse(String(e.data)));
        }
        catch { /* ignore */ } };
        ws.onerror = () => { try {
            ws.close();
        }
        catch { /* ignore */ } };
        ws.onclose = () => {
            if (this.ws === ws)
                this.ws = null;
            this.bus.emit('online:live', { open: false });
            if (this.wsWantOpen)
                this.scheduleReconnect();
        };
    }
    scheduleReconnect() {
        if (!this.wsWantOpen || this.wsTimer)
            return;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.wsAttempts++, 5)); // 1s → … → 30s
        this.wsTimer = setTimeout(() => { this.wsTimer = null; this.connectSocket(); }, delay);
    }
    /** Close the push socket and stop reconnecting (on logout / expiry). */
    disconnectSocket() {
        this.wsWantOpen = false;
        if (this.wsTimer) {
            clearTimeout(this.wsTimer);
            this.wsTimer = null;
        }
        if (this.ws) {
            try {
                this.ws.close();
            }
            catch { /* ignore */ }
            this.ws = null;
        }
    }
    // === Real HTTP transport ===============================================
    async api(path, { method = 'GET', body = null, auth = false } = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (auth && this.token)
            headers.Authorization = 'Bearer ' + this.token;
        const res = await fetch(this.serverUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
        this.serverReachable = true;
        if (!res.ok) {
            // Abgelaufenes/ungültiges Token bei einem authentifizierten Aufruf →
            // Sitzung beenden, damit die UI eine erneute Anmeldung anbieten kann.
            if (res.status === 401 && auth)
                this.handleExpiredToken();
            let msg = 'HTTP ' + res.status;
            try {
                msg = (await res.json()).error ?? msg;
            }
            catch { /* keep default */ }
            const err = new Error(msg);
            err.http = res.status;
            throw err;
        }
        return res.json();
    }
    handleExpiredToken() {
        this.disconnectSocket();
        this.token = null;
        localStorage.removeItem(this.storageKey + '-token');
        this.usingServer = false;
        this.session = { mode: 'offline', username: null, lastSync: 0 };
        this.bus.emit('online:session', this.session);
        this.bus.emit('online:expired');
    }
    applyAuth(r) {
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
    serverFailed(e) {
        this.serverReachable = false;
        this.usingServer = false;
        console.warn('[OnlineManager] Server nicht erreichbar – nutze Simulation:', e.message);
    }
    // === Simulation fallback (localStorage) ================================
    simSession(mode, username, email) {
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
    cloudKey() { return `${this.storageKey}-cloud-${this.session.username ?? 'anon'}`; }
    simCloudWrite(state) { localStorage.setItem(this.cloudKey(), JSON.stringify(state)); }
    simCloudRead() {
        const raw = localStorage.getItem(this.cloudKey());
        return raw ? JSON.parse(raw) : null;
    }
    simSubmit({ name, valuation, prestige }) {
        const board = this.readBoard();
        board.player = { name, valuation, prestige, isPlayer: true };
        this.writeBoard(board);
    }
    simLeaderboard(limit) {
        const board = this.readBoard();
        const now = Date.now();
        const entries = board.competitors.map((c) => {
            const minutes = Math.max(0, (now - board.seededAt) / 60000);
            const valuation = c.base * Math.pow(1 + c.growth, Math.min(minutes, 60 * 24 * 30));
            return { name: c.name, valuation, prestige: c.prestige, isPlayer: false };
        });
        if (board.player)
            entries.push(board.player);
        entries.sort((a, b) => b.valuation - a.valuation);
        return entries.slice(0, limit).map((e, i) => ({ ...e, rank: i + 1 }));
    }
    simEvents() {
        if (Math.random() > 0.12)
            return [];
        const pool = [
            { id: 'boom', name: '📈 Globaler Wirtschaftsboom', multiplier: 3, duration: 60 },
            { id: 'viral', name: '🔥 Virale Marketing-Kampagne', multiplier: 5, duration: 30 },
            { id: 'merger', name: '🤝 Fusionswelle', multiplier: 2, duration: 120 },
        ];
        const e = pool[Math.floor(Math.random() * pool.length)];
        return [{ ...e, source: 'online', startedAt: Date.now() }];
    }
    shortId() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }
    readBoard() {
        try {
            const raw = localStorage.getItem(this.storageKey + '-board');
            if (raw)
                return JSON.parse(raw);
        }
        catch { /* reseed */ }
        return this.seedCompetitors();
    }
    writeBoard(board) {
        localStorage.setItem(this.storageKey + '-board', JSON.stringify(board));
    }
    seedCompetitors() {
        const existing = localStorage.getItem(this.storageKey + '-board');
        if (existing) {
            try {
                return JSON.parse(existing);
            }
            catch { /* reseed */ }
        }
        const names = [
            'Globex Corp', 'Initech', 'Stark Industries', 'Wayne Enterprises', 'Hooli',
            'Pied Piper', 'Wonka Industries', 'Acme Co', 'Cyberdyne', 'Umbrella AG',
            'Soylent GmbH', 'Massive Dynamic', 'Aperture Science', 'Vandelay Inc', 'Gekko Capital',
        ];
        const competitors = names.map((name) => ({
            name,
            base: 10 ** (3 + Math.random() * 9),
            growth: 0.002 + Math.random() * 0.01,
            prestige: Math.floor(Math.random() * 20),
        }));
        const board = { seededAt: Date.now(), competitors, player: null };
        this.writeBoard(board);
        return board;
    }
}
//# sourceMappingURL=OnlineManager.js.map