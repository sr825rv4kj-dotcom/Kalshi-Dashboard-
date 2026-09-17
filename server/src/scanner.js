/**
 * scanner.js
 *
 * Scans one sport: pulls sharp lines, resolves each team to a live Kalshi
 * ticker, and enters positions that clear either entry path.
 *
 * Split out of botController.js so each file stays small enough to paste
 * reliably. botController owns the loop and safety rails; this owns the
 * per-sport work.
 */

import { kalshiGet } from "./kalshiClient.js";
import { getSharpProbabilities } from "./scraper.js";
import { assessOpportunity } from "./riskManager.js";
import { enterPosition } from "./executor.js";
import { appendLog } from "./stateStore.js";
import { resolveTicker } from "./tickerResolver.js";

const V2 = "/trade-api/v2";

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

/**
 * Returns true if the caller should stop scanning entirely (position cap hit).
 */
export async function scanSport({ sportKey, config, bankroll, tickerMap, atCap }) {
  let probResult;
  try {
    const tournamentId = (config.oddsPapiTournamentIds || {})[sportKey];
    probResult = await getSharpProbabilities(sportKey, {
      oddsPapiTournamentId: tournamentId,
      providerOrder: config.oddsProviderOrder,
    });
  } catch {
    return false;
  }

  // Resolve tickers and pull prices for every team in parallel. Sequentially
  // this was one round-trip per team (24+ for MLB alone), which is what put
  // entry latency into minutes rather than seconds.
  const teamEntries = Object.entries(probResult.probabilities);
  const drops = { window: 0, unresolved: 0, closed: 0, error: 0 };
  let sampleReason = null;

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

    try {
      const res = await kalshiGet(`${V2}/markets/${ticker}`);
      const market = res.market;
      if (!market || market.status !== "open") { drops.closed++; return null; }
      return { teamName, trueProbability, commenceTime, ticker, market, windowCheck };
    } catch {
      drops.error++;
      return null;
    }
  }));

  const viable = prepared.filter(Boolean);
  appendLog(
    `${sportKey}: ${teamEntries.length} lines -> ${viable.length} tradeable ` +
    `(dropped: ${drops.unresolved} unresolved, ${drops.window} out-of-window, ` +
    `${drops.closed} closed, ${drops.error} fetch error)` +
    (sampleReason ? ` | e.g. ${sampleReason}` : "")
  );

  const rejected = [];
  const minPrice = config.minEntryPriceCents ?? 40;

  for (const c of viable) {
    if (atCap()) {
      appendLog("Max concurrent positions reached - stopping scan this cycle.", "warn");
      return true;
    }

    const priceDollars = (c.market.yes_ask ?? 0) / 100;
    const assessment = assessOpportunity({
      bankroll,
      trueProbability: c.trueProbability,
      price: priceDollars,
      restingContracts: c.market.yes_ask_size ?? 0,
      multiplier: config.feeMultiplier,
      kellyFraction: config.kellyFraction,
      minLiquidity: config.minLiquidity,
      survivalMode: config.survivalMode,
    });

    // Two ways in: the fee-aware edge check clears, or the contract is priced
    // at/above the floor. The second has no edge signal behind it.
    const meetsFloor = c.market.yes_ask >= minPrice;
    if (assessment.action === "skip" && !meetsFloor) {
      rejected.push(`${c.ticker} ${c.market.yes_ask}c: ${assessment.reason}`);
      continue;
    }

    const viaFloor = assessment.action === "skip" && meetsFloor;
    if (viaFloor) {
      const inSurvival = config.survivalMode && bankroll < config.survivalMode.balanceThreshold;
      const flat = inSurvival
        ? (config.survivalMode.flatBetDollars ?? 1)
        : (config.priceFloorStakeDollars ?? 1);
      const contracts = Math.floor((flat * 100) / c.market.yes_ask);
      if (contracts <= 0) continue;
      assessment.sizing = { contracts, dollarsAtRisk: (contracts * c.market.yes_ask) / 100 };
      assessment.edgeCheck = { observedEdge: 0, requiredEdge: 0, margin: 0, qualifies: false };
    }

    appendLog(
      `Candidate ${c.ticker}: edge ${(assessment.edgeCheck.observedEdge * 100).toFixed(1)}%, ` +
      `${assessment.sizing.contracts} contracts ($${assessment.sizing.dollarsAtRisk.toFixed(2)})`
    );

    await enterPosition({
      ticker: c.ticker,
      side: "yes",
      priceCents: c.market.yes_ask,
      contracts: assessment.sizing.contracts,
      reason: viaFloor
        ? `Price-floor entry on "${c.teamName}" at ${c.market.yes_ask}c (>= ${minPrice}c floor)` +
          (c.windowCheck.live ? " [in progress]" : "") + " - price level only, no edge signal"
        : `Sharp-book edge via ${probResult.provider} on "${c.teamName}" ` +
          `(true ${(c.trueProbability * 100).toFixed(1)}% vs ${(priceDollars * 100).toFixed(0)}c)` +
          (c.windowCheck.live ? " [in progress]" : ""),
      edgePct: assessment.edgeCheck.observedEdge * 100,
      teamName: c.teamName,
      sportKey,
      commenceTime: c.commenceTime,
    });
  }

  if (rejected.length) {
    appendLog(`${sportKey}: ${rejected.length} tradeable market(s) failed entry checks. First: ${rejected[0]}`);
  }
  return false;
}
