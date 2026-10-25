/**
 * arbEngine.js  (2026-10-18)
 *
 * CROSS-EXCHANGE ARBITRAGE - account holder's call: "Build arbitrage engine".
 *
 * The same game is listed on Kalshi and on Polymarket US. Team A's "yes" on
 * one exchange plus team B's side on the other pays exactly $1.00 whichever
 * team wins. When the two cost less than $1.00 together, AFTER both
 * exchanges' fees, the difference is locked in before the game starts.
 *
 *   locked per contract = 100 - Kalshi price - Polymarket price
 *                         - Kalshi fee - Polymarket fee        (cents)
 *
 * Fees are taken at their worst case: each exchange's fee formula
 * (multiplier x contracts x p x (1-p)) rounded UP to a whole cent per order
 * (riskManager.orderFeeCents) - Kalshi 0.07, Polymarket 0.0695
 * (pmEngine.PM_FEE). A trade is taken only when the locked amount is at least
 * minLockedCents per contract (default 2c) AND minLockedDollars on the trade.
 *
 * ONLY GAMES THAT CANNOT END IN A TIE. If a game is drawn, team A and team B
 * both lose and both legs lose. So soccer, NFL (ties happen), KBO / NPB
 * (tied games), cricket tests, MMA and boxing are never arbitraged. Default
 * list: NBA, WNBA, NBL, college basketball, MLB, NHL, college football.
 *
 * MATCHING THE GAME. The odds feed's game (both team names, start time) is the
 * bridge: Kalshi's market for team A comes from tickerResolver.js (the same
 * resolver every Kalshi trade uses) and team B's is the other market in that
 * Kalshi game (flipTrader.opponentOf - the game ticker's own team codes).
 * Polymarket's sides come from pmMarkets.matchEvent / winnerSideFor, which
 * need BOTH teams and the start time to agree and tie each side to a team by
 * its id. Anything ambiguous is skipped and counted, never guessed.
 *
 * EXECUTION - Kalshi leg first, then Polymarket:
 *   1. Kalshi: immediate-or-cancel buy at the Kalshi ask (no walk-up).
 *   2. Polymarket: immediate-or-cancel buy of the same count at its ask.
 *   3. Polymarket filled less: one retry at the BREAKEVEN price (the highest
 *      Polymarket price at which the pair still costs no more than $1.00
 *      after fees).
 *   4. Still short: the unmatched Kalshi contracts are sold at the bid
 *      (executor.exitPosition - the proven Kalshi sell path), so the account
 *      is never left holding one side alone. That sale can cost a few cents;
 *      it is logged and counted as "unwound".
 * Both legs are marked arb:true and held to settlement - no exit rule ever
 * sells half a hedge (botController.js, pmEngine.js). The Polymarket copy rule
 * ignores arb legs.
 *
 * Runs after every bot cycle, also while the daily loss halt is on (an
 * arbitrage adds no betting risk). Prices are read fresh from both exchanges
 * right before the orders. Never throws into the bot loop.
 *
 * Settings (config.arbitrage):
 *   enabled            true
 *   sports             the no-tie list above
 *   minLockedCents     2      per contract, after worst-case fees
 *   minLockedDollars   0.10   per trade
 *   maxCostDollars     10     both legs together, per trade
 *   maxOpenArbs        3      games held as arbitrage at once
 *   everySeconds       30    (games live or starting within 3 hours)
 *   runWhileHalted     true
 */

