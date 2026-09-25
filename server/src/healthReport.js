/**
 * healthReport.js
 *
 * The bot diagnoses itself and says, in plain English, what is stopping it
 * from trading and what fixes it.
 *
 * WHY THIS EXISTS. Every diagnosis so far has needed a person in the loop:
 * Julian screenshots the dashboard, someone reads the refusal codes, works out
 * which of a dozen gates is responsible, and writes back. That round trip cost
 * whole trading days. The information needed to reach the answer is already on
 * disk - the scanner writes a per-sport tally with a worked example for every
 * refusal code, the executor logs every rejected order, and the state file
 * records halts and the circuit breaker. Nothing ever READ it and drew the
 * conclusion. This does.
 *
 * Two outputs:
 *   - diagnose()          returns the full report; the /api/monitor route
 *                         exposes it as `problems` so it can be read remotely
 *   - startHealthAlerts() every 5 minutes, pushes any NEW critical or high
 *                         problem to Telegram, so the phone hears about a
 *                         stalled bot without anyone opening the dashboard
 *
 * SAFETY. This module only READS state. It cannot place, cancel or size an
 * order, change config, or start or stop the bot. Every check is individually
 * contained, the timer is unref'd so it can never hold the process open, and a
 * failure anywhere in here is swallowed rather than allowed to reach the
 * trading loop.
 */

import { loadState } from "./stateStore.js";
import { loadConfig } from "./configStore.js";
import { getTelegramCredentials } from "./telegramStore.js";

export const HEALTH_VERSION = "2026-09-22-self-diagnosis";

/** A scan older than this means the bot is not scanning, not being choosy. */
const SCAN_STALE_MS = 5 * 60 * 1000;
/** Scan rows older than this say nothing about now and are ignored. */
const SCAN_WINDOW_MS = 15 * 60 * 1000;
/** Log lines older than this are ignored when looking for fresh errors. */
const LOG_WINDOW_MS = 30 * 60 * 1000;
/** The concurrency the account holder has asked for. */
const TARGET_MIN_POSITIONS = 5;

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, info: 3 };

/**
 * What each refusal code MEANS and what FIXES it.
 *
 * `healthy: true` marks codes that are the bot working correctly - a fairly
 * priced market is not a fault, and reporting it as one is how thresholds end
 * up loosened into losing trades.
 */
