import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { bootstrapPersistentStorage, ENV_PATH } from "./paths.js";

bootstrapPersistentStorage();
dotenv.config({ path: ENV_PATH });

import { hasCredentialsConfigured } from "./kalshiClient.js";
import { startBot } from "./botController.js";
import { loadConfig } from "./configStore.js";
import { hasAccount, createAccount, verifyLogin, verifyToken } from "./authStore.js";
import { registerPortfolioRoutes } from "./routes/portfolio.js";
import { registerBotRoutes } from "./routes/bot.js";
import { registerSettingsRoutes } from "./routes/primarysettings.js";
import { registerMonitorRoutes } from "./routes/monitor.js";

const app = express();
const PORT = process.env.PORT || 8080;

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// --- Health check (Railway uses this to know the process is alive) ---
app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// --- Read-only diagnostics, behind a secret path, ABOVE the auth gate ------
//
// Registered here on purpose: it must answer without a browser session, so it
// cannot sit below app.use("/api", ...auth...). It is inert unless
// MONITOR_TOKEN is set, has no POST, and returns no secrets - see
// routes/monitor.js for exactly which config fields are echoed.
registerMonitorRoutes(app);

// --- Auth: account setup (once), login, and the gate for everything else ---
app.get("/api/auth/status", (_req, res) => res.json({ hasAccount: hasAccount() }));

app.post("/api/auth/setup", (req, res) => {
  try {
    const { email, password } = req.body || {};
    res.json({ token: createAccount(email, password) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
