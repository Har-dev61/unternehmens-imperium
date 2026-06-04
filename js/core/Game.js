import { Player } from './Player.js';
import { Company } from './Company.js';
import { World } from './World.js';
import { Upgrade } from './Upgrade.js';
import { Achievement } from './Achievement.js';
import { Quest } from './Quest.js';
import { Asset } from './Asset.js';
import { GoldenDeal } from '../systems/GoldenDeal.js';
import { WORLD_DEFS } from '../data/worlds.js';
import { UPGRADE_DEFS } from '../data/upgrades.js';
import { ACHIEVEMENT_DEFS } from '../data/achievements.js';
import { PRESTIGE_UPGRADES } from '../data/prestige.js';
import { QUEST_DEFS } from '../data/quests.js';
import { RESEARCH_DEFS } from '../data/research.js';
/**
 * Central orchestrator. Owns all model objects and systems, runs the game
 * loop, and is the single place where the economy maths and the declarative
 * upgrade effects are combined. The UI never mutates models directly — it
 * calls Game methods (click/buyAsset/buyUpgrade/prestige) and reacts to events.
 */
export class Game {
    bus;
    saveSystem;
    onlineManager;
    eventManager;
    player;
    company;
    worlds;
    upgrades;
    achievements;
    quests;
    prestigeUpgradeDefs;
    researchUpgradeDefs;
    goldenDeal;
    /** Temporary click-value boost from a Golden Deal "click frenzy". */
    clickFrenzy = { mult: 1, until: 0 };
    activeWorldId = 'local';
    settings = { muted: false, autosave: true, buyQuantity: '1' };
    /** Balancing knob: global throttle on research-point generation (lower = slower). */
    RESEARCH_RATE = 0.1;
    worldIndex = new Map();
    assetIndex = new Map();
    // Cached derived values, refreshed by computeDerived().
    _passivePerSecond = 0;
    _clickValue = 1;
    _perSecond = 0;
    _eventMultiplier = 1;
    _researchPerSecond = 0;
    running = false;
    lastFrame = 0;
    rafId;
    constructor(systems) {
        this.bus = systems.bus;
        this.saveSystem = systems.saveSystem;
        this.onlineManager = systems.onlineManager;
        this.eventManager = systems.eventManager;
        this.player = new Player();
        this.company = new Company();
        this.worlds = WORLD_DEFS.map((def) => new World(def));
        this.upgrades = UPGRADE_DEFS.map((def) => new Upgrade(def));
        this.achievements = ACHIEVEMENT_DEFS.map((def) => new Achievement(def));
        this.quests = QUEST_DEFS.map((def) => new Quest(def));
        this.prestigeUpgradeDefs = PRESTIGE_UPGRADES;
        this.researchUpgradeDefs = RESEARCH_DEFS;
        this.goldenDeal = new GoldenDeal(this.bus);
        for (const w of this.worlds)
            this.worldIndex.set(w.id, w);
        for (const w of this.worlds)
            for (const a of w.assets)
                this.assetIndex.set(a.id, a);
        this.recalculate();
    }
    // === Lookups ============================================================
    getWorld(id) { return this.worldIndex.get(id) ?? null; }
    getAsset(id) { return this.assetIndex.get(id) ?? null; }
    getActiveWorld() { return this.getWorld(this.activeWorldId); }
    getUpgrade(id) { return this.upgrades.find((u) => u.id === id) ?? null; }
    getUnlockedWorldCount() { return this.worlds.filter((w) => w.unlocked).length; }
    getPurchasedUpgradeCount() { return this.upgrades.filter((u) => u.purchased).length; }
    getEmployeeCount() { return this.countAssets((a) => a.type === 'employee'); }
    getBuildingCount() { return this.countAssets((a) => a.type === 'building'); }
    getTotalAssetCount() { return this.countAssets(() => true); }
    countAssets(pred) {
        let n = 0;
        for (const w of this.worlds)
            for (const a of w.assets)
                if (pred(a))
                    n += a.count;
        return n;
    }
    // === Economy maths ======================================================
    /**
     * Recompute every multiplier from scratch: reset, apply all purchased
     * upgrade + prestige effects, layer on achievement and prestige bonuses.
     */
    recalculate() {
        const c = this.company;
        c.clickMultiplier = 1;
        c.clickPercentOfProduction = 0;
        c.globalMultiplier = 1;
        c.autoClicksPerSecond = 0;
        c.researchRateMult = 1;
        for (const w of this.worlds) {
            w.upgradeMultiplier = 1;
            for (const a of w.assets)
                a.multiplier = 1;
        }
        for (const u of this.upgrades) {
            if (u.purchased)
                for (const e of u.effects)
                    this.applyEffect(e);
        }
        for (const pu of this.prestigeUpgradeDefs) {
            if (this.player.prestigeUpgrades.has(pu.id) && pu.effects) {
                for (const e of pu.effects)
                    this.applyEffect(e);
            }
        }
        for (const ru of this.researchUpgradeDefs) {
            if (this.player.researchUpgrades.has(ru.id) && ru.effects) {
                for (const e of ru.effects)
                    this.applyEffect(e);
            }
        }
        let achBonus = 1;
        for (const a of this.achievements)
            if (a.unlocked)
                achBonus *= a.bonus;
        c.globalMultiplier *= achBonus;
        for (const q of this.quests) {
            if (q.claimed && q.reward.globalMult)
                c.globalMultiplier *= q.reward.globalMult;
        }
        this.player.prestigeMultiplier = 1 + 0.02 * this.player.prestigePoints;
        this.computeDerived();
        this.bus.emit('recalculated');
    }
    applyEffect(e) {
        const c = this.company;
        switch (e.type) {
            case 'click':
                c.clickMultiplier *= e.multiplier;
                break;
            case 'clickPercent':
                c.clickPercentOfProduction += e.percent;
                break;
            case 'global':
                c.globalMultiplier *= e.multiplier;
                break;
            case 'autoclick':
                c.autoClicksPerSecond += e.amount;
                break;
            case 'asset': {
                const a = this.getAsset(e.target);
                if (a)
                    a.multiplier *= e.multiplier;
                break;
            }
            case 'assetClass': {
                for (const w of this.worlds)
                    for (const a of w.assets) {
                        if (a.type === e.target)
                            a.multiplier *= e.multiplier;
                    }
                break;
            }
            case 'world': {
                const w = this.getWorld(e.target);
                if (w)
                    w.upgradeMultiplier *= e.multiplier;
                break;
            }
            case 'researchRate':
                c.researchRateMult *= e.multiplier;
                break;
        }
    }
    /** Refresh cached passive €/s, click value and total €/s. */
    computeDerived() {
        let production = 0;
        for (const w of this.worlds)
            if (w.unlocked)
                production += w.getProduction();
        const c = this.company;
        const meta = c.globalMultiplier * this.player.prestigeMultiplier * this.eventManager.getMultiplier();
        const passive = production * meta;
        const frenzy = Date.now() < this.clickFrenzy.until ? this.clickFrenzy.mult : 1;
        const clickBase = c.clickBaseValue * c.clickMultiplier * meta * frenzy;
        const clickValue = clickBase + c.clickPercentOfProduction * passive;
        const autoIncome = c.autoClicksPerSecond * clickValue;
        this._eventMultiplier = this.eventManager.getMultiplier();
        this._passivePerSecond = passive;
        this._clickValue = clickValue;
        this._perSecond = passive + autoIncome;
        // Forschung: Assets erzeugen Forschungspunkte (Gebäude voll, Mitarbeiter halb).
        // RESEARCH_RATE drosselt das Grundtempo stark, damit der Forschungsbaum
        // Stunden statt Sekunden braucht (Balancing-Stellschraube).
        this._researchPerSecond = (this.getBuildingCount() + this.getEmployeeCount() * 0.5) * c.researchRateMult * this.RESEARCH_RATE;
        this.company.research.perSecond = this._researchPerSecond;
    }
    getPerSecond() { return this._perSecond; }
    getPassivePerSecond() { return this._passivePerSecond; }
    getClickValue() { return this._clickValue; }
    getEventMultiplier() { return this._eventMultiplier; }
    getResearchPerSecond() { return this._researchPerSecond; }
    /** Firmenwert: liquid capital plus one minute of capitalised revenue. */
    getValuation() {
        return this.company.money.amount + this._perSecond * 60;
    }
    // === Player actions =====================================================
    click() {
        const value = this._clickValue;
        this.company.money.add(value);
        this.player.runEarned += value;
        this.player.lifetimeEarned += value;
        this.player.totalClicks += 1;
        this.bus.emit('click', { value });
        this.bus.emit('money:changed');
        this.checkProgress();
        return value;
    }
    buyAsset(assetId, quantity = 1) {
        const asset = this.getAsset(assetId);
        if (!asset)
            return false;
        const qty = quantity === 'max'
            ? asset.getMaxAffordable(this.company.money.amount)
            : quantity;
        if (qty <= 0)
            return false;
        const cost = asset.getCost(qty);
        if (!this.company.money.spend(cost))
            return false;
        asset.count += qty;
        this.recalculate();
        this.bus.emit('asset:bought', { asset, qty, cost });
        this.bus.emit('money:changed');
        this.checkProgress();
        return true;
    }
    buyUpgrade(id) {
        const u = this.getUpgrade(id);
        if (!u || u.purchased || !u.isUnlocked(this))
            return false;
        if (!this.company.money.spend(u.cost))
            return false;
        u.purchased = true;
        this.recalculate();
        this.bus.emit('upgrade:bought', { upgrade: u });
        this.bus.emit('money:changed');
        this.checkProgress();
        return true;
    }
    buyPrestigeUpgrade(id) {
        if (this.player.prestigeUpgrades.has(id))
            return false;
        const pu = this.prestigeUpgradeDefs.find((x) => x.id === id);
        if (!pu || this.player.prestigePoints < pu.cost)
            return false;
        this.player.prestigePoints -= pu.cost;
        this.player.prestigeUpgrades.add(id);
        this.recalculate();
        this.bus.emit('prestige:upgrade', { id });
        return true;
    }
    /** Are a research node's prerequisites all researched? */
    isResearchAvailable(id) {
        const ru = this.researchUpgradeDefs.find((x) => x.id === id);
        if (!ru)
            return false;
        return (ru.requires ?? []).every((req) => this.player.researchUpgrades.has(req));
    }
    /** Buy a research-tree node with Forschungspunkten. */
    buyResearch(id) {
        if (this.player.researchUpgrades.has(id))
            return false;
        const ru = this.researchUpgradeDefs.find((x) => x.id === id);
        if (!ru || !this.isResearchAvailable(id))
            return false;
        if (!this.company.research.spend(ru.cost))
            return false;
        this.player.researchUpgrades.add(id);
        this.recalculate();
        this.bus.emit('research:bought', { id });
        return true;
    }
    setActiveWorld(id) {
        const w = this.getWorld(id);
        if (!w || !w.unlocked)
            return false;
        this.activeWorldId = id;
        this.bus.emit('world:changed', { world: w });
        return true;
    }
    // === Prestige ===========================================================
    canPrestige() { return this.player.computePrestigeGain() >= 1; }
    getStartingCapital() {
        let cap = 0;
        for (const pu of this.prestigeUpgradeDefs) {
            if (pu.start && this.player.prestigeUpgrades.has(pu.id))
                cap += pu.start;
        }
        return cap;
    }
    getOfflineConfig() {
        let efficiency = 0.5;
        let cap = 8 * 3600; // 8 hours default
        for (const pu of this.prestigeUpgradeDefs) {
            if (pu.offline && this.player.prestigeUpgrades.has(pu.id)) {
                efficiency = Math.max(efficiency, pu.offline.efficiency);
                cap = Math.max(cap, pu.offline.cap);
            }
        }
        return { efficiency, cap };
    }
    prestige() {
        const gain = this.player.computePrestigeGain();
        if (gain < 1)
            return false;
        this.player.prestigePoints += gain;
        this.player.prestigeLevel += 1;
        this.player.runEarned = 0;
        this.company.resetForPrestige();
        for (const w of this.worlds)
            for (const a of w.assets)
                a.count = 0;
        for (const u of this.upgrades) {
            u.purchased = false;
            u.unlocked = false;
        }
        this.company.money.amount = this.getStartingCapital();
        this.goldenDeal.reset();
        this.clickFrenzy = { mult: 1, until: 0 };
        this.recalculate();
        this.bus.emit('prestige:done', { gain });
        this.checkProgress();
        return true;
    }
    // === Progress checks ====================================================
    /** Re-evaluate world unlocks, achievements and quests; recalc if changed. */
    checkProgress() {
        let dirty = false;
        for (const w of this.worlds) {
            if (w.checkUnlock(this)) {
                dirty = true;
                this.bus.emit('world:unlocked', { world: w });
            }
        }
        for (const a of this.achievements) {
            if (a.check(this)) {
                dirty = true;
                this.bus.emit('achievement:unlocked', { achievement: a });
            }
        }
        for (const q of this.quests) {
            if (q.checkComplete(this))
                this.bus.emit('quest:complete', { quest: q });
        }
        if (dirty)
            this.recalculate();
    }
    /** Apply the reward of an active Golden Deal. Returns a UI descriptor. */
    clickGolden(id) {
        const deal = this.goldenDeal.claim(id);
        if (!deal)
            return null;
        this.player.goldenClicks += 1;
        let result;
        switch (deal.type) {
            case 'frenzy':
                this.eventManager.addEvent({ id: 'golden-frenzy', name: '💎 Kaufrausch ×3', multiplier: 3, duration: 30, source: 'golden' });
                result = { type: deal.type, title: '💎 Kaufrausch!', text: '×3 auf alle Einnahmen für 30 s' };
                break;
            case 'clickFrenzy':
                this.clickFrenzy = { mult: 25, until: Date.now() + 15_000 };
                this.computeDerived();
                result = { type: deal.type, title: '💎 Klick-Rausch!', text: 'Klickwert ×25 für 15 s' };
                break;
            case 'lucky':
            default: {
                // Stark gedrosselt: ~30 s Einkommen (statt 15 min) und kein %-Anteil am
                // Kapital mehr (verhinderte den Geld-Runaway). Klick-Variante als Floor.
                const gain = Math.max(this._perSecond * 30, this._clickValue * 40);
                this.company.money.add(gain);
                this.player.runEarned += gain;
                this.player.lifetimeEarned += gain;
                result = { type: 'lucky', title: '💎 Glückstreffer!', text: '+' + gain, amount: gain };
                break;
            }
        }
        this.bus.emit('golden:reward', result);
        this.bus.emit('money:changed');
        this.checkProgress();
        return result;
    }
    /** Claim a completed quest's reward. */
    claimQuest(id) {
        const q = this.quests.find((x) => x.id === id);
        if (!q || !q.completed || q.claimed)
            return false;
        q.claimed = true;
        const r = q.reward;
        if (r.money) {
            const gain = Math.max(r.money, this._perSecond * r.money);
            this.company.money.add(gain);
            this.player.runEarned += gain;
            this.player.lifetimeEarned += gain;
        }
        if (r.influence)
            this.player.prestigePoints += r.influence;
        this.recalculate();
        this.bus.emit('quest:claimed', { quest: q });
        this.bus.emit('money:changed');
        this.checkProgress();
        return true;
    }
    // === Daily reward =======================================================
    DAILY_COOLDOWN = 20 * 3600 * 1000; // 20 h bis zur nächsten Belohnung
    DAILY_STREAK_WINDOW = 48 * 3600 * 1000; // innerhalb 48 h läuft der Streak weiter
    canClaimDaily() {
        return Date.now() - this.player.lastDailyClaim >= this.DAILY_COOLDOWN;
    }
    /** Sekunden bis zum nächsten Tagesbonus (0 = jetzt verfügbar). */
    secondsUntilDaily() {
        return Math.max(0, Math.ceil((this.player.lastDailyClaim + this.DAILY_COOLDOWN - Date.now()) / 1000));
    }
    claimDaily() {
        if (!this.canClaimDaily())
            return null;
        const continues = Date.now() - this.player.lastDailyClaim <= this.DAILY_STREAK_WINDOW;
        this.player.dailyStreak = continues ? this.player.dailyStreak + 1 : 1;
        this.player.lastDailyClaim = Date.now();
        const influence = Math.min(5, Math.max(1, Math.floor(this.player.dailyStreak / 3)));
        const money = Math.max(this._perSecond * 1800, 1000); // ~30 min Einnahmen, min. €1000
        this.player.prestigePoints += influence;
        this.company.money.add(money);
        this.player.runEarned += money;
        this.player.lifetimeEarned += money;
        this.recalculate();
        const reward = { streak: this.player.dailyStreak, influence, money };
        this.bus.emit('daily:claimed', reward);
        this.checkProgress();
        return reward;
    }
    // === Loop ===============================================================
    tick(dt) {
        this.eventManager.update(dt);
        this.goldenDeal.update(dt);
        this.computeDerived();
        const income = this._perSecond * dt;
        if (income > 0) {
            this.company.money.add(income);
            this.player.runEarned += income;
            this.player.lifetimeEarned += income;
        }
        const rp = this._researchPerSecond * dt;
        if (rp > 0)
            this.company.research.add(rp);
        this.company.money.perSecond = this._perSecond;
        this.player.playtimeSeconds += dt;
        this.checkProgress();
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        this.lastFrame = performance.now();
        const loop = (now) => {
            if (!this.running)
                return;
            let dt = (now - this.lastFrame) / 1000;
            this.lastFrame = now;
            if (dt > 1)
                dt = 1; // clamp tab-switch gaps; offline handled on load
            if (dt > 0)
                this.tick(dt);
            this.bus.emit('tick', { dt });
            this.rafId = requestAnimationFrame(loop);
        };
        this.rafId = requestAnimationFrame(loop);
    }
    stop() {
        this.running = false;
        if (this.rafId !== undefined)
            cancelAnimationFrame(this.rafId);
    }
    // === Offline progress ===================================================
    applyOfflineProgress(seconds) {
        if (seconds <= 0)
            return null;
        const { efficiency, cap } = this.getOfflineConfig();
        const effective = Math.min(seconds, cap);
        this.computeDerived();
        const earned = this._perSecond * effective * efficiency;
        if (earned > 0) {
            this.company.money.add(earned);
            this.player.runEarned += earned;
            this.player.lifetimeEarned += earned;
        }
        return { earned, seconds: effective, requested: seconds, capped: seconds > cap };
    }
    // === Persistence ========================================================
    serialize() {
        return {
            activeWorldId: this.activeWorldId,
            settings: this.settings,
            player: this.player.toJSON(),
            company: this.company.toJSON(),
            worlds: this.worlds.map((w) => w.toJSON()),
            upgrades: this.upgrades.map((u) => u.toJSON()),
            achievements: this.achievements.map((a) => a.toJSON()),
            quests: this.quests.map((q) => q.toJSON()),
            events: this.eventManager.toJSON(),
        };
    }
    applySave(data) {
        if (!data)
            return;
        this.player.loadJSON(data.player);
        this.company.loadJSON(data.company);
        for (const wd of data.worlds ?? [])
            this.getWorld(wd.id)?.loadJSON(wd);
        const upMap = new Map(this.upgrades.map((u) => [u.id, u]));
        for (const ud of data.upgrades ?? [])
            upMap.get(ud.id)?.loadJSON(ud);
        const acMap = new Map(this.achievements.map((a) => [a.id, a]));
        for (const ad of data.achievements ?? [])
            acMap.get(ad.id)?.loadJSON(ad);
        const qMap = new Map(this.quests.map((q) => [q.id, q]));
        for (const qd of data.quests ?? [])
            qMap.get(qd.id)?.loadJSON(qd);
        this.eventManager.loadJSON(data.events);
        if (data.settings)
            this.settings = { ...this.settings, ...data.settings };
        if (data.activeWorldId && this.getWorld(data.activeWorldId)?.unlocked) {
            this.activeWorldId = data.activeWorldId;
        }
        this.recalculate();
    }
    /** Convenience: serialise + persist to localStorage. */
    save() {
        return this.saveSystem.save(this.serialize());
    }
}
//# sourceMappingURL=Game.js.map