const CODE_GUIDE = {
  "skipped:shard-unfunded": {
    severity: "high", title: "Orders refused - the market's exchange shard has no money",
    fix: "Move funds to that exchange at kalshi.com/account/exchange-indexes. Leave 'Disable balance management' OFF - it only covers app trades, not the bot.",
  },
  "unresolved:no-code-match": {
    severity: "medium", title: "Team not found on Kalshi's board for that date",
    fix: "Usually the market is not listed yet or has closed. If it persists for a team that IS on Kalshi, send the example to Claude.",
  },
  "unresolved:ambiguous-code": {
    severity: "high", title: "Two Kalshi team codes fit one team name - refused rather than guessed",
    fix: "Send the example to Claude - the code matcher needs a tie-breaker for this pair.",
  },
  "unresolved:city-only-match": {
    severity: "high", title: "Team matched on city name only - refused to avoid buying a same-city rival",
    fix: "Send the example to Claude.",
  },
  "unresolved:no-name-match": {
    severity: "medium", title: "Team name matched no Kalshi market",
    fix: "Send the example to Claude if the team is visibly listed on Kalshi.",
  },
  "unresolved:opponent-side-only": {
    severity: "medium", title: "Team only found as the opponent - no contract pays on it",
    fix: "Usually harmless. Send the example to Claude if it repeats for a team Kalshi does list.",
  },
  "unresolved:ambiguous-side": {
    severity: "medium", title: "Cannot tell which team a YES contract pays on",
    fix: "Send the example to Claude.",
  },
  "unresolved:wrong-date": {
    severity: "info", title: "Only an older or later fixture of this team is listed",
    fix: "Normally resolves once Kalshi lists the game.",
  },
  "unresolved:no-series": {
    severity: "info", title: "Kalshi has no market series for this competition",
    fix: "Not fixable in code - Kalshi does not list it.",
  },
  "unresolved:series-empty": {
    severity: "info", title: "Kalshi lists this competition but has no markets right now",
    fix: "Not a fault.",
  },
  "unresolved:none-tradeable": {
    severity: "info", title: "Kalshi's markets for this competition are all closed right now",
    fix: "Not a fault.",
  },
  "unresolved:fetch-failed": {
    severity: "high", title: "Could not read Kalshi's market list",
    fix: "Check Kalshi status and the API credentials in the app.",
  },
  "model-disagrees": {
    severity: "high", title: "In-play model vetoed live lines as stale",
    fix: "Known issue: the model counts the live score twice. Send the example to Claude - fix is designed, pending validation on live lines.",
  },
  "stale-quote": {
    severity: "medium", title: "Sharp quote too old to trust",
    fix: "Send the count to Claude - the live quote-age limit may need tightening or the odds feed is lagging.",
  },
  "no-quote-timestamp": {
    severity: "medium", title: "Odds feed sent no quote timestamp",
    fix: "Send the example to Claude.",
  },
  "edge-implausible": {
    severity: "medium", title: "Large edge blocked by the plausibility cap (18%)",
    fix: "Send the count and example to Claude - in thin markets real edges can exceed the cap.",
  },
  "live-scores-unavailable": {
    severity: "medium", title: "Live scores feed unavailable - in-play markets skipped",
    fix: "Usually transient. If it persists, check the odds API key and quota.",
  },
  "no-live-score-match": {
    severity: "medium", title: "Could not match a live score to the team",
    fix: "Send the example to Claude.",
  },
  "no-model-for-sport": {
    severity: "info", title: "No in-game model for this sport - in-play markets skipped",
    fix: "Pre-game markets in this sport still trade.",
  },
  "unmodellable": {
    severity: "medium", title: "Game state could not be modelled",
    fix: "Send the example to Claude.",
  },
  "odds-fetch-failed": {
    severity: "high", title: "Sharp odds feed failed",
    fix: "Check the odds API key and remaining quota in the app.",
  },
  "order-error": {
    severity: "high", title: "Kalshi rejected orders",
    fix: "Check the log line 'Entry order rejected' for Kalshi's exact reason.",
  },
  "scanner-error": {
    severity: "high", title: "A sport's scan crashed and was contained",
    fix: "Send the log line to Claude.",
  },
  "size-zero": {
    severity: "high", title: "Balance cannot afford a single contract",
    fix: "Check the balance on the market's exchange shard.",
  },
  "illiquid": {
    severity: "info", title: "Not enough resting size on the book",
    fix: "Not a fault.",
  },
  "no-fill": {
    severity: "medium", title: "Orders placed but nothing filled before they expired",
    fix: "The book moved before the order arrived. If frequent, send the count to Claude.",
  },
  "spread-too-wide": {
    severity: "info", title: "Order book too wide to trust the quote",
    fix: "Not a fault.",
  },
  "edge-too-small": {
    severity: "info", healthy: true, title: "Fairly priced - no edge worth the fee",
    fix: "Healthy. This is the bot correctly refusing a losing trade.",
  },
  "price-below-floor": { severity: "info", healthy: true, title: "Price under the floor", fix: "Healthy refusal." },
  "price-above-ceiling": { severity: "info", healthy: true, title: "Price over the ceiling", fix: "Healthy refusal." },
  "ev-too-thin": { severity: "info", healthy: true, title: "Expected value below the floor", fix: "Healthy refusal." },
  "no-lines-from-provider": { severity: "info", healthy: true, title: "No games on the board", fix: "Not a fault." },
  "dropped:duplicate": { severity: "info", healthy: true, title: "Already holding that game", fix: "Healthy." },
  "dropped:pregame": { severity: "info", healthy: true, title: "Game not started yet - the bot trades live games only", fix: "Healthy. It becomes eligible at first pitch / kickoff." },
  "clv-killed": { severity: "info", healthy: true, title: "Paused by the CLV kill switch - shadow-tracked, revives on its own", fix: "Healthy. The segment restarts automatically once its tracked prices recover." },
  "dropped:window": { severity: "info", healthy: true, title: "Game starts outside the entry window", fix: "Healthy - it becomes eligible closer to start." },
  "dropped:closed": { severity: "info", healthy: true, title: "Market not tradeable (closed or settled)", fix: "Not a fault." },
  "dropped:error": {
    severity: "medium", title: "Market data fetch failed",
    fix: "Usually transient. If it repeats, send the example to Claude.",
  },
  "dropped:live": {
    severity: "high", title: "Live games skipped - live trading is switched off",
    fix: "Turn live trading back on in the bot settings.",
  },
  "live-disabled": {
    severity: "high", title: "Live games skipped - live trading is switched off",
    fix: "Turn live trading back on in the bot settings.",
  },
  "no-price": {
    severity: "medium", title: "No usable price in the order book",
    fix: "Usually an empty book. If it repeats on busy markets, send the example to Claude.",
  },
  "unresolved:draw-or-tie": { severity: "info", healthy: true, title: "Draw/tie outcome - not a team market", fix: "Not a fault." },
  "unresolved:unusable-name": {
    severity: "medium", title: "Team name had no usable words to match",
    fix: "Send the example to Claude.",
  },
};

