import fs from "fs";
import path from "path";
import { CONFIG_DIR } from "./paths.js";
import { kalshiGet } from "./kalshiClient.js";
import { exitPosition } from "./executor.js";
import { loadState, saveState, appendLog } from "./stateStore.js";
import { loadConfig } from "./configStore.js";
import { discoverActiveSports, allActiveSportKeys } from "./sportsDiscovery.js";
import { discoverSeriesMap } from "./seriesDiscovery.js";
import { setSeriesMap } from "./tickerResolver.js";
import { currentCadenceSeconds, describeCadence } from "./cadence.js";
import { scanSport } from "./scanner.js";
import { notifyMilestone, notifyDailyHalt, notifyDailySummary } from "./notifier.js";
import { getTelegramCredentials } from "./telegramStore.js";
import { getRecentTrades, recordTrade, scheduleFeeCents, loadLedger } from "./tradeLedgerStore.js";
import { syncResting, cancelAllResting, restingCount } from "./makerEngine.js";
import { getSharpProbabilities } from "./scraper.js";
import {
  fairValueExitDecision, fairValueMode, shouldLogShadow, recordDecision, recordFairFromProbabilities,
} from "./fairValue.js";
import { registerOpenPositions, markDue, needsBackfill, backfillFromLedger } from "./clvTracker.js";

const TICKER_MAP_PATH = path.join(CONFIG_DIR, "ticker-map.json");
const V2 = "/trade-api/v2";
const POSITION_MONITOR_INTERVAL_MS = 3 * 60 * 1000;

export const CONTROLLER_VERSION = "2026-09-24-fair-value-clv";

/**
 * 2026-09-24 - four changes in this file:
 *
 * 1. FAIR-VALUE EXIT (fairValue.js). Sells when the Kalshi bid, after the exit
 *    fee and a 1c cross, is worth more than the sharp line says the contract
 *    is worth held. Runs "shadow" by default: it logs WOULD SELL with the real
 *    numbers and sells nothing until config.fairValueExit is set to "live".
 *
 * 2. CLV MARKING (clvTracker.js). Every open position is registered, and every
 *    due mark is taken against the live book, once per cycle.
 *
 * 3. FAIR VALUES STAY FRESH FOR HELD GAMES. The cycle returns early at the
 *    position cap and never scans - exactly when an exit is most useful. Held
 *    sports that were not scanned this cycle now get their sharp line read
 *    anyway, so the exit rule is never working from a stale number.
 *
 * 4. THE TAKER CAP COUNTS RESTING BIDS. The log showed "7 held + 3 bids, cap
 *    10" followed by a taker fill to 8 held + 3 bids = 11. The taker path now
 *    stops at positions + bids >= cap. The cycle-level check still counts
 *    positions only, so bids keep being re-priced and synced at the cap.
 */

/**
 * 2026-09-23 - three fixes in this file:
 *
 * 1. SETTLEMENT IS VERIFIED, NOT ASSUMED. A position missing from
 *    /portfolio/positions was booked as settled on the spot. Kalshi reports an
 *    unsettled market as status "active", result "" (checked live against
 *    KXMLBGAME-26SEP251905BALNYY-NYY), and a finished one as "finalized",
 *    result "yes"/"no" (KXNFLGAME-26SEP20JACDEN-DEN). The old code booked both
 *    the same way. So a fresh fill the portfolio endpoint had not caught up
 *    with yet was written off as "settled-unknown" and dropped from tracking,
 *    which also removed its game from the one-position-per-game guard, so the
 *    next scan was free to buy the same game again. Now a position is booked
 *    only when the market reports a result. A live market that is simply
 *    missing from the portfolio is kept, and only written off as
 *    "closed-externally" after 30 minutes (e.g. sold by hand in the Kalshi app).
 *
 * 2. ONE POSITION CHECK AT A TIME. checkOpenPositions ran from two places, the
 *    scan cycle and a 3-minute monitor, with nothing stopping them overlapping.
 *    Both could read the same position at 97c and both could send the sell.
 *    Selling YES you no longer hold opens a short. Now a second call waits its
 *    turn and then re-reads state.
 *
 * 3. THE CEILING EXIT FIRES ONLY WHEN THE SLOT OR CASH IS NEEDED. Selling at a
 *    97-99c bid pays a 1c/contract fee to bank what settlement pays for free.
 *    It was sold every time (9 ceiling exits so far), even with slots and cash
 *    free and nothing to redeploy into. It now sells only when the bot is at its
 *    position cap or cash is below one stake. Set ceilingExitOnlyWhenNeeded:
 *    false to restore the old behaviour.
 */

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
 * Sizing tiers. Crossing a milestone governs how the bot trades: more size,
 * more concurrency, and a reserve that sizing is not allowed to touch.
 * Once the balance clears survival mode the bot is no longer
 * protecting a fragile bankroll, so the caps step up rather than staying at
 * survival-era numbers - that was leaving most of the balance idle at exactly
 * the point the strategy had proven itself.
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

