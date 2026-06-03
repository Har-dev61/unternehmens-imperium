/**
 * A one-time purchase that permanently modifies the game's economy through
 * one or more declarative "effects" (see the Effect union). Effects are
 * interpreted centrally by Game.recalculate().
 */
export class Upgrade {
    id;
    name;
    description;
    icon;
    category;
    cost;
    effects;
    world;
    rare;
    /** Unlock predicate; once unlocked it stays visible. */
    unlockFn;
    purchased = false;
    unlocked = false;
    constructor(config) {
        this.id = config.id;
        this.name = config.name;
        this.description = config.description ?? '';
        this.icon = config.icon ?? '⬆️';
        this.category = config.category ?? 'production';
        this.cost = config.cost;
        this.effects = config.effects ?? [];
        this.world = config.world ?? null;
        this.rare = config.rare ?? false;
        this.unlockFn = config.unlock ?? (() => true);
    }
    isUnlocked(game) {
        if (this.unlocked)
            return true;
        if (this.unlockFn(game))
            this.unlocked = true;
        return this.unlocked;
    }
    toJSON() {
        return { id: this.id, purchased: this.purchased, unlocked: this.unlocked };
    }
    loadJSON(data) {
        if (!data)
            return;
        this.purchased = !!data.purchased;
        this.unlocked = !!data.unlocked;
    }
}
//# sourceMappingURL=Upgrade.js.map