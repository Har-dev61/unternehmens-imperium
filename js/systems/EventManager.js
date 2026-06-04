const LOCAL_EVENTS = [
    { id: 'rush', name: '⚡ Auftragsboom', multiplier: 1.5, duration: 45 },
    { id: 'press', name: '📰 Positive Presse', multiplier: 1.3, duration: 90 },
    { id: 'investor', name: '💼 Investoren-Hype', multiplier: 2, duration: 30 },
    { id: 'season', name: '🎁 Saison-Hochbetrieb', multiplier: 1.8, duration: 60 },
];
/**
 * Manages temporary economic boosts. Local random events fire every few
 * minutes (offline-friendly); online events are ingested via the OnlineManager.
 */
export class EventManager {
    bus;
    active = [];
    secondsUntilNextLocal;
    constructor(bus) {
        this.bus = bus;
        this.secondsUntilNextLocal = this.randomInterval();
    }
    update(dt) {
        const now = Date.now();
        const before = this.active.length;
        this.active = this.active.filter((e) => {
            const alive = e.expiresAt > now;
            if (!alive)
                this.bus.emit('event:ended', e);
            return alive;
        });
        if (this.active.length !== before)
            this.bus.emit('events:changed', this.active);
        this.secondsUntilNextLocal -= dt;
        if (this.secondsUntilNextLocal <= 0) {
            const def = LOCAL_EVENTS[Math.floor(Math.random() * LOCAL_EVENTS.length)];
            this.addEvent({ ...def, source: 'local' });
            this.secondsUntilNextLocal = this.randomInterval();
        }
    }
    addEvent({ id, name, multiplier, duration, source = 'local', startedAt }) {
        // De-dupe: a server broadcast carries a stable id and is polled repeatedly —
        // don't stack the same event on every poll.
        const existing = this.active.find((e) => e.baseId === id);
        if (existing)
            return existing;
        const start = startedAt ?? Date.now();
        const event = {
            id: id + '-' + start,
            baseId: id,
            name,
            multiplier,
            source,
            expiresAt: start + duration * 1000,
        };
        this.active.push(event);
        this.bus.emit('event:started', event);
        this.bus.emit('events:changed', this.active);
        return event;
    }
    ingestServerEvents(events) {
        for (const e of events)
            this.addEvent(e);
    }
    /** Product of all active event multipliers. */
    getMultiplier() {
        return this.active.reduce((m, e) => m * e.multiplier, 1);
    }
    randomInterval() {
        return 360 + Math.random() * 240; // 6–10 minutes
    }
    toJSON() {
        return { active: this.active, secondsUntilNextLocal: this.secondsUntilNextLocal };
    }
    loadJSON(data) {
        if (!data)
            return;
        const now = Date.now();
        this.active = (data.active ?? []).filter((e) => e.expiresAt > now);
        this.secondsUntilNextLocal = data.secondsUntilNextLocal ?? this.randomInterval();
    }
}
//# sourceMappingURL=EventManager.js.map