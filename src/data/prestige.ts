/**
 * Prestige ("Börsengang" / IPO) upgrade tree. Bought with Einfluss-Punkten,
 * these persist through every reset and provide the long-term progression.
 *
 * `effects` reuse the same declarative shapes as normal Upgrades. Two extra
 * fields are read directly by the Game:
 *   start:   one-off starting capital granted after each prestige
 *   offline: { efficiency, cap } overrides for offline earnings
 */
import type { PrestigeUpgradeDef } from '../types.js';

export const PRESTIGE_UPGRADES: PrestigeUpgradeDef[] = [
  { id: 'pp-founder', name: 'Erfahrener Gründer', icon: '🎓', cost: 1,
    description: '+50 % auf alle Einnahmen.', effects: [{ type: 'global', multiplier: 1.5 }] },
  { id: 'pp-capital', name: 'Startkapital', icon: '💎', cost: 2,
    description: 'Beginne jeden Neustart mit €1 Mio. Startkapital.', start: 1e6 },
  { id: 'pp-network', name: 'Beziehungsnetzwerk', icon: '🤝', cost: 3,
    description: 'Verdoppelt alle Einnahmen.', effects: [{ type: 'global', multiplier: 2 }] },
  { id: 'pp-touch', name: 'Goldener Touch', icon: '✨', cost: 5,
    description: 'Klickwert ×5.', effects: [{ type: 'click', multiplier: 5 }] },
  { id: 'pp-passive', name: 'Passives Imperium', icon: '🏝️', cost: 8,
    description: 'Offline-Einnahmen: volle Effizienz und bis zu 24 Stunden.',
    offline: { efficiency: 1.0, cap: 24 * 3600 } },
  { id: 'pp-board', name: 'KI-Vorstand', icon: '🧠', cost: 13,
    description: '+10 automatische Klicks pro Sekunde.', effects: [{ type: 'autoclick', amount: 10 }] },
  { id: 'pp-magnate', name: 'Wirtschaftsmagnat', icon: '👑', cost: 25,
    description: '×3 auf alle Einnahmen.', effects: [{ type: 'global', multiplier: 3 }] },
  { id: 'pp-dynasty', name: 'Wirtschaftsdynastie', icon: '🏛️', cost: 50,
    description: '×5 auf alle Einnahmen.', effects: [{ type: 'global', multiplier: 5 }] },
];
