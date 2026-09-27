/**
 * polymarket/pmMarkets.js
 *
 * Finds the Polymarket US game market for a team the odds feed has priced.
 *
 * How Polymarket US lists a game (docs.polymarket.us, 2026-09):
 *   - leagues:  GET gateway /v2/leagues                     -> slug per league
 *   - games:    GET gateway /v2/leagues/{slug}/events        -> events with teams[] and markets[]
 *   - a two-team game has ONE winner market. Its YES ("long") side is one
 *     team; backing the other team means taking the NO ("short") side.
 *   - soccer has three winner markets (home / draw / away), each with its
 *     own team on the YES side.
 *   - the book only quotes the YES side. YES ask = what a YES buyer pays;
 *     a NO buyer pays 1 - YES bid.
 *   - prices:   GET gateway /v1/markets/{slug}/bbo
 *
 * WRONG-TEAM PROTECTION. The Kalshi resolver once bought the Mets for a
 * Yankees model because two teams shared a city. Here a game only matches
 * when BOTH teams from the odds feed match the event's two teams, and the
 * start times agree. A side is assigned to a team by its teamId first, and
 * by name only when there is no id. Anything ambiguous is skipped and counted,
 * never guessed.
 */

import { pmGet, centsOf, numberOf } from "./pmClient.js";
import { normName } from "./pmState.js";

export const PM_MARKETS_VERSION = "2026-09-27-polymarket-markets";

/** Odds-feed sport -> the Polymarket league slugs it may be listed under. */
const LEAGUE_CANDIDATES = {
  americanfootball_nfl: ["nfl"],
  americanfootball_ncaaf: ["cfb", "ncaaf", "college-football", "ncaa-football", "ncaafb"],
  basketball_nba: ["nba"],
  basketball_nba_preseason: ["nba"],
  basketball_wnba: ["wnba"],
  basketball_ncaab: ["cbb", "ncaab", "college-basketball", "ncaa-basketball", "ncaamb"],
  baseball_mlb: ["mlb"],
  icehockey_nhl: ["nhl"],
  icehockey_nhl_preseason: ["nhl"],
  soccer_epl: ["epl", "premier-league", "english-premier-league"],
  soccer_usa_mls: ["mls"],
  soccer_uefa_champs_league: ["ucl", "champions-league", "uefa-champions-league"],
  soccer_uefa_europa_league: ["uel", "europa-league", "uefa-europa-league"],
  soccer_spain_la_liga: ["laliga", "la-liga"],
  soccer_germany_bundesliga: ["bundesliga"],
  soccer_italy_serie_a: ["serie-a", "seriea"],
  soccer_france_ligue_one: ["ligue-1", "ligue1"],
  soccer_mexico_ligamx: ["liga-mx", "ligamx"],
  mma_mixed_martial_arts: ["ufc", "mma"],
  cricket_ipl: ["ipl"],
};

function candidatesFor(sportKey) {
  if (LEAGUE_CANDIDATES[sportKey]) return LEAGUE_CANDIDATES[sportKey];
  if (/^tennis_atp/.test(sportKey)) return ["atp", "tennis-atp"];
  if (/^tennis_wta/.test(sportKey)) return ["wta", "tennis-wta"];
  return [];
}

const alnum = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// --- Leagues -------------------------------------------------------------------

let leagueCache = { at: 0, leagues: [] };
const LEAGUE_TTL_MS = 6 * 60 * 60 * 1000;

export async function getLeagues() {
  if (Date.now() - leagueCache.at < LEAGUE_TTL_MS && leagueCache.leagues.length) return leagueCache.leagues;
  const all = [];
  for (let offset = 0; offset < 500; offset += 50) {
    const res = await pmGet("/v2/leagues", { query: { limit: 50, offset } });
    const rows = res.leagues || [];
    all.push(...rows);
    if (rows.length < 50) break;
  }
  leagueCache = { at: Date.now(), leagues: all };
  return all;
}

/** The Polymarket league slug for an odds-feed sport, or null. */
export async function leagueSlugFor(sportKey) {
  const cands = candidatesFor(sportKey).map(alnum);
  if (!cands.length) return null;
  const leagues = await getLeagues();
  for (const c of cands) {
    const hit = leagues.find((l) => l.isOperational !== false &&
      [l.slug, l.abbreviation, l.name].some((v) => alnum(v) === c));
    if (hit) return hit.slug;
  }
  return null;
}

// --- Events ----------------------------------------------------------------------

const eventCache = new Map();   // slug -> { at, events }
const EVENT_TTL_MS = 20_000;

