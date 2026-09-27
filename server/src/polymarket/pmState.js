/**
 * polymarket/pmState.js
 *
 * Where Polymarket positions and engine status live: state.pmPositions and
 * state.pmMeta, next to the Kalshi positions in the same state file, so they
 * survive restarts and redeploys on the persistent volume.
 *
 * Kept free of any Polymarket or scanner import on purpose: scanner.js reads
 * heldOnPolymarket() to stop the Kalshi side buying a game Polymarket already
 * holds, and that must never create an import cycle.
 */

import { loadState, saveState } from "../stateStore.js";

export function normName(s) {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

export function pmPositions() {
  try { return loadState().pmPositions || []; } catch { return []; }
}

export function savePmPositions(list) {
  const st = loadState();
  st.pmPositions = list;
  saveState(st);
}

export function pmMeta() {
  try { return loadState().pmMeta || {}; } catch { return {}; }
}

export function updatePmMeta(patch) {
  try {
    const st = loadState();
    st.pmMeta = { ...(st.pmMeta || {}), ...patch };
    saveState(st);
    return st.pmMeta;
  } catch {
    return null;
  }
}

function sameStart(a, b) {
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return String(a) === String(b);
  return Math.abs(x - y) < 3 * 60 * 60 * 1000;
}

/**
 * ONE BET PER GAME ACROSS BOTH EXCHANGES. True when a Polymarket position is
 * open on this game - same sport, same start, and either team named.
 */
export function heldOnPolymarket({ sportKey, commenceTime, teamNames }) {
  const names = new Set((teamNames || []).map(normName).filter(Boolean));
  if (!names.size) return false;
  return pmPositions().some((p) =>
    p.sportKey === sportKey && sameStart(p.commenceTime, commenceTime) &&
    (names.has(normName(p.teamName)) || names.has(normName(p.opponent)))
  );
}

/** The mirror check: a Kalshi position (or resting bid) already on this game. */
export function heldOnKalshi({ sportKey, commenceTime, teamNames, restingOrders = [] }) {
  const names = new Set((teamNames || []).map(normName).filter(Boolean));
  if (!names.size) return false;
  let positions = [];
  try { positions = loadState().positions || []; } catch { positions = []; }
  const rows = [...positions, ...restingOrders];
  return rows.some((p) =>
    (p.sportKey == null || p.sportKey === sportKey) && p.commenceTime && sameStart(p.commenceTime, commenceTime) &&
    names.has(normName(p.teamName))
  );
}
