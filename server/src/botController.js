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
import { getInSeasonSports, getOutOfSeasonSports } from "./seasonCalendar.js";
import { resolveTicker } from "./tickerResolver.js";
import { notifyMilestone, notifyDailyHalt, notifyDailySummary } from "./notifier.js";
import { getTelegramCredentials } from "./telegramStore.js";
import { getRecentTrades } from "./tradeLedgerStore.js";

const TICKER_MAP_PATH = path.join(CONFIG_DIR, "ticker-map.json");
const POLYMARKET_MAP_PATH = path.join(CONFIG_DIR, "polymarket-map.json");
const V2 = "/trade-api/v2";

let intervalHandle = null;
let positionMonitorHandle = null;
const POSITION_MONITOR_INTERVAL_MS = 90 * 1000; // 90s - independent of the main scan cycle

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

/**
 * Sends one Telegram notification the first time the balance crosses each
 * configured milestone, tracked in state so it never repeats.
 */
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

/**
 * Sends one daily summary once per calendar day (checked on whichever
 * cycle happens to run first after midnight), regardless of whether any
 * trades happened - this is the "throughout the day, even if quiet"
 * signal, separate from the per-trade notifications.
 */
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
  const inSurvivalMode = survivalMode && bankroll < survivalMode.balanceThreshold;

  // Survival mode's own (usually tighter) cap takes priority below the balance
  // threshold. Above it, use the general cap - this is what actually lets the
  // bot hold "several bots' worth" of concurrent positions as funds allow,
  // without needing separate bot instances.
  const cap = inSurvivalMode
    ? survivalMode.maxConcurrentPositions
    : config.maxConcurrentPositions;

  if (!cap) return false;
  const state = loadState();
  return state.positions.length >= cap;
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
      const levels = position.side === "yes" ? book.orderbook?.yes : book.orderbook?.no;
      const bestBid = levels && levels.length ? levels[0][0] : null;
      if (bestBid == null) continue;

      const adverseMovePct = (position.entryPriceCents - bestBid) / position.entryPriceCents;
      if (adverseMovePct >= config.perPositionStopLossPct) {
        appendLog(
          `Position ${position.ticker} down ${(adverseMovePct * 100).toFixed(1)}% from entry - cutting loss now.`, "warn"
        );
        await exitPosition(position, "stop-loss");
      }
    } catch (err) {
      appendLog(`Error checking position ${position.ticker}: ${err.message}`, "error");
    }
  }
}

async function runPolymarketCycle(config, bankroll) {
  const polyMap = loadPolymarketMap();
  const entries = Object.entries(polyMap);
  if (entries.length === 0) {
    appendLog("Polymarket map is empty - nothing to scan.");
    return;
  }

  for (const [slug, ticker] of entries) {
    if (atConcurrentPositionCap(config, bankroll)) {
      appendLog(`Max concurrent positions reached - skipping remaining non-sports scan.`, "warn");
      return;
    }

    let polyData;
    try {
      polyData = await getPolymarketProbability(slug);
    } catch (err) {
      appendLog(`Polymarket fetch failed for "${slug}": ${err.message}`, "warn");
      continue;
    }
    if (!polyData || polyData.closed || !polyData.active) continue;

    let market;
    try {
      const marketRes = await kalshiGet(`${V2}/markets/${ticker}`);
      market = marketRes.market;
    } catch (err) {
      appendLog(`Could not fetch Kalshi market ${ticker}: ${err.message}`, "warn");
      continue;
    }
    if (!market || market.status !== "open") continue;

    const priceDollars = (market.yes_ask ?? 0) / 100;
    const restingContracts = market.yes_ask_size ?? 0;

    const assessment = assessOpportunity({
      bankroll, trueProbability: polyData.trueProbability, price: priceDollars, restingContracts,
      multiplier: config.feeMultiplier, kellyFraction: config.kellyFraction, minLiquidity: config.minLiquidity,
      survivalMode: config.survivalMode,
    });

    if (assessment.action === "skip") {
      appendLog(`Skip (non-sports) ${ticker}: ${assessment.reason}`);
      continue;
    }

    appendLog(
      `Candidate (non-sports, Polymarket-vs-Kalshi) ${ticker}: edge ${(assessment.edgeCheck.observedEdge * 100).toFixed(1)}%, ` +
      `sizing ${assessment.sizing.contracts} contracts. Consensus-vs-consensus edge - lower confidence than sports.`
    );

    await enterPosition({
      ticker, side: "yes", priceCents: market.yes_ask, contracts: assessment.sizing.contracts,
      reason: `Polymarket-vs-Kalshi consensus mismatch on slug "${slug}" (non-sports, lower confidence)`,
              edgePct: assessment.edgeCheck.observedEdge * 100,
        teamName, sportKey, commenceTime,
      });

  }
}

