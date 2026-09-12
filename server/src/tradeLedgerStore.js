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

export function recordTrade({ action, ticker, side, contracts, priceCents, reason, environment, edgePct, filled }) {
  const ledger = loadLedger();
  ledger.push({
    timestamp: new Date().toISOString(),
    action, ticker, side, contracts, priceCents, filled, edgePct, reason, environment,
  });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

export function getRecentTrades(limit = 100) {
  const ledger = loadLedger();
  return ledger.slice(-limit).reverse();
}
