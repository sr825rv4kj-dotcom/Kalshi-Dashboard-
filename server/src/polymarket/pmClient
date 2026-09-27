/**
 * polymarket/pmClient.js
 *
 * POLYMARKET US - SIGNED API CLIENT (2026-09-27)
 *
 * Polymarket US is the CFTC-regulated exchange (polymarket.us), not the
 * international crypto site. Keys come from polymarket.us/developer after
 * identity verification in the Polymarket US app: a Key ID and a Secret Key.
 *
 * Authentication, exactly as the official polymarket-us SDK (v0.1.1) does it:
 *   message   = `${timestampMs}${METHOD}${pathname}`   (no query string)
 *   signature = base64( Ed25519.sign(message, first 32 bytes of the secret) )
 *   headers   = X-PM-Access-Key, X-PM-Timestamp, X-PM-Signature
 * Public market data lives on gateway.polymarket.us; anything signed goes to
 * api.polymarket.us.
 *
 * Node's own crypto signs Ed25519, so there is no new dependency. The
 * signature was checked byte-for-byte against the SDK's @noble/ed25519.
 *
 * SECRETS. The secret key is read from the environment (Railway variables
 * POLYMARKET_KEY_ID / POLYMARKET_SECRET_KEY) or from the keys saved in the
 * dashboard, which are written to the persistent .env file with owner-only
 * permissions - the same place the odds API keys live. It is never logged,
 * never returned by any route, and never included in an error message.
 */

import crypto from "crypto";
import fs from "fs";
import { ENV_PATH } from "../paths.js";

export const PM_CLIENT_VERSION = "2026-09-27-polymarket-us";

const GATEWAY = "https://gateway.polymarket.us";
const API = "https://api.polymarket.us";
const TIMEOUT_MS = 15_000;
// The retail API allows 20 requests a second. One request every 70ms keeps
// the bot comfortably under it without a queue library.
const MIN_GAP_MS = 70;

const stats = { requests: 0, errors: 0, rateLimited: 0, lastError: null, lastOkAt: null };

// --- Credentials -------------------------------------------------------------

