/**
 * scanner.js
 *
 * Scans one sport: pulls sharp lines, resolves each team to a live Kalshi
 * ticker, prices it from the order book, and enters positions that clear the
 * edge check.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE WAS REPLACED: A CRASH THAT SILENTLY STOPPED TRADING
 * ---------------------------------------------------------------------------
 * The in-play corroboration block called bump() on five paths. bump was
 * declared with `const` AFTER that block. `const` is in the temporal dead
 * zone until its declaration executes, so every one of those calls threw:
 *
 *     ReferenceError: Cannot access 'bump' before initialization
 *
 * It threw only when a live game was VETOED - no live score match, the game
 * could not be modelled, or the model disagreed with the line. That is the
 * ordinary case during a full slate, which is why this looked intermittent.
 *
 * What the throw cost, every time it fired:
 *   1. The rest of THIS sport was abandoned mid-scan.
 *   2. botController's `for (const sportKey of activeSports)` loop is not
 *      guarded per sport, so EVERY SPORT AFTER IT was never scanned at all.
 *   3. The throw reached runCycle's catch, which counts it as a cycle failure.
 *      Three in a row trips the circuit breaker and halts ALL trading.
 *   4. markExchangeReachable() never ran, so the breaker never saw a healthy
 *      exchange to reset against.
 *
 * Two fixes, both permanent:
 *   - tally and bump are now declared at the TOP of scanSport, before any
 *     code that can reach them.
 *   - the entire body is wrapped. scanSport can no longer throw. A failure in
 *     one sport is logged, tallied as `scanner-error`, and the next sport is
 *     scanned normally. Exchange-level failures still reach the breaker from
 *     botController, which is the correct boundary for those.
 * ---------------------------------------------------------------------------
 *
 * LIVE GAMES ARE TRADED. There is no waiting period: if a game is on and the
 * book is quoting it, the bot can trade it. What is refused is a price the
 * GAME STATE contradicts - the sharp line must be corroborated by an in-game
 * model built from the live score (liveModel.js), and the entry uses the MORE
 * CONSERVATIVE of the two.
 */

import { kalshiGet } from "./kalshiClient.js";
import { getSharpProbabilities } from "./scraper.js";
import { assessOpportunity } from "./riskManager.js";
import { enterPosition } from "./executor.js";
import { appendLog, loadState, saveState } from "./stateStore.js";
import { resolveTicker } from "./tickerResolver.js";
import { getLiveScores, findLiveGameForTeam } from "./scoresFetcher.js";
import { corroboratedProbability, fractionRemaining, paramsFor } from "./liveModel.js";

const V2 = "/trade-api/v2";

export const SCANNER_VERSION = "2026-09-21-tdz-contained";

// Kalshi reports a tradeable market as "active", not "open".
const TRADEABLE = new Set(["open", "active"]);

/**
 * Where a game sits relative to its start time.
 *
 * `live` is the important field: true means the clock is running and the
 * entry needs the in-game model to second the sharp line.
 */
export function entryTiming(commenceTime, { entryWindowHours = 8, minMinutesBeforeStart = 0 } = {}) {
  if (!commenceTime) {
    return { ok: false, live: false, reason: "no start time on the line - cannot tell whether the game has begun" };
  }

  const startMs = new Date(commenceTime).getTime();
  if (!Number.isFinite(startMs)) {
    return { ok: false, live: false, reason: `unreadable start time "${commenceTime}"` };
  }

  const minutesUntilStart = (startMs - Date.now()) / 60000;

  // In play. Always eligible - freshness, not the clock, decides whether the
  // quote is any good, and that is checked at the entry gate.
  if (minutesUntilStart <= 0) {
    return { ok: true, live: true, minutesUntilStart };
  }
  if (minutesUntilStart < minMinutesBeforeStart) {
    return {
      ok: false, live: false, minutesUntilStart,
      reason: `starts in ${minutesUntilStart.toFixed(0)}m, inside the ${minMinutesBeforeStart}m pre-kickoff cutoff`,
    };
  }
  if (entryWindowHours && minutesUntilStart > entryWindowHours * 60) {
    return {
      ok: false, live: false, minutesUntilStart,
      reason: `starts in ${(minutesUntilStart / 60).toFixed(1)}h, outside the ${entryWindowHours}h window`,
    };
  }
  return { ok: true, live: false, minutesUntilStart };
}

function eventKeyOf(ticker) {
  const parts = String(ticker).split("-");
  return parts.length > 1 ? `${parts[0]}-${parts[1]}` : String(ticker);
}

