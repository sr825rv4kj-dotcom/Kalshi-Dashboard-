/**
 * strategyReview.js
 *
 * Turns the trade ledger into evidence you can tune on.
 *
 * Every entry already records the price it paid, the edge it thought it had,
 * why it entered and why it left. None of that was ever read back, so every
 * decision about thresholds came down to argument rather than results. This
 * groups completed round-trips along the dimensions the strategy actually has
 * knobs for, and reports realised ROI for each bucket.
 *
 * It states sample size next to every number and refuses to draw a conclusion
 * from a handful of trades. Ten trades is not evidence, and a panel that
 * implies otherwise is worse than no panel - it would have you tightening a
 * threshold because of one bad Sunday.
 */

import { getTradeLifecycles } from "./tradeLedgerStore.js";
import { loadState } from "./stateStore.js";

/** Below this, a bucket is reported but explicitly marked as not actionable. */
const MIN_SAMPLE = 10;

function emptyBucket(label, note = null) {
  return { label, note, n: 0, wins: 0, losses: 0, cost: 0, proceeds: 0, net: 0, roiPct: null };
}

function addTrade(bucket, t) {
  bucket.n += 1;
  if (t.netDollars > 0) bucket.wins += 1;
  else if (t.netDollars < 0) bucket.losses += 1;
  bucket.cost += t.costDollars || 0;
  bucket.proceeds += t.proceedsDollars || 0;
  bucket.net += t.netDollars || 0;
}

function finalize(bucket) {
  bucket.roiPct = bucket.cost > 0 ? (bucket.net / bucket.cost) * 100 : null;
  bucket.winRatePct = bucket.n ? (bucket.wins / bucket.n) * 100 : null;
  bucket.actionable = bucket.n >= MIN_SAMPLE;
  bucket.net = Number(bucket.net.toFixed(4));
  bucket.cost = Number(bucket.cost.toFixed(4));
  bucket.proceeds = Number(bucket.proceeds.toFixed(4));
  return bucket;
}

function group(trades, keyFn, order = null) {
  const map = new Map();
  for (const t of trades) {
    const key = keyFn(t);
    if (key == null) continue;
    if (!map.has(key)) map.set(key, emptyBucket(key));
    addTrade(map.get(key), t);
  }
  let rows = [...map.values()].map(finalize);
  if (order) {
    rows.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
  } else {
    rows.sort((a, b) => b.n - a.n);
  }
  return rows;
}

/** Entry price decides how much of the stake the whole-cent fee eats. */
const PRICE_BANDS = ["under 25c", "25-39c", "40-59c", "60-74c", "75-88c", "over 88c"];
function priceBand(cents) {
  if (cents == null) return null;
  if (cents < 25) return "under 25c";
  if (cents < 40) return "25-39c";
  if (cents < 60) return "40-59c";
  if (cents < 75) return "60-74c";
  if (cents <= 88) return "75-88c";
  return "over 88c";
}

const EDGE_BANDS = ["under 5%", "5-9%", "10-14%", "15-19%", "20%+"];
function edgeBand(edgePct) {
  const e = Number(edgePct);
  if (!Number.isFinite(e)) return null;
  if (e < 5) return "under 5%";
  if (e < 10) return "5-9%";
  if (e < 15) return "10-14%";
  if (e < 20) return "15-19%";
  return "20%+";
}

/**
 * Whether the bot was holding or bailing. This has turned out to be the single
 * most informative split, so it gets its own grouping rather than being buried
 * in a list of reasons.
 */
const HELD = new Set(["settled-win", "settled-loss", "settled-unknown"]);
function exitFamily(reason) {
  const r = String(reason || "").toLowerCase();
  if (HELD.has(r)) return "held to settlement";
  if (!r) return "unknown";
  return "exited early";
}

function timingOf(t) {
  const r = String(t.entryReason || "").toLowerCase();
  if (r.startsWith("in-play")) return "in-play";
  if (r.startsWith("pre-game")) return "pre-game";
  // Older ledger rows carry no marker, so fall back to the clock.
  if (t.commenceTime && t.entryTimestamp) {
    const start = Date.parse(t.commenceTime), entered = Date.parse(t.entryTimestamp);
    if (Number.isFinite(start) && Number.isFinite(entered)) {
      return entered >= start ? "in-play" : "pre-game";
    }
  }
  return "unknown";
}

/**
 * Plain-language readings of the strongest patterns present.
 *
 * Deliberately conservative: each one names its sample size, and anything
 * under MIN_SAMPLE is phrased as a hint rather than a finding.
 */
