import React, { useState } from "react";

const TONE = { blocker: "neg", warn: "", ok: "pos" };
const ICON = { blocker: "⛔️", warn: "⚠️", ok: "✅" };

/**
 * Settings the "Apply" button writes through /api/bot/config.
 *
 * This block used to push the OPPOSITE of the current strategy. It set
 * entryWindowHours to 0 ("trade live games at any point"), takeProfitPct to
 * 0.15 and trailingStopPct to 0.08 - which is precisely the behaviour that was
 * measured at -1.92c per contract and removed. One tap would have quietly
 * reverted the whole strategy change while reporting success.
 *
 * It now matches the shipped defaults in configStore.js. Keep the two in step:
 * if a default changes there, change it here as well, or this button becomes a
 * way to silently drift the running bot away from the tested configuration.
 */
const RECOMMENDED = {
  // What may be traded
  allowLiveGames: false,        // a pre-game line cannot price a live market
  holdToSettlement: true,       // settlement is free; a flip pays a second fee
  entryWindowHours: 8,
  minMinutesBeforeStart: 0,

  // Price band - below 25c the whole-cent fee dominates the stake
  minEntryPriceCents: 25,
  maxEntryPriceCents: 88,
  maxPlausibleEdge: 0.18,
  minEvCentsPerContract: 2,
  maxSpreadCents: 6,
  minLiquidity: 0,              // coverage is checked against order size instead

  // Sizing
  kellyFraction: 0.25,
  maxRiskPctPerTrade: 0.20,

  // Exits: the three nulls are deliberate, not missing. Each cost more in
  // fees than it ever saved in price.
  perPositionStopLossPct: null,
  takeProfitPct: null,
  trailingStopPct: null,
  exitBelowCost: false,         // the bid is ALWAYS below entry right after buying
  blowoutExitBelowCents: 12,
  blowoutExitCollapsePct: 0.6,

  reentryCooldownMinutes: 60,
  dailyLossHaltPct: 0.15,
};

export default function SelfCheckPanel({ apiBase }) {
  const [report, setReport] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(null);
  const [confirming, setConfirming] = useState(false);

  async function run() {
    setRunning(true); setError(null); setReport(null); setApplied(null);
    try {
      const res = await fetch(`${apiBase}/api/selfcheck`);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error(`Server returned ${res.status}: ${text.slice(0, 200)}`); }
      if (data.error && !data.partial) throw new Error(data.error);
      setReport(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  async function applyFixes() {
    setApplying(true); setError(null); setApplied(null); setConfirming(false);
    try {
      const res = await fetch(`${apiBase}/api/bot/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(RECOMMENDED),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setApplied("Settings written. Re-running check...");
      await run();
      setApplied("Tested defaults applied. Restart the bot so the next scan picks them up.");
    } catch (err) {
      setError(err.message);
    } finally {
      setApplying(false);
    }
  }

  const blockers = report?.summary?.blockers ?? 0;

  return (
    <div className="panel">
      <h2>System Check</h2>
      <p className="setup-copy">
        Audits the running code against itself - missing exports, stale files,
        and any config value that makes trading arithmetically impossible.
      </p>

      <button type="button" onClick={run} disabled={running || applying}>
        {running ? "Checking..." : "Run system check"}
      </button>

      {report && !confirming && (
        <button
          type="button"
          className="ledger-toggle"
          onClick={() => setConfirming(true)}
          disabled={applying || running}
          style={{ marginTop: 10 }}
        >
          Reset to tested defaults
        </button>
      )}

      {confirming && (
        <div className="error-banner" style={{ marginTop: 12 }}>
          This overwrites the live strategy settings with the tested defaults:
          pre-game entries only, held to settlement, 25-88c price band, 25% Kelly.
          Anything you have tuned by hand will be replaced.
          <div className="error-action" style={{ display: "flex", gap: 10 }}>
            <button type="button" onClick={applyFixes} disabled={applying}>
              {applying ? "Applying..." : "Yes, reset"}
            </button>
            <button type="button" className="modal-cancel" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {applied && <div className="ledger-reason" style={{ marginTop: 10 }}>{applied}</div>}
      {error && <div className="error-banner" style={{ marginTop: 16 }}>{error}</div>}

      {report && (
        <div className="bot-subsection">
          <div className="ledger-figures ledger-summary">
            <div>
              <span>Blockers</span>
              <strong className={blockers ? "neg" : "pos"}>{blockers}</strong>
            </div>
            <div><span>Warnings</span><strong>{report.summary?.warnings ?? 0}</strong></div>
          </div>

          {report.findings.map((f, i) => (
            <div key={i} className="ledger-card">
              <div className="ledger-card-head">
                <span>{ICON[f.level]} {f.area}</span>
                <span className={TONE[f.level]}>{f.level}</span>
              </div>
              <div style={{ marginTop: 8, fontSize: 15, lineHeight: 1.45 }}>{f.detail}</div>
              <div className="ledger-reason"><strong>Fix:</strong> {f.fix}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
  { file: "./scanner.js", name: "entryTiming", missing: "scanner.js is stale - it cannot tell a live game from a pre-game one, so it is still trading in-progress games against frozen pre-game lines" },
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
    equals: "2026-09-20-pregame-hold",
    missing: "scanner.js is stale - it is still entering live games off pre-game sharp lines, which measured at -1.92c per contract of expected value.",
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

  if (config.entryWindowHours) {
    f.push({
      level: "warn", area: "timing",
      detail: `entryWindowHours is ${config.entryWindowHours} - games outside that window are skipped before any price check.`,
      fix: "Set entryWindowHours to 0 to trade live games at any point.",
    });
  }

  const ceiling = config.maxPlausibleEdge ?? 0.25;
  if (!ceiling || ceiling > 0.5) {
    f.push({
      level: "warn", area: "data",
      detail: `maxPlausibleEdge is ${ceiling ? (ceiling * 100).toFixed(0) + "%" : "off"} - the sharp line is pre-game while Kalshi's price is live, so a huge apparent edge usually means the game has turned and the line is stale.`,
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
