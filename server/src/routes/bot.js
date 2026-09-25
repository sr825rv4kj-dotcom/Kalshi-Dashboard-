/**
 * Bot control, trade history and the original diagnostic scan.
 */
import { kalshiGet } from "../kalshiClient.js";
import { startBot, stopBot, isRunning, resumeTrading, resetCircuitBreaker } from "../botController.js";
import { loadConfig, saveConfig, setEnvironment } from "../configStore.js";
import { loadState, getRecentLog } from "../stateStore.js";
import { getRecentTrades, getTradeStats, getTradeLifecycles, loadLedger } from "../tradeLedgerStore.js";
import { clvReport, backfillFromLedger, clearKill } from "../clvTracker.js";
import { fairValueReport } from "../fairValue.js";
import { buildStrategyReview } from "../strategyReview.js";
import { getRecentScores, findScoreForTeam } from "../scoresFetcher.js";
import { getSharpProbabilities } from "../scraper.js";
import { resolveTicker } from "../tickerResolver.js";
import { discoverActiveSports } from "../sportsDiscovery.js";
import { runCoverageCheck, REQUIRED_SPORTS, COVERAGE_VERSION } from "../coverageCheck.js";

const V2 = "/trade-api/v2";

export function registerBotRoutes(app) {
  // --- Bot config ---
  app.get("/api/bot/config", (_req, res) => res.json(loadConfig()));

  app.post("/api/bot/config", (req, res) => {
    try {
      const { environment, confirmedProductionAt, ...safeUpdates } = req.body || {};
      res.json(saveConfig(safeUpdates));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/bot/environment", (req, res) => {
    try {
      const { environment, confirmed } = req.body || {};
      if (!["demo", "production"].includes(environment)) {
        return res.status(400).json({ error: "environment must be 'demo' or 'production'" });
      }
      res.json(setEnvironment(environment, confirmed));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Bot start/stop/status ---
  app.get("/api/bot/status", async (_req, res) => {
    try {
      const state = loadState();
      const config = loadConfig();

      let currentBalance = null;
      let survivalModeActive = null;
      try {
        const balanceData = await kalshiGet(`${V2}/portfolio/balance`);
        currentBalance = (balanceData.balance ?? 0) / 100;
        if (config.survivalMode) survivalModeActive = currentBalance < config.survivalMode.balanceThreshold;
      } catch {
        // leave null - the frontend handles it
      }

      res.json({
        running: isRunning(),
        environment: config.environment,
        haltedForDay: state.haltedForDay,
        haltReason: state.haltReason,
        dayStartBalance: state.dayStartBalance,
        currentBalance,
        survivalMode: config.survivalMode ? { active: survivalModeActive, ...config.survivalMode } : null,
        openPositions: state.positions,
        botStartedAt: state.botStartedAt,
        tradeStats: getTradeStats(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/bot/start", (_req, res) => {
    try {
      res.json(startBot());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Clears a day halt and re-bases the drawdown baseline to current equity.
   *
   * Without this the only way out of a halt was to wait for the server's
   * calendar day to roll over - which on a UTC host is mid-afternoon local
   * time, and meant a loss taken under a strategy that has since been replaced
   * went on blocking the replacement from ever trading.
   */
  app.post("/api/bot/resume", async (_req, res) => {
    try {
      const result = await resumeTrading();
      resetCircuitBreaker();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/bot/stop", (_req, res) => {
    try {
      res.json(stopBot());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/bot/log", (req, res) => {
    const limit = Number(req.query.limit) || 100;
    res.json({ log: getRecentLog(limit) });
  });

  app.get("/api/trade-ledger", (req, res) => {
    const limit = Number(req.query.limit) || 100;
    res.json({ trades: getRecentTrades(limit) });
  });

  /**
   * Full trade lifecycles: completed round-trips with real cost, proceeds and
   * ROI, plus still-open positions. Final scores are opt-in (?withScores=true)
   * because they bill against the odds API separately from odds.
   */
  app.get("/api/trade-lifecycles", async (req, res) => {
    try {
      const { completed, open } = getTradeLifecycles();

      if (req.query.withScores === "true" && completed.length) {
        const sportKeys = [...new Set(completed.map((t) => t.sportKey).filter(Boolean))];
        const scoresBySport = {};
        for (const sportKey of sportKeys) {
          try {
            const { events } = await getRecentScores(sportKey);
            scoresBySport[sportKey] = events;
          } catch {
            scoresBySport[sportKey] = [];
          }
        }
        for (const trade of completed) {
          if (!trade.sportKey || !trade.teamName) continue;
          trade.finalScore = findScoreForTeam(scoresBySport[trade.sportKey] || [], trade.teamName);
        }
      }

      res.json({ completed, open, stats: getTradeStats() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Original diagnostic. Fully guarded - an unhandled throw here used to return
   * Express's HTML error page, which the panel reported as a JSON parse error
   * that named nothing useful. /api/diagnose/v2 in diagnostics.js is the
   * deeper report; this stays for compatibility.
   */
  /**
   * Groups completed trades by the dimensions the strategy has knobs for -
   * exit behaviour, entry price band, edge size, in-play vs pre-game - so
   * thresholds can be tuned against results instead of argument.
   */
  app.get("/api/strategy-review", (_req, res) => {
    try {
      res.json(buildStrategyReview());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * CLOSING LINE VALUE. Per-segment CLV (sport, timing, price band), what is
   * killed, what is proven, and the most recent marks - every one a live
   * Kalshi book read.
   */
  app.get("/api/clv", (_req, res) => {
    try {
      res.json(clvReport(loadConfig()));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Marks the account's HISTORICAL trades from Kalshi's one-minute candles, so
   * the kill switch starts from the real record. Safe to run more than once -
   * trades already marked are skipped. Reports every skip with its reason.
   */
  app.post("/api/clv/backfill", async (_req, res) => {
    try {
      const entries = loadLedger().filter((t) => t.action === "enter" && t.filled > 0);
      res.json(await backfillFromLedger(entries, loadConfig()));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Clears a kill by hand: body { segment: "sport:baseball_mlb" } or { segment: "*" }. */
  app.post("/api/clv/clear-kill", (req, res) => {
    try {
      const seg = String(req.body?.segment || "");
      if (!seg) return res.status(400).json({ error: "segment is required (or \"*\" for all)" });
      res.json({ cleared: clearKill(seg) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Fair-value exit: mode, and every WOULD SELL / SOLD / SUSPECT decision with its real numbers. */
  app.get("/api/fair-value", (_req, res) => {
    try {
      res.json(fairValueReport(loadConfig()));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/diagnose", async (_req, res) => {
    const report = { config: {}, pool: [], activeSports: [], sports: [] };

    try {
      const config = loadConfig();
      report.pool = config.sportsPool || config.sports || [];
      report.config = {
        entryWindowHours: config.entryWindowHours,
        minEntryPriceCents: config.minEntryPriceCents,
        perPositionStopLossPct: config.perPositionStopLossPct,
        exitBelowCost: config.exitBelowCost,
      };

      try {
        report.activeSports = await discoverActiveSports();
      } catch (err) {
        report.sportsError = err.message;
      }

      for (const sportKey of report.activeSports) {
        const entry = { sportKey, oddsOk: false, teamsFound: 0, samples: [] };
        try {
          const probResult = await getSharpProbabilities(sportKey, {
            oddsPapiTournamentId: (config.oddsPapiTournamentIds || {})[sportKey],
            providerOrder: config.oddsProviderOrder,
          });
          entry.oddsOk = true;
          entry.provider = probResult.provider;
          entry.quotaRemaining = probResult.quota?.remaining ?? null;

          const teams = Object.entries(probResult.probabilities);
          entry.teamsFound = teams.length;

          for (const [teamName, info] of teams.slice(0, 3)) {
            const sample = { teamName, trueProbability: info.trueProbability, commenceTime: info.commenceTime };
            try {
              const resolved = await resolveTicker({ sportKey, teamName, commenceTime: info.commenceTime });
              sample.ticker = resolved.ticker;
              sample.resolveReason = resolved.reason;
              if (resolved.ticker) {
                const m = await kalshiGet(`${V2}/markets/${resolved.ticker}`);
                sample.marketStatus = m.market?.status;
                sample.yesAsk = m.market?.yes_ask;
                sample.yesAskSize = m.market?.yes_ask_size;
              }
            } catch (err) {
              sample.marketError = err.message;
            }
            entry.samples.push(sample);
          }
        } catch (err) {
          entry.oddsError = err.message;
        }
        report.sports.push(entry);
      }

      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message, partial: report });
    }
  });

  /**
   * Per-sport coverage walk.
   *
   * Answers "would this sport trade if an edge existed", stage by stage, using
   * the same functions the scanner uses. On demand only: it spends one odds
   * credit per sport, so nothing here runs on a timer.
   *
   *   GET /api/coverage                      -> the 12 required sports
   *   GET /api/coverage?sports=a,b           -> just those
   *   GET /api/coverage?discovered=true      -> whatever the feed says is live
   *   GET /api/coverage?sample=3             -> markets sampled per sport (1-12)
   */
  app.get("/api/coverage", async (req, res) => {
    try {
      let sports = null;

      if (typeof req.query.sports === "string" && req.query.sports.trim()) {
        sports = req.query.sports.split(",").map((s) => s.trim()).filter(Boolean);
      } else if (req.query.discovered === "true") {
        try {
          const active = await discoverActiveSports();
          // Union with the required list so a required sport going missing from
          // discovery is visible as a row rather than silently absent.
          sports = [...new Set([...REQUIRED_SPORTS, ...active])];
        } catch (err) {
          sports = REQUIRED_SPORTS;
          res.set("X-Coverage-Note", `discovery failed: ${err.message}`);
        }
      }

      const sampleSize = Math.min(12, Math.max(1, Number(req.query.sample) || 6));
      const report = await runCoverageCheck({ sports, sampleSize });
      report.requiredSports = REQUIRED_SPORTS;
      report.coverageVersion = COVERAGE_VERSION;
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
