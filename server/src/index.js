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
import { getRecentTrades, getTradeStats } from "./tradeLedgerStore.js";
import { hasAccount, createAccount, verifyLogin, verifyToken } from "./authStore.js";
import { saveTelegramConfig, getTelegramStatus } from "./telegramStore.js";
import { getUpcomingGames, getAvailableSportKeys } from "./gamesFeed.js";
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

// --- Risk assessment (calculation only, never places orders) ---
app.post("/api/assess", (req, res) => {
  try {
    const { bankroll, trueProbability, price, restingContracts, kellyFraction, minLiquidity } = req.body;
    if (typeof bankroll !== "number" || typeof trueProbability !== "number" || typeof price !== "number" || typeof restingContracts !== "number") {
      return res.status(400).json({ error: "bankroll, trueProbability, price, and restingContracts must all be numbers" });
    }
    const result = assessOpportunity({ bankroll, trueProbability, price, restingContracts, kellyFraction, minLiquidity });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Bot config ---
app.get("/api/bot/config", (_req, res) => res.json(loadConfig()));

app.post("/api/bot/config", (req, res) => {
  try {
    const { environment, confirmedProductionAt, ...safeUpdates } = req.body || {};
    res.json(saveConfig(safeUpdates));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/bot/environment", (req, res) => {
  try {
    const { environment, confirmed } = req.body || {};
    if (!["demo", "production"].includes(environment)) return res.status(400).json({ error: "environment must be 'demo' or 'production'" });
    res.json(setEnvironment(environment, confirmed));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Bot start/stop/status ---
app.get("/api/bot/status", async (_req, res) => {
  const state = loadState();
  const config = loadConfig();

  let currentBalance = null;
  let survivalModeActive = null;
  try {
    const balanceData = await kalshiGet(`${V2}/portfolio/balance`);
    currentBalance = (balanceData.balance ?? 0) / 100;
    if (config.survivalMode) survivalModeActive = currentBalance < config.survivalMode.balanceThreshold;
  } catch {
    // leave null - frontend handles it
  }

  res.json({
    running: isRunning(), environment: config.environment,
    haltedForDay: state.haltedForDay, haltReason: state.haltReason, dayStartBalance: state.dayStartBalance,
    currentBalance,
    survivalMode: config.survivalMode ? { active: survivalModeActive, ...config.survivalMode } : null,
    openPositions: state.positions,
    botStartedAt: state.botStartedAt,
    tradeStats: getTradeStats(),
  });
});

app.post("/api/bot/start", (_req, res) => res.json(startBot()));
app.post("/api/bot/stop", (_req, res) => res.json(stopBot()));

app.get("/api/bot/log", (req, res) => {
  const limit = Number(req.query.limit) || 100;
  res.json({ log: getRecentLog(limit) });
});

app.get("/api/trade-ledger", (req, res) => {
  const limit = Number(req.query.limit) || 100;
  res.json({ trades: getRecentTrades(limit) });
});

// --- Ticker map status ---
app.get("/api/ticker-map/status", (_req, res) => {
  try {
    const readCount = (p) => {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const { _comment, _example, ...rest } = raw;
      return Object.keys(rest).length;
    };
    res.json({
      sportsTickerCount: readCount(path.join(CONFIG_DIR, "ticker-map.json")),
      polymarketTickerCount: readCount(path.join(CONFIG_DIR, "polymarket-map.json")),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Milestones & cost tracking (informational only) ---
app.get("/api/milestones", async (_req, res) => {
  try {
    const config = loadConfig();
    const balanceData = await kalshiGet(`${V2}/portfolio/balance`).catch(() => null);
    const currentBalance = balanceData ? (balanceData.balance ?? 0) / 100 : null;
    res.json({ milestones: config.milestones || [], currentBalance, monthlyCosts: config.monthlyCosts || {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/milestones", (req, res) => {
  try {
    const { milestones, monthlyCosts } = req.body || {};
    const updates = {};
    if (Array.isArray(milestones)) updates.milestones = milestones;
    if (monthlyCosts && typeof monthlyCosts === "object") updates.monthlyCosts = monthlyCosts;
    res.json(saveConfig(updates));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Overall system status ---
app.get("/api/system-status", async (_req, res) => {
  const config = loadConfig();
  const oddsKeys = getOddsKeysStatus();
  let kalshiConnected = false;
  let kalshiError = null;
  try {
    await kalshiGet(`${V2}/portfolio/balance`);
    kalshiConnected = true;
  } catch (err) {
    kalshiError = err.message;
  }
  res.json({
    kalshi: { connected: kalshiConnected, error: kalshiError },
    oddsPapi: { configured: oddsKeys.oddsPapiConfigured },
    theOddsApi: { configured: oddsKeys.theOddsApiConfigured },
    botRunning: isRunning(), environment: config.environment, autoStartOnBoot: Boolean(config.autoStartOnBoot),
  });
});

// --- Games board & background upload ---
app.get("/api/games/sports", (_req, res) => {
  res.json({ sportKeys: getAvailableSportKeys() });
});

app.get("/api/games/:sportKey", async (req, res) => {
  try {
    const result = await getUpcomingGames(req.params.sportKey);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/background", (_req, res) => {
  res.json(getBackground());
});

app.post("/api/background", (req, res) => {
  try {
    const { dataUrl } = req.body || {};
    res.json(saveBackground(dataUrl));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/background", (_req, res) => {
  res.json(clearBackground());
});

const clientDistPath = path.join(__dirname, "..", "..", "client", "dist");
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(clientDistPath, "index.html"));
  });
  console.log("Serving built frontend from client/dist");
}

app.listen(PORT, () => {
  console.log(`Kalshi dashboard backend running on http://localhost:${PORT}`);
  const config = loadConfig();
  if (config.autoStartOnBoot && hasCredentialsConfigured()) {
    console.log(`autoStartOnBoot enabled - starting bot in ${config.environment.toUpperCase()} mode.`);
    startBot();
  } else if (config.autoStartOnBoot) {
    console.log("autoStartOnBoot enabled but no credentials configured yet - waiting for setup.");
  }
});
