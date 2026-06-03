/**
 * The human behind the company: identity, long-term prestige progression and
 * lifetime statistics. Survives prestige resets (that's the whole point).
 */
export class Player {
    name;
    // --- Prestige progression ---
    prestigePoints = 0;
    prestigeLevel = 0;
    prestigeUpgrades = new Set();
    /** Researched tech-tree node ids (persist through prestige). */
    researchUpgrades = new Set();
    /** Combined prestige income multiplier; set by Game.recalculate(). */
    prestigeMultiplier = 1;
    // --- Daily reward ---
    /** Timestamp (ms) of the last claimed daily reward. */
    lastDailyClaim = 0;
    /** Consecutive-day streak. */
    dailyStreak = 0;
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
    computePrestigeGain() {
        return Math.floor(Math.cbrt(this.runEarned / 1e9));
    }
    toJSON() {
        return {
            name: this.name,
            prestigePoints: this.prestigePoints,
            prestigeLevel: this.prestigeLevel,
            prestigeUpgrades: [...this.prestigeUpgrades],
            researchUpgrades: [...this.researchUpgrades],
            runEarned: this.runEarned,
            lifetimeEarned: this.lifetimeEarned,
            totalClicks: this.totalClicks,
            playtimeSeconds: this.playtimeSeconds,
            goldenClicks: this.goldenClicks,
            lastDailyClaim: this.lastDailyClaim,
            dailyStreak: this.dailyStreak,
        };
    }
    loadJSON(data) {
        if (!data)
            return;
        this.name = data.name ?? this.name;
        this.prestigePoints = data.prestigePoints ?? 0;
        this.prestigeLevel = data.prestigeLevel ?? 0;
        this.prestigeUpgrades = new Set(data.prestigeUpgrades ?? []);
        this.researchUpgrades = new Set(data.researchUpgrades ?? []);
        this.runEarned = data.runEarned ?? 0;
        this.lifetimeEarned = data.lifetimeEarned ?? 0;
        this.totalClicks = data.totalClicks ?? 0;
        this.playtimeSeconds = data.playtimeSeconds ?? 0;
        this.goldenClicks = data.goldenClicks ?? 0;
        this.lastDailyClaim = data.lastDailyClaim ?? 0;
        this.dailyStreak = data.dailyStreak ?? 0;
    }
}
//# sourceMappingURL=Player.js.map