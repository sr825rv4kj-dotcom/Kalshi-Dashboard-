/**
 * fundsAlerts.js  (2026-10-06)
 *
 * MONEY REMINDERS - tells the account holder when an account needs money,
 * on the dashboard (a banner that can be closed once read) and as a phone
 * push through the bot's Telegram (once per alert per day).
 *
 * Checked every 5 minutes, from the exchanges' own balance endpoints:
 *
 *   kalshi-empty     Kalshi cash is below ONE stake - the bot cannot place
 *                    its next trade.
 *   kalshi-low       Kalshi cash covers fewer than fundsAlerts.lowStakes
 *                    stakes (default 3).
 *   kalshi-shard     an exchange shard refused orders for having no money in
 *                    the last 24 hours AND still holds $0 (Kalshi trades MLB
 *                    and NBA on their own shards). Clears itself once funded.
 *   pm-empty         Polymarket buying power is below one Polymarket stake.
 *   pm-low           Polymarket buying power covers fewer than lowStakes stakes.
 *
 * Cash is what is free to bet. Money in open positions comes back when they
 * settle, so each message also says how much is tied up.
 *
 * Closing a banner hides that alert for the rest of the day. If the problem is
 * still there tomorrow it comes back - an account that still needs money is
 * not a read message. Dismissals and sent pushes live in DATA_DIR/alerts.json.
 *
 * Read-only: never moves money, places or cancels an order.
 */

import fs from "fs";
import path from "path";
import { DATA_DIR } from "./paths.js";
import { atomicWriteFileSync, tradingDay, getRecentLog, loadState } from "./stateStore.js";
import { loadConfig } from "./configStore.js";
import { readShardBalances } from "./executor.js";
import { kalshiGet, hasCredentialsConfigured } from "./kalshiClient.js";
import { stakeReport } from "./scaling.js";
import { getTelegramCredentials } from "./telegramStore.js";

export const FUNDS_ALERTS_VERSION = "2026-10-06-funds-alerts";

const FILE = path.join(DATA_DIR, "alerts.json");
const CHECK_EVERY_MS = 5 * 60 * 1000;
const SHARD_LOOKBACK_MS = 24 * 60 * 60 * 1000;

let current = { at: null, alerts: [] };
let timer = null;

function loadStore() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return { dismissed: s.dismissed || {}, sent: s.sent || {} };
  } catch {
    return { dismissed: {}, sent: {} };
  }
}

function saveStore(store) {
  // Keep a week of history so the file cannot grow without end.
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const k of ["dismissed", "sent"]) {
    for (const [id, at] of Object.entries(store[k])) if (Date.parse(at) < cutoff) delete store[k][id];
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    atomicWriteFileSync(FILE, JSON.stringify(store, null, 2));
  } catch { /* a reminder must never break anything */ }
}

const money = (n) => `$${Number(n || 0).toFixed(2)}`;

/** Pure: the alerts for a set of balances. */
export function alertsFrom({ kalshiCash, kalshiStake, kalshiOpen, shards, unfundedShards, pmBuyingPower, pmStake, pmOpen, lowStakes }) {
  const out = [];
  if (Number.isFinite(kalshiCash) && kalshiStake > 0) {
    const tied = kalshiOpen > 0 ? ` ${kalshiOpen} open position(s) will return money as they settle.` : "";
    if (kalshiCash < kalshiStake) {
      out.push({
        type: "kalshi-empty", severity: "critical", venue: "kalshi",
        title: "Kalshi: add money - the bot can't place its next trade",
        text: `Cash ${money(kalshiCash)} is below one ${money(kalshiStake)} bet.${tied}`,
        action: "Deposit at kalshi.com (Account → Deposit).",
      });
    } else if (kalshiCash < kalshiStake * lowStakes) {
      out.push({
        type: "kalshi-low", severity: "warning", venue: "kalshi",
        title: "Kalshi: funds running low",
        text: `Cash ${money(kalshiCash)} covers ${Math.floor(kalshiCash / kalshiStake)} more ${money(kalshiStake)} bet(s).${tied}`,
        action: "Top up at kalshi.com (Account → Deposit) to keep trades going.",
      });
    }
  }
  for (const idx of unfundedShards) {
    const bal = shards ? shards[idx] : undefined;
    if (bal === undefined || bal > 0) continue;
    out.push({
      type: `kalshi-shard-${idx}`, severity: "critical", venue: "kalshi",
      title: `Kalshi: shard ${idx} has no money - its orders are being refused`,
      text: `Kalshi refused orders on shard ${idx} (MLB / NBA markets trade there) because it holds $0.`,
      action: `Set a target balance allocation that includes shard ${idx} at kalshi.com/account/exchange-indexes and leave "Disable balance management" OFF.`,
    });
  }
  if (Number.isFinite(pmBuyingPower) && pmStake > 0) {
    const tied = pmOpen > 0 ? ` ${pmOpen} open position(s) will return money as they settle.` : "";
    if (pmBuyingPower < pmStake) {
      out.push({
        type: "pm-empty", severity: "critical", venue: "polymarket",
        title: "Polymarket: add money - the bot can't place its next trade",
        text: `Buying power ${money(pmBuyingPower)} is below one ${money(pmStake)} bet.${tied}`,
        action: "Deposit in the Polymarket app.",
      });
    } else if (pmBuyingPower < pmStake * lowStakes) {
      out.push({
        type: "pm-low", severity: "warning", venue: "polymarket",
        title: "Polymarket: funds running low",
        text: `Buying power ${money(pmBuyingPower)} covers ${Math.floor(pmBuyingPower / pmStake)} more ${money(pmStake)} bet(s).${tied}`,
        action: "Top up in the Polymarket app to keep trades going.",
      });
    }
  }
  return out;
}

