/**
 * Bot control, trade history and the original diagnostic scan.
 */
import { kalshiGet } from "../kalshiClient.js";
import { startBot, stopBot, isRunning, resumeTrading, resetCircuitBreaker } from "../botController.js";
import { loadConfig, saveConfig, setEnvironment } from "../configStore.js";
import { loadState, getRecentLog } from "../stateStore.js";
import { getRecentTrades, getTradeStats, getTradeLifecycles } from "../tradeLedgerStore.js";
import { getRecentScores, findScoreForTeam } from "../scoresFetcher.js";
import { getSharpProbabilities } from "../scraper.js";
import { resolveTicker } from "../tickerResolver.js";
import { discoverActiveSports } from "../sportsDiscovery.js";

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
}
