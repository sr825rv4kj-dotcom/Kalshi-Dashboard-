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
import { getRecentTrades } from "./tradeLedgerStore.js";

const TICKER_MAP_PATH = path.join(CONFIG_DIR, "ticker-map.json");
const V2 = "/trade-api/v2";
const POSITION_MONITOR_INTERVAL_MS = 45 * 1000;

let intervalHandle = null;
let positionMonitorHandle = null;
let consecutiveFailures = 0;

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
 * Milestone tiers. Crossing a milestone used to send a message and change
 * nothing. Now it actually governs how the bot trades: more size, more
 * concurrency, and a reserve that sizing is not allowed to touch.
 */
export function tierFor(bankroll, config) {
  const tiers = config.milestoneTiers || [
    { at: 0,     kellyFraction: 0.10, maxConcurrentPositions: 2, maxStakeDollars: 2,   reservePct: 0.00 },
    { at: 100,   kellyFraction: 0.15, maxConcurrentPositions: 3, maxStakeDollars: 8,   reservePct: 0.10 },
    { at: 500,   kellyFraction: 0.20, maxConcurrentPositions: 5, maxStakeDollars: 30,  reservePct: 0.20 },
    { at: 2500,  kellyFraction: 0.25, maxConcurrentPositions: 8, maxStakeDollars: 120, reservePct: 0.30 },
    { at: 10000, kellyFraction: 0.25, maxConcurrentPositions: 12, maxStakeDollars: 400, reservePct: 0.40 },
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
    tradesExited: todays.filter((t) => t.action === "exit").length,
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

/**
 * Marks a game as just-exited. Without this the bot bought, hit take-profit
 * seconds later, sold, and the very next scan saw the same edge and bought
 * again - a buy/sell loop on one game paying the round-trip fee every lap.
 */
function recordExit(ticker) {
  const state = loadState();
  state.recentExits = state.recentExits || {};
  state.recentExits[eventKeyOf(ticker)] = new Date().toISOString();
  saveState(state);
}

/** Games exited within the cooldown, which this cycle must leave alone. */
function cooledDownEventKeys(config) {
  const minutes = config.reentryCooldownMinutes ?? 30;
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
 * Total account equity: cash plus the market value of open positions. The
 * drawdown check used cash alone, which meant buying contracts - converting
 * cash into positions - registered as a loss. Three small entries moved cash
 * from $19.67 to $16.7 and halted the bot for the day at "15% drawdown" with
 * nothing actually lost. Equity is the only measure that answers "am I down?"
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
    state.dayStartBalance = equity; // kept for the existing status display
    state.haltedForDay = false;
    state.haltReason = null;
    saveState(state);
  }

  // A baseline saved before this change was cash-only, and any halt derived
  // from it measured spending rather than loss. Migrate the baseline and clear
  // that halt once, so the bot is not locked out for a day it never lost money.
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

  if (state.haltedForDay) return { halted: true, reason: state.haltReason };

  const baseline = state.dayStartEquity || equity;
  const drawdown = (baseline - equity) / baseline;
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

/**
 * Best resting YES bid, in cents - what the position could be sold into now.
 * This read book.orderbook.yes, a key Kalshi no longer returns: the book comes
 * back under orderbook_fp with sides named yes_dollars/no_dollars, quoted in
 * dollars. The old read produced null every time, so every position skipped its
 * take-profit and stop-loss checks and simply rode to settlement.
 */
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
 * Kalshi's fee rounds UP to a whole cent per contract, each way. On an 8c
 * contract that is 1c in and 1c out - 25% of the stake in fees - while a 15%
 * take-profit is only 1.2c of gross gain. Every "winner" at that price closed
 * at a loss, which is where $2.21 went in ten round trips.
 *
 * So the exit target is the LARGER of the percentage target and the price that
 * actually clears the round-trip fee plus a margin.
 */
function takeProfitTargetCents(entryCents, config) {
  const pct = config.takeProfitPct ?? 0.12;
  const multiplier = config.feeMultiplier ?? 0.07;
  const minProfitCents = config.minProfitCentsPerContract ?? 1;

  const feeAt = (cents) => {
    const p = cents / 100;
    return Math.ceil(multiplier * p * (1 - p) * 100); // whole cents, as Kalshi charges
  };

  const pctTarget = entryCents * (1 + pct);
  const roundTripFee = feeAt(entryCents) + feeAt(Math.min(99, Math.round(pctTarget)));
  const feeTarget = entryCents + roundTripFee + minProfitCents;

  return Math.ceil(Math.max(pctTarget, feeTarget));
}

async function checkOpenPositions(config) {
  const state = loadState();
  const trailPct = config.trailingStopPct ?? 0.08;
  let dirty = false;


  for (const position of [...state.positions]) {
    try {
      const bestBid = await bestYesBidCents(position.ticker);
      if (bestBid == null) continue;

      const entry = position.entryPriceCents;
      const gainPct = (bestBid - entry) / entry;
      const adverseMovePct = (entry - bestBid) / entry;

      // Track the high-water mark so the trailing stop has a reference.
      if (position.peakBidCents == null || bestBid > position.peakBidCents) {
        position.peakBidCents = bestBid;
        dirty = true;
      }
      const offPeakPct = position.peakBidCents ? (position.peakBidCents - bestBid) / position.peakBidCents : 0;

      const target = takeProfitTargetCents(entry, config);
      if (bestBid >= target) {
        appendLog(
          `${position.ticker} at ${bestBid}c vs ${entry}c entry (+${(gainPct * 100).toFixed(1)}%, ` +
          `target ${target}c clears fees) - taking profit.`
        );

        await exitPosition(position, "take-profit");
        recordExit(position.ticker);
        continue;
      }

      // Only trails once the position has actually been in profit.
      if (position.peakBidCents > entry && offPeakPct >= trailPct) {
        appendLog(
          `${position.ticker} fell ${(offPeakPct * 100).toFixed(1)}% from its ${position.peakBidCents}c peak - trailing out.`,
          "warn"
        );
        await exitPosition(position, "trailing-stop");
        recordExit(position.ticker);
        continue;
      }

      if (config.exitBelowCost && bestBid * position.contracts < entry * position.contracts) {
        appendLog(
          `${position.ticker} worth ${bestBid}c vs ${entry}c paid - exiting below cost.`, "warn"
        );
        await exitPosition(position, "below-cost");
        recordExit(position.ticker);
        continue;
      }

      if (adverseMovePct >= config.perPositionStopLossPct) {
        appendLog(`${position.ticker} down ${(adverseMovePct * 100).toFixed(1)}% from entry - cutting loss.`, "warn");
        await exitPosition(position, "stop-loss");
        recordExit(position.ticker);
      }
    } catch (err) {
      appendLog(`Error checking ${position.ticker}: ${err.message}`, "error");
    }
  }

  if (dirty) {
    const fresh = loadState();
    for (const p of fresh.positions) {
      const match = state.positions.find((s) => s.ticker === p.ticker && s.openedAt === p.openedAt);
      if (match && match.peakBidCents != null) p.peakBidCents = match.peakBidCents;
    }
    saveState(fresh);
  }
}

export async function runCycle() {
  const config = loadConfig();

  // Circuit breaker: stop hammering the exchange after repeated failures.
  const maxFailures = config.circuitBreakerFailures ?? 3;
  if (consecutiveFailures >= maxFailures) {
    appendLog(`Circuit breaker open (${consecutiveFailures} consecutive failures) - skipping cycle.`, "error");
    return;
  }

  try {
    const { halted, reason } = await checkDailyHalt(config);
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

    const activeSports = await discoverActiveSports();
    if (!activeSports.length) {
      appendLog("No active sports returned by the odds provider.", "warn");
      return;
    }

    const skipEvents = openEventKeys();
    const cooling = cooledDownEventKeys(config);
    for (const k of cooling) skipEvents.add(k);
    if (cooling.size) {
      appendLog(`${cooling.size} game(s) in re-entry cooldown - not re-trading them this cycle.`);
    }

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

    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures++;
    appendLog(`Cycle failed (${consecutiveFailures}/${maxFailures}): ${err.message}`, "error");
    if (consecutiveFailures >= maxFailures) {
      appendLog("Circuit breaker tripped - trading paused. Restart the bot once the cause is fixed.", "error");
    }
  }
}

export function resetCircuitBreaker() {
  consecutiveFailures = 0;
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
  const { seconds, phase } = describeCadence();
  appendLog(`Bot started (${config.environment}). Scanning every ${seconds}s (${phase}).`);

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
