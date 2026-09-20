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

export async function kalshiGet(requestPath, query = "") {
  const headers = signRequest("GET", requestPath);
  const res = await fetch(`${root()}${requestPath}${query}`, { method: "GET", headers });
  if (!res.ok) throw new Error(`Kalshi API error ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function kalshiPost(requestPath, body) {
  const headers = { ...signRequest("POST", requestPath), "Content-Type": "application/json" };
  const res = await fetch(`${root()}${requestPath}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Kalshi API error ${res.status}: ${text}`);
  return data;
}

export async function kalshiDelete(requestPath) {
  const headers = signRequest("DELETE", requestPath);
  const res = await fetch(`${root()}${requestPath}`, { method: "DELETE", headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Kalshi API error ${res.status}: ${text}`);
  return data;
}
