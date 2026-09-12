import fs from "fs";
import crypto from "crypto";
import path from "path";
import { DATA_DIR } from "./paths.js";
import { ENV_PATH } from "./paths.js";

const ACCOUNT_PATH = path.join(DATA_DIR, "account.json");
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

function getOrCreateAuthSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const existing = loadEnvMap();
  if (existing.AUTH_SECRET) {
    process.env.AUTH_SECRET = existing.AUTH_SECRET;
    return existing.AUTH_SECRET;
  }
  const secret = crypto.randomBytes(32).toString("hex");
  writeEnvMap({ ...existing, AUTH_SECRET: secret });
  process.env.AUTH_SECRET = secret;
  return secret;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

export function hasAccount() {
  return fs.existsSync(ACCOUNT_PATH);
}

export function createAccount(email, password) {
  if (hasAccount()) throw new Error("An account already exists. Use login instead.");
  if (!email || !password || password.length < 8) {
    throw new Error("Email and a password of at least 8 characters are required.");
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, salt);
  fs.writeFileSync(ACCOUNT_PATH, JSON.stringify({ email, salt, passwordHash }, null, 2), { mode: 0o600 });
  return issueToken(email);
}

export function verifyLogin(email, password) {
  if (!hasAccount()) throw new Error("No account exists yet - set one up first.");
  const account = JSON.parse(fs.readFileSync(ACCOUNT_PATH, "utf8"));
  if (email !== account.email) throw new Error("Incorrect email or password.");
  const candidateHash = hashPassword(password, account.salt);
  const match = crypto.timingSafeEqual(Buffer.from(candidateHash), Buffer.from(account.passwordHash));
  if (!match) throw new Error("Incorrect email or password.");
  return issueToken(email);
}

export function issueToken(email) {
  const secret = getOrCreateAuthSecret();
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ email, expiresAt })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyToken(token) {
  if (!token) return null;
  const secret = getOrCreateAuthSecret();
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expectedSignature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  if (signature.length !== expectedSignature.length) return null;
  const valid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  if (!valid) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (Date.now() > data.expiresAt) return null;
    return data;
  } catch {
    return null;
  }
}
