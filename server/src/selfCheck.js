/**
 * Self-audit. Registers /api/selfcheck.
 *
 * Two classes of failure have cost this project the most time, and neither
 * shows up in a deploy log:
 *   1. Version drift - one module imports a symbol a stale sibling never
 *      exported. The server either won't boot or a route silently 500s.
 *   2. Config that is syntactically fine but arithmetically prohibits trading
 *      (a 1% risk cap on a $19.67 balance floors every order to zero).
 * This checks both, plus live runtime state, and reports each finding with the
 * exact fix rather than a pass/fail.
 */
import { loadConfig } from "./configStore.js";
import { loadState } from "./stateStore.js";
import { kalshiGet } from "./kalshiClient.js";

const V2 = "/trade-api/v2";

/** Modules and the named exports their siblings depend on. */
const CONTRACTS = [
  { file: "./kalshiClient.js", expects: ["kalshiGet", "kalshiPost", "kalshiDelete", "hasCredentialsConfigured", "resetCredentialsCache"] },
  { file: "./tickerResolver.js", expects: ["resolveTicker", "SPORT_SERIES_MAP", "getFetchReport"] },
  { file: "./riskManager.js", expects: ["assessOpportunity", "perContractFee", "requiredEdgeThreshold", "fractionalKellySize"] },
  { file: "./botController.js", expects: ["startBot", "stopBot", "isRunning", "runCycle"] },
  { file: "./executor.js", expects: ["enterPosition", "exitPosition"] },
  { file: "./scanner.js", expects: ["scanSport"] },
  { file: "./scraper.js", expects: ["getSharpProbabilities"] },
  { file: "./sportsDiscovery.js", expects: ["discoverActiveSports"] },
  { file: "./cadence.js", expects: ["currentCadenceSeconds", "describeCadence"] },
  { file: "./tradeLedgerStore.js", expects: ["recordTrade", "getTradeLifecycles", "getTradeStats"] },
];

/** Optional exports - absence means a newer file was never committed. */
const OPTIONAL = [
  { file: "./botController.js", name: "tradableBankroll", meansMissing: "botController.js is the old version - milestone tiers and take-profit are not active" },
  { file: "./botController.js", name: "resetCircuitBreaker", meansMissing: "botController.js is the old version - no circuit breaker" },
  { file: "./kalshiClient.js", name: "describeCredentials", meansMissing: "kalshiClient.js is the old version - the env-var key still overrides the saved key" },
  { file: "./riskManager.js", name: "passesLiquidityFilter", meansMissing: "riskManager.js may be the old version" },
];

async function checkModules() {
  const findings = [];

  for (const c of CONTRACTS) {
    try {
      const mod = await import(c.file);
      const missing = c.expects.filter((name) => typeof mod[name] === "undefined");
      if (missing.length) {
        findings.push({
          level: "blocker", area: "module",
          detail: `${c.file} is missing required export(s): ${missing.join(", ")}`,
          fix: `A file importing ${c.file} expects these. Commit the current version of ${c.file}.`,
        });
      }
    } catch (err) {
      findings.push({
        level: "blocker", area: "module",
        detail: `${c.file} failed to load: ${err.message}`,
        fix: "Syntax error or a broken import inside that file. Check the deploy log for the line number.",
      });
    }
  }

  for (const o of OPTIONAL) {
    try {
      const mod = await import(o.file);
      if (typeof mod[o.name] === "undefined") {
        findings.push({
          level: "warn", area: "version",
          detail: `${o.file} does not export ${o.name}`,
          fix: o.meansMissing,
        });
      }
    } catch {
      // The blocker above already covers an unloadable module.
    }
  }

  return findings;
}

/**
 * Config rules. Each returns a finding or null. These encode the arithmetic
 * that has actually stopped trades, not style preferences.
 */
