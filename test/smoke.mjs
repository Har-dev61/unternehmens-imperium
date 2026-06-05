/**
 * Headless smoke test for the LOGIC layer — no browser, no DOM.
 *
 * This file is itself a demonstration of the architecture's clean separation:
 * the entire economy (Game + models + systems) runs in plain Node with only a
 * tiny localStorage shim. Nothing in core/ or systems/ imports the UI.
 *
 *   Run:  npm test        (or: node test/smoke.mjs)
 */

// Minimal localStorage shim so SaveSystem / OnlineManager work under Node.
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

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } };

const makeGame = () => {
  const bus = new EventBus();
  return new Game({
    bus,
    saveSystem: new SaveSystem('test-save'),
    onlineManager: new OnlineManager(bus, 'test-online'),
    eventManager: new EventManager(bus),
  });
};

const game = makeGame();

// --- Initial state ---
ok(Math.abs(game.getClickValue() - 1) < 1e-9, `initial click value 1 (got ${game.getClickValue()})`);
ok(game.getPerSecond() === 0, 'initial €/s is 0');
ok(game.getUnlockedWorldCount() === 1, 'only local world unlocked at start');
ok(game.upgrades.length > 100, `large upgrade catalogue (got ${game.upgrades.length})`);

// --- Buying an asset (geometric cost curve) ---
game.company.money.amount = 1000;
const prakt = game.getAsset('local-0');
ok(prakt.getCost(1) === 15, `praktikant base cost 15 (got ${prakt.getCost(1)})`);
ok(game.buyAsset('local-0', 1), 'buy 1 praktikant');
ok(prakt.count === 1, 'count is 1');
// Balance (rebalanced): prod 0.15 × PROD_SCALE 1.0 = 0.15 €/s per Praktikant.
ok(Math.abs(game.getPerSecond() - 0.15) < 1e-9, `€/s is 0.15 (got ${game.getPerSecond()})`);
ok(Math.abs(game.company.money.amount - 985) < 1e-9, 'money 1000-15=985');
ok(prakt.getCost(10) > 150, 'buying 10 costs more than 10× base (growth)');

// --- Click upgrade doubles click value ---
game.company.money.amount = 1e6;
ok(game.buyUpgrade('click-1'), 'buy "Bessere Maus"');
ok(Math.abs(game.getClickValue() - 2) < 1e-9, `click value doubled (got ${game.getClickValue()})`);

// --- Asset-specific upgrade unlocks at threshold & doubles that asset ---
game.company.money.amount = 1e9;
game.buyAsset('local-0', 20);
const au = game.getUpgrade('au-local-0-0');
ok(au.isUnlocked(game), 'asset upgrade unlocks after owning 10');
const before = prakt.getProduction();
ok(game.buyUpgrade('au-local-0-0'), 'buy asset upgrade');
ok(Math.abs(prakt.getProduction() - before * 2) < 1e-3, 'asset upgrade doubles output');

// --- World unlock + achievements via lifetime earnings ---
game.player.lifetimeEarned = 2e7; // national now gates at €10M lifetime (rebalanced)
game.checkProgress();
ok(game.getWorld('national').unlocked, 'national unlocks at €10M lifetime');
ok(game.achievements.find((a) => a.id === 'ach-money-1').unlocked, 'first-million achievement');

// --- Prestige-gated later world (finance needs earnings AND a Börsengang) ---
game.player.lifetimeEarned = 1e18; // well past finance's €100 Brd. earnings gate
game.player.prestigeLevel = 0;
game.checkProgress();
ok(!game.getWorld('finance').unlocked, 'finance stays LOCKED on earnings alone (prestige-level gate)');
game.player.prestigeLevel = 1;
game.checkProgress();
ok(game.getWorld('finance').unlocked, 'finance unlocks once earnings + 1 prestige are met');
game.player.prestigeLevel = 0; // reset so later prestige assertions are unaffected

