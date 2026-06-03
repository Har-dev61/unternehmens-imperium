/**
 * A spendable resource (e.g. Geld/Kapital, Forschung, Einfluss).
 * Tracks the current amount, the lifetime total earned, and a cached
 * production rate (per second) for display.
 */
export interface ResourceConfig {
  id: string;
  name: string;
  icon?: string;
  amount?: number;
}

export interface ResourceData {
  amount: number;
  totalEarned: number;
}

export class Resource {
  id: string;
  name: string;
  icon: string;
  amount: number;
  /** Lifetime total ever earned of this resource (never decreases). */
  totalEarned: number;
  /** Cached production rate, set by the Game each tick. */
  perSecond = 0;

  constructor({ id, name, icon = '', amount = 0 }: ResourceConfig) {
    this.id = id;
    this.name = name;
    this.icon = icon;
    this.amount = amount;
    this.totalEarned = amount;
  }

  /** Add an amount (counts towards totalEarned when positive). */
  add(value: number): void {
    this.amount += value;
    if (value > 0) this.totalEarned += value;
  }

  /** Spend an amount if affordable. Returns true on success. */
  spend(value: number): boolean {
    if (this.amount < value) return false;
    this.amount -= value;
    return true;
  }

  canAfford(value: number): boolean {
    return this.amount >= value;
  }

  toJSON(): ResourceData {
    return { amount: this.amount, totalEarned: this.totalEarned };
  }

  loadJSON(data?: ResourceData | null): void {
    if (!data) return;
    this.amount = data.amount ?? 0;
    this.totalEarned = data.totalEarned ?? this.amount;
  }
}
