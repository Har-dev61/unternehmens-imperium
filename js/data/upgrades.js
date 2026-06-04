/**
 * Upgrade catalogue. Returns plain configs consumed by Game (which wraps each
 * in an Upgrade instance). Effects are declarative — see Upgrade.ts for the
 * supported shapes and Game.recalculate() for how they're applied.
 */
import { WORLD_DEFS } from './worlds.js';
// --- Unlock predicate helpers ---------------------------------------------
const earned = (n) => (game) => game.player.lifetimeEarned >= n;
const clicks = (n) => (game) => game.player.totalClicks >= n;
const owns = (assetId, n) => (game) => (game.getAsset(assetId)?.count ?? 0) >= n;
// --- Per-asset production multipliers (auto-generated) --------------------
const ASSET_TIERS = [
    { threshold: 15, costFactor: 25, label: 'Optimierung' },
    { threshold: 40, costFactor: 400, label: 'Spezialisierung' },
    { threshold: 90, costFactor: 12_000, label: 'Skalierung' },
    { threshold: 175, costFactor: 400_000, label: 'Perfektion' },
    { threshold: 300, costFactor: 12_000_000, label: 'Meisterschaft' },
];
function generateAssetUpgrades() {
    const list = [];
    for (const world of WORLD_DEFS) {
        for (const asset of world.assets ?? []) {
            ASSET_TIERS.forEach((tier, ti) => {
                list.push({
                    id: `au-${asset.id}-${ti}`,
                    name: `${asset.name}: ${tier.label}`,
                    description: `Verdoppelt die Produktion deiner ${asset.name}.`,
                    icon: asset.icon,
                    category: asset.type === 'employee' ? 'employee' : 'production',
                    cost: Math.ceil(asset.baseCost * tier.costFactor),
                    world: world.id,
                    effects: [{ type: 'asset', target: asset.id, multiplier: 2 }],
                    unlock: owns(asset.id, tier.threshold),
                });
            });
        }
    }
    return list;
}
// --- Per-world "market leadership" multipliers (auto-generated) -----------
function generateWorldUpgrades() {
    const list = [];
    WORLD_DEFS.forEach((w) => {
        const assets = w.assets ?? [];
        const topCost = assets[assets.length - 1].baseCost;
        [
            { n: 80, mult: 2, label: 'Marktführerschaft' },
            { n: 250, mult: 2, label: 'Marktbeherrschung' },
        ].forEach((tier, i) => {
            list.push({
                id: `wu-${w.id}-${i}`,
                name: `${w.name}: ${tier.label}`,
                description: `Verdoppelt alle Einnahmen aus „${w.name}“.`,
                icon: w.icon,
                category: 'world',
                world: w.id,
                cost: Math.ceil(topCost * (i === 0 ? 15 : 600)),
                effects: [{ type: 'world', target: w.id, multiplier: tier.mult }],
                unlock: (game) => {
                    const world = game.getWorld(w.id);
                    return !!world && world.unlocked && world.getTotalAssetCount() >= tier.n;
                },
            });
        });
    });
    return list;
}
// --- Hand-authored upgrades ------------------------------------------------
const CLICK_UPGRADES = [
    { id: 'click-1', name: 'Bessere Maus', icon: '🖱️', category: 'click', cost: 250,
        description: 'Verdoppelt den Wert pro Klick.', effects: [{ type: 'click', multiplier: 2 }], unlock: () => true },
    { id: 'click-2', name: 'Ergonomischer Stuhl', icon: '🪑', category: 'click', cost: 6_000,
        description: 'Verdoppelt den Wert pro Klick.', effects: [{ type: 'click', multiplier: 2 }], unlock: clicks(50) },
    { id: 'click-3', name: 'Doppelmonitor-Setup', icon: '🖥️', category: 'click', cost: 150_000,
        description: 'Verdoppelt den Wert pro Klick.', effects: [{ type: 'click', multiplier: 2 }], unlock: clicks(200) },
    { id: 'click-4', name: 'Energy-Drink-Flatrate', icon: '🥤', category: 'click', cost: 4_000_000,
        description: 'Verdreifacht den Wert pro Klick.', effects: [{ type: 'click', multiplier: 3 }], unlock: clicks(1_000) },
    { id: 'click-5', name: 'Tastatur-Makros', icon: '⌨️', category: 'click', cost: 200_000_000,
        description: 'Verdreifacht den Wert pro Klick.', effects: [{ type: 'click', multiplier: 3 }], unlock: clicks(5_000) },
];
const MARKETING_UPGRADES = [
    { id: 'mkt-1', name: 'Flyer & Plakate', icon: '📄', category: 'marketing', cost: 15_000,
        description: '+10 % auf alle Einnahmen.', effects: [{ type: 'global', multiplier: 1.1 }], unlock: earned(5e4) },
    { id: 'mkt-2', name: 'Lokale Radiowerbung', icon: '📻', category: 'marketing', cost: 300_000,
        description: '+15 % auf alle Einnahmen.', effects: [{ type: 'global', multiplier: 1.15 }], unlock: earned(1e6) },
    { id: 'mkt-3', name: 'TV-Kampagne', icon: '📺', category: 'marketing', cost: 15_000_000,
        description: '+20 % auf alle Einnahmen.', effects: [{ type: 'global', multiplier: 1.2 }], unlock: earned(5e7) },
    { id: 'mkt-4', name: 'Influencer-Deals', icon: '🤳', category: 'marketing', cost: 1_500_000_000,
        description: '+25 % auf alle Einnahmen.', effects: [{ type: 'global', multiplier: 1.25 }], unlock: earned(1e10) },
    { id: 'mkt-5', name: 'Viraler Mega-Hit', icon: '🔥', category: 'marketing', cost: 2_000_000_000_000,
        description: '+50 % auf alle Einnahmen.', effects: [{ type: 'global', multiplier: 1.5 }], unlock: earned(2e13) },
];
const RESEARCH_UPGRADES = [
    { id: 'res-1', name: 'Prozessoptimierung', icon: '⚙️', category: 'research', cost: 600_000,
        description: '+50 % Einnahmen aus Gebäuden.', effects: [{ type: 'assetClass', target: 'building', multiplier: 1.5 }], unlock: earned(2e6) },
    { id: 'res-2', name: 'Personalentwicklung', icon: '📚', category: 'research', cost: 600_000,
        description: '+50 % Einnahmen aus Mitarbeitern.', effects: [{ type: 'assetClass', target: 'employee', multiplier: 1.5 }], unlock: earned(2e6) },
    { id: 'res-3', name: 'Patentportfolio', icon: '📜', category: 'research', cost: 300_000_000,
        description: '+30 % auf alle Einnahmen.', effects: [{ type: 'global', multiplier: 1.3 }], unlock: earned(2e9) },
    { id: 'res-4', name: 'Robotik & Automation', icon: '🦾', category: 'research', cost: 30_000_000_000,
        description: 'Verdoppelt die Einnahmen aus Gebäuden.', effects: [{ type: 'assetClass', target: 'building', multiplier: 2 }], unlock: earned(5e10) },
    { id: 'res-5', name: 'Künstliche Intelligenz', icon: '🧠', category: 'research', cost: 30_000_000_000_000,
        description: '+50 % auf alle Einnahmen.', effects: [{ type: 'global', multiplier: 1.5 }], unlock: earned(5e13) },
];
const AUTOMATION_UPGRADES = [
    { id: 'auto-1', name: 'Auto-Klicker v1', icon: '🤖', category: 'automation', cost: 25_000,
        description: 'Klickt automatisch 1×/Sekunde für dich.', effects: [{ type: 'autoclick', amount: 1 }], unlock: clicks(100) },
    { id: 'auto-2', name: 'Makro-Bot', icon: '⚙️', category: 'automation', cost: 1_500_000,
        description: '+2 automatische Klicks/Sekunde.', effects: [{ type: 'autoclick', amount: 2 }], unlock: clicks(500) },
    { id: 'auto-3', name: 'RPA-Software', icon: '🦾', category: 'automation', cost: 200_000_000,
        description: '+4 automatische Klicks/Sekunde.', effects: [{ type: 'autoclick', amount: 4 }], unlock: earned(5e8) },
    { id: 'auto-4', name: 'Autonome Agenten', icon: '🛰️', category: 'automation', cost: 200_000_000_000,
        description: '+8 automatische Klicks/Sekunde.', effects: [{ type: 'autoclick', amount: 8 }], unlock: earned(5e11) },
];
const SPECIAL_UPGRADES = [
    { id: 'sp-ceo', name: 'Charismatischer CEO', icon: '🦸', category: 'special', rare: true, cost: 30_000_000,
        description: 'Klickwert ×5 und jeder Klick bringt +0,5 % des €/s.',
        effects: [{ type: 'click', multiplier: 5 }, { type: 'clickPercent', percent: 0.005 }], unlock: clicks(2_000) },
    { id: 'sp-monopol', name: 'Marktmonopol', icon: '👑', category: 'special', rare: true, cost: 3_000_000_000,
        description: 'Verdoppelt ALLE Einnahmen.', effects: [{ type: 'global', multiplier: 2 }], unlock: earned(2e9) },
    { id: 'sp-ki', name: 'Geheime Super-KI', icon: '🛸', category: 'special', rare: true, cost: 30_000_000_000_000,
        description: '×3 auf alle Einnahmen.', effects: [{ type: 'global', multiplier: 3 }], unlock: earned(5e13) },
    { id: 'sp-lobby', name: 'Politische Lobby', icon: '🎩', category: 'special', rare: true, cost: 3e16,
        description: '×3 auf alle Einnahmen.', effects: [{ type: 'global', multiplier: 3 }], unlock: earned(5e16) },
    { id: 'sp-singularity', name: 'Wirtschaftssingularität', icon: '🌌', category: 'special', rare: true, cost: 3e20,
        description: '×4 auf alle Einnahmen — die Zahlen brechen.', effects: [{ type: 'global', multiplier: 4 }], unlock: earned(1e20) },
];
/** The full catalogue, assembled once. */
export const UPGRADE_DEFS = [
    ...CLICK_UPGRADES,
    ...AUTOMATION_UPGRADES,
    ...MARKETING_UPGRADES,
    ...RESEARCH_UPGRADES,
    ...SPECIAL_UPGRADES,
    ...generateWorldUpgrades(),
    ...generateAssetUpgrades(),
];
/** Human-readable category labels for the shop UI. */
export const UPGRADE_CATEGORIES = {
    click: '🖱️ Klick',
    automation: '🤖 Automatisierung',
    employee: '👥 Mitarbeiter',
    production: '🏭 Produktion',
    marketing: '📣 Marketing',
    research: '🔬 Forschung',
    world: '🌍 Welt',
    special: '✨ Spezial',
};
//# sourceMappingURL=upgrades.js.map