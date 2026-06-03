/**
 * Entry point. Wires the systems together, restores the save (with offline
 * progress), starts the loop and schedules autosave + online polling.
 *
 * Dependency direction: main → Game (logic) → systems; UIManager observes the
 * EventBus. Nothing in the logic layer imports the UI.
 */
import { EventBus } from './systems/EventBus.js';
import { SaveSystem } from './systems/SaveSystem.js';
import { OnlineManager } from './systems/OnlineManager.js';
import { EventManager } from './systems/EventManager.js';
import { Notifications } from './ui/Notifications.js';
import { UIManager } from './ui/UIManager.js';
import { Game } from './core/Game.js';
import { formatMoney, formatTime } from './ui/format.js';

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

  // Restore save (if any) and remember when it was saved for offline maths.
  const saved = saveSystem.load();
  let savedAt = 0;
  if (saved) {
    game.applySave(saved);
    savedAt = saved.savedAt ?? 0;
  }

  game.company.name = game.company.name || 'Mein Startup';
  ui.init();
  (document.getElementById('company-name') as HTMLInputElement).value = game.company.name;

  // Offline progress.
  if (savedAt) {
    const elapsed = (Date.now() - savedAt) / 1000;
    if (elapsed > 60) {
      const result = game.applyOfflineProgress(elapsed);
      if (result && result.earned > 0) {
        ui.openModal(`
          <h2>👋 Willkommen zurück!</h2>
          <p>Dein Unternehmen war <b>${formatTime(result.requested)}</b> ohne dich aktiv
             ${result.capped ? `(angerechnet: ${formatTime(result.seconds)})` : ''}.</p>
          <p class="offline-earned">+${formatMoney(result.earned)}</p>
          <div class="modal-actions">
            <button class="btn-prestige" data-act="ok">Super!</button>
          </div>`);
        (document.querySelector('#modal-layer [data-act="ok"]') as HTMLElement).onclick = () => ui.closeModal();
        ui.refreshAll();
      }
    }
  }

  game.start();

  // Autosave every 30 s.
  setInterval(() => { if (game.settings.autosave) game.save(); }, 30_000);

  // Persist on tab hide / close so progress is never lost.
  const flush = (): void => { if (game.settings.autosave) game.save(); };
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  // Poll the server for global events while online (de-duped in EventManager).
  const pollEvents = async (): Promise<void> => {
    if (!onlineManager.isOnline) return;
    try {
      const events = await onlineManager.fetchEvents();
      if (events.length) eventManager.ingestServerEvents(events);
    } catch { /* offline / network hiccup — ignore */ }
  };
  setInterval(pollEvents, 60_000);
  // Sofort nach dem Login einmal pollen (statt bis zu 60 s zu warten).
  bus.on('online:session', (s: { mode: string }) => { if (s.mode !== 'offline') pollEvents(); });

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
