/**
 * A one-shot quest / mission. Tracks progress towards a numeric goal and,
 * once reached, can be claimed for a reward (applied in Game.claimQuest()).
 */
export class Quest {
    id;
    name;
    description;
    icon;
    goal;
    unit;
    reward;
    progressFn;
    completed = false;
    claimed = false;
    constructor(config) {
        this.id = config.id;
        this.name = config.name;
        this.description = config.description ?? '';
        this.icon = config.icon ?? '📋';
        this.goal = config.goal;
        this.unit = config.unit ?? '';
        this.reward = config.reward ?? {};
        this.progressFn = config.progress;
    }
    current(game) {
        return this.progressFn(game);
    }
    /** Re-evaluate; returns true the first time it flips to completed. */
    checkComplete(game) {
        if (this.completed)
            return false;
        if (this.current(game) >= this.goal) {
            this.completed = true;
            return true;
        }
        return false;
    }
    rewardText() {
        const parts = [];
        if (this.reward.money)
            parts.push('💰 Kapital');
        if (this.reward.influence)
            parts.push(`💠 ${this.reward.influence} Einfluss`);
        if (this.reward.globalMult)
            parts.push(`📈 +${Math.round((this.reward.globalMult - 1) * 100)} % Einnahmen`);
        return parts.join(' · ');
    }
    toJSON() {
        return { id: this.id, completed: this.completed, claimed: this.claimed };
    }
    loadJSON(data) {
        if (!data)
            return;
        this.completed = !!data.completed;
        this.claimed = !!data.claimed;
    }
}
//# sourceMappingURL=Quest.js.map