function observations({ byExitFamily, byPriceBand, byTiming, overall }) {
  const out = [];
  const pct = (v) => (v == null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

  const held = byExitFamily.find((b) => b.label === "held to settlement");
  const bailed = byExitFamily.find((b) => b.label === "exited early");
  if (held && bailed && held.n && bailed.n) {
    const gap = (held.roiPct ?? 0) - (bailed.roiPct ?? 0);
    out.push({
      strength: held.n >= MIN_SAMPLE && bailed.n >= MIN_SAMPLE ? "finding" : "hint",
      text:
        `Held to settlement: ${pct(held.roiPct)} ROI over ${held.n} trade(s). ` +
        `Exited early: ${pct(bailed.roiPct)} over ${bailed.n}. ` +
        (gap > 0
          ? `Holding is ahead by ${gap.toFixed(0)} points. Settlement costs no fee; every early exit pays one and crosses the spread.`
          : `Early exits are ahead here, which is worth watching - it is the opposite of what the fee maths predicts.`),
    });
  }

  const below = byPriceBand.find((b) => b.label === "under 25c");
  if (below && below.n) {
    out.push({
      strength: below.n >= MIN_SAMPLE ? "finding" : "hint",
      text:
        `Entries under 25c: ${pct(below.roiPct)} ROI over ${below.n} trade(s). ` +
        `These predate the 25c floor. At those prices the whole-cent fee is 20-40% of the stake, ` +
        `so the fee structure decides the outcome rather than the edge.`,
    });
  }

  const inplay = byTiming.find((b) => b.label === "in-play");
  const pregame = byTiming.find((b) => b.label === "pre-game");
  if (inplay && pregame && inplay.n && pregame.n) {
    const ip = inplay.roiPct ?? 0, pg = pregame.roiPct ?? 0;
    // The advice has to follow the data rather than an assumption about which
    // side is worse. Rendering this panel caught it telling the reader in-play
    // was lagging while the table above it showed in-play ahead by 58 points.
    const verdict = ip > pg
      ? `In-play is ahead by ${(ip - pg).toFixed(0)} points. If that holds up, there is room to LOOSEN ` +
        `maxModelDisagreementPoints and let more in-play markets through.`
      : `Pre-game is ahead by ${(pg - ip).toFixed(0)} points. If that holds up, TIGHTEN ` +
        `maxModelDisagreementPoints so more in-play lines are refused as stale.`;
    out.push({
      strength: inplay.n >= MIN_SAMPLE && pregame.n >= MIN_SAMPLE ? "finding" : "hint",
      text:
        `In-play: ${pct(inplay.roiPct)} over ${inplay.n}. Pre-game: ${pct(pregame.roiPct)} over ${pregame.n}. ` +
        verdict,
    });
  }

  if (overall.n < MIN_SAMPLE) {
    out.push({
      strength: "warning",
      text:
        `Only ${overall.n} completed trade(s) so far. Nothing here is a basis for changing a threshold yet - ` +
        `at this size a single game moves every number on the page. Around ${MIN_SAMPLE}+ per bucket, ` +
        `the comparisons start to mean something.`,
    });
  }

  return out;
}

/**
 * The last scan's refusal tally, flattened across sports and ordered by how
 * much each gate is actually blocking. This is the answer to "why isn't it
 * trading" - previously unanswerable without reading raw logs.
 */
const REASON_LABELS = {
  "dropped:live": "live trading disabled",
  "dropped:window": "outside the entry window",
  "dropped:unresolved": "no matching Kalshi market",
  "dropped:closed": "market not tradeable",
  "dropped:duplicate": "already holding that game",
  "dropped:error": "data fetch failed",
  "no-price": "no usable price in the book",
  "spread-too-wide": "book too wide to trust the quote",
  "price-below-floor": "price under the floor (fee would dominate)",
  "price-above-ceiling": "price over the ceiling (too little upside)",
  "edge-implausible": "edge too large to be real",
  "edge-too-small": "edge too small to clear the fee",
  "ev-too-thin": "expected value under the per-contract floor",
  "illiquid": "not enough resting size",
  "size-zero": "bankroll cannot afford a contract",
  "stale-quote": "sharp quote had gone stale",
  "no-quote-timestamp": "feed carried no quote timestamp",
  "model-disagrees": "sharp line contradicted the game state",
  "no-live-score-match": "could not match a live score to that team",
  "live-scores-unavailable": "live scores endpoint unavailable",
  "no-model-for-sport": "no in-game model for that sport",
  "unmodellable": "could not model the game state",
  "no-fill": "order placed but nothing filled",
  "skip-other": "other",
};

function lastScanSummary() {
  let scans = {};
  try { scans = loadState().lastScan || {}; } catch { return null; }
  const sports = Object.keys(scans);
  if (!sports.length) return null;

  const totals = {};
  let seen = 0, entered = 0, newest = null;
  for (const [sport, row] of Object.entries(scans)) {
    seen += row.seen || 0;
    entered += row.entered || 0;
    if (!newest || Date.parse(row.at) > Date.parse(newest)) newest = row.at;
    for (const [code, n] of Object.entries(row.reasons || {})) {
      totals[code] = (totals[code] || 0) + n;
    }
  }

  const blockers = Object.entries(totals)
    .map(([code, count]) => ({ code, count, label: REASON_LABELS[code] || code }))
    .sort((a, b) => b.count - a.count);

  return { at: newest, sports: sports.length, seen, entered, blockers };
}

export function buildStrategyReview() {
  const { completed, open } = getTradeLifecycles();

  const overall = finalize(
    completed.reduce((b, t) => { addTrade(b, t); return b; }, emptyBucket("all completed"))
  );

  const byExitFamily = group(completed, (t) => exitFamily(t.exitReason));
  const byExitReason = group(completed, (t) => String(t.exitReason || "unknown"));
  const byPriceBand = group(completed, (t) => priceBand(t.entryPriceCents), PRICE_BANDS);
  const byEdgeBand = group(completed, (t) => edgeBand(t.edgePct), EDGE_BANDS);
  const bySport = group(completed, (t) => t.sportKey || "unknown");
  const byTiming = group(completed, (t) => timingOf(t));

  const openExposure = open.reduce((s, t) => s + (t.costDollars || 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    minSample: MIN_SAMPLE,
    overall,
    open: { count: open.length, exposureDollars: Number(openExposure.toFixed(2)) },
    lastScan: lastScanSummary(),
    byExitFamily, byExitReason, byPriceBand, byEdgeBand, bySport, byTiming,
    observations: observations({ byExitFamily, byPriceBand, byTiming, overall }),
  };
}
