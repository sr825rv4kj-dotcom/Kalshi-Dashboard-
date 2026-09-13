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
