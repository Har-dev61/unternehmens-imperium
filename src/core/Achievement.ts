import type { Game } from './Game.js';
import type { AchievementConfig } from '../types.js';

export interface AchievementData {
  id: string;
  unlocked: boolean;
}

/**
 * A milestone that unlocks when its condition becomes true. Unlocked
 * achievements grant a small permanent global income bonus.
 */
export class Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  /** Multiplicative global bonus granted while unlocked (e.g. 1.01 = +1%). */
  bonus: number;
  conditionFn: (game: Game) => boolean;
  unlocked = false;

  constructor(config: AchievementConfig) {
    this.id = config.id;
    this.name = config.name;
    this.description = config.description ?? '';
    this.icon = config.icon ?? '🏆';
    this.bonus = config.bonus ?? 1;
    this.conditionFn = config.condition ?? (() => false);
  }

  /** Re-evaluate; returns true the first time it flips to unlocked. */
  check(game: Game): boolean {
    if (this.unlocked) return false;
    if (this.conditionFn(game)) {
      this.unlocked = true;
      return true;
    }
    return false;
  }

  toJSON(): AchievementData {
    return { id: this.id, unlocked: this.unlocked };
  }

  loadJSON(data?: Partial<AchievementData> | null): void {
    if (data) this.unlocked = !!data.unlocked;
  }
}
