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
import { getTradeStats, getTradeLifecycles } from "../tradeLedgerStore.js";
import { buildStrategyReview } from "../strategyReview.js";
import { lastDiscovery } from "../seriesDiscovery.js";
import { getSeriesMap, RESOLVER_VERSION } from "../tickerResolver.js";
import { SCANNER_VERSION } from "../scanner.js";
import { EXECUTOR_VERSION } from "../executor.js";
import { describeCadence } from "../cadence.js";
import { diagnose, startHealthAlerts, HEALTH_VERSION } from "../healthReport.js";
import { getRestingOrders, MAKER_VERSION } from "../makerEngine.js";

/**
 * Read MONITOR_TOKEN the way a phone-edited Railway variable actually arrives.
 *
 * Pasting on a phone can leave invisible characters: a trailing space or
 * newline, wrapping quotes, a trailing comma, or a space inside the variable
 * NAME. Any one of those made the exact comparison fail and the route answer
 * 404 with no hint why. The name is matched case- and whitespace-insensitively
 * and the value is stripped of whitespace, quotes and trailing punctuation.
 * The token itself is hex, so none of the stripped characters can be part of it.
 */
function expectedToken() {
  let raw = process.env.MONITOR_TOKEN;
  if (raw == null) {
    const key = Object.keys(process.env).find(
      (k) => k.replace(/\s+/g, "").toUpperCase() === "MONITOR_TOKEN"
    );
    raw = key ? process.env[key] : "";
  }
  return hexOnly(raw);
}

/**
 * The token is hexadecimal, so anything that is not 0-9 / a-f is not part of
 * it - a zero-width space, a non-breaking space or a smart-punctuation
 * character that a phone keyboard slipped into the Railway variable. The
 * previous version only stripped ordinary whitespace, quotes and a trailing
 * comma, and Safari still got "Wrong monitor token" on a value that looked
 * identical on screen. Both sides are reduced to lowercase hex before comparing.
 */
function hexOnly(v) {
  return String(v || "").toLowerCase().replace(/[^0-9a-f]/g, "");
}

/** First 8 hex chars of SHA-256 - enough to compare two values, useless for recovering either. */
function fingerprint(v) {
  return v ? crypto.createHash("sha256").update(v).digest("hex").slice(0, 8) : null;
}

/** Constant-time compare, so the token cannot be recovered by timing. */
function tokenMatches(supplied) {
  const expected = expectedToken();
  const given = hexOnly(supplied);
  if (!expected || !given) return false;
  const a = Buffer.from(given);
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
    liveOnly: cfg.liveOnly !== false,
    disabledSports: cfg.disabledSports ?? [],
  };
}

export function registerMonitorRoutes(app) {
  // The self-diagnosis alerts run whether or not MONITOR_TOKEN is set: they go
  // to the account holder's own Telegram, not to this route. Contained - a
  // failure to start them must never stop the server from booting.
  try { startHealthAlerts(); } catch (err) { console.warn("[health] alerts not started:", err.message); }

  app.get("/api/monitor/:token", (req, res) => {
    if (!tokenMatches(req.params.token)) {
      // DISTINCT STATUS CODES, so a failed check says WHY without a login.
      // Every attempt so far came back a bare 404, and a 404 could mean the
      // variable is missing, the token differs, or the route is not deployed.
      //   503 - MONITOR_TOKEN is not set on the running server
      //   403 - it is set, and the supplied token does not match it
      //   404 - (from Express itself) this route is not deployed at all
      // Neither reveals anything about the token's value.
      const expected = expectedToken();
      if (!expected) return res.status(503).json({ error: "Monitor not configured on this server." });
      // Lengths and short hash fingerprints of both sides: enough to see
      // whether the server holds a different value (and how it differs in
      // length), not enough to recover the token.
      const given = hexOnly(req.params.token);
      return res.status(403).json({
        error: "Wrong monitor token.",
        server: { length: expected.length, fingerprint: fingerprint(expected) },
        supplied: { length: given.length, fingerprint: fingerprint(given) },
      });
    }

    const out = { at: new Date().toISOString() };

    // Every section is independently contained. A monitor that dies on one
    // broken subsystem tells you nothing about the other seven.
    const section = (name, fn) => {
      try { out[name] = fn(); } catch (err) { out[name] = { error: err.message }; }
    };

    // FIRST, because it is the answer: what is wrong and what fixes it.
    section("problems", () => diagnose());

    section("versions", () => ({
      health: HEALTH_VERSION,
      resolver: RESOLVER_VERSION,
      scanner: SCANNER_VERSION,
      executor: EXECUTOR_VERSION,
      maker: MAKER_VERSION,
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

    // Every bid resting on Kalshi right now, and any cancel still clearing.
    section("resting", () => Object.values(getRestingOrders()).map((o) => ({
      ticker: o.ticker, teamName: o.teamName, priceCents: o.priceCents, contracts: o.contracts,
      filledSeen: o.filledSeen || 0, placedAt: o.placedAt, refreshedAt: o.refreshedAt,
      commenceTime: o.commenceTime, cancelPendingAt: o.cancelPendingAt ?? null, cancelAttempts: o.cancelAttempts ?? 0,
    })));

    section("seriesMap", () => ({
      map: getSeriesMap(),
      discovery: lastDiscovery(),
    }));

    section("trades", () => getTradeStats());
    // Every closed trade, compact, so strategy changes can be tested against
    // the account's real history rather than argued about.
    section("closedTrades", () => getTradeLifecycles().completed.map((t) => ({
      ticker: t.ticker, team: t.teamName, sport: t.sportKey, n: t.contracts,
      in: t.entryPriceCents, out: t.exitPriceCents, exit: t.exitReason,
      net: Math.round(t.netDollars * 100) / 100, opened: t.entryTimestamp, closed: t.exitTimestamp,
      live: /In-play/i.test(String(t.entryReason || "")),
    })));
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

