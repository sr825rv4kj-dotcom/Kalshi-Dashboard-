/**
 * seasonCalendar.js
 *
 * Filters a pool of candidate sports down to whichever are actually in
 * season right now, so the bot never burns odds-API quota scanning a
 * sport that's on its off-season (e.g. MLB in January, NBA in August).
 *
 * Windows are approximate real-world season boundaries, generous on
 * both ends (better to scan a few extra weeks than miss the season
 * opener). Any sport key NOT listed here - tournament-specific tennis
 * keys, one-off events, Olympics, anything niche The-Odds-API covers -
 * is treated as "always eligible": it passes through untouched, since
 * those are naturally self-limiting (the odds provider just returns no
 * lines when nothing's on, logged as usual, no real quota cost).
 *
 * Add more entries any time; nothing here is exhaustive by design.
 */

const SEASON_WINDOWS = [
  { sportKey: "americanfootball_nfl", start: { month: 9, day: 1 }, end: { month: 2, day: 15 } },
  { sportKey: "americanfootball_ncaaf", start: { month: 8, day: 20 }, end: { month: 1, day: 20 } },
  { sportKey: "basketball_nba", start: { month: 10, day: 15 }, end: { month: 6, day: 20 } },
  { sportKey: "basketball_ncaab", start: { month: 11, day: 1 }, end: { month: 4, day: 10 } },
  { sportKey: "baseball_mlb", start: { month: 3, day: 20 }, end: { month: 11, day: 5 } },
  { sportKey: "icehockey_nhl", start: { month: 10, day: 1 }, end: { month: 6, day: 30 } },
  { sportKey: "soccer_epl", start: { month: 8, day: 1 }, end: { month: 5, day: 31 } },
  { sportKey: "soccer_spain_la_liga", start: { month: 8, day: 1 }, end: { month: 5, day: 31 } },
  { sportKey: "soccer_germany_bundesliga", start: { month: 8, day: 1 }, end: { month: 5, day: 31 } },
  { sportKey: "soccer_italy_serie_a", start: { month: 8, day: 1 }, end: { month: 5, day: 31 } },
  { sportKey: "soccer_usa_mls", start: { month: 2, day: 1 }, end: { month: 12, day: 10 } },
];

function dateFallsInWindow(date, start, end) {
  const monthDay = (date.getMonth() + 1) * 100 + date.getDate();
  const startVal = start.month * 100 + start.day;
  const endVal = end.month * 100 + end.day;

  if (startVal <= endVal) {
    return monthDay >= startVal && monthDay <= endVal;
  }
  // Window wraps across the new year (e.g. NFL: Sep -> Feb)
  return monthDay >= startVal || monthDay <= endVal;
}

export function isInSeason(sportKey, date = new Date()) {
  const window = SEASON_WINDOWS.find((w) => w.sportKey === sportKey);
  if (!window) return true; // unlisted keys are always eligible - self-limiting via the odds API
  return dateFallsInWindow(date, window.start, window.end);
}

export function getInSeasonSports(pool, date = new Date()) {
  return (pool || []).filter((sportKey) => isInSeason(sportKey, date));
}

export function getOutOfSeasonSports(pool, date = new Date()) {
  return (pool || []).filter((sportKey) => !isInSeason(sportKey, date));
}
