import fs from "fs";
import path from "path";
import { DATA_DIR } from "./paths.js";

const STATE_PATH = path.join(DATA_DIR, "state.json");

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

function ensureFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_PATH)) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(defaultState(), null, 2));
  }
}

export function loadState() {
  ensureFile();
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

export function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  return state;
}

export function appendLog(message, level = "info") {
  const state = loadState();
  state.log.push({ time: new Date().toISOString(), level, message });
  if (state.log.length > 500) state.log = state.log.slice(-500);
  saveState(state);
  console.log(`[${level}] ${message}`);
}

export function getRecentLog(limit = 100) {
  const state = loadState();
  return state.log.slice(-limit).reverse();
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
