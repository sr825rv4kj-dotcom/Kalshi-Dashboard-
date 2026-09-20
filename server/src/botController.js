import fs from "fs";
import path from "path";
import { CONFIG_DIR } from "./paths.js";
import { kalshiGet } from "./kalshiClient.js";
import { exitPosition } from "./executor.js";
import { loadState, saveState, appendLog } from "./stateStore.js";
import { loadConfig } from "./configStore.js";
import { discoverActiveSports } from "./sportsDiscovery.js";
import { currentCadenceSeconds, describeCadence } from "./cadence.js";
import { scanSport } from "./scanner.js";
import { notifyMilestone, notifyDailyHalt, notifyDailySummary } from "./notifier.js";
import { getTelegramCredentials } from "./telegramStore.js";
import { getRecentTrades, recordTrade } from "./tradeLedgerStore.js";

const TICKER_MAP_PATH = path.join(CONFIG_DIR, "ticker-map.json");
const V2 = "/trade-api/v2";
const POSITION_MONITOR_INTERVAL_MS = 3 * 60 * 1000;

export const CONTROLLER_VERSION = "2026-09-20-hold-to-settlement";

let intervalHandle = null;
let positionMonitorHandle = null;
let consecutiveFailures = 0;
let breakerOpenedAt = null;
let breakerTrips = 0;
let lastCapLogAt = 0;

/**
 * How long the breaker stays shut before it will try again, doubling on each
 * consecutive trip so a genuine outage is not hammered, capped at an hour.
 */
function breakerCooldownMs(config) {
  const base = (config.circuitBreakerCooldownMinutes ?? 10) * 60 * 1000;
  return Math.min(base * Math.pow(2, Math.max(0, breakerTrips - 1)), 60 * 60 * 1000);
}

/** Breaker state, so the watchdog can report it instead of claiming health. */
export function getBreakerStatus(config = null) {
  const maxFailures = (config || loadConfig()).circuitBreakerFailures ?? 3;
  const open = consecutiveFailures >= maxFailures;
  if (!open) return { open: false, consecutiveFailures, trips: breakerTrips };
  const cooldown = breakerCooldownMs(config || loadConfig());
  const waited = breakerOpenedAt ? Date.now() - breakerOpenedAt : 0;
  return {
    open: true, consecutiveFailures, trips: breakerTrips,
    retryInSeconds: Math.max(0, Math.round((cooldown - waited) / 1000)),
  };
}

function loadTickerMap() {
  try {
    const raw = JSON.parse(fs.readFileSync(TICKER_MAP_PATH, "utf8"));
    const { _comment, _example, ...map } = raw;
    return map;
  } catch {
    return {}; // a missing manual map is normal - the resolver handles it
  }
}

/**
 * Milestone tiers. Crossing a milestone governs how the bot trades: more size,
 * more concurrency, and a reserve that sizing is not allowed to touch.
 */
export function tierFor(bankroll, config) {
  const tiers = config.milestoneTiers || [
    { at: 0,     kellyFraction: 0.25, maxConcurrentPositions: 3,  maxStakeDollars: 4,   reservePct: 0.00 },
    { at: 100,   kellyFraction: 0.25, maxConcurrentPositions: 5,  maxStakeDollars: 15,  reservePct: 0.10 },
    { at: 500,   kellyFraction: 0.25, maxConcurrentPositions: 8,  maxStakeDollars: 50,  reservePct: 0.20 },
    { at: 2500,  kellyFraction: 0.30, maxConcurrentPositions: 12, maxStakeDollars: 200, reservePct: 0.30 },
    { at: 10000, kellyFraction: 0.30, maxConcurrentPositions: 16, maxStakeDollars: 600, reservePct: 0.40 },
  ];
  let active = tiers[0];
  for (const t of tiers) if (bankroll >= t.at) active = t;
  return active;
}

/** Capital the bot is allowed to risk: balance minus the locked-in reserve. */
export function tradableBankroll(bankroll, config) {
  const tier = tierFor(bankroll, config);
  const reserve = bankroll * (tier.reservePct ?? 0);
  return { tier, reserve, tradable: Math.max(0, bankroll - reserve) };
}

