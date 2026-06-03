import { Employee } from './Employee.js';
import { Building } from './Building.js';
import { Asset } from './Asset.js';
/** Factory: turn a plain asset config into the right Asset subclass. */
function createAsset(config, world) {
    switch (config.type) {
        case 'employee':
            return new Employee(config, world);
        case 'building':
        default:
            return new Building(config, world);
    }
}
/**
 * A market / realm the player expands into. Each world owns its own income
 * assets, visual theme, production multiplier and unlock condition.
 */
export class World {
    id;
    name;
    description;
    icon;
    theme;
    productionMultiplier;
    /** Multiplier applied by world-specific upgrades; reset each recalc. */
    upgradeMultiplier = 1;
    unlockFn;
    unlocked;
    unlockHint;
    /** Lifetime-earnings threshold (for UI progress bars); null if N/A. */
    unlockAt;
    assets;
    constructor(config) {
        this.id = config.id;
        this.name = config.name;
        this.description = config.description ?? '';
        this.icon = config.icon ?? '🌍';
        this.theme = config.theme ?? 'local';
        this.productionMultiplier = config.productionMultiplier ?? 1;
        this.unlockFn = config.unlock ?? (() => true);
        this.unlocked = !!config.startUnlocked;
        this.unlockHint = config.unlockHint ?? '';
        this.unlockAt = config.unlockAt ?? null;
        this.assets = (config.assets ?? []).map((a) => createAsset(a, this));
    }
    /** Combined raw production of every asset in this world. */
    getProduction() {
        let sum = 0;
        for (const asset of this.assets)
            sum += asset.getProduction();
        return sum * this.productionMultiplier * this.upgradeMultiplier;
    }
    getAsset(id) {
        return this.assets.find((a) => a.id === id) ?? null;
    }
    /** Total units owned across all this world's assets. */
    getTotalAssetCount() {
        return this.assets.reduce((n, a) => n + a.count, 0);
    }
    /** Re-evaluate the unlock condition (sticky once true). */
    checkUnlock(game) {
        if (this.unlocked)
            return false;
        if (this.unlockFn(game)) {
            this.unlocked = true;
            return true;
        }
        return false;
    }
    toJSON() {
        return {
            id: this.id,
            unlocked: this.unlocked,
            assets: this.assets.map((a) => a.toJSON()),
        };
    }
    loadJSON(data) {
        if (!data)
            return;
        this.unlocked = !!data.unlocked;
        for (const assetData of data.assets ?? []) {
            this.getAsset(assetData.id)?.loadJSON(assetData);
        }
    }
}
//# sourceMappingURL=World.js.map