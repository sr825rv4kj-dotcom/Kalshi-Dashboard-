import fs from "fs";
import path from "path";
import { DATA_DIR } from "./paths.js";

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
    fs.writeFileSync(LEDGER_PATH, JSON.stringify([], null, 2));
  }
}

export function loadLedger() {
  ensureFile();
  return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
}

function writeLedger(ledger) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

export function recordTrade({
  action, ticker, side, contracts, priceCents, reason, environment, edgePct, filled,
  teamName, sportKey, commenceTime, exitPriceCents, feeCents, maker,
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
  });
  writeLedger(ledger);
}

export function getRecentTrades(limit = 100) {
  const ledger = loadLedger();
  return ledger.slice(-limit).reverse();
}

/**
 * Pairs each entry with its matching exit to produce completed round-trips
 * with real cost, proceeds, net P&L and ROI.
 *
 * All dollar figures derive from actual fill prices and counts recorded at
 * execution time - nothing here is estimated or simulated.
 */
export function getTradeLifecycles() {
  const ledger = loadLedger();

  // Pair on LEDGER ORDER, not on a strict timestamp comparison. An exit that
  // landed in the same second as its entry - routine with immediate-or-cancel
  // orders - failed "exit.timestamp > entry.timestamp" and left the trade
  // stranded as permanently open, with no cost, proceeds or ROI ever reported.
  const entries = ledger
    .map((t, i) => ({ ...t, _i: i }))
    .filter((t) => t.action === "enter" && t.filled > 0);
  const exits = ledger
    .map((t, i) => ({ ...t, _i: i }))
    .filter((t) => t.action === "exit" && t.filled > 0);
  const usedExitIndexes = new Set();

  const completed = [];
  const open = [];

  for (const entry of entries) {
    const exitIndex = exits.findIndex(
      (x, i) => !usedExitIndexes.has(i) && x.ticker === entry.ticker && x._i > entry._i
    );

    // What was put up: the contracts at the price paid, PLUS the entry fee.
    const entryFeeDollars = entryFeeCents(entry) / 100;
    const costDollars = (entry.filled * entry.priceCents) / 100 + entryFeeDollars;

    if (exitIndex === -1) {
      open.push({
        ...entry,
        costDollars,
        feesDollars: entryFeeDollars,
        status: "open",
      });
      continue;
    }

    usedExitIndexes.add(exitIndex);
    const exit = exits[exitIndex];
    // What came back: the payout, MINUS the exit fee (zero at settlement).
    const exitFeeDollars = exitFeeCents(exit) / 100;
    const proceedsDollars = (exit.filled * (exit.exitPriceCents ?? exit.priceCents)) / 100 - exitFeeDollars;
    const netDollars = proceedsDollars - costDollars;
    const roiPct = costDollars > 0 ? (netDollars / costDollars) * 100 : null;

    completed.push({
      ticker: entry.ticker,
      side: entry.side,
      teamName: entry.teamName,
      sportKey: entry.sportKey,
      commenceTime: entry.commenceTime,
      environment: entry.environment,
      entryTimestamp: entry.timestamp,
      exitTimestamp: exit.timestamp,
      contracts: entry.filled,
      entryPriceCents: entry.priceCents,
      exitPriceCents: exit.exitPriceCents ?? exit.priceCents,
      costDollars,
      proceedsDollars,
      feesDollars: entryFeeDollars + exitFeeDollars,
      netDollars,
      roiPct,
      entryReason: entry.reason,
      exitReason: exit.reason,
      edgePct: entry.edgePct,
      status: "closed",
    });
  }

  return { completed: completed.reverse(), open: open.reverse() };
}

export function getTradeStats() {
  const { completed, open } = getTradeLifecycles();
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
