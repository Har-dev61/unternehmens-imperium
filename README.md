# 🏢 Unternehmens-Imperium

Ein browserbasiertes **Idle-/Klicker-Game** im Stil von *Cookie Clicker* — mit dem
Thema **Unternehmensaufbau**. Starte als Ein-Personen-Startup und wachse über
**neun Welten** (vom lokalen Markt bis zur KI-Singularität) zu einem
internationalen Wirtschaftsimperium heran.

Geschrieben in **objektorientiertem, modularem TypeScript** (kompiliert nach
ES-Modulen) mit einem **echten Node/Express-Backend** für Online-Funktionen.
Saubere Trennung von Spiellogik, Datenmodellen, UI und Online-Funktionen.

---

## 🚀 Schnellstart

Der Spielcode liegt als **TypeScript** in `src/` und wird nach `js/` kompiliert.
Das kompilierte `js/` ist bereits eingecheckt — das Spiel ist also **sofort
spielbar**, ohne erst zu bauen. Browser laden ES-Module aus Sicherheitsgründen
**nicht** über `file://`, daher ein kleiner lokaler Server:

```bash
# Variante A: Node (serve)
npm start                       # → http://localhost:5173

# Variante B: Python (bereits installiert auf den meisten Systemen)
python -m http.server 5173      # → http://localhost:5173

# Variante C: VS Code
#   Rechtsklick auf index.html → "Open with Live Server"
```

Danach `http://localhost:5173` im Browser öffnen. Der Spielstand wird automatisch
im `localStorage` gespeichert (alle 30 s sowie beim Schließen des Tabs).

**Am Code arbeiten** (TypeScript neu kompilieren):

```bash
npm install        # einmalig (nur TypeScript als Dev-Abhängigkeit)
npm run build      # src/*.ts → js/
npm run watch      # automatisch bei jeder Änderung neu bauen
npm run typecheck  # nur Typprüfung, ohne Ausgabe
npm test           # baut und führt den headless-Logiktest aus
```

Für den **Online-Modus** zusätzlich das Backend starten (siehe unten):
`cd server && npm install && npm start`.

---

## 🎮 Features

| Bereich | Umgesetzt |
|--------|-----------|
| **Klick-Mechanik** | Geld pro Klick mit Animation & schwebenden Zahlen |
| **Passive Einnahmen** | Mitarbeiter & Gebäude erzeugen €/s |
| **Kauf-Mengen** | ×1, ×10, ×100 und **Max** (geometrische Kostenkurve) |
| **Upgrades** | 8 Kategorien: Klick, Automatisierung, Mitarbeiter, Produktion, Marketing, Forschung, Welt, Spezial (~280 Stück) |
| **Welten / Märkte** | 9 Welten mit eigenem Design, Skalierung & Freischalt-Bedingungen |
| **Prestige** | „Börsengang“ → Einfluss-Punkte + dauerhafter Prestige-Upgrade-Baum |
| **Erfolge** | 22 Achievements mit dauerhaften Einnahmen-Boni |
| **Aufträge** | 9 Quests mit Fortschrittsbalken & Belohnungen (Geld/Einfluss/Multiplikator) |
| **Forschung** | Zweite Ressource + Tech-Tree (9 Knoten mit Voraussetzungen), bleibt über Prestige erhalten |
| **Tagesbonus** | Tägliche Login-Belohnung mit Streak (Kapital + Einfluss) |
| **Goldene Deals** | Zufällige Klickziele à la „Golden Cookie“ (Glückstreffer, Kaufrausch ×7, Klick-Rausch ×777) |
| **Events** | Zufällige Wirtschafts-Events (×2…×5) + Online-Events |
| **Offline-Fortschritt** | Einnahmen während der Abwesenheit (mit Cap & Effizienz) |
| **Online-Modus** | Echtes Backend (Express + SQLite) mit Konten, Cloud-Saves, Bestenliste — inkl. Simulations-Fallback |
| **Speichern** | localStorage + Export/Import als Code + Cloud-Sync |
| **UI/UX** | Responsives Dashboard, Themes pro Welt, Toasts, Sound-Feedback |
| **PWA** | Installierbar & offline spielbar (Service Worker + App-Manifest; aktiv unter HTTPS/localhost) |

