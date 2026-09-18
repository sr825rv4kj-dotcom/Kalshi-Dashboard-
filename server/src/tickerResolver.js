/**
 * Resolves a sportsbook team name + kickoff time to a live Kalshi ticker.
 * Kalshi titles games by city ("Seattle vs Texas"); sportsbooks send full
 * names ("Seattle Mariners"), so matching is on any significant word.
 *
 * The time filter is now advisory, not mandatory. It used to drop every event
 * whose strike_date and expected_expiration_time were both absent, which is
 * common enough that entire sports resolved at 0%. Now: filter by time when
 * times exist, and fall back to title matching across all open events when
 * they don't.
 */

import { kalshiGet } from "./kalshiClient.js";

const V2 = "/trade-api/v2";
const MATCH_WINDOW_HOURS = 14;
const CACHE_TTL_MS = 5 * 60 * 1000;

export const SPORT_SERIES_MAP = {
  americanfootball_nfl: "KXNFLGAME",
  americanfootball_ncaaf: "KXNCAAFGAME",
  basketball_nba: "KXNBAGAME",
  basketball_ncaab: "KXNCAABGAME",
  baseball_mlb: "KXMLBGAME",
  icehockey_nhl: "KXNHLGAME",
};

const NON_TEAM_OUTCOMES = new Set(["draw", "tie"]);
const cache = new Map();

function normalize(t) {
  return (t || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

/** Falls back to the first market's close_time when the event carries no date. */
function eventTimeMs(e) {
  const direct = e.strike_date ?? e.expected_expiration_time;
  if (direct) {
    const ms = new Date(direct).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  for (const m of e.markets ?? []) {
    const t = m.close_time ?? m.expected_expiration_time ?? m.open_time;
    if (t) {
      const ms = new Date(t).getTime();
      if (!Number.isNaN(ms)) return ms;
    }
  }
  return null;
}

async function getOpenEvents(series) {
  const hit = cache.get(series);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.events;
  const data = await kalshiGet(
    `${V2}/events`,
    `?series_ticker=${series}&status=open&with_nested_markets=true&limit=200`
  );
  const events = data.events ?? [];
  cache.set(series, { events, at: Date.now() });
  return events;
}

export async function resolveTicker({ sportKey, teamName, commenceTime }) {
  if (NON_TEAM_OUTCOMES.has((teamName || "").toLowerCase().trim())) {
    return { ticker: null, reason: "draw/tie is not a two-sided market" };
  }

  const series = SPORT_SERIES_MAP[sportKey];
  if (!series) return { ticker: null, reason: `no Kalshi series for "${sportKey}"` };

  let events;
  try {
    events = await getOpenEvents(series);
  } catch (err) {
    return { ticker: null, reason: `${series} events fetch failed: ${err.message}` };
  }
  if (!events.length) return { ticker: null, reason: `${series} returned 0 open events` };

  const target = new Date(commenceTime).getTime();
  const timed = events.map((e) => ({ e, ms: eventTimeMs(e) }));
  const inWindow = Number.isNaN(target)
    ? []
    : timed.filter((x) => x.ms != null && Math.abs(x.ms - target) <= MATCH_WINDOW_HOURS * 3600 * 1000);

  // Time is a narrowing tool, not a gate. If it narrows to nothing, match names
  // across every open event rather than giving up on the sport entirely.
  const pool = inWindow.length ? inWindow : timed;
  const usedWindow = inWindow.length > 0;

  const words = normalize(teamName).split(" ").filter((w) => w.length > 2);
  if (!words.length) return { ticker: null, reason: `no usable words in "${teamName}"` };

  const matches = pool.filter((x) => words.some((w) => normalize(x.e.title).includes(w)));
  if (!matches.length) {
    return {
      ticker: null,
      reason:
        `no title match for "${teamName}" among ${pool.length} ${series} events` +
        (usedWindow ? " in window" : " (window empty, searched all)") +
        `, e.g. "${pool[0].e.title}"`,
    };
  }

  // A team can appear in several fixtures; take the one closest to the
  // sportsbook's kickoff time. Undated events sort last.
  const best = matches.reduce((a, b) => {
    const da = a.ms == null ? Infinity : Math.abs(a.ms - target);
    const db = b.ms == null ? Infinity : Math.abs(b.ms - target);
    return db < da ? b : a;
  });
  const event = best.e;

  const market = (event.markets ?? []).find((m) =>
    words.some((w) => normalize(`${m.yes_sub_title ?? ""} ${m.subtitle ?? ""} ${m.title ?? ""}`).includes(w))
  );
  if (!market) {
    const sides = (event.markets ?? []).map((m) => m.yes_sub_title || m.subtitle || m.ticker).join(" | ");
    return { ticker: null, reason: `matched "${event.title}" but no side matched "${teamName}" (sides: ${sides || "none"})` };
  }

  return { ticker: market.ticker, reason: `resolved via ${series} "${event.title}"` };
}
