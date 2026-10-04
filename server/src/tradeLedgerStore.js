import fs from "fs";
import path from "path";
import { DATA_DIR } from "./paths.js";
import { atomicWriteFileSync } from "./stateStore.js";

const LEDGER_PATH = path.join(DATA_DIR, "trade-ledger.json");

/**
 * NET PROFIT IS AFTER FEES (2026-09-22).
 *
 * Every trade used to be scored as payout minus price paid. Kalshi's fee was
 * never subtracted, so every win read higher and every loss read smaller than
 * what actually hit the account - by 1-2c per contract on each side of a trade.
 *
 * Each ledger row now carries `feeCents`: the TOTAL fee for that row, taken
 * from what Kalshi reported on the fill where it reported one. Rows written
 * before this change carry none, so their fee is computed from Kalshi's
 * published schedule - round up(0.07 x C x P x (1-P)) for a taker trade,
 * round up(0.0175 x C x P x (1-P)) for a resting (maker) fill. Settlement is
 * free, so a settled exit adds no fee.
 */
export function scheduleFeeCents(priceCents, contracts, maker = false) {
  const p = Number(priceCents) / 100;
  const c = Number(contracts) || 0;
  if (!(p > 0 && p < 1) || c <= 0) return 0;
  const rate = maker ? 0.0175 : 0.07;
  // Round the product to 1e-9 before the ceiling so float noise (0.07*... =
  // 1.7500000000000002) cannot add a phantom cent.
  return Math.ceil(Math.round(rate * c * p * (1 - p) * 100 * 1e9) / 1e9);
}

function isSettlement(row) {
  return /^settled/.test(String(row.reason || ""));
}

function isMakerEntry(row) {
  return row.maker === true || /as MAKER|Resting bid filled/i.test(String(row.reason || ""));
}

/** Series that carry a maker fee (Kalshi fee schedule); a maker fill elsewhere pays none. */
const MAKER_FEE_SERIES_PREFIXES = ["KXNBA", "KXNHL", "KXNFLGAME", "KXUEFACL", "KXPGA", "KXCLUBWC"];

function entryFeeCents(row) {
  if (Number.isFinite(row.feeCents)) return row.feeCents;
  if (isMakerEntry(row)) {
    const series = String(row.ticker || "").split("-")[0].toUpperCase();
    if (!MAKER_FEE_SERIES_PREFIXES.some((p) => series.startsWith(p))) return 0;
    return scheduleFeeCents(row.priceCents, row.filled, true);
  }
  return scheduleFeeCents(row.priceCents, row.filled, false);
}

function exitFeeCents(row) {
  if (isSettlement(row)) return 0;
  if (Number.isFinite(row.feeCents)) return row.feeCents;
  return scheduleFeeCents(row.exitPriceCents ?? row.priceCents, row.filled, false);
}

function ensureFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LEDGER_PATH)) {
    atomicWriteFileSync(LEDGER_PATH, JSON.stringify([], null, 2));
  }
}

export function loadLedger() {
  ensureFile();
  return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
}

