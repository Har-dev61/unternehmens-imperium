export class Resource {
    id;
    name;
    icon;
    amount;
    /** Lifetime total ever earned of this resource (never decreases). */
    totalEarned;
    /** Cached production rate, set by the Game each tick. */
    perSecond = 0;
    constructor({ id, name, icon = '', amount = 0 }) {
        this.id = id;
        this.name = name;
        this.icon = icon;
        this.amount = amount;
        this.totalEarned = amount;
    }
    /** Add an amount (counts towards totalEarned when positive). */
    add(value) {
        this.amount += value;
        if (value > 0)
            this.totalEarned += value;
    }
    /** Spend an amount if affordable. Returns true on success. */
    spend(value) {
        if (this.amount < value)
            return false;
        this.amount -= value;
        return true;
    }
    canAfford(value) {
        return this.amount >= value;
    }
    toJSON() {
        return { amount: this.amount, totalEarned: this.totalEarned };
    }
    loadJSON(data) {
        if (!data)
            return;
        this.amount = data.amount ?? 0;
        this.totalEarned = data.totalEarned ?? this.amount;
    }
}
//# sourceMappingURL=Resource.js.map