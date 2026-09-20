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
  return loadState().positions.length >= cap