// 2026-10-04: temp file + rename, so a restart mid-write can never leave a
// half-written ledger (the same failure that broke state.json).
function writeLedger(ledger) {
  atomicWriteFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

export function recordTrade({
  action, ticker, side, contracts, priceCents, reason, environment, edgePct, filled,
  teamName, sportKey, commenceTime, exitPriceCents, feeCents, maker, lotId,
}) {
  const ledger = loadLedger();
  ledger.push({
    timestamp: new Date().toISOString(),
    action, ticker, side, contracts, priceCents, filled, edgePct, reason, environment,
    exitPriceCents: exitPriceCents ?? null,
    feeCents: Number.isFinite(feeCents) ? feeCents : null,
    maker: maker === true ? true : undefined,
    teamName: teamName ?? null,
    sportKey: sportKey ?? null,
    commenceTime: commenceTime ?? null,
    // The position this row belongs to (its openedAt) - lets a sale be matched
    // to the exact buy when one ticker holds two positions (double-down).
    lotId: lotId ?? undefined,
  });
  writeLedger(ledger);
}

export function getRecentTrades(limit = 100) {
  const ledger = loadLedger();
  return ledger.slice(-limit).reverse();
}

/**
 * ROUND TRIPS, INCLUDING PARTIAL SELLS (2026-09-29, swing trading).
 *
 * The swing engine sells a position in pieces - half when the price climbs
 * back to fair value, the rest at the +65% target (swingEngine.js). One entry
 * can therefore close through two or more exit rows, and a game can be bought
 * again after it is sold.
 *
 * Exits are matched to entries by LOT first: a row carrying lotId (the
 * position's openedAt, written by this build) closes contracts of the entry
 * with the same lotId. Anything left - and every older row without one - is
 * matched FIRST IN, FIRST OUT, per ticker, in ledger order: the oldest open
 * entry of that ticker, then the next. A trade (one entry) is complete when all of its
 * contracts are closed; its proceeds are the sum of every piece, net of each
 * piece's share of that exit's fee.
 *
 * For a ledger where every exit closes exactly one whole entry - the whole
 * history before this build - this gives the same trades, costs and results
 * as the old one-entry-one-exit pairing (checked on the account's 118 closed
 * trades). It is also right where the old pairing was not: an exit that only
 * partly filled, followed by a second exit for the rest.
 *
 * Also returned: `pieces`, one row per exit allocation with the profit it
 * realised and when - today's P&L and round trips per game come from these.
 * Every figure comes from recorded fills; nothing is estimated.
 */
export function getTradeLifecycles() {
  const ledger = loadLedger();
  const lots = [];
  const completed = [];
  const pieces = [];

  const finish = (lot) => {
    const entry = lot.entry;
    const netDollars = lot.proceedsDollars - lot.costDollars;
    const last = lot.exits[lot.exits.length - 1];
    const reasons = [...new Set(lot.exits.map((x) => String(x.reason || "")))].filter(Boolean);
    completed.push({
      ticker: entry.ticker,
      side: entry.side,
      teamName: entry.teamName,
      sportKey: entry.sportKey,
      commenceTime: entry.commenceTime,
      environment: entry.environment,
      entryTimestamp: entry.timestamp,
      exitTimestamp: last.timestamp,
      contracts: entry.filled,
      entryPriceCents: entry.priceCents,
      exitPriceCents: Math.round((lot.exitValueCents / entry.filled) * 10) / 10,
      costDollars: lot.costDollars,
      proceedsDollars: lot.proceedsDollars,
      feesDollars: lot.entryFeeDollars + lot.exitFeeDollars,
      netDollars,
      roiPct: lot.costDollars > 0 ? (netDollars / lot.costDollars) * 100 : null,
      entryReason: entry.reason,
      exitReason: reasons.length > 1 ? reasons.join(" + ") : (reasons[0] || last.reason),
      exitPieces: lot.exits.length,
      edgePct: entry.edgePct,
      status: "closed",
      _order: lot.order,
    });
  };

  for (const t of ledger) {
    if (t.action === "enter" && t.filled > 0) {
      const entryFeeDollars = entryFeeCents(t) / 100;
      lots.push({
        order: lots.length,
        entry: t,
        remaining: t.filled,
        // What was put up: the contracts at the price paid, PLUS the entry fee.
        costDollars: (t.filled * t.priceCents) / 100 + entryFeeDollars,
        entryFeeDollars,
        proceedsDollars: 0,
        exitFeeDollars: 0,
        exitValueCents: 0,
        exits: [],
      });
      continue;
    }
    if (t.action !== "exit" || !(t.filled > 0)) continue;

    // What came back: the payout, MINUS the exit fee (zero at settlement),
    // shared across the entries this exit closes by contracts.
    const exitFeeDollars = exitFeeCents(t) / 100;
    const px = t.exitPriceCents ?? t.priceCents;
    let left = t.filled;
    const own = t.lotId ? lots.filter((l) => l.entry.lotId === t.lotId && l.entry.ticker === t.ticker) : [];
    const rest = lots.filter((l) => !own.includes(l));
    for (const lot of [...own, ...rest]) {
      if (left <= 0) break;
      if (lot.remaining <= 0 || lot.entry.ticker !== t.ticker) continue;
      const take = Math.min(left, lot.remaining);
      const feeShare = exitFeeDollars * (take / t.filled);
      const gross = (take * px) / 100;
      lot.remaining -= take;
      left -= take;
      lot.proceedsDollars += gross - feeShare;
      lot.exitFeeDollars += feeShare;
      lot.exitValueCents += take * px;
      lot.exits.push(t);
      const costShare = lot.costDollars * (take / lot.entry.filled);
      pieces.push({
        ticker: t.ticker,
        teamName: lot.entry.teamName ?? t.teamName ?? null,
        sportKey: lot.entry.sportKey ?? t.sportKey ?? null,
        commenceTime: lot.entry.commenceTime ?? t.commenceTime ?? null,
        timestamp: t.timestamp,
        entryTimestamp: lot.entry.timestamp,
        contracts: take,
        entryPriceCents: lot.entry.priceCents,
        exitPriceCents: px,
        netDollars: gross - feeShare - costShare,
        reason: t.reason,
        closesTrade: lot.remaining === 0,
      });
      if (lot.remaining === 0) finish(lot);
    }
  }

  const open = lots
    .filter((lot) => lot.remaining > 0)
    .map((lot) => ({
      ...lot.entry,
      remainingContracts: lot.remaining,
      // Cost of what is still held (a part-sold trade carries its share).
      costDollars: lot.costDollars * (lot.remaining / lot.entry.filled),
      feesDollars: lot.entryFeeDollars,
      realizedDollars: lot.exits.length ? lot.proceedsDollars - lot.costDollars * ((lot.entry.filled - lot.remaining) / lot.entry.filled) : 0,
      status: lot.exits.length ? "part-sold" : "open",
    }));

  // Same order as before: by entry, newest first.
  completed.sort((a, b) => b._order - a._order);
  for (const c of completed) delete c._order;
  return { completed, open: open.reverse(), pieces };
}

/**
 * WHICH EXCHANGE A TRADE WAS ON (2026-09-27). Polymarket trades are recorded
 * with a "PM:" ticker; everything else is Kalshi. venue: "kalshi" |
 * "polymarket" | "all".
 */
export function venueOf(ticker) {
  return String(ticker || "").startsWith("PM:") ? "polymarket" : "kalshi";
}

export function filterByVenue(list, venue = "all") {
  if (!venue || venue === "all" || venue === "combined") return list || [];
  return (list || []).filter((t) => venueOf(t.ticker) === venue);
}

export function getTradeStats(venue = "all") {
  const all = getTradeLifecycles();
  const completed = filterByVenue(all.completed, venue);
  const open = filterByVenue(all.open, venue);
  const wins = completed.filter((t) => t.netDollars > 0).length;
  const losses = completed.filter((t) => t.netDollars < 0).length;
  const totalNet = completed.reduce((sum, t) => sum + t.netDollars, 0);
  const totalCost = completed.reduce((sum, t) => sum + t.costDollars, 0);

  return {
    totalEntries: completed.length + open.length,
    totalExits: completed.length,
    openCount: open.length,
    wins,
    losses,
    winRatePct: completed.length ? (wins / completed.length) * 100 : null,
    totalNetDollars: totalNet,
    totalFeesDollars: completed.reduce((sum, t) => sum + (t.feesDollars || 0), 0),
    netIsAfterFees: true,
    overallRoiPct: totalCost > 0 ? (totalNet / totalCost) * 100 : null,
  };
}