import fs from "fs";
import path from "path";
import { DATA_DIR } from "./paths.js";
import { atomicWriteFileSync, appendLog, loadState, saveState } from "./stateStore.js";
import { kalshiGet } from "./kalshiClient.js";
import { resolveTicker } from "./tickerResolver.js";
import { opponentOf } from "./flipTrader.js";
import { enterPosition, exitPosition } from "./executor.js";
import { orderFeeCents } from "./riskManager.js";
import { getRecentLines } from "./scanner.js";
import { getSharpProbabilities } from "./scraper.js";
import { schedulePlan, shouldScanSport } from "./liveSchedule.js";
import { recordTrade } from "./tradeLedgerStore.js";
import { getSportEvents, matchEvent, winnerSideFor, sidePrice } from "./polymarket/pmMarkets.js";
import { pmPositions, savePmPositions, normName } from "./polymarket/pmState.js";
import { PM_FEE, pmArbReady, pmShortReady, pmArbBuy, pmArbSell, readPmAccount } from "./polymarket/pmEngine.js";

export const ARB_VERSION = "2026-10-18-arbitrage";

const V2 = "/trade-api/v2";
const KALSHI_FEE = 0.07;
const FILE = path.join(DATA_DIR, "arb-state.json");
const OWN_LINES_EVERY_MS = 60 * 1000;
const LINE_MAX_AGE_MS = 120 * 1000;

export const ARB_DEFAULT_SPORTS = [
  "basketball_nba", "basketball_nba_preseason", "basketball_wnba", "basketball_nbl", "basketball_ncaab",
  "baseball_mlb", "icehockey_nhl", "icehockey_nhl_preseason", "americanfootball_ncaaf",
];

export function arbSettings(config = {}) {
  const a = config.arbitrage && typeof config.arbitrage === "object" ? config.arbitrage : {};
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled: a.enabled === true,
    sports: Array.isArray(a.sports) && a.sports.length ? a.sports.map(String) : ARB_DEFAULT_SPORTS,
    minLockedCents: n(a.minLockedCents, 2),
    minLockedDollars: n(a.minLockedDollars, 0.10),
    maxCostDollars: n(a.maxCostDollars, 10),
    maxOpenArbs: n(a.maxOpenArbs, 3),
    everySeconds: n(a.everySeconds, 30),
    runWhileHalted: a.runWhileHalted !== false,
  };
}

// --- State ---------------------------------------------------------------------------

let mem = null;
function load() {
  if (mem) return mem;
  try { mem = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { mem = null; }
  if (!mem || typeof mem !== "object") mem = {};
  mem.stats = mem.stats || { scans: 0, gamesCompared: 0, opportunities: 0, executed: 0, unwound: 0 };
  mem.skips = mem.skips || {};
  mem.best = Array.isArray(mem.best) ? mem.best : [];
  mem.trades = Array.isArray(mem.trades) ? mem.trades : [];
  return mem;
}
function save() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); atomicWriteFileSync(FILE, JSON.stringify(mem)); } catch { /* never stops trading */ }
}
function skip(code) { const m = load(); m.skips[code] = (m.skips[code] || 0) + 1; }

// --- Pure math ------------------------------------------------------------------------

/**
 * Pure: worst-case cost and locked profit of `contracts` pairs at these
 * prices. Polymarket prices can carry a tenth of a cent; fees are rounded up.
 */
export function arbMath({ kalshiCents, pmCents, contracts }) {
  const n = Math.max(1, Math.floor(contracts));
  const kFee = orderFeeCents(kalshiCents, n, KALSHI_FEE);
  const pFee = orderFeeCents(pmCents, n, PM_FEE);
  const costCents = n * (kalshiCents + pmCents) + kFee + pFee;
  const lockedCents = n * 100 - costCents;
  return {
    contracts: n, kFeeCents: kFee, pFeeCents: pFee,
    costDollars: costCents / 100,
    lockedCents, lockedPerContract: lockedCents / n,
    lockedDollars: lockedCents / 100,
  };
}

/** Pure: the most pairs the cost cap allows at these prices (fees included). */
export function arbContracts({ kalshiCents, pmCents, maxCostDollars, pmSize = null }) {
  let n = Math.floor((maxCostDollars * 100) / (kalshiCents + pmCents + 2));
  if (Number.isFinite(pmSize) && pmSize > 0 && pmSize < 1e8) n = Math.min(n, Math.floor(pmSize));
  while (n > 1 && arbMath({ kalshiCents, pmCents, contracts: n }).costDollars > maxCostDollars) n -= 1;
  return Math.max(0, n);
}