function maybeAdjustScanInterval(config, latestQuotaRemaining, sportsScannedThisCycle) {
  if (latestQuotaRemaining == null || !sportsScannedThisCycle) return;
  const creditsPerScan = sportsScannedThisCycle * 2; // 1 market x 2 regions per sport
  const newInterval = computeAdaptiveIntervalMinutes({ remainingCredits: latestQuotaRemaining, creditsPerScan });
  if (!newInterval) return;

  const current = config.scanIntervalMinutes;
  const percentChange = Math.abs(newInterval - current) / current;
  if (percentChange < 0.2) return;

  appendLog(
    `Adjusting scan interval from ${current}m to ${newInterval}m based on remaining quota ` +
    `(${latestQuotaRemaining} credits, ~${creditsPerScan}/scan). Automatic - no action needed on upgrade.`
  );
  saveConfig({ scanIntervalMinutes: newInterval });

  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = setInterval(() => {
      runCycle().catch((err) => appendLog(`Cycle error: ${err.message}`, "error"));
    }, newInterval * 60 * 1000);
  }
}

export async function runCycle() {
  const config = loadConfig();

  const { halted, reason } = await checkDailyHalt(config);
  if (halted) {
    appendLog(`Skipping cycle - trading halted for today: ${reason}`);
    return;
  }

  await checkOpenPositions(config);

  const tickerMap = loadTickerMap();
  const balanceData = await kalshiGet(`${V2}/portfolio/balance`);
  const bankroll = (balanceData.balance ?? 0) / 100;
  await checkMilestones(config, bankroll);
  await checkDailySummary(config, bankroll);

  if (config.nonSportsEnabled) {
    await runPolymarketCycle(config, bankroll);
  }

  let latestQuotaRemaining = null;

  const activeSports = getInSeasonSports(config.sportsPool || config.sports);
  const skippedSports = getOutOfSeasonSports(config.sportsPool || config.sports);
  if (skippedSports.length) {
    appendLog(`Skipping out-of-season: ${skippedSports.join(", ")}`);
  }

  for (const sportKey of activeSports) {
    let probResult;
    try {
      const tournamentId = (config.oddsPapiTournamentIds || {})[sportKey];
      probResult = await getSharpProbabilities(sportKey, { oddsPapiTournamentId: tournamentId, providerOrder: config.oddsProviderOrder });
    } catch (err) {
      appendLog(`Odds fetch failed for ${sportKey}: ${err.message}`, "error");
      continue;
    }

    if (probResult.fallbackReason) {
      appendLog(`${sportKey}: primary odds source failed (${probResult.fallbackReason}), used fallback.`, "warn");
    }

    appendLog(
      `Scanned ${sportKey} via ${probResult.provider}: ${Object.keys(probResult.probabilities).length} lines found ` +
      `(quota remaining: ${probResult.quota?.remaining ?? "n/a"})`
    );

    if (probResult.quota?.remaining != null) latestQuotaRemaining = Number(probResult.quota.remaining);

    for (const [teamName, { trueProbability, commenceTime }] of Object.entries(probResult.probabilities)) {
      if (atConcurrentPositionCap(config, bankroll)) {
        appendLog(`Max concurrent positions reached - skipping remaining candidates this cycle.`, "warn");
        return;
      }

      let ticker = tickerMap[teamName];
      if (!ticker) {
        const resolved = await resolveTicker({ sportKey, teamName, commenceTime });
        if (!resolved.ticker) {
          appendLog(`Skip "${teamName}": ${resolved.reason}`);
          continue;
        }
        ticker = resolved.ticker;
        appendLog(`Auto-resolved "${teamName}" -> ${ticker}`);
      }

      const windowCheck = withinEntryWindow(commenceTime, config.entryWindowHours ?? 4);
      if (!windowCheck.ok) {
        appendLog(`Skip ${ticker}: ${windowCheck.reason}`);
        continue;
      }

      let market;
      try {
        const marketRes = await kalshiGet(`${V2}/markets/${ticker}`);
        market = marketRes.market;
      } catch (err) {
        appendLog(`Could not fetch Kalshi market ${ticker}: ${err.message}`, "warn");
        continue;
      }
      if (!market || market.status !== "open") continue;

      const priceDollars = (market.yes_ask ?? 0) / 100;
      const restingContracts = market.yes_ask_size ?? 0;

      const assessment = assessOpportunity({
        bankroll, trueProbability, price: priceDollars, restingContracts,
        multiplier: config.feeMultiplier, kellyFraction: config.kellyFraction, minLiquidity: config.minLiquidity,
        survivalMode: config.survivalMode,
      });

      if (assessment.action === "skip") {
        appendLog(`Skip ${ticker}: ${assessment.reason}`);
        continue;
      }

      appendLog(
        `Candidate ${ticker}: edge ${(assessment.edgeCheck.observedEdge * 100).toFixed(1)}%, ` +
        `sizing ${assessment.sizing.contracts} contracts ($${assessment.sizing.dollarsAtRisk.toFixed(2)})` +
        (assessment.survivalMode ? " [survival mode: flat bet]" : "")
      );

      await enterPosition({
        ticker, side: "yes", priceCents: market.yes_ask, contracts: assessment.sizing.contracts,
        reason: `Sharp-book edge via ${probResult.provider} on "${teamName}" (true prob ${(trueProbability * 100).toFixed(1)}% vs price ${(priceDollars * 100).toFixed(0)}c)` +
          (assessment.survivalMode ? " [survival mode]" : ""),
        edgePct: assessment.edgeCheck.observedEdge * 100,
      });
    }
  }

  maybeAdjustScanInterval(config, latestQuotaRemaining, activeSports.length);
}

export function startBot() {
  const config = loadConfig();
  if (intervalHandle) return { alreadyRunning: true };

  appendLog(`Bot starting in ${config.environment.toUpperCase()} mode. Scan interval: ${config.scanIntervalMinutes} minutes.`);

  const state = loadState();
  state.running = true;
  state.botStartedAt = new Date().toISOString();
  saveState(state);

  runCycle().catch((err) => appendLog(`Cycle error: ${err.message}`, "error"));
  intervalHandle = setInterval(() => {
    runCycle().catch((err) => appendLog(`Cycle error: ${err.message}`, "error"));
  }, config.scanIntervalMinutes * 60 * 1000);

  // Independent, much faster loop that only watches positions already open -
  // for tight stop-loss reaction time without re-scanning the whole market
  // (and burning odds-API quota) every 90 seconds.
  positionMonitorHandle = setInterval(() => {
    const currentState = loadState();
    if (!currentState.positions.length) return;
    checkOpenPositions(loadConfig()).catch((err) => appendLog(`Position monitor error: ${err.message}`, "error"));
  }, POSITION_MONITOR_INTERVAL_MS);

  return { started: true };
}

export function stopBot() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
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
