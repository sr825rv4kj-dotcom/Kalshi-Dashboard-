import fs from "fs";
import { ENV_PATH } from "./paths.js";

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

export function saveTelegramConfig({ botToken, chatId }) {
  const existing = loadEnvMap();
  if (botToken) existing.TELEGRAM_BOT_TOKEN = botToken;
  if (chatId) existing.TELEGRAM_CHAT_ID = chatId;
  writeEnvMap(existing);
  if (botToken) process.env.TELEGRAM_BOT_TOKEN = botToken;
  if (chatId) process.env.TELEGRAM_CHAT_ID = chatId;
  return getTelegramStatus();
}

export function getTelegramStatus() {
  return { configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) };
}

export function getTelegramCredentials() {
  return { botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID };
}
