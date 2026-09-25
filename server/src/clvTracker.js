/**
 * clvTracker.js
 *
 * CLOSING LINE VALUE + AUTOMATIC KILL SWITCH (2026-09-24)
 *
 * Win/loss needs ~500 trades to say whether an edge is real. CLV says it in
 * ~50, because it measures the thing the edge actually is: did the market move
 * TOWARD the price the bot paid after it bought?
 *
 *     CLV (cents/contract) = Kalshi mid at the mark  -  price paid
 *
 * The mark is taken:
 *   - IN-PLAY:  clvLiveHorizonMinutes after the fill (default 5). The bot's
 *               in-play edge is Kalshi repricing slower than the sharp books;
 *               if that edge is real, the correction shows up within minutes.
 *   - PRE-GAME: at first pitch / kickoff - the textbook closing line.
 *
 * The mid is used, not the bid, so the half-spread the bot paid to cross is
 * INSIDE the number. A trade that bought at the ask and saw no move scores
 * minus half the spread, which is the truth about it.
 *
 * Every mark is a live Kalshi order book read. Nothing is estimated. A market
 * whose book is too wide to give a mid (clvMaxMarkSpreadCents) is retried for
 * 30 minutes and then dropped as unmarkable - it is never filled in.
 *
 * SEGMENTS. Every marked trade counts toward four segments:
 *     sport:<key>   timing:<live|pre>   band:<price band>   sportTiming:<key>|<live|pre>
 *
 * KILL. A segment with >= clvMinSample marks whose mean CLV is confidently
 * negative (mean + clvZ x standard error < clvKillBelowCents) stops trading.
 * Confidence matters: in-play prices are noisy, and killing on a raw mean would
 * park good segments on a bad hour.
 *
 * SHADOW. While a segment is killed, every candidate it would have taken is
 * still recorded at the real ask and marked against the real book later - no
 * money moves. When the shadow sample since the kill reaches clvMinSample with
 * mean CLV >= clvReviveAboveCents, the segment is revived automatically. So a
 * kill is never permanent and never needs a human.
 *
 * PROVEN. A sport whose real CLV is confidently POSITIVE (mean - clvZ x SE > 0)
 * is "proven". scanner.js sizes with Kelly only on proven sports; everything
 * else trades the flat survival stake even after the balance clears survival
 * mode. Bigger bets are earned per sport, by evidence.
 */

import fs from "fs";
import path from "path";
import { DATA_DIR } from "./paths.js";
import { kalshiGet } from "./kalshiClient.js";
import { appendLog } from "./stateStore.js";
import { getFair } from "./fairValue.js";

const V2 = "/trade-api/v2";
const CLV_PATH = path.join(DATA_DIR, "clv-ledger.json");

export const CLV_VERSION = "2026-09-24-clv-kill-switch";

const MAX_MARKED = 5000;
const MAX_PENDING = 400;
const UNMARKABLE_GRACE_MS = 30 * 60 * 1000;
const SHADOW_DEDUPE_MS = 30 * 60 * 1000;
const SETTLED = new Set(["finalized", "settled", "determined"]);

// --- storage -----------------------------------------------------------------

function emptyStore() {
  return { version: CLV_VERSION, pending: [], marked: [], kills: {}, parole: {}, registered: {}, dropped: {} };
}

let memo = null;

function load() {
  if (memo) return memo;
  try {
    const raw = JSON.parse(fs.readFileSync(CLV_PATH, "utf8"));
    memo = { ...emptyStore(), ...raw };
  } catch {
    memo = emptyStore();
  }
  return memo;
}

function save() {
  const s = load();
  if (s.marked.length > MAX_MARKED) s.marked = s.marked.slice(-MAX_MARKED);
  if (s.pending.length > MAX_PENDING) s.pending = s.pending.slice(-MAX_PENDING);
  // registered keys only need to outlive the pending window
  const keys = Object.keys(s.registered);
  if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 2000)) delete s.registered[k];
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${CLV_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, CLV_PATH);
  } catch (err) {
    console.error("[clv] save failed:", err.message);
  }
}

// --- helpers -----------------------------------------------------------------

export function priceBandOf(cents) {
  const c = Number(cents);
  if (!Number.isFinite(c)) return "unknown";
  if (c < 25) return "12-24c";
  if (c < 40) return "25-39c";
  if (c < 60) return "40-59c";
  if (c < 75) return "60-74c";
  return "75-95c";
}

export function segmentsFor({ sportKey, live, priceCents }) {
  const t = live ? "live" : "pre";
  const s = sportKey || "unknown";
  return [`sport:${s}`, `timing:${t}`, `band:${priceBandOf(priceCents)}`, `sportTiming:${s}|${t}`];
}