/**
 * Normalizes a price to cents. The book quotes in dollars (0.43); anything at
 * or below 1 is treated as a decimal, anything above as cents already.
 */
function toCents(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = n <= 1 ? n * 100 : n;
  return Math.round(cents);
}

/** Highest-priced level in a book side. Kalshi's ordering is not guaranteed. */
function bestLevel(levels) {
  let best = null;
  for (const lvl of levels ?? []) {
    const rawPrice = Array.isArray(lvl) ? lvl[0] : (lvl?.price ?? lvl?.yes_price ?? lvl?.no_price);
    const rawSize = Array.isArray(lvl) ? lvl[1] : (lvl?.size ?? lvl?.count ?? lvl?.quantity);
    const price = toCents(rawPrice);
    if (price == null) continue;
    const size = Number(rawSize ?? 0) || 0;
    if (!best || price > best.price) best = { price, size };
  }
  return best;
}

/**
 * Price to buy YES, in order of reliability:
 *   1. market.yes_ask when the endpoint populates it
 *   2. 100c minus the best NO bid - buying YES means selling NO to a bidder
 *   3. best YES bid + 1c when nobody is offering
 *
 * Also returns the spread, which is a liquidity signal in its own right: a
 * 15c-wide book means the fill price is a guess and the edge is imaginary.
 */
export async function priceFor(ticker, market) {
  const direct = market?.yes_ask ?? 0;
  const directBid = market?.yes_bid ?? 0;
  if (direct > 0 && direct < 100) {
    return {
      askCents: direct,
      askSize: market.yes_ask_size ?? 0,
      bidCents: directBid > 0 ? directBid : null,
      spreadCents: directBid > 0 ? direct - directBid : null,
      source: "market",
    };
  }

  let book = null;
  try {
    book = await kalshiGet(`${V2}/markets/${ticker}/orderbook`);
  } catch (err) {
    return { askCents: 0, askSize: 0, bidCents: null, spreadCents: null, source: `book-error:${err.message.slice(0, 40)}` };
  }

  const ob = book?.orderbook_fp ?? book?.orderbook ?? book ?? {};

  // Kalshi names the sides "yes_dollars" / "no_dollars" on this endpoint and
  // quotes them in dollars (0.43), not cents. Matching on a key prefix keeps
  // this working if the suffix changes again.
  const sideFor = (prefix) => {
    for (const [k, v] of Object.entries(ob)) {
      if (Array.isArray(v) && k.toLowerCase().startsWith(prefix)) return v;
    }
    return [];
  };
  const yesLevels = sideFor("yes");
  const noLevels = sideFor("no");

  const bestYes = bestLevel(yesLevels);
  const bestNo = bestLevel(noLevels);
  const bidCents = bestYes && bestYes.price > 0 ? bestYes.price : null;

  if (bestNo && bestNo.price > 0 && bestNo.price < 100) {
    const askCents = 100 - bestNo.price;
    return {
      askCents, askSize: bestNo.size, bidCents,
      spreadCents: bidCents != null ? askCents - bidCents : null,
      source: "book-no-bid",
    };
  }

  if (bestYes && bestYes.price > 0 && bestYes.price < 99) {
    return {
      askCents: bestYes.price + 1, askSize: bestYes.size, bidCents,
      spreadCents: 1, source: "book-yes-bid+1",
    };
  }

  const shape = `keys=[${Object.keys(ob).join(",")}] yes=${yesLevels.length} no=${noLevels.length}`;
  return { askCents: 0, askSize: 0, bidCents: null, spreadCents: null, source: `book-empty (${shape})` };
}

/**
 * Records why every candidate was refused, per scan, into state.
 *
 * With every rejection carrying a code, the bottleneck becomes a number: 23
 * markets seen, 14 outside the price band, 6 edge too small, 3 stale line. The
 * gate to loosen stops being a matter of opinion.
 */
export function recordScanTally(sportKey, tally, seen, entered) {
  try {
    const state = loadState();
    state.lastScan = state.lastScan || {};
    state.lastScan[sportKey] = {
      at: new Date().toISOString(),
      seen, entered,
      reasons: tally,
    };
    // Keep only sports seen in the last hour so this cannot grow unbounded.
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [k, v] of Object.entries(state.lastScan)) {
      if (Date.parse(v.at) < cutoff) delete state.lastScan[k];
    }
    saveState(state);
  } catch {
    // telemetry must never be the reason a scan fails
  }
}

