/**
 * tradeCounter.js  (2026-10-06)
 *
 * THE BOT'S DAILY COUNTER - how hard it is working and what it is getting.
 *
 * Counts, for the trading day (Pacific, same day as the daily halt):
 *   - scans run and the sports they covered
 *   - markets priced, and every refusal by reason (the day's top blockers)
 *   - trades entered, by exchange and by lane (dip / middle / favorite), and
 *     which were PROBATION trades (see outcomeLearner.js)
 * and compares trades entered with a daily pace target.
 *
 * THE PACE IS WHAT THE BOT ADJUSTS ON. Behind pace, the outcome learner lets
 * an area it has blocked take one half-stake probation trade a day, so a block
 * can be re-tested instead of lasting forever. On pace, blocks hold. Nothing
 * else is loosened: the price floors, the lanes and the minimum returns stay
 * exactly as set.
 *
 *   pace.targetPerDay   Kalshi entries a day to aim for (default 5)
 *   pace.startHour      Pacific hour the day's pace starts counting (default 6)
 *   pace.endHour        Pacific hour it should be met by (default 23)
 *
 * Entries are read from the trade ledger (every fill, taker or resting bid),
 * so nothing is missed; the lane comes from the scanner at the moment it buys.
 * Counters live in DATA_DIR/trade-counter.json, written atomically.
 */

import fs from "fs";
import path from "path";
import { DATA_DIR } from "./paths.js";
import { atomicWriteFileSync, tradingDay } from "./stateStore.js";
import { loadLedger } from "./tradeLedgerStore.js";

export const TRADE_COUNTER_VERSION = "2026-10-06-trade-counter";

const FILE = path.join(DATA_DIR, "trade-counter.json");
const FLUSH_MS = 30 * 1000;

let mem = null;
let dirty = false;
let lastFlush = 0;

function fresh(day) {
  return { day, scans: 0, sports: {}, seen: 0, refusals: {}, lanes: {}, probation: [] };
}

function load() {
  const today = tradingDay();
  if (mem && mem.day === today) return mem;
  if (!mem) {
    try {
      const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
      if (saved && saved.day === today) { mem = saved; return mem; }
    } catch { /* first run or unreadable - start the day fresh */ }
  }
  mem = fresh(today);
  dirty = true;
  return mem;
}

function flush(force = false) {
  if (!dirty) return;
  if (!force && Date.now() - lastFlush < FLUSH_MS) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    atomicWriteFileSync(FILE, JSON.stringify(mem));
    dirty = false;
    lastFlush = Date.now();
  } catch { /* counting must never stop trading */ }
}

/** One sport scan finished (scanner.recordScanTally). */
export function countScan(sportKey, tally = {}, seen = 0) {
  try {
    const c = load();
    c.scans += 1;
    c.sports[sportKey] = (c.sports[sportKey] || 0) + 1;
    c.seen += Number(seen) || 0;
    for (const [code, n] of Object.entries(tally || {})) {
      c.refusals[code] = (c.refusals[code] || 0) + (Number(n) || 0);
    }
    dirty = true;
    flush();
  } catch { /* never throws into the scan */ }
}

/** The scanner bought: remember which lane, and whether it was a probation trade. */
export function countEntry({ ticker, lane, probation = false, segment = null } = {}) {
  try {
    const c = load();
    if (ticker) c.lanes[ticker] = lane || "?";
    if (probation) c.probation.push({ at: new Date().toISOString(), ticker, segment });
    dirty = true;
    flush(true);
  } catch { /* never throws */ }
}

/** Probation trades already taken today for a segment (outcomeLearner.js). */
export function probationUsedToday(segment) {
  try { return load().probation.filter((p) => p.segment === segment).length; } catch { return 0; }
}

function pacificHour(d = new Date()) {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric", hour12: false })
    .formatToParts(d).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
  return (Number(h.hour) % 24) + Number(h.minute) / 60;
}

export function paceSettings(config = {}) {
  const p = config.pace && typeof config.pace === "object" ? config.pace : {};
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return { targetPerDay: n(p.targetPerDay, 5), startHour: n(p.startHour, 6), endHour: n(p.endHour, 23) };
}