function isLiveEntry(openedAt, commenceTime) {
  const o = Date.parse(openedAt), c = Date.parse(commenceTime);
  if (!Number.isFinite(c)) return false;
  return (Number.isFinite(o) ? o : Date.now()) >= c;
}

function markTimeFor({ openedAt, commenceTime, live }, config) {
  const horizon = (config.clvLiveHorizonMinutes ?? 5) * 60 * 1000;
  const opened = Date.parse(openedAt) || Date.now();
  if (live) return opened + horizon;
  const start = Date.parse(commenceTime);
  if (!Number.isFinite(start)) return opened + horizon;
  return Math.max(opened + horizon, start - 60 * 1000);
}

function toCents(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n <= 1 ? n * 100 : n;
}

/** Best YES bid / ask from the live book, in cents. */
export async function bookQuote(ticker) {
  const book = await kalshiGet(`${V2}/markets/${ticker}/orderbook`);
  const ob = book?.orderbook_fp ?? book?.orderbook ?? book ?? {};
  const side = (prefix) => {
    for (const [k, v] of Object.entries(ob)) if (Array.isArray(v) && k.toLowerCase().startsWith(prefix)) return v;
    return [];
  };
  const best = (levels) => {
    let b = null;
    for (const lvl of levels) {
      const c = toCents(Array.isArray(lvl) ? lvl[0] : lvl?.price);
      if (c != null && (b == null || c > b)) b = c;
    }
    return b;
  };
  const bid = best(side("yes"));
  const noBid = best(side("no"));
  const ask = noBid != null && noBid < 100 ? 100 - noBid : null;
  return { bid, ask, spread: bid != null && ask != null ? ask - bid : null };
}

function stats(values) {
  const n = values.length;
  if (!n) return { n: 0, mean: null, sd: null, se: null };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : null;
  const se = sd != null ? sd / Math.sqrt(n) : null;
  return { n, mean, sd, se };
}

function round(v, d = 2) {
  return v == null ? null : Number(v.toFixed(d));
}

// --- intake ------------------------------------------------------------------

/**
 * Registers every open position that is not yet tracked. Runs each cycle, so
 * taker fills, resting-bid (maker) fills and anything else that lands in
 * state.positions are all covered without touching the code that created them.
 */
export function registerOpenPositions(positions, config) {
  const s = load();
  let added = 0;
  for (const p of positions || []) {
    const key = `${p.ticker}|${p.openedAt}`;
    if (s.registered[key]) continue;
    const live = isLiveEntry(p.openedAt, p.commenceTime);
    const markAt = markTimeFor({ openedAt: p.openedAt, commenceTime: p.commenceTime, live }, config);
    s.registered[key] = true;
    // Opened long before this build was watching: a mark taken now would be at
    // the wrong horizon. Those are marked by the candlestick backfill instead.
    if (Date.now() > markAt + 10 * 60 * 1000) continue;
    const fair = getFair(p.sportKey, p.teamName);
    s.pending.push({
      id: key, kind: "real", source: p.source ?? "taker",
      ticker: p.ticker, sportKey: p.sportKey ?? null, teamName: p.teamName ?? null,
      entryPriceCents: p.entryPriceCents, contracts: p.contracts,
      openedAt: p.openedAt, commenceTime: p.commenceTime ?? null, live,
      fairCents: fair ? round(fair.prob * 100, 1) : null,
      markAt,
    });
    added++;
  }
  if (added) save();
  return added;
}

/** A candidate a killed segment refused. Marked later against the real book. */
export function recordShadow({ ticker, sportKey, teamName, askCents, trueProbability, commenceTime, live }, config) {
  const s = load();
  const now = Date.now();
  const dup = s.pending.some((r) => r.kind === "shadow" && r.ticker === ticker && now - Date.parse(r.openedAt) < SHADOW_DEDUPE_MS);
  if (dup) return false;
  const openedAt = new Date(now).toISOString();
  s.pending.push({
    id: `shadow|${ticker}|${openedAt}`, kind: "shadow", source: "shadow",
    ticker, sportKey, teamName, entryPriceCents: askCents, contracts: 0,
    openedAt, commenceTime: commenceTime ?? null, live: !!live,
    fairCents: trueProbability != null ? round(trueProbability * 100, 1) : null,
    markAt: markTimeFor({ openedAt, commenceTime, live }, config),
  });
  save();
  return true;
}

// --- marking -----------------------------------------------------------------

