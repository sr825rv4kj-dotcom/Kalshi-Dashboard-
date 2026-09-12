import fs from "fs";
import path from "path";
import { CONFIG_DIR } from "./paths.js";

const CONFIG_PATH = path.join(CONFIG_DIR, "bot-config.json");

export function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

export function saveConfig(partial) {
  const current = loadConfig();
  const next = { ...current, ...partial };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

export function setEnvironment(environment, confirmed) {
  if (environment === "production" && !confirmed) {
    throw new Error("Switching to production requires explicit confirmation of the real-funds warning.");
  }
  return saveConfig({
    environment,
    confirmedProductionAt: environment === "production" ? new Date().toISOString() : null,
  });
}