function checkConfig(config, bankroll) {
  const f = [];
  const price = 0.5; // representative mid-price contract

  const maxRisk = config.maxRiskPctPerTrade ?? 0.10;
  const dollarsAtRisk = bankroll * maxRisk;
  if (dollarsAtRisk < price) {
    f.push({
      level: "blocker", area: "sizing",
      detail: `maxRiskPctPerTrade ${(maxRisk * 100).toFixed(0)}% of $${bankroll.toFixed(2)} is $${dollarsAtRisk.toFixed(2)} - less than one 50c contract, so every order floors to zero.`,
      fix: `Raise maxRiskPctPerTrade to at least ${Math.ceil((price / Math.max(bankroll, 0.01)) * 100)}%, or rely on the one-contract floor in the current riskManager.js.`,
    });
  }

  const minLiq = config.minLiquidity ?? 0;
  if (minLiq >= 25) {
    f.push({
      level: "blocker", area: "liquidity",
      detail: `minLiquidity is ${minLiq} resting contracts, but positions at this bankroll are 1-4 contracts. Most game markets never show ${minLiq}.`,
      fix: "Set minLiquidity to 0 and let the relative 2x-coverage check govern.",
    });
  }

  if (config.entryWindowHours) {
    f.push({
      level: "warn", area: "timing",
      detail: `entryWindowHours is ${config.entryWindowHours} - games outside that window are skipped before any price check.`,
      fix: "Set entryWindowHours to 0 or null to trade live games at any point.",
    });
  }

  const tp = config.takeProfitPct ?? 0.12;
  const feeRoundTrip = 2 * Math.ceil(0.07 * price * (1 - price) * 100) / 100;
  const grossNeeded = feeRoundTrip / price;
  if (tp <= grossNeeded) {
    f.push({
      level: "warn", area: "exits",
      detail: `takeProfitPct ${(tp * 100).toFixed(0)}% does not clear round-trip fees (~${(grossNeeded * 100).toFixed(0)}% at 50c). Winners would close at a loss.`,
      fix: `Raise takeProfitPct above ${(grossNeeded * 100).toFixed(0)}%.`,
    });
  }

  if (config.exitBelowCost) {
    f.push({
      level: "warn", area: "exits",
      detail: "exitBelowCost fires on any tick below entry, which is ordinary noise. Each exit pays the round-trip fee.",
      fix: "Turn exitBelowCost off and let perPositionStopLossPct govern, unless you want the tightest possible stop.",
    });
  }

  const cap = config.maxConcurrentPositions;
  if (cap != null && cap < 1) {
    f.push({
      level: "blocker", area: "limits",
      detail: `maxConcurrentPositions is ${cap} - no position can ever open.`,
      fix: "Set it to 2 or more.",
    });
  }

  if (config.survivalMode && bankroll < (config.survivalMode.balanceThreshold ?? 0)) {
    const mult = config.survivalMode.edgeMultiplier ?? 1;
    f.push({
      level: mult > 1.5 ? "blocker" : "warn", area: "survival",
      detail: `Survival mode is active (balance $${bankroll.toFixed(2)} below $${config.survivalMode.balanceThreshold}) and requires ${mult}x the normal edge.`,
      fix: mult > 1.5
        ? `An edge multiplier of ${mult} is close to unreachable. Lower survivalMode.edgeMultiplier to 1.2 or less.`
        : "This is intentional caution at a small balance - no action needed.",
    });
  }

  if (config.environment !== "production") {
    f.push({
      level: "warn", area: "environment",
      detail: `Environment is "${config.environment}" - orders do not touch the real account.`,
      fix: "Switch to production in Bot Settings when you intend to trade real money.",
    });
  }

  return f;
}

function checkRuntime(state, botRunning) {
  const f = [];

  if (!botRunning) {
    f.push({
      level: "blocker", area: "runtime",
      detail: "The bot is not running - no scans are happening.",
      fix: "Press Start on the bot panel, or enable the watchdog to keep it running automatically.",
    });
  }

  if (state.haltedForDay) {
    f.push({
      level: "blocker", area: "runtime",
      detail: `Trading is halted for the day: ${state.haltReason}`,
      fix: "This clears itself at the next calendar day. To resume sooner, raise dailyLossHaltPct.",
    });
  }

  return f;
}

export function registerSelfCheckRoutes(app) {
  app.get("/api/selfcheck", async (_req, res) => {
    const report = { ranAt: new Date().toISOString(), findings: [] };

    try {
      report.findings.push(...(await checkModules()));

      const config = loadConfig();
      const state = loadState();

      let bankroll = 0;
      try {
        const bal = await kalshiGet(`${V2}/portfolio/balance`);
        bankroll = (bal.balance ?? 0) / 100;
        report.balanceDollars = bankroll;
      } catch (err) {
        report.findings.push({
          level: "blocker", area: "kalshi",
          detail: `Cannot read balance: ${err.message}`,
          fix: "Check the API key in the credentials screen and that KALSHI_PRIVATE_KEY_PEM is not set in Railway.",
        });
      }

      let botRunning = false;
      try {
        const bc = await import("./botController.js");
        botRunning = bc.isRunning();
      } catch { /* module check already reported this */ }

      report.findings.push(...checkConfig(config, bankroll));
      report.findings.push(...checkRuntime(state, botRunning));

      const order = { blocker: 0, warn: 1, ok: 2 };
      report.findings.sort((a, b) => order[a.level] - order[b.level]);
      report.summary = {
        blockers: report.findings.filter((x) => x.level === "blocker").length,
        warnings: report.findings.filter((x) => x.level === "warn").length,
      };

      if (!report.summary.blockers) {
        report.findings.unshift({
          level: "ok", area: "summary",
          detail: "No mechanical blocker found. If the bot still is not trading, no market currently clears the edge threshold.",
          fix: "Watch the scan log for 'failed entry checks' - the reason there is the live market condition, not a bug.",
        });
      }

      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message, partial: report });
    }
  });
}
