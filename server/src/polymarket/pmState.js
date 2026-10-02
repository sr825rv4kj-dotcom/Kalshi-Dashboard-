/**
 * polymarket/pmState.js
 *
 * Where Polymarket positions and engine status live: state.pmPositions and
 * state.pmMeta, next to the Kalshi positions in the same state file, so they
 * survive restarts and redeploys on the persistent volume.
 *
 * Kept free of any Polymarket or scanner import on purpose: scanner.js reads
 * polymarketTeamOnGame() to see which team Polymarket holds in a game, and
 * that must never create an import cycle.
 *
 * SAME TRADES ON BOTH EXCHANGES (2026-09-28, account holder's rule). The old
 * rule was one bet per game across both exchanges, which handed every game to
 * whichever exchange scanned it first - Kalshi, every cycle - so Polymarket
 * never got a game Kalshi had. Now a game may be held on BOTH, on the SAME
 * team: each exchange buys it when ITS price clears the same rules. The other
 * team of a game held on either exchange is never bought, so the two
 * accounts are never on opposite sides of one game.
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
 * True when a Polymarket position is open on this game - same sport, same
 * start, and either team named. (Polymarket's own one-bet-per-game check.)
 */
export function heldOnPolymarket({ sportKey, commenceTime, teamNames }) {
  const names = new Set((teamNames || []).map(normName).filter(Boolean));
  if (!names.size) return false;
  return pmPositions().some((p) =>
    p.sportKey === sportKey && sameStart(p.commenceTime, commenceTime) &&
    (names.has(normName(p.teamName)) || names.has(normName(p.opponent)))
  );
}

/** Every Polymarket position held on this game (for the double-down check). */
export function pmPositionsOnGame({ sportKey, commenceTime, teamNames }) {
  const names = new Set((teamNames || []).map(normName).filter(Boolean));
  if (!names.size) return [];
  return pmPositions().filter((p) =>
    p.sportKey === sportKey && sameStart(p.commenceTime, commenceTime) &&
    (names.has(normName(p.teamName)) || names.has(normName(p.opponent)))
  );
}

/** The mirror check: a Kalshi position (or resting bid) already on this game. */
export function heldOnKalshi({ sportKey, commenceTime, teamNames, restingOrders = [] }) {
  return kalshiTeamOnGame({ sportKey, commenceTime, teamNames, restingOrders }) != null;
}

/**
 * WHICH TEAM Kalshi holds in this game (a position or a resting bid), as a
 * normalised name, or null. Polymarket may then buy only that same team.
 */
export function kalshiTeamOnGame({ sportKey, commenceTime, teamNames, restingOrders = [] }) {
  const names = new Set((teamNames || []).map(normName).filter(Boolean));
  if (!names.size) return null;
  let positions = [];
  try { positions = loadState().positions || []; } catch { positions = []; }
  const rows = [...positions, ...restingOrders];
  const hit = rows.find((p) =>
    (p.sportKey == null || p.sportKey === sportKey) && p.commenceTime && sameStart(p.commenceTime, commenceTime) &&
    names.has(normName(p.teamName))
  );
  return hit ? normName(hit.teamName) : null;
}

/**
 * WHICH TEAM Polymarket holds in this game, as a normalised name, or null.
 * Kalshi may then buy only that same team.
 */
export function polymarketTeamOnGame({ sportKey, commenceTime, teamNames }) {
  const names = new Set((teamNames || []).map(normName).filter(Boolean));
  if (!names.size) return null;
  const hit = pmPositions().find((p) =>
    p.sportKey === sportKey && sameStart(p.commenceTime, commenceTime) &&
    (names.has(normName(p.teamName)) || names.has(normName(p.opponent)))
  );
  return hit ? normName(hit.teamName) : null;
}
