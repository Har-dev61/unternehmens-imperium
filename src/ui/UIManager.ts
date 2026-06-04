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
import type { BuyQuantity, UpgradeCategory, ResearchUpgradeConfig, NewsEntry } from '../types.js';

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
  private resourceConfig: { worlds: any[]; buildings: any[]; capSeconds?: number } | null = null;
  private resourceState: { resources: Record<string, number>; rates: Record<string, number>; buildings: Record<string, number>; fetchedAt: number } | null = null;
  private resIconMap: Record<string, string> = {};
  private resNameMap: Record<string, string> = {};
  private resourceSyncAccum = 0;

  // Trading (Phase 3): which lobby we're in (null = browsing the list), the last
  // polled lobby state, the list search term, and a poll accumulator.
  private tradeLobbyId: string | null = null;
  private tradeState: any = null;
  private tradeSearch = '';
  private tradePollAccum = 0;

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

  // === Bootstrap ==========================================================
  init(): void {
    this.clickButton = this.$('click-button');
    this.shopList = this.$('shop-list');
    this.floatLayer = this.$('float-layer');

    this.bindStatic();
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
        this.game.settings.buyQuantity = btn.dataset.qty as BuyQuantity;
        document.querySelectorAll<HTMLElement>('#buy-qty [data-qty]').forEach((b) =>
          b.classList.toggle('active', b === btn));
        this.refreshShopRows();
      });
    });

    (this.$('company-name') as HTMLInputElement).addEventListener('change', (e) => {
      this.game.company.name = (e.target as HTMLInputElement).value.trim() || 'Mein Unternehmen';
    });
    this.$('btn-settings').addEventListener('click', () => this.openSettings());
    this.$('btn-save').addEventListener('click', () => {
      this.game.save();
      this.notify.show({ title: 'Gespeichert', icon: '💾', kind: 'success', duration: 2000 });
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
    if (this.activeTab === 'resources') this.refreshResourceAmounts(); // smooth ticking
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
        const interval = this.tradeLobbyId ? 1.6 : 6; // poll the room fast, the list slowly
        if (this.tradePollAccum >= interval) { this.tradePollAccum = 0; void this.pollTrade(); }
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
    const r = this.game.claimDaily();
    if (r) this.playSound(880);
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
    const value = this.game.click();
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
    const ok = this.game.buyAsset(id, q === 'max' ? 'max' : Number(q));
    if (ok) this.playSound(520, 0.05);
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
        card.addEventListener('click', () => this.game.buyUpgrade(u.id));
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
        card.querySelector('.world-select')!.addEventListener('click', () => this.game.setActiveWorld(w.id));
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
      row.querySelector('.quest-claim')!.addEventListener('click', () => this.game.claimQuest(q.id));
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
      if (!owned && available) card.addEventListener('click', () => this.game.buyResearch(ru.id));
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
      if (!owned) card.addEventListener('click', () => this.game.buyPrestigeUpgrade(pu.id));
      shop.appendChild(card);
    }
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
      this.game.prestige();
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
    const transport = om.usingServer ? '🟢 Mit Server verbunden'
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
          : `<button data-act="sync">☁️ In Cloud speichern</button>
             <button data-act="load">⬇️ Aus Cloud laden</button>
             <button data-act="logout" class="btn-ghost">Abmelden</button>`}
        <button data-act="server" class="btn-ghost">Server …</button>
      </div>
      <h3>🏆 Bestenliste (Firmenwert)</h3>
      <button data-act="refresh" class="btn-ghost small">Aktualisieren</button>
      <div id="leaderboard" class="leaderboard"><p class="empty">Lade …</p></div>`;

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
    on('sync', () => this.cloudSync());
    on('load', () => this.cloudLoad());
    on('refresh', () => this.refreshLeaderboard());
    on('server', () => {
      const url = prompt('Server-URL (leer = nur Simulation):', om.serverUrl);
      if (url !== null) { om.setServerUrl(url.trim()); this.buildOnline(); }
    });

    this.refreshLeaderboard();
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

  // === Resources (Phase 2) ================================================
  /** Build/refresh the Rohstoffe tab (locked unless connected to the server). */
  async buildResources(): Promise<void> {
    const container = this.$('resources-content');
    const om = this.game.onlineManager;
    if (!om.usingServer) {
      this.resourceState = null;
      container.innerHTML = `
        <div class="res-locked">
          <p>🔒 Rohstoffe werden serverseitig produziert, gelagert und gehandelt.</p>
          <p class="hint">Melde dich mit einem Konto (oder als Gast) an, um zu starten.</p>
          <button data-act="res-auth">🔐 Anmelden / Registrieren</button>
        </div>`;
      container.querySelector('[data-act="res-auth"]')?.addEventListener('click', () => this.openAuthModal());
      return;
    }
    try {
      if (!this.resourceConfig) {
        this.resourceConfig = await om.fetchResourceConfig();
        for (const w of this.resourceConfig!.worlds) {
          for (const r of w.resources) { this.resIconMap[r.type] = r.icon; this.resNameMap[r.type] = r.name; }
        }
      }
      const snap = await om.fetchResources();
      this.resourceState = { resources: snap.resources, rates: snap.rates, buildings: snap.buildings, fetchedAt: Date.now() };
      this.renderResources();
    } catch (e) {
      container.innerHTML = `<p class="empty">Rohstoffe konnten nicht geladen werden: ${escapeHtml((e as Error).message)}</p>`;
    }
  }

  private renderResources(): void {
    const cfg = this.resourceConfig, st = this.resourceState;
    if (!cfg || !st) return;
    const container = this.$('resources-content');
    let html = '';
    for (const w of cfg.worlds) {
      const stocks = w.resources.map((r: any) =>
        `<div class="res-chip"><span class="res-ico">${r.icon}</span><b class="res-amt" data-res="${r.type}">0</b><span class="res-rate" data-rate="${r.type}"></span></div>`).join('');
      const blds = cfg.buildings.filter((b: any) => b.world === w.world).map((b: any) => {
        const count = st.buildings[b.id] ?? 0;
        return `<button class="res-build" data-build="${b.id}">
          <span class="rb-icon">${this.resIconMap[b.produces] ?? '📦'}</span>
          <span class="rb-main">
            <span class="rb-name">${escapeHtml(b.name)}</span>
            <span class="rb-prod">+${formatNumber(b.rate, 2)}/s ${escapeHtml(this.resNameMap[b.produces] ?? b.produces)} · <span data-count="${b.id}">×${count}</span></span>
          </span>
          <span class="rb-cost" data-cost="${b.id}"></span>
        </button>`;
      }).join('');
      html += `<div class="res-world"><h3>${escapeHtml(w.name)}</h3><div class="res-stocks">${stocks}</div><div class="res-buildings">${blds}</div></div>`;
    }
    container.innerHTML = html;
    container.querySelectorAll<HTMLElement>('[data-build]').forEach((btn) =>
      btn.addEventListener('click', () => this.handleBuildResource(btn.dataset.build!)));
    this.refreshResourceAmounts();
  }

  /** Cost of the NEXT unit (geometric in the owned count) — mirrors the server. */
  private resBuildingCost(b: any, owned: number): Record<string, number> {
    const g = b.growth ?? 1.15;
    const f = Math.pow(g, owned);
    const cost: Record<string, number> = {};
    for (const [t, base] of Object.entries(b.cost)) cost[t] = (base as number) * f;
    return cost;
  }

  /** Per-frame: extrapolate stocks from the last snapshot + show affordability. */
  refreshResourceAmounts(): void {
    const cfg = this.resourceConfig, st = this.resourceState;
    if (!cfg || !st) return;
    const container = this.$('resources-content');
    const elapsed = (Date.now() - st.fetchedAt) / 1000;
    const cur: Record<string, number> = {};
    for (const type of Object.keys(st.resources)) cur[type] = st.resources[type] + (st.rates[type] ?? 0) * elapsed;
    container.querySelectorAll<HTMLElement>('[data-res]').forEach((el) => { el.textContent = formatNumber(cur[el.dataset.res!] ?? 0); });
    container.querySelectorAll<HTMLElement>('[data-rate]').forEach((el) => { el.textContent = `+${formatNumber(st.rates[el.dataset.rate!] ?? 0, 2)}/s`; });
    for (const b of cfg.buildings) {
      const cost = this.resBuildingCost(b, st.buildings[b.id] ?? 0);
      const costEl = container.querySelector<HTMLElement>(`[data-cost="${b.id}"]`);
      if (costEl) costEl.innerHTML = Object.entries(cost).map(([t, a]) => `${this.resIconMap[t] ?? ''} ${formatNumber(a)}`).join(' · ');
      const affordable = Object.entries(cost).every(([t, a]) => (cur[t] ?? 0) >= a);
      container.querySelector<HTMLElement>(`[data-build="${b.id}"]`)?.classList.toggle('affordable', affordable);
    }
  }

  async handleBuildResource(buildingId: string): Promise<void> {
    try {
      const snap = await this.game.onlineManager.buildResource(buildingId, 1);
      this.resourceState = { resources: snap.resources, rates: snap.rates, buildings: snap.buildings, fetchedAt: Date.now() };
      this.renderResources();
      this.playSound(560, 0.05);
    } catch (e) {
      this.notify.show({ title: 'Bau fehlgeschlagen', text: (e as Error).message, icon: '⚠️', kind: 'error' });
    }
  }

  /** Quietly re-fetch the authoritative snapshot (also settles server-side). */
  private async syncResources(): Promise<void> {
    if (!this.game.onlineManager.usingServer) return;
    try {
      const snap = await this.game.onlineManager.fetchResources();
      this.resourceState = { resources: snap.resources, rates: snap.rates, buildings: snap.buildings, fetchedAt: Date.now() };
    } catch { /* offline blip — keep extrapolating from the last snapshot */ }
  }

  // === Trading (Phase 3) ==================================================
  private resIcon(t: string): string { return this.resIconMap[t] ?? '📦'; }
  private fmtBundle(b: Record<string, number>): string {
    const e = Object.entries(b ?? {});
    return e.length ? e.map(([t, a]) => `${this.resIcon(t)} ${formatNumber(a)}`).join(' · ') : '—';
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
      `<div class="hist-row">🤝 mit <b>${escapeHtml(h.partner)}</b>: gab ${this.fmtBundle(h.youGave)} · erhielt ${this.fmtBundle(h.youGot)}</div>`).join('')
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
    const waiting = st.status !== 'active';
    const offerRows = Object.entries(you.resources)
      .filter(([t, a]) => (a as number) > 0 || (you.offer[t] ?? 0) > 0)
      .map(([t, a]) => {
        const max = Math.floor((a as number) + (you.offer[t] ?? 0));
        return `<div class="offer-edit-row">
          <span class="res-ico">${this.resIcon(t)}</span>
          <span class="oe-name">${escapeHtml(this.resNameMap[t] ?? t)}</span>
          <input type="number" min="0" step="1" max="${max}" data-offer="${escapeAttr(t)}" value="${Math.floor(you.offer[t] ?? 0)}">
        </div>`;
      }).join('') || '<p class="empty">Keine Rohstoffe zum Anbieten.</p>';
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
            <div class="offer-editor">${offerRows}</div>
            <button class="btn-ghost small" data-act="set-offer">Angebot speichern</button>
          </div>
          <div class="trade-col">
            <h3>${partner ? escapeHtml(partner.name) : 'Gegenseite'}${partner ? pill(partner.confirmed) : ''}</h3>
            <div class="offer-view">${partner ? this.fmtBundle(partner.offer) : '—'}</div>
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
    const offer: Record<string, number> = {};
    this.$('trade-content').querySelectorAll<HTMLInputElement>('[data-offer]').forEach((i) => {
      const v = Math.floor(Number(i.value)); if (v > 0) offer[i.dataset.offer!] = v;
    });
    try { this.tradeState = await this.game.onlineManager.setLobbyOffer(this.tradeLobbyId, offer); this.renderLobbyRoom(); this.playSound(540, 0.05); }
    catch (e) { this.notify.show({ title: 'Angebot abgelehnt', text: (e as Error).message, icon: '⚠️', kind: 'error' }); }
  }
  private async handleConfirmTrade(confirmed: boolean): Promise<void> {
    if (!this.tradeLobbyId) return;
    try {
      const st = await this.game.onlineManager.confirmTrade(this.tradeLobbyId, confirmed);
      this.tradeState = st;
      if (st.status === 'completed') {
        this.notify.show({ title: 'Tausch abgeschlossen! 🤝', icon: '✅', kind: 'success', duration: 6000 });
        this.tradeLobbyId = null; await this.buildTrade();
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
        this.tradeLobbyId = null; this.tradeState = st; await this.buildTrade(); return;
      }
      if (st.status === 'cancelled') {
        this.notify.show({ title: 'Lobby beendet', text: 'Escrow wurde zurückgebucht.', icon: '❌', kind: 'info' });
        this.tradeLobbyId = null; this.tradeState = st; await this.buildTrade(); return;
      }
      // Only re-render on material changes, so we don't wipe the player's edits.
      const sig = (x: any) => x && JSON.stringify({ s: x.status, c: x.you?.confirmed, p: x.partner });
      const changed = sig(st) !== sig(this.tradeState);
      this.tradeState = st;
      if (changed) this.renderLobbyRoom();
    } catch { /* transient network blip */ }
  }

  async cloudSync(): Promise<void> {
    try {
      await this.game.onlineManager.syncSave(this.game.serialize());
      this.notify.show({ title: 'In Cloud gespeichert', icon: '☁️', kind: 'success' });
    } catch (err) {
      this.notify.show({ title: 'Cloud-Fehler', text: (err as Error).message, icon: '⚠️', kind: 'error' });
    }
  }

  async cloudLoad(): Promise<void> {
    try {
      const data = await this.game.onlineManager.loadCloud();
      if (!data) { this.notify.show({ title: 'Kein Cloud-Save gefunden', icon: '☁️', kind: 'info' }); return; }
      this.game.applySave(data);
      this.refreshAll();
      this.notify.show({ title: 'Aus Cloud geladen', icon: '⬇️', kind: 'success' });
    } catch (err) {
      this.notify.show({ title: 'Cloud-Fehler', text: (err as Error).message, icon: '⚠️', kind: 'error' });
    }
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
      <label class="check"><input id="set-auto" type="checkbox" ${g.settings.autosave ? 'checked' : ''}> Automatisch speichern</label>
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
      g.company.name = (e.target as HTMLInputElement).value.trim() || 'Mein Unternehmen';
      (this.$('company-name') as HTMLInputElement).value = g.company.name;
    });
    (m.querySelector('#set-player') as HTMLInputElement).addEventListener('change', (e) => {
      g.player.name = (e.target as HTMLInputElement).value.trim() || 'Gast';
    });
    (m.querySelector('#set-auto') as HTMLInputElement).addEventListener('change', (e) => { g.settings.autosave = (e.target as HTMLInputElement).checked; });
    (m.querySelector('#set-mute') as HTMLInputElement).addEventListener('change', (e) => {
      g.settings.muted = (e.target as HTMLInputElement).checked; this.updateMuteButton();
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
      <h2>🗑️ Wirklich alles löschen?</h2>
      <p>Dein gesamter Fortschritt wird unwiderruflich zurückgesetzt.</p>
      <div class="modal-actions">
        <button class="btn-ghost" data-act="cancel">Abbrechen</button>
        <button class="btn-prestige" data-act="wipe">Alles löschen</button>
      </div>`);
    const m = this.$('modal-layer');
    (m.querySelector('[data-act="cancel"]') as HTMLElement).onclick = () => this.closeModal();
    (m.querySelector('[data-act="wipe"]') as HTMLElement).onclick = () => {
      // Disable autosave first, otherwise the reload's beforeunload handler
      // would immediately re-save the in-memory state over the cleared slot.
      this.game.settings.autosave = false;
      this.game.saveSystem.clear();
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
    this.game.settings.muted = !this.game.settings.muted;
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
