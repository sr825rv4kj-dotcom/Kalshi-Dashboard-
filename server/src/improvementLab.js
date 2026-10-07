/**
 * improvementLab.js  (2026-10-06)
 *
 * WHAT NEEDS IMPROVEMENT - the app reads its own closed trades and says, in
 * plain words, where it is losing and what it would have done better there.
 *
 * The outcome learner (outcomeLearner.js) can only CUT: a sport or price band
 * that clearly underperforms is skipped. This module looks for a DIFFERENT WAY
 * to play each losing area instead, and tests every alternative against the
 * trades the account actually made:
 *
 *   other-side     bet the opposing side in the same games. Only trades held to
 *                  settlement are used (their result is known). The other side
 *                  is priced at 100 - entry + 1c (the 1c is the spread, so the
 *                  estimate errs against the idea), same dollar stake, the
 *                  venue's own fee (Kalshi 0.07, Polymarket 0.0695 x C x p(1-p)).
 *   price-range    keep only the price ranges of this area that made money.
 *   timing         in-play only, or pre-game only.
 *   sell-early     how this area's early exits did against holding to the end.
 *                  Shown as evidence only - the mid-game price a held trade could
 *                  have sold at was never recorded, so it cannot be replayed.
 *   pause          stop trading the area (net 0).
 *
 * Every figure is computed from recorded fills. Nothing is simulated or
 * estimated except the opposite side's price, and that assumption is stated
 * on every row that uses it.
 *
 * SAMPLE SIZE. An area is judged by how far its wins fall from what its prices
 * implied (a 40c contract should win 40% of the time). The gap in standard
 * deviations is shown beside every finding:
 *   under 10 trades  "too few trades to judge"
 *   under 1 sd       "could be luck"
 *   1 - 2 sd         "leaning real"
 *   2 sd or more     "strong evidence"
 * A recommendation built on a price range picked from the same trades it is
 * scored on is marked "in-sample" - it describes the past, it is not proof.
 *
 * Read-only: this module never changes a setting or places an order.
 */

import { getTradeLifecycles } from "./tradeLedgerStore.js";

export const IMPROVEMENT_VERSION = "2026-10-06-improvement-lab";

const FEE = { kalshi: 0.07, polymarket: 0.0695 };
const MIN_AREA_TRADES = 6;
const MIN_ALT_TRADES = 5;
const SPREAD_CENTS = 1;
const MIRROR_WINDOW_MS = 30 * 60 * 1000;

/* ----------------------------- small helpers ----------------------------- */

const round2 = (n) => Math.round(Number(n) * 100) / 100;

export function bandOf(cents) {
  const c = Number(cents);
  if (c < 25) return "under 25c";
  if (c < 35) return "25-34c";
  if (c < 50) return "35-49c";
  if (c < 70) return "50-69c";
  return "70c+";
}
const BAND_ORDER = ["under 25c", "25-34c", "35-49c", "50-69c", "70c+"];

const SPORT_NAMES = {
  americanfootball_nfl: "NFL", americanfootball_ncaaf: "NCAAF", americanfootball_cfl: "CFL",
  baseball_mlb: "MLB", baseball_kbo: "KBO", baseball_npb: "NPB",
  basketball_nba: "NBA", basketball_wnba: "WNBA", basketball_euroleague: "EuroLeague", basketball_nbl: "NBL",
  icehockey_nhl: "NHL", icehockey_nhl_preseason: "NHL preseason", icehockey_liiga: "Liiga",
  icehockey_sweden_hockey_league: "SHL", mma_mixed_martial_arts: "MMA",
};
export function sportName(key) {
  const k = String(key || "unknown");
  if (SPORT_NAMES[k]) return SPORT_NAMES[k];
  if (k.startsWith("tennis_")) return `Tennis (${k.replace(/^tennis_/, "").replace(/_/g, " ")})`;
  if (k.startsWith("soccer_")) return `Soccer (${k.replace(/^soccer_/, "").replace(/_/g, " ")})`;
  return k.replace(/_/g, " ");
}
const venueName = (v) => (v === "polymarket" ? "Polymarket" : v === "kalshi" ? "Kalshi" : "Both exchanges");

function feeDollars(venue, contracts, priceCents) {
  const p = Number(priceCents) / 100;
  if (!(p > 0 && p < 1) || !(contracts > 0)) return 0;
  return Math.ceil(Math.round((FEE[venue] ?? FEE.kalshi) * contracts * p * (1 - p) * 100 * 1e9) / 1e9) / 100;
}

