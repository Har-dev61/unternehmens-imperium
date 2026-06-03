import { Asset } from './Asset.js';
import type { World } from './World.js';
import type { AssetConfig } from '../types.js';

/**
 * Physical / structural assets — offices, factories, data centres, colonies.
 * More expensive than employees but with much higher base output.
 */
export class Building extends Asset {
  constructor(config: AssetConfig, world: World) {
    super(config, world);
    this.type = 'building';
    this.icon = config.icon ?? '🏭';
  }
}
