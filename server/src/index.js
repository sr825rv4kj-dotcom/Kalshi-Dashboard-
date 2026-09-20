import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { bootstrapPersistentStorage, ENV_PATH } from "./paths.js";

dotenv.config({ path: ENV_PATH });
bootstrapPersistentStorage();

import { hasCredentialsConfigured } from "./kalshiClient.js";
import { startBot } from "./botController.js";
import { loadConfig } from "./configStore.js";
import { hasAccount, createAccount, verifyLogin, verifyToken } from "./authStore.js";
import { registerPortfolioRoutes } from "./routes/portfolio.js";
import { registerBotRoutes } from "./routes/bot.js";
import { registerSettingsRoutes } from "./routes/primarysettings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;

// --- Crash resilience ---
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

app.post("/api/auth/login", (req, res) => {
  try {
    const { email, password } = req.body || {};
    res.json({ token: verifyLogin(email, password) });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

/**
 * Anything that looks like an API call but is not one gets a JSON 404 rather
 * than the HTML page. A stale frontend bundle was requesting
 * "/undefined/api/diagnose/v2"; because that path does not start with "/api/",
 * it fell through to the SPA catch-all and came back as index.html with a 200,
 * which the dashboard then reported as a mysterious parse error. This turns
 * that class of mistake into a message that names itself.
 */
app.use((req, res, next) => {
  if (req.path.includes("/api/") && !req.path.startsWith("/api/")) {
    return res.status(404).json({
      error: `Malformed API path "${req.path}". The browser is running a stale build - ` +
             `close the tab and reopen the app.`,
    });
  }
  next();
});

// Everything below requires a valid session token, except the routes defined
// above and the static frontend, which must load before anyone is logged in.
app.use("/api", (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const session = verifyToken(token);
  if (!session) return res.status(401).json({ error: "Not authenticated." });
  req.user = session;
  next();
});

/**
 * Sits behind the gate above, so a 200 here means the caller's token is still
 * valid. Its URL starts with /api/auth/ so the client's fetch wrapper leaves
 * the 401 alone and AuthGate can handle it deliberately.
 */
app.get("/api/auth/verify", (_req, res) => res.json({ ok: true }));

// --- Routes, grouped by area (see src/routes/) ---
registerPortfolioRoutes(app);
registerBotRoutes(app);
registerSettingsRoutes(app);

/**
 * Optional modules, loaded defensively. If diagnostics.js, selfCheck.js or
 * watchdog.js has not been committed yet, the server logs a line and keeps
 * running rather than refusing to boot on a missing import.
 */
async function registerOptionalModules() {
  try {
    const { registerDiagnosticRoutes } = await import("./diagnostics.js");
    registerDiagnosticRoutes(app);
    console.log("Diagnostics enabled at /api/diagnose/v2");
  } catch (err) {
    console.warn("[optional] diagnostics.js not loaded:", err.message);
  }

  try {
    const { registerSelfCheckRoutes } = await import("./selfCheck.js");
    registerSelfCheckRoutes(app);
    console.log("Self-check enabled at /api/selfcheck");
  } catch (err) {
    console.warn("[optional] selfCheck.js not loaded:", err.message);
  }
}

/**
 * Static frontend, registered AFTER the API routes so its catch-all cannot
 * swallow them.
 *
 * index.html is served with no-store. Hashed asset files can cache forever,
 * but the HTML that names them must never be cached - otherwise a browser
 * keeps loading yesterday's bundle after a deploy, which is exactly what made
 * fixed bugs appear to persist for hours.
 */
function registerFrontend() {
  const clientDistPath = path.join(__dirname, "..", "..", "client", "dist");
  if (!fs.existsSync(clientDistPath)) return;

  app.use(express.static(clientDistPath, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      } else {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }));

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.join(clientDistPath, "index.html"));
  });

  console.log("Serving built frontend from client/dist");
}

async function boot() {
  await registerOptionalModules();
  registerFrontend();

  app.listen(PORT, async () => {
    console.log(`Kalshi dashboard backend running on http://localhost:${PORT}`);

    const config = loadConfig();
    if (config.autoStartOnBoot && hasCredentialsConfigured()) {
      console.log(`autoStartOnBoot enabled - starting bot in ${config.environment.toUpperCase()} mode.`);
      startBot();
    } else if (config.autoStartOnBoot) {
      console.log("autoStartOnBoot enabled but no credentials configured yet - waiting for setup.");
    }

    try {
      const { startWatchdog } = await import("./watchdog.js");
      startWatchdog();
    } catch (err) {
      console.warn("[optional] watchdog.js not loaded:", err.message);
    }
  });
}

boot();
