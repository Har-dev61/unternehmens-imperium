import type { Game } from './Game.js';
import type { Effect, UpgradeConfig, UpgradeCategory } from '../types.js';

export interface UpgradeData {
  id: string;
  purchased: boolean;
  unlocked: boolean;
}

/**
 * A one-time purchase that permanently modifies the game's economy through
 * one or more declarative "effects" (see the Effect union). Effects are
 * interpreted centrally by Game.recalculate().
 */
export class Upgrade {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: UpgradeCategory;
  cost: number;
  effects: Effect[];
  world: string | null;
  rare: boolean;
  /** Unlock predicate; once unlocked it stays visible. */
  unlockFn: (game: Game) => boolean;

  purchased = false;
  unlocked = false;

  constructor(config: UpgradeConfig) {
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

  isUnlocked(game: Game): boolean {
    if (this.unlocked) return true;
    if (this.unlockFn(game)) this.unlocked = true;
    return this.unlocked;
  }

  toJSON(): UpgradeData {
    return { id: this.id, purchased: this.purchased, unlocked: this.unlocked };
  }

  loadJSON(data?: Partial<UpgradeData> | null): void {
    if (!data) return;
    this.purchased = !!data.purchased;
    this.unlocked = !!data.unlocked;
  }
}