/** Market status tallies ("status:finalized" etc.) are board conditions, never faults. */
function guideFor(code) {
  if (CODE_GUIDE[code]) return CODE_GUIDE[code];
  if (code.startsWith("status:")) {
    return { severity: "info", healthy: true, title: `Market ${code.slice(7)}`, fix: "Not a fault." };
  }
  return null;
}

function problem(severity, code, title, evidence, fix) {
  return { severity, code, title, evidence: evidence ?? null, fix };
}

/**
 * Builds the full report from state and config. Pure read - pass state and
 * config in to test it against a real snapshot, or let it load them.
 */
export function diagnose({ state, config, now = Date.now() } = {}) {
  const problems = [];
  const healthy = [];
  let st, cfg;
  try { st = state || loadState(); } catch (err) {
    return { at: new Date(now).toISOString(), version: HEALTH_VERSION, summary: `Could not read state: ${err.message}`, problems: [], healthy: [] };
  }
  try { cfg = config || loadConfig(); } catch { cfg = {}; }

  const guard = (fn) => { try { fn(); } catch { /* one broken check must not hide the others */ } };

  // --- 1. Is the bot even running? -------------------------------------
  guard(() => {
    if (!st.running) {
      problems.push(problem("critical", "bot-stopped", "The bot is stopped",
        null, "Open the dashboard and tap Start Bot."));
    }
    if (st.haltedForDay) {
      problems.push(problem("critical", "halted-for-day", "Trading is halted for the day",
        st.haltReason || null,
        "The daily loss limit was hit. It clears automatically tomorrow; resume from the dashboard sooner if you choose."));
    }
    if (st.circuitBreakerOpen) {
      problems.push(problem("critical", "circuit-breaker", "The circuit breaker is open - trading stopped after repeated failures",
        st.circuitBreakerReason || null,
        "It resets itself once the exchange responds. If it stays open, send the reason to Claude."));
    }
  });

  // --- 2. Is it scanning? ------------------------------------------------
  const scans = st.lastScan || {};
  const rows = Object.entries(scans).map(([sportKey, r]) => ({ sportKey, ...r, t: Date.parse(r.at) }))
    .filter((r) => Number.isFinite(r.t));
  const newest = rows.reduce((m, r) => Math.max(m, r.t), 0);
  guard(() => {
    if (st.running && (!newest || now - newest > SCAN_STALE_MS)) {
      const age = newest ? `${Math.round((now - newest) / 60000)} min ago` : "never";
      problems.push(problem("critical", "not-scanning", "The bot is running but has stopped scanning",
        `Last scan: ${age}.`, "Restart the service in Railway. If it recurs, send the Railway log to Claude."));
    }
  });

  // --- 3. Why fresh scans refused what they saw --------------------------
  const fresh = rows.filter((r) => now - r.t <= SCAN_WINDOW_MS);
  const totals = {};
  const samples = {};
  let seen = 0, entered = 0;
  for (const r of fresh) {
    seen += r.seen || 0;
    entered += r.entered || 0;
    for (const [code, n] of Object.entries(r.reasons || {})) totals[code] = (totals[code] || 0) + n;
    for (const [code, ex] of Object.entries(r.samples || {})) if (!samples[code]) samples[code] = ex;
  }

  guard(() => {
    for (const [code, count] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
      const g = guideFor(code);
      if (!g) {
        problems.push(problem("medium", code, `Unrecognised refusal "${code}" x${count}`,
          samples[code] || null, "Send this to Claude - it is a code the report does not know yet."));
        continue;
      }
      const entry = { code, count, title: g.title, example: samples[code] || null, fix: g.fix };
      if (g.healthy || g.severity === "info") healthy.push(entry);
      else problems.push(problem(g.severity, code, `${g.title} (x${count})`, samples[code] || null, g.fix));
    }
  });

  // --- 4. Fresh errors in the log ----------------------------------------
  guard(() => {
    const log = Array.isArray(st.log) ? st.log : [];
    const recent = log.filter((l) => now - Date.parse(l.time) <= LOG_WINDOW_MS);
    const buckets = [
      { code: "log:order-rejected", re: /Entry order rejected/i, severity: "high",
        title: "Kalshi rejected entry orders", fix: "The example shows Kalshi's exact reason - send it to Claude if it is not a balance issue." },
      { code: "log:exit-stuck", re: /could not fully exit/i, severity: "critical",
        title: "A position could not be exited", fix: "Close it manually in the Kalshi app, then send the ticker to Claude." },
      { code: "log:cycle-failed", re: /Cycle failed/i, severity: "high",
        title: "Scan cycles are failing", fix: "Send the example to Claude." },
      { code: "log:shard", re: /holds no collateral|insufficient_shard_balance/i, severity: "high",
        title: "Orders hitting an unfunded exchange shard", fix: "Fund that exchange at kalshi.com/account/exchange-indexes." },
    ];
    for (const b of buckets) {
      const hits = recent.filter((l) => b.re.test(l.message || ""));
      if (!hits.length) continue;
      // Skip if the scan tally already reported the same thing - one alert per cause.
      if (b.code === "log:shard" && totals["skipped:shard-unfunded"]) continue;
      problems.push(problem(b.severity, b.code, `${b.title} (x${hits.length} in 30 min)`,
        String(hits[hits.length - 1].message).slice(0, 240), b.fix));
    }
  });

  // --- 5. Against the target: 5+ positions -------------------------------
  const open = (st.positions || []).length;
  guard(() => {
    if (st.running && open < TARGET_MIN_POSITIONS && fresh.length) {
      const blockers = problems.filter((p) => p.severity !== "info" && !["bot-stopped", "halted-for-day", "circuit-breaker", "not-scanning"].includes(p.code));
      const main = blockers.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0];
      const topHealthy = healthy.slice().sort((a, b) => b.count - a.count)[0];
      const why = main
        ? `Main blocker: ${main.title}`
        : topHealthy
          ? `Nothing is broken - the board is fairly priced right now (${topHealthy.title}, x${topHealthy.count}). More trades need more mispriced markets, not a lower bar.`
          : "No lines on the board in the last 15 minutes.";
      problems.push(problem(main ? "high" : "info", "below-target",
        `${open} open position(s) - below the ${TARGET_MIN_POSITIONS}-10 target`,
        `${seen} line(s) seen, ${entered} entered in the last 15 min across ${fresh.length} sport(s). ${why}`,
        main ? main.fix : "No action needed - the bot trades as soon as a line clears the fee."));
    }
  });

  problems.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const actionable = problems.filter((p) => p.severity !== "info");
  const crit = actionable.filter((p) => p.severity === "critical").length;

  const summary = actionable.length
    ? `${actionable.length} problem(s)${crit ? `, ${crit} critical` : ""}: ` +
      actionable.slice(0, 3).map((p) => p.title).join(" | ")
    : `No problems. ${open} open, ${entered} entered in the last 15 min. ` +
      (healthy.length ? `Refusals are all healthy (${healthy.map((h) => `${h.code} x${h.count}`).slice(0, 3).join(", ")}).` : "");

  return {
    at: new Date(now).toISOString(),
    version: HEALTH_VERSION,
    summary,
    openPositions: open,
    lastScanAgeSeconds: newest ? Math.round((now - newest) / 1000) : null,
    window: { seen, entered, sports: fresh.length },
    problems,
    healthy,
  };
}

