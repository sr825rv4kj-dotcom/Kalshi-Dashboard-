import fs from "fs";
import path from "path";
import { CONFIG_DIR } from "./paths.js";
import { kalshiGet } from "./kalshiClient.js";
import { getSharpProbabilities } from "./scraper.js";
import { getPolymarketProbability } from "./polymarketScraper.js";
import { assessOpportunity } from "./riskManager.js";
import { enterPosition, exitPosition } from "./executor.js";
import { loadState, saveState, appendLog } from "./stateStore.js";
import { loadConfig, saveConfig } from "./configStore.js";
import { computeAdaptiveIntervalMinutes } from "./quotaScheduler.js";
import { notifyMilestone, notifyDailyHalt, notifyDailySummary } from "./notifier.js";
import { getTelegramCredentials } from "./telegramStore.js";
import { getRecentTrades } from "./tradeLedgerStore.js";

const TICKER_MAP_PATH = path.join(CONFIG_DIR, "ticker-map.json");
const POLYMARKET_MAP_PATH = path.join(CONFIG_DIR, "polymarket-map.json");
const V2 = "/trade-api/v2";

let intervalHandle = null;

function loadTickerMap() {
  const raw = JSON.parse(fs.readFileSync(TICKER_MAP_PATH, "utf8"));
  const { _comment, _example, ...map } = raw;
  return map;
}

function loadPolymarketMap() {
  const raw = JSON.parse(fs.readFileSync(POLYMARKET_MAP_PATH, "utf8"));
  const { _comment, _example, ...map } = raw;
  return map;
}

async function checkMilestones(config, currentBalance) {
  const milestones = config.milestones || [];
  if (!milestones.length) return;

  const state = loadState();
  const highestNotified = state.highestMilestoneNotified || 0;
  const newlyCrossed = milestones.filter((m) => m > highestNotified && currentBalance >= m).sort((a, b) => b - a);

  if (newlyCrossed.length > 0) {
    const top = newlyCrossed[0];
    state.highestMilestoneNotified = top;
    saveState(state);
    appendLog(`Milestone reached: $${top.toLocaleString()}`);
    const { botToken, chatId } = getTelegramCredentials();
    await notifyMilestone({ botToken, chatId, milestone: top, currentBalance }).catch(() => {});
  }
}

async function checkDailySummary(config, currentBalance) {
  const state = loadState();
  const today = new Date().toDateString();
  if (state.lastDailySummaryDate === today) return;

  const recentTrades = getRecentTrades(500);
  const todaysTrades = recentTrades.filter((t) => new Date(t.timestamp).toDateString() === today);
  const tradesEntered = todaysTrades.filter((t) => t.action === "enter").length;
  const tradesExited = todaysTrades.filter((t) => t.action === "exit").length;

  const { botToken, chatId } = getTelegramCredentials();
  await notifyDailySummary({
    botToken, chatId, tradesEntered, tradesExited, currentBalance, environment: config.environment,
  }).catch(() => {});

  state.lastDailySummaryDate = today;
  saveState(state);
}

function atConcurrentPositionCap(config, bankroll) {
  const survivalMode = config.survivalMode;
  if (!survivalMode) return false;
  const inSurvivalMode = bankroll < survivalMode.balanceThreshold;
  if (!inSurvivalMode || !survivalMode.maxConcurrentPositions) return false;
  const state = loadState();
  return state.positions.length >= survivalMode.maxConcurrentPositions;
}

function withinEntryWindow(commenceTime, entryWindowHours) {
  if (!commenceTime) return { ok: false, reason: "no start time available for this event" };
  const startMs = new Date(commenceTime).getTime();
  const nowMs = Date.now();
  if (nowMs >= startMs) return { ok: false, reason: "game has already started - pre-game odds are stale" };
  const hoursUntilStart = (startMs - nowMs) / (1000 * 60 * 60);
  if (hoursUntilStart > entryWindowHours) {
    return { ok: false, reason: `starts in ${hoursUntilStart.toFixed(1)}h, outside the ${entryWindowHours}h entry window` };
  }
  return { ok: true, hoursUntilStart };
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
      const
