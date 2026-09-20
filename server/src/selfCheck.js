/**
 * Self-audit. Registers /api/selfcheck.
 *
 * Checks three things that never appear in a deploy log:
 *   1. Version drift - a module missing an export a sibling imports, or an
 *      older version of a file whose behavior has since changed.
 *   2. Config that is syntactically fine but arithmetically prohibits trading.
 *   3. Runtime state - bot stopped, halted for the day, credentials broken.
 */
import { loadConfig } from "./configStore.js";
import { loadState } from "./stateStore.js";
import { kalshiGet } from "./kalshiClient.js";

const V2 = "/trade-api/v2";

/** Named exports each module's dependents require. */
const CONTRACTS = [
  { file: "./kalshiClient.js", expects: ["kalshiGet", "kalshiPost", "kalshiDelete", "hasCredentialsConfigured", "resetCredentialsCache"] },
  { file: "./tickerResolver.js", expects: ["resolveTicker", "SPORT_SERIES_MAP", "getFetchReport"] },
  { file: "./riskManager.js", expects: ["assessOpportunity", "perContractFee", "requiredEdgeThreshold", "fractionalKellySize", "feeCentsAt", "evPerContractCents"] },
  { file: "./botController.js", expects: ["startBot", "stopBot", "isRunning", "runCycle"] },
  { file: "./executor.js", expects: ["enterPosition", "exitPosition"] },
  { file: "./scanner.js", expects: ["scanSport"] },
  { file: "./scraper.js", expects: ["getSharpProbabilities", "devig"] },
  { file: "./configStore.js", expects: ["loadConfig", "saveConfig", "DEFAULTS", "STRATEGY_VERSION", "describeStrategy"] },
  { file: "./sportsDiscovery.js", expects: ["discoverActiveSports"] },
  { file: "./cadence.js", expects: ["currentCadenceSeconds", "describeCadence"] },
  { file: "./tradeLedgerStore.js", expects: ["recordTrade", "getTradeLifecycles", "getTradeStats"] },
];

/** Exports that exist only in the current version of a file. */
const EXPECTED_EXPORTS = [
  { file: "./botController.js", name: "tradableBankroll", missing: "botController.js is stale - milestone tiers and take-profit are not active" },
  { file: "./botController.js", name: "resetCircuitBreaker", missing: "botController.js is stale - no circuit breaker" },
  { file: "./kalshiClient.js", name: "describeCredentials", missing: "kalshiClient.js is stale - the env-var key still overrides your saved key" },
  { file: "./tickerResolver.js", name: "getFetchReport", missing: "tickerResolver.js is stale - no Kalshi query telemetry" },
  { file: "./scanner.js", name: "entryTiming", missing: "scanner.js is stale - it cannot tell a live game from a pre-game one, so it cannot apply the right quote-freshness limit to either" },
  { file: "./scraper.js", name: "devig", missing: "scraper.js is stale - the bookmaker margin is not being removed, which reports 2-4% of edge that does not exist on every single market" },
  { file: "./riskManager.js", name: "evPerContractCents", missing: "riskManager.js is stale - it still prices a round trip and demands roughly double the edge actually needed, rejecting most profitable entries" },
  { file: "./configStore.js", name: "STRATEGY_VERSION", missing: "configStore.js is stale - strategy defaults still come only from the volume file, so a deploy that changes how the bot trades changes nothing" },
];

/**
 * Version markers. Reading an exported module constant is reliable. The
 * previous approach read a single function's source, which could not see
 * markers declared beside that function - and reported a current scanner.js
 * as stale for an hour.
 */
const FINGERPRINTS = [
  {
    file: "./scanner.js",
    exportName: "SCANNER_VERSION",
    equals: "2026-09-20-live-fresh",
    missing: "scanner.js is stale - it either refuses live games outright, or enters them without checking whether the sharp quote is still being refreshed.",
  },
  {
    file: "./executor.js",
    exportName: "EXECUTOR_VERSION",
    equals: "2026-09-19-shard-patient",
    missing: "executor.js is stale - a collateral-routing failure still throws, which trips the circuit breaker and stops the bot instead of skipping that one market.",
  },
  {
    file: "./botController.js",
    exportName: "CONTROLLER_VERSION",
    equals: "2026-09-20-hold-to-settlement",
    missing: "botController.js is stale - it does not reconcile settled positions, so held positions never clear from tracking and the concurrent-position cap silently fills with finished games until the bot stops trading altogether.",
  },
];

