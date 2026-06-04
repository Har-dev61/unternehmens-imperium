const REWARD_WEIGHTS = [
    { type: 'lucky', weight: 50 },
    { type: 'frenzy', weight: 35 },
    { type: 'clickFrenzy', weight: 15 },
];
/**
 * "Goldener Deal" — the company-themed golden cookie. Every few minutes a
 * clickable reward spawns for a short window; the reward type is rolled here
 * and applied by Game.clickGolden().
 */
export class GoldenDeal {
    bus;
    active = null;
    lifetime = 13;
    secondsUntilNext;
    constructor(bus) {
        this.bus = bus;
        this.secondsUntilNext = this.randomInterval();
    }
    update(dt) {
        const now = Date.now();
        if (this.active) {
            if (now > this.active.expiresAt) {
                const expired = this.active;
                this.active = null;
                this.secondsUntilNext = this.randomInterval();
                this.bus.emit('golden:expire', expired);
            }
            return;
        }
        this.secondsUntilNext -= dt;
        if (this.secondsUntilNext <= 0)
            this.spawn();
    }
    /** Consume the active deal if the id matches; returns it (or null). */
    claim(id) {
        if (!this.active || this.active.id !== id)
            return null;
        const deal = this.active;
        this.active = null;
        this.secondsUntilNext = this.randomInterval();
        return deal;
    }
    reset() {
        this.active = null;
        this.secondsUntilNext = this.randomInterval();
    }
    spawn() {
        this.active = {
            id: 'gd-' + Date.now(),
            type: this.rollType(),
            expiresAt: Date.now() + this.lifetime * 1000,
        };
        this.bus.emit('golden:spawn', this.active);
    }
    rollType() {
        const total = REWARD_WEIGHTS.reduce((s, r) => s + r.weight, 0);
        let roll = Math.random() * total;
        for (const r of REWARD_WEIGHTS) {
            roll -= r.weight;
            if (roll <= 0)
                return r.type;
        }
        return 'lucky';
    }
    randomInterval() {
        return 300 + Math.random() * 300; // 5–10 minutes
    }
}
//# sourceMappingURL=GoldenDeal.js.map