/**
 * Scan one sport.
 *
 * CONTRACT: this function does not throw. Ever. It returns true only to tell
 * the caller to stop scanning further sports this cycle (position cap hit),
 * and false in every other case including failure. One sport failing must
 * never cost the others their turn, and must never be counted as an exchange
 * outage by the circuit breaker.
 */
export async function scanSport(args) {
  const { sportKey } = args;
  try {
    return await runScan(args);
  } catch (err) {
    // Tally it so the dashboard shows the sport as failing rather than as
    // "no opportunities", which is what a swallowed error looks like.
    appendLog(
      `${sportKey}: scan failed and was contained - ${err && err.message ? err.message : String(err)}. ` +
      `Remaining sports are unaffected.`,
      "error"
    );
    if (err && err.stack) appendLog(`${sportKey}: ${String(err.stack).split("\n").slice(0, 3).join(" | ")}`, "error");
    recordScanTally(sportKey, { "scanner-error": 1 }, 0, 0);
    return false;
  }
}

async function runScan({ sportKey, config, bankroll, tickerMap, atCap, skipEvents }) {
  // ---------------------------------------------------------------------
  // Declared FIRST. This is the fix. Every path below - including the
  // in-play corroboration block, which runs long before the entry loop -
  // can now reach bump() without hitting the temporal dead zone.
  // ---------------------------------------------------------------------
  const tally = {};
  const bump = (code) => { tally[code] = (tally[code] || 0) + 1; };
  const rejected = [];

  let probResult;
  try {
    const tournamentId = (config.oddsPapiTournamentIds || {})[sportKey];
    probResult = await getSharpProbabilities(sportKey, {
      oddsPapiTournamentId: tournamentId,
      providerOrder: config.oddsProviderOrder,
    });
  } catch (err) {
    appendLog(`${sportKey}: odds fetch failed - ${err.message}`, "warn");
    recordScanTally(sportKey, { "odds-fetch-failed": 1 }, 0, 0);
    return false;
  }

  const teamEntries = Object.entries(probResult.probabilities || {});
  if (!teamEntries.length) {
    recordScanTally(sportKey, { "no-lines-from-provider": 1 }, 0, 0);
    return false;
  }

  const drops = { live: 0, window: 0, unresolved: 0, closed: 0, error: 0, duplicate: 0 };
  // "8 not-tradeable" told us nothing actionable. Counting the actual status
  // strings turns it into "status=finalized x8", which is a fixable fact.
  const statusCounts = {};
  let sampleReason = null;
  const openEvents = skipEvents instanceof Set ? skipEvents : new Set();
  const allowLive = config.allowLiveGames !== false;   // live trading is ON unless switched off

  const prepared = await Promise.all(teamEntries.map(async ([teamName, info]) => {
    const { trueProbability, commenceTime } = info;

    const timing = entryTiming(commenceTime, {
      entryWindowHours: config.entryWindowHours ?? 0,
      minMinutesBeforeStart: config.minMinutesBeforeStart ?? 0,
    });

    if (timing.live && !allowLive) {
      drops.live++;
      if (!sampleReason) sampleReason = `${teamName}: live trading switched off in config`;
      return null;
    }
    if (!timing.ok) { drops.window++; return null; }

    let ticker = tickerMap[teamName];
    if (!ticker) {
      const resolved = await resolveTicker({ sportKey, teamName, commenceTime });
      if (!resolved.ticker) {
        drops.unresolved++;
        if (!sampleReason) sampleReason = `${teamName}: ${resolved.reason}`;
        return null;
      }
      ticker = resolved.ticker;
    }

    if (openEvents.has(eventKeyOf(ticker))) { drops.duplicate++; return null; }

    try {
      const res = await kalshiGet(`${V2}/markets/${ticker}`);
      const market = res.market;
      const status = String(market?.status || "").toLowerCase();
      if (!market || !TRADEABLE.has(status)) {
        const label = status || "missing";
        statusCounts[label] = (statusCounts[label] || 0) + 1;
        drops.closed++;
        if (!sampleReason) sampleReason = `${teamName}: status "${status || "missing"}"`;
        return null;
      }

      const pricing = await priceFor(ticker, market);
      return {
        teamName, trueProbability, commenceTime, ticker, market, timing, pricing,
        lineAgeSeconds: info.lineAgeSeconds ?? null,
      };
    } catch (err) {
      drops.error++;
      if (!sampleReason) sampleReason = `${teamName}: ${err.message}`;
      return null;
    }
  }));

  let viable = prepared.filter(Boolean);

  // --- In-play corroboration -------------------------------------------
  // One /scores call per sport per scan, and only when something in play
  // actually needs it - that endpoint is billed separately from /odds.
  const livePending = viable.filter((c) => c.timing.live);
  if (livePending.length) {
    if (!paramsFor(sportKey)) {
      appendLog(
        `${sportKey}: ${livePending.length} in-play market(s) skipped - no in-game model exists for this sport, ` +
        `so a stale line could not be detected.`, "warn"
      );
      for (const c of viable) if (c.timing.live) bump("no-model-for-sport");
      viable = viable.filter((c) => !c.timing.live);
    } else {
      let events = [];
      let scoresError = null;
      try {
        const res = await getLiveScores(sportKey);
        events = res.events || [];
        scoresError = res.error || null;
      } catch (err) {
        scoresError = err.message;
      }

      if (scoresError && !events.length) {
        appendLog(`${sportKey}: live scores unavailable (${scoresError}) - in-play markets skipped this cycle.`, "warn");
        for (const c of viable) if (c.timing.live) bump("live-scores-unavailable");
        viable = viable.filter((c) => !c.timing.live);
      } else {
        const vetoed = [];
        viable = viable.filter((c) => {
          if (!c.timing.live) return true;

          const game = findLiveGameForTeam(events, c.teamName);
          if (!game) {
            vetoed.push(`${c.teamName}: in play but no live score found - cannot check the line against the game`);
            bump("no-live-score-match");
            return false;
          }

          const frac = fractionRemaining(sportKey, c.commenceTime);
          const corr = corroboratedProbability({
            sportKey, sharpProbability: c.trueProbability, lead: game.lead, fracRemaining: frac,
          });
          if (!corr.usable) {
            vetoed.push(`${c.teamName}: in play, could not model the game state`);
            bump("unmodellable");
            return false;
          }

          const maxDisagree = config.maxModelDisagreementPoints ?? 12;
          if (corr.disagreementPoints > maxDisagree) {
            vetoed.push(
              `${c.teamName}: sharp line ${(c.trueProbability * 100).toFixed(0)}% vs in-game model ` +
              `${(corr.modelProbability * 100).toFixed(0)}% (${game.homeScore}-${game.awayScore}, ` +
              `${(frac * 100).toFixed(0)}% left) - ${corr.disagreementPoints.toFixed(0)}pt gap exceeds ${maxDisagree}, line is stale`
            );
            bump("model-disagrees");
            return false;
          }

          // Trade on the more conservative of the two.
          c.trueProbability = corr.probability;
          c.liveContext =
            `${game.homeTeam} ${game.homeScore}-${game.awayScore} ${game.awayTeam}, ` +
            `${(frac * 100).toFixed(0)}% left, model ${(corr.modelProbability * 100).toFixed(0)}%`;
          return true;
        });

        if (vetoed.length) {
          appendLog(`${sportKey}: ${vetoed.length} in-play market(s) vetoed by the game state. First: ${vetoed[0]}`, "warn");
        }
      }
    }
  }

  appendLog(
    `${sportKey}: ${teamEntries.length} lines -> ${viable.length} tradeable ` +
    `(dropped: ${drops.live} live-disabled, ${drops.unresolved} unresolved, ${drops.window} out-of-window, ` +
    `${drops.closed} not-tradeable, ${drops.duplicate} already held, ${drops.error} fetch error)` +
    (sampleReason ? ` | e.g. ${sampleReason}` : "")
  );

  // Assign the COUNT, not a single bump. The old line called bump() once per
  // key, so "6 unresolved" was recorded in the tally as "dropped:unresolved x1"
  // and the Strategy Review under-reported every bulk drop by its whole size.
  for (const [k, n] of Object.entries(drops)) if (n) tally[`dropped:${k}`] = n;
  for (const [st, n] of Object.entries(statusCounts)) tally[`status:${st}`] = n;

  const maxSpread = config.maxSpreadCents ?? 6;
  let entered = 0;
  let stopScanning = false;

  for (const c of viable) {
    if (atCap()) {
      appendLog("Max concurrent positions reached - stopping scan this cycle.", "warn");
      stopScanning = true;
      break;
    }
    if (openEvents.has(eventKeyOf(c.ticker))) continue;

    const askCents = c.pricing.askCents;
    if (askCents <= 0 || askCents >= 100) {
      bump("no-price");
      rejected.push(`${c.ticker}: ${c.pricing.source}`);
      continue;
    }

    // A wide book means the quoted ask is not a price anyone is trading at,
    // and any edge measured against it is measurement error.
    if (maxSpread && c.pricing.spreadCents != null && c.pricing.spreadCents > maxSpread) {
      bump("spread-too-wide");
      rejected.push(`${c.ticker}: ${c.pricing.spreadCents}c spread exceeds the ${maxSpread}c limit - the quote is not a real price`);
      continue;
    }

    const assessment = assessOpportunity({
      bankroll,
      trueProbability: c.trueProbability,
      price: askCents / 100,
      restingContracts: c.pricing.askSize,
      multiplier: config.feeMultiplier,
      kellyFraction: config.kellyFraction,
      minLiquidity: config.minLiquidity ?? 0,
      maxRiskPctPerTrade: config.maxRiskPctPerTrade ?? 0.20,
      maxStakeDollars: config.maxStakeDollars ?? null,
      maxPlausibleEdge: config.maxPlausibleEdge ?? 0.18,
      minEntryPriceCents: config.minEntryPriceCents ?? 25,
      maxEntryPriceCents: config.maxEntryPriceCents ?? 88,
      minEvCentsPerContract: config.minEvCentsPerContract ?? 1,
      isLiveGame: c.timing.live,
      allowLiveGames: allowLive,
      lineAgeSeconds: c.lineAgeSeconds,
      maxLineAgeSecondsLive: config.maxLineAgeSecondsLive ?? 900,
      maxLineAgeSecondsPregame: config.maxLineAgeSecondsPregame ?? 7200,
      survivalMode: config.survivalMode,
    });

    if (assessment.action === "skip") {
      bump(assessment.code || "skip-other");
      rejected.push(
        `${c.ticker} ${askCents}c [${c.pricing.source}] (sharp ${(c.trueProbability * 100).toFixed(1)}%): ${assessment.reason}`
      );
      continue;
    }

    const startsIn = c.timing.live
      ? `LIVE ${Math.abs(c.timing.minutesUntilStart ?? 0).toFixed(0)}m in` +
        (c.lineAgeSeconds != null ? `, quote ${Math.round(c.lineAgeSeconds)}s old` : "")
      : (c.timing.minutesUntilStart != null ? `${c.timing.minutesUntilStart.toFixed(0)}m to start` : "start time unknown");
    const liveNote = c.liveContext ? ` | ${c.liveContext}` : "";
    appendLog(
      `Candidate ${c.ticker} (${c.teamName}): sharp ${(c.trueProbability * 100).toFixed(1)}% vs ${askCents}c ` +
      `[${c.pricing.source}], edge ${(assessment.edgeCheck.observedEdge * 100).toFixed(1)}%, ` +
      `EV ${assessment.edgeCheck.evCents.toFixed(1)}c/contract, ` +
      `${assessment.sizing.contracts} contracts ($${assessment.sizing.dollarsAtRisk.toFixed(2)}), ${startsIn}${liveNote}`
    );

    let result = null;
    try {
      result = await enterPosition({
        ticker: c.ticker,
        side: "yes",
        priceCents: askCents,
        exchangeIndex: c.market?.exchange_index ?? null,
        contracts: assessment.sizing.contracts,
        reason:
          `${c.timing.live ? "In-play" : "Pre-game"} edge via ${probResult.provider} on "${c.teamName}" ` +
          `(sharp ${(c.trueProbability * 100).toFixed(1)}% vs ${askCents}c, ` +
          `EV ${assessment.edgeCheck.evCents.toFixed(1)}c/contract, held to settlement)`,
        edgePct: assessment.edgeCheck.observedEdge * 100,
        teamName: c.teamName,
        sportKey,
        commenceTime: c.commenceTime,
      });
    } catch (err) {
      // One rejected order must not cost the remaining candidates their turn.
      bump("order-error");
      rejected.push(`${c.ticker}: order failed - ${err.message}`);
      continue;
    }

    if (result && result.filled > 0) { openEvents.add(eventKeyOf(c.ticker)); entered += 1; }
    else bump("no-fill");
  }

  const tallyLine = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} x${n}`)
    .join(", ");
  if (tallyLine) {
    appendLog(`${sportKey}: entered ${entered}. Refusals - ${tallyLine}.`);
  }
  if (rejected.length) {
    appendLog(`${sportKey}: e.g. ${rejected[0]}`);
  }
  recordScanTally(sportKey, tally, teamEntries.length, entered);
  return stopScanning;
}