const normTeam = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

/* ------------------------------ trade rows ------------------------------- */

/**
 * One row per closed trade in the shape the analysis uses. Accepts the
 * ledger's lifecycle objects (getTradeLifecycles().completed).
 */
export function rowsFromLifecycles(completed) {
  return (completed || [])
    .filter((t) => Number.isFinite(Number(t.netDollars)) && Number.isFinite(Number(t.entryPriceCents)) && Number(t.contracts) > 0)
    .map((t) => ({
      venue: String(t.ticker || "").startsWith("PM:") ? "polymarket" : "kalshi",
      sport: t.sportKey || "unknown",
      team: t.teamName || "",
      entryCents: Number(t.entryPriceCents),
      contracts: Number(t.contracts),
      cost: Number(t.costDollars) || (Number(t.contracts) * Number(t.entryPriceCents)) / 100,
      net: Number(t.netDollars),
      fees: Number(t.feesDollars) || 0,
      exit: String(t.exitReason || ""),
      live: /In-play/i.test(String(t.entryReason || "")),
      opened: t.entryTimestamp,
      closed: t.exitTimestamp,
    }));
}

const won = (r) => r.net > 0;
const heldToEnd = (r) => /^settled/.test(r.exit) && !r.exit.includes("+");

/* ------------------------------- statistics ------------------------------ */

export function tally(rows) {
  let wins = 0, expected = 0, variance = 0, net = 0, cost = 0, fees = 0;
  for (const r of rows) {
    const p = r.entryCents / 100;
    wins += won(r) ? 1 : 0;
    expected += p;
    variance += p * (1 - p);
    net += r.net;
    cost += r.cost;
    fees += r.fees;
  }
  const sd = Math.sqrt(variance);
  const z = rows.length && sd > 0 ? (wins - expected) / sd : 0;
  return {
    trades: rows.length, wins, losses: rows.length - wins,
    expectedWins: round2(expected), z: round2(z),
    net: round2(net), cost: round2(cost), fees: round2(fees),
    roiPct: cost > 0 ? round2((net / cost) * 100) : null,
    evidence: evidenceOf(rows.length, z),
  };
}

export function evidenceOf(n, z) {
  const zz = Number(z) || 0;
  const a = Math.abs(zz);
  if (n < 10) return "too few trades to judge";
  if (a < 1) return "could be luck";
  const side = zz < 0 ? "wins less often than priced" : "wins more often than priced";
  return `${a < 2 ? "leaning real" : "strong evidence"} - ${side}`;
}

/* ----------------------------- alternatives ------------------------------ */

/** Opposite side, same games, same dollar stake. Held-to-settlement trades only. */
function altOtherSide(rows) {
  const used = rows.filter(heldToEnd);
  if (used.length < MIN_ALT_TRADES) return null;
  let net = 0, wins = 0, actual = 0;
  for (const r of used) {
    const q = Math.min(99, 100 - r.entryCents + SPREAD_CENTS);
    const stake = (r.contracts * r.entryCents) / 100;
    const n = Math.max(1, Math.floor((stake * 100) / q));
    const fee = feeDollars(r.venue, n, q);
    const cost = (n * q) / 100 + fee;
    const pnl = won(r) ? -cost : n - cost;
    net += pnl;
    wins += won(r) ? 0 : 1;
    actual += r.net;
  }
  return {
    code: "other-side",
    title: "Bet the other side",
    trades: used.length, wins,
    net: round2(net), actualNet: round2(actual),
    gain: round2(net - actual),
    note: `${used.length} trade(s) held to the end; other side priced at 100 - entry + ${SPREAD_CENTS}c, same stake, fees included`,
    inSample: false,
  };
}

/** Keep only the price ranges in this area that made money. */
function altPriceRange(rows, actualNet) {
  const byBand = new Map();
  for (const r of rows) {
    const b = bandOf(r.entryCents);
    if (!byBand.has(b)) byBand.set(b, []);
    byBand.get(b).push(r);
  }
  if (byBand.size < 2) return null;
  const keep = [...byBand.entries()].filter(([, list]) => list.reduce((t, r) => t + r.net, 0) > 0);
  const kept = keep.flatMap(([, list]) => list);
  if (!keep.length || kept.length < MIN_ALT_TRADES) return null;
  const t = tally(kept);
  const bands = keep.map(([b]) => b).sort((a, b) => BAND_ORDER.indexOf(a) - BAND_ORDER.indexOf(b));
  return {
    code: "price-range",
    title: `Only buy at ${bands.join(" / ")}`,
    trades: kept.length, wins: t.wins,
    net: t.net, actualNet: round2(actualNet), gain: round2(t.net - actualNet),
    note: `${kept.length} of ${rows.length} trade(s) were in ${bands.join(" / ")}; ranges chosen from these same trades`,
    inSample: true,
  };
}