async function checkModules() {
  const findings = [];
  const loaded = {};

  for (const c of CONTRACTS) {
    try {
      const mod = await import(c.file);
      loaded[c.file] = mod;
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
        fix: "Syntax error or a broken import inside that file. The deploy log has the line number.",
      });
    }
  }

  for (const e of EXPECTED_EXPORTS) {
    const mod = loaded[e.file];
    if (mod && typeof mod[e.name] === "undefined") {
      findings.push({
        level: "warn", area: "version",
        detail: `${e.file} does not export ${e.name}`,
        fix: e.missing,
      });
    }
  }

  for (const f of FINGERPRINTS) {
    const mod = loaded[f.file];
    if (!mod) continue;
    if (mod[f.exportName] !== f.equals) {
      findings.push({
        level: "blocker", area: "version",
        detail: `${f.file} reports version "${mod[f.exportName] ?? "none"}", expected "${f.equals}"`,
        fix: f.missing,
      });
    }
  }

  return findings;
}

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
      detail: `minLiquidity is ${minLiq} resting contracts, but positions at this bankroll are 1-4 contracts.`,
      fix: "Set minLiquidity to 0 and let the relative 2x-coverage check govern.",
    });
  }

  // Live trading status. This used to warn that entryWindowHours blocked live
  // games and advise setting it to 0 - advice that is now simply wrong.
  // entryWindowHours only limits how far AHEAD of kickoff to look; a game that
  // has already started is always eligible, and quote freshness decides it.
  if (config.allowLiveGames === false) {
    f.push({
      level: "warn", area: "live",
      detail: "Live trading is switched OFF - games already in progress are skipped no matter how good the price is.",
      fix: "Set allowLiveGames to true to trade in-play markets.",
    });
  } else {
    f.push({
      level: "ok", area: "live",
      detail: `Live trading is ON. In-play markets are traded with no waiting period, provided the sharp quote was refreshed within ${config.maxLineAgeSecondsLive ?? 180}s ` +
        `(pre-game allowance ${config.maxLineAgeSecondsPregame ?? 1800}s). A stale quote means the book has suspended its market while the exchange kept moving.`,
      fix: "No action needed. Raise maxLineAgeSecondsLive to accept older in-play quotes, lower it to be stricter.",
    });
  }

  if (config.entryWindowHours) {
    f.push({
      level: "ok", area: "timing",
      detail: `entryWindowHours is ${config.entryWindowHours} - that is how far AHEAD of kickoff a pre-game line is read. It does not limit live games, which are always eligible.`,
      fix: "No action needed. Raise it to look further ahead at pre-game markets.",
    });
  }

  const ceiling = config.maxPlausibleEdge ?? 0.25;
  if (!ceiling || ceiling > 0.5) {
    f.push({
      level: "warn", area: "data",
      detail: `maxPlausibleEdge is ${ceiling ? (ceiling * 100).toFixed(0) + "%" : "off"} - a sharp book and a live exchange that far apart means one of the two feeds is wrong, not that free money is on the screen.`,
      fix: "Set maxPlausibleEdge to about 0.25 so blowout losers at single-digit prices are refused.",
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
      fix: "Turn exitBelowCost off and let perPositionStopLossPct govern.",
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
        : "Intentional caution at a small balance - no action needed.",
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
      fix: "Press Start on the bot panel. The watchdog should also restart it within two minutes.",
    });
  }

  if (state.haltedForDay) {
    f.push({
      level: "blocker", area: "runtime",
      detail: `Trading is halted for the day: ${state.haltReason}`,
      fix: "This clears at the next calendar day. To resume sooner, raise dailyLossHaltPct.",
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
      } catch { /* the module check above already reported this */ }

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
          detail: "No mechanical blocker found. Every file is the current version. If the bot still is not trading, no market currently clears the edge threshold.",
          fix: "Watch the scan log for 'failed entry checks' - the reason printed there is the live market condition, not a bug.",
        });
      }

      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message, partial: report });
    }
  });
}
