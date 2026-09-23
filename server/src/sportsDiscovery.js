/**
 * sportsDiscovery.js
 *
 * Decides which sports the scanner actually spends a cycle on.
 *
 * ---------------------------------------------------------------------------
 * THE SCANNER WAS WORKING ON THE WRONG UNIVERSE (2026-09-22)
 * ---------------------------------------------------------------------------
 * A production tally, 60 lines across 75 sports in one minute, entered 0:
 *
 *     55  no games on the board (nothing to price)
 *     16  Kalshi has the sport but nothing is open right now
 *     12  Kalshi lists no markets at all for this sport
 *     12  only found on a different date
 *     13  edge too small to clear the fee
 *
 * Eighty-three of those rows are the same fact said three ways: the sport has
 * nothing to trade. Every one of them still cost a scan slot and, for most, an
 * Odds API call - every cycle, all day, whether or not the sport had produced
 * a single tradeable market in a week. Meanwhile the twelve sports that DO
 * trade were sharing what was left of the cycle.
 *
 * The 13 "edge too small" rows are the bot working correctly. Nothing here
 * touches them. What this fixes is the 83 rows of dead weight in front of them.
 *
 * TWO GATES, both of which cost nothing when a sport is healthy:
 *
 *   1. ADDRESSABLE. No Kalshi series, no scan. Already the intent; now it is
 *      enforced against a matcher that can no longer invent a series (see
 *      seriesDiscovery.js - it was binding Swedish hockey to Baller League).
 *
 *   2. QUARANTINE. A sport whose last few scans produced nothing but board
 *      conditions - no lines, no open markets, no series content - is parked
 *      for six hours and then automatically re-probed. Seasons start and end;
 *      nothing here is permanent and nothing needs maintaining.
 *
 * Quarantine reads the per-sport scan records the scanner already writes, so
 * no other file changes and no new bookkeeping is introduced into the hot
 * path. A sport that enters a trade, or that gets far enough to be refused by
 * a THRESHOLD rather than by the board, clears its strikes immediately.
 * ---------------------------------------------------------------------------
 */

import { getSeriesMap } from "./tickerResolver.js";
import { loadState, saveState, appendLog } from "./stateStore.js";

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h - season status barely moves

export const SPORTS_DISCOVERY_VERSION = "2026-09-22-no-outrights";

/** Consecutive barren scans before a sport is parked. */
const STRIKES_TO_PARK = 3;
/** How long a parked sport stays parked before it is tried again. */
const PARK_MS = 6 * 60 * 60 * 1000;
/** A scan record older than this is ignored - it says nothing about now. */
const FRESH_MS = 15 * 60 * 1000;

let cache = null;

/**
 * Refusal codes that describe the BOARD, not a decision the bot made.
 *
 * This list is the whole basis of the quarantine, so it is deliberately
 * narrow: only codes that mean "there is nothing here to trade". A sport
 * refused for edge, price, spread, liquidity or staleness is a sport that
 * reached the entry gate with a real market in hand - that is a healthy scan
 * that happened to say no, and it must never be parked for it.
 */
const BOARD_CONDITIONS = new Set([
  "no-lines-from-provider",
  "unresolved:series-empty",
  "unresolved:none-tradeable",
  "unresolved:no-series",
  "unresolved:fetch-failed",
  "unresolved:draw-or-tie",
  "odds-fetch-failed",
  "dropped:window",
]);

/**
 * FUTURES ARE NOT GAMES (2026-09-22).
 *
 * The odds feed lists outright markets - "golf_masters_tournament_winner",
 * "politics_us_presidential_election_winner", "..._super_bowl_winner" - as
 * sports in their own right, flagged has_outrights. The scanner prices
 * head-to-head GAME lines only, so every one of those failed its odds request
 * every cycle. Production 22:06: six "Sharp odds feed failed" rows, all six
 * outrights, which the health report then named as the MAIN blocker - pointing
 * at the odds API key when nothing was wrong with it.
 */
function isGameSport(s) {
  return s && s.active && !s.has_outrights && !/_winner$/.test(String(s.key || ""));
}

/** Every sport the odds feed currently reports as active, mapped or not. */
export async function allActiveSportKeys() {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch(`${ODDS_API_BASE}/sports?apiKey=${apiKey}`);
    if (!res.ok) return [];
    const all = await res.json();
    return all.filter(isGameSport).map((s) => s.key);
  } catch {
    return [];
  }
}

/**
 * True when the most recent scan of this sport found nothing tradeable AND
 * every refusal it recorded was a board condition.
 *
 * Returns null when there is no fresh record, which is treated as "no
 * evidence" rather than as a strike. A sport must actually be observed doing
 * nothing before it is parked for it.
 */
function barrenScan(record) {
  if (!record) return null;
  const at = Date.parse(record.at);
  if (!Number.isFinite(at) || Date.now() - at > FRESH_MS) return null;
  if ((record.entered || 0) > 0) return false;

  const codes = Object.keys(record.reasons || {});
  if (!codes.length) {
    // Seen lines, refused nothing, entered nothing. That is not barren - it is
    // a sport whose markets were all already held or filtered upstream.
    return (record.seen || 0) === 0;
  }
  return codes.every((c) => BOARD_CONDITIONS.has(c));
}

