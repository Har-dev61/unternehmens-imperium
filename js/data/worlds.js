const LADDER = [
    { cost: 15, prod: 0.1 },
    { cost: 100, prod: 1 },
    { cost: 1_100, prod: 8 },
    { cost: 12_000, prod: 47 },
    { cost: 130_000, prod: 260 },
    { cost: 1_400_000, prod: 1_400 },
    { cost: 20_000_000, prod: 7_800 },
];
/**
 * Balancing knob: global production scale. Costs stay put, output is cut, so
 * every asset's payback time lengthens — a clean, uniform income reduction.
 */
const PROD_SCALE = 0.10;
function buildAssets(worldId, scale, defs) {
    return defs.map((d, i) => ({
        id: `${worldId}-${i}`,
        name: d.name,
        icon: d.icon,
        type: d.type,
        description: d.desc,
        baseCost: LADDER[i].cost * scale,
        baseProduction: LADDER[i].prod * scale * PROD_SCALE,
    }));
}
/** Convenience for unlock predicates. */
const earned = (n) => (game) => game.player.lifetimeEarned >= n;
/**
 * Long-term gate: the later worlds need lifetime earnings AND a minimum number
 * of Börsengänge (prestige levels). Since Einfluss accrues slowly, this forces
 * the prestige/reset meta-loop — the back half of the game unfolds over days
 * and weeks of repeated runs, not a single sitting.
 */