export async function getLeagueEvents(slug) {
  const hit = eventCache.get(slug);
  if (hit && Date.now() - hit.at < EVENT_TTL_MS) return hit.events;
  const events = [];
  for (let offset = 0; offset < 300; offset += 100) {
    const res = await pmGet(`/v2/leagues/${encodeURIComponent(slug)}/events`, { query: { limit: 100, offset, type: "sport" } });
    const rows = res.events || [];
    events.push(...rows);
    if (rows.length < 100) break;
  }
  eventCache.set(slug, { at: Date.now(), events });
  return events;
}

// --- Name matching -------------------------------------------------------------------

// Words that locate a team without identifying it (see tickerResolver.js).
const PLACE = new Set([
  "new", "york", "ny", "los", "angeles", "la", "san", "francisco", "jose", "diego", "antonio",
  "chicago", "boston", "philadelphia", "washington", "dallas", "houston", "miami", "atlanta",
  "detroit", "denver", "phoenix", "seattle", "portland", "minnesota", "tampa", "bay", "orlando",
  "cleveland", "cincinnati", "pittsburgh", "baltimore", "kansas", "city", "st", "louis", "oakland",
  "sacramento", "vegas", "las", "nashville", "memphis", "milwaukee", "indianapolis", "columbus",
  "charlotte", "jacksonville", "buffalo", "brooklyn", "anaheim", "arizona", "colorado", "carolina",
  "florida", "texas", "utah", "vancouver", "toronto", "montreal", "ottawa", "calgary", "edmonton",
  "winnipeg", "jersey", "england", "green", "madrid", "manchester", "man", "milan", "london", "rome",
  "turin", "munich", "liverpool", "barcelona", "sevilla", "lisbon", "porto", "glasgow",
  "the", "fc", "cf", "sc", "afc", "club", "de", "real", "state", "university",
]);

function distinctive(norm) {
  const words = norm.split(" ").filter(Boolean);
  const strong = words.filter((w) => w.length > 2 && !PLACE.has(w));
  return strong;
}

/** True when an odds-feed name and a Polymarket name are the same team. */
export function sameTeam(oddsName, pmName) {
  const a = normName(oddsName);
  const b = normName(pmName);
  if (!a || !b) return false;
  if (a === b) return true;
  const aw = new Set(a.split(" "));
  const bw = new Set(b.split(" "));
  const da = distinctive(a);
  const db = distinctive(b);
  if (db.length && db.every((w) => aw.has(w))) return true;
  if (da.length && da.every((w) => bw.has(w))) return true;
  return false;
}

function teamNamesOf(t) {
  return [t?.name, t?.alias, t?.safeName, t?.displayName].filter(Boolean);
}

function teamMatches(oddsName, pmTeam) {
  return teamNamesOf(pmTeam).some((n) => sameTeam(oddsName, n));
}

