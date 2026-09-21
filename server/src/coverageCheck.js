/**
 * coverageCheck.js
 *
 * Answers one question per sport, with evidence: "if a tradeable edge existed
 * in this sport right now, would the bot be able to take it?"
 *
 * The scan log could never answer that. "0 entered" is produced identically by
 * a healthy sport with no mispricing, a sport whose Kalshi series was never
 * found, a sport whose team names do not resolve, and a sport that crashed.
 * Those four need four different fixes, and telling them apart by reading logs
 * is guesswork. This walks every stage of the real pipeline, in order, using
 * the SAME functions the scanner uses, and names the first stage that fails.
 *
 * The stages, in pipeline order:
 *
 *   1. series    - does a Kalshi series ticker exist for this sport?
 *   2. model     - are there calibrated in-game parameters, or the generic set?
 *   3. odds      - does the sharp provider return lines?
 *   4. timing    - how many of those lines are live / pre-game / out of window?
 *   5. resolve   - do the team names resolve to real Kalshi tickers?
 *   6. market    - does Kalshi return those markets, and are they tradeable?
 *   7. price     - can a YES ask be read off the book?
 *   8. gate      - what does the entry gate say, code by code?
 *
 * A sport is "ready" when it reaches stage 8 with a price. Stage 8 returning
 * all `edge-too-small` is a HEALTHY result: it means the pipeline works and
 * the market is fairly priced. That distinction is the whole point.
 *
 * COST: one /odds call per sport checked. Kalshi calls are not metered. This
 * is an on-demand endpoint, never on a timer.
 *
 * This module cannot throw. Every stage is individually contained, because a
 * diagnostic that dies on the first broken sport diagnoses nothing.
 */

import { kalshiGet } from "./kalshiClient.js";
import { getSharpProbabilities } from "./scraper.js";
import { resolveTicker, getSeriesMap } from "./tickerResolver.js";
import { assessOpportunity } from "./riskManager.js";
import { priceFor, entryTiming, SCANNER_VERSION } from "./scanner.js";
import { paramsFor, SPORT_PARAMS } from "./liveModel.js";
import { CONFIRMED_SERIES, distinctiveTokens } from "./seriesDiscovery.js";
import { loadConfig } from "./configStore.js";

const V2 = "/trade-api/v2";
const TRADEABLE = new Set(["open", "active"]);

export const COVERAGE_VERSION = "2026-09-21-stagewalk";

/**
 * The sports that must work. Runtime discovery can and does add more; these
 * are the ones held to account explicitly, so a regression in any of them is
 * visible rather than inferred from an empty board.
 */
export const REQUIRED_SPORTS = [
  "americanfootball_nfl",
  "americanfootball_ncaaf",
  "basketball_nba",
  "basketball_ncaab",
  "baseball_mlb",
  "icehockey_nhl",
  "soccer_epl",
  "soccer_spain_la_liga",
  "soccer_germany_bundesliga",
  "soccer_italy_serie_a",
  "soccer_usa_mls",
  "tennis_atp_us_open",
];

/** Human wording for each stage, used by the dashboard. */
export const STAGE_LABELS = {
  series: "Kalshi series",
  model: "In-game model",
  odds: "Sharp odds feed",
  timing: "Entry timing",
  resolve: "Ticker resolution",
  market: "Market status",
  price: "Order book price",
  gate: "Entry gate",
};

function stage(name, ok, detail, extra = {}) {
  return { stage: name, label: STAGE_LABELS[name] || name, ok: !!ok, detail, ...extra };
}

/**
 * Walks one sport through the pipeline. Never throws.
 *
 * `sampleSize` caps how many teams are carried past the odds stage. Six is
 * enough to prove resolution and pricing work without walking a 40-game
 * college slate market by market.
 */