/**
 * Marks every pending row whose time has come, against the live book.
 * Bounded per call so a backlog can never stall a cycle. Never throws.
 */
export async function markDue(config) {
  const s = load();
  const now = Date.now();
  const due = s.pending.filter((r) => r.markAt <= now).slice(0, config.clvMarksPerCycle ?? 20);
  if (!due.length) return { marked: 0, dropped: 0 };

  const maxSpread = config.clvMaxMarkSpreadCents ?? 10;
  let marked = 0, dropped = 0;
  const done = new Set();

  for (const r of due) {
    try {
      const m = await kalshiGet(`${V2}/markets/${r.ticker}`);
      const status = String(m?.market?.status || "").toLowerCase();
      const result = String(m?.market?.result || "").toLowerCase();
      if (SETTLED.has(status) || result === "yes" || result === "no") {
        // Settled before the mark: the outcome is not a closing line.
        s.dropped["settled-before-mark"] = (s.dropped["settled-before-mark"] || 0) + 1;
        done.add(r.id); dropped++;
        continue;
      }

      const q = await bookQuote(r.ticker);
      if (q.bid == null || q.ask == null || q.spread > maxSpread) {
        if (now - r.markAt > UNMARKABLE_GRACE_MS) {
          s.dropped.unmarkable = (s.dropped.unmarkable || 0) + 1;
          done.add(r.id); dropped++;
        }
        continue;
      }

      const mid = (q.bid + q.ask) / 2;
      s.marked.push({
        ...r, markAt: undefined,
        markedAt: new Date(now).toISOString(),
        markBid: q.bid, markAsk: q.ask, markCents: mid,
        clvCents: round(mid - r.entryPriceCents, 2),
        segments: segmentsFor({ sportKey: r.sportKey, live: r.live, priceCents: r.entryPriceCents }),
      });
      done.add(r.id); marked++;
    } catch {
      // network hiccup - retried next cycle, dropped only by the grace rule
      if (now - r.markAt > UNMARKABLE_GRACE_MS * 4) {
        s.dropped["read-failed"] = (s.dropped["read-failed"] || 0) + 1;
        done.add(r.id); dropped++;
      }
    }
  }

  s.pending = s.pending.filter((r) => !done.has(r.id));
  save();
  if (marked) evaluate(config);
  return { marked, dropped };
}

// --- verdicts ----------------------------------------------------------------

function settings(config = {}) {
  return {
    enabled: config.clvKillSwitch !== false,
    minSample: config.clvMinSample ?? 15,
    z: config.clvZ ?? 1.0,
    killBelow: config.clvKillBelowCents ?? 0,
    reviveAbove: config.clvReviveAboveCents ?? 0,
  };
}

/** Real marks for a segment, counting only those after its last parole. */
function realValues(s, seg) {
  const since = s.parole[seg] ? Date.parse(s.parole[seg]) : 0;
  return s.marked
    .filter((r) => r.kind === "real" && r.segments?.includes(seg) && Date.parse(r.openedAt) > since)
    .map((r) => r.clvCents);
}

function shadowValuesSince(s, seg, sinceIso) {
  const since = Date.parse(sinceIso) || 0;
  return s.marked
    .filter((r) => r.segments?.includes(seg) && Date.parse(r.openedAt) > since)
    .map((r) => r.clvCents);
}

/** Recomputes kills and revivals. Logs every change. */
export function evaluate(config) {
  const s = load();
  const cfg = settings(config);
  const segs = new Set();
  for (const r of s.marked) for (const g of r.segments || []) segs.add(g);
  const changes = [];

  for (const seg of segs) {
    if (s.kills[seg]) {
      const st = stats(shadowValuesSince(s, seg, s.kills[seg].killedAt));
      if (st.n >= cfg.minSample && st.mean >= cfg.reviveAbove) {
        changes.push(`REVIVED ${seg}: ${st.n} marks since the kill average ${st.mean >= 0 ? "+" : ""}${st.mean.toFixed(2)}c`);
        delete s.kills[seg];
        s.parole[seg] = new Date().toISOString();
      }
      continue;
    }
    const st = stats(realValues(s, seg));
    // A cross-sport segment (band / timing) is only killed on cross-sport
    // evidence. If one sport is most of its sample, that sport's own segment
    // does the killing - MLB must not take NFL's 40-59c trades down with it.
    if (seg.startsWith("band:") || seg.startsWith("timing:")) {
      const since = s.parole[seg] ? Date.parse(s.parole[seg]) : 0;
      const rows = s.marked.filter((r) => r.kind === "real" && r.segments?.includes(seg) && Date.parse(r.openedAt) > since);
      const bySport = {};
      for (const r of rows) bySport[r.sportKey] = (bySport[r.sportKey] || 0) + 1;
      const top = Math.max(0, ...Object.values(bySport));
      if (rows.length && top / rows.length > 0.6) continue;
    }
    if (st.n >= cfg.minSample && st.se != null && st.mean + cfg.z * st.se < cfg.killBelow) {
      s.kills[seg] = {
        killedAt: new Date().toISOString(),
        n: st.n, meanCents: round(st.mean), seCents: round(st.se),
      };
      changes.push(`KILLED ${seg}: mean CLV ${st.mean.toFixed(2)}c +/- ${st.se.toFixed(2)}c over ${st.n} trades`);
    }
  }

  if (changes.length) {
    save();
    for (const c of changes) {
      try { appendLog(`CLV ${c}${cfg.enabled ? "" : " (kill switch disabled - not enforced)"}`, c.startsWith("KILLED") ? "warn" : "info"); } catch { /* ignore */ }
    }
  }
  return changes;
}

