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
    this.clickButton.addEventListener('click', (e) => this.handleClick(e as MouseEvent));

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
    this.bus.on('online:session', () => this.buildOnline());
    this.bus.on('online:expired', () => this.notify.show({
      title: 'Sitzung abgelaufen', text: 'Bitte melde dich erneut an.', icon: '🔑', kind: 'info', duration: 6000,
    }));

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
    this.throttle += dt;
    if (this.throttle >= 0.4) {
      this.throttle = 0;
      this.rebuildUpgrades();
      this.refreshWorldsProgress();
      if (this.activeTab === 'prestige') this.rebuildPrestige();
      if (this.activeTab === 'quests') this.refreshQuests();
      if (this.activeTab === 'research') this.refreshResearch();
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
  handleClick(e: MouseEvent): void {
    const value = this.game.click();
    this.clickButton.classList.remove('pop');
    void this.clickButton.offsetWidth; // restart animation
    this.clickButton.classList.add('pop');
    const rect = this.floatLayer.getBoundingClientRect();
    this.spawnFloat(e.clientX - rect.left, e.clientY - rect.top, '+' + formatMoney(value));
    this.playSound(440, 0.05);
  }

  spawnFloat(x: number, y: number, text: string): void {
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
    el.addEventListener('click', () => {
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

    container.innerHTML = `
      <div class="online-status">
        <div>Status: <b>${status}</b></div>
        <div class="online-transport">${transport}${om.hasServer() ? ` · <code>${escapeHtml(om.serverUrl)}</code>` : ''}</div>
      </div>
      <div class="online-actions">
        ${s.mode === 'offline'
          ? `<button data-act="guest">Als Gast spielen</button>
             <button data-act="login">Konto / Anmelden</button>`
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
    on('guest', async () => { await om.loginAsGuest(); this.refreshLeaderboard(); });
    on('login', async () => {
      const name = prompt('Benutzername:', this.game.company.name);
      if (!name) return;
      const pw = prompt('Passwort (für ein echtes Konto; leer lassen für Gast/Simulation):', '');
      await om.login(name, pw || '');
      this.refreshLeaderboard();
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