---

## 🏗️ Architektur

**Leitprinzip:** Die Spiellogik kennt die UI nicht. Sie sendet semantische
Events über einen `EventBus`; die UI *beobachtet* nur und ruft Spielmethoden auf.
Dadurch ist die Logik vollständig ohne DOM testbar (siehe [`test/smoke.mjs`](test/smoke.mjs)).

```
                ┌─────────────┐
                │   main.js   │  Bootstrap: verdrahtet alles, startet Loop
                └──────┬──────┘
                       │ erzeugt
        ┌──────────────┼───────────────────────────┐
        ▼              ▼                             ▼
   ┌─────────┐   ┌───────────┐                 ┌──────────┐
   │  Game   │   │  Systeme  │                 │UIManager │  (beobachtet Bus,
   │(Logik)  │◄──┤ EventBus  │◄────────────────┤  Render  │   ruft Game-Methoden)
   └────┬────┘   │ SaveSystem│   emit/on        └──────────┘
        │        │ Online…   │                       ▲
        │        │ Event…    │                       │ Toasts
        │        └───────────┘                  ┌──────────┐
        │ besitzt                               │Notifica… │
        ▼                                       └──────────┘
  Player · Company · World[] · Upgrade[] · Achievement[]
                       │ World besitzt
                       ▼
                  Asset[]  →  Employee | Building   (Vererbung)
                       │
                  Resource (Kapital)
```

### Klassen­übersicht

Quelldateien liegen in `src/` als TypeScript (`.ts`); die Tabelle verlinkt die Quelle.

| Klasse | Datei | Verantwortung |
|--------|-------|---------------|
| `Game` | [`src/core/Game.ts`](src/core/Game.ts) | Orchestrator: Spiel-Loop, **zentrale Ökonomie-Mathematik**, Käufe, Prestige, Offline, Serialisierung |
| `Player` | [`src/core/Player.ts`](src/core/Player.ts) | Spieler/Account: Prestige-Fortschritt, Statistiken (überlebt Resets) |
| `Company` | [`src/core/Company.ts`](src/core/Company.ts) | Wirtschaftseinheit: Kapital + Multiplikatoren (Klick/Global/Auto) |
| `World` | [`src/core/World.ts`](src/core/World.ts) | Markt/Welt: eigene Assets, Theme, Produktions-Multiplikator, Freischaltung |
| `Asset` | [`src/core/Asset.ts`](src/core/Asset.ts) | **Abstrakte Basis** für Einkommens-Assets (Kostenkurve, Produktion) |
| `Employee` / `Building` | [`…/Employee.ts`](src/core/Employee.ts) · [`…/Building.ts`](src/core/Building.ts) | Konkrete Asset-Typen (Vererbung) |
| `Upgrade` | [`src/core/Upgrade.ts`](src/core/Upgrade.ts) | Einmalkauf mit **deklarativen Effekten** + Freischalt-Bedingung |
| `Achievement` | [`src/core/Achievement.ts`](src/core/Achievement.ts) | Meilenstein mit dauerhaftem Bonus |
| `Quest` | [`src/core/Quest.ts`](src/core/Quest.ts) | Auftrag mit Fortschritt, Ziel & einlösbarer Belohnung |
| `Resource` | [`src/core/Resource.ts`](src/core/Resource.ts) | Spielbare Ressource (Betrag, Gesamt-verdient, Rate) |
| `EventBus` | [`src/systems/EventBus.ts`](src/systems/EventBus.ts) | Publish/Subscribe — entkoppelt Logik ↔ UI |
| `SaveSystem` | [`src/systems/SaveSystem.ts`](src/systems/SaveSystem.ts) | localStorage, JSON, Export/Import, Zeitstempel |
| `OnlineManager` | [`src/systems/OnlineManager.ts`](src/systems/OnlineManager.ts) | Konten, Cloud-Saves, Bestenliste, Events — echtes `fetch()` **oder** Simulation |
| `EventManager` | [`src/systems/EventManager.ts`](src/systems/EventManager.ts) | Temporäre Einnahmen-Boosts |
| `GoldenDeal` | [`src/systems/GoldenDeal.ts`](src/systems/GoldenDeal.ts) | Spawnt zufällige „Goldene Deals" (Golden-Cookie-Mechanik) |
| `UIManager` | [`src/ui/UIManager.ts`](src/ui/UIManager.ts) | Gesamtes DOM-Rendering & Eingaben |
| `Notifications` | [`src/ui/Notifications.ts`](src/ui/Notifications.ts) | Toast-Benachrichtigungen |
| `types.ts` | [`src/types.ts`](src/types.ts) | Gemeinsame Typen (Configs, Effekt-Union, Save-State) |