/** Today's ledger entries, newest first. */
function entriesToday() {
  const today = tradingDay();
  let ledger = [];
  try { ledger = loadLedger(); } catch { ledger = []; }
  return ledger
    .filter((t) => t.action === "enter" && Number(t.filled) > 0 && t.timestamp && tradingDay(new Date(t.timestamp)) === today)
    .map((t) => ({
      at: t.timestamp,
      venue: String(t.ticker || "").startsWith("PM:") ? "polymarket" : "kalshi",
      ticker: t.ticker, team: t.teamName, sportKey: t.sportKey,
      priceCents: t.priceCents, contracts: t.filled,
      maker: t.maker === true || /as MAKER|Resting bid filled/i.test(String(t.reason || "")),
    }))
    .reverse();
}

/** Pure: where the day stands against the pace target. */
export function paceFrom(kalshiEntries, settings, hourNow) {
  const { targetPerDay, startHour, endHour } = settings;
  const span = Math.max(1, endHour - startHour);
  const frac = Math.min(1, Math.max(0, (hourNow - startHour) / span));
  const expectedByNow = Math.floor(targetPerDay * frac);
  const behind = targetPerDay > 0 && kalshiEntries < expectedByNow;
  return {
    targetPerDay, expectedByNow, entered: kalshiEntries, behind,
    status: targetPerDay <= 0 ? "off" : behind ? "behind" : kalshiEntries >= targetPerDay ? "target met" : "on pace",
  };
}

/** Is the bot behind today's pace? (outcomeLearner.js asks this before allowing probation.) */
export function behindPace(config = {}) {
  try {
    const k = entriesToday().filter((e) => e.venue === "kalshi").length;
    return paceFrom(k, paceSettings(config), pacificHour()).behind;
  } catch { return false; }
}

const CODE_WORDS = {
  "no-lines-from-provider": "no games on the odds feed",
  "dropped:window": "game not inside the entry window",
  "no-lane": "price fits no lane (outside 35-92c / under 65% to win)",
  "edge-too-small": "fairly priced - no edge after fees",
  "learned-block": "blocked by the learner",
  "learned-probation": "learner probation trade",
  "model-priced": "betting line stale - priced on the score model",
  "dropped:duplicate": "already holding that game",
  "skipped:shard-unfunded": "Kalshi rejected - funds on another exchange shard",
};

/** For the System tab and the monitor. */
export function tradeCounterReport(config = {}) {
  const c = load();
  flush();
  const entries = entriesToday();
  const kalshi = entries.filter((e) => e.venue === "kalshi");
  const pm = entries.filter((e) => e.venue === "polymarket");
  const byLane = {};
  for (const e of kalshi) {
    const lane = c.lanes[e.ticker] || (e.maker ? "resting bid" : "unrecorded");
    byLane[lane] = (byLane[lane] || 0) + 1;
  }
  const settings = paceSettings(config);
  const pace = paceFrom(kalshi.length, settings, pacificHour());
  const blockers = Object.entries(c.refusals)
    .filter(([code]) => code !== "no-lines-from-provider")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([code, n]) => ({ code, count: n, label: CODE_WORDS[code] || code }));
  return {
    version: TRADE_COUNTER_VERSION,
    day: c.day,
    scans: c.scans,
    sportsScanned: Object.keys(c.sports).length,
    marketsPriced: c.seen,
    entered: { kalshi: kalshi.length, polymarket: pm.length, total: entries.length },
    byLane,
    probationToday: c.probation,
    pace: {
      ...pace,
      adjustment: pace.behind
        ? "Behind pace: areas the learner blocked may take one half-stake probation trade today each."
        : "On pace: learner blocks hold. Floors, lanes and minimum returns are never loosened by the pace.",
    },
    blockers,
    entries: entries.slice(0, 20),
  };
}

export function registerTradeCounterRoutes(app, loadConfig) {
  app.get("/api/trade-counter", (_req, res) => {
    try {
      res.json(tradeCounterReport(loadConfig ? loadConfig() : {}));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