// --- New worlds & content ---
ok(game.worlds.length === 9, `9 worlds total (got ${game.worlds.length})`);
ok(game.getWorld('biotech') && game.getWorld('ai'), 'biotech & ai worlds exist');
ok(game.quests.length >= 8, `quest catalogue present (got ${game.quests.length})`);

// --- Quest completion & claim (with permanent reward) ---
game.player.totalClicks = 300;
game.checkProgress();
const qClick = game.quests.find((q) => q.id === 'q-click');
ok(qClick.completed, 'click quest completes at 250 clicks');
const gmBefore = game.company.globalMultiplier;
ok(game.claimQuest('q-click'), 'claim click quest');
ok(qClick.claimed, 'quest marked claimed');
ok(game.company.globalMultiplier > gmBefore, 'quest globalMult reward applied');

// --- Golden Deal reward ---
game.goldenDeal.active = { id: 'gd-test', type: 'lucky', expiresAt: Date.now() + 9999 };
game.company.money.amount = 1e6;
const goldBefore = game.company.money.amount;
const gres = game.clickGolden('gd-test');
ok(gres && gres.type === 'lucky', 'golden "lucky" reward returned');
ok(game.player.goldenClicks === 1, 'golden click counted');
ok(game.company.money.amount > goldBefore, 'golden lucky added money');

// --- Prestige ---
game.player.runEarned = 1e15; // gain = cbrt(1e15 / 1e12) = 10 (rebalanced divisor)
ok(game.player.computePrestigeGain() === 10, `prestige gain 10 for 1e15 (got ${game.player.computePrestigeGain()})`);
const lifetimeBefore = game.player.lifetimeEarned;
ok(game.prestige(), 'prestige succeeds');
ok(game.player.prestigePoints === 10, 'gained 10 influence');
ok(Math.abs(game.player.prestigeMultiplier - 1.2) < 1e-9, 'prestige multiplier +20%');
ok(prakt.count === 0, 'assets reset after prestige');
ok(game.getWorld('national').unlocked, 'worlds stay unlocked after prestige');
ok(game.player.lifetimeEarned === lifetimeBefore, 'lifetime earnings persist');

// --- Offline progress ---
game.company.money.amount = 1e6;
game.buyAsset('local-0', 5);
game.computeDerived();
const ps = game.getPerSecond();
const off = game.applyOfflineProgress(3600);
ok(off.earned > 0 && Math.abs(off.earned - ps * 3600 * 0.5) < ps, 'offline ≈ ps×time×efficiency');

// --- Save round-trip ---
const snapshot = game.serialize();
const game2 = makeGame();
game2.applySave(snapshot);
ok(game2.player.prestigePoints === 10, 'save restores influence');
ok(game2.getWorld('national').unlocked, 'save restores world unlocks');
ok(game2.getAsset('local-0').count === game.getAsset('local-0').count, 'save restores asset counts');

// --- Research tree ---
game.company.money.amount = 1e9;
game.buyAsset('local-2', 30); // Heimbüro (Gebäude) → erzeugt Forschung
game.computeDerived();
ok(game.getResearchPerSecond() > 0, 'assets generate research/s');
game.company.research.amount = 100;
const gmBeforeR = game.company.globalMultiplier;
ok(game.buyResearch('r-basics'), 'buy root research node');
ok(game.company.globalMultiplier > gmBeforeR, 'research effect applied to global multiplier');
ok(game.isResearchAvailable('r-materials'), 'child node unlocks after prerequisite');
ok(!game.isResearchAvailable('r-data'), 'deep node stays locked without prereqs');
ok(!game.buyResearch('r-data'), 'cannot buy a locked research node');

// --- Research persists through prestige ---
game.player.runEarned = 1e12;
game.prestige();
ok(game.player.researchUpgrades.has('r-basics'), 'research persists through prestige');

// --- Daily reward ---
ok(game.canClaimDaily(), 'daily reward claimable initially');
const daily = game.claimDaily();
ok(daily && daily.streak === 1, 'daily streak starts at 1');
ok(!game.canClaimDaily(), 'daily reward not claimable twice in a row');

console.log(`\n${fail === 0 ? '✅' : '❌'} smoke test: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
