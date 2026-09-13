import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { bootstrapPersistentStorage, CONFIG_DIR, ENV_PATH } from "./paths.js";

dotenv.config({ path: ENV_PATH });
bootstrapPersistentStorage();

import { kalshiGet, hasCredentialsConfigured, resetCredentialsCache } from "./kalshiClient.js";
import { assessOpportunity } from "./riskManager.js";
import { saveCredentials } from "./credentialsStore.js";
import { saveOddsKeys, getOddsKeysStatus } from "./oddsKeysStore.js";
import { startBot, stopBot, isRunning } from "./botController.js";
import { loadConfig, saveConfig, setEnvironment } from "./configStore.js";
import { loadState, getRecentLog } from "./stateStore.js";
import { getRecentTrades, getTradeStats, getTradeLifecycles } from "./tradeLedgerStore.js";
import { getRecentScores, findScoreForTeam } from "./scoresFetcher.js";
import { hasAccount, createAccount, verifyLogin, verifyToken } from "./authStore.js";
import { saveTelegramConfig, getTelegramStatus } from "./telegramStore.js";
import { getUpcomingGames, getAvailableSportKeys, getLiveFeed } from "./gamesFeed.js";
import { saveBackground, getBackground, clearBackground } from "./backgroundStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// --- Crash resilience ---
// A single bad tick in the bot loop (a malformed API response, a network
// blip) should never take down the whole process - it should log and
// keep running. These are last-resort catches; specific errors are still
// caught closer to their source (botController already wraps each cycle).
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// --- Health check (used by Railway to know the process is alive) ---
app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// --- Auth: account setup (once), login, and the gate for everything else ---
app.get("/api/auth/status", (_req, res) => res.json({ hasAccount: hasAccount() }));

app.post("/api/auth/setup", (req, res) => {
  try {
    const { email, password } = req.body || {};
    const token = createAccount(email, password);
    res.json({ token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/login", (req, res) => {
  try {
    const { email, password } = req.body || {};
    const token = verifyLogin(email, password);
    res.json({ token });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// Everything below this line requires a valid session token, except the
// routes already defined above (health, auth status/setup/login) and the
// static frontend files, which need to load before anyone is logged in.
app.use("/api", (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const session = verifyToken(token);
  if (!session) return res.status(401).json({ error: "Not authenticated." });
  req.user = session;
  next();
});

const PORT = process.env.PORT || 4000;
const V2 = "/trade-api/v2";

// --- Credentials setup ---
app.get("/api/credentials/status", (_req, res) => {
  res.json({ configured: hasCredentialsConfigured() });
});

app.post("/api/credentials", (req, res) => {
  try {
    const { keyId, privateKeyPem, baseUrl } = req.body || {};
    if (!keyId || !privateKeyPem) return res.status(400).json({ error: "keyId and privateKeyPem are required." });
    saveCredentials({ keyId, privateKeyPem, baseUrl });
    resetCredentialsCache();
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Odds API keys ---
app.get("/api/settings/odds-keys/status", (_req, res) => {
  res.json(getOddsKeysStatus());
});

app.post("/api/settings/odds-keys", (req, res) => {
  try {
    const { oddsPapiKey, theOddsApiKey } = req.body || {};
    if (!oddsPapiKey && !theOddsApiKey) return res.status(400).json({ error: "Provide at least one key to save." });
    const status = saveOddsKeys({ oddsPapiKey, theOddsApiKey });
    res.json({ saved: true, ...status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Telegram notification settings ---
app.get("/api/settings/telegram/status", (_req, res) => {
  res.json(getTelegramStatus());
});

app.post("/api/settings/telegram", (req, res) => {
  try {
    const { botToken, chatId } = req.body || {};
    if (!botToken && !chatId) return res.status(400).json({ error: "Provide a bot token and chat ID." });
    const status = saveTelegramConfig({ botToken, chatId });
    res.json({ saved: true, ...status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Portfolio (real Kalshi data only) ---
app.get("/api/balance", async (_req, res) => {
  try {
    const data = await kalshiGet(`${V2}/portfolio/balance`);
    res.json({ balanceDollars: (data.balance ?? 0) / 100 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/positions", async (_req, res) => {
  try {
    const data = await kalshiGet(`${V2}/portfolio/positions`);
    const positions = (data.market_positions ?? []).map((p) => ({
      ticker: p.ticker,
      position: p.position_fp != null ? Number(p.position_fp) : (p.position ?? 0),
      marketExposureDollars: p.market_exposure_dollars != null
        ? Number(p.market_exposure_dollars)
        : (p.market_exposure ?? 0) / 100,
      realizedPnlDollars: p.realized_pnl_dollars != null
        ? Number(p.realized_pnl_dollars)
        : (p.realized_pnl ?? 0) / 100,
      resting_orders_count: p.resting_orders_count,
    }));
    res.json({ positions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/orders", async (req, res) => {
  try {
    const limit = req.query.limit || "50";
    const data = await kalshiGet(`${V2}/portfolio/orders`, `?limit=${limit}`);
    const orders = (data.orders ?? []).map((o) => ({
      orderId: o.order_id, ticker: o.ticker, side: o.side, action: o.action, status: o.status,
      priceCents: o.yes_price ?? o.no_price, count: o.remaining_count ?? o.original_count ?? o.count,
      createdTime: o.created_time,
    }));
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/pnl-history", async (req, res) => {
  try {
    const limit = req.query.limit || "200";
    const data = await kalshiGet(`${V2}/portfolio/settlements`, `?limit=${limit}`);
    const settlements = (data.settlements ?? []).map((s) => ({
      ticker: s.ticker, settledTime: s.settled_time,
      revenueDollars: (s.revenue ?? 0) / 100,
      yesTotalCostDollars: (s.yes_total_cost ?? 0) / 100,
      noTotalCostDollars: (s.no_total_cost ?? 0) / 100,
    }));
    const sorted = [...settlements].sort((a, b) => new Date(a.settledTime) - new Date(b.settledTime));
    let cumulative = 0;
    const series = sorted.map((s) => {
      const cost = s.yesTotalCostDollars + s.noTotalCostDollars;
      const pnl = s.revenueDollars - cost;
      cumulative += pnl;
      return { date: s.settledTime, ticker: s.ticker, pnl, cumulativePnl: cumulative };
    });
    res.json({ series });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
