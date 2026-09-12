import fs from "fs";
import { ENV_PATH, KEY_FILE_PATH } from "./paths.js";

function loadEnvMap() {
  const existing = {};
  if (fs.existsSync(ENV_PATH)) {
    for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) existing[match[1]] = match[2];
    }
  }
  return existing;
}

function writeEnvMap(map) {
  const contents = Object.entries(map).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  fs.writeFileSync(ENV_PATH, contents, { mode: 0o600 });
}

export function saveCredentials({ keyId, privateKeyPem, baseUrl }) {
  if (!keyId || !privateKeyPem) throw new Error("Both keyId and privateKeyPem are required.");

  fs.writeFileSync(KEY_FILE_PATH, privateKeyPem.trim() + "\n", { mode: 0o600 });

  const resolvedBaseUrl = baseUrl || "https://api.elections.kalshi.com/trade-api/v2";
  const existing = loadEnvMap();
  const merged = {
    ...existing,
    KALSHI_API_KEY_ID: keyId,
    KALSHI_PRIVATE_KEY_PATH: KEY_FILE_PATH,
    KALSHI_API_BASE: resolvedBaseUrl,
    PORT: existing.PORT || process.env.PORT || "4000",
  };
  writeEnvMap(merged);

  process.env.KALSHI_API_KEY_ID = keyId;
  process.env.KALSHI_PRIVATE_KEY_PATH = KEY_FILE_PATH;
  process.env.KALSHI_API_BASE = resolvedBaseUrl;

  return { keyPath: KEY_FILE_PATH, envPath: ENV_PATH };
}
