/**
 * routes/monitor.js
 *
 * A single read-only endpoint that reports everything needed to diagnose why
 * the bot is or is not trading, without a login.
 *
 * WHY THIS EXISTS. Every /api/* route sits behind a Bearer token, so the only
 * way anyone outside the browser session could see what the bot was doing was
 * for Julian to screenshot it. That turned every diagnosis into a round trip:
 * a change went out, hours passed, a screenshot came back, and the next fix
 * waited on the one after that. Two resolver rewrites were built against an
 * imagined market shape for exactly this reason - the real board was never
 * visible to whoever was writing the code.
 *
 * SECURITY. This is deliberately NOT open. It requires a secret path segment
 * matched against MONITOR_TOKEN, compared in constant time, and it is
 * mounted BEFORE the auth gate so it can answer without a session. It exposes
 * read-only diagnostics and nothing else:
 *
 *   - it never returns API keys, the Kalshi private key, credentials,
 *     the Telegram token, or the account password hash
 *   - it has no POST, so it cannot start, stop, or configure the bot
 *   - it cannot place, cancel or alter an order
 *
 * If MONITOR_TOKEN is unset the route refuses every request, so deploying this
 * file without setting the variable changes nothing.
 */

import crypto from "crypto";
import { loadState, getRecentLog } from "../stateStore.js";
import { loadConfig } from "../configStore.js";
import { getTradeStats } from "../tradeLedgerStore.js";
import { buildStrategyReview } from "../strategyReview.js";
import { lastDiscovery } from "../seriesDiscovery.js";
import { getSeriesMap, RESOLVER_VERSION } from "../tickerResolver.js";
import { SCANNER_VERSION } from "../scanner.js";
import { EXECUTOR_VERSION } from "../executor.js";
import { describeCadence } from "../cadence.js";

/** Constant-time compare, so the token cannot be recovered by timing. */
function tokenMatches(supplied) {
  const expected = process.env.MONITOR_TOKEN || "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Config is echoed back FIELD BY FIELD, never spread.
 *
 * A spread would leak whatever secret a future version happens to store on the
 * config object. Listing the fields means a new secret is invisible here by
 * default, which is the safe direction for a route with no login.
 */
function safeConfig(cfg) {
  return {
    environment: cfg.environment,
    allowLiveGames: cfg.allowLiveGames,
    entryWindowHours: cfg.entryWindowHours,
    minMinutesBeforeStart: cfg.minMinutesBeforeStart,
    minEntryPriceCents: cfg.minEntryPriceCents,
    maxEntryPriceCents: cfg.maxEntryPriceCents,
    maxSpreadCents: cfg.maxSpreadCents,
    maxPlausibleEdge: cfg.maxPlausibleEdge,
    minEvCentsPerContract: cfg.minEvCentsPerContract,
    minEvCentsPerTrade: cfg.minEvCentsPerTrade,
    maxWalkupCents: cfg.maxWalkupCents,
    entrySlippageCents: cfg.entrySlippageCents,
    kellyFraction: cfg.kellyFraction,
    feeMultiplier: cfg.feeMultiplier,
    maxRiskPctPerTrade: cfg.maxRiskPctPerTrade,
    maxConcurrentPositions: cfg.maxConcurrentPositions,
    maxModelDisagreementPoints: cfg.maxModelDisagreementPoints,
    maxLineAgeSecondsLive: cfg.maxLineAgeSecondsLive,
    maxLineAgeSecondsPregame: cfg.maxLineAgeSecondsPregame,
    dailyLossHaltPct: cfg.dailyLossHaltPct,
    survivalMode: cfg.survivalMode,
  };
}

export function registerMonitorRoutes(app) {
  app.get("/api/monitor/:token", (req, res) => {
    if (!tokenMatches(req.params.token)) {
      return res.status(404).json({ error: "Not found." });
    }

    const out = { at: new Date().toISOString() };

    // Every section is independently contained. A monitor that dies on one
    // broken subsystem tells you nothing about the other seven.
    const section = (name, fn) => {
      try { out[name] = fn(); } catch (err) { out[name] = { error: err.message }; }
    };

    section("versions", () => ({
      resolver: RESOLVER_VERSION,
      scanner: SCANNER_VERSION,
      executor: EXECUTOR_VERSION,
      cadence: describeCadence(),
    }));

    section("bot", () => {
      const st = loadState();
      return {
        running: !!st.running,
        haltedForDay: !!st.haltedForDay,
        haltDate: st.haltDate ?? null,
        circuitBreakerOpen: !!st.circuitBreakerOpen,
        openPositions: (st.positions || []).length,
        positions: (st.positions || []).map((p) => ({
          ticker: p.ticker, teamName: p.teamName, sportKey: p.sportKey,
          contracts: p.contracts, entryPriceCents: p.entryPriceCents, openedAt: p.openedAt,
        })),
        sportHealth: st.sportHealth ?? null,
      };
    });

    // THE ANSWER TO "WHY IS IT NOT TRADING", straight from the scanner's own
    // per-sport tally, with one worked example per refusal code.
    section("lastScan", () => {
      const st = loadState();
      const scans = st.lastScan || {};
      return Object.entries(scans).map(([sportKey, row]) => ({
        sportKey,
        at: row.at,
        ageSeconds: Math.round((Date.now() - Date.parse(row.at)) / 1000),
        seen: row.seen,
        entered: row.entered,
        reasons: row.reasons,
        samples: row.samples,
      })).sort((a, b) => a.ageSeconds - b.ageSeconds);
    });

    section("seriesMap", () => ({
      map: getSeriesMap(),
      discovery: lastDiscovery(),
    }));

    section("trades", () => getTradeStats());
    section("review", () => {
      const r = buildStrategyReview();
      // The bucket tables are large and already derived from the ledger; the
      // blockers and the headline numbers are what diagnose a stalled bot.
      return {
        overall: r.overall, open: r.open, lastScan: r.lastScan,
        observations: r.observations, byExitFamily: r.byExitFamily, bySport: r.bySport,
      };
    });

    section("config", () => safeConfig(loadConfig()));
    section("log", () => getRecentLog(120));

    res.json(out);
  });
}
