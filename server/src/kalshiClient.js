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

function getPrivateKey() {
  const { keyPath, keyPem } = getConfig();
  if (cachedPrivateKey) return cachedPrivateKey;

  if (keyPem) {
    cachedPrivateKey = keyPem.replace(/\\n/g, "\n");
    return cachedPrivateKey;
  }

  if (!keyPath || !fs.existsSync(keyPath)) {
    throw new Error(
      `Kalshi private key not found. Set KALSHI_PRIVATE_KEY_PEM (recommended for Railway) or ` +
      `KALSHI_PRIVATE_KEY_PATH to a file, or enter credentials in the app.`
    );
  }
  cachedPrivateKey = fs.readFileSync(keyPath, "utf8");
  return cachedPrivateKey;
}

export function resetCredentialsCache() {
  cachedPrivateKey = null;
}

export function hasCredentialsConfigured() {
  const { keyId, keyPath, keyPem } = getConfig();
  if (!keyId) return false;
  if (keyPem) return true;
  return Boolean(keyPath && fs.existsSync(keyPath));
}

function signRequest(method, requestPath) {
  const { keyId } = getConfig();
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

export async function kalshiGet(requestPath, query = "") {
  const { baseUrl } = getConfig();
  const headers = signRequest("GET", requestPath);
  const url = `${baseUrl.replace("/trade-api/v2", "")}${requestPath}${query}`;
  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) throw new Error(`Kalshi API error ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function kalshiPost(requestPath, body) {
  const { baseUrl } = getConfig();
  const headers = { ...signRequest("POST", requestPath), "Content-Type": "application/json" };
  const url = `${baseUrl.replace("/trade-api/v2", "")}${requestPath}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Kalshi API error ${res.status}: ${text}`);
  return data;
}

export async function kalshiDelete(requestPath) {
  const { baseUrl } = getConfig();
  const headers = signRequest("DELETE", requestPath);
  const url = `${baseUrl.replace("/trade-api/v2", "")}${requestPath}`;
  const res = await fetch(url, { method: "DELETE", headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Kalshi API error ${res.status}: ${text}`);
  return data;
}
