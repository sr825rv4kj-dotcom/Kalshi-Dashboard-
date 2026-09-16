import fs from "fs";
import path from "path";
import { CONFIG_DIR } from "./paths.js";
import { kalshiGet } from "./kalshiClient.js";
import { getSharpProbabilities } from "./scraper.js";
import { assessOpportunity } from "./riskManager.js";
import { enterPosition, exitPosition } from "./executor.js";
import { loadState, saveState, appendLog } from "./stateStore.js";
import { loadConfig } from "./configStore.js";
import { discoverActiveSports } from "./sportsDiscovery.js";
import { currentCadenceSeconds, describeCadence } from "./cadence.js";
import { resolveTicker } from "./tickerResolver.js";
import { notifyMilestone, notifyDailyHalt, notifyDailySummary } from "./notifier.js";
import { getTelegramCredentials } from "./telegramStore.js";
import { getRecentTrades } from "./tradeLedgerStore.js";

const TICKER_MAP_PATH = path.join(CONFIG_DIR, "ticker-map.json");
const V2 = "/trade-api/v2";

let intervalHandle = null;
let positionMonitorHandle = null;
const POSITION_MONITOR_INTERVAL_MS = 90 * 1000; // 90s - independent of the main scan cycle

function loadTickerMap() {
  const raw = JSON.parse(fs.readFileSync(TICKER_MAP_PATH, "utf8"));
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

/**
 * Entry timing gate. With entryWindowHours set to null/0 the gate is OFF
 * entirely - pre-game AND in-progress games are both tradeable, which is
 * what "no windows, trade live games" means.
 *
 * Note: when a game is already in progress, any pre-game sharp line the
 * odds provider returns is stale by definition. The price-threshold path
 * below is what actually drives in-play entries.
 */
function withinEntryWindow(commenceTime, entryWindowHours) {
  if (!entryWindowHours) return { ok: true, live: true };
  if (!commenceTime) return { ok: true, live: false };

  const startMs = new Date(commenceTime).getTime();
  const nowMs = Date.now();
  if (nowMs >= startMs) return { ok: true, live: true };

  const hoursUntilStart = (startMs - nowMs) / (1000 * 60 * 60);
  if (hoursUntilStart > entryWindowHours) {
    return { ok: false, reason: `starts in ${hoursUntilStart.toFixed(1)}h, outside the ${entryWindowHours}h entry window` };
  }
  return { ok: true, hoursUntilStart, live: false };
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

      // What the position is worth right now vs what was paid for it.
      const costCents = position.entryPriceCents * position.contracts;
      const valueCents = bestBid * position.contracts;
      const adverseMovePct = (position.entryPriceCents - bestBid) / position.entryPriceCents;

      // exitBelowCost: bail the moment the position is worth less than it cost.
      // This is the tightest possible stop - it will exit on ordinary noise,
      // and every such exit still pays the round-trip fee.
      if (config.exitBelowCost && valueCents < costCents) {
        appendLog(
          `Position ${position.ticker} worth ${(valueCents / 100).toFixed(2)} vs ${(costCents / 100).toFixed(2)} paid - exiting below cost.`, "warn"
        );
        await exitPosition(position, "below-cost");
      } else if (adverseMovePct >= config.perPositionStopLossPct) {
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

  // Which sports are live right now comes straight from the odds provider -
  // nothing to maintain, seasons handle themselves.
  const activeSports = await discoverActiveSports();
  if (!activeSports.length) {
    appendLog("No active sports returned by the odds provider.", "warn");
    return;
  }

  for (const sportKey of activeSports) {
    let probResult;
    try {
      const tournamentId = (config.oddsPapiTournamentIds || {})[sportKey];
      probResult = await getSharpProbabilities(sportKey, { oddsPapiTournamentId: tournamentId, providerOrder: config.oddsProviderOrder });
    } catch (err) {
      continue;
    }

    // Resolve tickers and pull market prices for every team in parallel.
    // Sequentially this was one round-trip per team (24+ for MLB alone),
    // which is what put entry latency into minutes rather than seconds.
    const teamEntries = Object.entries(probResult.probabilities);
    const drops = { window: 0, unresolved: 0, marketClosed: 0, marketError: 0 };
    let sampleUnresolved = null;

    const prepared = await Promise.all(teamEntries.map(async ([teamName, info]) => {
      const { trueProbability, commenceTime } = info;

      const windowCheck = withinEntryWindow(commenceTime, config.entryWindowHours);
      if (!windowCheck.ok) { drops.window++; return null; }

      let ticker = tickerMap[teamName];
      if (!ticker) {
        const resolved = await resolveTicker({ sportKey, teamName, commenceTime });
        if (!resolved.ticker) {
          drops.unresolved++;
          if (!sampleUnresolved) sampleUnresolved = `${teamName}: ${resolved.reason}`;
          return null;
        }
        ticker = resolved.ticker;
      }

      try {
        const marketRes = await kalshiGet(`${V2}/markets/${ticker}`);
        const market = marketRes.market;
        if (!market || market.status !== "open") { drops.marketClosed++; return null; }
        return { teamName, trueProbability, commenceTime, ticker, market, windowCheck };
      } catch {
        drops.marketError++;
        return null;
      }
    }));

    const viable = prepared.filter(Boolean);
    const rejected = [];

    appendLog(
      `${sportKey}: ${teamEntries.length} lines -> ${viable.length} tradeable ` +
      `(dropped: ${drops.unresolved} unresolved, ${drops.window} out-of-window, ` +
      `${drops.marketClosed} market closed, ${drops.marketError} fetch error)` +
      (sampleUnresolved ? ` | e.g. ${sampleUnresolved}` : "")
    );

    for (const candidate of prepared) {
      if (!candidate) continue;
      const { teamName, trueProbability, commenceTime, ticker, market, windowCheck } = candidate;

      if (atConcurrentPositionCap(config, bankroll)) {
        appendLog(`Max concurrent positions reached - skipping remaining candidates this cycle.`, "warn");
        return;
      }

      const priceDollars = (market.yes_ask ?? 0) / 100;
      const restingContracts = market.yes_ask_size ?? 0;

      const assessment = assessOpportunity({
        bankroll, trueProbability, price: priceDollars, restingContracts,
        multiplier: config.feeMultiplier, kellyFraction: config.kellyFraction, minLiquidity: config.minLiquidity,
        survivalMode: config.survivalMode,
      });

      // Two independent ways in:
      //   1. the fee-aware edge check clears (the original, stricter path), or
      //   2. the contract is priced at or above minEntryPriceCents.
      // Path 2 has no edge signal behind it - it trades on price level alone.
      const minEntryPriceCents = config.minEntryPriceCents ?? 40;
      const meetsPriceFloor = market.yes_ask >= minEntryPriceCents;

      if (assessment.action === "skip" && !meetsPriceFloor) {
        rejected.push(`${ticker} ${market.yes_ask}c: ${assessment.reason}`);
        continue;
      }

      const viaPriceFloor = assessment.action === "skip" && meetsPriceFloor;

      if (viaPriceFloor) {
        // The risk manager declined, so it gave us no size. Fall back to the
        // configured flat stake so the trade is still bounded.
        const flatDollars = (config.survivalMode && bankroll < config.survivalMode.balanceThreshold)
          ? (config.survivalMode.flatBetDollars ?? 1)
          : (config.priceFloorStakeDollars ?? 1);
        const contracts = Math.floor((flatDollars * 100) / market.yes_ask);
        if (contracts <= 0) continue;
        assessment.sizing = { contracts, dollarsAtRisk: (contracts * market.yes_ask) / 100, mode: "price-floor" };
        assessment.edgeCheck = { observedEdge: 0, requiredEdge: 0, margin: 0, qualifies: false };
      }

      appendLog(
        `Candidate ${ticker}: edge ${(assessment.edgeCheck.observedEdge * 100).toFixed(1)}%, ` +
        `sizing ${assessment.sizing.contracts} contracts ($${assessment.sizing.dollarsAtRisk.toFixed(2)})` +
        (assessment.survivalMode ? " [survival mode: flat bet]" : "")
      );

      await enterPosition({
        ticker, side: "yes", priceCents: market.yes_ask, contracts: assessment.sizing.contracts,
        reason: viaPriceFloor
          ? `Price-floor entry on "${teamName}" at ${market.yes_ask}c (>= ${minEntryPriceCents}c floor)` +
            (windowCheck.live ? " [game in progress]" : "") +
            ` - no sharp-book edge behind this, price level only`
          : `Sharp-book edge via ${probResult.provider} on "${teamName}" (true prob ${(trueProbability * 100).toFixed(1)}% vs price ${(priceDollars * 100).toFixed(0)}c)` +
            (windowCheck.live ? " [game in progress]" : "") +
            (assessment.survivalMode ? " [survival mode]" : ""),
        edgePct: assessment.edgeCheck.observedEdge * 100,
        teamName, sportKey, commenceTime,
      });
    }

    if (rejected.length) {
      appendLog(`${sportKey}: ${rejected.length} tradeable market(s) failed entry checks. First: ${rejected[0]}`);
    }
  }
}

/**
 * Reschedules itself after every cycle at whatever cadence the current hour
 * calls for, so the bot tightens up during games and eases off overnight
 * without anyone setting an interval.
 */
function scheduleNextCycle() {
  if (intervalHandle) clearTimeout(intervalHandle);
  const seconds = currentCadenceSeconds();
  intervalHandle = setTimeout(async () => {
    try {
      await runCycle();
    } catch (err) {
      appendLog(`Cycle error: ${err.message}`, "error");
    }
    if (intervalHandle) scheduleNextCycle();
  }, seconds * 1000);
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
