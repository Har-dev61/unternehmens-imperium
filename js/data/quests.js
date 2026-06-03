export const QUEST_DEFS = [
    {
        id: 'q-hire', name: 'Erste Belegschaft', icon: '👥',
        description: 'Stelle 10 Mitarbeiter ein.', unit: 'Mitarbeiter', goal: 10,
        progress: (g) => g.getEmployeeCount(), reward: { money: 120 },
    },
    {
        id: 'q-build', name: 'Erste Standorte', icon: '🏗️',
        description: 'Besitze 10 Gebäude.', unit: 'Gebäude', goal: 10,
        progress: (g) => g.getBuildingCount(), reward: { money: 180 },
    },
    {
        id: 'q-click', name: 'Ärmel hochkrempeln', icon: '👆',
        description: 'Klicke 250-mal.', unit: 'Klicks', goal: 250,
        progress: (g) => g.player.totalClicks, reward: { money: 120, globalMult: 1.02 },
    },
    {
        id: 'q-upgrades', name: 'Modernisierung', icon: '⬆️',
        description: 'Kaufe 10 Upgrades.', unit: 'Upgrades', goal: 10,
        progress: (g) => g.getPurchasedUpgradeCount(), reward: { globalMult: 1.05 },
    },
    {
        id: 'q-mps', name: 'Laufendes Geschäft', icon: '📈',
        description: 'Erreiche €10.000 pro Sekunde.', unit: '€/s', goal: 1e4,
        progress: (g) => g.getPerSecond(), reward: { money: 300, globalMult: 1.05 },
    },
    {
        id: 'q-worlds', name: 'Expansion', icon: '🌍',
        description: 'Erschließe 3 Welten.', unit: 'Welten', goal: 3,
        progress: (g) => g.getUnlockedWorldCount(), reward: { influence: 2 },
    },
    {
        id: 'q-golden', name: 'Schnäppchenjäger', icon: '💎',
        description: 'Sammle 3 Goldene Deals ein.', unit: 'Deals', goal: 3,
        progress: (g) => g.player.goldenClicks, reward: { globalMult: 1.1 },
    },
    {
        id: 'q-prestige', name: 'An die Börse', icon: '📊',
        description: 'Gehe einmal an die Börse (Prestige).', unit: 'Börsengänge', goal: 1,
        progress: (g) => g.player.prestigeLevel, reward: { influence: 5 },
    },
    {
        id: 'q-assets', name: 'Konglomerat', icon: '🏢',
        description: 'Besitze 500 Assets insgesamt.', unit: 'Assets', goal: 500,
        progress: (g) => g.getTotalAssetCount(), reward: { globalMult: 1.15 },
    },
];
//# sourceMappingURL=quests.js.map