function envValue(name) {
  const direct = process.env[name];
  if (direct) return String(direct).trim().replace(/^["']|["']$/g, "");
  // A phone-edited Railway variable can pick up stray spaces in its NAME.
  const key = Object.keys(process.env).find((k) => k.replace(/\s+/g, "").toUpperCase() === name);
  return key ? String(process.env[key]).trim().replace(/^["']|["']$/g, "") : "";
}

export function pmCredentials() {
  return {
    keyId: envValue("POLYMARKET_KEY_ID"),
    secretKey: envValue("POLYMARKET_SECRET_KEY").replace(/\s+/g, ""),
  };
}

export function pmConfigured() {
  const { keyId, secretKey } = pmCredentials();
  return Boolean(keyId && secretKey);
}

/** Decodes the secret and returns the 32-byte Ed25519 seed, or throws a message with no secret in it. */
function seedFrom(secretKey) {
  let bytes;
  try { bytes = Buffer.from(secretKey, "base64"); } catch { bytes = Buffer.alloc(0); }
  if (bytes.length === 64) return bytes.subarray(0, 32);
  if (bytes.length === 32) return bytes;
  throw new Error(`Polymarket secret key is not a valid key (decoded to ${bytes.length} bytes, expected 32 or 64) - copy it again from polymarket.us/developer`);
}

let cachedKey = { secret: null, key: null };
function privateKeyFor(secretKey) {
  if (cachedKey.secret === secretKey && cachedKey.key) return cachedKey.key;
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seedFrom(secretKey)]);
  const key = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  cachedKey = { secret: secretKey, key };
  return key;
}

/** Exported for the signature self-test only. */
export function signMessage(secretKey, message) {
  return crypto.sign(null, Buffer.from(message, "utf8"), privateKeyFor(secretKey)).toString("base64");
}

export function authHeaders(method, pathname, now = Date.now()) {
  const { keyId, secretKey } = pmCredentials();
  if (!keyId || !secretKey) throw tag(new Error("Polymarket keys are not set"), "config");
  const timestamp = String(now);
  return {
    "X-PM-Access-Key": keyId,
    "X-PM-Timestamp": timestamp,
    "X-PM-Signature": signMessage(secretKey, `${timestamp}${method}${pathname}`),
  };
}

/** Save keys entered on the dashboard. Validates the secret before writing anything. */
export function savePmKeys({ keyId, secretKey }) {
  const id = String(keyId || "").trim();
  const secret = String(secretKey || "").replace(/\s+/g, "");
  if (!id && !secret) throw new Error("Enter the Key ID and the Secret Key.");
  if (secret) seedFrom(secret);   // throws a clean message if it is not a key

  const map = {};
  if (fs.existsSync(ENV_PATH)) {
    for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) map[m[1]] = m[2];
    }
  }
  if (id) map.POLYMARKET_KEY_ID = id;
  if (secret) map.POLYMARKET_SECRET_KEY = secret;
  fs.writeFileSync(ENV_PATH, Object.entries(map).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  if (id) process.env.POLYMARKET_KEY_ID = id;
  if (secret) process.env.POLYMARKET_SECRET_KEY = secret;
  cachedKey = { secret: null, key: null };
  return { configured: pmConfigured() };
}

// --- Requests ----------------------------------------------------------------

function tag(err, kind, status = null) {
  err.kind = kind;
  if (status != null) err.status = status;
  return err;
}

let lastRequestAt = 0;
async function pace() {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  lastRequestAt = Math.max(Date.now(), lastRequestAt + MIN_GAP_MS);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/**
 * One request. `auth: true` signs it and sends it to api.polymarket.us;
 * otherwise it goes to the public gateway. A 429 is retried once after a
 * second; every other failure throws with .status and .kind set.
 */
export async function pmRequest(method, path, { query, body, auth = false } = {}) {
  const url = new URL(path, auth ? API : GATEWAY);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
      else url.searchParams.set(k, String(v));
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    await pace();
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (auth) Object.assign(headers, authHeaders(method, url.pathname));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    stats.requests++;
    let res;
    try {
      res = await fetch(url.toString(), {
        method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      stats.errors++;
      stats.lastError = `${method} ${url.pathname}: ${err.name === "AbortError" ? "timed out" : err.message}`;
      throw tag(new Error(`Polymarket unreachable (${stats.lastError})`), "transport");
    }
    clearTimeout(timer);

    const text = await res.text().catch(() => "");
    if (res.status === 429 && attempt === 0) {
      stats.rateLimited++;
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (!res.ok) {
      stats.errors++;
      let msg = text.slice(0, 300);
      try { const j = JSON.parse(text); msg = j.message || j.error || msg; } catch { /* keep text */ }
      stats.lastError = `${method} ${url.pathname}: HTTP ${res.status} ${msg}`;
      const kind = res.status === 401 ? "auth" : res.status === 403 ? "forbidden" : res.status === 404 ? "not-found" : "http";
      throw tag(new Error(`Polymarket ${res.status}: ${msg}`), kind, res.status);
    }
    stats.lastOkAt = new Date().toISOString();
    if (!text) return {};
    try { return JSON.parse(text); } catch { throw tag(new Error(`Polymarket returned non-JSON from ${url.pathname}`), "http", res.status); }
  }
  throw tag(new Error("Polymarket rate limit - retry later"), "http", 429);
}

export const pmGet = (path, opts = {}) => pmRequest("GET", path, opts);
export const pmPost = (path, body, opts = {}) => pmRequest("POST", path, { ...opts, body });

export function pmClientStats() {
  return { ...stats, configured: pmConfigured() };
}

// --- Field readers -------------------------------------------------------------
// The docs and the SDK disagree on a few spellings (netPosition vs
// netPositionDecimal, settlement vs settlementPrice). Every reader accepts
// both, so whichever the live API sends is read correctly.

/** Amount {value:"0.55"} | "0.55" | 0.55 -> dollars as a number, or null. */
export function dollarsOf(v) {
  if (v == null) return null;
  if (typeof v === "object") return dollarsOf(v.value ?? v.amount ?? null);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function centsOf(v) {
  const d = dollarsOf(v);
  return d == null ? null : Math.round(d * 1000) / 10;   // keeps a 0.1c tick
}

export function numberOf(...vals) {
  for (const v of vals) {
    if (v == null || v === "") continue;
    const n = Number(typeof v === "object" ? v.value : v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