/** The position cap in force at this bankroll (survival mode or milestone tier). */
function positionCapFor(config, bankroll) {
  const sm = config.survivalMode;
  const inSurvival = sm && bankroll < sm.balanceThreshold;
  const tier = tierFor(bankroll, config);
  return inSurvival
    ? sm.maxConcurrentPositions
    : (config.maxConcurrentPositions ?? tier.maxConcurrentPositions);
}

function atConcurrentPositionCap(config, bankroll) {
  const cap = positionCapFor(config, bankroll);
  if (!cap) return false;
  return loadState().positions.length >= cap;
}

/** The taker path's cap: positions PLUS resting bids, so it can never overshoot. */
function takerAtCap(config, bankroll) {
  const cap = positionCapFor(config, bankroll);
  if (!cap) return false;
  let bids = 0;
  try { bids = restingCount(); } catch { bids = 0; }
  return loadState().positions.length + bids >= cap;
}

/** Sports switched off by hand (config.disabledSports). */
function disabledSports(config) {
  return new Set((config.disabledSports || []).map((k) => String(k)));
}

/**
 * Reads the sharp line for every sport with an open position that was NOT
 * scanned this cycle, so the fair-value exit always has a fresh number.
 * One odds call per held sport; never throws.
 */
async function refreshHeldFairValues(config, alreadyScanned = new Set()) {
  const held = [...new Set(loadState().positions.map((p) => p.sportKey).filter(Boolean))]
    .filter((k) => !alreadyScanned.has(k));
  for (const sportKey of held) {
    try {
      const r = await getSharpProbabilities(sportKey, {
        oddsPapiTournamentId: (config.oddsPapiTournamentIds || {})[sportKey],
        providerOrder: config.oddsProviderOrder,
      });
      recordFairFromProbabilities(sportKey, r.probabilities);
    } catch {
      // the exit refuses on a stale fair value - that is the safe failure
    }
  }
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
  // Prune anything older than two days so state.json does not grow forever.
  const keepAfter = Date.now() - 48 * 60 * 60 * 1000;
  for (const [key, iso] of Object.entries(state.recentExits)) {
    if (new Date(iso).getTime() < keepAfter) delete state.recentExits[key];
  }
  saveState(state);
}

/** Kalshi statuses that mean the market has a final answer. */
const SETTLED_STATUSES = new Set(["finalized", "settled", "determined"]);