export async function checkSport(sportKey, { config, sampleSize = 6 } = {}) {
  const cfg = config || loadConfig();
  const stages = [];
  const result = {
    sportKey,
    verdict: "unknown",
    blockedAt: null,
    headline: "",
    stages,
    counts: {},
    samples: [],
    gateCodes: {},
  };

  // ---- 1. series -------------------------------------------------------
  let seriesTicker = null;
  try {
    const map = getSeriesMap() || {};
    seriesTicker = map[sportKey] || CONFIRMED_SERIES[sportKey] || null;
    if (seriesTicker) {
      stages.push(stage("series", true,
        `mapped to ${seriesTicker}${CONFIRMED_SERIES[sportKey] ? " (confirmed)" : " (discovered at runtime)"}`,
        { seriesTicker }));
    } else {
      stages.push(stage("series", false,
        `no Kalshi series found. Runtime discovery searched for: ${distinctiveTokens(sportKey).join(", ") || "(no distinctive tokens)"}. ` +
        `Kalshi may not list this competition, or it lists it under wording none of those tokens match.`,
        { seriesTicker: null, tokens: distinctiveTokens(sportKey) }));
    }
  } catch (err) {
    stages.push(stage("series", false, `series lookup failed: ${err.message}`));
  }

  // ---- 2. model --------------------------------------------------------
  try {
    const calibrated = !!SPORT_PARAMS[sportKey];
    const params = paramsFor(sportKey);
    stages.push(stage("model", !!params,
      calibrated
        ? `calibrated (sigma ${params.sigma}, ${params.wallClockMinutes}m wall clock) - in-play entries are checked against the live score`
        : `generic fallback (sigma ${params.sigma}) - in-play entries still run, but the model is deliberately unconfident so the sharp line carries the decision`,
      { calibrated, params }));
  } catch (err) {
    stages.push(stage("model", false, `model lookup failed: ${err.message}`));
  }

  // ---- 3. odds ---------------------------------------------------------
  let probResult = null;
  try {
    probResult = await getSharpProbabilities(sportKey, {
      oddsPapiTournamentId: (cfg.oddsPapiTournamentIds || {})[sportKey],
      providerOrder: cfg.oddsProviderOrder,
    });
  } catch (err) {
    stages.push(stage("odds", false, `odds fetch failed: ${err.message}`));
    result.verdict = "blocked";
    result.blockedAt = "odds";
    result.headline = `Odds feed error: ${err.message}`;
    return result;
  }

  const entries = Object.entries(probResult.probabilities || {});
  result.counts.lines = entries.length;
  result.provider = probResult.provider;
  result.quotaRemaining = probResult.quota?.remaining ?? null;

  if (!entries.length) {
    stages.push(stage("odds", false,
      `${probResult.provider} returned 0 lines. Either no games are scheduled in this competition right now, or the competition is out of season / finished.`));
    result.verdict = "no-games";
    result.blockedAt = null;
    result.headline = "No games on the board - nothing to price. Not a fault.";
    return result;
  }
  stages.push(stage("odds", true, `${entries.length} line(s) from ${probResult.provider}`));

  // ---- 4. timing -------------------------------------------------------
  const live = [];
  const pregame = [];
  const outOfWindow = [];
  for (const [teamName, info] of entries) {
    const t = entryTiming(info.commenceTime, {
      entryWindowHours: cfg.entryWindowHours ?? 0,
      minMinutesBeforeStart: cfg.minMinutesBeforeStart ?? 0,
    });
    const row = { teamName, info, timing: t };
    if (!t.ok) outOfWindow.push(row);
    else if (t.live) live.push(row);
    else pregame.push(row);
  }
  result.counts.live = live.length;
  result.counts.pregame = pregame.length;
  result.counts.outOfWindow = outOfWindow.length;

  const eligible = [...live, ...pregame];
  if (!eligible.length) {
    stages.push(stage("timing", false,
      `all ${entries.length} line(s) are outside the entry window (${outOfWindow[0]?.timing?.reason || "no readable start time"})`));
    result.verdict = "blocked";
    result.blockedAt = "timing";
    result.headline = `${entries.length} line(s), none enterable on timing.`;
    return result;
  }
  stages.push(stage("timing", true,
    `${live.length} in play, ${pregame.length} pre-game, ${outOfWindow.length} outside the window`));

  // ---- 5-8: resolve -> market -> price -> gate, per sampled team --------
  const sample = eligible.slice(0, Math.max(1, sampleSize));
  let resolved = 0;
  let tradeable = 0;
  let priced = 0;
  let wouldEnter = 0;
  const gateCodes = {};

  for (const row of sample) {
    const s = {
      teamName: row.teamName,
      live: row.timing.live,
      sharpPct: Math.round((row.info.trueProbability ?? 0) * 1000) / 10,
      lineAgeSeconds: row.info.lineAgeSeconds ?? null,
    };

    try {
      const r = await resolveTicker({
        sportKey, teamName: row.teamName, commenceTime: row.info.commenceTime,
      });
      s.ticker = r.ticker || null;
      if (!r.ticker) { s.failedAt = "resolve"; s.note = r.reason; result.samples.push(s); continue; }
      resolved++;
    } catch (err) {
      s.failedAt = "resolve"; s.note = err.message; result.samples.push(s); continue;
    }

    let market = null;
    try {
      const res = await kalshiGet(`${V2}/markets/${s.ticker}`);
      market = res.market;
      const status = String(market?.status || "").toLowerCase();
      s.status = status || "missing";
      if (!market || !TRADEABLE.has(status)) {
        s.failedAt = "market";
        s.note = `status "${s.status}" is not tradeable`;
        result.samples.push(s);
        continue;
      }
      tradeable++;
    } catch (err) {
      s.failedAt = "market"; s.note = err.message; result.samples.push(s); continue;
    }

    let pricing = null;
    try {
      pricing = await priceFor(s.ticker, market);
      s.askCents = pricing.askCents;
      s.bidCents = pricing.bidCents;
      s.spreadCents = pricing.spreadCents;
      s.priceSource = pricing.source;
      if (!(pricing.askCents > 0 && pricing.askCents < 100)) {
        s.failedAt = "price";
        s.note = `no usable ask (${pricing.source})`;
        result.samples.push(s);
        continue;
      }
      priced++;
    } catch (err) {
      s.failedAt = "price"; s.note = err.message; result.samples.push(s); continue;
    }

    // Gate. Run with a nominal bankroll so a small balance does not mask a
    // pipeline that is otherwise healthy - this reports reachability, not
    // whether today's balance can afford the trade.
    try {
      const a = assessOpportunity({
        bankroll: 100,
        trueProbability: row.info.trueProbability,
        price: pricing.askCents / 100,
        restingContracts: pricing.askSize,
        multiplier: cfg.feeMultiplier,
        kellyFraction: cfg.kellyFraction,
        minLiquidity: cfg.minLiquidity ?? 0,
        maxRiskPctPerTrade: cfg.maxRiskPctPerTrade ?? 0.20,
        maxStakeDollars: cfg.maxStakeDollars ?? null,
        maxPlausibleEdge: cfg.maxPlausibleEdge ?? 0.18,
        minEntryPriceCents: cfg.minEntryPriceCents ?? 25,
        maxEntryPriceCents: cfg.maxEntryPriceCents ?? 88,
        minEvCentsPerContract: cfg.minEvCentsPerContract ?? 1,
        isLiveGame: row.timing.live,
        allowLiveGames: cfg.allowLiveGames !== false,
        lineAgeSeconds: row.info.lineAgeSeconds ?? null,
        maxLineAgeSecondsLive: cfg.maxLineAgeSecondsLive ?? 900,
        maxLineAgeSecondsPregame: cfg.maxLineAgeSecondsPregame ?? 7200,
        survivalMode: cfg.survivalMode,
      });
      if (a.action === "candidate") {
        s.gate = "would-enter";
        s.edgePct = Math.round(a.edgeCheck.observedEdge * 1000) / 10;
        s.evCents = Math.round(a.edgeCheck.evCents * 10) / 10;
        wouldEnter++;
        gateCodes["would-enter"] = (gateCodes["would-enter"] || 0) + 1;
      } else {
        const code = a.code || "skip-other";
        s.gate = code;
        s.note = a.reason;
        gateCodes[code] = (gateCodes[code] || 0) + 1;
      }
    } catch (err) {
      s.failedAt = "gate"; s.note = err.message;
    }

    result.samples.push(s);
  }

  result.counts.sampled = sample.length;
  result.counts.resolved = resolved;
  result.counts.tradeable = tradeable;
  result.counts.priced = priced;
  result.counts.wouldEnter = wouldEnter;
  result.gateCodes = gateCodes;

  stages.push(stage("resolve", resolved > 0,
    `${resolved}/${sample.length} team name(s) resolved to a Kalshi ticker` +
    (resolved === 0 ? ` - the series exists but no market matched these teams for this date` : "")));
  stages.push(stage("market", tradeable > 0,
    `${tradeable}/${Math.max(resolved, 1)} resolved market(s) are tradeable` +
    (resolved > 0 && tradeable === 0 ? ` - every one came back closed, settled or finalized` : "")));
  stages.push(stage("price", priced > 0,
    `${priced}/${Math.max(tradeable, 1)} tradeable market(s) returned a usable YES ask` +
    (tradeable > 0 && priced === 0 ? ` - the order books are empty` : "")));

  const codeLine = Object.entries(gateCodes).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} x${n}`).join(", ");
  stages.push(stage("gate", priced > 0,
    priced > 0
      ? (codeLine || "no verdicts recorded")
      : "not reached - nothing was priced"));

  // ---- verdict ---------------------------------------------------------
  const firstFail = stages.find((st) => !st.ok && st.stage !== "series" && st.stage !== "model");
  if (priced > 0) {
    result.verdict = "ready";
    result.blockedAt = null;
    result.headline = wouldEnter > 0
      ? `Working. ${wouldEnter} of ${sample.length} sampled market(s) clear the entry gate right now.`
      : `Working. Priced ${priced} market(s); none currently show an edge worth taking (${codeLine}). ` +
        `That is a fair market, not a fault.`;
  } else if (firstFail) {
    result.verdict = "blocked";
    result.blockedAt = firstFail.stage;
    result.headline = `Blocked at "${firstFail.label}": ${firstFail.detail}`;
  } else {
    result.verdict = "blocked";
    result.blockedAt = "price";
    result.headline = "Reached the book but read no price.";
  }

  // A sport with no series can still show as ready if tickers came from the
  // confirmed map; but if it has no series AND nothing resolved, say so first,
  // because that is the fix that matters.
  if (!seriesTicker && resolved === 0) {
    result.blockedAt = "series";
    result.verdict = "blocked";
    result.headline =
      `Blocked at "Kalshi series": no series ticker is mapped for this sport, so no team name can ever resolve. ` +
      `Either Kalshi does not list this competition, or discovery needs an alias for it.`;
  }

  return result;
}

/**
 * Runs the walk across a set of sports, sequentially.
 *
 * Sequential on purpose: parallel /odds calls burn the provider's per-second
 * limit and the failure then looks like a broken sport rather than a throttle.
 */
export async function runCoverageCheck({ sports, sampleSize = 6 } = {}) {
  const config = loadConfig();
  const list = Array.isArray(sports) && sports.length ? sports : REQUIRED_SPORTS;

  const report = {
    at: new Date().toISOString(),
    coverageVersion: COVERAGE_VERSION,
    scannerVersion: SCANNER_VERSION,
    oddsCallsUsed: 0,
    sports: [],
    summary: { ready: 0, noGames: 0, blocked: 0, wouldEnterNow: 0 },
  };

  for (const sportKey of list) {
    let row;
    try {
      row = await checkSport(sportKey, { config, sampleSize });
    } catch (err) {
      row = {
        sportKey, verdict: "blocked", blockedAt: "internal",
        headline: `Coverage check itself failed: ${err.message}`,
        stages: [], counts: {}, samples: [], gateCodes: {},
      };
    }
    report.oddsCallsUsed += 1;
    if (row.verdict === "ready") report.summary.ready += 1;
    else if (row.verdict === "no-games") report.summary.noGames += 1;
    else report.summary.blocked += 1;
    report.summary.wouldEnterNow += row.counts?.wouldEnter || 0;
    report.sports.push(row);
  }

  return report;
}