/**
 * Pure: the highest Polymarket price at which `contracts` pairs still cost no
 * more than $1.00 each after fees, given what Kalshi actually filled at.
 */
export function breakevenPmCents({ kalshiCents, contracts }) {
  for (let p = 99; p >= 1; p--) {
    if (arbMath({ kalshiCents, pmCents: p, contracts }).lockedCents >= 0) return p;
  }
  return null;
}

/** Pure: the odds feed's games for a sport - two teams sharing an event id. */
export function gamesFromLines(probabilities = {}) {
  const byEvent = new Map();
  for (const [teamName, info] of Object.entries(probabilities || {})) {
    if (!info || !info.eventId || /^(draw|tie)$/i.test(String(teamName).trim())) continue;
    const g = byEvent.get(info.eventId) || { eventId: info.eventId, commenceTime: info.commenceTime, teams: [] };
    g.teams.push(teamName);
    byEvent.set(info.eventId, g);
  }
  return [...byEvent.values()].filter((g) => g.teams.length === 2);
}

// --- Reads ----------------------------------------------------------------------------

function cents(m, key) {
  const d = Number(m?.[`${key}_dollars`]);
  if (Number.isFinite(d) && d > 0) return Math.round(d * 100);
  const v = Number(m?.[key]);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v <= 1 ? Math.round(v * 100) : Math.round(v);
}

const TRADEABLE = new Set(["active", "open"]);

/** Both teams' Kalshi markets in one game, with live asks. */
async function kalshiPair(sportKey, game) {
  const [a, b] = game.teams;
  const r = await resolveTicker({ sportKey, teamName: a, commenceTime: game.commenceTime, opponentName: b });
  if (!r.ticker) return { error: `kalshi:${r.code || "unresolved"}` };
  const ev = r.ticker.slice(0, r.ticker.lastIndexOf("-"));
  const data = await kalshiGet(`${V2}/markets`, `?event_ticker=${encodeURIComponent(ev)}`);
  const markets = Array.isArray(data?.markets) ? data.markets : [];
  const mine = markets.find((m) => m.ticker === r.ticker);
  const opp = opponentOf(r.ticker, markets);
  if (!mine || !opp) return { error: "kalshi:no-opponent-market" };
  if (markets.length !== 2) return { error: "kalshi:not-two-way" };
  const legs = {};
  for (const [team, m] of [[a, mine], [b, opp]]) {
    if (!TRADEABLE.has(String(m.status || "").toLowerCase())) return { error: "kalshi:market-closed" };
    const ask = cents(m, "yes_ask");
    if (!(ask >= 1 && ask <= 99)) return { error: "kalshi:no-ask" };
    legs[team] = { ticker: m.ticker, askCents: ask, exchangeIndex: m.exchange_index ?? null };
  }
  return { legs, event: ev };
}

/** Both teams' Polymarket sides in one game, with live asks from the price endpoint. */
async function pmPair(sportKey, game) {
  const events = await getSportEvents(sportKey);
  const ev = matchEvent(events, game.teams, game.commenceTime);
  if (!ev) return { error: "pm:no-event" };
  if (ev.ambiguous) return { error: "pm:ambiguous-event" };
  const legs = {};
  for (const team of game.teams) {
    const side = winnerSideFor(ev, team);
    if (!side.ok) return { error: side.code || "pm:no-side" };
    if (!side.long && !pmShortReady()) return { error: "pm:no-side-format-unconfirmed" };
    const px = await sidePrice(side.slug, side.long);
    if (!px.open) return { error: "pm:market-closed" };
    if (px.source !== "bbo") return { error: "pm:price-not-fresh" };
    if (!(px.askCents > 0 && px.askCents < 100)) return { error: "pm:no-ask" };
    legs[team] = { slug: side.slug, long: side.long, askCents: px.askCents, bidCents: px.bidCents, askSize: px.askSize, eventSlug: ev.slug ?? null };
  }
  // Two different markets or two sides of one market - never the same side twice.
  const [x, y] = game.teams.map((t) => legs[t]);
  if (x.slug === y.slug && x.long === y.long) return { error: "pm:same-side-twice" };
  return { legs };
}