/**
 * The scanner's question: may this trade happen, and at what size?
 *   { killed: bool, killedBy: seg|null, proven: bool, provenBy: stats|null }
 */
export function clvVerdict({ sportKey, live, priceCents }, config) {
  const s = load();
  const cfg = settings(config);
  const segs = segmentsFor({ sportKey, live, priceCents });
  const killedBy = cfg.enabled ? segs.find((g) => s.kills[g]) || null : null;

  const st = stats(realValues(s, `sport:${sportKey || "unknown"}`));
  const proven = st.n >= cfg.minSample && st.se != null && st.mean - cfg.z * st.se > 0;
  return { killed: !!killedBy, killedBy, proven, sportStats: { n: st.n, mean: round(st.mean), se: round(st.se) } };
}

// --- backfill ----------------------------------------------------------------

function candleValue(side) {
  if (!side || typeof side !== "object") return null;
  const c = side.close ?? null;
  if (c != null && Number.isFinite(Number(c))) return toCents(c);
  if (side.close_dollars != null) return toCents(Number(side.close_dollars));
  return null;
}

/**
 * Marks HISTORICAL trades from Kalshi's own one-minute candlesticks, so the
 * kill switch starts with the account's real record instead of zero.
 *
 * Every mark comes from Kalshi's candle at the mark minute. A trade whose
 * candles cannot be read, or whose candle has no bid and ask, is reported as
 * skipped with the reason - never estimated. The response carries the raw key
 * shape of the first candle so a format change is visible immediately.
 */
