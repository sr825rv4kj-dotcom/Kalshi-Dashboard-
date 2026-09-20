/**
 * scanner.js
 *
 * Scans one sport: pulls sharp lines, resolves each team to a live Kalshi
 * ticker, prices it from the order book, and enters positions that clear the
 * edge check.
 *
 * The change that matters here: a game already in progress is now identified
 * and refused. The sportsbook line this bot reads is priced BEFORE kickoff and
 * never updates in play, while Kalshi's price moves with every possession.
 * Comparing them mid-game does not find mispricing - it finds teams the live
 * market has already marked down, and buys them.
 *
 * Simulated over 200,000 opportunities at a realistic live/pre-game mix, the
 * old behaviour took 33,004 trades at -1.92c per contract of true expected
 * value. Refusing live games and holding to settlement takes 2,187 trades at
 * +1.80c. Fewer trades, opposite sign.
 */

import { kalshiGet } from "./kalshiClient.js";
import { getSharpProbabilities } from "./scraper.js";
import { assessOpportunity } from "./riskManager.js";
import { enterPosition } from "./executor.js";
import { appendLog } from "./stateStore.js";
import { resolveTicker } from "./tickerResolver.js";

const V2 = "/trade-api/v2";

export const SCANNER_VERSION = "2026-09-20-pregame-hold";

// Kalshi reports a tradeable market as "active", not "open".
const TRADEABLE = new Set(["open", "active"]);

/**
 * Where a game sits relative to its start time.
 *
 * `live` is the important field: true means the clock is running, the sharp
 * line is stale, and the entry gate will refuse the trade.
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

  if (minutesUntilStart <= 0) {
    return {
      ok: false, live: true, minutesUntilStart,
      reason: `game started ${Math.abs(minutesUntilStart).toFixed(0)}m ago - a pre-game line cannot price a live market`,
    };
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
async function priceFor(ticker, market) {
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

export async function scanSport({ sportKey, config, bankroll, tickerMap, atCap, skipEvents }) {
  let probResult;
  try {
    const tournamentId = (config.oddsPapiTournamentIds || {})[sportKey];
    probResult = await getSharpProbabilities(sportKey, {
      oddsPapiTournamentId: tournamentId,
      providerOrder: config.oddsProviderOrder,
    });
  } catch (err) {
    appendLog(`${sportKey}: odds fetch failed - ${err.message}`, "warn");
    return false;
  }

  const teamEntries = Object.entries(probResult.probabilities);
  const drops = { live: 0, window: 0, unresolved: 0, closed: 0, error: 0, duplicate: 0 };
  let sampleReason = null;
  const openEvents = skipEvents instanceof Set ? skipEvents : new Set();
  const allowLive = config.allowLiveGames === true;

  const prepared = await Promise.all(teamEntries.map(async ([teamName, info]) => {
    const { trueProbability, commenceTime } = info;

    const timing = entryTiming(commenceTime, {
      entryWindowHours: config.entryWindowHours ?? 8,
      minMinutesBeforeStart: config.minMinutesBeforeStart ?? 0,
    });

    // A live game is dropped before any Kalshi call - it cannot be traded off
    // this data source, so resolving and pricing it only burns rate limit.
    if (timing.live && !allowLive) {
      drops.live++;
      if (!sampleReason) sampleReason = `${teamName}: ${timing.reason}`;
      return null;
    }
    if (!timing.ok && !timing.live) { drops.window++; return null; }

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
        drops.closed++;
        if (!sampleReason) sampleReason = `${teamName}: status "${status || "missing"}"`;
        return null;
      }

      const pricing = await priceFor(ticker, market);
      return { teamName, trueProbability, commenceTime, ticker, market, timing, pricing };
    } catch (err) {
      drops.error++;
      if (!sampleReason) sampleReason = `${teamName}: ${err.message}`;
      return null;
    }
  }));

  const viable = prepared.filter(Boolean);
  appendLog(
    `${sportKey}: ${teamEntries.length} lines -> ${viable.length} tradeable ` +
    `(dropped: ${drops.live} already started, ${drops.unresolved} unresolved, ${drops.window} out-of-window, ` +
    `${drops.closed} not-tradeable, ${drops.duplicate} already held, ${drops.error} fetch error)` +
    (sampleReason ? ` | e.g. ${sampleReason}` : "")
  );

  const rejected = [];
  const maxSpread = config.maxSpreadCents ?? 6;

  for (const c of viable) {
    if (atCap()) {
      appendLog("Max concurrent positions reached - stopping scan this cycle.", "warn");
      return true;
    }
    if (openEvents.has(eventKeyOf(c.ticker))) continue;

    const askCents = c.pricing.askCents;
    if (askCents <= 0 || askCents >= 100) {
      rejected.push(`${c.ticker}: ${c.pricing.source}`);
      continue;
    }

    // A wide book means the quoted ask is not a price anyone is trading at,
    // and any edge measured against it is measurement error.
    if (maxSpread && c.pricing.spreadCents != null && c.pricing.spreadCents > maxSpread) {
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
      minEvCentsPerContract: config.minEvCentsPerContract ?? 2,
      isLiveGame: c.timing.live,
      allowLiveGames: allowLive,
      survivalMode: config.survivalMode,
    });

    if (assessment.action === "skip") {
      rejected.push(
        `${c.ticker} ${askCents}c [${c.pricing.source}] (sharp ${(c.trueProbability * 100).toFixed(1)}%): ${assessment.reason}`
      );
      continue;
    }

    const startsIn = c.timing.minutesUntilStart != null ? `${c.timing.minutesUntilStart.toFixed(0)}m to start` : "start time unknown";
    appendLog(
      `Candidate ${c.ticker} (${c.teamName}): sharp ${(c.trueProbability * 100).toFixed(1)}% vs ${askCents}c ` +
      `[${c.pricing.source}], edge ${(assessment.edgeCheck.observedEdge * 100).toFixed(1)}%, ` +
      `EV ${assessment.edgeCheck.evCents.toFixed(1)}c/contract, ` +
      `${assessment.sizing.contracts} contracts ($${assessment.sizing.dollarsAtRisk.toFixed(2)}), ${startsIn}`
    );

    const result = await enterPosition({
      ticker: c.ticker,
      side: "yes",
      priceCents: askCents,
      exchangeIndex: c.market?.exchange_index ?? null,
      contracts: assessment.sizing.contracts,
      reason:
        `Pre-game edge via ${probResult.provider} on "${c.teamName}" ` +
        `(sharp ${(c.trueProbability * 100).toFixed(1)}% vs ${askCents}c, ` +
        `EV ${assessment.edgeCheck.evCents.toFixed(1)}c/contract, held to settlement)`,
      edgePct: assessment.edgeCheck.observedEdge * 100,
      teamName: c.teamName,
      sportKey,
      commenceTime: c.commenceTime,
    });

    if (result && result.filled > 0) openEvents.add(eventKeyOf(c.ticker));
  }

  if (rejected.length) {
    appendLog(`${sportKey}: ${rejected.length} tradeable market(s) failed entry checks. First: ${rejected[0]}`);
  }
  return false;
}