/** In-play only or pre-game only. */
function altTiming(rows, actualNet) {
  const live = rows.filter((r) => r.live);
  const pre = rows.filter((r) => !r.live);
  if (!live.length || !pre.length) return null;
  const best = [["in-play", live], ["pre-game", pre]]
    .map(([name, list]) => ({ name, list, t: tally(list) }))
    .filter((x) => x.list.length >= MIN_ALT_TRADES)
    .sort((a, b) => b.t.net - a.t.net)[0];
  if (!best) return null;
  return {
    code: "timing",
    title: `Only trade ${best.name}`,
    trades: best.list.length, wins: best.t.wins,
    net: best.t.net, actualNet: round2(actualNet), gain: round2(best.t.net - actualNet),
    note: `${best.list.length} ${best.name} trade(s) in this area`,
    inSample: true,
  };
}

/** Early exits vs held - evidence only, not replayable. */
function sellEarlyEvidence(rows) {
  const early = rows.filter((r) => !heldToEnd(r));
  const held = rows.filter(heldToEnd);
  if (early.length < 3 || held.length < 3) return null;
  const e = tally(early), h = tally(held);
  return {
    earlyTrades: early.length, earlyRoiPct: e.roiPct, earlyNet: e.net,
    heldTrades: held.length, heldRoiPct: h.roiPct, heldNet: h.net,
    text: `Sold early: ${early.length} trade(s), ${fmtPct(e.roiPct)} return. Held to the end: ${held.length}, ${fmtPct(h.roiPct)}.`,
  };
}

const fmtPct = (v) => (v == null ? "-" : `${v >= 0 ? "+" : ""}${Number(v).toFixed(1)}%`);
const fmtMoney = (v) => `${v < 0 ? "-" : "+"}$${Math.abs(Number(v)).toFixed(2)}`;

/* -------------------------------- areas ---------------------------------- */

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

function areaList(rows) {
  const areas = [];
  const add = (kind, label, list, filters) => areas.push({ kind, label, rows: list, filters });
  for (const venue of ["kalshi", "polymarket"]) {
    const vr = rows.filter((r) => r.venue === venue);
    const sports = groupBy(vr, (r) => r.sport);
    for (const [sport, list] of sports) {
      add("sport", `${venueName(venue)} · ${sportName(sport)}`, list, { venue, sport });
    }
    for (const [band, list] of groupBy(vr, (r) => bandOf(r.entryCents))) {
      add("price", `${venueName(venue)} · bought at ${band}`, list, { venue, band });
    }
    for (const [key, list] of groupBy(vr, (r) => `${r.sport}|${bandOf(r.entryCents)}`)) {
      const [sport, band] = key.split("|");
      // Skip when it is the whole sport (every trade at one price range) - same rows, listed once.
      if (list.length === (sports.get(sport) || []).length) continue;
      add("sport-price", `${venueName(venue)} · ${sportName(sport)} at ${band}`, list, { venue, sport, band });
    }
    for (const [timing, list] of groupBy(vr, (r) => (r.live ? "in-play" : "pre-game"))) {
      // Skip when every trade on this exchange has the same timing - it is the exchange total.
      if (list.length === vr.length) continue;
      add("timing", `${venueName(venue)} · ${timing}`, list, { venue, timing });
    }
  }
  return areas;
}