/** Shards that refused an order for having no money in the last 24 hours (from the bot's log). */
function recentlyUnfundedShards() {
  const since = Date.now() - SHARD_LOOKBACK_MS;
  const found = new Set();
  try {
    for (const l of getRecentLog(500)) {
      if (Date.parse(l.time) < since) continue;
      const m = /shard (\d+) holds no collateral/.exec(String(l.message || ""));
      if (m) found.add(Number(m[1]));
    }
  } catch { /* no log, no shard alerts */ }
  return [...found];
}

async function kalshiCashAndShards() {
  if (!hasCredentialsConfigured()) return { cash: NaN, shards: null };
  const shards = await readShardBalances();
  if (shards) return { cash: Object.values(shards).reduce((t, v) => t + v, 0), shards };
  try {
    const bal = await kalshiGet("/trade-api/v2/portfolio/balance");
    return { cash: Number(bal.balance) / 100, shards: null };
  } catch {
    return { cash: NaN, shards: null };
  }
}

async function pmBuyingPowerNow() {
  try {
    const { pmConfigured } = await import("./polymarket/pmClient.js");
    if (!pmConfigured()) return NaN;
    const { readPmAccount } = await import("./polymarket/pmEngine.js");
    const acct = await readPmAccount();
    return Number(acct.buyingPower);
  } catch {
    return NaN;
  }
}

async function sendPush(alert) {
  try {
    const { botToken, chatId } = getTelegramCredentials() || {};
    if (!botToken || !chatId) return false;
    const icon = alert.severity === "critical" ? "🔴" : "🟡";
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `${icon} ${alert.title}\n\n${alert.text}\n\n${alert.action}` }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** One check: read balances, rebuild the alert list, push anything new. */
export async function checkFundsOnce() {
  const config = loadConfig();
  const fa = config.fundsAlerts && typeof config.fundsAlerts === "object" ? config.fundsAlerts : {};
  if (fa.enabled === false) { current = { at: new Date().toISOString(), alerts: [] }; return current; }
  const lowStakes = Number.isFinite(Number(fa.lowStakes)) && Number(fa.lowStakes) > 1 ? Number(fa.lowStakes) : 3;

  const { cash: kalshiCash, shards } = await kalshiCashAndShards();
  const pmBuyingPower = await pmBuyingPowerNow();
  const st = (() => { try { return loadState(); } catch { return {}; } })();
  const kalshiStake = Number(stakeReport(config).current?.stake) || Number(config.flatStakeDollars) || 5;
  const pmStake = Number(config.polymarket?.flatStakeDollars) || 3.5;

  const day = tradingDay();
  const alerts = alertsFrom({
    kalshiCash, kalshiStake, kalshiOpen: (st.positions || []).length,
    shards, unfundedShards: recentlyUnfundedShards(),
    pmBuyingPower, pmStake, pmOpen: (st.pmPositions || []).length,
    lowStakes,
  }).map((a) => ({ ...a, id: `${a.type}:${day}` }));

  const store = loadStore();
  let changed = false;
  for (const a of alerts) {
    if (store.sent[a.id]) continue;
    if (await sendPush(a)) { store.sent[a.id] = new Date().toISOString(); changed = true; }
  }
  if (changed) saveStore(store);

  current = { at: new Date().toISOString(), alerts };
  return current;
}

/** Alerts not yet closed today, for the banner. */
export function openAlerts() {
  const store = loadStore();
  return {
    version: FUNDS_ALERTS_VERSION,
    at: current.at,
    alerts: current.alerts.filter((a) => !store.dismissed[a.id]),
  };
}

export function dismissAlert(id) {
  const store = loadStore();
  store.dismissed[String(id)] = new Date().toISOString();
  saveStore(store);
}

export function startFundsAlerts() {
  if (timer) return;
  const tick = () => { checkFundsOnce().catch(() => {}); };
  timer = setInterval(tick, CHECK_EVERY_MS);
  if (typeof timer.unref === "function") timer.unref();
  const first = setTimeout(tick, 60 * 1000);
  if (typeof first.unref === "function") first.unref();
}

export function registerFundsAlertRoutes(app) {
  startFundsAlerts();
  app.get("/api/alerts", async (_req, res) => {
    try {
      // Fresh check if the last one is over a minute old, so the banner is current on open.
      if (!current.at || Date.now() - Date.parse(current.at) > 60 * 1000) await checkFundsOnce();
      res.json(openAlerts());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/alerts/dismiss", (req, res) => {
    try {
      const id = String(req.body?.id || "");
      if (!id) return res.status(400).json({ error: "id required" });
      dismissAlert(id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