async function checkMilestones(config, currentBalance) {
  const milestones = config.milestones || [];
  if (!milestones.length) return;

  const state = loadState();
  const highest = state.highestMilestoneNotified || 0;
  const crossed = milestones.filter((m) => m > highest && currentBalance >= m).sort((a, b) => b - a);
  if (!crossed.length) return;

  state.highestMilestoneNotified = crossed[0];
  saveState(state);
  const tier = tierFor(currentBalance, config);
  appendLog(
    `Milestone reached: $${crossed[0].toLocaleString()} - now sizing at ${(tier.kellyFraction * 100).toFixed(0)}% Kelly, ` +
    `${tier.maxConcurrentPositions} concurrent, $${tier.maxStakeDollars} max stake, ` +
    `${(tier.reservePct * 100).toFixed(0)}% reserved.`
  );
  const { botToken, chatId } = getTelegramCredentials();
  await notifyMilestone({ botToken, chatId, milestone: crossed[0], currentBalance }).catch(() => {});
}

async function checkDailySummary(config, currentBalance) {
  const state = loadState();
  const today = new Date().toDateString();
  if (state.lastDailySummaryDate === today) return;

  const todays = getRecentTrades(500).filter((t) => new Date(t.timestamp).toDateString() === today);
  const { botToken, chatId } = getTelegramCredentials();
  await notifyDailySummary({
    botToken, chatId,
    tradesEntered: todays.filter((t) => t.action === "enter").length,
    tradesExited: todays.filter((t) => t.action === "exit" || t.action === "settle").length,
    currentBalance,
    environment: config.environment,
  }).catch(() => {});

  state.lastDailySummaryDate = today;
  saveState(state);
}

function atConcurrentPositionCap(config, bankroll) {
  const sm = config.survivalMode;
  const inSurvival = sm && bankroll < sm.balanceThreshold;
  const tier = tierFor(bankroll, config);
  const cap = inSurvival
    ? sm.maxConcurrentPositions
    : (config.maxConcurrentPositions ?? tier.maxConcurrentPositions);
  if (!cap) return false;
  return loadState().positions.length >= cap;
}

/** One position per game. Both sides of the same event is a guaranteed fee loss. */
function eventKeyOf(ticker) {
  const parts = String(ticker).split("-");
  return parts.length > 1 ? `${parts[0]}-${parts[1]}` : String(ticker);
}

function openEventKeys() {
  return new Set(loadState().positions.map((p) => eventKeyOf(p.ticker)));
}

function recordExit(ticker) {
  const state = loadState();
  state.recentExits = state.recentExits || {};
  state.recentExits[eventKeyOf(ticker)] = new Date().toISOString();
  saveState(state);
}

/** Games exited within the cooldown, which this cycle must leave alone. */
function cooledDownEventKeys(config) {
  const minutes = config.reentryCooldownMinutes ?? 60;
  if (!minutes) return new Set();
  const cutoff = Date.now() - minutes * 60 * 1000;
  const recent = loadState().recentExits || {};
  const keys = new Set();
  for (const [key, iso] of Object.entries(recent)) {
    if (new Date(iso).getTime() >= cutoff) keys.add(key);
  }
  return keys;
}

/**
 * SETTLEMENT RECONCILIATION.
 *
 * Positions were only ever removed from local state by exitPosition. That was
 * survivable while the bot flipped everything before the whistle. It is fatal
 * once positions are held to settlement: Kalshi settles the contract, the
 * exchange forgets it, and the local record sits there forever. The concurrent
 * position cap fills with games that finished days ago and the bot silently
 * stops trading - no error, no log, just nothing.
 *
 * So every cycle, local positions are reconciled against what Kalshi actually
 * reports. Anything the exchange no longer holds has settled, and is closed out
 * locally at its true settled value so the statement shows real profit and loss.
 */
