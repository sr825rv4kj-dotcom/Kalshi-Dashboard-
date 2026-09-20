/**
 * scanner.js
 *
 * Scans one sport: pulls sharp lines, resolves each team to a live Kalshi
 * ticker, and enters positions that clear the edge check.
 */

import { kalshiGet } from "./kalshiClient.js";
import { getSharpProbabilities } from "./scraper.js";
import { assessOpportunity } from "./riskManager.js";
import { enterPosition } from "./executor.js";
import { appendLog } from "./stateStore.js";
import { resolveTicker } from "./tickerResolver.js";

const V2 = "/trade-api/v2";

// Kalshi reports a tradeable market as "active". This module checked for
// "open" and silently dropped every live market it had just resolved.
const TRADEABLE = new Set(["open", "active"]);

/**
 * Entry timing gate. With entryWindowHours null/0 the gate is OFF entirely -
 * pre-game AND in-progress games are both tradeable.
 */
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

/** Both sides of one game is a guaranteed loss of both fee legs. */
function eventKeyOf(ticker) {
  const parts = String(ticker).split("-");
  return parts.length > 1 ? `${parts[0]}-${parts[1]}` : String(ticker);
}

/**
 * Returns true if the caller should stop scanning entirely (position cap hit).
 */
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

  // Resolve tickers and pull prices in parallel. Sequentially this was one
  // round-trip per team (24+ for MLB alone), which put entry latency into
  // minutes rather than seconds.
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
      return { teamName, trueProbability, commenceTime, ticker, market, windowCheck };
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
    // Re-check inside the loop: an entry earlier in this same pass may have
    // opened a position on the other side of this game.
    if (openEvents.has(eventKeyOf(c.ticker))) continue;

    const askCents = c.market.yes_ask ?? 0;
    if (askCents <= 0 || askCents >= 100) {
      rejected.push(`${c.ticker}: no ask price`);
      continue;
    }

    const assessment = assessOpportunity({
      bankroll,
      trueProbability: c.trueProbability,
      price: askCents / 100,
      restingContracts: c.market.yes_ask_size ?? 0,
      multiplier: config.feeMultiplier,
      kellyFraction: config.kellyFraction,
      minLiquidity: config.minLiquidity ?? 0,
      maxStakeDollars: config.maxStakeDollars ?? null,
      survivalMode: config.survivalMode,
    });

    if (assessment.action === "skip") {
      rejected.push(`${c.ticker} ${askCents}c: ${assessment.reason}`);
      continue;
    }

    appendLog(
      `Candidate ${c.ticker} (${c.teamName}): sharp ${(c.trueProbability * 100).toFixed(1)}% vs ${askCents}c, ` +
      `edge ${(assessment.edgeCheck.observedEdge * 100).toFixed(1)}%, ` +
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
