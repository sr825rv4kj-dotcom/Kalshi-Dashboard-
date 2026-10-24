import fs from "fs";
import crypto from "crypto";

let cachedPrivateKey = null;

function getConfig() {
  return {
    keyId: process.env.KALSHI_API_KEY_ID,
    keyPath: process.env.KALSHI_PRIVATE_KEY_PATH,
    keyPem: process.env.KALSHI_PRIVATE_KEY_PEM,
    baseUrl: process.env.KALSHI_API_BASE || "https://api.elections.kalshi.com/trade-api/v2",
  };
}

/**
 * Key file wins over the env var. This order matters: the env var is set once
 * at deploy time and never changes, while the file is what the app writes when
 * you save new credentials. With the old precedence, rotating your Kalshi key
 * in the app updated the Key ID but kept signing with the stale env-var key -
 * which Kalshi rejects as INCORRECT_API_KEY_SIGNATURE, with no clue why.
 */
function getPrivateKey() {
  if (cachedPrivateKey) return cachedPrivateKey;
  const { keyPath, keyPem } = getConfig();

  if (keyPath && fs.existsSync(keyPath)) {
    cachedPrivateKey = fs.readFileSync(keyPath, "utf8");
    return cachedPrivateKey;
  }

  if (keyPem) {
    cachedPrivateKey = keyPem.replace(/\\n/g, "\n"); // literal and escaped newlines
    return cachedPrivateKey;
  }

  throw new Error(
    "Kalshi private key not found. Enter your credentials in the app, or set " +
    "KALSHI_PRIVATE_KEY_PEM as a fallback."
  );
}

export function resetCredentialsCache() {
  cachedPrivateKey = null;
}

export function hasCredentialsConfigured() {
  const { keyId, keyPath, keyPem } = getConfig();
  if (!keyId) return false;
  if (keyPath && fs.existsSync(keyPath)) return true;
  return Boolean(keyPem);
}

/**
 * Reports which source the key came from and a fingerprint of its public half.
 * No private key material is ever returned. Surfacing this is the difference
 * between "401" and "you are signing with the wrong key".
 */
export function describeCredentials() {
  const { keyId, keyPath, keyPem } = getConfig();
  const usingFile = Boolean(keyPath && fs.existsSync(keyPath));

  let fingerprint = null;
  let keyError = null;
  try {
    const pub = crypto.createPublicKey(getPrivateKey());
    fingerprint = crypto
      .createHash("sha256")
      .update(pub.export({ type: "spki", format: "der" }))
      .digest("hex")
      .slice(0, 16);
  } catch (err) {
    keyError = err.message;
  }

  return {
    keyId: keyId ? `${keyId.slice(0, 8)}...` : null,
    source: usingFile ? "saved in app" : keyPem ? "KALSHI_PRIVATE_KEY_PEM env var" : "none",
    envVarAlsoSet: Boolean(keyPem),
    keyFileExists: usingFile,
    fingerprint,
    keyError,
  };
}