async function reconcileSettledPositions() {
  const state = loadState();
  if (!state.positions.length) return { settled: 0 };

  let live;
  try {
    const data = await kalshiGet(`${V2}/portfolio/positions`);
    live = data.market_positions ?? [];
  } catch (err) {
    // Cannot tell what is still open - do nothing rather than wrongly close.
    appendLog(`Could not reconcile positions (${err.message}) - leaving local records untouched.`, "warn");
    return { settled: 0, error: err.message };
  }

  const heldNow = new Map();
  for (const p of live) {
    const count = p.position_fp != null ? Number(p.position_fp) : (p.position ?? 0);
    if (count !== 0) heldNow.set(p.ticker, p);
  }

  const stillOpen = [];
  let settledCount = 0;

  for (const position of state.positions) {
    if (heldNow.has(position.ticker)) { stillOpen.push(position); continue; }

    // Gone from the exchange: it settled. Read the real outcome so the ledger
    // records what actually happened rather than an assumption.
    let settlementCents = null;
    try {
      const res = await kalshiGet(`${V2}/markets/${position.ticker}`);
      const result = String(res.market?.result || "").toLowerCase();
      if (result === "yes") settlementCents = 100;
      else if (result === "no") settlementCents = 0;
    } catch {
      // leave null - recorded as unknown rather than guessed
    }

    const outcome =
      settlementCents === 100 ? "settled-win" :
      settlementCents === 0 ? "settled-loss" : "settled-unknown";

    recordTrade({
      action: "exit",
      ticker: position.ticker,
      side: "yes",
      contracts: position.contracts,
      priceCents: position.entryPriceCents,
      exitPriceCents: settlementCents,
      filled: position.contracts,
      reason: outcome,
      edgePct: null,
      environment: loadConfig().environment,
      teamName: position.teamName ?? null,
      sportKey: position.sportKey ?? null,
      commenceTime: position.commenceTime ?? null,
    });

    const net = settlementCents == null
      ? "outcome unavailable"
      : `$${(((settlementCents - position.entryPriceCents) * position.contracts) / 100).toFixed(2)}`;
    appendLog(
      `${position.ticker} settled ${settlementCents == null ? "(result unreadable)" : settlementCents === 100 ? "YES - won" : "NO - lost"}: ` +
      `${position.contracts} contracts @ ${position.entryPriceCents}c entry, net ${net}. No exit fee - settlement is free.`
    );
    settledCount++;
  }

  if (settledCount) {
    const fresh = loadState();
    const settledKeys = new Set(state.positions.filter((p) => !heldNow.has(p.ticker)).map((p) => `${p.ticker}|${p.openedAt}`));
    fresh.positions = fresh.positions.filter((p) => !settledKeys.has(`${p.ticker}|${p.openedAt}`));
    saveState(fresh);
  }

  return { settled: settledCount };
}

/**
 * Total account equity: cash plus the market value of open positions. The
 * drawdown check used cash alone, which meant buying contracts - converting
 * cash into positions - registered as a loss and halted the bot for the day
 * with nothing actually lost.
 */
async function readEquity() {
  const data = await kalshiGet(`${V2}/portfolio/balance`);
  const cash = (data.balance ?? 0) / 100;
  const positions = (data.portfolio_value ?? 0) / 100;
  return { cash, positions, equity: cash + positions };
}

async function checkDailyHalt(config) {
  const state = loadState();
  const today = new Date().toDateString();
  const { cash, positions, equity } = await readEquity();

  if (state.dayStartDate !== today) {
    state.dayStartDate = today;
    state.dayStartEquity = equity;
    state.dayStartBalance = equity;
    state.haltedForDay = false;
    state.haltReason = null;
    saveState(state);
  }

  if (state.dayStartEquity == null) {
    state.dayStartEquity = equity;
    state.dayStartBalance = equity;
    if (state.haltedForDay) {
      appendLog("Clearing a halt that was measured against cash rather than equity - no real loss occurred.", "warn");
      state.haltedForDay = false;
      state.haltReason = null;
    }
    saveState(state);
  }

  const baseline = state.dayStartEquity || equity;
  const drawdown = baseline > 0 ? (baseline - equity) / baseline : 0;

  // A halt is a STATE, not a verdict carved in stone. This used to return the
  // stored flag and the stored sentence without ever looking at them again, so
  // a halt written under an old limit outlived the limit that caused it: the
  // bot sat blocked reporting "hit the 10% halt limit" while the configured
  // limit was 15% and the actual drawdown was 10.5% - under the rules actually
  // in force, nothing was wrong. It could not clear until the server's calendar
  // day rolled over, which on a UTC host is mid-afternoon local time.
  //
  // So the halt is re-checked against the CURRENT limit and the CURRENT equity
  // every cycle. Hysteresis at 90% of the limit stops it flapping on and off
  // around the boundary: it halts at the limit and only resumes once the
  // drawdown has genuinely pulled back from it.
  if (state.haltedForDay) {
    const resumeBelow = config.dailyLossHaltPct * 0.9;
    if (drawdown < resumeBelow) {
      appendLog(
        `Resuming: drawdown is ${(drawdown * 100).toFixed(1)}%, back under the ` +
        `${(config.dailyLossHaltPct * 100).toFixed(0)}% limit (resume threshold ${(resumeBelow * 100).toFixed(1)}%). ` +
        `Previous halt: ${state.haltReason}`
      );
      state.haltedForDay = false;
      state.haltReason = null;
      saveState(state);
    } else {
      return { halted: true, reason: state.haltReason };
    }
  }

  if (drawdown >= config.dailyLossHaltPct) {
    state.haltedForDay = true;
    state.haltReason =
      `Daily drawdown ${(drawdown * 100).toFixed(1)}% hit the ${(config.dailyLossHaltPct * 100).toFixed(0)}% halt limit ` +
      `(equity $${equity.toFixed(2)} vs $${baseline.toFixed(2)} at open)`;
    saveState(state);
    appendLog(state.haltReason, "error");
    const { botToken, chatId } = getTelegramCredentials();
    notifyDailyHalt({ botToken, chatId, reason: state.haltReason }).catch(() => {});
    return { halted: true, reason: state.haltReason };
  }

  return { halted: false, currentBalance: cash, equity, positionsValue: positions };
}