export async function backfillFromLedger(entries, config) {
  const s = load();
  const have = new Set([...s.marked.map((r) => r.id), ...s.pending.map((r) => r.id)]);
  // The live path keys a trade by the position's openedAt, the ledger by its
  // own timestamp - milliseconds apart. Match on ticker + time so a trade is
  // never counted twice.
  const tracked = [...s.marked, ...s.pending].filter((r) => r.kind === "real");
  const alreadyTracked = (ticker, iso) => {
    const t = Date.parse(iso);
    return tracked.some((r) => r.ticker === ticker && Math.abs(Date.parse(r.openedAt) - t) < 120 * 1000);
  };
  const out ={ considered: 0, marked: 0, skipped: {}, sampleCandleKeys: null, examples: [] };
  const skip = (why) => { out.skipped[why] = (out.skipped[why] || 0) + 1; };
  const maxSpread = config.clvMaxMarkSpreadCents ?? 10;

  for (const e of entries) {
    if (!(e.filled > 0) || !e.ticker || !e.timestamp) continue;
    const id = `${e.ticker}|${e.timestamp}`;
    if (have.has(id) || alreadyTracked(e.ticker, e.timestamp)) { skip("already tracked"); continue; }
    out.considered++;

    const live = isLiveEntry(e.timestamp, e.commenceTime);
    const markAt = markTimeFor({ openedAt: e.timestamp, commenceTime: e.commenceTime, live }, config);
    if (markAt > Date.now()) { skip("mark time not reached"); continue; }

    const series = String(e.ticker).split("-")[0];
    const startTs = Math.floor(markAt / 1000) - 120;
    const endTs = Math.floor(markAt / 1000) + 600;
    let res;
    try {
      res = await kalshiGet(
        `${V2}/series/${series}/markets/${e.ticker}/candlesticks`,
        `?start_ts=${startTs}&end_ts=${endTs}&period_interval=1`
      );
    } catch (err) {
      skip(`candles unreadable (${String(err.message).slice(0, 60)})`);
      continue;
    }
    const candles = res?.candlesticks || [];
    if (!out.sampleCandleKeys && candles[0]) {
      out.sampleCandleKeys = {
        top: Object.keys(candles[0]),
        yes_bid: candles[0].yes_bid ? Object.keys(candles[0].yes_bid) : null,
      };
    }
    const at = candles.find((c) => Number(c.end_period_ts) * 1000 >= markAt) || candles[candles.length - 1];
    if (!at) { skip("no candles in the mark window"); continue; }
    const bid = candleValue(at.yes_bid);
    const ask = candleValue(at.yes_ask);
    if (bid == null || ask == null) { skip("candle has no bid/ask"); continue; }
    if (ask - bid > maxSpread) { skip("book too wide at the mark"); continue; }

    const mid = (bid + ask) / 2;
    const fairMatch = /sharp ([\d.]+)%/.exec(String(e.reason || ""));
    const row = {
      id, kind: "real", source: "backfill",
      ticker: e.ticker, sportKey: e.sportKey ?? null, teamName: e.teamName ?? null,
      entryPriceCents: e.priceCents, contracts: e.filled,
      openedAt: e.timestamp, commenceTime: e.commenceTime ?? null, live,
      fairCents: fairMatch ? Number(fairMatch[1]) : null,
      markedAt: new Date(Number(at.end_period_ts) * 1000).toISOString(),
      markBid: bid, markAsk: ask, markCents: mid,
      clvCents: round(mid - e.priceCents, 2),
      segments: segmentsFor({ sportKey: e.sportKey, live, priceCents: e.priceCents }),
    };
    s.marked.push(row);
    tracked.push(row);
    have.add(id);
    out.marked++;
    if (out.examples.length < 5) {
      out.examples.push(`${e.ticker}: paid ${e.priceCents}c, mid ${mid}c at the mark -> CLV ${row.clvCents >= 0 ? "+" : ""}${row.clvCents}c`);
    }
  }
  s.marked.sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
  s.backfilledAt = new Date().toISOString();
  s.lastBackfill = { marked: out.marked, considered: out.considered, skipped: out.skipped, sampleCandleKeys: out.sampleCandleKeys };
  save();
  out.changes = evaluate(config);
  return out;
}

// --- report ------------------------------------------------------------------

export function clvReport(config) {
  const s = load();
  const cfg = settings(config);
  const segs = new Map();
  for (const r of s.marked) {
    for (const g of r.segments || []) {
      if (!segs.has(g)) segs.set(g, []);
      if (r.kind === "real") segs.get(g).push(r.clvCents);
    }
  }
  const rows = [...segs.entries()].map(([seg, vals]) => {
    const st = stats(vals);
    const lo = st.se != null ? st.mean - cfg.z * st.se : null;
    const hi = st.se != null ? st.mean + cfg.z * st.se : null;
    return {
      segment: seg, n: st.n, meanCents: round(st.mean), seCents: round(st.se),
      status: s.kills[seg] ? "KILLED"
        : st.n < cfg.minSample ? "collecting"
        : lo > 0 ? "PROVEN"
        : hi < cfg.killBelow ? "negative"
        : "neutral",
    };
  }).sort((a, b) => a.segment.localeCompare(b.segment));

  const real = s.marked.filter((r) => r.kind === "real");
  const all = stats(real.map((r) => r.clvCents));
  return {
    version: CLV_VERSION,
    settings: cfg,
    overall: { n: all.n, meanCents: round(all.mean), seCents: round(all.se) },
    pending: { real: s.pending.filter((r) => r.kind === "real").length, shadow: s.pending.filter((r) => r.kind === "shadow").length },
    kills: s.kills,
    dropped: s.dropped,
    backfill: s.backfilledAt ? { at: s.backfilledAt, ...(s.lastBackfill || {}) } : null,
    segments: rows,
    recent: s.marked.slice(-15).reverse().map((r) => ({
      ticker: r.ticker, kind: r.kind, source: r.source, live: r.live,
      paid: r.entryPriceCents, mark: r.markCents, clv: r.clvCents, at: r.markedAt,
    })),
  };
}

/** True until the first candlestick backfill has run on this volume. */
export function needsBackfill() {
  return !load().backfilledAt;
}

/** Clears one kill by hand (or all with seg = "*"). */
export function clearKill(seg) {
  const s = load();
  const cleared = [];
  for (const k of Object.keys(s.kills)) {
    if (seg === "*" || k === seg) {
      delete s.kills[k];
      s.parole[k] = new Date().toISOString();
      cleared.push(k);
    }
  }
  save();
  return cleared;
}