### Verzeichnisstruktur

```
click/
├── index.html              # Struktur + IDs, die der UIManager befüllt
├── css/styles.css          # Dark-Dashboard, Themes pro Welt, responsiv
├── src/                    # ► TypeScript-Quellcode (Quelle der Wahrheit)
│   ├── main.ts             # Einstiegspunkt
│   ├── types.ts            # Gemeinsame Typen / Interfaces
│   ├── core/               # Spiellogik & Datenmodelle (kennen die UI NICHT)
│   ├── systems/            # Querschnitt: Bus, Speichern, Online, Events, Golden Deals
│   ├── ui/                 # Rendering & Formatierung
│   └── data/               # Inhalte: worlds, upgrades, achievements, prestige, quests
├── js/                     # ◄ von tsc generiert (eingecheckt, direkt spielbar)
├── server/                 # Node/Express + SQLite-Backend (eigenes package.json)
│   ├── server.js           # API-Endpunkte
│   └── db.js               # SQLite-Schema & Queries (node:sqlite)
├── test/smoke.mjs          # Headless-Logiktest (läuft gegen js/)
├── tsconfig.json           # strenge TS-Konfiguration (NodeNext → js/)
└── package.json
```

---

## ⚙️ Kernmechaniken

**Kostenkurve (pro Asset):** `Kosten(n) = baseCost · 1,15ⁿ`. Massenkäufe nutzen die
geschlossene Form der geometrischen Reihe (`Asset.getCost`, `Asset.getMaxAffordable`).

**Einnahmen-Mathematik** (zentral in `Game.recalculate()` + `computeDerived()`):

```
Welt-Produktion  = Σ(Asset.count · baseProduction · AssetMult) · WeltMult · WeltUpgradeMult
Passiv €/s       = Σ(Welt-Produktion freigeschalteter Welten) · Global · Prestige · Event
Klickwert        = (Basis · KlickMult) · Global · Prestige · Event  + Klick%·Passiv
Auto-Einnahmen   = AutoKlicks/s · Klickwert
```

Alle Multiplikatoren werden bei jeder relevanten Änderung **von Grund auf neu
berechnet** (`recalculate`), indem die deklarativen Effekte aller gekauften
Upgrades + Prestige-Upgrades angewandt und Achievement-/Prestige-Boni
aufgeschlagen werden. Das hält den Zustand konsistent und frei von Drift.

**Prestige (Börsengang):** Gewinn = `⌊∛(runEarned / 1e9)⌋` Einfluss-Punkte; jeder
Punkt gibt dauerhaft **+2 %** auf alle Einnahmen. Zurückgesetzt werden Kapital,
Assets und normale Upgrades — erhalten bleiben Welten, Erfolge, Einfluss und der
Prestige-Upgrade-Baum.

**Welten-Skalierung:** Alle Welten teilen dieselbe ausbalancierte „Asset-Leiter“,
skaliert mit **einem** Faktor je Welt (auf Kosten *und* Produktion). Dadurch ist
die Amortisationszeit in jeder Welt gleich (Balance), während die absoluten Zahlen
über 10¹⁸-fach wachsen.

---

## 🧩 Inhalte erweitern (data-driven)

Der gesamte Spielinhalt liegt deklarativ in `js/data/` — **kein Logik-Code nötig**:

**Neue Welt** → Eintrag in [`src/data/worlds.ts`](src/data/worlds.ts):

