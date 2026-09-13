import fs from "fs";
import path from "path";
import { DATA_DIR } from "./paths.js";

const LEDGER_PATH = path.join(DATA_DIR, "trade-ledger.json");

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
  teamName, sportKey, commenceTime, exitPriceCents,
}) {
  const ledger = loadLedger();
  ledger.push({
    timestamp: new Date().toISOString(),
    action, ticker, side, contracts, priceCents, filled, edgePct, reason, environment,
    exitPriceCents: exitPriceCents ?? null,
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
 * Pairs each entry with its matching exit (same ticker, first exit after
 * that entry) to produce completed round-trips with real cost, proceeds,
 * net P&L and ROI. Entries without a matching exit are still-open trades.
 *
 * All dollar figures derive from actual fill prices and counts recorded at
 * execution time - nothing here is estimated or simulated.
 */
export function getTradeLifecycles() {
  const ledger = loadLedger();
  const entries = ledger.filter((t) => t.action === "enter" && t.filled > 0);
  const exits = ledger.filter((t) => t.action === "exit" && t.filled > 0);
  const usedExitIndexes = new Set();

  const completed = [];
  const open = [];

  for (const entry of entries) {
    const exitIndex = exits.findIndex(
      (x, i) => !usedExitIndexes.has(i) && x.ticker === entry.ticker && new Date(x.timestamp) > new Date(entry.timestamp)
    );

    const costDollars = (entry.filled * entry.priceCents) / 100;

    if (exitIndex === -1) {
      open.push({
        ...entry,
        costDollars,
        status: "open",
      });
      continue;
    }

    usedExitIndexes.add(exitIndex);
    const exit = exits[exitIndex];
    const proceedsDollars = (exit.filled * (exit.exitPriceCents ?? exit.priceCents)) / 100;
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
    overallRoiPct: totalCost > 0 ? (totalNet / totalCost) * 100 : null,
  };
}
