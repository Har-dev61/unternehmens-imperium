/**
 * Shared type definitions for the game's data model and configuration.
 * Type-only — erased at compile time, so the type-level dependency on Game
 * (for predicate signatures) introduces no runtime import cycle.
 */
import type { Game } from './core/Game.js';

export type AssetType = 'employee' | 'building';

export interface AssetConfig {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  type?: AssetType | 'asset';
  baseCost: number;
  baseProduction: number;
  costMultiplier?: number;
}

/** Declarative upgrade effect; a discriminated union over `type`. */
export type Effect =
  | { type: 'click'; multiplier: number }
  | { type: 'clickPercent'; percent: number }
  | { type: 'global'; multiplier: number }
  | { type: 'autoclick'; amount: number }
  | { type: 'asset'; target: string; multiplier: number }
  | { type: 'assetClass'; target: AssetType; multiplier: number }
  | { type: 'world'; target: string; multiplier: number }
  | { type: 'researchRate'; multiplier: number };

/** A node in the research tech-tree (bought with Forschungspunkten). */
export interface ResearchUpgradeConfig {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  cost: number;            // in Forschungspunkten
  requires?: string[];     // ids that must be researched first (tech-tree)
  effects?: Effect[];
}

export type UpgradeCategory =
  | 'click' | 'automation' | 'employee' | 'production'
  | 'marketing' | 'research' | 'world' | 'special';

export interface UpgradeConfig {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  category?: UpgradeCategory;
  cost: number;
  effects?: Effect[];
  world?: string | null;
  rare?: boolean;
  unlock?: (game: Game) => boolean;
}

export interface WorldConfig {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  theme?: string;
  productionMultiplier?: number;
  startUnlocked?: boolean;
  unlock?: (game: Game) => boolean;
  unlockHint?: string;
  unlockAt?: number | null;
  assets?: AssetConfig[];
}

export interface AchievementConfig {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  bonus?: number;
  condition?: (game: Game) => boolean;
}

export interface QuestReward {
  money?: number;
  influence?: number;
  globalMult?: number;
}

export interface QuestConfig {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  goal: number;
  unit?: string;
  reward?: QuestReward;
  progress: (game: Game) => number;
}

export interface PrestigeUpgradeDef {
  id: string;
  name: string;
  icon?: string;
  cost: number;
  description?: string;
  effects?: Effect[];
  start?: number;
  offline?: { efficiency: number; cap: number };
}

export type NewsType = 'update' | 'upcoming' | 'fix' | 'event' | 'info';

/** A single entry in the news / changelog center (see data/news.ts). */
export interface NewsEntry {
  id: string;          // stable, unique id — used to track what the player has seen
  date: string;        // 'YYYY-MM-DD' announcement date; drives ordering & display
  type: NewsType;      // controls the icon/accent and which section it lands in
  title: string;       // short headline
  tag?: string;        // small label, e.g. 'v1.1' or 'Server'
  eta?: string;        // for 'upcoming': human-readable timing, e.g. 'geplant für Q3'
  items: string[];     // bullet points (plain text)
}

export type BuyQuantity = '1' | '10' | '100' | 'max';

export interface GameSettings {
  muted: boolean;
  autosave: boolean;
  buyQuantity: BuyQuantity;
}

export interface OnlineSession {
  mode: 'offline' | 'guest' | 'account';
  username: string | null;
  email?: string | null;
  emailVerified?: boolean;
  /** True only for the server-defined dev account (drives the hidden dev menu). */
  isDev?: boolean;
  lastSync: number;
}

export interface ActiveEvent {
  id: string;
  /** Stable source id used to de-duplicate repeated server broadcasts. */
  baseId: string;
  name: string;
  multiplier: number;
  source: string;
  expiresAt: number;
}

export interface LeaderboardEntry {
  rank?: number;
  name: string;
  valuation: number;
  prestige: number;
  isPlayer: boolean;
}

/** The full serialised game state persisted to storage / cloud. */
export interface SaveState {
  version?: number;
  savedAt?: number;
  activeWorldId?: string;
  settings?: Partial<GameSettings>;
  player?: any;
  company?: any;
  worlds?: any[];
  upgrades?: any[];
  achievements?: any[];
  quests?: any[];
  events?: any;
}
