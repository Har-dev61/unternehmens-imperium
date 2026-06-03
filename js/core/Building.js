import { Asset } from './Asset.js';
/**
 * Physical / structural assets — offices, factories, data centres, colonies.
 * More expensive than employees but with much higher base output.
 */
export class Building extends Asset {
    constructor(config, world) {
        super(config, world);
        this.type = 'building';
        this.icon = config.icon ?? '🏭';
    }
}
//# sourceMappingURL=Building.js.map