/** One weak area: its numbers, every alternative tested, and the verdict. */
function judgeArea(area) {
  const t = tally(area.rows);
  const alts = [
    altOtherSide(area.rows),
    area.filters.band ? null : altPriceRange(area.rows, t.net),
    area.filters.timing ? null : altTiming(area.rows, t.net),
  ].filter(Boolean);
  alts.push({ code: "pause", title: "Pause this area", trades: 0, wins: 0, net: 0, actualNet: t.net, gain: round2(-t.net), note: "no trades, no loss", inSample: false });

  // An alternative has to beat what happened by at least $1 or 10% of the
  // money put up, whichever is larger, to count as a real improvement.
  const bar = Math.max(1, 0.1 * t.cost);
  // HINDSIGHT GUARD. Every area on this list was picked BECAUSE it lost, so
  // the other side of its games will always look profitable in hindsight.
  // Flipping is only recommended when the area wins clearly less often than
  // its prices implied (10+ trades, 1+ sd below) - a pattern, not just losses.
  const flipBacked = t.trades >= 10 && t.z <= -1 && area.rows.filter(heldToEnd).length >= 10;
  const real = alts
    .filter((a) => a.code !== "pause" && a.gain >= bar && a.net > 0)
    .filter((a) => a.code !== "other-side" || flipBacked)
    .sort((a, b) => b.net - a.net);
  const best = real[0] || null;
  const flip = alts.find((a) => a.code === "other-side");
  const sellEarly = sellEarlyEvidence(area.rows);
  const earlyBacked = sellEarly && sellEarly.earlyTrades >= 5 && sellEarly.earlyNet > 0 &&
    (sellEarly.earlyRoiPct ?? 0) - (sellEarly.heldRoiPct ?? 0) >= 20;

  let verdict;
  if (best) {
    verdict = {
      action: best.code,
      text: `${best.title}: ${fmtMoney(best.net)} instead of ${fmtMoney(t.net)} on the same games` +
        (best.inSample ? " (in-sample - picked from these trades, watch it hold up)" : "") + ".",
    };
  } else if (earlyBacked) {
    verdict = {
      action: "sell-early",
      text: `Take profit before the final whistle here. ${sellEarly.text} Early sales are a different set of games, so this is a lead to test, not a replay.`,
    };
  } else if (t.trades >= 10 && t.z <= -1) {
    verdict = {
      action: "pause",
      text: `No alternative tested made money here, and it wins less often than its prices said (${t.wins} of ${t.trades} vs ${t.expectedWins} expected). Pausing saves ${fmtMoney(-t.net).replace("+", "")}.`,
    };
  } else {
    verdict = {
      action: "watch",
      text: `Wins ${t.wins} of ${t.trades} vs ${t.expectedWins} its prices implied - ${t.evidence}. ` +
        (flip && flip.net > 0
          ? `Betting the other side would have made ${fmtMoney(flip.net)}, but that is hindsight - these picks win about as often as their prices said, so the losses look like bad luck, not a pattern to reverse. `
          : "") +
        "Keep collecting trades before changing it.",
    };
  }

  return {
    area: area.label, kind: area.kind, filters: area.filters,
    ...t,
    alternatives: alts,
    flipBacked,
    sellEarly,
    verdict,
  };
}

/* ------------------------- Polymarket copy trades ------------------------ */

function mirrorReport(rows) {
  const kalshi = rows.filter((r) => r.venue === "kalshi");
  const pm = rows.filter((r) => r.venue === "polymarket");
  if (!pm.length) return null;
  const copied = [], own = [], kalshiSide = [];
  let sameResult = 0;
  for (const p of pm) {
    const k = kalshi.find((x) => normTeam(x.team) === normTeam(p.team) && Math.abs(Date.parse(x.opened) - Date.parse(p.opened)) <= MIRROR_WINDOW_MS);
    if (k) {
      copied.push(p); kalshiSide.push(k);
      if (won(k) === won(p)) sameResult += 1;
    } else own.push(p);
  }
  const c = tally(copied), o = tally(own), ks = tally(kalshiSide);
  const lines = [];
  if (copied.length) {
    lines.push(`Copied Kalshi on ${copied.length} game(s): ${fmtMoney(c.net)} (${fmtPct(c.roiPct)}). Kalshi made ${fmtMoney(ks.net)} on those same games; both exchanges had the same result in ${sameResult} of ${copied.length}.`);
  }
  if (own.length) lines.push(`Its own picks: ${own.length} trade(s), ${fmtMoney(o.net)} (${fmtPct(o.roiPct)}), ${o.wins} won vs ${o.expectedWins} expected.`);
  if (copied.length && sameResult === copied.length && ks.net < 0) {
    lines.push("Polymarket's copied losses are Kalshi's losses - the picks lost, not the exchange. Fixing Kalshi's weak areas fixes these too.");
  }
  return { copied: c, own: o, kalshiOnSameGames: ks, sameResult, lines };
}

/* -------------------------------- report --------------------------------- */

