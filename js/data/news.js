export const NEWS_ENTRIES = [
    {
        id: 'upcoming-roadmap',
        date: '2026-06-03',
        type: 'upcoming',
        eta: 'in Planung',
        title: 'Das steht als Nächstes an',
        items: [
            '🌌 Weitere Welten jenseits der KI-Singularität.',
            '📊 Statistik-Tab mit Diagrammen zu deinem Wachstum.',
            '🔔 Erinnerung, sobald dein Tagesbonus wieder bereitsteht.',
            '🤝 Gilden & gemeinsame Saison-Ziele mit anderen Spieler:innen.',
        ],
    },
    {
        id: 'v1-1',
        date: '2026-06-03',
        type: 'update',
        tag: 'v1.1',
        title: 'Nachrichten-Center, Forschung & Tagesbonus',
        items: [
            '📰 Neues Nachrichten-Center (dieses Fenster): Updates & Ausblick auf einen Blick.',
            '🔬 Forschungsbaum mit der neuen Ressource „Forschungspunkte“ — bleibt über Prestige erhalten.',
            '🎁 Täglicher Bonus mit Streak: jeden Tag Kapital und Einfluss abholen.',
            '📲 Als App installierbar (PWA) und offline spielbar.',
        ],
    },
    {
        id: 'server-hardening',
        date: '2026-06-03',
        type: 'fix',
        tag: 'Server',
        title: 'Sicherer & stabiler im Online-Modus',
        items: [
            '🛡️ Schutz gegen Spam und Brute-Force (Rate-Limiting).',
            '🔑 Sitzungen laufen sicher ab — bei Bedarf einfach neu anmelden.',
            '⚖️ Anti-Cheat: unrealistische Firmenwerte werden in der Bestenliste abgewiesen.',
            '🐞 Anzeige aktiver Events korrigiert.',
        ],
    },
    {
        id: 'v1-0',
        date: '2026-05-30',
        type: 'update',
        tag: 'v1.0',
        title: 'Unternehmens-Imperium ist da! 🎉',
        items: [
            '🏢 Baue vom Startup zum Welt-Konzern: klicken, Assets kaufen, automatisieren.',
            '🌍 9 Welten, ~280 Upgrades, 22 Erfolge, Aufträge, Prestige & Goldene Deals.',
            '☁️ Online-Modus mit Konto, Cloud-Speicher und Bestenliste.',
        ],
    },
];
/** Icon + Label je Nachrichtentyp (für die Darstellung). */
export const NEWS_TYPE_META = {
    update: { icon: '✨', label: 'Update' },
    upcoming: { icon: '🔜', label: 'Bald' },
    fix: { icon: '🛠️', label: 'Fix' },
    event: { icon: '🎉', label: 'Event' },
    info: { icon: 'ℹ️', label: 'Info' },
};
//# sourceMappingURL=news.js.map