// --- Open arbitrage bookkeeping ----------------------------------------------------------------

function sameGame(sportKey, commenceTime, teamNames) {
  const names = new Set(teamNames.map(normName));
  const want = Date.parse(commenceTime);
  return (p) => {
    if (p.sportKey && p.sportKey !== sportKey) return false;
    if (!names.has(normName(p.teamName))) return false;
    const at = Date.parse(p.commenceTime);
    return Number.isFinite(at) && Number.isFinite(want) && Math.abs(at - want) < 3 * 60 * 60 * 1000;
  };
}

function openArbGames() {
  const keys = new Set();
  try { for (const p of loadState().positions || []) if (p.arb && p.arbId) keys.add(p.arbId); } catch { /* none */ }
  try { for (const p of pmPositions()) if (p.arb && p.arbId) keys.add(p.arbId); } catch { /* none */ }
  return keys.size;
}

function markKalshiArb(ticker, openedAfterIso, arbId) {
  const st = loadState();
  let marked = null;
  for (const p of st.positions) {
    if (p.ticker === ticker && p.openedAt >= openedAfterIso && !p.arb) { p.arb = true; p.arbId = arbId; marked = p; }
  }
  if (marked) saveState(st);
  return marked;
}

// --- Execution --------------------------------------------------------------------------------