/** Pure: the full report from normalized rows (rowsFromLifecycles). */
export function buildImprovements(rows, now = Date.now()) {
  const all = (rows || []).slice().sort((a, b) => Date.parse(a.closed) - Date.parse(b.closed));
  const overall = tally(all);
  const byVenue = {
    kalshi: tally(all.filter((r) => r.venue === "kalshi")),
    polymarket: tally(all.filter((r) => r.venue === "polymarket")),
  };

  // EDGE CHECK: does the bot win more often than the prices it pays imply?
  const preFee = round2(overall.net + overall.fees);
  const edge = {
    ...overall,
    netBeforeFees: preFee,
    text: overall.trades < 30
      ? `Only ${overall.trades} closed trades - not enough to measure an edge yet.`
      : overall.z >= 1
        ? `Wins ${overall.wins} of ${overall.trades} against ${overall.expectedWins} the prices implied (${overall.z} sd above) - the picks beat the market.`
        : overall.z <= -1
          ? `Wins ${overall.wins} of ${overall.trades} against ${overall.expectedWins} the prices implied (${Math.abs(overall.z)} sd below) - the picks are worse than the market price.`
          : `Wins ${overall.wins} of ${overall.trades} against ${overall.expectedWins} the prices implied - about what the market already priced in. Before fees ${fmtMoney(preFee)}, after fees ${fmtMoney(overall.net)}: no proven edge yet.`,
  };

  // RECENT FORM: the last 30 closed trades against everything before them.
  const recentN = Math.min(30, Math.floor(all.length / 2));
  const recent = recentN >= 10 ? tally(all.slice(-recentN)) : null;
  const earlier = recentN >= 10 ? tally(all.slice(0, -recentN)) : null;
  const form = recent && earlier ? {
    recent, earlier, recentTrades: recentN,
    text: `Last ${recentN} trades: ${fmtMoney(recent.net)} (${fmtPct(recent.roiPct)}), ${recent.wins} won vs ${recent.expectedWins} expected. Before that: ${fmtMoney(earlier.net)} (${fmtPct(earlier.roiPct)}).`,
  } : null;

  const areas = areaList(all).filter((a) => a.rows.length >= MIN_AREA_TRADES);

  // Weak areas, biggest loss first. A narrower area is dropped when a broader
  // one on the same exchange already covers the same loss (keeps the list short).
  const weak = areas
    .map((a) => ({ a, t: tally(a.rows) }))
    .filter((x) => x.t.net < 0)
    .sort((x, y) => x.t.net - y.t.net)
    .slice(0, 12)
    .map((x) => judgeArea(x.a));

  const working = areas
    .map((a) => ({ area: a.label, kind: a.kind, filters: a.filters, ...tally(a.rows) }))
    .filter((x) => x.net > 0 && x.trades >= MIN_AREA_TRADES && x.z >= 0.5)
    .sort((x, y) => y.net - x.net)
    .slice(0, 8);

  // NEEDS IMPROVEMENT: the short list, in plain words, most money first.
  const needs = [];
  if (overall.trades >= 30 && overall.z < 1) {
    needs.push({ priority: 1, title: "No proven edge yet", text: edge.text });
  }
  for (const w of weak.slice(0, 6)) {
    needs.push({
      priority: needs.length + 1,
      title: `${w.area}: ${fmtMoney(w.net)} over ${w.trades} trade(s)`,
      text: w.verdict.text,
      evidence: w.evidence,
    });
  }
  const mirror = mirrorReport(all);
  if (mirror && byVenue.polymarket.net < 0) {
    needs.push({ priority: needs.length + 1, title: `Polymarket: ${fmtMoney(byVenue.polymarket.net)} over ${byVenue.polymarket.trades} trade(s)`, text: mirror.lines.join(" ") });
  }

  return {
    version: IMPROVEMENT_VERSION,
    at: new Date(now).toISOString(),
    trades: all.length,
    edge, byVenue, form,
    needsImprovement: needs,
    weakAreas: weak,
    working,
    polymarket: mirror,
    method: "Every number is from the account's own closed trades. 'Bet the other side' prices the opposing contract at 100 - entry + 1c with the same stake and fees; everything else is the trades as they happened. Read-only - nothing here changes a setting.",
  };
}

let cache = { at: 0, report: null };

/** The report from the live ledger, recomputed at most once a minute. */
export function improvementReport() {
  if (cache.report && Date.now() - cache.at < 60_000) return cache.report;
  const report = buildImprovements(rowsFromLifecycles(getTradeLifecycles().completed));
  cache = { at: Date.now(), report };
  return report;
}

export function registerImprovementRoutes(app) {
  app.get("/api/improvements", (_req, res) => {
    try {
      res.json(improvementReport());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
