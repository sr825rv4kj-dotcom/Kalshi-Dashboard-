import fs from "fs";
import path from "path";
import { DATA_DIR } from "./paths.js";

const STATE_PATH = path.join(DATA_DIR, "state.json");
const BACKUP_PATH = path.join(DATA_DIR, "state.backup.json");
const BACKUP_EVERY_MS = 60 * 1000;

export const STATE_STORE_VERSION = "2026-10-04-atomic-state";

/**
 * 2026-10-04: THE STATE FILE WAS WRITTEN IN PLACE, AND A HALF-WRITTEN FILE
 * STOPPED THE BOT. Production 16:37Z: "Could not read state: Unexpected end
 * of JSON input" - state.json was cut off mid-write (a redeploy or restart
 * killing the process during fs.writeFileSync, which truncates the file
 * first and fills it after). Every loadState() then threw, so the bot,
 * the schedule panel and the monitor all failed until a human intervened.
 *
 * Now:
 *   - every save goes to a temporary file that is then RENAMED over
 *     state.json. A rename is atomic: the file on disk is always either the
 *     old complete state or the new complete state, never half of one.
 *   - a backup copy (state.backup.json) is written at most once a minute.
 *   - if state.json still cannot be read, the backup is used; if that fails
 *     too, whatever complete pieces of the broken file can still be read
 *     (open positions, Polymarket positions, priors, exits, halt status) are
 *     kept, the broken file is set aside as state.corrupt-<time>.json for
 *     inspection, and the bot carries on instead of stopping.
 */

function defaultState() {
  return {
    running: false,
    dayStartBalance: null,
    dayStartDate: null,
    haltedForDay: false,
    haltReason: null,
    positions: [],
    log: [],
    botStartedAt: null,
  };
}

/** Write a file so it is never seen half-written: temp file, then rename. */
export function atomicWriteFileSync(file, text, options = undefined) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, options);
  fs.renameSync(tmp, file);
}

function ensureFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_PATH)) {
    atomicWriteFileSync(STATE_PATH, JSON.stringify(defaultState(), null, 2));
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * The complete JSON value that follows `"key":` in a broken file, or
 * undefined. Walks brackets and strings so a value is only returned whole.
 */
function salvageKey(text, key) {
  const at = text.indexOf(`"${key}"`);
  if (at < 0) return undefined;
  let i = text.indexOf(":", at + key.length + 2);
  if (i < 0) return undefined;
  i++;
  while (i < text.length && /\s/.test(text[i])) i++;
  const start = i;
  const open = text[i];
  if (open !== "[" && open !== "{") {
    const m = /^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?|"(?:[^"\\]|\\.)*")/.exec(text.slice(i));
    if (!m) return undefined;
    try { return JSON.parse(m[0]); } catch { return undefined; }
  }
  let depth = 0;
  let inStr = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") inStr = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return undefined; }
      }
    }
  }
  return undefined;   // cut off before the value closed
}

const SALVAGE_KEYS = [
  "positions", "pmPositions", "pmMeta", "pregamePriors", "recentExits",
  "dayStartBalance", "dayStartDate", "haltedForDay", "haltReason", "haltDate",
  "botStartedAt", "running", "sportHealth", "doubledDown",
];

function recoverState(err) {
  // 1. The backup.
  try {
    const backup = readJson(BACKUP_PATH);
    if (backup && typeof backup === "object") {
      atomicWriteFileSync(STATE_PATH, JSON.stringify(backup, null, 2));
      console.error(`[state] state.json unreadable (${err.message}) - restored from state.backup.json`);
      return backup;
    }
  } catch { /* no usable backup - salvage below */ }

  // 2. Whatever complete pieces the broken file still holds.
  let text = "";
  try { text = fs.readFileSync(STATE_PATH, "utf8"); } catch { text = ""; }
  const state = defaultState();
  const kept = [];
  for (const key of SALVAGE_KEYS) {
    const v = salvageKey(text, key);
    if (v !== undefined) { state[key] = v; kept.push(key); }
  }
  if (!Array.isArray(state.positions)) state.positions = [];
  if (!Array.isArray(state.log)) state.log = [];
  try {
    if (text.length) fs.renameSync(STATE_PATH, path.join(DATA_DIR, `state.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
  } catch { /* setting it aside is best-effort */ }
  state.log.push({
    time: new Date().toISOString(), level: "error",
    message: `State file was unreadable (${err.message}) and there was no backup - rebuilt it. ` +
      `Recovered: ${kept.length ? kept.join(", ") : "nothing (the file was empty)"}. ` +
      `${state.positions.length} open Kalshi position(s) on record.`,
  });
  atomicWriteFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.error(`[state] state.json unreadable (${err.message}) - rebuilt; recovered ${kept.join(", ") || "nothing"}`);
  return state;
}

export function loadState() {
  ensureFile();
  try {
    return readJson(STATE_PATH);
  } catch (err) {
    return recoverState(err);
  }
}

let lastBackupAt = 0;

export function saveState(state) {
  const text = JSON.stringify(state, null, 2);
  atomicWriteFileSync(STATE_PATH, text);
  const now = Date.now();
  if (now - lastBackupAt >= BACKUP_EVERY_MS) {
    try { atomicWriteFileSync(BACKUP_PATH, text); lastBackupAt = now; } catch { /* the main write already succeeded */ }
  }
  return state;
}

export function appendLog(message, level = "info") {
  const state = loadState();
  state.log = Array.isArray(state.log) ? state.log : [];
  state.log.push({ time: new Date().toISOString(), level, message });
  if (state.log.length > 500) state.log = state.log.slice(-500);
  saveState(state);
  console.log(`[${level}] ${message}`);
}

export function getRecentLog(limit = 100) {
  const state = loadState();
  return (Array.isArray(state.log) ? state.log : []).slice(-limit).reverse();
}

/**
 * THE TRADING DAY IS THE PACIFIC DAY (2026-10-01). Every daily rule - the
 * daily loss halt on both exchanges, the daily summary, the watchdog's halt
 * clearing - used new Date().toDateString(), which on Railway is the UTC day.
 * The day rolled over at 5pm Pacific, so a halt taken at 7pm Pacific lasted
 * until 5pm the next afternoon. Same "Thu Oct 01 2026" format as before.
 */
export function tradingDay(d = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "2-digit", year: "numeric" })
      .formatToParts(d instanceof Date ? d : new Date(d)).map((p) => [p.type, p.value])
  );
  return `${parts.weekday} ${parts.month} ${parts.day} ${parts.year}`;
}