// ---- Telegram push ------------------------------------------------------

const ALERT_EVERY_MS = 5 * 60 * 1000;
/** The same problem is not re-sent more often than this. */
const REALERT_AFTER_MS = 60 * 60 * 1000;
const lastSent = new Map();
let timer = null;

/**
 * Plain text, deliberately. Tickers, refusal codes and team names carry
 * hyphens, underscores and brackets; Telegram's Markdown mode rejects a whole
 * message over one unbalanced character, and a rejected alert is a silent one.
 */
async function sendTelegram(text) {
  const { botToken, chatId } = getTelegramCredentials();
  if (!botToken || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900), disable_web_page_preview: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function runHealthAlertOnce(now = Date.now()) {
  const report = diagnose({ now });
  const due = report.problems.filter((p) =>
    (p.severity === "critical" || p.severity === "high") &&
    (!lastSent.has(p.code) || now - lastSent.get(p.code) > REALERT_AFTER_MS));
  if (!due.length) return { sent: 0, report };

  const lines = [`Kalshi bot needs attention (${due.length}):`, ""];
  for (const p of due) {
    lines.push(`[${p.severity.toUpperCase()}] ${p.title}`);
    if (p.evidence) lines.push(`  e.g. ${String(p.evidence).slice(0, 200)}`);
    lines.push(`  Fix: ${p.fix}`);
    lines.push("");
  }
  lines.push(`${report.openPositions} open | ${report.window.entered} entered / ${report.window.seen} seen in 15 min`);

  const ok = await sendTelegram(lines.join("\n"));
  if (ok) for (const p of due) lastSent.set(p.code, now);
  return { sent: ok ? due.length : 0, report };
}

/** Starts the 5-minute check. Idempotent; never throws; never holds the process open. */
export function startHealthAlerts() {
  if (timer) return;
  const tick = () => { runHealthAlertOnce().catch(() => {}); };
  timer = setInterval(tick, ALERT_EVERY_MS);
  if (typeof timer.unref === "function") timer.unref();
  // First look two minutes after boot, once the first scans have landed.
  const first = setTimeout(tick, 2 * 60 * 1000);
  if (typeof first.unref === "function") first.unref();
}
