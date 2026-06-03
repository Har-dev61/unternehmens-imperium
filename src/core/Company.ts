import { Resource } from './Resource.js';
import type { ResourceData } from './Resource.js';

export interface CompanyData {
  name: string;
  money: ResourceData;
  research?: ResourceData;
}

/**
 * The player's economic entity. Holds the capital (money) and the multipliers
 * that upgrades and achievements feed into. The final per-click / per-second
 * formulas live in Game.recalculate(), which writes the computed multipliers
 * back onto this object.
 */
export class Company {
  name: string;
  money: Resource;
  /** Forschungspunkte — bleiben über Prestige erhalten. */
  research: Resource;

  // --- Values recomputed every recalculate() ---
  clickBaseValue = 1;
  clickMultiplier = 1;
  clickPercentOfProduction = 0;
  globalMultiplier = 1;
  autoClicksPerSecond = 0;
  /** Multiplikator auf die Forschungsrate (aus dem Forschungsbaum). */
  researchRateMult = 1;

  constructor(name = 'Mein Startup') {
    this.name = name;
    this.money = new Resource({ id: 'money', name: 'Kapital', icon: '💰' });
    this.research = new Resource({ id: 'research', name: 'Forschung', icon: '🔬' });
  }

  /** Reset economic state for a prestige. Keeps name + research (Meta-Progression). */
  resetForPrestige(): void {
    this.money = new Resource({ id: 'money', name: 'Kapital', icon: '💰' });
    this.clickBaseValue = 1;
    this.clickMultiplier = 1;
    this.clickPercentOfProduction = 0;
    this.globalMultiplier = 1;
    this.autoClicksPerSecond = 0;
    // research bleibt absichtlich erhalten
  }

  toJSON(): CompanyData {
    return { name: this.name, money: this.money.toJSON(), research: this.research.toJSON() };
  }

  loadJSON(data?: Partial<CompanyData> | null): void {
    if (!data) return;
    this.name = data.name ?? this.name;
    this.money.loadJSON(data.money);
    this.research.loadJSON(data.research);
  }
}