/** A position missing from the portfolio on a still-live market is kept this long. */
const MISSING_GRACE_MS = 30 * 60 * 1000;

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
export async function reconcileSettledPositions() {
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
  const missingMarks = new Map();   // ticker|openedAt -> first-missing ISO, written back below

  for (const position of state.positions) {
    if (heldNow.has(position.ticker)) { stillOpen.push(position); continue; }

    // EVERY POSITION IS RECONCILED INDEPENDENTLY.
    //
    // recordTrade() below parses trade-ledger.json, and that parse was not
    // guarded - only the market lookup was. A truncated ledger therefore threw
    // out of this loop, so NO position was ever cleared, the cap filled with
    // games that had already settled, and three cycles of it tripped the
    // circuit breaker. Because the corruption is permanent, every half-open
    // probe re-tripped it with the cooldown doubling toward an hour. That is
    // exactly the silent stop this function exists to prevent.
    try {
      // Gone from the exchange: it settled. Read the real outcome so the ledger
      // records what actually happened rather than an assumption.
      let settlementCents = null;
      let marketStatus = null;
      let marketRead = false;
      try {
        const res = await kalshiGet(`${V2}/markets/${position.ticker}`);
        marketRead = true;
        marketStatus = String(res.market?.status || "").toLowerCase();
        const result = String(res.market?.result || "").toLowerCase();
        if (result === "yes") settlementCents = 100;
        else if (result === "no") settlementCents = 0;
      } catch {
        // could not read the market - handled below
      }

      const hasResult = settlementCents != null;
      const marketFinished = hasResult || SETTLED_STATUSES.has(marketStatus);

      // NOT SETTLED: keep tracking it. Either the portfolio has not caught up
      // with a fresh fill, the market could not be read, or it was closed
      // outside the bot. Only the last is ever written off, and only after the
      // grace period, so the one-per-game guard keeps covering this game.
      if (!marketFinished) {
        const key = `${position.ticker}|${position.openedAt}`;
        const firstMissing = position.missingSince ? Date.parse(position.missingSince) : Date.now();
        const missingFor = Date.now() - firstMissing;
        if (!marketRead || missingFor < MISSING_GRACE_MS) {
          if (!position.missingSince) missingMarks.set(key, new Date(firstMissing).toISOString());
          stillOpen.push(position);
          continue;
        }
        // Live market, gone from the account for 30+ minutes: closed outside the bot.
        recordTrade({
          action: "exit",
          ticker: position.ticker,
          side: "yes",
          contracts: position.contracts,
          priceCents: position.entryPriceCents,
          exitPriceCents: null,
          filled: position.contracts,
          reason: "closed-externally",
          edgePct: null,
          environment: loadConfig().environment,
          teamName: position.teamName ?? null,
          sportKey: position.sportKey ?? null,
          commenceTime: position.commenceTime ?? null,
          source: position.source ?? "taker",
        });
        appendLog(
          `${position.ticker} is no longer held but the market is still ${marketStatus || "open"} - ` +
          `it was closed outside the bot. Stopped tracking it after ${Math.round(missingFor / 60000)}m; ` +
          `check the Kalshi app for the actual exit price.`, "warn"
        );
        settledCount++;
        continue;
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
        // Maker vs taker, so resting-bid fills can be scored on their own.
        source: position.source ?? "taker",
      });

      // Net AFTER the entry fee - what actually reached the account.
      const entryFee = scheduleFeeCents(position.entryPriceCents, position.contracts, position.source === "maker");
      const net = settlementCents == null
        ? "outcome unavailable"
        : `$${(((settlementCents - position.entryPriceCents) * position.contracts - entryFee) / 100).toFixed(2)} after the ${entryFee}c entry fee`;
      appendLog(
        `${position.ticker} settled ${settlementCents == null ? "(result unreadable)" : settlementCents === 100 ? "YES - won" : "NO - lost"}: ` +
        `${position.contracts} contracts @ ${position.entryPriceCents}c entry, net ${net}. No exit fee - settlement is free.`
      );
      settledCount++;
    } catch (err) {
      // This position could not be booked. Keep it tracked so it is retried
      // next cycle, log loudly, and carry on with the rest - one unreadable
      // settlement must never cost the others their reconciliation.
      appendLog(
        `Could not book the settlement of ${position.ticker} (${err && err.message}) - ` +
        `keeping it tracked and retrying next cycle.`, "error"
      );
      stillOpen.push(position);
    }
  }

  // Positions that reappear in the portfolio lose any stale missing mark.
  const heldAgain = state.positions.filter((p) => p.missingSince && heldNow.has(p.ticker));

  if (settledCount || missingMarks.size || heldAgain.length) {
    const fresh = loadState();
    const cleared = new Set(stillOpen.map((p) => `${p.ticker}|${p.openedAt}`));
    const settledKeys = new Set(
      state.positions
        .filter((p) => !heldNow.has(p.ticker) && !cleared.has(`${p.ticker}|${p.openedAt}`))
        .map((p) => `${p.ticker}|${p.openedAt}`)
    );
    fresh.positions = fresh.positions
      .filter((p) => !settledKeys.has(`${p.ticker}|${p.openedAt}`))
      .map((p) => {
        const key = `${p.ticker}|${p.openedAt}`;
        if (missingMarks.has(key)) return { ...p, missingSince: missingMarks.get(key) };
        if (p.missingSince && heldNow.has(p.ticker)) {
          const { missingSince, ...rest } = p;
          return rest;
        }
        return p;
      });
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
  // THE HALT LIMIT IS VALIDATED BEFORE IT IS COMPARED AGAINST.
  //
  // loadConfig is {...DEFAULTS, ...stored} and POST /api/bot/config writes
  // arbitrary JSON, so any stored value beats the default. Both plausible
  // wrong values failed silently and in opposite directions:
  //
  //   dailyLossHaltPct: 15   (a percent in a field that holds a fraction)
  //     -> a 60% drawdown compares as 0.60 >= 15 = false. The guard is OFF and
  //        the whole bankroll is unprotected. Reproduced: equity $10 against a
  //        $25 baseline, haltedForDay stayed false.
  //
  //   dailyLossHaltPct: null
  //     -> `0 >= null` is TRUE in JavaScript, so it halts at 0.0% drawdown on
  //        the first cycle, and the resume test `drawdown < null*0.9` is never
  //        true, so the halt is PERMANENT - logged only at info level.
  //
  // Anything outside a sane fractional range falls back to the default.
  const rawHaltPct = Number(config.dailyLossHaltPct);
  const haltPct = Number.isFinite(rawHaltPct) && rawHaltPct > 0 && rawHaltPct <= 1
    ? rawHaltPct
    : 0.15;
  if (haltPct !== config.dailyLossHaltPct) {
    appendLog(
      `dailyLossHaltPct is ${JSON.stringify(config.dailyLossHaltPct)}, which is not a fraction between 0 and 1 - ` +
      `using ${haltPct} instead. Set it from the dashboard as a decimal (0.15 = 15%).`, "warn"
    );
  }

  if (state.haltedForDay) {
    const resumeBelow = haltPct * 0.9;
    if (drawdown < resumeBelow) {
      appendLog(
        `Resuming: drawdown is ${(drawdown * 100).toFixed(1)}%, back under the ` +
        `${(haltPct * 100).toFixed(0)}% limit (resume threshold ${(resumeBelow * 100).toFixed(1)}%). ` +
        `Previous halt: ${state.haltReason}`
      );
      state.haltedForDay = false;
      state.haltReason = null;
      state.haltDate = null;
      saveState(state);
    } else {
      return { halted: true, reason: state.haltReason };
    }
  }

  if (drawdown >= haltPct) {
    state.haltedForDay = true;
    // Stamp the DAY the halt belongs to. Without this the watchdog cannot tell
    // a halt taken an hour ago from one taken last Tuesday, and a stopped bot
    // that was halted could never restart itself.
    state.haltDate = today;
    state.haltReason =
      `Daily drawdown ${(drawdown * 100).toFixed(1)}% hit the ${(haltPct * 100).toFixed(0)}% halt limit ` +
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
async function yesQuote(ticker) {
  try {
    const book = await kalshiGet(`${V2}/markets/${ticker}/orderbook`);
    const ob = book?.orderbook_fp ?? book?.orderbook ?? book ?? {};

    let levels = [];
    for (const [k, v] of Object.entries(ob)) {
      if (Array.isArray(v) && k.toLowerCase().startsWith("yes")) { levels = v; break; }
    }

    const bestOf = (side) => {
      let best = null;
      for (const lvl of side) {
        const raw = Array.isArray(lvl) ? lvl[0] : lvl?.price;
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) continue;
        const cents = Math.round(n <= 1 ? n * 100 : n);
        if (best == null || cents > best) best = cents;
      }
      return best;
    };

    let noLevels = [];
    for (const [k, v] of Object.entries(ob)) {
      if (Array.isArray(v) && k.toLowerCase().startsWith("no")) { noLevels = v; break; }
    }

    const bid = bestOf(levels);
    const bestNo = bestOf(noLevels);
    // Buying YES means selling NO to a bidder, so the YES ask is 100 - best NO bid.
    const ask = bestNo != null && bestNo > 0 && bestNo < 100 ? 100 - bestNo : null;
    return { bid, ask, spread: bid != null && ask != null ? ask - bid : null };
  } catch {
    return { bid: null, ask: null, spread: null };
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
function blowoutExitDecision(position, quote, config) {
  // OFF BY DEFAULT (2026-09-23). The account's own record: 4 positions held to
  // settlement, 4 won, +139%; 27 sold early, +4%. The two most recent blowout
  // sells - Angels 85c -> 4c and Sri Lanka 12c -> 4c - each paid a fee and the
  // spread to recover 4c that settlement would have paid out or lost for
  // free, and gave up the whole payout on a comeback. Held positions settle
  // at no fee. Set config.blowoutExit = true to bring this rule back.
  if (config.blowoutExit !== true) return null;
  if (config.holdToSettlement === false) return null;
  const bestBid = quote?.bid;
  if (bestBid == null) return null;

  const floorCents = config.blowoutExitBelowCents ?? 12;
  const collapsePct = config.blowoutExitCollapsePct ?? 0.6;
  const entry = position.entryPriceCents;
  if (!entry || !floorCents) return null;

  const collapse = (entry - bestBid) / entry;
  if (!(bestBid <= floorCents && collapse >= collapsePct)) return null;

  /**
   * The collapse test alone is not enough, and this is what it cost to learn:
   *
   *   HOU bought 5 @ 34c. Price collapsed, the rule fired, and it sold at the
   *   10c BID while the ask was still ~17c - a 7c spread on a 10c contract,
   *   a 41% discount to the mid. It took $0.45 for something worth about
   *   $0.70 held, because SETTLEMENT IS FREE and selling pays both a fee and
   *   the entire spread.
   *
   * On a cheap contract the spread is proportionally enormous, so dumping into
   * the bid is nearly always value-destroying. The exit now also requires the
   * book to be TIGHT - only then is the bid close enough to fair value to be
   * worth taking. A wide book means there is no real buyer, and the right move
   * is to let it settle for nothing rather than pay to get out.
   */
  const maxSpread = config.blowoutExitMaxSpreadCents ?? 2;
  if (quote.spread == null) {
    return null; // cannot see the other side - do not dump blind
  }
  if (quote.spread > maxSpread) {
    return null;
  }

  return `blowout: ${bestBid}c is ${(collapse * 100).toFixed(0)}% below the ${entry}c entry, ` +
    `under the ${floorCents}c floor, and the book is tight (${quote.spread}c spread) - ` +
    `taking the bid rather than riding it to zero`;
}

/**
 * CEILING EXIT - bank a position that is all but settled.
 *
 * Holding to settlement is right almost everywhere, because settlement is free
 * and selling pays a fee. At the very top of the range that stops being true,
 * for three reasons that all point the same way:
 *
 *   1. The trade is over. A contract bid at 97c has 3c of upside left. It is
 *      not an investment any more, it is a receivable.
 *   2. It is occupying a slot, and the slot cap is the thing that has actually
 *      been blocking new trades on a busy slate. The cash inside it earns
 *      nothing until the whistle, which can be hours away.
 *   3. The risk is wildly asymmetric. Five contracts held at 97c risk $4.85 to
 *      win $0.15, and 3% of the time the whole $4.85 is gone. Selling banks
 *      $4.80 with certainty.
 *
 * The cost is exactly 1c per contract - the exit fee - anywhere in the 92-99c
 * range. Redeploying even $1.50 into an ordinary +2c edge is worth about 6c,
 * several times what the exit costs.
 *
 * A spread guard is kept for symmetry with the blowout exit, but it is close to
 * unreachable here and that is worth being straight about: a bid of 97c cannot
 * have an ask more than 3c away, because the ask cannot exceed 100c. What
 * actually protects this exit is the price itself. Selling at a 97c BID is
 * banking 96c against a hold worth 97c - a bounded 1c give-up no matter what
 * the other side of the book looks like. That is the opposite of the HOU exit,
 * where a 10c bid sat 7c under the ask and selling meant taking a 41% discount.
 */
function ceilingExitDecision(position, quote, config) {
  const at = config.ceilingExitAtCents ?? 97;
  if (!at) return null;

  const bid = quote?.bid;
  if (bid == null || bid < at) return null;

  const maxSpread = config.ceilingExitMaxSpreadCents ?? 3;
  if (quote.spread != null && quote.spread > maxSpread) return null;
  // Note: an unreadable spread does NOT block this exit, unlike the blowout
  // rule. At 97c+ the bid alone caps the downside at 1c, so refusing to act on
  // a missing ask would leave capital parked for no protection.

  const entry = position.entryPriceCents || 0;
  const gain = entry ? (((bid - entry) / entry) * 100).toFixed(0) : "?";
  return `ceiling: ${bid}c bid is at or above the ${at}c take-out level ` +
    `(entry ${entry}c, +${gain}%) - banking it and freeing the slot rather than ` +
    `risking ${bid}c to win the last ${100 - bid}c`;
}

/**
 * Is a slot or cash actually needed right now? The ceiling exit is only worth
 * its 1c/contract fee if the capital it frees has somewhere to go. Unreadable
 * balance counts as "needed", which falls back to the old always-sell behaviour
 * rather than holding on a guess.
 */
export function capitalNeeded({ openPositions, cap, cashDollars, stakeDollars }) {
  if (cap && openPositions >= cap) return { needed: true, why: `at the ${cap}-position cap` };
  if (cashDollars == null) return { needed: true, why: "balance unreadable" };
  if (cashDollars < stakeDollars) {
    return { needed: true, why: `cash $${cashDollars.toFixed(2)} is below one $${stakeDollars.toFixed(2)} stake` };
  }
  return { needed: false, why: `${openPositions}/${cap || "no"} slots used and $${cashDollars.toFixed(2)} cash free` };
}

async function readCapitalNeed(config, openPositions) {
  let cash = null;
  try {
    const b = await kalshiGet(`${V2}/portfolio/balance`);
    cash = (b.balance ?? 0) / 100;
  } catch {
    cash = null;
  }
  const bankroll = cash ?? 0;
  const sm = config.survivalMode;
  const inSurvival = sm && bankroll < sm.balanceThreshold;
  // Smallest stake worth freeing cash for: the survival flat bet, or $1.
  const stake = inSurvival ? (sm.flatBetDollars ?? 1) : 1;
  return capitalNeeded({ openPositions, cap: positionCapFor(config, bankroll), cashDollars: cash, stakeDollars: stake });
}

// Only one position check runs at a time. The scan cycle and the 3-minute
// monitor both call this; overlapping runs could sell the same position twice.
let positionCheckRunning = null;

export async function checkOpenPositions(config) {
  if (positionCheckRunning) {
    // Let the running check finish. Its exits are then visible in state, so a
    // position is never sold twice.
    await positionCheckRunning.catch(() => {});
    return;
  }
  positionCheckRunning = checkOpenPositionsOnce(config);
  try {
    await positionCheckRunning;
  } finally {
    positionCheckRunning = null;
  }
}

async function checkOpenPositionsOnce(config) {
  const state = loadState();
  if (!state.positions.length) return;

  let need = null;   // read lazily - only when a ceiling candidate exists

  for (const position of [...state.positions]) {
    try {
      // Re-read: an earlier iteration may have exited or settled this one.
      if (!loadState().positions.some((p) => p.ticker === position.ticker && p.openedAt === position.openedAt)) continue;

      const quote = await yesQuote(position.ticker);

      // Winners first: a position at the ceiling is the cheapest slot to free.
      const ceiling = ceilingExitDecision(position, quote, config);
      if (ceiling) {
        if (config.ceilingExitOnlyWhenNeeded !== false) {
          if (!need) need = await readCapitalNeed(config, loadState().positions.length);
          if (!need.needed) {
            // Holding: settlement pays the same for free. Logged once per position.
            if (!position.ceilingHoldLogged) {
              appendLog(`${position.ticker} - at ${quote.bid}c, holding to settlement instead of paying the exit fee (${need.why}).`);
              const st = loadState();
              const p = st.positions.find((x) => x.ticker === position.ticker && x.openedAt === position.openedAt);
              if (p) { p.ceilingHoldLogged = true; saveState(st); }
            }
            continue;
          }
          appendLog(`${position.ticker} - ${ceiling} [${need.why}]`);
        } else {
          appendLog(`${position.ticker} - ${ceiling}`);
        }
        await exitPosition(position, "ceiling-exit");
        recordExit(position.ticker);
        // One freed slot answers the need; re-check before selling another.
        need = null;
        continue;
      }

      // FAIR-VALUE EXIT. Shadow by default - see fairValue.js.
      const fv = fairValueExitDecision(position, quote, config);
      if (fv.action === "sell") {
        const mode = fairValueMode(config);
        if (mode === "live") {
          appendLog(`${position.ticker} - ${fv.line}`);
          recordDecision({ mode, ticker: position.ticker, team: position.teamName, action: "SOLD", bid: fv.bid, fairCents: fv.fairCents, sellNetCents: fv.sellNetCents, entry: position.entryPriceCents });
          await exitPosition(position, "fair-value-exit");
          recordExit(position.ticker);
          continue;
        }
        if (shouldLogShadow(position, quote.bid)) {
          appendLog(`${position.ticker} - SHADOW, would sell: ${fv.line} (set fairValueExit to "live" to act)`);
          recordDecision({ mode, ticker: position.ticker, team: position.teamName, action: "WOULD SELL", bid: fv.bid, fairCents: fv.fairCents, sellNetCents: fv.sellNetCents, entry: position.entryPriceCents });
        }
      } else if (fv.action === "refuse" && fv.code === "suspect-mapping" && !position.suspectLogged) {
        appendLog(`${position.ticker} (${position.teamName}) - ${fv.why}. Check this position by hand in the Kalshi app.`, "warn");
        recordDecision({ mode: fairValueMode(config), ticker: position.ticker, team: position.teamName, action: "SUSPECT MAPPING", bid: quote.bid, entry: position.entryPriceCents, why: fv.why });
        const st = loadState();
        const p = st.positions.find((x) => x.ticker === position.ticker && x.openedAt === position.openedAt);
        if (p) { p.suspectLogged = true; saveState(st); }
      }

      const decision = blowoutExitDecision(position, quote, config);
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

    // CLV: register new fills, take every mark that is due. Never blocks a cycle.
    try {
      registerOpenPositions(loadState().positions, config);
      const m = await markDue(config);
      if (m.marked || m.dropped) appendLog(`CLV: ${m.marked} mark(s) taken, ${m.dropped} dropped (see /api/clv).`);
      // First run on this volume: mark the account's history from Kalshi's own
      // one-minute candles so the kill switch starts from the real record.
      if (needsBackfill()) {
        const entries = loadLedger().filter((t) => t.action === "enter" && t.filled > 0);
        const b = await backfillFromLedger(entries, config);
        const skipped = Object.entries(b.skipped).map(([k, n]) => `${k} x${n}`).join(", ") || "none";
        appendLog(`CLV backfill: ${b.marked} of ${b.considered} past trades marked from Kalshi candles. Skipped: ${skipped}.` +
          (b.examples.length ? ` e.g. ${b.examples[0]}` : ""));
      }
    } catch (err) {
      appendLog(`CLV marking skipped this cycle (${err.message}).`, "warn");
    }

    const { halted, reason } = await checkDailyHalt(config);
    markExchangeReachable();   // checkDailyHalt reads the balance - the exchange answered
    if (halted) {
      // A halted day must not keep buying through resting bids either.
      const n = await cancelAllResting("trading halted for the day").catch(() => 0);
      appendLog(`Skipping cycle - halted for today: ${reason}` + (n ? ` (${n} resting bid(s) cancelled)` : ""));
      return;
    }

    await checkOpenPositions(config);

    const tickerMap = loadTickerMap();
    const balanceData = await kalshiGet(`${V2}/portfolio/balance`);
    const bankroll = (balanceData.balance ?? 0) / 100;
    await checkMilestones(config, bankroll);
    await checkDailySummary(config, bankroll);

    // RESTING BIDS: book any fills since the last cycle, drop finished orders,
    // cancel any the scan has stopped confirming, and trim bids so positions
    // plus bids never exceed the cap. Runs BEFORE the cap check below, so a
    // fill is counted before the cycle decides whether it has room.
    const makerSync = await syncResting({ cap: positionCapFor(config, bankroll) });
    if (makerSync.filled || makerSync.stale || makerSync.trimmed || makerSync.tossed) {
      appendLog(
        `Resting bids: ${makerSync.filled} contract(s) filled, ${makerSync.tossed || 0} tossed unfilled, ` +
        `${makerSync.stale} cancelled as unconfirmed, ${makerSync.trimmed} cancelled to stay under the position cap.`
      );
    }

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
      // Not scanning - but held games still need a fresh fair value for exits.
      await refreshHeldFairValues(config);
      return;
    }

    // Refresh which Kalshi series exist BEFORE deciding what is scannable.
    // Six hardcoded sports were the real reason the bot sat idle on a board of
    // 86 live markets; this asks Kalshi what it actually lists. Cached 6h, so
    // this is one extra call a few times a day.
    try {
      const candidates = await allActiveSportKeys();
      if (candidates.length) {
        setSeriesMap(await discoverSeriesMap(kalshiGet, candidates));
      }
    } catch (err) {
      appendLog(`Series discovery skipped this cycle (${err.message}).`, "warn");
    }

    const activeSports = await discoverActiveSports();
    if (!activeSports.length) {
      appendLog("No active sports returned by the odds provider.", "warn");
      return;
    }

    const skipEvents = openEventKeys();
    const cooling = cooledDownEventKeys(config);
    for (const k of cooling) skipEvents.add(k);

    const off = disabledSports(config);
    const scanned = new Set();
    for (const sportKey of activeSports) {
      if (off.has(sportKey)) continue;
      scanned.add(sportKey);
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
        atCap: () => takerAtCap(config, bankroll),
        positionCap: positionCapFor(config, bankroll),
      });
      if (stop) break;
    }

    await refreshHeldFairValues(config, scanned);

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

/**
 * THE SCAN TIMER MUST NEVER DIE.
 *
 * This used to be `await runCycle(); if (intervalHandle) scheduleNextCycle();`
 * with nothing catching a rejection. runCycle has its own try/catch, but
 * appendLog runs inside that catch and appendLog reads state.json - so a
 * truncated state file (a SIGKILL or a full disk mid-write) made the error
 * handler itself throw, the rejection escaped, and the chain simply stopped.
 *
 * Worse, `intervalHandle` still pointed at the already-fired Timeout, so
 * isRunning() kept returning true. The watchdog looked, saw "healthy", and did
 * nothing. Reproduced end to end: one failure, then zero cycles for the next
 * 45 seconds even after the state file was repaired, with the watchdog logging
 * "healthy - bot running" throughout. The only recovery was a human pressing
 * Stop then Start.
 *
 * Now the re-arm is in a finally block, so nothing that happens inside a cycle
 * can stop the next one being scheduled.
 */
function scheduleNextCycle() {
  if (intervalHandle) clearTimeout(intervalHandle);
  intervalHandle = setTimeout(async () => {
    try {
      await runCycle();
    } catch (err) {
      // runCycle is supposed to swallow its own errors. If one still reaches
      // here, its error handler broke - so this must not depend on appendLog.
      try {
        appendLog(`Cycle threw past its own handler: ${err && err.message}. Scanning continues.`, "error");
      } catch {
        console.error("[bot] cycle threw and logging failed:", err && err.message);
      }
    } finally {
      if (intervalHandle) scheduleNextCycle();
    }
  }, currentCadenceSeconds() * 1000);
}

export function startBot() {
  const config = loadConfig();
  if (intervalHandle) return { alreadyRunning: true };

  consecutiveFailures = 0;
  breakerOpenedAt = null;
  breakerTrips = 0;
  const { seconds, phase } = describeCadence();
  appendLog(
    `Bot started (${config.environment}). Scanning every ${seconds}s (${phase}). ` +
    `Live and pre-game entries, ${config.minEntryPriceCents}-${config.maxEntryPriceCents}c band, ` +
    `fair-value exit ${fairValueMode(config)}, CLV kill switch ${config.clvKillSwitch === false ? "off" : "on"}.`
  );

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
  // A stopped bot must not leave bids on the book that nobody is re-pricing.
  cancelAllResting("bot stopped").catch((err) => appendLog(`Could not cancel resting bids on stop: ${err.message}`, "error"));
  return { stopped: true };
}

export function isRunning() {
  return intervalHandle !== null;
}
