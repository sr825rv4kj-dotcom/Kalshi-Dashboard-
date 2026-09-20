/**
 * Credentials, API keys, notifications, milestones, games and background.
 */
import fs from "fs";
import path from "path";
import { CONFIG_DIR } from "../paths.js";
import { kalshiGet, hasCredentialsConfigured, resetCredentialsCache } from "../kalshiClient.js";
import { saveCredentials } from "../credentialsStore.js";
import { saveOddsKeys, getOddsKeysStatus } from "../oddsKeysStore.js";
import { saveTelegramConfig, getTelegramStatus } from "../telegramStore.js";
import { loadConfig, saveConfig } from "../configStore.js";
import { isRunning } from "../botController.js";
import { getUpcomingGames, getAvailableSportKeys, getLiveFeed } from "../gamesFeed.js";
import { saveBackground, getBackground, clearBackground } from "../backgroundStore.js";
import { discoverActiveSports } from "../sportsDiscovery.js";

const V2 = "/trade-api/v2";

export function registerSettingsRoutes(app) {
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
  app.get("/api/settings/odds-keys/status", (_req, res) => res.json(getOddsKeysStatus()));

  app.post("/api/settings/odds-keys", (req, res) => {
    try {
      const { oddsPapiKey, theOddsApiKey } = req.body || {};
      if (!oddsPapiKey && !theOddsApiKey) return res.status(400).json({ error: "Provide at least one key to save." });
      res.json({ saved: true, ...saveOddsKeys({ oddsPapiKey, theOddsApiKey }) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Telegram notification settings ---
  app.get("/api/settings/telegram/status", (_req, res) => res.json(getTelegramStatus()));

  app.post("/api/settings/telegram", (req, res) => {
    try {
      const { botToken, chatId } = req.body || {};
      if (!botToken && !chatId) return res.status(400).json({ error: "Provide a bot token and chat ID." });
      res.json({ saved: true, ...saveTelegramConfig({ botToken, chatId }) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Ticker map status. The manual map is deliberately empty now that the
   * resolver matches Kalshi markets automatically, so this also reports the
   * sports actually being scanned - otherwise the status bar reads "0 sports"
   * while the bot is happily scanning several.
   */
  app.get("/api/ticker-map/status", async (_req, res) => {
    const readCount = (p) => {
      try {
        const raw = JSON.parse(fs.readFileSync(p, "utf8"));
        const { _comment, _example, ...rest } = raw;
        return Object.keys(rest).length;
      } catch {
        return 0;
      }
    };

    let activeSports = [];
    try {
      activeSports = await discoverActiveSports();
    } catch {
      activeSports = [];
    }

    res.json({
      sportsTickerCount: readCount(path.join(CONFIG_DIR, "ticker-map.json")),
      polymarketTickerCount: readCount(path.join(CONFIG_DIR, "polymarket-map.json")),
      activeSports,
      activeSportsCount: activeSports.length,
      autoResolve: true,
    });
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
    try {
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

      let activeSports = [];
      try {
        activeSports = await discoverActiveSports();
      } catch {
        activeSports = [];
      }

      res.json({
        kalshi: { connected: kalshiConnected, error: kalshiError },
        oddsPapi: { configured: oddsKeys.oddsPapiConfigured },
        theOddsApi: { configured: oddsKeys.theOddsApiConfigured },
        botRunning: isRunning(),
        environment: config.environment,
        autoStartOnBoot: Boolean(config.autoStartOnBoot),
        activeSports,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Games board & background upload ---
  app.get("/api/games/sports", (_req, res) => res.json({ sportKeys: getAvailableSportKeys() }));

  /**
   * Live feed. Falls back to auto-discovered sports when sportsPool is empty,
   * which it now is by design - otherwise the board renders nothing while the
   * bot scans a full slate.
   */
  app.get("/api/games/live-feed", async (_req, res) => {
    try {
      const config = loadConfig();
      let pool = config.sportsPool || config.sports || [];
      if (!pool.length) {
        try {
          pool = await discoverActiveSports();
        } catch {
          pool = [];
        }
      }
      res.json(await getLiveFeed(pool));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/games/:sportKey", async (req, res) => {
    try {
      res.json(await getUpcomingGames(req.params.sportKey));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/background", (_req, res) => res.json(getBackground()));

  /**
   * Wallpaper settings. This used to destructure `dataUrl` and forward only
   * that, which silently discarded the whole new payload - the selected
   * wallpaper, the saved library and the rotation setting all looked saved in
   * the browser and were never written to the server. The body is forwarded
   * whole; backgroundStore validates and sanitizes it, and still accepts the
   * old bare-{dataUrl} shape from an older client.
   */
  app.post("/api/background", (req, res) => {
    try {
      res.json(saveBackground(req.body || {}));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete("/api/background", (_req, res) => res.json(clearBackground()));
}
