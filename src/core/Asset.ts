import type { World } from './World.js';
import type { AssetConfig } from '../types.js';

export interface AssetData {
  id: string;
  count: number;
}

/**
 * Abstract base class for everything the player can buy that generates
 * passive income: employees, buildings, departments, etc.
 *
 * Cost grows geometrically with the owned count (classic idle-game curve):
 *   cost(n) = baseCost * costMultiplier ^ n
 */
export class Asset {
  id: string;
  name: string;
  description: string;
  icon: string;
  /** UI category key — overridden by subclasses. */
  type: string;
  baseCost: number;
  baseProduction: number;
  costMultiplier: number;
  /** Number owned. */
  count = 0;
  /** Production multiplier contributed by upgrades; reset each recalc. */
  multiplier = 1;
  /** Back-reference to the owning world (not serialised). */
  world: World;

  constructor(config: AssetConfig, world: World) {
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
  getCost(quantity = 1, fromCount = this.count): number {
    const r = this.costMultiplier;
    const first = this.baseCost * Math.pow(r, fromCount);
    if (quantity === 1) return Math.ceil(first);
    return Math.ceil((first * (Math.pow(r, quantity) - 1)) / (r - 1));
  }

  /** How many can be bought with the given budget. */
  getMaxAffordable(budget: number): number {
    const r = this.costMultiplier;
    const first = this.baseCost * Math.pow(r, this.count);
    if (budget < first) return 0;
    const n = Math.floor(Math.log((budget * (r - 1)) / first + 1) / Math.log(r));
    return Math.max(0, n);
  }

  /** Production of a single unit (after upgrade multipliers). */
  getUnitProduction(): number {
    return this.baseProduction * this.multiplier;
  }

  /** Total production of all owned units (before world/global multipliers). */
  getProduction(): number {
    return this.count * this.getUnitProduction();
  }

  toJSON(): AssetData {
    return { id: this.id, count: this.count };
  }

  loadJSON(data?: Partial<AssetData> | null): void {
    if (data) this.count = data.count ?? 0;
  }
}
