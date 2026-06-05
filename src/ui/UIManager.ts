import { formatNumber, formatMoney, formatRate, formatTime, formatDate } from './format.js';
import { UPGRADE_CATEGORIES } from '../data/upgrades.js';
import { NEWS_ENTRIES, NEWS_TYPE_META } from '../data/news.js';
import type { Game, DailyReward } from '../core/Game.js';
import type { Notifications } from './Notifications.js';
import type { EventBus } from '../systems/EventBus.js';
import type { Asset } from '../core/Asset.js';
import type { Upgrade } from '../core/Upgrade.js';
import type { Quest } from '../core/Quest.js';
import type { GoldenActive } from '../systems/GoldenDeal.js';
import type { BuyQuantity, UpgradeCategory, ResearchUpgradeConfig, NewsEntry, SaveState } from '../types.js';

interface ShopRow {
  asset: Asset;
  row: HTMLButtonElement;
  costEl: HTMLElement;
  countEl: HTMLElement;
  prodEl: HTMLElement;
}
interface UpgradeRow { upgrade: Upgrade; el: HTMLButtonElement; }
interface QuestRow {
  quest: Quest;
  row: HTMLElement;
  fill: HTMLElement;
  prog: HTMLElement;
  btn: HTMLButtonElement;
}

/**
 * Owns all DOM rendering and input handling. It never mutates game models
 * directly — it calls Game methods and reacts to EventBus events. Cheap text
 * updates run every frame; expensive list rebuilds are event-driven or throttled.
 */
export class UIManager {
  game: Game;
  bus: EventBus;
  notify: Notifications;
  activeTab = 'shop';

  private shopRows: ShopRow[] = [];
  private upgradeRows: UpgradeRow[] = [];
  private questRows: QuestRow[] = [];
  private researchRows: { def: ResearchUpgradeConfig; el: HTMLButtonElement }[] = [];
  private worldCards = new Map<string, HTMLElement>();
  private throttle = 0;
  private audioCtx: AudioContext | null = null;
  private goldenEl: HTMLElement | null = null;
  /** localStorage key remembering the newest news entry the player has opened. */
  private readonly newsSeenKey = 'imperium-news-seen';

  // Resources (Phase 2): cached static registry + last server snapshot, which
  // the UI extrapolates client-side between syncs for a smooth ticking display.
  private resourceConfig: any = null;
  private resourceState: {
    resources: Record<string, number>;
    energy: Record<string, { energy: number; max: number; regenPerSec: number }>;
    buildings: Record<string, number>; fetchedAt: number;
  } | null = null;
  private resIconMap: Record<string, string> = {};
  private resNameMap: Record<string, string> = {};
  private resRarity: Record<string, string> = {};       // type → rarity id
  private rarityColor: Record<string, string> = {};      // rarity id → colour
  private rarityRank: Record<string, number> = {};       // rarity id → order (for sorting)
  private resourceSyncAccum = 0;

  // Trading (Phase 3): which lobby we're in (null = browsing the list), the last
  // polled lobby state, the list search term, and a poll accumulator.
  private tradeLobbyId: string | null = null;
  private tradeState: any = null;
  private tradeSearch = '';
  private tradePollAccum = 0;

  // Economy (Part 2b): the server is authoritative. Clicks are buffered and
  // flushed as a batch (~1×/s); the whole economy is reconciled (~every 4 s)
  // against the server's save. Between syncs the local Game ticks optimistically
  // for a smooth display only.
  private pendingClicks = 0;
  private clickFlushAccum = 0;
  private econReconcileAccum = 0;
  /** When the server rate-limits us (429), pause economy syncing until this time. */
  private econBackoffUntil = 0;
  /** Timestamp of the last roll request, to throttle collect-button spam. */
  private lastRollAt = 0;

  // Login gate (online-mandatory): callback to run once a server session exists,
  // plus the unsubscribe for the session listener that watches the auth modal.
  private gateOnAuthed: (() => void) | null = null;
  private gateUnsub: (() => void) | null = null;

  // Lootboxes: cached static catalogue + last inventory snapshot + UI state.
  private lootboxConfig: any = null;
  private lootboxItems: Record<string, number> = {};
  private lootboxWorld = '';     // selected world for the Welten-Box
  private lootboxBusy = false;   // true while a box is opening / the reel spins

  // Client-local UI preferences. Under server authority the game state comes
  // from the server, but these cosmetic choices stay on the device (otherwise a
  // reconcile would reset them every few seconds).
  private readonly prefsKey = 'imperium-prefs';
  private prefs: { companyName?: string; muted: boolean; buyQuantity: BuyQuantity } = { muted: false, buyQuantity: '1' };

  private clickButton!: HTMLElement;
  private shopList!: HTMLElement;
  private floatLayer!: HTMLElement;

  constructor(game: Game, notifications: Notifications) {
    this.game = game;
    this.bus = game.bus;
    this.notify = notifications;
  }

  private $(id: string): HTMLElement {
    return document.getElementById(id) as HTMLElement;
  }

  // === Client-local prefs =================================================
  private loadPrefs(): void {
    try { const raw = localStorage.getItem(this.prefsKey); if (raw) this.prefs = { ...this.prefs, ...JSON.parse(raw) }; }
    catch { /* private mode / corrupt — keep defaults */ }
  }
  private savePrefs(): void {
    try { localStorage.setItem(this.prefsKey, JSON.stringify(this.prefs)); } catch { /* ignore */ }
  }
  /** Re-apply device-local prefs over the (server-mirrored) state. */
  private applyPrefs(): void {
    this.game.settings.muted = this.prefs.muted;
    this.game.settings.buyQuantity = this.prefs.buyQuantity;
    if (this.prefs.companyName) this.game.company.name = this.prefs.companyName;
  }
  private syncBuyQtyButtons(): void {
    document.querySelectorAll<HTMLElement>('#buy-qty [data-qty]').forEach((b) =>
      b.classList.toggle('active', b.dataset.qty === this.game.settings.buyQuantity));
  }
  /** Set the (device-local) company name and mirror it into the topbar input. */
  private setCompanyName(raw: string): void {
    const name = raw.trim() || 'Mein Unternehmen';
    this.game.company.name = name;
    this.prefs.companyName = name;
    this.savePrefs();
    (this.$('company-name') as HTMLInputElement).value = name;
  }

  // === Bootstrap ==========================================================
  init(): void {
    this.clickButton = this.$('click-button');
    this.shopList = this.$('shop-list');
    this.floatLayer = this.$('float-layer');

    this.loadPrefs();
    this.applyPrefs();
    this.bindStatic();
    this.syncBuyQtyButtons();
    this.preventMobileZoom();
    this.buildShop();
    this.rebuildUpgrades();
    this.buildWorlds();
    this.buildQuests();
    this.buildResearch();
    this.buildAchievements();
    this.rebuildPrestige();
    this.buildOnline();
    this.applyTheme();
    this.updateStats();
    this.updateNewsBadge();
    this.subscribe();
    this.switchTab(this.activeTab);
  }

