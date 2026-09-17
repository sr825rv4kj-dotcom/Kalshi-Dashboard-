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
const POSITION_MONITOR_INTERVAL_MS = 90 * 1000;

let intervalHandle = null;
let positionMonitorHandle = null;

function loadTickerMap() {
  const raw = JSON.parse(fs.readFileSync(TICKER_MAP_PATH, "utf8"));
  const { _comment, _example, ...map } = raw;
  return map;
}

/** One notification the first time the balance crosses each milestone. */
async function checkMilestones(config, currentBalance) {
  const milestones = config.milestones || [];
  if (!milestones.length) return;

  const state = loadState();
  const highest = state.highestMilestoneNotified || 0;
  const crossed = milestones.filter((m) => m > highest && currentBalance >= m).sort((a, b) => b - a);
  if (!crossed.length) return;

  state.highestMilestoneNotified = crossed[0];
  saveState(state);
  appendLog(`Milestone reached: $${crossed[0].toLocaleString()}`);
  const { botToken, chatId } = getTelegramCredentials();
  await notifyMilestone({ botToken, chatId, milestone: crossed[0], currentBalance }).catch(() => {});
}

/** One summary per calendar day, whether or not anything traded. */
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

  // Survival mode's tighter cap applies below the balance threshold; above it
  // the general cap governs, which is what lets the bot hold several
  // positions at once without needing separate bot instances.
  const cap = inSurvival ? sm.maxConcurrentPositions : config.maxConcurrentPositions;
  if (!cap) return false;
  return loadState().positions.length >= cap;
}

async function checkDailyHalt(config) {
  const state = loadState();
  const today = new Date().toDateString();
  const balanceData = await kalshiGet(`${V2}/portfolio/balance`);
  const currentBalance = (balanceData.balance ?? 0) / 100;

  if (state.dayStartDate !== today) {
    state.dayStartDate = today;
    state.dayStartBalance = currentBalance;
    state.haltedForDay = false;
    state.haltReason = null;
    saveState(state);
  }
  if (state.haltedForDay) return { halted: true, reason: state.haltReason };

  const drawdown = (state.dayStartBalance - currentBalance) / state.dayStartBalance;
  if (drawdown >= config.dailyLossHaltPct) {
    state.haltedForDay = true;
    state.haltReason = `Daily drawdown ${(drawdown * 100).toFixed(1)}% hit the ${(config.dailyLossHaltPct * 100).toFixed(0)}% halt limit`;
    saveState(state);
    appendLog(state.haltReason, "error");
    const { botToken, chatId } = getTelegramCredentials();
    notifyDailyHalt({ botToken, chatId, reason: state.haltReason }).catch(() => {});
    return { halted: true, reason: state.haltReason };
  }
  return { halted: false, currentBalance };
}

async function checkOpenPositions(config) {
  const state = loadState();
  for (const position of [...state.positions]) {
    try {
      const book = await kalshiGet(`${V2}/markets/${position.ticker}/orderbook`);
      const levels = position.side === "yes" ? book.orderbook?.yes : book.orderbook?.no;
      const bestBid = levels && levels.length ? levels[0][0] : null;
      if (bestBid == null) continue;

      const costCents = position.entryPriceCents * position.contracts;
      const valueCents = bestBid * position.contracts;
      const adverseMovePct = (position.entryPriceCents - bestBid) / position.entryPriceCents;

      // exitBelowCost is the tightest possible stop: it fires on ordinary
      // noise, and every exit still pays the round-trip fee.
      if (config.exitBelowCost && valueCents < costCents) {
        appendLog(
          `${position.ticker} worth $${(valueCents / 100).toFixed(2)} vs $${(costCents / 100).toFixed(2)} paid - exiting.`,
          "warn"
        );
        await exitPosition(position, "below-cost");
      } else if (adverseMovePct >= config.perPositionStopLossPct) {
        appendLog(
          `${position.ticker} down ${(adverseMovePct * 100).toFixed(1)}% from entry - cutting loss.`,
          "warn"
        );
        await exitPosition(position, "stop-loss");
      }
    } catch (err) {
      appendLog(`Error checking ${position.ticker}: ${err.message}`, "error");
    }
  }
}

export async function runCycle() {
  const config = loadConfig();

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

  // Which sports are live comes straight from the odds provider - nothing to
  // maintain, seasons handle themselves.
  const activeSports = await discoverActiveSports();
  if (!activeSports.length) {
    appendLog("No active sports returned by the odds provider.", "warn");
    return;
  }

  for (const sportKey of activeSports) {
    const stop = await scanSport({
      sportKey,
      config,
      bankroll,
      tickerMap,
      atCap: () => atConcurrentPositionCap(config, bankroll),
    });
    if (stop) return;
  }
}

/**
 * Reschedules itself after every cycle at whatever cadence the current hour
 * calls for, so the bot tightens up during games and eases off overnight
 * without anyone setting an interval.
 */
function scheduleNextCycle() {
  if (intervalHandle) clearTimeout(intervalHandle);
  intervalHandle = setTimeout(async () => {
    try {
      await runCycle();
    } catch (err) {
      appendLog(`Cycle error: ${err.message}`, "error");
    }
    if (intervalHandle) scheduleNextCycle();
  }, currentCadenceSeconds() * 1000);
}

export function startBot() {
  const config = loadConfig();
  if (intervalHandle) return { alreadyRunning: true };

  const { seconds, phase } = describeCadence();
  appendLog(`Bot started (${config.environment}). Scanning every ${seconds}s (${phase}).`);

  const state = loadState();
  state.running = true;
  state.botStartedAt = new Date().toISOString();
  saveState(state);

  runCycle().catch((err) => appendLog(`Cycle error: ${err.message}`, "error"));
  scheduleNextCycle();

  // Independent, faster loop watching only positions already open - tight
  // stop-loss reaction without re-scanning the market every 90 seconds.
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