async function execute(op, s) {
  const arbId = `${op.sportKey}|${op.game.eventId}`;
  const before = new Date(Date.now() - 1000).toISOString();
  const k = op.kalshi;
  const pm = op.pm;
  const teamK = op.kalshiTeam;
  const teamP = op.pmTeam;

  appendLog(
    `ARBITRAGE ${op.sportKey}: ${teamK} YES on Kalshi @ ${k.askCents}c + ${teamP} on Polymarket @ ${pm.askCents}c = ` +
    `${(k.askCents + pm.askCents).toFixed(1)}c a pair; ${op.math.contracts} pairs lock +$${op.math.lockedDollars.toFixed(2)} ` +
    `after worst-case fees ($${op.math.costDollars.toFixed(2)} in)`
  );

  // 1. Kalshi leg.
  let kRes;
  try {
    kRes = await enterPosition({
      ticker: k.ticker, side: "yes", priceCents: k.askCents, limitCents: k.askCents,
      exchangeIndex: k.exchangeIndex, contracts: op.math.contracts,
      reason: `ARBITRAGE leg 1 of 2: ${teamK} on Kalshi @ ${k.askCents}c, hedged by ${teamP} on Polymarket @ ${pm.askCents}c ` +
        `(locks +${op.math.lockedPerContract.toFixed(1)}c a pair after fees)`,
      edgePct: null, teamName: teamK, sportKey: op.sportKey, commenceTime: op.game.commenceTime,
    });
  } catch (err) {
    appendLog(`ARBITRAGE ${arbId}: Kalshi leg failed (${err.message}) - nothing bought.`, "warn");
    skip("kalshi-order-error");
    return;
  }
  const kFilled = Math.floor(kRes?.filled || 0);
  if (!(kFilled > 0)) {
    appendLog(`ARBITRAGE ${arbId}: Kalshi leg did not fill at ${k.askCents}c${kRes?.skipped ? ` (${kRes.skipped})` : ""} - nothing bought.`);
    skip(kRes?.skipped ? `kalshi-${kRes.skipped}` : "kalshi-no-fill");
    return;
  }
  const kPos = markKalshiArb(k.ticker, before, arbId);
  const kFillCents = Number(kRes.priceCents) || k.askCents;

  // 2. Polymarket leg, same count; 3. one retry at breakeven.
  let pFilled = 0, pCostCents = 0, pFeeCents = 0, lastErr = null;
  const tries = [pm.askCents];
  const be = breakevenPmCents({ kalshiCents: kFillCents, contracts: kFilled });
  if (be != null && be > pm.askCents) tries.push(be);
  for (const limit of tries) {
    const want = kFilled - pFilled;
    if (want <= 0) break;
    try {
      const r = await pmArbBuy({ slug: pm.slug, long: pm.long, limitCents: limit, contracts: want, seenAskCents: pm.askCents });
      if (r.rejected) { lastErr = `rejected: ${r.rejected}`; continue; }
      const got = Math.floor(r.filled || 0);
      if (got > 0 && r.fillCents != null) {
        pFilled += got;
        pCostCents += got * r.fillCents;
        pFeeCents += Number.isFinite(r.feeCents) && r.feeCents > 0 ? r.feeCents : orderFeeCents(r.fillCents, got, PM_FEE);
      }
    } catch (err) { lastErr = err.message; }
  }

  if (pFilled > 0) {
    const avg = Math.round((pCostCents / pFilled) * 10) / 10;
    const ticker = `PM:${pm.slug}:${pm.long ? "YES" : "NO"}`;
    const openedAt = new Date().toISOString();
    const list = pmPositions();
    list.push({
      ticker, slug: pm.slug, long: pm.long, teamName: teamP, opponent: teamK, sportKey: op.sportKey,
      commenceTime: op.game.commenceTime, contracts: pFilled, entryPriceCents: avg, entryFeeCents: pFeeCents,
      openedAt, orderId: null, eventSlug: pm.eventSlug, arb: true, arbId,
    });
    savePmPositions(list);
    recordTrade({
      action: "enter", ticker, side: pm.long ? "yes" : "no", contracts: kFilled, priceCents: avg, filled: pFilled,
      reason: `ARBITRAGE leg 2 of 2: ${teamP} on Polymarket @ ${avg}c, hedging ${teamK} on Kalshi @ ${kFillCents}c`,
      edgePct: null, environment: "production", teamName: teamP, sportKey: op.sportKey,
      commenceTime: op.game.commenceTime, feeCents: pFeeCents, lotId: openedAt,
    });
  }

  // 4. Unmatched Kalshi contracts are sold - never left as a one-sided bet.
  const unmatched = kFilled - pFilled;
  if (unmatched > 0) {
    appendLog(`ARBITRAGE ${arbId}: Polymarket filled ${pFilled} of ${kFilled}${lastErr ? ` (${lastErr})` : ""} - selling the ${unmatched} unmatched Kalshi contract(s).`, "warn");
    const pos = loadState().positions.find((p) => p.ticker === k.ticker && p.arbId === arbId) || kPos;
    if (pos) {
      try {
        // Temporarily unmark so the sale is booked like any exit, then restore on what is left.
        await exitPosition({ ...pos, arb: false }, "arb-unwind", { count: unmatched });
      } catch (err) {
        appendLog(`ARBITRAGE ${arbId}: unwind sale failed (${err.message}) - ${unmatched} Kalshi contract(s) left open; check the Kalshi app.`, "error");
      }
    }
    // Nothing hedges what is left (the sale did not complete): it becomes an
    // ordinary position again so the normal exit rules manage it.
    if (pFilled === 0) {
      const st = loadState();
      let changed = false;
      for (const p of st.positions) if (p.ticker === k.ticker && p.arbId === arbId) { delete p.arb; delete p.arbId; changed = true; }
      if (changed) {
        saveState(st);
        appendLog(`ARBITRAGE ${arbId}: Kalshi contracts still held after the unwind are now an ordinary position (normal exit rules apply).`, "warn");
      }
    }
    const m = load();
    m.stats.unwound += 1;
  }

  const matched = Math.min(kFilled, pFilled);
  const m = load();
  if (matched > 0) {
    const pAvg = pCostCents / pFilled;
    const locked = arbMath({ kalshiCents: kFillCents, pmCents: pAvg, contracts: matched });
    m.stats.executed += 1;
    m.trades.unshift({
      at: new Date().toISOString(), arbId, sportKey: op.sportKey, teams: op.game.teams,
      kalshi: { team: teamK, ticker: k.ticker, contracts: matched, cents: kFillCents },
      polymarket: { team: teamP, slug: pm.slug, side: pm.long ? "YES" : "NO", contracts: matched, cents: Math.round(pAvg * 10) / 10 },
      lockedDollars: Math.round(locked.lockedDollars * 100) / 100,
      unwound: unmatched > 0 ? unmatched : 0,
    });
    m.trades = m.trades.slice(0, 50);
    appendLog(`ARBITRAGE ${arbId}: LOCKED ${matched} pairs - ${teamK} on Kalshi @ ${kFillCents}c + ${teamP} on Polymarket @ ${(Math.round(pAvg * 10) / 10)}c = +$${locked.lockedDollars.toFixed(2)} at settlement, whoever wins.`);
  }
  save();
}

