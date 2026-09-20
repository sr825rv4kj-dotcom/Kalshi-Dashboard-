/**
 * scanner.js
 *
 * Scans one sport: pulls sharp lines, resolves each team to a live Kalshi
 * ticker, prices it from the order book, and enters positions that clear the
 * edge check.
 */

import { kalshiGet } from "./kalshiClient.js";
import { getSharpProbabilities } from "./scraper.js";
import { assessOpportunity } from "./riskManager.js";
import { enterPosition } from "./executor.js";
import { appendLog } from "./stateStore.js";
import { resolveTicker } from "./tickerResolver.js";

const V2 = "/trade-api/v2";

export const SCANNER_VERSION = "2026-09-19-orderbook-fp";

// Kalshi reports a tradeable market as "active", not "open".
const TRADEABLE = new Set(["open", "active"]);

export function withinEntryWindow(commenceTime, entryWindowHours) {
  if (!entryWindowHours) return { ok: true, live: true };
  if (!commenceTime) return { ok: true, live: false };

  const startMs = new Date(commenceTime).getTime();
  const nowMs = Date.now();
  if (nowMs >= startMs) return { ok: true, live: true };

  const hoursUntilStart = (startMs - nowMs) / (1000 * 60 * 60);
  if (hoursUntilStart > entryWindowHours) {
    return { ok: false, reason: `starts in ${hoursUntilStart.toFixed(1)}h, outside ${entryWindowHours}h window` };
  }
  return { ok: true, hoursUntilStart, live: false };
}

function eventKeyOf(ticker) {
  const parts = String(ticker).split("-");
  return parts.length > 1 ? `${parts[0]}-${parts[1]}` : String(ticker);
}

/**
 * Normalizes a price to cents. The "_fp" (fixed point) book may express price
 * as a decimal probability (0.55) or as cents (55); anything at or below 1 is
 * treated as a decimal.
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
 * Kalshi returns the book under "orderbook_fp"; the older "orderbook" key is
 * still read as a fallback. Reading only the old key made every book look
 * empty, which is what stopped every entry.
 */
async function priceFor(ticker, market) {
  const direct = market?.yes_ask ?? 0;
  if (direct > 0 && direct < 100) {
    return { askCents: direct, askSize: market.yes_ask_size ?? 0, source: "market" };
  }

  let book = null;
  try {
    book = await kalshiGet(`${V2}/markets/${ticker}/orderbook`);
  } catch (err) {
    return { askCents: 0, askSize: 0, source: `book-error:${err.message.slice(0, 40)}` };
  }

  const ob = book?.orderbook_fp ?? book?.orderbook ?? book ?? {};
  const noLevels = ob.no ?? ob.no_levels ?? [];
  const yesLevels = ob.yes ?? ob.yes_levels ?? [];

  const bestNo = bestLevel(noLevels);
  if (bestNo && bestNo.price > 0 && bestNo.price < 100) {
    return { askCents: 100 - bestNo.price, askSize: bestNo.size, source: "book-no-bid" };
  }

  // Nobody is bidding NO, so nothing is offered on YES. A bid one cent above
  // the best YES bid is the cheapest price that could realistically fill.
  const bestYes = bestLevel(yesLevels);
  if (bestYes && bestYes.price > 0 && bestYes.price < 99) {
    return { askCents: bestYes.price + 1, askSize: bestYes.size, source: "book-yes-bid+1" };
  }

  const shape = `keys=[${Object.keys(ob).join(",")}] yes=${yesLevels.length} no=${noLevels.length}`;
  return { askCents: 0, askSize: 0, source: `book-empty (${shape})` };
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
  const drops = { window: 0, unresolved: 0, closed: 0, error: 0, duplicate: 0 };
  let sampleReason = null;
  const openEvents = skipEvents instanceof Set ? skipEvents : new Set();

  const prepared = await Promise.all(teamEntries.map(async ([teamName, info]) => {
    const { trueProbability, commenceTime } = info;

    const windowCheck = withinEntryWindow(commenceTime, config.entryWindowHours);
    if (!windowCheck.ok) { drops.window++; return null; }

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
      return { teamName, trueProbability, commenceTime, ticker, market, windowCheck, pricing };
    } catch (err) {
      drops.error++;
      if (!sampleReason) sampleReason = `${teamName}: ${err.message}`;
      return null;
    }
  }));

  const viable = prepared.filter(Boolean);
  appendLog(
    `${sportKey}: ${teamEntries.length} lines -> ${viable.length} tradeable ` +
    `(dropped: ${drops.unresolved} unresolved, ${drops.window} out-of-window, ` +
    `${drops.closed} not-tradeable, ${drops.duplicate} already held, ${drops.error} fetch error)` +
    (sampleReason ? ` | e.g. ${sampleReason}` : "")
  );

  const rejected = [];

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

    const assessment = assessOpportunity({
      bankroll,
      trueProbability: c.trueProbability,
      price: askCents / 100,
      restingContracts: c.pricing.askSize,
      multiplier: config.feeMultiplier,
      kellyFraction: config.kellyFraction,
      minLiquidity: config.minLiquidity ?? 0,
      maxStakeDollars: config.maxStakeDollars ?? null,
      survivalMode: config.survivalMode,
    });

    if (assessment.action === "skip") {
      rejected.push(
        `${c.ticker} ${askCents}c [${c.pricing.source}] (sharp ${(c.trueProbability * 100).toFixed(1)}%): ${assessment.reason}`
      );
      continue;
    }

    appendLog(
      `Candidate ${c.ticker} (${c.teamName}): sharp ${(c.trueProbability * 100).toFixed(1)}% vs ${askCents}c ` +
      `[${c.pricing.source}], edge ${(assessment.edgeCheck.observedEdge * 100).toFixed(1)}%, ` +
      `${assessment.sizing.contracts} contracts ($${assessment.sizing.dollarsAtRisk.toFixed(2)})`
    );

    const result = await enterPosition({
      ticker: c.ticker,
      side: "yes",
      priceCents: askCents,
      contracts: assessment.sizing.contracts,
      reason:
        `Sharp-book edge via ${probResult.provider} on "${c.teamName}" ` +
        `(true ${(c.trueProbability * 100).toFixed(1)}% vs ${askCents}c)` +
        (c.windowCheck.live ? " [in progress]" : ""),
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