```js
{
  id: 'biotech', name: 'Biotech-Welt', icon: '🧬', theme: 'biotech',
  description: '…', unlock: earned(1e24), unlockAt: 1e24,
  unlockHint: 'Verdiene insgesamt €1 Quad.',
  assets: buildAssets('biotech', 1e21, [
    { name: 'Laborant', icon: '🥼', type: 'employee', desc: '…' },
    /* … 7 Einträge … */
  ]),
}
```
Eine Theme-Farbe ergänzt man in `css/styles.css`: `body[data-theme="biotech"]{…}`.

**Neues Upgrade** → in [`src/data/upgrades.ts`](src/data/upgrades.ts). Unterstützte
Effekt-Typen (die `Effect`-Union in [`src/types.ts`](src/types.ts)):
`click`, `clickPercent`, `global`, `autoclick`, `asset`, `assetClass`, `world`.

```ts
{ id: 'mkt-x', name: 'Super Bowl Spot', category: 'marketing', cost: 1e9,
  description: '+40 % Einnahmen.', effects: [{ type: 'global', multiplier: 1.4 }],
  unlock: (game) => game.player.lifetimeEarned >= 5e8 }
```

**Neuer Erfolg** → [`src/data/achievements.ts`](src/data/achievements.ts) ·
**Auftrag** → [`src/data/quests.ts`](src/data/quests.ts) ·
**Prestige-Upgrade** → [`src/data/prestige.ts`](src/data/prestige.ts) ·
**Forschungsknoten** → [`src/data/research.ts`](src/data/research.ts).
Nach Änderungen `npm run build` ausführen.

---

## 🌐 Online-Modus

Es gibt ein **echtes Backend** in [`server/`](server/server.js) — und einen
nahtlosen Fallback auf eine **Simulation**, falls kein Server läuft.

### Echtes Backend (Node/Express + SQLite)

```bash
cd server
npm install        # einmalig (installiert Express)
npm start          # → http://localhost:3000
```

- **Express** als HTTP-Framework, **`node:sqlite`** als Datenbank (in Node ≥ 22
  eingebaut — keine native Abhängigkeit zu kompilieren), **`node:crypto`**
  (scrypt) für Passwort-Hashing.
- Endpunkte: `POST /api/auth/{guest,register,login}`, `GET|PUT /api/save`,
  `GET|POST /api/leaderboard`, `GET /api/events`, `GET /api/health`.
- Auth über Bearer-Token; Cloud-Saves und Bestenliste liegen in `imperium.db`.

Der Client ([`OnlineManager`](src/systems/OnlineManager.ts)) ist mit
`serverUrl: 'http://localhost:3000'` vorkonfiguriert und nutzt automatisch das
echte `fetch()`-Transport. Jede Methode versucht zuerst den Server und fällt bei
Netzwerkfehlern transparent auf die `localStorage`-Simulation (mit lebenden
KI-Konkurrenten) zurück — das Spiel funktioniert also **mit oder ohne** Server.
Die Server-URL lässt sich im Online-Tab per „Server …“ ändern (leer = nur Simulation).

> Produktiv noch ergänzen: HTTPS, Rate-Limiting, Token-Ablauf, serverseitige
> Plausibilitätsprüfung der Scores (Anti-Cheat).

---

## 🛣️ Ideen für Erweiterungen

Bereits umgesetzt: ✅ echtes Backend (Express + SQLite) · ✅ TypeScript-Migration ·
✅ Quests · ✅ Golden Deals · ✅ Biotech- & KI-Singularität-Welt.

Nächste Schritte:

- **Zweite Ressource** „Forschung“ mit eigenem Tech-Tree (Hooks sind vorbereitet).
- **Anti-Cheat**: serverseitige Plausibilitätsprüfung der Scores + JWT mit Ablauf.
- **Allianzen & Handel** zwischen Spielern (über `OnlineManager` / neue Endpunkte).
- **Synchronisierte Live-Events** für alle Spieler (das Backend liefert sie bereits
  zeit-gebucketet aus — nur die UI-Ankündigung fehlt).
- **Multiversum / weitere Welten**, Mutationen, Skins.
- **PWA**: Service-Worker + Manifest für „Installieren“ und echtes Offline-Spiel.
- **Build-Bundling** (esbuild/Vite) für eine einzige minifizierte Datei in Produktion.

---

## 📄 Lizenz

MIT — frei nutzbar als Grundlage für die Weiterentwicklung.
