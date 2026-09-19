/**
 * Deep diagnostic. Registers /api/diagnose/v2 - a separate path from the
 * original /api/diagnose so it can live alongside it without route conflicts.
 *
 * Every stage is individually guarded and the whole handler is wrapped. The
 * old endpoint threw on failure, which returned Express's HTML error page, and
 * the panel reported "the string did not match the expected pattern" - a JSON
 * parse failure that told you nothing about the actual fault.
 */
import fs from "fs";
import crypto from "crypto";
import { kalshiGet } from "./kalshiClient.js";
import { tradableBankroll } from "./botController.js";
import { loadConfig } from "./configStore.js";
import { loadState } from "./stateStore.js";
import { getSharpProbabilities } from "./scraper.js";
import { resolveTicker, getFetchReport, SPORT_SERIES_MAP } from "./tickerResolver.js";
import { discoverActiveSports } from "./sportsDiscovery.js";
import { assessOpportunity } from "./riskManager.js";

const V2 = "/trade-api/v2";

export function registerDiagnosticRoutes(app) {
  app.get("/api/diagnose/v2", async (_req, res) => {
    const report = { ranAt: new Date().toISOString(), stages: {}, sports: [] };

    try {
           // Stage 1: which key is actually signing requests. Computed here rather
      // than imported so this endpoint works against the current kalshiClient.
      try {
        const keyId = process.env.KALSHI_API_KEY_ID;
        const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH;
        const keyPem = process.env.KALSHI_PRIVATE_KEY_PEM;
        const fileExists = Boolean(keyPath && fs.existsSync(keyPath));

        // The env var wins in the current client, so report it as the source
        // whenever it is set - that is what is really signing.
        const source = keyPem
          ? "KALSHI_PRIVATE_KEY_PEM env var"
          : fileExists ? "saved in app" : "none";

        let fingerprint = null;
        let keyError = null;
        try {
          const pem = keyPem ? keyPem.replace(/\\n/g, "\n") : fs.readFileSync(keyPath, "utf8");
          const pub = crypto.createPublicKey(pem);
          fingerprint = crypto
            .createHash("sha256")
            .update(pub.export({ type: "spki", format: "der" }))
            .digest("hex")
            .slice(0, 16);
        } catch (err) {
          keyError = err.message;
        }

        report.stages.credentials = {
          keyId: keyId ? `${keyId.slice(0, 8)}...` : null,
          source,
          envVarAlsoSet: Boolean(keyPem),
          keyFileExists: fileExists,
          fingerprint,
          keyError,
        };
      } catch (err) {
        report.stages.credentials = { error: err.message };
      }

      // Stage 2: can we reach Kalshi at all
      try {
        const bal = await kalshiGet(`${V2}/portfolio/balance`);
        report.stages.kalshi = { ok: true, balanceDollars: (bal.balance ?? 0) / 100 };
      } catch (err) {
        report.stages.kalshi = { ok: false, error: err.message };
      }

      // Stage 3: the config actually in force on the volume, not in the repo
      const config = loadConfig();
      const bankroll = report.stages.kalshi?.balanceDollars ?? 0;
      const tiering = tradableBankroll(bankroll, config);
      report.stages.config = {
        environment: config.environment,
        entryWindowHours: config.entryWindowHours,
        minEntryPriceCents: config.minEntryPriceCents,
        perPositionStopLossPct: config.perPositionStopLossPct,
        takeProfitPct: config.takeProfitPct ?? 0.12,
        trailingStopPct: config.trailingStopPct ?? 0.08,
        exitBelowCost: config.exitBelowCost,
        entrySlippageCents: config.entrySlippageCents ?? 1,
        tier: tiering.tier,
        reserve: tiering.reserve,
        tradableBankroll: tiering.tradable,
        openPositions: loadState().positions.length,
      };

      // Stage 4: what is in season
      let activeSports = [];
      try {
        activeSports = await discoverActiveSports();
        report.stages.sports = { ok: true, activeSports, seriesMapped: Object.keys(SPORT_SERIES_MAP) };
      } catch (err) {
        report.stages.sports = { ok: false, error: err.message };
        activeSports = [];
      }

      // Stage 5: per sport - odds, resolution, live price, and the exact
      // verdict the risk manager would hand back for a real entry.
      for (const sportKey of activeSports) {
        const entry = { sportKey, samples: [] };

        let probResult = null;
        try {
          probResult = await getSharpProbabilities(sportKey, {
            oddsPapiTournamentId: (config.oddsPapiTournamentIds || {})[sportKey],
            providerOrder: config.oddsProviderOrder,
          });
          entry.odds = {
            ok: true,
            provider: probResult.provider,
            teamsFound: Object.keys(probResult.probabilities).length,
            quotaRemaining: probResult.quota?.remaining ?? null,
          };
        } catch (err) {
          entry.odds = { ok: false, error: err.message };
          report.sports.push(entry);
          continue;
        }

        const teams = Object.entries(probResult.probabilities);
        for (const [teamName, info] of teams.slice(0, 4)) {
          const sample = { teamName, trueProbability: info.trueProbability, commenceTime: info.commenceTime };
          try {
            const resolved = await resolveTicker({ sportKey, teamName, commenceTime: info.commenceTime });
            sample.ticker = resolved.ticker;
            sample.resolveReason = resolved.reason;

            if (resolved.ticker) {
              const m = await kalshiGet(`${V2}/markets/${resolved.ticker}`);
              const market = m.market || {};
              sample.marketStatus = market.status;
              sample.yesAsk = market.yes_ask;
              sample.yesAskSize = market.yes_ask_size;

              if (market.yes_ask > 0) {
                const verdict = assessOpportunity({
                  bankroll: tiering.tradable,
                  trueProbability: info.trueProbability,
                  price: market.yes_ask / 100,
                  restingContracts: market.yes_ask_size ?? 0,
                  multiplier: config.feeMultiplier,
                  kellyFraction: config.kellyFraction ?? tiering.tier.kellyFraction,
                  minLiquidity: config.minLiquidity ?? 0,
                  maxStakeDollars: tiering.tier.maxStakeDollars,
                  survivalMode: config.survivalMode,
                });
                sample.verdict = verdict.action;
                sample.verdictReason = verdict.reason ?? null;
                sample.edge = verdict.edgeCheck ?? null;
                sample.sizing = verdict.sizing ?? null;
              }
            }
          } catch (err) {
            sample.error = err.message;
          }
          entry.samples.push(sample);
        }

        // Raw Kalshi query telemetry: which query shape won, row counts,
        // status histogram. This is the layer that keeps returning zero.
        entry.kalshiFetch = getFetchReport(SPORT_SERIES_MAP[sportKey]);
        report.sports.push(entry);
      }

      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message, partial: report });
    }
  });
}
