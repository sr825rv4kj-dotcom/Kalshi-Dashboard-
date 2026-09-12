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