  bindStatic(): void {
    // Instant, spam-proof clicking. `pointerdown` fires the moment a finger (or
    // mouse) touches down — no 300 ms tap delay, and one event per simultaneous
    // finger, so multi-touch spamming all counts. preventDefault stops the touch
    // from being interpreted as a scroll/zoom/selection gesture.
    this.clickButton.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.handleClick(e.clientX, e.clientY);
    });
    // Keyboard activation (Enter/Space) fires a synthetic click with detail 0;
    // pointer-driven clicks (detail ≥ 1) are already handled above, so ignore them.
    this.clickButton.addEventListener('click', (e) => { if (e.detail === 0) this.handleClick(); });
    this.clickButton.addEventListener('contextmenu', (e) => e.preventDefault());

    document.querySelectorAll<HTMLElement>('#nav [data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab ?? 'shop'));
    });

    document.querySelectorAll<HTMLElement>('#buy-qty [data-qty]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.prefs.buyQuantity = btn.dataset.qty as BuyQuantity;
        this.savePrefs();
        this.game.settings.buyQuantity = this.prefs.buyQuantity;
        document.querySelectorAll<HTMLElement>('#buy-qty [data-qty]').forEach((b) =>
          b.classList.toggle('active', b === btn));
        this.refreshShopRows();
      });
    });

    (this.$('company-name') as HTMLInputElement).addEventListener('change', (e) => {
      this.setCompanyName((e.target as HTMLInputElement).value);
    });
    this.$('btn-settings').addEventListener('click', () => this.openSettings());
    // Server is authoritative now → the save button forces an immediate sync.
    this.$('btn-save').addEventListener('click', () => {
      void this.reconcileEconomy();
      this.notify.show({ title: 'Mit Server synchronisiert', icon: '🔄', kind: 'success', duration: 2000 });
    });
    this.$('btn-mute').addEventListener('click', () => this.toggleMute());
    this.$('btn-news').addEventListener('click', () => this.openNews());
    this.$('daily-bonus').addEventListener('click', () => this.handleDaily());

    this.$('modal-layer').addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'modal-layer') this.closeModal();
    });
    this.updateMuteButton();
  }

  /**
   * Stop the browser from turning fast taps into zoom gestures. `touch-action`
   * (in CSS) already kills double-tap zoom; this blocks pinch-zoom too, which
   * iOS Safari still allows because it ignores `user-scalable=no`.
   */
  preventMobileZoom(): void {
    const block = (e: Event): void => e.preventDefault();
    // iOS-only pinch gesture events.
    document.addEventListener('gesturestart', block, { passive: false });
    document.addEventListener('gesturechange', block, { passive: false });
    document.addEventListener('gestureend', block, { passive: false });
    // Any 2+ finger move is a pinch attempt — block it everywhere (single-finger
    // scrolling is untouched, so lists still scroll normally).
    document.addEventListener('touchmove', (e: TouchEvent) => {
      if (e.touches.length > 1) e.preventDefault();
    }, { passive: false });
  }

  subscribe(): void {
    this.bus.on('tick', ({ dt }: { dt: number }) => this.onTick(dt));
    this.bus.on('asset:bought', () => { this.refreshShopRows(); });
    this.bus.on('upgrade:bought', ({ upgrade }: { upgrade: Upgrade }) => {
      this.rebuildUpgrades();
      this.playSound(660);
      if (upgrade.rare) {
        this.notify.show({ title: 'Spezial-Upgrade!', text: upgrade.name, icon: upgrade.icon, kind: 'rare' });
      }
    });
    this.bus.on('world:unlocked', ({ world }: any) => {
      this.buildWorlds();
      this.notify.show({ title: 'Neue Welt freigeschaltet!', text: world.name, icon: world.icon, kind: 'success', duration: 6000 });
      this.playSound(880);
    });
    this.bus.on('world:changed', () => { this.buildShop(); this.applyTheme(); this.buildWorlds(); });
    this.bus.on('achievement:unlocked', ({ achievement }: any) => {
      this.buildAchievements();
      this.notify.show({ title: 'Erfolg freigeschaltet!', text: `${achievement.name} (×${achievement.bonus})`, icon: achievement.icon, kind: 'success', duration: 5000 });
      this.playSound(990);
    });
    this.bus.on('prestige:done', ({ gain }: { gain: number }) => {
      this.rebuildPrestige(); this.buildShop(); this.rebuildUpgrades(); this.buildWorlds();
      this.notify.show({ title: 'Börsengang erfolgreich!', text: `+${gain} Einfluss`, icon: '📈', kind: 'rare', duration: 6000 });
    });
    this.bus.on('prestige:upgrade', () => this.rebuildPrestige());
    this.bus.on('event:started', (e: any) => {
      this.notify.show({ title: e.name, text: `×${e.multiplier} Einnahmen`, icon: '🎉', kind: 'rare', duration: 5000 });
    });
    this.bus.on('online:session', () => {
      this.buildOnline();
      if (this.activeTab === 'resources') void this.buildResources();
      if (this.activeTab === 'trade') { this.tradeLobbyId = null; void this.buildTrade(); }
      if (this.activeTab === 'lootbox') void this.buildLootbox();
    });
    this.bus.on('online:expired', () => this.notify.show({
      title: 'Sitzung abgelaufen', text: 'Bitte melde dich erneut an.', icon: '🔑', kind: 'info', duration: 6000,
    }));
    // No e-mail delivery yet → show dev tokens (e.g. after registration) so the
    // verify/reset flow is testable. Harmless once real e-mail is configured.
    this.bus.on('online:devtoken', (t: { verify?: string; reset?: string }) => {
      const tok = t.verify || t.reset;
      if (tok) this.notify.show({ title: '🔑 Dev-Token (E-Mail noch inaktiv)', text: tok, icon: '🔑', kind: 'info', duration: 10000 });
    });
    // Realtime push (Phase 4): live lobby updates + "logged in elsewhere" notice.
    this.bus.on('realtime', (m: { type: string; id?: string }) => {
      if (m.type === 'lobby:changed') {
        if (this.activeTab === 'trade' && this.tradeLobbyId && m.id === this.tradeLobbyId) void this.pollTrade();
      } else if (m.type === 'session:elsewhere') {
        this.notify.show({ title: 'Andere Sitzung aktiv', text: 'Dein Konto ist woanders eingeloggt.', icon: '👥', kind: 'info', duration: 7000 });
      }
    });
    this.bus.on('online:live', () => {
      // On (re)connect, reconcile the open lobby so nothing was missed offline.
      if (this.activeTab === 'trade' && this.tradeLobbyId) void this.pollTrade();
      if (this.activeTab === 'online') this.buildOnline(); // refresh the ⚡ Live indicator
    });

    this.bus.on('golden:spawn', (deal: GoldenActive) => this.spawnGolden(deal));
    this.bus.on('golden:expire', () => this.removeGolden());

    this.bus.on('quest:complete', ({ quest }: { quest: Quest }) => {
      this.buildQuests();
      this.notify.show({ title: 'Auftrag erfüllt!', text: `${quest.name} — jetzt einlösbar`, icon: quest.icon, kind: 'success', duration: 5000 });
    });
    this.bus.on('quest:claimed', () => { this.buildQuests(); this.buildAchievements(); this.playSound(770); });

    // Research & daily reward
    this.bus.on('research:bought', () => { this.buildResearch(); this.playSound(700); });
    this.bus.on('daily:claimed', (r: DailyReward) => {
      this.notify.show({
        title: `🎁 Tagesbonus – Tag ${r.streak}`,
        text: `+${formatMoney(r.money)}${r.influence ? ` · +${r.influence} Einfluss` : ''}`,
        icon: '🎁', kind: 'rare', duration: 5000,
      });
      this.updateDaily();
    });
  }

  // === Per-frame update ===================================================
  onTick(dt: number): void {
    this.updateStats();
    this.refreshShopRows();
    this.refreshBoosts();
    if (this.activeTab === 'resources') this.refreshResourceEnergy(); // smooth energy regen
    this.throttle += dt;
    if (this.throttle >= 0.4) {
      this.throttle = 0;
      this.rebuildUpgrades();
      this.refreshWorldsProgress();
      if (this.activeTab === 'prestige') this.rebuildPrestige();
      if (this.activeTab === 'quests') this.refreshQuests();
      if (this.activeTab === 'research') this.refreshResearch();
      if (this.activeTab === 'resources') {
        this.resourceSyncAccum += 0.4;
        if (this.resourceSyncAccum >= 20) { this.resourceSyncAccum = 0; void this.syncResources(); }
      }
      if (this.activeTab === 'trade') {
        this.tradePollAccum += 0.4;
        // Live push handles instant updates; polling is just a fallback/reconcile
        // (slow when the socket is live, faster when it isn't).
        const interval = this.tradeLobbyId ? (this.game.onlineManager.isLive ? 8 : 2) : 8;
        if (this.tradePollAccum >= interval) { this.tradePollAccum = 0; void this.pollTrade(); }
      }
      // Economy: flush buffered clicks (~1.5 s) and reconcile (~8 s). Skipped
      // while backing off after a 429 so we don't pile onto a rate-limited server.
      if (this.game.onlineManager.usingServer && Date.now() >= this.econBackoffUntil) {
        this.clickFlushAccum += 0.4;
        this.econReconcileAccum += 0.4;
        if (this.pendingClicks > 0 && this.clickFlushAccum >= 1.5) { this.clickFlushAccum = 0; void this.flushClicks(); }
        if (this.econReconcileAccum >= 8) { this.econReconcileAccum = 0; void this.reconcileEconomy(); }
      }
    }
  }

  updateStats(): void {
    const g = this.game;
    this.setText('stat-money', formatMoney(g.company.money.amount));
    this.setText('stat-mps', formatRate(g.getPerSecond()));
    this.setText('click-value', formatMoney(g.getClickValue()));
    this.setText('stat-employees', formatNumber(g.getEmployeeCount()));
    this.setText('stat-buildings', formatNumber(g.getBuildingCount()));
    this.setText('stat-valuation', formatMoney(g.getValuation()));
    this.setText('stat-influence', formatNumber(g.player.prestigePoints));

    const evtMult = g.getEventMultiplier();
    const badge = this.$('event-mult');
    if (evtMult > 1) {
      badge.hidden = false;
      badge.textContent = `🔥 ×${formatNumber(evtMult)}`;
    } else {
      badge.hidden = true;
    }
    this.setText('research-points', formatNumber(g.company.research.amount));
    this.setText('research-rate', formatNumber(g.getResearchPerSecond(), 1));
    this.updateDaily();
    this.refreshMilestone();
  }

  updateDaily(): void {
    const btn = this.$('daily-bonus') as HTMLButtonElement;
    const g = this.game;
    btn.hidden = false;
    if (g.canClaimDaily()) {
      btn.disabled = false;
      btn.classList.add('ready');
      btn.textContent = '🎁 Tagesbonus abholen';
    } else {
      btn.disabled = true;
      btn.classList.remove('ready');
      btn.textContent = `🎁 Tagesbonus in ${formatTime(g.secondsUntilDaily())}`;
    }
  }

  handleDaily(): void {
    void this.econAction(
      () => this.game.onlineManager.econDaily(),
      (resp) => { if (resp.reward) { this.playSound(880); this.bus.emit('daily:claimed', resp.reward); } },
    );
  }

  refreshMilestone(): void {
    const next = this.game.worlds.find((w) => !w.unlocked && w.unlockAt);
    const label = this.$('milestone-label');
    const fill = this.$('milestone-fill');
    if (!next) {
      label.textContent = 'Alle Welten erschlossen 🌌';
      fill.style.width = '100%';
      return;
    }
    const at = next.unlockAt as number;
    const pct = Math.min(100, (this.game.player.lifetimeEarned / at) * 100);
    label.textContent = `Nächste Welt: ${next.icon} ${next.name} — ${pct.toFixed(1)} %`;
    fill.style.width = pct + '%';
  }

  refreshBoosts(): void {
    const container = this.$('boosts');
    const now = Date.now();
    const items = this.game.eventManager.active.map((e) => ({
      name: e.name, mult: e.multiplier, left: Math.max(0, Math.ceil((e.expiresAt - now) / 1000)),
    }));
    if (now < this.game.clickFrenzy.until) {
      items.unshift({ name: '⚡ Klick-Rausch', mult: this.game.clickFrenzy.mult, left: Math.ceil((this.game.clickFrenzy.until - now) / 1000) });
    }
    if (items.length === 0) { container.innerHTML = ''; return; }
    container.innerHTML = items.map((i) =>
      `<div class="boost">${i.name} <span>×${i.mult} · ${i.left}s</span></div>`).join('');
  }

  // === Clicking ===========================================================
  handleClick(clientX?: number, clientY?: number): void {
    // Optimistic: credit the local mirror instantly for snappy feedback, and
    // buffer the click to send to the server as a batch (which is the source of
    // truth — it re-credits at the server click value, rate-limited).
    const value = this.game.click();
    this.pendingClicks++;
    this.clickButton.classList.remove('pop');
    void this.clickButton.offsetWidth; // restart animation
    this.clickButton.classList.add('pop');
    const rect = this.floatLayer.getBoundingClientRect();
    // Fall back to the button centre when there are no pointer coords (keyboard).
    const x = (clientX ?? rect.left + rect.width / 2) - rect.left;
    const y = (clientY ?? rect.top + rect.height / 2) - rect.top;
    this.spawnFloat(x, y, '+' + formatMoney(value));
    this.playSound(440, 0.05);
  }

  spawnFloat(x: number, y: number, text: string): void {
    // Cap concurrent float numbers so heavy spam-tapping never piles up DOM nodes.
    if (this.floatLayer.childElementCount > 24) this.floatLayer.firstElementChild?.remove();
    const span = document.createElement('span');
    span.className = 'float-num';
    span.textContent = text;
    span.style.left = x + 'px';
    span.style.top = y + 'px';
    this.floatLayer.appendChild(span);
    setTimeout(() => span.remove(), 1100);
  }

  // === Economy sync (server-authoritative) ================================
  /**
   * Mirror an authoritative server save into the local Game. Device-local prefs
   * (name, mute, buy quantity) are preserved, and not-yet-flushed optimistic
   * clicks are re-applied so the balance never visibly dips under spam.
   * With `emitTransitions`, newly-unlocked worlds / achievements / completed
   * quests fire their usual events (toasts + targeted rebuilds). The initial
   * load passes `false` to avoid a flood of "unlocked!" toasts on every login.
   */
  mirrorEconomy(save: SaveState, emitTransitions = true): void {
    const g = this.game;
    const preWorlds = emitTransitions ? new Set(g.worlds.filter((w) => w.unlocked).map((w) => w.id)) : null;
    const preAch = emitTransitions ? new Set(g.achievements.filter((a) => a.unlocked).map((a) => a.id)) : null;
    const preQuest = emitTransitions ? new Set(g.quests.filter((q) => q.completed).map((q) => q.id)) : null;

    g.applySave(save);
    this.applyPrefs();
    if (this.pendingClicks > 0) g.company.money.add(this.pendingClicks * g.getClickValue());

    if (emitTransitions) {
      for (const w of g.worlds) if (w.unlocked && !preWorlds!.has(w.id)) this.bus.emit('world:unlocked', { world: w });
      for (const a of g.achievements) if (a.unlocked && !preAch!.has(a.id)) this.bus.emit('achievement:unlocked', { achievement: a });
      for (const q of g.quests) if (q.completed && !preQuest!.has(q.id)) this.bus.emit('quest:complete', { quest: q });
    }
  }

  /** Send buffered clicks to the server and reconcile the returned save. */
  private async flushClicks(): Promise<void> {
    const om = this.game.onlineManager;
    if (!om.usingServer || this.pendingClicks <= 0) return;
    const n = this.pendingClicks;
    this.pendingClicks = 0;
    try { const resp = await om.econClick(n); this.mirrorEconomy(resp.save); }
    catch (e) { this.pendingClicks += n; this.econBackoff(e); } // keep clicks for a retry
  }

  /** Pull a fresh authoritative snapshot (or flush pending clicks first). */
  private async reconcileEconomy(): Promise<void> {
    const om = this.game.onlineManager;
    if (!om.usingServer) return;
    if (this.pendingClicks > 0) { await this.flushClicks(); return; }
    try { const resp = await om.fetchEconomy(); this.mirrorEconomy(resp.save); }
    catch (e) { this.econBackoff(e); } // keep extrapolating locally until the next sync
  }

  /** After a failed sync, pause economy polling — longer when rate-limited (429). */
  private econBackoff(e: unknown): void {
    const http = (e as { http?: number }).http;
    this.econBackoffUntil = Date.now() + (http === 429 ? 30_000 : 5_000);
  }

  /** Run a server economy action, mirror the result, and surface failures. */
  private async econAction(call: () => Promise<any>, onOk?: (resp: any) => void): Promise<void> {
    try {
      const resp = await call();
      this.mirrorEconomy(resp.save);
      onOk?.(resp);
    } catch (e) {
      this.notify.show({ title: 'Aktion fehlgeschlagen', text: (e as Error).message, icon: '⚠️', kind: 'error' });
    }
  }

  // === Shop (assets of active world) ======================================
  buildShop(): void {
    const world = this.game.getActiveWorld();
    if (!world) return;
    this.setText('world-banner-icon', world.icon);
    this.setText('world-banner-name', world.name);
    this.setText('world-banner-desc', world.description);
    this.setText('click-icon', world.icon);

    this.shopList.innerHTML = '';
    this.shopRows = [];
    for (const asset of world.assets) {
      const row = document.createElement('button');
      row.className = 'asset-row';
      row.innerHTML = `
        <span class="asset-icon">${asset.icon}</span>
        <span class="asset-main">
          <span class="asset-name">${asset.name}</span>
          <span class="asset-desc">${asset.description}</span>
          <span class="asset-prod"></span>
        </span>
        <span class="asset-buy">
          <span class="asset-cost"></span>
          <span class="asset-count"></span>
        </span>`;
      row.addEventListener('click', () => this.handleBuyAsset(asset.id));
      this.shopList.appendChild(row);
      this.shopRows.push({
        asset, row,
        costEl: row.querySelector<HTMLElement>('.asset-cost')!,
        countEl: row.querySelector<HTMLElement>('.asset-count')!,
        prodEl: row.querySelector<HTMLElement>('.asset-prod')!,
      });
    }
    this.refreshShopRows();
  }

  handleBuyAsset(id: string): void {
    const q = this.game.settings.buyQuantity;
    void this.econAction(
      () => this.game.onlineManager.econBuyAsset(id, q === 'max' ? 'max' : Number(q)),
      (resp) => { if (resp.ok) { this.playSound(520, 0.05); this.refreshShopRows(); this.rebuildUpgrades(); } },
    );
  }

  refreshShopRows(): void {
    const g = this.game;
    const money = g.company.money.amount;
    const q = g.settings.buyQuantity;
    const meta = g.company.globalMultiplier * g.player.prestigeMultiplier * g.getEventMultiplier();
    for (const r of this.shopRows) {
      const maxAff = r.asset.getMaxAffordable(money);
      const qty = q === 'max' ? Math.max(1, maxAff) : Number(q);
      const cost = r.asset.getCost(qty);
      const affordable = q === 'max' ? maxAff >= 1 : money >= cost;
      const unit = r.asset.getUnitProduction() * r.asset.world.productionMultiplier *
        r.asset.world.upgradeMultiplier * meta;

      r.costEl.textContent = formatMoney(cost) + (q !== '1' ? ` ·${qty}×` : '');
      r.countEl.textContent = r.asset.count > 0 ? `×${r.asset.count}` : '';
      r.prodEl.textContent = r.asset.count > 0
        ? `${formatRate(unit)} · Σ ${formatRate(unit * r.asset.count)}`
        : `${formatRate(unit)} pro Stück`;
      r.row.classList.toggle('affordable', affordable);
    }
  }

  // === Upgrades ===========================================================
  rebuildUpgrades(): void {
    const container = this.$('upgrades-list');
    const g = this.game;
    const available = g.upgrades
      .filter((u) => !u.purchased && u.isUnlocked(g))
      .sort((a, b) => a.cost - b.cost);

    const groups = new Map<UpgradeCategory, Upgrade[]>();
    for (const u of available) {
      if (!groups.has(u.category)) groups.set(u.category, []);
      groups.get(u.category)!.push(u);
    }

    if (available.length === 0) {
      container.innerHTML = '<p class="empty">Aktuell keine Upgrades verfügbar — kaufe mehr Assets, um neue freizuschalten.</p>';
      this.upgradeRows = [];
      return;
    }

    container.innerHTML = '';
    this.upgradeRows = [];
    for (const [cat, ups] of groups) {
      const section = document.createElement('div');
      section.className = 'upgrade-group';
      section.innerHTML = `<h3>${UPGRADE_CATEGORIES[cat] ?? cat}</h3>`;
      const grid = document.createElement('div');
      grid.className = 'upgrade-grid';
      for (const u of ups) {
        const card = document.createElement('button');
        card.className = 'upgrade-card' + (u.rare ? ' rare' : '');
        card.innerHTML = `
          <span class="up-icon">${u.icon}</span>
          <span class="up-name">${u.name}</span>
          <span class="up-desc">${u.description}</span>
          <span class="up-cost">${formatMoney(u.cost)}</span>`;
        card.addEventListener('click', () => this.handleBuyUpgrade(u.id));
        grid.appendChild(card);
        this.upgradeRows.push({ upgrade: u, el: card });
      }
      section.appendChild(grid);
      container.appendChild(section);
    }
    this.refreshUpgradesAfford();
  }

  refreshUpgradesAfford(): void {
    const money = this.game.company.money.amount;
    for (const r of this.upgradeRows) {
      r.el.classList.toggle('affordable', money >= r.upgrade.cost);
    }
  }

  private handleBuyUpgrade(id: string): void {
    void this.econAction(
      () => this.game.onlineManager.econBuyUpgrade(id),
      (resp) => { if (resp.ok) { const u = this.game.getUpgrade(id); if (u) this.bus.emit('upgrade:bought', { upgrade: u }); } },
    );
  }

  // === Worlds =============================================================
  buildWorlds(): void {
    const container = this.$('worlds-list');
    container.innerHTML = '';
    this.worldCards = new Map();
    for (const w of this.game.worlds) {
      const card = document.createElement('div');
      card.className = 'world-card';
      if (w.id === this.game.activeWorldId) card.classList.add('active');
      if (!w.unlocked) card.classList.add('locked');

      if (w.unlocked) {
        card.innerHTML = `
          <div class="world-icon">${w.icon}</div>
          <div class="world-info">
            <div class="world-name">${w.name}</div>
            <div class="world-desc">${w.description}</div>
            <div class="world-stats">${w.getTotalAssetCount()} Assets · ${formatRate(w.getProduction() * this.game.company.globalMultiplier * this.game.player.prestigeMultiplier)}</div>
          </div>
          <button class="world-select">${w.id === this.game.activeWorldId ? 'Aktiv' : 'Betreten'}</button>`;
        card.querySelector('.world-select')!.addEventListener('click', () => this.handleSetWorld(w.id));
      } else {
        card.innerHTML = `
          <div class="world-icon">🔒</div>
          <div class="world-info">
            <div class="world-name">${w.name}</div>
            <div class="world-desc">${w.unlockHint}</div>
            <div class="world-progress"><div class="world-progress-fill"></div></div>
          </div>`;
      }
      container.appendChild(card);
      this.worldCards.set(w.id, card);
    }
    this.refreshWorldsProgress();
  }

  refreshWorldsProgress(): void {
    const g = this.game;
    const meta = g.company.globalMultiplier * g.player.prestigeMultiplier;
    for (const w of g.worlds) {
      const card = this.worldCards.get(w.id);
      if (!card) continue;
      if (w.unlocked) {
        const stats = card.querySelector('.world-stats');
        if (stats) stats.textContent = `${w.getTotalAssetCount()} Assets · ${formatRate(w.getProduction() * meta)}`;
      } else if (w.unlockAt) {
        const fill = card.querySelector<HTMLElement>('.world-progress-fill');
        if (fill) fill.style.width = Math.min(100, (g.player.lifetimeEarned / w.unlockAt) * 100) + '%';
      }
    }
  }

  private handleSetWorld(id: string): void {
    void this.econAction(
      () => this.game.onlineManager.econSetWorld(id),
      (resp) => { if (resp.ok) { const w = this.game.getWorld(id); if (w) this.bus.emit('world:changed', { world: w }); } },
    );
  }

  // === Quests =============================================================
  buildQuests(): void {
    const container = this.$('quests-list');
    this.questRows = [];
    container.innerHTML = '';
    for (const q of this.game.quests) {
      const row = document.createElement('div');
      row.className = 'quest-card';
      row.innerHTML = `
        <div class="quest-icon">${q.icon}</div>
        <div class="quest-main">
          <div class="quest-name">${q.name}</div>
          <div class="quest-desc">${q.description}</div>
          <div class="quest-bar"><div class="quest-fill"></div></div>
          <div class="quest-meta"><span class="quest-prog"></span><span class="quest-reward">${q.rewardText()}</span></div>
        </div>
        <button class="quest-claim">Einlösen</button>`;
      row.querySelector('.quest-claim')!.addEventListener('click', () => this.handleClaimQuest(q.id));
      container.appendChild(row);
      this.questRows.push({
        quest: q, row,
        fill: row.querySelector<HTMLElement>('.quest-fill')!,
        prog: row.querySelector<HTMLElement>('.quest-prog')!,
        btn: row.querySelector<HTMLButtonElement>('.quest-claim')!,
      });
    }
    this.refreshQuests();
  }

  refreshQuests(): void {
    if (!this.questRows) return;
    for (const r of this.questRows) {
      const cur = r.quest.current(this.game);
      const pct = Math.min(100, (cur / r.quest.goal) * 100);
      r.fill.style.width = pct + '%';
      r.prog.textContent = `${formatNumber(Math.min(cur, r.quest.goal))} / ${formatNumber(r.quest.goal)} ${r.quest.unit}`;
      r.row.classList.toggle('complete', r.quest.completed && !r.quest.claimed);
      r.row.classList.toggle('claimed', r.quest.claimed);
      r.btn.disabled = !r.quest.completed || r.quest.claimed;
      r.btn.textContent = r.quest.claimed ? '✓ Eingelöst' : (r.quest.completed ? 'Einlösen' : 'Offen');
    }
  }

  private handleClaimQuest(id: string): void {
    void this.econAction(
      () => this.game.onlineManager.econClaimQuest(id),
      (resp) => { if (resp.ok) { const q = this.game.quests.find((x) => x.id === id); if (q) this.bus.emit('quest:claimed', { quest: q }); } },
    );
  }

  // === Research ===========================================================
  buildResearch(): void {
    const container = this.$('research-tree');
    const g = this.game;
    container.innerHTML = '';
    this.researchRows = [];
    for (const ru of g.researchUpgradeDefs) {
      const owned = g.player.researchUpgrades.has(ru.id);
      const available = g.isResearchAvailable(ru.id);
      const card = document.createElement('button');
      card.className = 'research-card' + (owned ? ' owned' : available ? '' : ' locked');
      card.innerHTML = `
        <span class="up-icon">${ru.icon ?? '🔬'}</span>
        <span class="up-name">${ru.name}</span>
        <span class="up-desc">${ru.description ?? ''}</span>
        <span class="up-cost">${owned ? '✓ Erforscht' : (available ? `🔬 ${formatNumber(ru.cost)} FP` : '🔒 Voraussetzung fehlt')}</span>`;
      if (!owned && available) card.addEventListener('click', () => this.handleBuyResearch(ru.id));
      container.appendChild(card);
      this.researchRows.push({ def: ru, el: card });
    }
    this.refreshResearch();
  }

  refreshResearch(): void {
    if (!this.researchRows.length) return;
    const rp = this.game.company.research.amount;
    for (const r of this.researchRows) {
      const owned = this.game.player.researchUpgrades.has(r.def.id);
      const available = this.game.isResearchAvailable(r.def.id);
      r.el.classList.toggle('affordable', !owned && available && rp >= r.def.cost);
    }
  }

  private handleBuyResearch(id: string): void {
    void this.econAction(
      () => this.game.onlineManager.econResearch(id),
      (resp) => { if (resp.ok) this.bus.emit('research:bought', { id }); },
    );
  }

  // === Golden Deals =======================================================
  spawnGolden(deal: GoldenActive): void {
    this.removeGolden();
    const el = document.createElement('button');
    el.className = 'golden-deal';
    el.textContent = '💎';
    el.title = 'Goldener Deal — schnell anklicken!';
    el.style.left = (10 + Math.random() * 70) + '%';
    el.style.top = (15 + Math.random() * 60) + '%';
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const result = this.game.clickGolden(deal.id);
      this.removeGolden();
      if (result) {
        const text = result.type === 'lucky' ? '+' + formatMoney(result.amount ?? 0) : result.text;
        this.notify.show({ title: result.title, text, icon: '💎', kind: 'rare', duration: 5000 });
        this.playSound(1200, 0.12);
      }
    });
    document.body.appendChild(el);
    this.goldenEl = el;
  }

  removeGolden(): void {
    if (this.goldenEl) { this.goldenEl.remove(); this.goldenEl = null; }
  }

  // === Prestige ===========================================================
  rebuildPrestige(): void {
    const g = this.game;
    const container = this.$('prestige-content');
    const gain = g.player.computePrestigeGain();
    const bonusPct = ((g.player.prestigeMultiplier - 1) * 100).toFixed(0);

    container.innerHTML = `
      <div class="prestige-hero">
        <div class="prestige-big">📈 Börsengang</div>
        <p>Setze dein Unternehmen zurück und wandle dein Lebenswerk in <b>Einfluss</b> um.
           Jeder Einfluss-Punkt gibt dauerhaft <b>+2 %</b> auf alle Einnahmen.</p>
        <div class="prestige-grid">
          <div><span class="pl">Aktueller Einfluss</span><span class="pv">${formatNumber(g.player.prestigePoints)}</span></div>
          <div><span class="pl">Prestige-Bonus</span><span class="pv">+${bonusPct} %</span></div>
          <div><span class="pl">Börsengänge</span><span class="pv">${g.player.prestigeLevel}</span></div>
          <div><span class="pl">Gewinn bei Reset</span><span class="pv">+${formatNumber(gain)}</span></div>
        </div>
        <button id="do-prestige" class="btn-prestige" ${gain < 1 ? 'disabled' : ''}>
          ${gain < 1 ? 'Noch zu klein (mind. €1 Bio. nötig)' : `An die Börse gehen → +${formatNumber(gain)} Einfluss`}
        </button>
      </div>
      <h3>Prestige-Upgrades (dauerhaft)</h3>
      <div class="prestige-shop" id="prestige-shop"></div>`;

    container.querySelector('#do-prestige')!.addEventListener('click', () => this.confirmPrestige());

    const shop = container.querySelector('#prestige-shop')!;
    for (const pu of g.prestigeUpgradeDefs) {
      const owned = g.player.prestigeUpgrades.has(pu.id);
      const affordable = g.player.prestigePoints >= pu.cost;
      const card = document.createElement('button');
      card.className = 'prestige-card' + (owned ? ' owned' : affordable ? ' affordable' : '');
      card.disabled = owned;
      card.innerHTML = `
        <span class="up-icon">${pu.icon}</span>
        <span class="up-name">${pu.name}</span>
        <span class="up-desc">${pu.description}</span>
        <span class="up-cost">${owned ? '✓ Im Besitz' : `💠 ${pu.cost} Einfluss`}</span>`;
      if (!owned) card.addEventListener('click', () => this.handlePrestigeUpgrade(pu.id));
      shop.appendChild(card);
    }
  }

  private handlePrestigeUpgrade(id: string): void {
    void this.econAction(
      () => this.game.onlineManager.econPrestigeUpgrade(id),
      (resp) => { if (resp.ok) this.bus.emit('prestige:upgrade', { id }); },
    );
  }

  confirmPrestige(): void {
    const gain = this.game.player.computePrestigeGain();
    this.openModal(`
      <h2>📈 Börsengang bestätigen</h2>
      <p>Dein Unternehmen wird zurückgesetzt: Kapital, Assets und normale Upgrades gehen verloren.
         Welten, Erfolge und Prestige-Upgrades bleiben erhalten.</p>
      <p>Du erhältst <b>+${formatNumber(gain)} Einfluss</b> (dauerhaft +${gain * 2} % Einnahmen).</p>
      <div class="modal-actions">
        <button class="btn-ghost" data-act="cancel">Abbrechen</button>
        <button class="btn-prestige" data-act="confirm">Jetzt an die Börse</button>
      </div>`);
    const m = this.$('modal-layer');
    (m.querySelector('[data-act="cancel"]') as HTMLElement).onclick = () => this.closeModal();
    (m.querySelector('[data-act="confirm"]') as HTMLElement).onclick = () => {
      const before = this.game.player.prestigePoints;
      void this.econAction(
        () => this.game.onlineManager.econPrestige(),
        (resp) => { if (resp.ok) this.bus.emit('prestige:done', { gain: this.game.player.prestigePoints - before }); },
      );
      this.closeModal();
    };
  }

  // === Achievements =======================================================
  buildAchievements(): void {
    const container = this.$('achievements-list');
    const unlocked = this.game.achievements.filter((a) => a.unlocked).length;
    this.setText('ach-progress', `${unlocked}/${this.game.achievements.length}`);
    container.innerHTML = '';
    for (const a of this.game.achievements) {
      const card = document.createElement('div');
      card.className = 'ach-card' + (a.unlocked ? ' unlocked' : '');
      card.innerHTML = `
        <div class="ach-icon">${a.unlocked ? a.icon : '🔒'}</div>
        <div class="ach-name">${a.name}</div>
        <div class="ach-desc">${a.description}</div>
        <div class="ach-bonus">+${((a.bonus - 1) * 100).toFixed(0)} % Einnahmen</div>`;
      container.appendChild(card);
    }
  }

  // === News / Updates =====================================================
  /** Entries sorted newest-first by announcement date (stable on ties). */
  private sortedNews(): NewsEntry[] {
    return [...NEWS_ENTRIES].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  private lastSeenNewsId(): string | null {
    try { return localStorage.getItem(this.newsSeenKey); } catch { return null; }
  }

  /** How many entries are newer than the one the player last acknowledged. */
  unseenNewsCount(): number {
    const list = this.sortedNews();
    const seen = this.lastSeenNewsId();
    if (!seen) return list.length;
    const idx = list.findIndex((n) => n.id === seen);
    return idx < 0 ? list.length : idx;
  }

  /** Remember the newest entry as seen, so the unread badge clears. */
  private markNewsSeen(): void {
    const newest = this.sortedNews()[0];
    if (newest) { try { localStorage.setItem(this.newsSeenKey, newest.id); } catch { /* private mode — ignore */ } }
  }

  updateNewsBadge(): void {
    const badge = this.$('news-badge');
    const n = this.unseenNewsCount();
    badge.hidden = n === 0;
    if (n > 0) badge.textContent = n > 9 ? '9+' : String(n);
  }

  /** Auto-open once on boot when there's unseen news and no other modal is up. */
  maybeAutoShowNews(): void {
    if (this.unseenNewsCount() > 0 && this.$('modal-layer').hidden) this.openNews();
  }

  openNews(): void {
    const list = this.sortedNews();
    const seen = this.lastSeenNewsId();
    const seenIdx = seen ? list.findIndex((n) => n.id === seen) : -1;
    const unread = (n: NewsEntry): boolean => seenIdx < 0 || list.indexOf(n) < seenIdx;

    const card = (n: NewsEntry): string => {
      const meta = NEWS_TYPE_META[n.type];
      const items = n.items.map((t) => `<li>${escapeHtml(t)}</li>`).join('');
      return `
        <article class="news-entry ${n.type}${unread(n) ? ' unread' : ''}">
          <div class="news-entry-head">
            <span class="news-entry-icon">${meta.icon}</span>
            <span class="news-entry-title">${escapeHtml(n.title)}</span>
            ${n.tag ? `<span class="news-tag">${escapeHtml(n.tag)}</span>` : ''}
            <span class="news-entry-date">${escapeHtml(formatDate(n.date))}</span>
          </div>
          ${n.eta ? `<span class="news-eta">⏳ ${escapeHtml(n.eta)}</span>` : ''}
          <ul class="news-items">${items}</ul>
        </article>`;
    };

    const upcoming = list.filter((n) => n.type === 'upcoming');
    const history = list.filter((n) => n.type !== 'upcoming');
    this.openModal(`
      <h2>📰 Neuigkeiten</h2>
      ${upcoming.length ? `<h3>🔜 Bald verfügbar</h3><div class="news-list">${upcoming.map(card).join('')}</div>` : ''}
      <h3>📋 Änderungsverlauf</h3>
      <div class="news-list">${history.map(card).join('')}</div>
      <div class="modal-actions">
        <button class="btn-prestige" data-act="close">Alles klar</button>
      </div>`);
    (this.$('modal-layer').querySelector('[data-act="close"]') as HTMLElement).onclick = () => this.closeModal();

    // Mark as read after rendering (so the "neu" markers still show this time).
    this.markNewsSeen();
    this.updateNewsBadge();
  }

  // === Online =============================================================
  buildOnline(): void {
    const container = this.$('online-content');
    const om = this.game.onlineManager;
    const s = om.session;
    const status = s.mode === 'offline' ? 'Nicht angemeldet' :
      `${s.mode === 'guest' ? 'Gast' : 'Konto'}: ${escapeHtml(s.username ?? '')}`;
    const transport = om.usingServer ? ('🟢 Mit Server verbunden' + (om.isLive ? ' · ⚡ Live (WebSocket)' : ''))
      : om.serverReachable === false ? '🟡 Server offline – Simulation'
      : om.hasServer() ? '⚪ Server konfiguriert' : '⚪ Nur Simulation';

    const account = s.mode === 'account';
    const verifyPill = account
      ? (s.emailVerified ? ' <span class="verify-pill ok">✓ verifiziert</span>' : ' <span class="verify-pill">E-Mail offen</span>')
      : '';
    // Verification prompt only for real server accounts that aren't verified yet.
    const needsVerify = account && om.usingServer && s.emailVerified === false;

    container.innerHTML = `
      <div class="online-status">
        <div>Status: <b>${status}</b>${verifyPill}</div>
        <div class="online-transport">${transport}${om.hasServer() ? ` · <code>${escapeHtml(om.serverUrl)}</code>` : ''}</div>
      </div>
      ${needsVerify ? `<div class="verify-banner">
        <span>📧 Bestätige deine E-Mail, um dein Konto abzusichern.</span>
        <span class="verify-actions">
          <button data-act="verify" class="btn-ghost small">Bestätigen</button>
          <button data-act="resend" class="btn-ghost small">Erneut senden</button>
        </span>
      </div>` : ''}
      <div class="online-actions">
        ${s.mode === 'offline'
          ? `<button data-act="auth">🔐 Anmelden / Registrieren</button>
             <button data-act="guest" class="btn-ghost">Als Gast spielen</button>`
          : `<button data-act="logout" class="btn-ghost">Abmelden</button>`}
        <button data-act="server" class="btn-ghost">Server …</button>
      </div>
      <h3>🏆 Bestenliste (Firmenwert)</h3>
      <button data-act="refresh" class="btn-ghost small">Aktualisieren</button>
      <div id="leaderboard" class="leaderboard"><p class="empty">Lade …</p></div>
      ${om.session.isDev ? '<div id="dev-panel"></div>' : ''}`;

    const on = (act: string, fn: () => void): void => {
      const btn = container.querySelector(`[data-act="${act}"]`);
      if (btn) btn.addEventListener('click', fn);
    };
    on('guest', async () => { try { await om.loginAsGuest(); } catch { /* sim fallback handles it */ } this.refreshLeaderboard(); });
    on('auth', () => this.openAuthModal());
    on('verify', () => this.openVerifyModal());
    on('resend', async () => {
      try {
        const r = await om.resendVerification();
        this.notify.show({ title: 'Bestätigungs-E-Mail gesendet', icon: '📧', kind: 'success' });
        if (r?.devVerifyToken) this.notify.show({ title: '🔑 Dev-Token', text: r.devVerifyToken, icon: '🔑', kind: 'info', duration: 10000 });
      } catch (e) { this.notify.show({ title: 'Fehler', text: (e as Error).message, icon: '⚠️', kind: 'error' }); }
    });
    on('logout', () => om.logout());
    on('refresh', () => this.refreshLeaderboard());
    on('server', () => {
      const url = prompt('Server-URL (leer = nur Simulation):', om.serverUrl);
      if (url !== null) { om.setServerUrl(url.trim()); this.buildOnline(); }
    });

    this.refreshLeaderboard();
    if (om.session.isDev) void this.renderDevPanel();
  }

  // === Dev panel (only rendered for the server-defined dev account) ========
  /** The server enforces the dev gate; this menu is just convenience/UX. */
  private async renderDevPanel(): Promise<void> {
    const om = this.game.onlineManager;
    const host = document.getElementById('dev-panel');
    if (!host || !om.session.isDev) return;
    if (!this.lootboxConfig) { try { this.lootboxConfig = await om.fetchLootboxConfig(); } catch { /* item select stays empty */ } }
    const itemOpts = (this.lootboxConfig?.items ?? []).map((it: any) =>
      `<option value="${escapeAttr(it.id)}">${escapeHtml(it.worldName)} · ${escapeHtml(this.rarityMeta(it.rarity).name)} — ${escapeHtml(it.name)}</option>`).join('');
    host.innerHTML = `
      <div class="dev-panel">
        <h3>🛠️ Dev-Werkzeuge</h3>
        <div class="dev-row">
          <input id="dev-money" type="number" min="0" step="1" value="1000000">
          <button class="btn-ghost small" data-act="dev-money">💰 Geld gutschreiben</button>
        </div>
        <div class="dev-row">
          <select id="dev-item">${itemOpts}</select>
          <input id="dev-item-n" type="number" min="1" step="1" value="1">
          <button class="btn-ghost small" data-act="dev-item">🎁 Item</button>
        </div>
        <div class="dev-row">
          <button class="btn-ghost small" data-act="dev-reset">♻️ Account zurücksetzen</button>
        </div>
      </div>`;

    host.querySelector('[data-act="dev-money"]')!.addEventListener('click', async () => {
      const amount = Number((host.querySelector('#dev-money') as HTMLInputElement).value);
      try {
        await om.devGrantMoney(amount);
        await this.reconcileEconomy();
        this.notify.show({ title: 'Geld gutgeschrieben', text: formatMoney(amount), icon: '💰', kind: 'success' });
      } catch (e) { this.notify.show({ title: 'Dev-Fehler', text: (e as Error).message, icon: '⚠️', kind: 'error' }); }
    });
    host.querySelector('[data-act="dev-item"]')!.addEventListener('click', async () => {
      const itemId = (host.querySelector('#dev-item') as HTMLSelectElement).value;
      const count = Math.max(1, Math.floor(Number((host.querySelector('#dev-item-n') as HTMLInputElement).value)) || 1);
      try {
        const r = await om.devGrantItem(itemId, count);
        if (r.items) this.lootboxItems = r.items;
        if (this.activeTab === 'lootbox') this.renderLootboxInventory();
        this.notify.show({ title: 'Item gutgeschrieben', text: `${this.itemName(itemId)} ×${count}`, icon: '🎁', kind: 'success' });
      } catch (e) { this.notify.show({ title: 'Dev-Fehler', text: (e as Error).message, icon: '⚠️', kind: 'error' }); }
    });
    host.querySelector('[data-act="dev-reset"]')!.addEventListener('click', () => this.confirmDevReset());
  }

  private confirmDevReset(): void {
    this.openModal(`
      <h2>♻️ Dev: Account zurücksetzen?</h2>
      <p>Setzt <b>Ökonomie</b> (Geld, Assets, Upgrades, Prestige) und das gesamte <b>Inventar</b>
         (Rohstoffe + Prestige-Items) dieses Dev-Accounts auf null zurück.</p>
      <div class="modal-actions">
        <button class="btn-ghost" data-act="cancel">Abbrechen</button>
        <button class="btn-prestige" data-act="confirm">Zurücksetzen</button>
      </div>`);
    const m = this.$('modal-layer');
    (m.querySelector('[data-act="cancel"]') as HTMLElement).onclick = () => this.closeModal();
    (m.querySelector('[data-act="confirm"]') as HTMLElement).onclick = async () => {
      try {
        await this.game.onlineManager.devReset();
        this.lootboxItems = {};
        const fresh = await this.game.onlineManager.fetchEconomy();
        this.mirrorEconomy(fresh.save, false);
        this.refreshAll();
        if (this.activeTab === 'lootbox') void this.buildLootbox();
        this.notify.show({ title: 'Account zurückgesetzt', icon: '♻️', kind: 'success' });
      } catch (e) { this.notify.show({ title: 'Dev-Fehler', text: (e as Error).message, icon: '⚠️', kind: 'error' }); }
      this.closeModal();
    };
  }

  /** Small helper: write a status line into an open auth modal. */
  private authMsg(text: string, kind: 'error' | 'ok' = 'error'): void {
    const el = this.$('modal-layer').querySelector('#auth-msg') as HTMLElement | null;
    if (el) { el.hidden = false; el.textContent = text; el.className = 'auth-msg ' + kind; }
  }

  /** Login / Register modal (replaces the old prompt() flow). */
  openAuthModal(): void {
    const om = this.game.onlineManager;
    this.openModal(`
      <h2>🔐 Konto</h2>
      <div class="auth-tabs">
        <button data-atab="login" class="active">Anmelden</button>
        <button data-atab="register">Registrieren</button>
      </div>
      <div data-aview="login">
        <label class="field"><span>Benutzername oder E-Mail</span><input id="a-login-id" type="text" autocomplete="username"></label>
        <label class="field"><span>Passwort</span><input id="a-login-pw" type="password" autocomplete="current-password"></label>
        <div class="modal-actions">
          <button class="btn-ghost" data-act="forgot">Passwort vergessen?</button>
          <button class="btn-prestige" data-act="do-login">Anmelden</button>
        </div>
      </div>
      <div data-aview="register" hidden>
        <label class="field"><span>Benutzername (3–20 Zeichen)</span><input id="a-reg-name" type="text" autocomplete="username"></label>
        <label class="field"><span>E-Mail</span><input id="a-reg-email" type="email" autocomplete="email"></label>
        <label class="field"><span>Passwort (min. 8 Zeichen)</span><input id="a-reg-pw" type="password" autocomplete="new-password"></label>
        <div class="modal-actions"><button class="btn-prestige" data-act="do-register">Konto erstellen</button></div>
      </div>
      <div id="auth-msg" class="auth-msg" hidden></div>`);

    const m = this.$('modal-layer');
    const val = (sel: string): string => (m.querySelector(sel) as HTMLInputElement).value.trim();
    m.querySelectorAll<HTMLElement>('[data-atab]').forEach((b) => b.addEventListener('click', () => {
      const name = b.dataset.atab;
      m.querySelectorAll<HTMLElement>('[data-atab]').forEach((x) => x.classList.toggle('active', x === b));
      m.querySelectorAll<HTMLElement>('[data-aview]').forEach((v) => { v.hidden = v.dataset.aview !== name; });
      this.authMsg('', 'ok'); (m.querySelector('#auth-msg') as HTMLElement).hidden = true;
    }));
    (m.querySelector('[data-act="do-login"]') as HTMLElement).onclick = async () => {
      const id = val('#a-login-id'), pw = (m.querySelector('#a-login-pw') as HTMLInputElement).value;
      if (!id || !pw) return this.authMsg('Bitte beide Felder ausfüllen.');
      try { await om.login(id, pw); this.closeModal(); this.buildOnline(); this.refreshLeaderboard(); this.notify.show({ title: 'Angemeldet', icon: '✅', kind: 'success' }); }
      catch (e) { this.authMsg((e as Error).message); }
    };
    (m.querySelector('[data-act="do-register"]') as HTMLElement).onclick = async () => {
      const name = val('#a-reg-name'), email = val('#a-reg-email'), pw = (m.querySelector('#a-reg-pw') as HTMLInputElement).value;
      try { await om.register(name, email, pw); this.closeModal(); this.buildOnline(); this.refreshLeaderboard(); this.notify.show({ title: 'Konto erstellt', text: 'Bitte E-Mail bestätigen.', icon: '🎉', kind: 'success', duration: 6000 }); }
      catch (e) { this.authMsg((e as Error).message); }
    };
    (m.querySelector('[data-act="forgot"]') as HTMLElement).onclick = () => this.openForgotModal();
  }

  /** Two-step password reset (request token → set new password). */
  openForgotModal(): void {
    const om = this.game.onlineManager;
    this.openModal(`
      <h2>🔑 Passwort zurücksetzen</h2>
      <p>Fordere einen Reset-Token an (kommt per E-Mail, sobald der Versand aktiv ist), und setze dann ein neues Passwort.</p>
      <label class="field"><span>E-Mail</span><input id="f-email" type="email" autocomplete="email"></label>
      <div class="modal-actions"><button class="btn-prestige" data-act="req">Token anfordern</button></div>
      <hr class="auth-sep">
      <label class="field"><span>Reset-Token</span><input id="f-token" type="text"></label>
      <label class="field"><span>Neues Passwort (min. 8 Zeichen)</span><input id="f-pw" type="password" autocomplete="new-password"></label>
      <div class="modal-actions">
        <button class="btn-ghost" data-act="back">Zurück</button>
        <button class="btn-prestige" data-act="reset">Passwort setzen</button>
      </div>
      <div id="auth-msg" class="auth-msg" hidden></div>`);
    const m = this.$('modal-layer');
    (m.querySelector('[data-act="req"]') as HTMLElement).onclick = async () => {
      const email = (m.querySelector('#f-email') as HTMLInputElement).value.trim();
      if (!email) return this.authMsg('Bitte E-Mail eingeben.');
      try {
        const r = await om.requestPasswordReset(email);
        this.authMsg('Falls ein Konto existiert, wurde ein Token gesendet.', 'ok');
        if (r?.devResetToken) { (m.querySelector('#f-token') as HTMLInputElement).value = r.devResetToken; this.authMsg('Dev: Token automatisch eingefügt.', 'ok'); }
      } catch (e) { this.authMsg((e as Error).message); }
    };
    (m.querySelector('[data-act="reset"]') as HTMLElement).onclick = async () => {
      const token = (m.querySelector('#f-token') as HTMLInputElement).value.trim();
      const pw = (m.querySelector('#f-pw') as HTMLInputElement).value;
      if (!token || !pw) return this.authMsg('Token und neues Passwort nötig.');
      try { await om.resetPassword(token, pw); this.closeModal(); this.buildOnline(); this.notify.show({ title: 'Passwort geändert', icon: '✅', kind: 'success' }); }
      catch (e) { this.authMsg((e as Error).message); }
    };
    (m.querySelector('[data-act="back"]') as HTMLElement).onclick = () => this.openAuthModal();
  }

  /** Confirm e-mail ownership with the verification token. */
  openVerifyModal(): void {
    const om = this.game.onlineManager;
    this.openModal(`
      <h2>📧 E-Mail bestätigen</h2>
      <p>Gib den Bestätigungs-Token aus deiner E-Mail ein (oder fordere ihn erneut an).</p>
      <label class="field"><span>Token</span><input id="v-token" type="text"></label>
      <div class="modal-actions">
        <button class="btn-ghost" data-act="resend">Erneut senden</button>
        <button class="btn-prestige" data-act="do-verify">Bestätigen</button>
      </div>
      <div id="auth-msg" class="auth-msg" hidden></div>`);
    const m = this.$('modal-layer');
    (m.querySelector('[data-act="do-verify"]') as HTMLElement).onclick = async () => {
      const token = (m.querySelector('#v-token') as HTMLInputElement).value.trim();
      if (!token) return this.authMsg('Bitte Token eingeben.');
      try { await om.verifyEmail(token); this.closeModal(); this.buildOnline(); this.notify.show({ title: 'E-Mail bestätigt', icon: '✅', kind: 'success' }); }
      catch (e) { this.authMsg((e as Error).message); }
    };
    (m.querySelector('[data-act="resend"]') as HTMLElement).onclick = async () => {
      try {
        const r = await om.resendVerification();
        this.authMsg('Bestätigungs-E-Mail gesendet.', 'ok');
        if (r?.devVerifyToken) { (m.querySelector('#v-token') as HTMLInputElement).value = r.devVerifyToken; this.authMsg('Dev: Token automatisch eingefügt.', 'ok'); }
      } catch (e) { this.authMsg((e as Error).message); }
    };
  }

  // === Resources: rarity drops (server-authoritative) =====================
  private applyResourceSnapshot(snap: any): void {
    this.resourceState = { resources: snap.resources, energy: snap.energy, buildings: snap.buildings, fetchedAt: Date.now() };
  }

  /** Build/refresh the Rohstoffe tab (locked unless connected to the server). */
  async buildResources(): Promise<void> {
    const container = this.$('resources-content');
    const om = this.game.onlineManager;
    if (!om.usingServer) {
      this.resourceState = null;
      container.innerHTML = `
        <div class="res-locked">
          <p>🔒 Rohstoffe werden durch aktives Sammeln server-seitig erwürfelt (raritätsbasiert).</p>
          <p class="hint">Melde dich mit einem Konto (oder als Gast) an, um zu sammeln.</p>
          <button data-act="res-auth">🔐 Anmelden / Registrieren</button>
        </div>`;
      container.querySelector('[data-act="res-auth"]')?.addEventListener('click', () => this.openAuthModal());
      return;
    }
    try {
      if (!this.resourceConfig) {
        const cfg = await om.fetchResourceConfig();
        this.resourceConfig = cfg;
        cfg.rarities.forEach((r: any, i: number) => { this.rarityColor[r.id] = r.color; this.rarityRank[r.id] = i; });
        for (const w of cfg.worlds) for (const r of w.resources) {
          this.resIconMap[r.type] = r.icon; this.resNameMap[r.type] = r.name; this.resRarity[r.type] = r.rarity;
        }
      }
      this.applyResourceSnapshot(await om.fetchResources());
      this.renderResources();
    } catch (e) {
      container.innerHTML = `<p class="empty">Rohstoffe konnten nicht geladen werden: ${escapeHtml((e as Error).message)}</p>`;
    }
  }

  private renderResources(): void {
    const cfg = this.resourceConfig, st = this.resourceState;
    if (!cfg || !st) return;
    const container = this.$('resources-content');
    const boosterByWorld: Record<string, any> = {};
    for (const b of cfg.boosters) boosterByWorld[b.world] = b;

    const worldsHtml = cfg.worlds.map((w: any) => {
      const b = boosterByWorld[w.world];
      const tiers = w.resources.map((r: any) =>
        `<span class="tier-dot" title="${escapeHtml(this.rarityName(r.rarity))}: ${escapeHtml(r.name)}" style="background:${this.rarityColor[r.rarity]}"></span>`).join('');
      return `
        <div class="res-world">
          <div class="rw-head"><h3>${escapeHtml(w.name)}</h3><span class="rw-tiers">${tiers}</span></div>
          <div class="energy-row">
            <div class="energy-bar"><div class="energy-fill" data-efill="${w.world}"></div></div>
            <span class="energy-text" data-etext="${w.world}"></span>
          </div>
          <div class="roll-row">
            <button class="roll-btn" data-roll="${w.world}">🎲 Sammeln <small>(1 ⚡)</small></button>
            <div class="drop-reveal" data-reveal="${w.world}"></div>
          </div>
          ${b ? `<button class="res-build" data-build="${b.id}">
            <span class="rb-icon">⚡</span>
            <span class="rb-main"><span class="rb-name">${escapeHtml(b.name)}</span>
              <span class="rb-prod">+${b.effect.energyMax} Max-Energie · ×<span data-count="${b.id}">${st.buildings[b.id] ?? 0}</span></span></span>
            <span class="rb-cost" data-cost="${b.id}"></span>
          </button>` : ''}
        </div>`;
    }).join('');

    container.innerHTML = `<div class="res-worlds">${worldsHtml}</div><h3>🎒 Inventar</h3><div id="res-inventory"></div>`;
    container.querySelectorAll<HTMLElement>('[data-roll]').forEach((btn) => btn.addEventListener('click', () => this.handleRoll(btn.dataset.roll!)));
    container.querySelectorAll<HTMLElement>('[data-build]').forEach((btn) => btn.addEventListener('click', () => this.handleBuildResource(btn.dataset.build!)));
    this.renderInventory();
    this.refreshResourceEnergy();
  }

  private rarityName(id: string): string {
    return this.resourceConfig?.rarities.find((r: any) => r.id === id)?.name ?? id;
  }

  /** The owned-resources inventory, coloured + sorted by rarity (rarest first). */
  private renderInventory(): void {
    const st = this.resourceState;
    const host = document.getElementById('res-inventory');
    if (!st || !host) return;
    const owned = Object.entries(st.resources).filter(([, a]) => a > 0)
      .sort((a, b) => (this.rarityRank[this.resRarity[b[0]]] ?? 0) - (this.rarityRank[this.resRarity[a[0]]] ?? 0));
    host.innerHTML = owned.length ? owned.map(([type, amt]) => {
      const col = this.rarityColor[this.resRarity[type]] ?? '#9ca3af';
      return `<div class="inv-chip" style="border-color:${col}">
        <span class="inv-ico">${this.resIconMap[type] ?? '📦'}</span>
        <span class="inv-name" style="color:${col}">${escapeHtml(this.resNameMap[type] ?? type)}</span>
        <b class="inv-amt">${formatNumber(amt)}</b></div>`;
    }).join('') : '<p class="empty">Noch keine Rohstoffe — sammle in einer Welt!</p>';
  }

  private boosterCost(b: any, owned: number): Record<string, number> {
    const f = Math.pow(b.growth ?? 1.6, owned);
    const cost: Record<string, number> = {};
    for (const [t, base] of Object.entries(b.cost)) cost[t] = (base as number) * f;
    return cost;
  }

  /** Per-frame: extrapolate per-world energy + update bars, roll buttons, booster cost. */
  refreshResourceEnergy(): void {
    const cfg = this.resourceConfig, st = this.resourceState;
    if (!cfg || !st) return;
    const container = this.$('resources-content');
    const elapsed = (Date.now() - st.fetchedAt) / 1000;
    const cur: Record<string, number> = {};
    for (const [world, e] of Object.entries(st.energy)) {
      const energy = Math.min(e.max, e.energy + e.regenPerSec * elapsed);
      cur[world] = energy;
      const fill = container.querySelector<HTMLElement>(`[data-efill="${world}"]`);
      if (fill) fill.style.width = Math.max(0, Math.min(100, (energy / e.max) * 100)) + '%';
      const txt = container.querySelector<HTMLElement>(`[data-etext="${world}"]`);
      if (txt) txt.textContent = `${Math.floor(energy)} / ${e.max} ⚡`;
      const btn = container.querySelector<HTMLButtonElement>(`[data-roll="${world}"]`);
      if (btn) btn.disabled = energy < 1;
    }
    for (const b of cfg.boosters) {
      const cost = this.boosterCost(b, st.buildings[b.id] ?? 0);
      const costEl = container.querySelector<HTMLElement>(`[data-cost="${b.id}"]`);
      if (costEl) costEl.innerHTML = Object.entries(cost).map(([t, a]) => `${this.resIconMap[t] ?? ''} ${formatNumber(a)}`).join(' · ');
      const affordable = Object.entries(cost).every(([t, a]) => (st.resources[t] ?? 0) >= a);
      container.querySelector<HTMLElement>(`[data-build="${b.id}"]`)?.classList.toggle('affordable', affordable);
    }
  }

  async handleRoll(world: string): Promise<void> {
    // Throttle to the server's roll rate (5/s) so spam-clicking doesn't fire
    // requests that would just be rejected — and waste the shared rate budget.
    const now = Date.now();
    if (now - this.lastRollAt < 200) return;
    this.lastRollAt = now;
    try {
      const res = await this.game.onlineManager.rollResource(world);
      this.applyResourceSnapshot(res);                 // res spreads the fresh snapshot
      this.showDrop(world, res.drop);
      this.renderInventory();
      this.refreshResourceEnergy();
      this.playSound(res.drop.rarity === 'common' ? 520 : 880, 0.06);
    } catch (e) {
      const msg = (e as Error).message;
      if (!/zu viele|zu schnell/i.test(msg)) this.notify.show({ title: 'Kein Fund', text: msg, icon: '⚡', kind: 'info', duration: 2500 });
    }
  }

  private showDrop(world: string, drop: any): void {
    const slot = this.$('resources-content').querySelector<HTMLElement>(`[data-reveal="${world}"]`);
    if (!slot) return;
    slot.innerHTML = `<span class="drop-item" style="border-color:${drop.color};color:${drop.color}">${drop.icon} ${escapeHtml(drop.name)} +${formatNumber(drop.qty)}</span>`;
    const el = slot.firstElementChild as HTMLElement | null;
    if (el) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
  }

  async handleBuildResource(buildingId: string): Promise<void> {
    try {
      this.applyResourceSnapshot(await this.game.onlineManager.buildResource(buildingId));
      this.renderResources(); // energy cap changed → full refresh
      this.playSound(560, 0.05);
    } catch (e) {
      this.notify.show({ title: 'Booster fehlgeschlagen', text: (e as Error).message, icon: '⚠️', kind: 'error' });
    }
  }

  /** Quietly re-fetch the authoritative snapshot (corrects energy + reflects trades). */
  private async syncResources(): Promise<void> {
    if (!this.game.onlineManager.usingServer) return;
    try { this.applyResourceSnapshot(await this.game.onlineManager.fetchResources()); this.renderInventory(); this.refreshResourceEnergy(); }
    catch { /* offline blip — keep extrapolating */ }
  }

  // === Trading (Phase 3) ==================================================
  private resIcon(t: string): string { return this.resIconMap[t] ?? '📦'; }
  /** Render an escrow bundle { resources, money, items } (tolerates a legacy flat map). */
  private fmtOffer(o: any): string {
    const res = o && typeof o === 'object' && 'resources' in o ? (o.resources ?? {}) : (o ?? {});
    const parts = Object.entries(res).filter(([, a]) => (a as number) > 0)
      .map(([t, a]) => `${this.resIcon(t)} ${formatNumber(a as number)}`);
    const items = o && typeof o === 'object' && 'items' in o ? (o.items ?? {}) : {};
    for (const [id, n] of Object.entries(items)) if ((n as number) > 0) parts.push(`${this.itemIcon(id)} ${formatNumber(n as number)}`);
    const money = o && typeof o === 'object' && 'money' in o ? Number(o.money) : 0;
    if (money > 0) parts.push(`💶 ${formatMoney(money)}`);
    return parts.length ? parts.join(' · ') : '—';
  }

  /** Top-level Handel tab: locked / lobby room / lobby browser. */
  async buildTrade(): Promise<void> {
    const container = this.$('trade-content');
    const om = this.game.onlineManager;
    if (!om.usingServer) {
      this.tradeLobbyId = null; this.tradeState = null;
      container.innerHTML = `
        <div class="res-locked">
          <p>🔒 Handel läuft serverseitig und ist betrugssicher (Escrow).</p>
          <p class="hint">Melde dich mit einem Konto (oder als Gast) an, um zu handeln.</p>
          <button data-act="trade-auth">🔐 Anmelden / Registrieren</button>
        </div>`;
      container.querySelector('[data-act="trade-auth"]')?.addEventListener('click', () => this.openAuthModal());
      return;
    }
    try {
      if (!this.resourceConfig) {
        this.resourceConfig = await om.fetchResourceConfig();
        for (const w of this.resourceConfig!.worlds) for (const r of w.resources) { this.resIconMap[r.type] = r.icon; this.resNameMap[r.type] = r.name; }
      }
      if (!this.lootboxConfig) { try { this.lootboxConfig = await om.fetchLootboxConfig(); } catch { /* item chips fall back to 🎁 */ } }
      if (this.tradeLobbyId) {
        this.tradeState = await om.getLobby(this.tradeLobbyId);
        if (this.tradeState?.error) { this.tradeLobbyId = null; this.tradeState = null; }
      }
      if (this.tradeLobbyId && this.tradeState) this.renderLobbyRoom();
      else await this.renderLobbyList();
    } catch (e) {
      container.innerHTML = `<p class="empty">Handel konnte nicht geladen werden: ${escapeHtml((e as Error).message)}</p>`;
    }
  }

  private async renderLobbyList(): Promise<void> {
    const om = this.game.onlineManager;
    const container = this.$('trade-content');
    let lobbies: any[] = [], hist: any[] = [];
    try { lobbies = await om.listLobbies(this.tradeSearch); } catch { /* show empty */ }
    try { hist = await om.tradeHistory(); } catch { /* ignore */ }
    const rows = lobbies.length ? lobbies.map((l) => `
      <div class="lobby-row">
        <div class="lobby-info"><b>${escapeHtml(l.title || 'Handelslobby')}</b>
          <span class="lobby-meta">von ${escapeHtml(l.creator)} · <code>${escapeHtml(l.id)}</code></span></div>
        <button class="btn-prestige" data-join="${escapeAttr(l.id)}">Beitreten</button>
      </div>`).join('') : '<p class="empty">Keine offenen Lobbys. Erstelle die erste!</p>';
    const histRows = hist.length ? hist.map((h) =>
      `<div class="hist-row">🤝 mit <b>${escapeHtml(h.partner)}</b>: gab ${this.fmtOffer(h.youGave)} · erhielt ${this.fmtOffer(h.youGot)}</div>`).join('')
      : '<p class="empty">Noch keine Trades.</p>';
    container.innerHTML = `
      <div class="trade-create">
        <input id="lobby-title" type="text" maxlength="60" placeholder="Lobby-Titel (optional)">
        <button class="btn-prestige" data-act="create">Lobby erstellen</button>
      </div>
      <div class="trade-search">
        <input id="lobby-search" type="text" placeholder="Suchen: Titel / Name / Code" value="${escapeAttr(this.tradeSearch)}">
        <button class="btn-ghost small" data-act="refresh">Aktualisieren</button>
      </div>
      <div class="lobby-list">${rows}</div>
      <h3>📜 Dein Handelsverlauf</h3>
      <div class="trade-history">${histRows}</div>`;
    container.querySelector('[data-act="create"]')?.addEventListener('click', () => this.handleCreateLobby());
    container.querySelector('[data-act="refresh"]')?.addEventListener('click', () => {
      this.tradeSearch = (container.querySelector('#lobby-search') as HTMLInputElement).value;
      void this.buildTrade();
    });
    container.querySelectorAll<HTMLElement>('[data-join]').forEach((b) => b.addEventListener('click', () => this.handleJoinLobby(b.dataset.join!)));
  }

  private renderLobbyRoom(): void {
    const st = this.tradeState;
    if (!st) return;
    const container = this.$('trade-content');
    const you = st.you, partner = st.partner;
    const myOffer = you.offer ?? { resources: {}, money: 0 };
    const offRes: Record<string, number> = myOffer.resources ?? {};
    const waiting = st.status !== 'active';
    const resourceRows = Object.entries(you.resources)
      .filter(([t, a]) => (a as number) > 0 || (offRes[t] ?? 0) > 0)
      .map(([t, a]) => {
        const max = Math.floor((a as number) + (offRes[t] ?? 0));
        return `<div class="offer-edit-row">
          <span class="res-ico">${this.resIcon(t)}</span>
          <span class="oe-name">${escapeHtml(this.resNameMap[t] ?? t)}</span>
          <input type="number" min="0" step="1" max="${max}" data-offer="${escapeAttr(t)}" value="${Math.floor(offRes[t] ?? 0)}">
        </div>`;
      }).join('');
    // Cosmetic items can be offered too (escrowed like resources).
    const offItems: Record<string, number> = myOffer.items ?? {};
    const itemRows = Object.entries(you.items ?? {})
      .filter(([id, a]) => (a as number) > 0 || (offItems[id] ?? 0) > 0)
      .map(([id, a]) => {
        const max = Math.floor((a as number) + (offItems[id] ?? 0));
        return `<div class="offer-edit-row">
          <span class="res-ico">${this.itemIcon(id)}</span>
          <span class="oe-name">${escapeHtml(this.itemName(id))}</span>
          <input type="number" min="0" step="1" max="${max}" data-offer-item="${escapeAttr(id)}" value="${Math.floor(offItems[id] ?? 0)}">
        </div>`;
      }).join('');
    // Money is escrowed too: the cap is liquid capital + what's already offered.
    const maxMoney = Math.floor((you.money ?? 0) + (myOffer.money ?? 0));
    const moneyRow = `<div class="offer-edit-row">
        <span class="res-ico">💶</span>
        <span class="oe-name">Geld</span>
        <input type="number" min="0" step="1" max="${maxMoney}" data-offer-money value="${Math.floor(myOffer.money ?? 0)}">
      </div>`;
    const offerBody = ((resourceRows + itemRows) || '<p class="empty">Nichts zum Anbieten.</p>') + moneyRow;
    const pill = (c: boolean) => c ? ' <span class="verify-pill ok">bestätigt</span>' : '';
    container.innerHTML = `
      <div class="trade-room">
        <div class="trade-head">
          <span>Lobby <code>${escapeHtml(st.id)}</code>${st.title ? ' · ' + escapeHtml(st.title) : ''}</span>
          <button class="btn-ghost small" data-act="leave">Verlassen</button>
        </div>
        ${waiting ? `<p class="trade-wait">⏳ Warte auf Mitspieler … teile den Code <code>${escapeHtml(st.id)}</code>.</p>` : ''}
        <div class="trade-cols">
          <div class="trade-col">
            <h3>Dein Angebot${pill(you.confirmed)}</h3>
            <div class="oe-balance">Verfügbares Kapital: <b>${formatMoney(you.money ?? 0)}</b></div>
            <div class="offer-editor">${offerBody}</div>
            <button class="btn-ghost small" data-act="set-offer">Angebot speichern</button>
          </div>
          <div class="trade-col">
            <h3>${partner ? escapeHtml(partner.name) : 'Gegenseite'}${partner ? pill(partner.confirmed) : ''}</h3>
            <div class="offer-view">${partner ? this.fmtOffer(partner.offer) : '—'}</div>
          </div>
        </div>
        <label class="trade-confirm">
          <input type="checkbox" data-act="confirm" ${you.confirmed ? 'checked' : ''} ${st.status !== 'active' ? 'disabled' : ''}>
          Ich bestätige diesen Tausch
        </label>
      </div>`;
    container.querySelector('[data-act="leave"]')?.addEventListener('click', () => this.handleLeaveLobby());
    container.querySelector('[data-act="set-offer"]')?.addEventListener('click', () => this.handleSetOffer());
    container.querySelector('[data-act="confirm"]')?.addEventListener('change', (e) => this.handleConfirmTrade((e.target as HTMLInputElement).checked));
  }

  private async handleCreateLobby(): Promise<void> {
    const title = (this.$('trade-content').querySelector('#lobby-title') as HTMLInputElement)?.value ?? '';
    try { this.tradeLobbyId = (await this.game.onlineManager.createLobby(title)).id; await this.buildTrade(); }
    catch (e) { this.notify.show({ title: 'Fehler', text: (e as Error).message, icon: '⚠️', kind: 'error' }); }
  }
  private async handleJoinLobby(id: string): Promise<void> {
    try { await this.game.onlineManager.joinLobby(id); this.tradeLobbyId = id; await this.buildTrade(); }
    catch (e) { this.notify.show({ title: 'Beitritt fehlgeschlagen', text: (e as Error).message, icon: '⚠️', kind: 'error' }); }
  }
  private async handleSetOffer(): Promise<void> {
    if (!this.tradeLobbyId) return;
    const resources: Record<string, number> = {};
    this.$('trade-content').querySelectorAll<HTMLInputElement>('[data-offer]').forEach((i) => {
      const v = Math.floor(Number(i.value)); if (v > 0) resources[i.dataset.offer!] = v;
    });
    const items: Record<string, number> = {};
    this.$('trade-content').querySelectorAll<HTMLInputElement>('[data-offer-item]').forEach((i) => {
      const v = Math.floor(Number(i.value)); if (v > 0) items[i.dataset.offerItem!] = v;
    });
    const moneyEl = this.$('trade-content').querySelector<HTMLInputElement>('[data-offer-money]');
    const money = moneyEl ? Math.max(0, Math.floor(Number(moneyEl.value)) || 0) : 0;
    try {
      this.tradeState = await this.game.onlineManager.setLobbyOffer(this.tradeLobbyId, { resources, money, items });
      this.renderLobbyRoom();
      this.playSound(540, 0.05);
      void this.reconcileEconomy(); // money moved into/out of escrow → refresh the mirror
    } catch (e) { this.notify.show({ title: 'Angebot abgelehnt', text: (e as Error).message, icon: '⚠️', kind: 'error' }); }
  }
  private async handleConfirmTrade(confirmed: boolean): Promise<void> {
    if (!this.tradeLobbyId) return;
    try {
      const st = await this.game.onlineManager.confirmTrade(this.tradeLobbyId, confirmed);
      this.tradeState = st;
      if (st.status === 'completed') {
        this.notify.show({ title: 'Tausch abgeschlossen! 🤝', icon: '✅', kind: 'success', duration: 6000 });
        this.tradeLobbyId = null; void this.reconcileEconomy(); await this.buildTrade();
      } else this.renderLobbyRoom();
    } catch (e) { this.notify.show({ title: 'Fehler', text: (e as Error).message, icon: '⚠️', kind: 'error' }); this.renderLobbyRoom(); }
  }
  private async handleLeaveLobby(): Promise<void> {
    if (this.tradeLobbyId) { try { await this.game.onlineManager.leaveLobby(this.tradeLobbyId); } catch { /* ignore */ } }
    this.tradeLobbyId = null; this.tradeState = null; await this.buildTrade();
  }

  /** Poll the active lobby (live offers/confirmations) without clobbering edits. */
  private async pollTrade(): Promise<void> {
    const om = this.game.onlineManager;
    if (!om.usingServer) return;
    if (!this.tradeLobbyId) { await this.renderLobbyList(); return; }
    try {
      const st = await om.getLobby(this.tradeLobbyId);
      if (st?.error) { this.tradeLobbyId = null; this.tradeState = null; await this.buildTrade(); return; }
      if (st.status === 'completed') {
        this.notify.show({ title: 'Tausch abgeschlossen! 🤝', icon: '✅', kind: 'success', duration: 6000 });
        this.tradeLobbyId = null; this.tradeState = st; void this.reconcileEconomy(); await this.buildTrade(); return;
      }
      if (st.status === 'cancelled') {
        this.notify.show({ title: 'Lobby beendet', text: 'Escrow wurde zurückgebucht.', icon: '❌', kind: 'info' });
        this.tradeLobbyId = null; this.tradeState = st; void this.reconcileEconomy(); await this.buildTrade(); return;
      }
      // Only re-render on material changes, so we don't wipe the player's edits.
      const sig = (x: any) => x && JSON.stringify({ s: x.status, c: x.you?.confirmed, p: x.partner });
      const changed = sig(st) !== sig(this.tradeState);
      this.tradeState = st;
      if (changed) this.renderLobbyRoom();
    } catch { /* transient network blip */ }
  }

  // === Lootboxes (cosmetic prestige items, server-authoritative) ==========
  private itemIcon(id: string): string { return this.lootboxConfig?.items.find((it: any) => it.id === id)?.icon ?? '🎁'; }
  private itemName(id: string): string { return this.lootboxConfig?.items.find((it: any) => it.id === id)?.name ?? id; }
  private rarityMeta(id: string): { name: string; color: string } {
    const r = this.lootboxConfig?.rarities.find((x: any) => x.id === id);
    return { name: r?.name ?? id, color: r?.color ?? '#9ca3af' };
  }

  /** Build/refresh the Lootbox tab (locked unless connected to the server). */
  async buildLootbox(): Promise<void> {
    const container = this.$('lootbox-content');
    const om = this.game.onlineManager;
    if (!om.usingServer) {
      container.innerHTML = `
        <div class="res-locked">
          <p>🔒 Lootboxen kaufst du mit deinem Firmen-Guthaben — Inhalt &amp; Inventar sind server-autoritativ.</p>
          <p class="hint">Melde dich mit einem Konto (oder als Gast) an, um zu öffnen.</p>
          <button data-act="lb-auth">🔐 Anmelden / Registrieren</button>
        </div>`;
      container.querySelector('[data-act="lb-auth"]')?.addEventListener('click', () => this.openAuthModal());
      return;
    }
    try {
      if (!this.lootboxConfig) {
        this.lootboxConfig = await om.fetchLootboxConfig();
        this.lootboxWorld = this.lootboxConfig.worlds[0]?.world ?? '';
      }
      this.lootboxItems = (await om.fetchLootboxInventory()).items ?? {};
      this.renderLootbox();
    } catch (e) {
      container.innerHTML = `<p class="empty">Lootboxen konnten nicht geladen werden: ${escapeHtml((e as Error).message)}</p>`;
    }
  }

  private renderLootbox(): void {
    const cfg = this.lootboxConfig;
    if (!cfg) return;
    const container = this.$('lootbox-content');
    const order: string[] = cfg.rarities.map((r: any) => r.id);
    const oddsBar = (odds: Record<string, number>): string => order.filter((id) => (odds[id] ?? 0) > 0).map((id) => {
      const m = this.rarityMeta(id);
      return `<span class="odds-seg" style="width:${odds[id]}%;background:${m.color}" title="${escapeHtml(m.name)}: ${odds[id].toFixed(1)} %"></span>`;
    }).join('');
    const worldOptions = cfg.worlds.map((w: any) =>
      `<option value="${escapeAttr(w.world)}"${w.world === this.lootboxWorld ? ' selected' : ''}>${escapeHtml(w.name)}</option>`).join('');

    const boxCards = cfg.boxes.map((b: any) => `
      <div class="lb-box">
        <div class="lb-box-head"><span class="lb-box-ico">${b.icon}</span><span class="lb-box-name">${escapeHtml(b.name)}</span></div>
        <p class="lb-box-desc">${escapeHtml(b.desc ?? '')}</p>
        ${b.scope === 'world' ? `<select class="lb-world-select" data-lb-world>${worldOptions}</select>` : ''}
        <div class="odds-bar" title="Drop-Chancen">${oddsBar(b.odds)}</div>
        <button class="btn-prestige lb-open" data-open="${escapeAttr(b.id)}">Öffnen · ${formatMoney(b.price)}</button>
      </div>`).join('');

    container.innerHTML = `
      <div class="lb-boxes">${boxCards}</div>
      <div class="lb-inv-head"><h3>🎒 Sammlung</h3><span class="lb-progress" id="lb-progress"></span></div>
      <div id="lb-inventory"></div>`;
    container.querySelector('[data-lb-world]')?.addEventListener('change', (e) => { this.lootboxWorld = (e.target as HTMLSelectElement).value; });
    container.querySelectorAll<HTMLElement>('[data-open]').forEach((btn) => btn.addEventListener('click', () => void this.handleOpenBox(btn.dataset.open!)));
    this.renderLootboxInventory();
    this.setLootboxBusy(this.lootboxBusy);
  }

  /** The owned-items collection (all items shown; unowned ones locked). */
  private renderLootboxInventory(): void {
    const cfg = this.lootboxConfig;
    const host = document.getElementById('lb-inventory');
    if (!cfg || !host) return;
    const inv = this.lootboxItems;
    const owned = cfg.items.filter((it: any) => (inv[it.id] ?? 0) > 0).length;
    const prog = document.getElementById('lb-progress');
    if (prog) prog.textContent = `${owned}/${cfg.items.length} gesammelt`;

    const byWorld = new Map<string, any[]>();
    for (const it of cfg.items) { if (!byWorld.has(it.world)) byWorld.set(it.world, []); byWorld.get(it.world)!.push(it); }
    host.innerHTML = [...byWorld.entries()].map(([world, items]) => {
      const wname = cfg.worlds.find((w: any) => w.world === world)?.name ?? world;
      const chips = items.map((it: any) => {
        const n = inv[it.id] ?? 0;
        if (n > 0) return `<div class="lb-item owned" style="border-color:${it.color}" title="${escapeHtml(this.rarityMeta(it.rarity).name)}">
          <span class="lb-item-ico">${it.icon}</span>
          <span class="lb-item-name" style="color:${it.color}">${escapeHtml(it.name)}</span>
          <b class="lb-item-n">×${formatNumber(n)}</b></div>`;
        return `<div class="lb-item locked" title="${escapeHtml(this.rarityMeta(it.rarity).name)} — noch nicht gefunden">
          <span class="lb-item-ico">🔒</span><span class="lb-item-name">???</span></div>`;
      }).join('');
      return `<div class="lb-inv-world"><h4>${escapeHtml(wname)}</h4><div class="lb-item-grid">${chips}</div></div>`;
    }).join('');
  }

  private setLootboxBusy(busy: boolean): void {
    this.$('lootbox-content').querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) => { b.disabled = busy; });
  }

  private async handleOpenBox(boxType: string): Promise<void> {
    if (this.lootboxBusy) return;
    const cfg = this.lootboxConfig;
    const box = cfg?.boxes.find((b: any) => b.id === boxType);
    if (!box) return;
    let world = '';
    if (box.scope === 'world') {
      world = this.lootboxWorld || cfg.worlds[0]?.world || '';
      if (!world) { this.notify.show({ title: 'Bitte eine Welt wählen', icon: '🌍', kind: 'info' }); return; }
    }
    this.lootboxBusy = true; this.setLootboxBusy(true);
    try {
      const resp = await this.game.onlineManager.openLootbox(boxType, world);
      if (resp.items) this.lootboxItems = resp.items;
      void this.reconcileEconomy(); // the price was spent server-side
      await this.playLootboxAnimation(resp.item);
      this.renderLootboxInventory();
    } catch (e) {
      this.notify.show({ title: 'Öffnen fehlgeschlagen', text: (e as Error).message, icon: '⚠️', kind: 'error' });
    } finally {
      this.lootboxBusy = false; this.setLootboxBusy(false);
    }
  }

  /**
   * CS:GO-style horizontal reel that decelerates onto the item the SERVER
   * already chose. Purely visual: the winning tile is fixed before the spin,
   * the reel is skippable, and nothing here can change the result.
   */
  private playLootboxAnimation(item: any): Promise<void> {
    return new Promise((resolve) => {
      const pool: any[] = this.lootboxConfig?.items ?? [];
      const COUNT = 48, WIN = 42;
      const pick = (): any => (pool.length ? pool[Math.floor(Math.random() * pool.length)] : item);
      const tiles = Array.from({ length: COUNT }, (_, i) => (i === WIN ? item : pick()));
      const tileHtml = (it: any): string =>
        `<div class="reel-tile" style="--rc:${it.color}"><span class="reel-ico">${it.icon}</span><span class="reel-name">${escapeHtml(it.name)}</span></div>`;

      let overlay = document.getElementById('lootbox-overlay');
      if (!overlay) { overlay = document.createElement('div'); overlay.id = 'lootbox-overlay'; document.body.appendChild(overlay); }
      overlay.hidden = false;
      overlay.innerHTML = `
        <div class="lb-spinner">
          <div class="reel-viewport"><div class="reel-marker"></div><div class="reel-track">${tiles.map(tileHtml).join('')}</div></div>
          <div class="lb-result" hidden></div>
          <div class="lb-actions"><button class="btn-ghost small" data-act="skip">Überspringen</button></div>
        </div>`;
      const track = overlay.querySelector('.reel-track') as HTMLElement;
      const viewport = overlay.querySelector('.reel-viewport') as HTMLElement;
      const meta = this.rarityMeta(item.rarity);

      // Centre the winning tile under the marker, using real layout (robust to CSS).
      const finalX = (): number => {
        const win = track.children[WIN] as HTMLElement;
        const jitter = (Math.random() * 0.5 - 0.25) * win.offsetWidth;
        return -(win.offsetLeft + win.offsetWidth / 2 - viewport.clientWidth / 2 + jitter);
      };
      let revealed = false;
      const reveal = (): void => {
        if (revealed || overlay!.hidden) return;
        revealed = true;
        const res = overlay!.querySelector('.lb-result') as HTMLElement;
        res.hidden = false;
        res.innerHTML = `<div class="lb-win" style="--rc:${item.color}">
          <span class="lb-win-ico">${item.icon}</span>
          <div class="lb-win-name" style="color:${item.color}">${escapeHtml(item.name)}</div>
          <div class="lb-win-meta">${escapeHtml(meta.name)} · ${escapeHtml(item.worldName ?? '')}</div></div>`;
        const actions = overlay!.querySelector('.lb-actions') as HTMLElement;
        actions.innerHTML = `<button class="btn-prestige" data-act="close">Erhalten!</button>`;
        actions.querySelector('[data-act="close"]')!.addEventListener('click', close);
        this.playSound(item.rarity === 'common' ? 520 : item.rarity === 'mythic' ? 1320 : 900, 0.12);
      };
      const close = (): void => { if (overlay) overlay.hidden = true; resolve(); };

      overlay.querySelector('[data-act="skip"]')!.addEventListener('click', () => {
        track.style.transition = 'none';
        track.style.transform = `translateX(${finalX()}px)`;
        reveal();
      });
      track.style.transform = 'translateX(0)';
      requestAnimationFrame(() => {
        track.style.transition = 'transform 5s cubic-bezier(0.12, 0.7, 0.08, 1)';
        track.style.transform = `translateX(${finalX()}px)`;
      });
      track.addEventListener('transitionend', reveal, { once: true });
      setTimeout(reveal, 6000); // safety net if transitionend is missed (e.g. throttled tab)
    });
  }

  // === Login gate (online-mandatory) ======================================
  /**
   * Full-screen gate shown until a server session exists. Offers guest play and
   * the existing auth modal; `onAuthed` fires once a real server session is up
   * (either the guest button or a login through the auth modal).
   */
  showLoginGate(onAuthed: () => void): void {
    this.gateOnAuthed = onAuthed;
    const om = this.game.onlineManager;
    let gate = document.getElementById('login-gate');
    if (!gate) { gate = document.createElement('div'); gate.id = 'login-gate'; document.body.appendChild(gate); }
    gate.hidden = false;
    gate.innerHTML = `
      <div class="gate-card">
        <div class="gate-logo">🏢</div>
        <h1>Unternehmens-Imperium</h1>
        <p>Dein Imperium läuft jetzt server-seitig. Melde dich an, um zu spielen — als Gast geht es sofort los.</p>
        <div id="gate-msg" class="auth-msg" hidden></div>
        <div class="gate-actions">
          <button class="btn-prestige" data-act="auth">🔐 Anmelden / Registrieren</button>
          <button class="btn-ghost" data-act="guest">Als Gast spielen</button>
        </div>
        <button class="btn-ghost small" data-act="server">Server …</button>
      </div>`;
    const msg = (text: string, kind: 'error' | 'ok' = 'error'): void => {
      const e = gate!.querySelector('#gate-msg') as HTMLElement;
      e.hidden = false; e.textContent = text; e.className = 'auth-msg ' + kind;
    };
    (gate.querySelector('[data-act="guest"]') as HTMLElement).onclick = async () => {
      msg('Verbinde mit dem Server …', 'ok');
      try { await om.loginAsGuest(); } catch { /* sim fallback keeps usingServer=false */ }
      if (om.usingServer) this.completeGate();
      else msg('Server nicht erreichbar. Bitte später erneut versuchen.');
    };
    (gate.querySelector('[data-act="auth"]') as HTMLElement).onclick = () => this.openAuthModal();
    (gate.querySelector('[data-act="server"]') as HTMLElement).onclick = () => {
      const url = prompt('Server-URL:', om.serverUrl);
      if (url !== null) om.setServerUrl(url.trim());
    };
    // A login through the auth modal surfaces as an online:session event.
    this.gateUnsub?.();
    this.gateUnsub = this.bus.on('online:session', () => { if (om.usingServer) this.completeGate(); });
  }

  hideLoginGate(): void {
    const gate = document.getElementById('login-gate');
    if (gate) gate.hidden = true;
  }

  private completeGate(): void {
    const cb = this.gateOnAuthed;
    this.gateOnAuthed = null;
    if (this.gateUnsub) { this.gateUnsub(); this.gateUnsub = null; }
    cb?.();
  }

  async refreshLeaderboard(): Promise<void> {
    const board = this.$('leaderboard');
    if (!board) return;
    const om = this.game.onlineManager;
    if (om.isOnline) {
      await om.submitScore({
        name: this.game.company.name,
        valuation: this.game.getValuation(),
        prestige: this.game.player.prestigeLevel,
      });
    }
    const entries = await om.fetchLeaderboard(15);
    board.innerHTML = entries.map((e) => `
      <div class="lb-row ${e.isPlayer ? 'me' : ''}">
        <span class="lb-rank">#${e.rank}</span>
        <span class="lb-name">${e.isPlayer ? '⭐ ' : ''}${escapeHtml(e.name)}</span>
        <span class="lb-val">${formatMoney(e.valuation)}</span>
      </div>`).join('');
  }

  // === Settings & modal ===================================================
  openSettings(): void {
    const g = this.game;
    const save = this.game.saveSystem.exportSave(this.game.serialize());
    this.openModal(`
      <h2>⚙️ Einstellungen</h2>
      <label class="field"><span>Firmenname</span>
        <input id="set-company" type="text" value="${escapeAttr(g.company.name)}"></label>
      <label class="field"><span>Spielername</span>
        <input id="set-player" type="text" value="${escapeAttr(g.player.name)}"></label>
      <label class="check"><input id="set-mute" type="checkbox" ${g.settings.muted ? 'checked' : ''}> Stumm</label>

      <h3>Spielstand</h3>
      <label class="field"><span>Export (zum Sichern kopieren)</span>
        <textarea id="set-export" readonly rows="3">${save}</textarea></label>
      <label class="field"><span>Import (Code einfügen & laden)</span>
        <textarea id="set-import" rows="3" placeholder="Spielstand-Code …"></textarea></label>
      <div class="modal-actions">
        <button class="btn-ghost" data-act="reset">🗑️ Hard Reset</button>
        <button data-act="import">Import laden</button>
        <button class="btn-prestige" data-act="close">Fertig</button>
      </div>`);

    const m = this.$('modal-layer');
    (m.querySelector('#set-company') as HTMLInputElement).addEventListener('change', (e) => {
      this.setCompanyName((e.target as HTMLInputElement).value);
    });
    (m.querySelector('#set-player') as HTMLInputElement).addEventListener('change', (e) => {
      g.player.name = (e.target as HTMLInputElement).value.trim() || 'Gast';
    });
    (m.querySelector('#set-mute') as HTMLInputElement).addEventListener('change', (e) => {
      this.prefs.muted = (e.target as HTMLInputElement).checked;
      this.savePrefs();
      g.settings.muted = this.prefs.muted;
      this.updateMuteButton();
    });
    (m.querySelector('[data-act="close"]') as HTMLElement).onclick = () => this.closeModal();
    (m.querySelector('[data-act="import"]') as HTMLElement).onclick = () => {
      const code = (m.querySelector('#set-import') as HTMLTextAreaElement).value.trim();
      if (!code) return;
      try {
        const data = this.game.saveSystem.importSave(code);
        this.game.applySave(data);
        this.refreshAll();
        this.closeModal();
        this.notify.show({ title: 'Spielstand importiert', icon: '📥', kind: 'success' });
      } catch {
        this.notify.show({ title: 'Ungültiger Code', icon: '⚠️', kind: 'error' });
      }
    };
    (m.querySelector('[data-act="reset"]') as HTMLElement).onclick = () => this.confirmReset();
  }

  confirmReset(): void {
    this.openModal(`
      <h2>🗑️ Abmelden &amp; lokale Daten löschen?</h2>
      <p>Du wirst abgemeldet und alle lokalen Daten dieses Geräts werden gelöscht.
         Der Fortschritt eines <b>Kontos</b> bleibt mit dem Konto verknüpft; als <b>Gast</b>
         beginnst du nach dem Neuladen frisch bei €0.</p>
      <div class="modal-actions">
        <button class="btn-ghost" data-act="cancel">Abbrechen</button>
        <button class="btn-prestige" data-act="wipe">Abmelden &amp; löschen</button>
      </div>`);
    const m = this.$('modal-layer');
    (m.querySelector('[data-act="cancel"]') as HTMLElement).onclick = () => this.closeModal();
    (m.querySelector('[data-act="wipe"]') as HTMLElement).onclick = () => {
      this.game.saveSystem.clear();
      try { localStorage.removeItem(this.prefsKey); } catch { /* ignore */ }
      this.game.onlineManager.logout(); // drops the token → next load shows the gate
      location.reload();
    };
  }

  openModal(html: string): void {
    const m = this.$('modal-layer');
    (m.querySelector('#modal-content') as HTMLElement).innerHTML = html;
    m.hidden = false;
  }

  closeModal(): void {
    this.$('modal-layer').hidden = true;
  }

  // === Misc ===============================================================
  switchTab(tab: string): void {
    this.activeTab = tab;
    document.querySelectorAll<HTMLElement>('#nav [data-tab]').forEach((b) =>
      b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll<HTMLElement>('.tab').forEach((t) =>
      t.classList.toggle('active', t.id === 'tab-' + tab));
    if (tab === 'online') this.refreshLeaderboard();
    if (tab === 'prestige') this.rebuildPrestige();
    if (tab === 'quests') this.refreshQuests();
    if (tab === 'research') this.refreshResearch();
    if (tab === 'resources') { this.resourceSyncAccum = 0; void this.buildResources(); }
    if (tab === 'trade') { this.tradePollAccum = 0; void this.buildTrade(); }
    if (tab === 'lootbox') void this.buildLootbox();
  }

  applyTheme(): void {
    document.body.dataset.theme = this.game.getActiveWorld()?.theme ?? 'local';
  }

  refreshAll(): void {
    (this.$('company-name') as HTMLInputElement).value = this.game.company.name;
    this.buildShop();
    this.rebuildUpgrades();
    this.buildWorlds();
    this.buildQuests();
    this.buildResearch();
    this.buildAchievements();
    this.rebuildPrestige();
    this.buildOnline();
    this.applyTheme();
    this.updateStats();
  }

  toggleMute(): void {
    this.prefs.muted = !this.game.settings.muted;
    this.savePrefs();
    this.game.settings.muted = this.prefs.muted;
    this.updateMuteButton();
  }

  updateMuteButton(): void {
    this.$('btn-mute').textContent = this.game.settings.muted ? '🔇' : '🔊';
  }

  setText(id: string, text: string): void {
    const el = document.getElementById(id);
    if (el && el.textContent !== text) el.textContent = text;
  }

  /** Tiny WebAudio blip for tactile feedback (skipped when muted). */
  playSound(freq = 440, duration = 0.06): void {
    if (this.game.settings.muted) return;
    try {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      if (!this.audioCtx) this.audioCtx = new Ctor();
      const ctx = this.audioCtx!;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.06, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch { /* audio not available — ignore */ }
  }
}

function escapeHtml(str: unknown): string {
  const MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(str).replace(/[&<>"']/g, (c) => MAP[c] ?? c);
}
function escapeAttr(str: unknown): string {
  return escapeHtml(str);
}
