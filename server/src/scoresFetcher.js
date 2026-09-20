/**
 * scoresFetcher.js
 *
 * Fetches real final scores from The-Odds-API's /scores endpoint so the
 * trade log can show how a game actually ended, not just the P&L.
 *
 * COST NOTE: this endpoint is billed separately from the odds endpoint.
 * Per The-Odds-API's own docs, /scores with daysFrom set costs more than
 * a plain odds call, so this is deliberately:
 *   - only called for trades that are already settled/closed
 *   - cached per (sportKey, day) so one call covers every trade that day
 *   - never called on the hot scanning path
 */

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h - final scores don't change

const scoreCache = new Map(); // sportKey -> { events, fetchedAt }

export async function getRecentScores(sportKey, daysFrom = 3) {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) return { events: [], error: "THE_ODDS_API_KEY not set" };

  const cached = scoreCache.get(sportKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { events: cached.events, cached: true };
  }

  const url = `${ODDS_API_BASE}/sports/${sportKey}/scores?apiKey=${apiKey}&daysFrom=${daysFrom}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { events: [], error: `scores fetch ${res.status}` };
    const events = await res.json();
    scoreCache.set(sportKey, { events, fetchedAt: Date.now() });
    return { events, quotaRemaining: res.headers.get("x-requests-remaining") };
  } catch (err) {
    return { events: [], error: err.message };
  }
}

/**
 * Finds the completed game matching a team name, returning both teams'
 * final scores. Returns null when no confident match exists - never guesses.
 */
export function findScoreForTeam(events, teamName) {
  if (!teamName) return null;
  const needle = teamName.toLowerCase().trim();

  const match = (events || []).find((e) => {
    if (!e.completed) return false;
    const home = (e.home_team || "").toLowerCase();
    const away = (e.away_team || "").toLowerCase();
    return home.includes(needle) || away.includes(needle) || needle.includes(home) || needle.includes(away);
  });

  if (!match || !Array.isArray(match.scores)) return null;

  const scoreFor = (name) => {
    const entry = match.scores.find((s) => (s.name || "").toLowerCase() === (name || "").toLowerCase());
    return entry ? Number(entry.score) : null;
  };

  return {
    homeTeam: match.home_team,
    awayTeam: match.away_team,
    homeScore: scoreFor(match.home_team),
    awayScore: scoreFor(match.away_team),
    completed: match.completed,
    commenceTime: match.commence_time,
  };
}

/**
 * LIVE scores, for the in-play win-probability model.
 *
 * Separate from getRecentScores above because the requirements are opposite:
 * that one serves settled trades and caches for an hour, this one has to be
 * fresh enough to price a game in progress.
 *
 * COST. /scores is billed separately from /odds, so this is kept cheap:
 *   - cached per sport for LIVE_CACHE_MS, so a 20-second scan cadence makes
 *     at most one call every 90 seconds per sport
 *   - daysFrom=1, the smallest window that still covers today's slate
 *   - only ever called by the scanner when an in-play candidate actually
 *     exists, so a pre-game-only slate costs nothing
 */
const LIVE_CACHE_MS = 90 * 1000;
const liveCache = new Map(); // sportKey -> { events, fetchedAt }

export async function getLiveScores(sportKey) {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) return { events: [], error: "THE_ODDS_API_KEY not set" };

  const cached = liveCache.get(sportKey);
  if (cached && Date.now() - cached.fetchedAt < LIVE_CACHE_MS) {
    return { events: cached.events, cached: true };
  }

  try {
    const res = await fetch(`${ODDS_API_BASE}/sports/${sportKey}/scores?apiKey=${apiKey}&daysFrom=1`);
    if (!res.ok) return { events: cached?.events ?? [], error: `live scores ${res.status}` };
    const events = await res.json();
    liveCache.set(sportKey, { events, fetchedAt: Date.now() });
    return { events, quotaRemaining: res.headers.get("x-requests-remaining") };
  } catch (err) {
    // Serve the last good copy rather than nothing - a 90s-old score is a far
    // better input than refusing to model the game at all.
    return { events: cached?.events ?? [], error: err.message };
  }
}

/** Loose two-way name match, same approach the ticker resolver uses. */
function namesMatch(a, b) {
  const x = String(a || "").toLowerCase().trim();
  const y = String(b || "").toLowerCase().trim();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * Current margin for `teamName` in an IN-PROGRESS game, from that team's own
 * point of view: positive means ahead.
 *
 * Returns null when the game is not found, is already completed, or has no
 * usable scores - all of which the caller must treat as "cannot model", never
 * as a zero lead.
 */
export function findLiveGameForTeam(events, teamName) {
  if (!teamName) return null;

  const match = (events || []).find((e) => {
    if (e.completed) return null;
    if (!Array.isArray(e.scores) || !e.scores.length) return false;
    return namesMatch(e.home_team, teamName) || namesMatch(e.away_team, teamName);
  });
  if (!match) return null;

  const scoreFor = (name) => {
    const row = (match.scores || []).find((s) => namesMatch(s.name, name));
    const n = row ? Number(row.score) : NaN;
    return Number.isFinite(n) ? n : null;
  };

  const home = scoreFor(match.home_team);
  const away = scoreFor(match.away_team);
  if (home == null || away == null) return null;

  const isHome = namesMatch(match.home_team, teamName);
  return {
    homeTeam: match.home_team, awayTeam: match.away_team,
    homeScore: home, awayScore: away,
    lead: isHome ? home - away : away - home,
    commenceTime: match.commence_time,
    lastUpdate: match.last_update ?? null,
  };
}
