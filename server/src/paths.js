import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, "..");

const PERSIST_DIR = process.env.PERSIST_DIR || null;

export const DATA_DIR = PERSIST_DIR
  ? path.join(PERSIST_DIR, "data")
  : path.join(SERVER_ROOT, "data");

export const CONFIG_DIR = PERSIST_DIR
  ? path.join(PERSIST_DIR, "config")
  : path.join(SERVER_ROOT, "config");

export const ENV_PATH = PERSIST_DIR
  ? path.join(PERSIST_DIR, ".env")
  : path.join(SERVER_ROOT, ".env");

export const KEY_FILE_PATH = PERSIST_DIR
  ? path.join(PERSIST_DIR, "kalshi_private_key.pem")
  : path.join(SERVER_ROOT, "kalshi_private_key.pem");

const DEFAULT_CONFIG_DIR = path.join(SERVER_ROOT, "config");

export function bootstrapPersistentStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  if (PERSIST_DIR) {
    for (const filename of ["ticker-map.json", "polymarket-map.json", "bot-config.json"]) {
      const dest = path.join(CONFIG_DIR, filename);
      const src = path.join(DEFAULT_CONFIG_DIR, filename);
      if (!fs.existsSync(dest) && fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        console.log(`Bootstrapped ${filename} into persistent storage.`);
      }
    }
  }
}
