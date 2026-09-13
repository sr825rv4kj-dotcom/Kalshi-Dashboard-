import fs from "fs";
import path from "path";
import { DATA_DIR } from "./paths.js";

const BACKGROUND_PATH = path.join(DATA_DIR, "background.json");
const MAX_BYTES = 8 * 1024 * 1024; // 8MB, generous for a background image as base64

export function saveBackground(dataUrl) {
  if (!dataUrl || !dataUrl.startsWith("data:image/")) {
    throw new Error("Expected a data:image/... URL.");
  }
  if (dataUrl.length > MAX_BYTES) {
    throw new Error("Image is too large (max ~6MB original file).");
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BACKGROUND_PATH, JSON.stringify({ dataUrl, updatedAt: new Date().toISOString() }));
  return { saved: true };
}

export function getBackground() {
  if (!fs.existsSync(BACKGROUND_PATH)) return { dataUrl: null };
  return JSON.parse(fs.readFileSync(BACKGROUND_PATH, "utf8"));
}

export function clearBackground() {
  if (fs.existsSync(BACKGROUND_PATH)) fs.unlinkSync(BACKGROUND_PATH);
  return { cleared: true };
}
