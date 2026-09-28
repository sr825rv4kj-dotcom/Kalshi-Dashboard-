/**
 * polymarket/pmRoutes.js
 *
 * Dashboard routes for Polymarket US. All behind the dashboard login (they
 * are registered after the auth gate in index.js).
 *
 *   GET  /api/polymarket/status     balance, positions, switch, self-check, last scan
 *   POST /api/polymarket/keys       save Key ID + Secret Key (secret is never returned)
 *   POST /api/polymarket/settings   { trading: "auto"|"on"|"off" }
 *   POST /api/polymarket/selfcheck  run the live self-check now
 */

import { loadConfig, saveConfig } from "../configStore.js";
import { savePmKeys } from "./pmClient.js";
import { pmStatus, pmSettings, runSelfCheck } from "./pmEngine.js";

export function registerPolymarketRoutes(app) {
  app.get("/api/polymarket/status", (_req, res) => {
    try {
      res.json(pmStatus(loadConfig()));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/polymarket/keys", async (req, res) => {
    try {
      const { keyId, secretKey } = req.body || {};
      const saved = savePmKeys({ keyId, secretKey });
      // Check the new keys against the real API straight away.
      let selfCheck = null;
      try { selfCheck = await runSelfCheck(loadConfig()); } catch { selfCheck = null; }
      res.json({ ...saved, selfCheck: selfCheck ? { passed: selfCheck.passed, steps: selfCheck.steps } : null });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/polymarket/settings", (req, res) => {
    try {
      const body = req.body || {};
      const current = pmSettings(loadConfig());
      const next = { ...current };
      if (body.trading != null) {
        if (!["auto", "on", "off"].includes(body.trading)) throw new Error('trading must be "auto", "on" or "off"');
        next.trading = body.trading;
      }
      // No open-bet limit on Polymarket (removed 2026-09-28) - any old stored
      // value is dropped here so it can never come back.
      delete next.maxOpenPositions;
      if (body.enabled != null) next.enabled = body.enabled !== false;
      saveConfig({ polymarket: next });
      res.json(pmStatus(loadConfig()));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/polymarket/selfcheck", async (_req, res) => {
    try {
      const out = await runSelfCheck(loadConfig());
      res.json({ passed: out.passed, steps: out.steps, at: out.at });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
