/**
 * A milestone that unlocks when its condition becomes true. Unlocked
 * achievements grant a small permanent global income bonus.
 */
export class Achievement {
    id;
    name;
    description;
    icon;
    /** Multiplicative global bonus granted while unlocked (e.g. 1.01 = +1%). */
    bonus;
    conditionFn;
    unlocked = false;
    constructor(config) {
        this.id = config.id;
        this.name = config.name;
        this.description = config.description ?? '';
        this.icon = config.icon ?? '🏆';
        this.bonus = config.bonus ?? 1;
        this.conditionFn = config.condition ?? (() => false);
    }
    /** Re-evaluate; returns true the first time it flips to unlocked. */
    check(game) {
        if (this.unlocked)
            return false;
        if (this.conditionFn(game)) {
            this.unlocked = true;
            return true;
        }
        return false;
    }
    toJSON() {
        return { id: this.id, unlocked: this.unlocked };
    }
    loadJSON(data) {
        if (data)
            this.unlocked = !!data.unlocked;
    }
}
//# sourceMappingURL=Achievement.js.map