/**
 * Updates strike counts from the scanner's own records and returns the set of
 * sports currently parked.
 *
 * All state lives under state.sportHealth as { strikes, parkedUntil, lastSeen }
 * so it survives a restart and shows up in the state file for inspection.
 */
function applyQuarantine(candidates) {
  let state;
  try { state = loadState(); } catch { return new Set(); }

  const health = state.sportHealth && typeof state.sportHealth === "object" ? state.sportHealth : {};
  const scans = state.lastScan || {};
  const now = Date.now();
  const parked = new Set();
  const justParked = [];
  const justReleased = [];
  let dirty = false;

  for (const sportKey of candidates) {
    const h = health[sportKey] || { strikes: 0, parkedUntil: 0 };
    const verdict = barrenScan(scans[sportKey]);

    if (verdict === false) {
      // Healthy scan. Clear everything - a sport that produced a real decision
      // has earned a clean slate, including release from an active park.
      if (h.strikes || h.parkedUntil) {
        if (h.parkedUntil > now) justReleased.push(sportKey);
        health[sportKey] = { strikes: 0, parkedUntil: 0, lastSeen: now };
        dirty = true;
      }
      continue;
    }

    if (verdict === true) {
      h.strikes = (h.strikes || 0) + 1;
      h.lastSeen = now;
      if (h.strikes >= STRIKES_TO_PARK && !(h.parkedUntil > now)) {
        h.parkedUntil = now + PARK_MS;
        justParked.push(sportKey);
      }
      health[sportKey] = h;
      dirty = true;
    }

    if (h.parkedUntil > now) {
      parked.add(sportKey);
    } else if (h.parkedUntil) {
      // Park expired. Reset to zero strikes so the sport gets a genuine fresh
      // run of chances rather than being re-parked on its first barren scan.
      health[sportKey] = { strikes: 0, parkedUntil: 0, lastSeen: now };
      justReleased.push(sportKey);
      dirty = true;
    }
  }

  // Forget sports the feed no longer lists, so this cannot grow forever.
  const live = new Set(candidates);
  for (const k of Object.keys(health)) {
    if (!live.has(k)) { delete health[k]; dirty = true; }
  }

  if (dirty) {
    try {
      state.sportHealth = health;
      saveState(state);
    } catch {
      // bookkeeping must never be the reason a cycle fails
    }
  }

  if (justParked.length) {
    appendLog(
      `Parked ${justParked.length} sport(s) for 6h after ${STRIKES_TO_PARK} scans with nothing on the board: ` +
      `${justParked.join(", ")}. They are re-probed automatically - no action needed.`
    );
  }
  if (justReleased.length) {
    appendLog(`Un-parked ${justReleased.length} sport(s) - back in the rotation: ${justReleased.join(", ")}.`);
  }

  return parked;
}

export async function discoverActiveSports() {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) return [];

  let all = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS ? cache.all : null;

  if (!all) {
    try {
      const res = await fetch(`${ODDS_API_BASE}/sports?apiKey=${apiKey}`);
      if (!res.ok) return cache?.sports ?? [];
      const body = await res.json();
      all = body.filter(isGameSport).map((s) => s.key);
      cache = { all, sports: cache?.sports ?? [], fetchedAt: Date.now() };
    } catch {
      return cache?.sports ?? [];
    }
  }

  // Gate 1: addressable. Filter against the DISCOVERED map. Filtering against
  // six hardcoded rows is what made WNBA, tennis and soccer invisible to the
  // scanner while they were live on Kalshi.
  const seriesMap = getSeriesMap();
  const addressable = all.filter((k) => seriesMap[k]);

  // Gate 2: quarantine. Evaluated EVERY call, not cached, because the strikes
  // come from scans that happen between calls. Caching this was what would
  // have made a parked sport stay parked through a season opener.
  const parked = applyQuarantine(addressable);
  const sports = addressable.filter((k) => !parked.has(k));

  if (cache) cache.sports = sports;

  if (!sports.length && addressable.length) {
    // Never hand back an empty list because everything happened to be parked -
    // that would stop trading outright. Release the parks and scan anyway.
    appendLog("Every addressable sport is parked - releasing all parks and scanning the full list.", "warn");
    try {
      const st = loadState();
      st.sportHealth = {};
      saveState(st);
    } catch { /* best effort */ }
    return addressable;
  }

  return sports;
}

/** What the gates last concluded, for the dashboard and self-check. */
export function sportsHealthReport() {
  let state;
  try { state = loadState(); } catch { return null; }
  const health = state.sportHealth || {};
  const now = Date.now();
  const parked = [];
  const striking = [];
  for (const [k, h] of Object.entries(health)) {
    if (h.parkedUntil > now) {
      parked.push({ sportKey: k, minutesLeft: Math.round((h.parkedUntil - now) / 60000) });
    } else if (h.strikes) {
      striking.push({ sportKey: k, strikes: h.strikes });
    }
  }
  return {
    parked: parked.sort((a, b) => b.minutesLeft - a.minutesLeft),
    striking: striking.sort((a, b) => b.strikes - a.strikes),
    strikesToPark: STRIKES_TO_PARK,
    parkHours: PARK_MS / 3600000,
  };
}

export function clearSportsCache() {
  cache = null;
}

/** Clears every strike and park. Exposed so the dashboard can force a rescan. */
export function clearSportQuarantine() {
  try {
    const st = loadState();
    st.sportHealth = {};
    saveState(st);
    return true;
  } catch {
    return false;
  }
}
