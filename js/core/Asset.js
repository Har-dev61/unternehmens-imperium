/**
 * Abstract base class for everything the player can buy that generates
 * passive income: employees, buildings, departments, etc.
 *
 * Cost grows geometrically with the owned count (classic idle-game curve):
 *   cost(n) = baseCost * costMultiplier ^ n
 */
export class Asset {
    id;
    name;
    description;
    icon;
    /** UI category key — overridden by subclasses. */
    type;
    baseCost;
    baseProduction;
    costMultiplier;
    /** Number owned. */
    count = 0;
    /** Production multiplier contributed by upgrades; reset each recalc. */
    multiplier = 1;
    /** Back-reference to the owning world (not serialised). */
    world;
    constructor(config, world) {
        this.id = config.id;
        this.name = config.name;
        this.description = config.description ?? '';
        this.icon = config.icon ?? '🏢';
        this.type = config.type ?? 'asset';
        this.baseCost = config.baseCost;
        this.baseProduction = config.baseProduction;
        this.costMultiplier = config.costMultiplier ?? 1.15;
        this.world = world;
    }
    /**
     * Total cost to buy `quantity` more, starting from the current count.
     * Uses the closed-form geometric series sum.
     */
    getCost(quantity = 1, fromCount = this.count) {
        const r = this.costMultiplier;
        const first = this.baseCost * Math.pow(r, fromCount);
        if (quantity === 1)
            return Math.ceil(first);
        return Math.ceil((first * (Math.pow(r, quantity) - 1)) / (r - 1));
    }
    /** How many can be bought with the given budget. */
    getMaxAffordable(budget) {
        const r = this.costMultiplier;
        const first = this.baseCost * Math.pow(r, this.count);
        if (budget < first)
            return 0;
        const n = Math.floor(Math.log((budget * (r - 1)) / first + 1) / Math.log(r));
        return Math.max(0, n);
    }
    /** Production of a single unit (after upgrade multipliers). */
    getUnitProduction() {
        return this.baseProduction * this.multiplier;
    }
    /** Total production of all owned units (before world/global multipliers). */
    getProduction() {
        return this.count * this.getUnitProduction();
    }
    toJSON() {
        return { id: this.id, count: this.count };
    }
    loadJSON(data) {
        if (data)
            this.count = data.count ?? 0;
    }
}
//# sourceMappingURL=Asset.js.map