# Handover: Teil 2b — Client auf server-autoritative Ökonomie umstellen

> Übergabedokument für eine frische Session. Wenn 2b fertig ist, kann diese Datei gelöscht werden.

## Wo wir stehen (alles auf `main`, committet & gepusht)

Der gesamte Online-Ausbau ist gebaut **bis auf den Client-Teil von Phase 2b/2c**:

- **Phase 1** — Accounts (E-Mail/Verifizierung/Reset), `server/server.js` + `db.js` + `mailer.js`.
- **Phase 2 (alt)** und Rohstoff-Neudesign — **rarität-basierte aktive Drops**: `server/resources.js` (Energie pro Welt, CSPRNG-Rolls, Booster, Rate-Limit, Farben), Client-Tab in `src/ui/UIManager.ts`.
- **Phase 3** — Handel mit Lobbys + Escrow: `server/trade.js` (jetzt inkl. **Geld** im Escrow).
- **Phase 4** — Echtzeit-Push via WebSockets: `server/realtime.js`, Client-WS in `src/systems/OnlineManager.ts`.
- **Teil 2a + 2c (Server)** — **server-autoritative Ökonomie**: `server/economy.js`.

**Tests (alle grün):** `node test/smoke.mjs` (50) + im `server/`: `test-migration` (5), `test-resources` (27), `test-economy` (17), `test-auth` (23), `test-trade` (43), `test-realtime` (7).
Build: `npm run build` (tsc). Backend lokal: `MAIL_DEV_RETURN_TOKENS=1 PORT=3000 node server/server.js`.

## Architektur-Kernidee (wichtig!)

**Reuse statt Neu-Implementierung:** Der Server führt die **echte Spiel-Logik** (`js/core/Game.js` + Daten) als autoritative Instanz pro Spieler — kein Duplizieren, kein Drift. `server/economy.js` lädt den serialisierten SaveState aus der Tabelle `player_economy`, baut ein `Game`, akkumuliert passives Einkommen (Lazy Settlement, 8h-Cap), wendet die Aktion an, speichert wieder. Zufalls-Events/Golden sind server-seitig **deaktiviert** (deterministisches Einkommen).

**Vorhandene Server-Endpoints (alle auth + `tx`):**
`GET /api/economy` · `POST /api/economy/{click,buy-asset,buy-upgrade,research,prestige-upgrade,prestige,world,daily,quest}`.
`GET /api/economy` und jede Aktion liefern: `{ money, perSecond, clickValue, valuation, influence, employees, buildings, save }` — `save` ist der volle serialisierte Zustand zum **Spiegeln** im Client.
Klicks: `POST /api/economy/click {count}` → server-seitiges Token-Bucket (10/s, Burst 30) × server-bekanntem Klickwert.
`OnlineManager`-Methoden für den Client sind noch zu ergänzen (siehe Schritte).

## Entschiedene Vorgaben für 2b (NICHT erneut fragen)

- **Online-Pflicht:** Kein autoritatives Spielen ohne Server-Sitzung (Gast genügt). Offline-/PWA-Spielen entfällt damit.
- **Frischer Start:** Server-Ökonomie startet bei €0 für alle (kein Migrieren vorhandener Spielstände).
- **Geld trustless:** nur Server-Aktionen ändern Geld; Klicks = rate-limitierte Anzahl × Server-Klickwert.
- **Handel:** Geld + Rohstoffe kombiniert, atomar — Server-Seite ist fertig (`trade.js`, Escrow `{ resources, money }`). `getLobbyState` liefert `you.money` (aus `economy.peekMoney`).

## 2b — Schritt-für-Schritt-Plan

1. **`OnlineManager` (`src/systems/OnlineManager.ts`):** Methoden ergänzen:
   `fetchEconomy()`, `econClick(count)`, `econBuyAsset(id, qty)`, `econBuyUpgrade(id)`, `econResearch(id)`, `econPrestigeUpgrade(id)`, `econPrestige()`, `econSetWorld(id)`, `econDaily()`, `econClaimQuest(id)` — alles `requireServer()` + `this.api('/api/economy/...', {auth:true})`.
2. **Login-Gate (`src/main.ts`):** Spiel erst nach Server-Sitzung starten. Ohne Login einen Gate-Screen zeigen (Gast/Anmelden über das vorhandene Auth-Modal). Lokale `Game`-Simulation **nicht** mehr als Autorität laufen lassen — nur als Render-Spiegel: nach jeder Server-Antwort `game.applySave(state.save)` + `ui.refreshAll()`.
3. **Aktionen → Server (`src/ui/UIManager.ts`):** Die Handler (`handleBuyAsset`, `buyUpgrade`, Prestige, Research, Daily, Quest, `setActiveWorld`) auf `await onlineManager.econ*` umstellen, danach `applySave(resp.save)` + gezieltes Refresh. Lokale `game.buyAsset()` etc. nicht mehr direkt mutieren.
4. **Klicks:** lokal **optimistisch** (sofortiges Feedback mit lokalem Klickwert), Anzahl puffern und ~1×/s als Batch an `econClick(count)` senden; Antwort-`save` spiegeln (Reconcile). Bei Drift „springt" Geld auf den Server-Wert — wegen identischem Code + menschlicher Klickrate praktisch deckungsgleich.
5. **Periodischer Reconcile:** alle ~3–5 s `fetchEconomy()` → `applySave(save)` (passives Einkommen wird server-seitig gerechnet). Optional optimistisches lokales Ticken nur für die Anzeige zwischen Syncs.
6. **Client-Events/Golden deaktivieren** (Konsistenz, da server-seitig aus) — oder später server-autoritativ nachrüsten.
7. **2c-Client:** Im Trade-UI (`renderLobbyRoom` in `UIManager.ts`) Geld anbieten: ein €-Eingabefeld neben den Rohstoffen; Offer als `{ resources:{…}, money:N }` senden (`setLobbyOffer` akzeptiert das Format bereits server-seitig). `you.money` aus dem Lobby-State anzeigen.
8. **Autosave/Save:** localStorage-Autosave als Autorität entfernen (Server ist Quelle). Cloud-Sync-Buttons ggf. entfernen/anpassen.
9. **Verifizieren** (Browser-Preview): Login-Gate, Kauf, Klick-Batch, Reconcile, Geld-Trade. **Achtung Service-Worker-Cache** beim Testen: vor dem Reload SW + Caches leeren (`navigator.serviceWorker.getRegistrations()` → unregister; `caches.keys()` → delete) und `game.settings.autosave=false` setzen, sonst lädt alter Code.

## Schlüsseldateien
- Server: `server/economy.js`, `server/trade.js`, `server/server.js` (Endpoints), `server/db.js` (`player_economy`).
- Client: `src/main.ts` (Boot/Loop), `src/ui/UIManager.ts` (alle Handler/Render), `src/systems/OnlineManager.ts` (API/WS).
- Nach Client-Änderungen: `npm run build`, dann Smoke + ggf. neue Tests.

## Konsequenzen beim Deploy von 2b
- **Online-Pflicht** und **Reset auf €0** gehen damit live. Vorher kommunizieren/abwägen.
- Commit-Nachrichten auf Englisch (so der bisherige Stil).