const gate = (n, prestigeLevel) => (game) => game.player.lifetimeEarned >= n && game.player.prestigeLevel >= prestigeLevel;
export const WORLD_DEFS = [
    {
        id: 'local',
        name: 'Lokaler Markt',
        icon: '🏠',
        theme: 'local',
        description: 'Wo jedes Imperium beginnt: dein erstes Ein-Personen-Startup.',
        startUnlocked: true,
        assets: buildAssets('local', 1, [
            { name: 'Praktikant', icon: '🧑‍🎓', type: 'employee', desc: 'Motiviert, unterbezahlt, unermüdlich.' },
            { name: 'Freelancer', icon: '🧑‍💻', type: 'employee', desc: 'Arbeitet auf Rechnung, liefert ab.' },
            { name: 'Heimbüro', icon: '🏠', type: 'building', desc: 'Der Küchentisch als Konzernzentrale.' },
            { name: 'Kleines Team', icon: '👥', type: 'employee', desc: 'Drei Leute, ein Traum.' },
            { name: 'Ladengeschäft', icon: '🏪', type: 'building', desc: 'Endlich eine echte Adresse.' },
            { name: 'Marketing-Abteilung', icon: '📣', type: 'building', desc: 'Macht aus Produkten Marken.' },
            { name: 'Lieferflotte', icon: '🚚', type: 'building', desc: 'Bringt die Ware zur Kundschaft.' },
        ]),
    },
    {
        id: 'national',
        name: 'Nationale Wirtschaft',
        icon: '🏙️',
        theme: 'national',
        description: 'Expandiere über die Stadtgrenzen hinaus auf den nationalen Markt.',
        unlock: earned(1e7),
        unlockAt: 1e7,
        unlockHint: 'Verdiene insgesamt €10 Mio.',
        assets: buildAssets('national', 1e3, [
            { name: 'Vertriebsmitarbeiter', icon: '🧑‍💼', type: 'employee', desc: 'Kennt jeden Einkäufer im Land.' },
            { name: 'Regionalbüro', icon: '🏢', type: 'building', desc: 'Präsenz in jeder Großstadt.' },
            { name: 'Filiale', icon: '🏬', type: 'building', desc: 'Eine Kette entsteht.' },
            { name: 'Großhandelslager', icon: '📦', type: 'building', desc: 'Paletten bis unter die Decke.' },
            { name: 'Werbeagentur', icon: '📺', type: 'building', desc: 'Prime-Time-Spots inklusive.' },
            { name: 'Produktionswerk', icon: '🏭', type: 'building', desc: 'Fertigung im großen Stil.' },
            { name: 'Logistikzentrum', icon: '🚛', type: 'building', desc: 'Das Herz der Lieferkette.' },
        ]),
    },
    {
        id: 'global',
        name: 'Globaler Markt',
        icon: '🌍',
        theme: 'global',
        description: 'Die ganze Welt wird zu deinem Absatzmarkt.',
        unlock: earned(1e11),
        unlockAt: 1e11,
        unlockHint: 'Verdiene insgesamt €100 Mrd.',
        assets: buildAssets('global', 1e6, [
            { name: 'Übersetzer-Team', icon: '🌐', type: 'employee', desc: 'Spricht alle Sprachen des Marktes.' },
            { name: 'Auslandsniederlassung', icon: '🏛️', type: 'building', desc: 'Flaggen auf jedem Kontinent.' },
            { name: 'Containerschiff', icon: '🚢', type: 'building', desc: 'Tausende TEU auf hoher See.' },
            { name: 'Übersee-Fabrik', icon: '🏭', type: 'building', desc: 'Produktion rund um die Uhr.' },
            { name: 'Globale Lieferkette', icon: '🔗', type: 'building', desc: 'Just-in-time über Zeitzonen.' },
            { name: 'Weltmarke', icon: '🏷️', type: 'building', desc: 'Jeder kennt dein Logo.' },
            { name: 'Handelsimperium', icon: '🌍', type: 'building', desc: 'Die Märkte tanzen nach deiner Pfeife.' },
        ]),
    },
    {
        id: 'tech',
        name: 'Tech-Welt',
        icon: '💻',
        theme: 'tech',
        description: 'Software frisst die Welt — und du servierst sie.',
        unlock: earned(1e15),
        unlockAt: 1e15,
        unlockHint: 'Verdiene insgesamt €1 Brd.',
        assets: buildAssets('tech', 1e9, [
            { name: 'Softwareentwickler', icon: '👨‍💻', type: 'employee', desc: 'Verwandelt Kaffee in Code.' },
            { name: 'Startup-Inkubator', icon: '🚀', type: 'building', desc: 'Brutkasten für die nächste Idee.' },
            { name: 'Server-Rack', icon: '🖥️', type: 'building', desc: 'Rechenleistung im Dauerbetrieb.' },
            { name: 'App-Plattform', icon: '📱', type: 'building', desc: 'Millionen Downloads pro Tag.' },
            { name: 'Rechenzentrum', icon: '🗄️', type: 'building', desc: 'Eine Cloud, die nie regnet.' },
            { name: 'KI-Labor', icon: '🤖', type: 'building', desc: 'Modelle, die für dich denken.' },
            { name: 'Quantencomputer', icon: '⚛️', type: 'building', desc: 'Rechnet, was niemand sonst kann.' },
        ]),
    },
    {
        id: 'finance',
        name: 'Finanzwelt',
        icon: '💹',
        theme: 'finance',
        description: 'Geld arbeitet jetzt für dich — Tag und Nacht an den Börsen.',
        unlock: gate(1e17, 1),
        unlockAt: 1e17,
        unlockHint: 'Verdiene €100 Brd. (10^17) und gehe 1× an die Börse (Prestige).',
        assets: buildAssets('finance', 1e12, [
            { name: 'Börsenhändler', icon: '📈', type: 'employee', desc: 'Kauft tief, verkauft hoch.' },
            { name: 'Investmentfonds', icon: '💹', type: 'building', desc: 'Diversifiziert in alles.' },
            { name: 'Privatbank', icon: '🏦', type: 'building', desc: 'Diskret und vermögend.' },
            { name: 'Hedgefonds', icon: '💸', type: 'building', desc: 'Wettet auf jede Richtung.' },
            { name: 'Krypto-Mine', icon: '⛏️', type: 'building', desc: 'Schürft digitale Werte.' },
            { name: 'Börsenparkett', icon: '🏛️', type: 'building', desc: 'Du machst hier die Kurse.' },
            { name: 'Zentralbank', icon: '💴', type: 'building', desc: 'Du druckst quasi das Geld.' },
        ]),
    },
    {
        id: 'space',
        name: 'Weltraumkolonien',
        icon: '🚀',
        theme: 'space',
        description: 'Der Himmel war nie die Grenze. Die Wirtschaft wird interplanetar.',
        unlock: gate(1e19, 2),
        unlockAt: 1e19,
        unlockHint: 'Verdiene €10 Trill. (10^19) und 2 Börsengänge.',
        assets: buildAssets('space', 1e15, [
            { name: 'Astronauten-Crew', icon: '🧑‍🚀', type: 'employee', desc: 'Pioniere mit Helm.' },
            { name: 'Startrampe', icon: '🛫', type: 'building', desc: 'Wöchentliche Raketenstarts.' },
            { name: 'Orbitalstation', icon: '🛰️', type: 'building', desc: 'Produktion in Schwerelosigkeit.' },
            { name: 'Mondbasis', icon: '🌕', type: 'building', desc: 'Erste Adresse außerhalb der Erde.' },
            { name: 'Asteroiden-Bergbau', icon: '☄️', type: 'building', desc: 'Platin aus dem All.' },
            { name: 'Mars-Kolonie', icon: '🪐', type: 'building', desc: 'Eine ganze Welt als Markt.' },
            { name: 'Dyson-Schwarm', icon: '☀️', type: 'building', desc: 'Erntet die Energie einer Sonne.' },
        ]),
    },
    {
        id: 'metaverse',
        name: 'Metaverse-Wirtschaft',
        icon: '🕶️',
        theme: 'metaverse',
        description: 'Die letzte Grenze ist virtuell — und unendlich skalierbar.',
        unlock: gate(1e21, 3),
        unlockAt: 1e21,
        unlockHint: 'Verdiene €1 Trd. (10^21) und 3 Börsengänge.',
        assets: buildAssets('metaverse', 1e18, [
            { name: 'Avatar-Designer', icon: '🧝', type: 'employee', desc: 'Erschafft digitale Identitäten.' },
            { name: 'Virtuelles Grundstück', icon: '🟦', type: 'building', desc: 'Lage, Lage, Lage — in Pixeln.' },
            { name: 'NFT-Galerie', icon: '🖼️', type: 'building', desc: 'Knappheit auf Knopfdruck.' },
            { name: 'VR-Arena', icon: '🥽', type: 'building', desc: 'Millionen tauchen ein.' },
            { name: 'Krypto-Casino', icon: '🎰', type: 'building', desc: 'Das Haus gewinnt immer.' },
            { name: 'Digitale Metropole', icon: '🌃', type: 'building', desc: 'Eine Stadt aus reinem Code.' },
            { name: 'Metaverse-Plattform', icon: '🌐', type: 'building', desc: 'Du besitzt die Realität 2.0.' },
        ]),
    },
    {
        id: 'biotech',
        name: 'Biotech-Welt',
        icon: '🧬',
        theme: 'biotech',
        description: 'Die Wirtschaft des Lebens selbst — von Genen bis zur Unsterblichkeit.',
        unlock: gate(1e24, 5),
        unlockAt: 1e24,
        unlockHint: 'Verdiene €1 Quad. (10^24) und 5 Börsengänge.',
        assets: buildAssets('biotech', 1e21, [
            { name: 'Laborant', icon: '🥼', type: 'employee', desc: 'Pipettiert die Zukunft zusammen.' },
            { name: 'Genlabor', icon: '🧫', type: 'building', desc: 'Wo Code zu Leben wird.' },
            { name: 'Biotech-Startup', icon: '🧬', type: 'building', desc: 'Disruption auf Zellebene.' },
            { name: 'Pharmafabrik', icon: '💊', type: 'building', desc: 'Heilung im Industriemaßstab.' },
            { name: 'Klinik-Netzwerk', icon: '🏥', type: 'building', desc: 'Gesundheit als Abomodell.' },
            { name: 'Gen-Editor', icon: '✂️', type: 'building', desc: 'Bearbeitet das Buch des Lebens.' },
            { name: 'Lebensverlängerung', icon: '⏳', type: 'building', desc: 'Das ultimative Produkt: Zeit.' },
        ]),
    },
    {
        id: 'ai',
        name: 'KI-Singularität',
        icon: '🤖',
        theme: 'ai',
        description: 'Die letzte Erfindung der Menschheit arbeitet jetzt für dich.',
        unlock: gate(1e27, 8),
        unlockAt: 1e27,
        unlockHint: 'Verdiene €1 Quint. (10^27) und 8 Börsengänge.',
        assets: buildAssets('ai', 1e24, [
            { name: 'ML-Forscher', icon: '🧑‍🔬', type: 'employee', desc: 'Bringt Maschinen das Denken bei.' },
            { name: 'Trainings-Cluster', icon: '🖥️', type: 'building', desc: 'Petaflops im Dauerlauf.' },
            { name: 'Autonome Fabrik', icon: '🏭', type: 'building', desc: 'Baut sich selbst — und mehr.' },
            { name: 'AGI-Kern', icon: '🧠', type: 'building', desc: 'Denkt schneller, als du lesen kannst.' },
            { name: 'Roboterarmee', icon: '🤖', type: 'building', desc: 'Arbeitskraft ohne Grenzen.' },
            { name: 'Neuronales Imperium', icon: '🕸️', type: 'building', desc: 'Ein Netz über die ganze Welt.' },
            { name: 'Technologische Singularität', icon: '🌌', type: 'building', desc: 'Ab hier ist nichts mehr wie zuvor.' },
        ]),
    },
];
//# sourceMappingURL=worlds.js.map