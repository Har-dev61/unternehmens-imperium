/**
 * Entry point. Wires the systems together, then gates the game behind a server
 * session (Part 2b: the economy is server-authoritative — online is mandatory).
 *
 * Dependency direction: main → Game (logic) → systems; UIManager observes the
 * EventBus. Nothing in the logic layer imports the UI.
 *
 * The local Game is only a RENDER MIRROR of the server's canonical instance: it
 * ticks optimistically for a smooth display, but every action goes to the server
 * and the returned save is mirrored back. Random events, golden deals and
 * progress detection are disabled locally (the server owns them, and has them
 * off too), so the mirror never drifts from the authoritative state.
 */
import { EventBus } from './systems/EventBus.js';
import { SaveSystem } from './systems/SaveSystem.js';
import { OnlineManager } from './systems/OnlineManager.js';
import { EventManager } from './systems/EventManager.js';
import { Notifications } from './ui/Notifications.js';
import { UIManager } from './ui/UIManager.js';
import { Game } from './core/Game.js';
import type { SaveState } from './types.js';

function boot(): void {
  const bus = new EventBus();
  const saveSystem = new SaveSystem();
  // Backend-URL: lokal das Dev-Backend auf :3000, in Produktion derselbe Host
  // wie die Seite (nginx leitet /api an das Backend weiter → kein CORS).
  // Ein per "Server …" gesetzter Wert im localStorage hat Vorrang.
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  const onlineManager = new OnlineManager(bus, {
    serverUrl: isLocal ? 'http://localhost:3000' : location.origin,
  });
  const eventManager = new EventManager(bus);

  const game = new Game({ bus, saveSystem, onlineManager, eventManager });
  const notifications = new Notifications();
  const ui = new UIManager(game, notifications);

  // --- Server is authoritative: keep the local mirror from drifting ---------
  // Same pattern the server uses (server/economy.js) but for the opposite role:
  // no random events, no golden deals, and no client-side progress detection
  // (world unlocks / achievements / quests are read from the server save, with
  // toasts emitted by UIManager.mirrorEconomy on transitions).
  game.eventManager.update = () => {};
  game.goldenDeal.update = () => {};
  game.checkProgress = () => {};

  game.company.name = game.company.name || 'Mein Startup';
  ui.init();

  /** Pull authoritative state, reveal the game and start the render loop. */
  const enterGame = async (): Promise<void> => {
    let state: { save: SaveState };
    try {
      state = await onlineManager.fetchEconomy();
    } catch (e) {
      notifications.show({ title: 'Verbindungsfehler', text: (e as Error).message, icon: '⚠️', kind: 'error', duration: 5000 });
      // Token expired (401) → usingServer is now false → re-auth via the gate.
      // Transient hiccup (still authed) → retry shortly; the boot self-heals.
      if (onlineManager.usingServer) setTimeout(() => void enterGame(), 3000);
      else ui.showLoginGate(enterGame);
      return;
    }
    ui.mirrorEconomy(state.save, false); // initial load: no "unlocked!" toast flood
    ui.hideLoginGate();
    ui.refreshAll();
    ui.maybeAutoShowNews();
    if (!game.running) game.start();
  };

  // Online-Pflicht: restore an existing session, otherwise show the login gate.
  void (async () => {
    await onlineManager.restoreSession();

    // Losing the session (logout / token expiry) drops back to the gate.
    bus.on('online:session', (s: { mode: string }) => {
      if (s.mode === 'offline') { game.stop(); ui.showLoginGate(enterGame); }
    });

    if (onlineManager.usingServer) await enterGame();
    else ui.showLoginGate(enterGame);
  })();

  // PWA: Service Worker registrieren (greift nur in sicherem Kontext: https oder localhost).
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* z. B. unsicherer http-Kontext – ignorieren */ });
    });
  }

  // Expose for debugging in the console.
  (window as any).game = game;
  console.info('%c🏢 Unternehmens-Imperium gestartet', 'color:#4ade80;font-weight:bold');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