/** Best resting YES bid, in cents - what the position could be sold into now. */
async function bestYesBidCents(ticker) {
  try {
    const book = await kalshiGet(`${V2}/markets/${ticker}/orderbook`);
    const ob = book?.orderbook_fp ?? book?.orderbook ?? book ?? {};

    let levels = [];
    for (const [k, v] of Object.entries(ob)) {
      if (Array.isArray(v) && k.toLowerCase().startsWith("yes")) { levels = v; break; }
    }

    let best = null;
    for (const lvl of levels) {
      const raw = Array.isArray(lvl) ? lvl[0] : lvl?.price;
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) continue;
      const cents = Math.round(n <= 1 ? n * 100 : n);
      if (best == null || cents > best) best = cents;
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * EXIT POLICY - the single biggest change in this file.
 *
 * Kalshi charges a fee on every trade and charges NOTHING at settlement. A
 * contract bought and held pays one fee; a contract bought and sold back pays
 * two. Measured at the prices this bot trades:
 *
 *   - holding to settlement beats flipping at the old take-profit target by
 *     +4 to +7c per contract
 *   - the old 5% stop-loss cost 12-25% of stake every time it fired, and the
 *     FEES were the larger half of that: 1-3c of price move, 4c of fees
 *   - on a live binary, a 5% swing is one possession, so that stop was firing
 *     on noise and paying 4c to do it
 *
 * So there is no take-profit, no trailing stop and no percentage stop-loss.
 * Positions are held until the game settles.
 *
 * ONE exception, and it is risk control rather than expected value: a genuine
 * blowout. When the price has collapsed far enough that the original thesis is
 * dead and only a sliver of value is left, that sliver is recovered rather than
 * ridden to zero. The thresholds are deliberately deep so this fires on routs,
 * not on a bad quarter.
 *
 * `exitBelowCost` has been removed outright. It compared the bid to the entry
 * price, and the bid is ALWAYS below the entry price immediately after buying,
 * because you buy at the ask. Enabling it would have exited every position at a
 * guaranteed loss 3 minutes after opening it.
 */
function blowoutExitDecision(position, bestBid, config) {
  if (config.holdToSettlement === false) return null;      // explicit opt-out
  if (bestBid == null) return null;

  const floorCents = config.blowoutExitBelowCents ?? 12;
  const collapsePct = config.blowoutExitCollapsePct ?? 0.6;
  const entry = position.entryPriceCents;
  if (!entry) return null;

  const collapse = (entry - bestBid) / entry;
  if (bestBid <= floorCents && collapse >= collapsePct) {
    return `blowout: ${bestBid}c is ${(collapse * 100).toFixed(0)}% below the ${entry}c entry and under the ${floorCents}c floor - recovering the remainder rather than riding it to zero`;
  }
  return null;
}

async function checkOpenPositions(config) {
  const state = loadState();
  if (!state.positions.length) return;

  for (const position of [...state.positions]) {
    try {
      const bestBid = await bestYesBidCents(position.ticker);
      const decision = blowoutExitDecision(position, bestBid, config);
      if (decision) {
        appendLog(`${position.ticker} - ${decision}`, "warn");
        await exitPosition(position, "blowout-exit");
        recordExit(position.ticker);
      }
    } catch (err) {
      appendLog(`Error checking ${position.ticker}: ${err.message}`, "error");
    }
  }
}

export async function runCycle() {
  const config = loadConfig();

  const maxFailures = config.circuitBreakerFailures ?? 3;

  // The breaker used to be a PERMANENT LATCH. Once it tripped, runCycle
  // returned before doing any work - so it could never record the successful
  // cycle that was the only thing able to reset it. Worse, the timer kept
  // running, so isRunning() stayed true and the watchdog went on reporting
  // "healthy" while the bot silently traded nothing until a human restarted
  // it. One transient exchange outage was enough to end the day.
  //
  // It is now a proper breaker: it opens, waits, then half-opens and lets a
  // single probe cycle through. A probe that succeeds clears everything; one
  // that fails re-opens with a doubled cooldown, so a real outage is backed
  // off rather than hammered.
  if (consecutiveFailures >= maxFailures) {
    const cooldown = breakerCooldownMs(config);
    const waited = breakerOpenedAt ? Date.now() - breakerOpenedAt : Infinity;

    if (waited < cooldown) {
      appendLog(
        `Circuit breaker open (${consecutiveFailures} consecutive failures) - ` +
        `retrying in ${Math.ceil((cooldown - waited) / 60000)}m.`,
        "error"
      );
      return;
    }

    // Half-open: allow exactly one attempt. Leaving the counter one below the
    // limit means a single further failure re-opens it immediately.
    appendLog(
      `Circuit breaker half-open after ${Math.round(waited / 60000)}m - running one probe cycle. ` +
      `If it succeeds, normal trading resumes.`,
      "warn"
    );
    consecutiveFailures = maxFailures - 1;
  }

  /**
   * Clears the breaker. Called as soon as the exchange has actually answered,
   * NOT at the end of runCycle - the reset used to live at the bottom of the
   * function, after several legitimate early returns (no active sports, at the
   * position cap, halted for the day, no tradable capital). A quiet night with
   * no games therefore never cleared the counter, and a half-open probe that
   * found nothing to trade counted as a failure even though the exchange had
   * answered perfectly well. Connectivity is what this breaker guards, so
   * connectivity is what clears it.
   */
  const markExchangeReachable = () => {
    if (consecutiveFailures === 0 && breakerTrips === 0) return;
    appendLog("Exchange reachable - circuit breaker cleared, normal trading resumed.");
    consecutiveFailures = 0;
    breakerOpenedAt = null;
    breakerTrips = 0;
    try {
      const st = loadState();
      if (st.circuitBreakerOpen) {
        st.circuitBreakerOpen = false;
        st.circuitBreakerReason = null;
        saveState(st);
      }
    } catch { /* ignore */ }
  };

  try {
    // Reconcile FIRST. A cap full of settled ghosts would otherwise make every
    // check below report "at capacity" and skip the scan.
    const { settled } = await reconcileSettledPositions();
    if (settled) appendLog(`${settled} position(s) settled and cleared from tracking.`);

    const { halted, reason } = await checkDailyHalt(config);
    markExchangeReachable();   // checkDailyHalt reads the balance - the exchange answered
    if (halted) {
      appendLog(`Skipping cycle - halted for today: ${reason}`);
      return;
    }

    await checkOpenPositions(config);

    const tickerMap = loadTickerMap();
    const balanceData = await kalshiGet(`${V2}/portfolio/balance`);
    const bankroll = (balanceData.balance ?? 0) / 100;
    await checkMilestones(config, bankroll);
    await checkDailySummary(config, bankroll);

    const { tier, reserve, tradable } = tradableBankroll(bankroll, config);
    if (tradable <= 0) {
      appendLog(`Balance $${bankroll.toFixed(2)} is entirely reserved - no tradable capital.`, "warn");
      return;
    }

    if (atConcurrentPositionCap(config, bankroll)) {
      // Once every 10 minutes, not every 20-second scan. At peak cadence this
      // wrote 180 identical lines an hour and pushed every useful line out of
      // the 500-entry log buffer, which is how a readable log becomes useless.
      const now = Date.now();
      if (now - lastCapLogAt > 10 * 60 * 1000) {
        lastCapLogAt = now;
        appendLog(`At the concurrent position cap with ${loadState().positions.length} open - waiting for games to settle.`);
      }
      return;
    }

    const activeSports = await discoverActiveSports();
    if (!activeSports.length) {
      appendLog("No active sports returned by the odds provider.", "warn");
      return;
    }

    const skipEvents = openEventKeys();
    const cooling = cooledDownEventKeys(config);
    for (const k of cooling) skipEvents.add(k);

    for (const sportKey of activeSports) {
      const stop = await scanSport({
        sportKey,
        config: {
          ...config,
          kellyFraction: config.kellyFraction ?? tier.kellyFraction,
          maxStakeDollars: tier.maxStakeDollars,
        },
        bankroll: tradable,
        tickerMap,
        skipEvents,
        atCap: () => atConcurrentPositionCap(config, bankroll),
      });
      if (stop) break;
    }

    markExchangeReachable();
  } catch (err) {
    consecutiveFailures++;
    appendLog(`Cycle failed (${consecutiveFailures}/${maxFailures}): ${err.message}`, "error");
    if (consecutiveFailures >= maxFailures) {
      breakerOpenedAt = Date.now();
      breakerTrips++;
      // Persist it. watchdog.js has always read state.circuitBreakerOpen to
      // decide whether to clear a latched breaker - and nothing ever wrote
      // that flag, so its entire recovery branch was dead code. The bot's own
      // half-open above is the primary recovery; this makes the watchdog's
      // backstop real as well, and lets the dashboard show the state.
      try {
        const st = loadState();
        st.circuitBreakerOpen = true;
        st.circuitBreakerReason = err.message;
        st.circuitBreakerAt = new Date().toISOString();
        saveState(st);
      } catch { /* logging must never be the thing that breaks the bot */ }
      appendLog(
        `Circuit breaker tripped (trip #${breakerTrips}) - pausing trading for ` +
        `${Math.round(breakerCooldownMs(config) / 60000)}m, then it will retry on its own. No restart needed.`,
        "error"
      );
    }
  }
}

/**
 * Clears a day halt on demand and re-bases the drawdown baseline to the
 * account's current equity.
 *
 * The automatic re-check above handles a halt whose limit has moved. This is
 * for the other case: a halt that is arithmetically correct but no longer
 * meaningful - a loss taken under a strategy that has since been replaced, or
 * a baseline set before capital was deliberately withdrawn. Without it the only
 * way to trade again was to wait for the server's calendar day to turn over.
 */
export async function resumeTrading() {
  const state = loadState();
  const previous = state.haltReason;

  let equity = null;
  try {
    ({ equity } = await readEquity());
  } catch (err) {
    // Cannot read the account - clear the halt but leave the baseline alone
    // rather than re-basing it to a number we could not verify.
    state.haltedForDay = false;
    state.haltReason = null;
    saveState(state);
    appendLog(`Halt cleared manually. Could not read equity to re-base the baseline (${err.message}).`, "warn");
    return { resumed: true, baselineReset: false, previousHalt: previous };
  }

  state.haltedForDay = false;
  state.haltReason = null;
  state.dayStartEquity = equity;
  state.dayStartBalance = equity;
  state.dayStartDate = new Date().toDateString();
  saveState(state);

  appendLog(
    `Trading resumed manually. Drawdown baseline re-based to $${equity.toFixed(2)}.` +
    (previous ? ` Cleared halt: ${previous}` : "")
  );
  return { resumed: true, baselineReset: true, baselineEquity: equity, previousHalt: previous };
}

export function resetCircuitBreaker() {
  consecutiveFailures = 0;
  breakerOpenedAt = null;
  breakerTrips = 0;
  return { reset: true };
}

function scheduleNextCycle() {
  if (intervalHandle) clearTimeout(intervalHandle);
  intervalHandle = setTimeout(async () => {
    await runCycle();
    if (intervalHandle) scheduleNextCycle();
  }, currentCadenceSeconds() * 1000);
}

export function startBot() {
  const config = loadConfig();
  if (intervalHandle) return { alreadyRunning: true };

  consecutiveFailures = 0;
  breakerOpenedAt = null;
  breakerTrips = 0;
  const { seconds, phase } = describeCadence();
  appendLog(`Bot started (${config.environment}). Scanning every ${seconds}s (${phase}). Pre-game entries, held to settlement.`);

  const state = loadState();
  state.running = true;
  state.botStartedAt = new Date().toISOString();
  saveState(state);

  runCycle().catch((err) => appendLog(`Cycle error: ${err.message}`, "error"));
  scheduleNextCycle();

  positionMonitorHandle = setInterval(() => {
    if (!loadState().positions.length) return;
    checkOpenPositions(loadConfig()).catch((err) => appendLog(`Monitor error: ${err.message}`, "error"));
  }, POSITION_MONITOR_INTERVAL_MS);

  return { started: true };
}

export function stopBot() {
  if (intervalHandle) {
    clearTimeout(intervalHandle);
    intervalHandle = null;
  }
  if (positionMonitorHandle) {
    clearInterval(positionMonitorHandle);
    positionMonitorHandle = null;
  }
  const state = loadState();
  state.running = false;
  saveState(state);
  appendLog("Bot stopped.");
  return { stopped: true };
}

export function isRunning() {
  return intervalHandle !== null;
}
