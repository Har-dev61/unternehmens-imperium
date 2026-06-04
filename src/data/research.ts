/**
 * Forschungsbaum — wird mit Forschungspunkten (RP) gekauft. Knoten können
 * Voraussetzungen (`requires`) haben und bilden so einen kleinen Tech-Tree.
 * Forschung bleibt über Prestige erhalten (dauerhafte Meta-Progression).
 * Effekte nutzen dieselbe Effect-Union wie normale Upgrades.
 */
import type { ResearchUpgradeConfig } from '../types.js';

export const RESEARCH_DEFS: ResearchUpgradeConfig[] = [
  { id: 'r-basics', name: 'Grundlagenforschung', icon: '🔬', cost: 40,
    description: '+25 % auf alle Einnahmen.', effects: [{ type: 'global', multiplier: 1.25 }] },

  { id: 'r-automation', name: 'Automatisierungslehre', icon: '⚙️', cost: 120, requires: ['r-basics'],
    description: '+2 automatische Klicks/Sekunde.', effects: [{ type: 'autoclick', amount: 2 }] },
  { id: 'r-materials', name: 'Materialwissenschaft', icon: '🧱', cost: 120, requires: ['r-basics'],
    description: '+50 % Einnahmen aus Gebäuden.', effects: [{ type: 'assetClass', target: 'building', multiplier: 1.5 }] },
  { id: 'r-hr', name: 'Arbeitspsychologie', icon: '🧑‍🏫', cost: 120, requires: ['r-basics'],
    description: '+50 % Einnahmen aus Mitarbeitern.', effects: [{ type: 'assetClass', target: 'employee', multiplier: 1.5 }] },

  { id: 'r-data', name: 'Datenanalyse', icon: '📊', cost: 400, requires: ['r-materials', 'r-hr'],
    description: '+50 % auf alle Einnahmen.', effects: [{ type: 'global', multiplier: 1.5 }] },
  { id: 'r-robotics', name: 'Robotik', icon: '🦾', cost: 1000, requires: ['r-automation'],
    description: 'Gebäude ×2 und +4 automatische Klicks/Sekunde.',
    effects: [{ type: 'assetClass', target: 'building', multiplier: 2 }, { type: 'autoclick', amount: 4 }] },

  { id: 'r-ml', name: 'Maschinelles Lernen', icon: '🧠', cost: 2500, requires: ['r-data'],
    description: 'Einnahmen ×2 und Forschungsrate ×2.',
    effects: [{ type: 'global', multiplier: 2 }, { type: 'researchRate', multiplier: 2 }] },
  { id: 'r-fusion', name: 'Fusionsenergie', icon: '⚛️', cost: 6000, requires: ['r-robotics', 'r-ml'],
    description: '×2 auf alle Einnahmen.', effects: [{ type: 'global', multiplier: 2 }] },
  { id: 'r-singularity', name: 'Selbstverbessernde KI', icon: '🌌', cost: 20000, requires: ['r-fusion'],
    description: '×3 Einnahmen und Forschungsrate ×3.',
    effects: [{ type: 'global', multiplier: 3 }, { type: 'researchRate', multiplier: 3 }] },
];