function startMsOf(ev) {
  for (const v of [ev.startDate, ev.gameStartTime, ev.startTime, ev.eventDate]) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * The event for this game: both odds-feed teams must match two DIFFERENT
 * event teams, and the start must be within 12 hours of the odds feed's.
 */
export function matchEvent(events, teamNames, commenceTime) {
  const [a, b] = teamNames;
  const want = Date.parse(commenceTime);
  const hits = (events || []).filter((ev) => {
    if (ev.closed || ev.archived) return false;
    const teams = ev.teams || [];
    if (teams.length < 2) return false;
    const ia = teams.findIndex((t) => teamMatches(a, t));
    const ib = teams.findIndex((t) => teamMatches(b, t));
    if (ia < 0 || ib < 0 || ia === ib) return false;
    const start = startMsOf(ev);
    if (start != null && Number.isFinite(want) && Math.abs(start - want) > 12 * 60 * 60 * 1000) return false;
    return true;
  });
  if (hits.length !== 1) return hits.length ? { ambiguous: hits.length } : null;
  return hits[0];
}

// --- The winner market and which side our team is on ---------------------------------------

function isWinnerMarket(m) {
  if (!m || m.closed || m.active === false || m.hidden) return false;
  const type = JSON.stringify([m.sportsMarketType, m.sportsMarketTypeV2, m.marketType]).toUpperCase();
  if (!/MONEYLINE|DRAWABLE|WINNER/.test(type)) return false;
  if (/SPREAD|TOTAL|PROP|FUTURE/.test(type)) return false;
  // Period markets (first half, a quarter, an inning, a set) are not the game.
  const words = `${m.title ?? ""} ${m.question ?? ""} ${m.subtitle ?? ""}`.toLowerCase();
  if (/\b(1st|2nd|first|second|half|quarter|period|inning|innings|set \d|map \d)\b/.test(words)) return false;
  if (m.line != null && Number(m.line) !== 0) return false;
  return true;
}

/** Which event team a market side stands for, or null. */
function teamOfSide(side, ev) {
  const teams = ev.teams || [];
  if (side?.teamId != null) {
    const t = teams.find((x) => String(x.id) === String(side.teamId));
    if (t) return { team: t, by: "teamId" };
  }
  const direct = side?.team?.id != null ? teams.find((x) => String(x.id) === String(side.team.id)) : null;
  if (direct) return { team: direct, by: "team.id" };
  const text = `${side?.identifier ?? ""} ${side?.description ?? ""} ${side?.team?.name ?? ""}`;
  if (/\b(draw|tie)\b/i.test(text)) return { draw: true, by: "text" };
  const matches = teams.filter((t) => teamNamesOf(t).some((n) => {
    const d = distinctive(normName(n));
    const words = new Set(normName(text).split(" "));
    return d.length && d.every((w) => words.has(w));
  }));
  if (matches.length === 1) return { team: matches[0], by: "name" };
  return null;
}

/**
 * The market and side that pay if `teamName` wins.
 * Returns { ok:true, market, slug, long, sideBy } or { ok:false, code, reason }.
 */
export function winnerSideFor(ev, teamName) {
  const ours = (ev.teams || []).find((t) => teamMatches(teamName, t));
  if (!ours) return { ok: false, code: "pm-team-not-in-event", reason: `${teamName} is not one of this event's teams` };

  const markets = (ev.markets || []).filter(isWinnerMarket);
  if (!markets.length) return { ok: false, code: "pm-no-winner-market", reason: `${ev.title ?? ev.slug}: no open winner market` };

  const found = [];
  for (const m of markets) {
    const sides = m.marketSides || [];
    for (const s of sides) {
      const who = teamOfSide(s, ev);
      if (!who || who.draw || !who.team) continue;
      if (String(who.team.id) !== String(ours.id)) continue;
      if (s.long === true) found.push({ market: m, long: true, sideBy: who.by });
      else if (s.long === false) found.push({ market: m, long: false, sideBy: who.by });
    }
    // Only the OTHER team's long side is listed: backing ours is the short side.
    if (!found.some((f) => f.market === m) && sides.length === 1 && sides[0].long === true) {
      const who = teamOfSide(sides[0], ev);
      if (who?.team && String(who.team.id) !== String(ours.id) && (ev.teams || []).length === 2) {
        found.push({ market: m, long: false, sideBy: `${who.by}-opponent` });
      }
    }
  }

  // Prefer a market where our team is the YES side (every soccer game, and
  // half of everything else): no short-side order format is involved.
  const longHit = found.filter((f) => f.long);
  const pick = longHit.length === 1 ? longHit[0] : (!longHit.length && found.length === 1 ? found[0] : null);
  if (!pick) {
    return {
      ok: false, code: found.length ? "pm-side-ambiguous" : "pm-side-unknown",
      reason: `${ev.title ?? ev.slug}: ${found.length ? `${found.length} candidate sides` : "no market side could be tied to"} ${teamName}`,
    };
  }
  return { ok: true, market: pick.market, slug: pick.market.slug, long: pick.long, sideBy: pick.sideBy };
}

// --- Prices ------------------------------------------------------------------------

/**
 * What it costs to back the side, from the YES book:
 *   long:  ask = YES best ask,          size = shares offered
 *   short: ask = 100 - YES best bid,    size = shares bid
 */
export async function sidePrice(slug, long) {
  const res = await pmGet(`/v1/markets/${encodeURIComponent(slug)}/bbo`);
  const d = res.marketData || res.bbo || res;
  const bid = centsOf(d.bestBid);
  const ask = centsOf(d.bestAsk);
  const state = String(d.state || "");
  const open = !state || /OPEN/.test(state);
  if (long) {
    return {
      askCents: ask, bidCents: bid, askSize: numberOf(d.askShares, d.askQty) ?? 0,
      spreadCents: ask != null && bid != null ? ask - bid : null, state, open, raw: d,
    };
  }
  return {
    askCents: bid != null ? Math.round((100 - bid) * 10) / 10 : null,
    bidCents: ask != null ? Math.round((100 - ask) * 10) / 10 : null,
    askSize: numberOf(d.bidShares, d.bidQty) ?? 0,
    spreadCents: ask != null && bid != null ? ask - bid : null, state, open, raw: d,
  };
}

export function pmMarketsReport() {
  return {
    version: PM_MARKETS_VERSION,
    leaguesCached: leagueCache.leagues.map((l) => l.slug),
    eventCaches: [...eventCache.entries()].map(([slug, v]) => ({ slug, events: v.events.length, ageSeconds: Math.round((Date.now() - v.at) / 1000) })),
  };
}
