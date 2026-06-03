export interface PlayerData {
  name: string;
  prestigePoints: number;
  prestigeLevel: number;
  prestigeUpgrades: string[];
  runEarned: number;
  lifetimeEarned: number;
  totalClicks: number;
  playtimeSeconds: number;
  goldenClicks: number;
}

/**
 * The human behind the company: identity, long-term prestige progression and
 * lifetime statistics. Survives prestige resets (that's the whole point).
 */
export class Player {
  name: string;

  // --- Prestige progression ---
  prestigePoints = 0;
  prestigeLevel = 0;
  prestigeUpgrades = new Set<string>();
  /** Combined prestige income multiplier; set by Game.recalculate(). */
  prestigeMultiplier = 1;

  // --- Statistics ---
  runEarned = 0;
  lifetimeEarned = 0;
  totalClicks = 0;
  playtimeSeconds = 0;
  /** Golden Deals collected (stat for quests/achievements). */
  goldenClicks = 0;

  constructor(name = 'Gast') {
    this.name = name;
  }

  /** Potential Einfluss gain if the player prestiged right now. */
  computePrestigeGain(): number {
    return Math.floor(Math.cbrt(this.runEarned / 1e9));
  }

  toJSON(): PlayerData {
    return {
      name: this.name,
      prestigePoints: this.prestigePoints,
      prestigeLevel: this.prestigeLevel,
      prestigeUpgrades: [...this.prestigeUpgrades],
      runEarned: this.runEarned,
      lifetimeEarned: this.lifetimeEarned,
      totalClicks: this.totalClicks,
      playtimeSeconds: this.playtimeSeconds,
      goldenClicks: this.goldenClicks,
    };
  }

  loadJSON(data?: Partial<PlayerData> | null): void {
    if (!data) return;
    this.name = data.name ?? this.name;
    this.prestigePoints = data.prestigePoints ?? 0;
    this.prestigeLevel = data.prestigeLevel ?? 0;
    this.prestigeUpgrades = new Set(data.prestigeUpgrades ?? []);
    this.runEarned = data.runEarned ?? 0;
    this.lifetimeEarned = data.lifetimeEarned ?? 0;
    this.totalClicks = data.totalClicks ?? 0;
    this.playtimeSeconds = data.playtimeSeconds ?? 0;
    this.goldenClicks = data.goldenClicks ?? 0;
  }
}
