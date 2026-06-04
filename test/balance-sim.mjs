/**
 * Headless BALANCE simulation — an auto-player that measures progression pacing.
 *
 * It runs the real Game economy in Node with a greedy "active player" strategy
 * (click N×/s, then keep buying the best-ROI asset / cheapest worthwhile upgrade
 * while affordable) and reports how long it takes to unlock each world and to
 * reach key money milestones.
 *
 * Random events & Golden Deals are disabled for determinism — they only make
 * real play marginally faster, so this is a slightly conservative estimate of
 * the *fastest* reasonable pacing.
 *
 *   Run:  node test/balance-sim.mjs [clicksPerSec]
 *   e.g.  node test/balance-sim.mjs 5
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { EventBus } = await import('../js/systems/EventBus.js');
const { SaveSystem } = await import('../js/systems/SaveSystem.js');
const { OnlineManager } = await import('../js/systems/OnlineManager.js');
const { EventManager } = await import('../js/systems/EventManager.js');
const { Game } = await import('../js/core/Game.js');

const CLICKS_PER_SEC = Number(process.argv[2] ?? 4);

const bus = new EventBus();
const game = new Game({
  bus,
  saveSystem: new SaveSystem('sim-save'),
  onlineManager: new OnlineManager(bus, 'sim-online'),
  eventManager: new EventManager(bus),
});
// Determinism: silence random events & golden deals during the core-economy sim.
game.eventManager.update = () => {};
game.goldenDeal.update = () => {};

const fmtT = (s) => {
  s = Math.floor(s);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), sec = s % 60;
  return [d ? d + 'd' : '', h ? h + 'h' : '', m ? m + 'm' : '', `${sec}s`].filter(Boolean).join(' ');
};
const fmtMoney = (n) => {
  const tiers = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
  if (n < 1000) return '€' + n.toFixed(1);
  const t = Math.floor(Math.log10(n) / 3);
  return t < tiers.length ? '€' + (n / 1e3 ** t).toFixed(2) + tiers[t] : '€' + n.toExponential(2);
};

const worldUnlock = {};
const snap = () => ({ t, ps: game.getPerSecond(), gm: game.company.globalMultiplier, life: game.player.lifetimeEarned });
bus.on('world:unlocked', ({ world }) => { if (!(world.id in worldUnlock)) worldUnlock[world.id] = snap(); });
worldUnlock['local'] = { t: 0, ps: 0, gm: 1, life: 0 };

// Greedy purchase: buy affordable upgrades (cheapest first, if not too pricey
// relative to cash) and the best-ROI affordable asset, until nothing helps.
function spend() {
  // Research nodes are bought with research points (separate currency) as soon
  // as they're affordable & available — a player always takes free multipliers.
  for (const ru of game.researchUpgradeDefs) {
    if (!game.player.researchUpgrades.has(ru.id) && game.isResearchAvailable(ru.id) &&
        game.company.research.amount >= ru.cost) {
      game.buyResearch(ru.id);
    }
  }
  let guard = 0;
  for (;;) {
    if (guard++ > 150) break;
    const money = game.company.money.amount;
    let up = null;
    for (const u of game.upgrades) {
      if (!u.purchased && u.isUnlocked(game) && u.cost <= money && (!up || u.cost < up.cost)) up = u;
    }
    const meta = game.company.globalMultiplier * game.player.prestigeMultiplier * game.getEventMultiplier();
    let bestA = null, bestRoi = 0;
    for (const w of game.worlds) {
      if (!w.unlocked) continue;
      for (const a of w.assets) {
        const cost = a.getCost(1);
        if (cost > money) continue;
        const unit = a.getUnitProduction() * w.productionMultiplier * w.upgradeMultiplier * meta;
        const roi = unit / cost;
        if (roi > bestRoi) { bestRoi = roi; bestA = a; }
      }
    }
    if (up && (!bestA || up.cost <= money * 0.5)) { if (!game.buyUpgrade(up.id)) break; }
    else if (bestA) { if (!game.buyAsset(bestA.id, 1)) break; }
    else if (up) { if (!game.buyUpgrade(up.id)) break; }
    else break;
  }
}

let t = 0;
let prestiges = 0;
const HORIZON = 365 * 86400; // cap: 1 simulated year
const milestones = [1e3, 1e6, 1e9, 1e12, 1e15, 1e18, 1e21, 1e24, 1e27];
const milestoneHit = {};

console.log(`\n⏱️  Balance-Sim — ${CLICKS_PER_SEC} Klicks/s, Events/Golden aus\n`);

while (t < HORIZON && game.getUnlockedWorldCount() < game.worlds.length) {
  // variable timestep: fine early, coarse late (keeps the run fast)
  const dt = t < 7200 ? 1 : t < 2 * 86400 ? 20 : 300;

  for (let c = 0; c < CLICKS_PER_SEC * dt && c < 5000; c++) game.click();
  game.tick(dt);
  spend();

  // Auto-prestige (meta-loop): only when the next world's EARNINGS are already
  // met but it's still locked — i.e. a prestige-level gate is blocking. Models a
  // player who prestiges specifically to open the next prestige-gated world.
  const nextLocked = game.worlds.find((w) => !w.unlocked);
  const blockedByPrestige = nextLocked && nextLocked.unlockAt && game.player.lifetimeEarned >= nextLocked.unlockAt;
  if (blockedByPrestige && game.player.computePrestigeGain() >= 1) {
    game.prestige();
    prestiges++;
  }
  t += dt;

  for (const m of milestones) {
    if (!(m in milestoneHit) && game.player.lifetimeEarned >= m) {
      milestoneHit[m] = t;
    }
  }
}

console.log('🌍 Welt-Freischaltungen (Zeit · €/s · globaler Mult.):');
for (const w of game.worlds) {
  const at = worldUnlock[w.id];
  if (at === undefined) { console.log(`   ${w.icon} ${w.name.padEnd(24)} — nicht erreicht`); continue; }
  console.log(`   ${w.icon} ${w.name.padEnd(24)} ${fmtT(at.t).padStart(12)}  ·  ${fmtMoney(at.ps).padStart(10)}/s  ·  ×${at.gm.toFixed(0)}`);
}
console.log('\n💰 Meilensteine (Lebenszeit-Einnahmen):');
for (const m of milestones) {
  const at = milestoneHit[m];
  console.log(`   ${fmtMoney(m).padStart(10)}  ${at === undefined ? '— nicht erreicht' : fmtT(at).padStart(12)}`);
}
console.log(`\n📊 Endstand nach ${fmtT(t)}: ${fmtMoney(game.company.money.amount)} Kapital, ` +
  `${fmtMoney(game.getPerSecond())}/s, ${game.getUnlockedWorldCount()}/${game.worlds.length} Welten, ` +
  `${prestiges} Börsengänge (Einfluss ${game.player.prestigePoints}), ${game.player.totalClicks} Klicks`);