// --- The scan -----------------------------------------------------------------------------------

const ownLines = new Map();   // sportKey -> { at, probabilities }
let running = false;
let lastRunAt = 0;

async function linesFor(sportKey, plan) {
  const recent = getRecentLines(LINE_MAX_AGE_MS).get(sportKey);
  if (recent) return recent.probabilities;
  if (!shouldScanSport(sportKey, plan)) return null;
  const hit = ownLines.get(sportKey);
  if (hit && Date.now() - hit.at < OWN_LINES_EVERY_MS) return hit.probabilities;
  try {
    const r = await getSharpProbabilities(sportKey, {});
    ownLines.set(sportKey, { at: Date.now(), probabilities: r.probabilities || {} });
    return r.probabilities || {};
  } catch { return hit?.probabilities ?? null; }
}

/** One arbitrage pass. Called after every bot cycle (botController.js). Never throws. */
export async function runArbitrageCycle(config) {
  if (running) return { skipped: "running" };
  const s = arbSettings(config);
  if (!s.enabled) return { skipped: "off" };
  if (Date.now() - lastRunAt < s.everySeconds * 1000) return { skipped: "too soon" };
  running = true;
  lastRunAt = Date.now();
  const m = load();
  try {
    if (!s.runWhileHalted && loadState().haltedForDay) return { skipped: "halted" };
    if (!pmArbReady()) { skip("pm-not-ready"); return { skipped: "polymarket not ready" }; }
    if (openArbGames() >= s.maxOpenArbs) { skip("max-open-arbs"); return { skipped: "at max open arbitrages" }; }

    m.stats.scans += 1;
    const plan = schedulePlan();
    const found = [];
    for (const sportKey of s.sports) {
      let probs;
      try { probs = await linesFor(sportKey, plan); } catch { probs = null; }
      if (!probs) continue;
      for (const game of gamesFromLines(probs)) {
        // Games live or starting within 3 hours only - fewer reads, and the
        // prices that move (and drift apart) are the ones close to and in play.
        const start = Date.parse(game.commenceTime);
        if (!Number.isFinite(start) || start > Date.now() + 3 * 60 * 60 * 1000 || start < Date.now() - 5 * 60 * 60 * 1000) continue;
        // One position per game, as everywhere: a game already held on either
        // exchange (a bet or an arbitrage) is not arbitraged.
        const onGame = sameGame(sportKey, game.commenceTime, game.teams);
        let held = false;
        try { held = (loadState().positions || []).some(onGame) || pmPositions().some(onGame); } catch { held = true; }
        if (held) { skip("game-already-held"); continue; }

        m.stats.gamesCompared += 1;
        let kp, pp;
        try { kp = await kalshiPair(sportKey, game); } catch (err) { skip(`kalshi:read-failed`); continue; }
        if (kp.error) { skip(kp.error); continue; }
        try { pp = await pmPair(sportKey, game); } catch (err) { skip(`pm:read-failed`); continue; }
        if (pp.error) { skip(pp.error); continue; }

        const [a, b] = game.teams;
        for (const [kTeam, pTeam] of [[a, b], [b, a]]) {
          const k = kp.legs[kTeam];
          const pm = pp.legs[pTeam];
          const n = arbContracts({ kalshiCents: k.askCents, pmCents: pm.askCents, maxCostDollars: s.maxCostDollars, pmSize: pm.askSize });
          if (!(n >= 1)) continue;
          const math = arbMath({ kalshiCents: k.askCents, pmCents: pm.askCents, contracts: n });
          const row = {
            at: new Date().toISOString(), sportKey, teams: game.teams, kalshiTeam: kTeam, pmTeam: pTeam,
            kalshiCents: k.askCents, pmCents: pm.askCents, pairCents: Math.round((k.askCents + pm.askCents) * 10) / 10,
            contracts: n, lockedPerContract: Math.round(math.lockedPerContract * 10) / 10, lockedDollars: Math.round(math.lockedDollars * 100) / 100,
          };
          m.best.push(row);
          if (math.lockedPerContract >= s.minLockedCents && math.lockedDollars >= s.minLockedDollars) {
            found.push({ sportKey, game, kalshiTeam: kTeam, pmTeam: pTeam, kalshi: k, pm, math });
          }
        }
      }
    }
    // Keep the 15 closest pairs seen recently, for the monitor.
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    m.best = m.best.filter((r) => Date.parse(r.at) >= cutoff).sort((x, y) => y.lockedPerContract - x.lockedPerContract).slice(0, 15);

    if (!found.length) { save(); return { found: 0 }; }
    m.stats.opportunities += found.length;
    found.sort((x, y) => y.math.lockedDollars - x.math.lockedDollars);

    // Cash on both sides for the best one.
    const op = found[0];
    try {
      const bal = await kalshiGet(`${V2}/portfolio/balance`);
      const kCash = (bal.balance ?? 0) / 100;
      const pAcct = await readPmAccount();
      const kNeed = (op.math.contracts * op.kalshi.askCents + op.math.kFeeCents) / 100;
      const pNeed = (op.math.contracts * op.pm.askCents + op.math.pFeeCents) / 100;
      if (kCash < kNeed) { skip("kalshi-cash-short"); save(); return { found: found.length, skipped: "Kalshi cash short" }; }
      if ((pAcct.buyingPower ?? 0) < pNeed) { skip("pm-cash-short"); save(); return { found: found.length, skipped: "Polymarket cash short" }; }
    } catch (err) { skip("balance-read-failed"); save(); return { error: err.message }; }

    await execute(op, s);
    return { found: found.length, executed: 1 };
  } catch (err) {
    try { appendLog(`Arbitrage pass contained: ${err.message}`, "warn"); } catch { /* never break the loop */ }
    return { error: err.message };
  } finally {
    save();
    running = false;
  }
}

/** For the monitor and dashboard. */
export function arbReport(config = {}) {
  const m = load();
  const s = arbSettings(config);
  return {
    version: ARB_VERSION,
    enabled: s.enabled,
    settings: s,
    stats: m.stats,
    skips: Object.entries(m.skips).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([code, n]) => ({ code, count: n })),
    closestPairs: m.best.slice(0, 8),
    trades: m.trades.slice(0, 10),
    note: "A pair is team A on one exchange + team B on the other; it pays $1.00 whoever wins. Locked = $1.00 minus both prices minus worst-case fees.",
  };
}