function signRequest(method, requestPath) {
  const { keyId } = getConfig();
  if (!keyId) throw new Error("Kalshi API Key ID is not set. Enter your credentials in the app.");

  const timestamp = Date.now().toString();
  const message = timestamp + method.toUpperCase() + requestPath;

  const signature = crypto.sign("sha256", Buffer.from(message, "utf8"), {
    key: getPrivateKey(),
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-SIGNATURE": signature.toString("base64"),
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
  };
}

function root() {
  return getConfig().baseUrl.replace("/trade-api/v2", "");
}

/*
 * RATE LIMITING (2026-10-24). Production log 2026-10-24 13:43-13:44 PT: every
 * 20-second cycle failed with "Kalshi API error 429 too_many_requests", the
 * circuit breaker opened and cleared on each one, and nothing traded. Every
 * Kalshi call in the app goes through this file, so it is paced here:
 *   - reads (GET) at most READS_PER_SEC, writes (POST / DELETE) at most
 *     WRITES_PER_SEC - well under Kalshi's Basic-tier allowance
 *   - a 429 is retried up to 3 times, waiting Kalshi's Retry-After when it
 *     sends one, else 1s / 2s / 4s; during that wait every other call to the
 *     same kind (read or write) waits too, so the burst stops instead of
 *     piling on
 *   - a 429 means Kalshi refused the request without acting on it, so an
 *     order (POST) is safe to resend; it is resent with the SAME body and so
 *     the same client_order_id, which Kalshi will not accept twice
 * Counts are kept for the monitor (kalshiRateStats).
 */
const READS_PER_SEC = Number(process.env.KALSHI_READS_PER_SEC) > 0 ? Number(process.env.KALSHI_READS_PER_SEC) : 8;
const WRITES_PER_SEC = Number(process.env.KALSHI_WRITES_PER_SEC) > 0 ? Number(process.env.KALSHI_WRITES_PER_SEC) : 4;
const RETRY_WAITS_MS = [1000, 2000, 4000];

const lanes = {
  read: { gapMs: 1000 / READS_PER_SEC, next: 0, pausedUntil: 0 },
  write: { gapMs: 1000 / WRITES_PER_SEC, next: 0, pausedUntil: 0 },
};
const rateStats = { reads: 0, writes: 0, limited: 0, retriedOk: 0, gaveUp: 0, last429At: null, lastPath: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for this lane's next free slot (spacing calls evenly, honouring any 429 pause). */
async function takeSlot(kind) {
  const lane = lanes[kind];
  const now = Date.now();
  const at = Math.max(now, lane.next, lane.pausedUntil);
  lane.next = at + lane.gapMs;
  if (at > now) await sleep(at - now);
}

function retryAfterMs(res) {
  const h = res.headers?.get?.("retry-after");
  const n = Number(h);
  if (Number.isFinite(n) && n > 0) return Math.min(10000, n * 1000);
  return null;
}

/** One Kalshi call, paced, with 429 retries. Returns the fetch Response and its text. */
async function paced(kind, method, requestPath, url, body) {
  for (let attempt = 0; ; attempt++) {
    await takeSlot(kind);
    rateStats[kind === "read" ? "reads" : "writes"] += 1;
    const headers = { ...signRequest(method, requestPath), ...(body != null ? { "Content-Type": "application/json" } : {}) };
    const res = await fetch(url, { method, headers, ...(body != null ? { body } : {}) });
    const text = await res.text();
    if (res.status !== 429) {
      if (attempt > 0) rateStats.retriedOk += 1;
      return { res, text };
    }
    rateStats.limited += 1;
    rateStats.last429At = new Date().toISOString();
    rateStats.lastPath = requestPath;
    if (attempt >= RETRY_WAITS_MS.length) {
      rateStats.gaveUp += 1;
      return { res, text };
    }
    const wait = retryAfterMs(res) ?? RETRY_WAITS_MS[attempt];
    lanes[kind].pausedUntil = Math.max(lanes[kind].pausedUntil, Date.now() + wait);
  }
}

/** For the monitor: calls made, 429s seen, retries that then succeeded, and calls that gave up. */
export function kalshiRateStats() {
  return { readsPerSec: READS_PER_SEC, writesPerSec: WRITES_PER_SEC, ...rateStats };
}

export async function kalshiGet(requestPath, query = "") {
  const { res, text } = await paced("read", "GET", requestPath, `${root()}${requestPath}${query}`, null);
  if (!res.ok) throw new Error(`Kalshi API error ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

export async function kalshiPost(requestPath, body) {
  const { res, text } = await paced("write", "POST", requestPath, `${root()}${requestPath}`, JSON.stringify(body));
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Kalshi API error ${res.status}: ${text}`);
  return data;
}

/**
 * DELETE with an optional query string. The query is NOT part of the signed
 * message - Kalshi signs the path only, exactly as kalshiGet does. Cancelling
 * an order on a non-default exchange shard needs `?exchange_index=` here, or
 * the cancel is sent to shard 0 and misses the order.
 */
export async function kalshiDelete(requestPath, query = "") {
  const { res, text } = await paced("write", "DELETE", requestPath, `${root()}${requestPath}${query}`, null);
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Kalshi API error ${res.status}: ${text}`);
  return data;
}
