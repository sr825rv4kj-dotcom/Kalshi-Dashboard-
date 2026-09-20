/**
 * backgroundStore.js
 *
 * Wallpaper persistence.
 *
 * This used to hold a single image data URL. It now holds the whole wallpaper
 * setting - which built-in animation is selected, any external media URLs, any
 * uploaded file, and the rotation preference - so the look follows the account
 * to whatever device opens the dashboard rather than living in one browser's
 * local storage.
 *
 * The old { dataUrl } shape is still read and still written back, so an
 * existing saved background survives the upgrade and older clients keep working.
 */
import fs from "fs";
import path from "path";
import { DATA_DIR } from "./paths.js";

const BACKGROUND_PATH = path.join(DATA_DIR, "background.json");

// Base64 inflates a file by about a third, so this is roughly a 6MB original.
// The ceiling is Express's own 10mb JSON body limit in index.js: anything
// larger is rejected by the body parser before this file ever sees it, which
// would surface as an opaque failure. Keeping the cap below that limit means
// the error the user gets is the real one. 6MB is ample for a looping
// wallpaper, and keeps the dashboard quick to open on cellular.
const MAX_BYTES = 9 * 1024 * 1024;

const ALLOWED_UPLOAD = /^data:(image\/(png|jpe?g|gif|webp|avif)|video\/(mp4|webm|quicktime));base64,/i;

function emptySettings() {
  return {
    active: { type: "builtin", key: "aurora" },
    library: [],
    rotate: false,
    rotateMinutes: 15,
    dataUrl: null,        // legacy field, kept populated for older clients
    updatedAt: null,
  };
}

function readFile() {
  if (!fs.existsSync(BACKGROUND_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(BACKGROUND_PATH, "utf8"));
  } catch {
    return null;          // corrupt file should not take the dashboard down
  }
}

function write(settings) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BACKGROUND_PATH, JSON.stringify(settings, null, 2));
  return settings;
}

/** Validates one library entry and strips anything unexpected. */
function sanitizeLibraryItem(item, index) {
  if (!item || typeof item !== "object") return null;
  const label = String(item.label ?? `Wallpaper ${index + 1}`).slice(0, 80);

  if (item.type === "upload") {
    const dataUrl = String(item.dataUrl ?? "");
    if (!ALLOWED_UPLOAD.test(dataUrl)) return null;
    if (dataUrl.length > MAX_BYTES) return null;
    return { id: String(item.id ?? `u${index}`), label, type: "upload", dataUrl };
  }

  const url = String(item.url ?? "");
  if (!/^https:\/\//i.test(url)) return null;   // https only - a http asset blocks on Railway's TLS
  return { id: String(item.id ?? `l${index}`), label, type: "url", url };
}

function sanitizeActive(active) {
  if (!active || typeof active !== "object") return { type: "builtin", key: "aurora" };
  if (active.type === "builtin") return { type: "builtin", key: String(active.key || "aurora").slice(0, 40) };
  if (active.type === "url" && /^https:\/\//i.test(String(active.url || ""))) {
    return { type: "url", url: String(active.url) };
  }
  if (active.type === "upload" && ALLOWED_UPLOAD.test(String(active.dataUrl || ""))) {
    if (String(active.dataUrl).length > MAX_BYTES) return { type: "builtin", key: "aurora" };
    return { type: "upload", dataUrl: String(active.dataUrl) };
  }
  if (active.type === "none") return { type: "none" };
  return { type: "builtin", key: "aurora" };
}

export function getBackground() {
  const stored = readFile();
  if (!stored) return emptySettings();

  // Legacy shape: a bare image data URL and nothing else.
  if (stored.dataUrl && !stored.active) {
    return {
      ...emptySettings(),
      active: { type: "upload", dataUrl: stored.dataUrl },
      dataUrl: stored.dataUrl,
      updatedAt: stored.updatedAt ?? null,
    };
  }

  return { ...emptySettings(), ...stored };
}

/**
 * Saves the whole wallpaper setting. Accepts either the new shape or a bare
 * { dataUrl } from an older client.
 */
export function saveBackground(payload) {
  // Older clients POST { dataUrl } and expect it to become the background.
  if (typeof payload === "string" || (payload && payload.dataUrl && !payload.active && !payload.library)) {
    const dataUrl = typeof payload === "string" ? payload : payload.dataUrl;
    if (!ALLOWED_UPLOAD.test(String(dataUrl))) {
      throw new Error("Expected an image or video data URL (png, jpg, gif, webp, mp4, webm).");
    }
    if (String(dataUrl).length > MAX_BYTES) {
      throw new Error("That file is too large - keep it under about 12MB.");
    }
    const current = getBackground();
    return write({
      ...current,
      active: { type: "upload", dataUrl },
      dataUrl,
      updatedAt: new Date().toISOString(),
    });
  }

  const incoming = payload || {};
  const current = getBackground();

  const library = Array.isArray(incoming.library)
    ? incoming.library.map(sanitizeLibraryItem).filter(Boolean).slice(0, 24)
    : current.library;

  const active = incoming.active !== undefined ? sanitizeActive(incoming.active) : current.active;

  const settings = {
    active,
    library,
    rotate: incoming.rotate !== undefined ? Boolean(incoming.rotate) : current.rotate,
    rotateMinutes: Math.min(720, Math.max(1, Number(incoming.rotateMinutes ?? current.rotateMinutes) || 15)),
    // Keep the legacy field pointing at an uploaded image so an older client
    // that only understands { dataUrl } still renders something sensible.
    dataUrl: active.type === "upload" ? active.dataUrl : null,
    updatedAt: new Date().toISOString(),
  };

  return write(settings);
}

export function clearBackground() {
  if (fs.existsSync(BACKGROUND_PATH)) fs.unlinkSync(BACKGROUND_PATH);
  return { cleared: true, ...emptySettings() };
}
