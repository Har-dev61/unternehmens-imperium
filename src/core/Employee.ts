import { Asset } from './Asset.js';
import type { World } from './World.js';
import type { AssetConfig } from '../types.js';

/**
 * People you hire. Tend to be cheaper than buildings and contribute to the
 * company head-count statistic. Otherwise behaves like any income asset.
 */
export class Employee extends Asset {
  constructor(config: AssetConfig, world: World) {
    super(config, world);
    this.type = 'employee';
    this.icon = config.icon ?? '👤';
  }
}
