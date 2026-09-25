/**
 * seriesDiscovery.js
 *
 * Works out which Kalshi series each odds-feed sport should trade against.
 *
 * ---------------------------------------------------------------------------
 * 2026-09-23: PINNED SERIES + SPORT-TAG GATE
 * ---------------------------------------------------------------------------
 * The previous version refused every tie, which was right in principle and
 * expensive in practice. The single most profitable market in the account -
 * the Argentine Primera, +$8.51 on two trades - tied KXARGPREMDIV against
 * KXARGPREMDIVGAME and was dropped. So were Liga MX, EPL, La Liga, Serie A,
 * Bundesliga, Ligue 1, UCL, WNBA, KBO and NPB.
 *
 * At the same time, five sports DID bind, to the wrong thing entirely. Each
 * was checked against Kalshi's /series/{ticker} endpoint on 2026-09-23:
 *
 *   mma_mixed_martial_arts            -> KXMARMAD          tags: Basketball  (March Madness)
 *   soccer_efl_champ                  -> KXCHAMPTOUR       tags: Golf        (PGA Champions Tour)
 *   icehockey_sweden_allsvenskan      -> KXALLSVENSKANGAME tags: Soccer
 *   aussierules_aflw                  -> KXAFLGAME         title "AFL Game"  (the men's league)
 *   soccer_conmebol_copa_sudamericana -> KXCONMEBOLSUDADVANCE  an "advance" market, not a match winner
 *
 * Three fixes, in the order they are applied:
 *
 *   1. PINNED_SERIES. Hardcoded sportKey -> series, every row verified live
 *      against /series/{ticker} (title and sport tag) on 2026-09-23. A pin is
 *      used only if that ticker is present in today's live series list and
 *      passes the sport-tag gate - a delisted or retagged series falls back to
 *      discovery rather than being traded blind.
 *
 *      Pins are hardcoded, NOT a generic "prefer the ...GAME series" rule. A
 *      generic rule would bind soccer_austria_bundesliga to KXBUNDESLIGAGAME
 *      (Germany) and soccer_greece_super_league to KXSUPERLIGGAME (verified:
 *      "Turkish Super Lig Game"). Those stay refused.
 *
 *   2. SPORT-TAG GATE. Kalshi tags every series with its sport. A soccer key
 *      may only bind to a series tagged Soccer, a hockey key to Hockey, and so
 *      on. This kills the MMA, EFL and Swedish-hockey bindings generically.
 *      A series with no tags is allowed through (degrade, don't break).
 *
 *   3. SHAPE GATES.
 *      - Women's competitions bind only to series whose title says Women, and
 *        men's only to series whose title does not. Kills AFLW -> AFL.
 *      - Market-type series (ADVANCE, BTTS, TOTAL, SPREAD, 1H, 2H, TOUR ...)
 *        are never a match-winner answer. Kills Copa Sudamericana -> ADVANCE.
 *      - An abbreviated-core match now needs TWO anchored chunks, not one.
 *        One three-letter chunk ("mar" from martial -> MARMAD) is not evidence.
 *
 * A tie between two different series that survive all gates is still a
 * REFUSAL, never list order.
 * ---------------------------------------------------------------------------
 */

/*
 * ---------------------------------------------------------------------------
 * 2026-09-24: MONEYLINE COVERAGE
 * ---------------------------------------------------------------------------
 * The last discovery left 27 feed sports unmapped and refused 5 as ambiguous.
 * Two additions, both restricted to MONEYLINE series - a ticker ending GAME,
 * MATCH or FIGHT - because that is the only market type the bot prices:
 *
 *   4. TITLE PHRASES. A curated phrase per league ("efl championship",
 *      "primeira liga", "scottish premiership") matched on whole words against
 *      Kalshi's series TITLE. The series must still pass every gate above
 *      (sport tag, women's, market type, NEVER_BIND) and exactly one moneyline
 *      series may match - two is a refusal, as always. Nothing is bound to a
 *      guessed ticker: if Kalshi has no such series today, the sport stays
 *      unmapped and costs nothing.
 *
 *   5. MONEYLINE TIE-BREAK. A tie where exactly ONE survivor is a moneyline
 *      series resolves to it. The other side of those ties is a futures /
 *      championship series (KXBOXING, KXNHL, KXCONMEBOLSUD), which the scanner
 *      cannot trade anyway. Ties between two moneyline series stay refused -
 *      conference league vs KXUELGAME / KXUEFAGAME is exactly that, and both
 *      are the wrong competition.
 * ---------------------------------------------------------------------------
 */

import { appendLog } from "./stateStore.js";

const V2 = "/trade-api/v2";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // series lists barely move

export const DISCOVERY_VERSION = "2026-09-24-moneyline-titles";

let cache = null;

/**
 * Confirmed mappings, in production and known correct. Never overwritten.
 */
export const CONFIRMED_SERIES = {
  americanfootball_nfl: "KXNFLGAME",
  americanfootball_ncaaf: "KXNCAAFGAME",
  basketball_nba: "KXNBAGAME",
  basketball_ncaab: "KXNCAABGAME",
  baseball_mlb: "KXMLBGAME",
  icehockey_nhl: "KXNHLGAME",
};

/**
 * Verified 2026-09-23 against GET /trade-api/v2/series/{ticker}.
 * Title and tag recorded beside each row so a future mismatch is obvious.
 */
export const PINNED_SERIES = {
  soccer_argentina_primera_division: "KXARGPREMDIVGAME", // Argentina Primera Division Game | Soccer
  soccer_mexico_ligamx: "KXLIGAMXGAME",                   // Liga MX Game | Soccer
  soccer_epl: "KXEPLGAME",                                // English Premier League Game | Soccer
  soccer_spain_la_liga: "KXLALIGAGAME",                   // La Liga Game | Soccer
  soccer_italy_serie_a: "KXSERIEAGAME",                   // Serie A Game | Soccer
  soccer_italy_serie_b: "KXSERIEBGAME",                   // Serie B Game | Soccer
  soccer_germany_bundesliga: "KXBUNDESLIGAGAME",          // Bundesliga Game | Soccer
  soccer_germany_liga3: "KXGER3LGAME",                    // German 3. Liga Game | Soccer
  soccer_france_ligue_one: "KXLIGUE1GAME",                // Ligue 1 Game | Soccer
  soccer_france_ligue_two: "KXLIGUE2GAME",                // Ligue 2 Game | Soccer
  soccer_uefa_champs_league: "KXUCLGAME",                 // UEFA Champions League Game | Soccer
  soccer_uefa_europa_league: "KXUELGAME",                 // UEFA Europa League Game | Soccer
  soccer_netherlands_eredivisie: "KXEREDIVISIEGAME",      // Eredivisie Game | Soccer
  soccer_brazil_campeonato: "KXBRASILEIROGAME",           // Brasileiro Serie A Game | Soccer
  soccer_conmebol_copa_libertadores: "KXCONMEBOLLIBGAME", // CONMEBOL Libertadores Game | Soccer
  soccer_denmark_superliga: "KXDENSUPERLIGAGAME",         // Danish Superliga Game | Soccer
  soccer_belgium_first_div: "KXBELGIANPLGAME",            // Belgian Pro League Game | Soccer
  soccer_korea_kleague1: "KXKLEAGUEGAME",                 // Korea K League Game | Soccer
  soccer_turkey_super_league: "KXSUPERLIGGAME",           // Turkish Super Lig Game | Soccer
  soccer_sweden_allsvenskan: "KXALLSVENSKANGAME",         // Allsvenskan Game | Soccer
  basketball_wnba: "KXWNBAGAME",                          // Women's Pro Basketball Game | Basketball
  basketball_euroleague: "KXEUROLEAGUEGAME",              // Euroleague Game | Basketball
  basketball_nbl: "KXNBLGAME",                            // Australia NBL Game | Basketball
  baseball_kbo: "KXKBOGAME",                              // KBO Game | Baseball
  baseball_npb: "KXNPBGAME",                              // Japan NPB Game | Baseball
  icehockey_liiga: "KXLIIGAGAME",                         // Liiga Game | Hockey
  rugbyleague_nrl: "KXRUGBYNRLMATCH",                     // Rugby NRL Match | Rugby
  aussierules_afl: "KXAFLGAME",                           // AFL Game | Football, Aussie Rules
  mma_mixed_martial_arts: "KXUFCFIGHT",                   // UFC Fight | MMA
};

/**
 * Bindings that must never happen, whatever the scorer thinks. Each of these
 * is a different country's league sharing a name with a Kalshi series:
 *   KXBUNDESLIGA / KXBUNDESLIGAGAME  are Germany ("Bundesliga Game")
 *   KXSUPERLIG / KXSUPERLIGGAME      are Turkey  ("Turkish Super Lig Game")
 *   KXFINYLGAME                      is Finland's 2nd tier (Ykkosliiga), not Veikkausliiga
 * Today these are refused only because two series tie. If Kalshi retired
 * one of the pair, the tie would vanish and the survivor would bind - so they
 * are blocked explicitly rather than left to luck.
 */
export const NEVER_BIND = {
  soccer_austria_bundesliga: ["KXBUNDESLIGA", "KXBUNDESLIGAGAME"],
  handball_germany_bundesliga: ["KXBUNDESLIGA", "KXBUNDESLIGAGAME"],
  soccer_greece_super_league: ["KXSUPERLIG", "KXSUPERLIGGAME"],
  soccer_switzerland_superleague: ["KXSUPERLIG", "KXSUPERLIGGAME"],
  soccer_sweden_superettan: ["KXSUPERLIG", "KXSUPERLIGGAME"],
  soccer_finland_veikkausliiga: ["KXFINYLGAME"],
  // FCS is not FBS. KXNCAAFGAME would win the new moneyline tie-break.
  americanfootball_ncaaf_fcs: ["KXNCAAFGAME"],
};

/** A series that settles on who wins a single game, match or fight. */
export function isMoneylineSeries(ticker) {
  return /(GAME|MATCH|FIGHT)$/.test(String(ticker || "").toUpperCase());
}

/**
 * League -> phrases Kalshi's series TITLE would carry. Whole-word, case-
 * insensitive. Only moneyline series are considered, after every gate.
 */
export const MONEYLINE_TITLES = {
  soccer_efl_champ: ["efl championship", "english championship"],
  soccer_england_league1: ["efl league one", "english league one"],
  soccer_england_league2: ["efl league two", "english league two"],
  soccer_england_efl_cup: ["efl cup", "carabao cup"],
  soccer_portugal_primeira_liga: ["primeira liga", "liga portugal"],
  soccer_spl: ["scottish premiership"],
  soccer_austria_bundesliga: ["austrian bundesliga"],
  soccer_switzerland_superleague: ["swiss super league"],
  soccer_greece_super_league: ["greek super league"],
  soccer_germany_dfb_pokal: ["dfb pokal"],
  soccer_brazil_serie_b: ["brasileiro serie b", "brazil serie b"],
  soccer_chile_campeonato: ["chilean primera", "chile primera"],
  soccer_spain_segunda_division: ["segunda division", "la liga 2", "laliga 2"],
  soccer_finland_veikkausliiga: ["veikkausliiga"],
  soccer_league_of_ireland: ["league of ireland"],
  soccer_sweden_superettan: ["superettan"],
  soccer_uefa_europa_conference_league: ["conference league"],
  soccer_conmebol_copa_sudamericana: ["sudamericana"],
  icehockey_sweden_hockey_league: ["swedish hockey league", "shl"],
  icehockey_sweden_allsvenskan: ["hockeyallsvenskan"],
  icehockey_mestis: ["mestis"],
  icehockey_nhl_preseason: ["nhl"],
  handball_germany_bundesliga: ["handball bundesliga"],
  aussierules_aflw: ["aflw", "afl women"],
  rugbyleague_nrlw: ["nrlw", "nrl women"],
  boxing_boxing: ["boxing"],
};

function titleHas(title, phrase) {
  const t = ` ${String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const p = ` ${String(phrase || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  return p.trim().length > 0 && t.includes(p);
}

/** Step 4. Returns { ticker } on a unique match, { ambiguous: [...] }, or null. */
export function titleMoneylineMatch(series, sportKey) {
  const phrases = MONEYLINE_TITLES[sportKey];
  if (!phrases) return null;
  const hits = new Set();
  for (const s of series) {
    if (!isMoneylineSeries(s.ticker)) continue;
    if (!phrases.some((ph) => titleHas(s.title, ph))) continue;
    if (ineligibleReason(s, sportKey)) continue;
    hits.add(s.ticker);
  }
  if (hits.size === 1) return { ticker: [...hits][0] };
  if (hits.size > 1) return { ambiguous: [...hits] };
  return null;
}

/**
 * Pins by prefix, for feeds that publish one key per tournament
 * (tennis_wta_singapore_open, tennis_atp_shanghai_masters ...).
 */
export const PINNED_PREFIXES = [
  ["tennis_wta_", "KXWTAMATCH"], // WTA Tennis Match | Tennis
  ["tennis_atp_", "KXATPMATCH"], // ATP Tennis Match | Tennis
];

/**
 * Sport family of an odds-feed key -> the Kalshi tags that family accepts.
 * `reject` lists tags that disqualify even when an accepted tag is present:
 * KXAFLGAME is tagged both "Football" and "Aussie Rules".
 */
const SPORT_TAGS = {
  americanfootball: { accept: ["football"], reject: ["aussie rules"] },
  aussierules: { accept: ["aussie rules"] },
  basketball: { accept: ["basketball"] },
  baseball: { accept: ["baseball"] },
  icehockey: { accept: ["hockey"] },
  soccer: { accept: ["soccer"] },
  tennis: { accept: ["tennis"] },
  cricket: { accept: ["cricket"] },
  mma: { accept: ["mma"] },
  boxing: { accept: ["boxing"] },
  rugbyleague: { accept: ["rugby"] },
  rugbyunion: { accept: ["rugby"] },
  golf: { accept: ["golf"] },
  handball: { accept: ["handball"] },
};

/**
 * Words that describe the SPORT rather than the competition. Stripped when
 * working out what makes a sport key distinctive. "division" is NOT here - it
 * is the DIV in ARGPREMDIV.
 */
const GENERIC_TOKENS = new Set([
  "americanfootball", "basketball", "baseball", "icehockey", "soccer", "tennis",
  "cricket", "golf", "mma", "boxing", "rugbyleague", "rugbyunion", "aussierules",
  "football", "hockey", "sport", "sports", "league", "liga", "serie",
  "cup", "open", "championship", "pro", "premier", "national",
]);

const ALIASES = {
  epl: ["epl", "premierleague"],
  spain_la_liga: ["laliga"],
  germany_bundesliga: ["bundesliga"],
  italy_serie_a: ["seriea"],
  italy_serie_b: ["serieb"],
  france_ligue_one: ["ligue1", "ligueone"],
  usa_mls: ["mls", "majorleaguesoccer"],
  uefa_champs_league: ["ucl", "championsleague"],
  uefa_europa_league: ["uel", "europaleague"],
  brazil_campeonato: ["brasileirao", "brasileiro", "campeonato"],
  atp: ["atp"],
  wta: ["wta"],
  wnba: ["wnba"],
  ncaaf: ["ncaaf"],
  ncaab: ["ncaab"],
  mlb: ["mlb"],
  nhl: ["nhl"],
  nba: ["nba"],
  nfl: ["nfl"],
};

/**
 * Series cores that describe a market TYPE, not a competition's match winner.
 * KXCONMEBOLSUDADVANCE, KXLIGUE1BTTS, KXCONMEBOLLIB1H, KXCHAMPTOUR.
 */
const MARKET_TYPE_SUFFIX = /(ADVANCE|BTTS|TOTAL|TOTALS|SPREAD|1H|2H|FTTS|GOAL|GOALS|MOV|LAST|TOP\d*|TOUR|MVP|SEASON|FUTURES|CHAMP|CHAMPION)$/;

/** The league core of a Kalshi series ticker: KXNHLGAME -> NHL. */
export function seriesCore(ticker) {
  let c = String(ticker || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  c = c.replace(/^KX/, "");
  for (let i = 0; i < 2; i++) c = c.replace(/(GAMES|GAME|MATCH|WINNER|FIGHT)$/, "");
  return c;
}

/** All-star, pro-bowl and exhibition series. Never a regular-season answer. */
export function isExhibitionCore(core) {
  return /ALLSTAR|PROBOWL|EXHIB|FRIENDLY|PRESEASON/.test(core) || /^[A-Z]{3,}AS$/.test(core);
}

/** Kalshi returns tags as an array, a JSON string, or a plain string. */
export function seriesTags(series) {
  let t = series?.tags;
  if (typeof t === "string") {
    const s = t.trim();
    if (s.startsWith("[")) {
      try { t = JSON.parse(s); } catch { t = [s]; }
    } else {
      t = s.split(",");
    }
  }
  if (!Array.isArray(t)) return [];
  return t.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean);
}

function sportFamily(sportKey) {
  return String(sportKey || "").toLowerCase().split("_")[0];
}

function isWomensKey(sportKey) {
  const WOMENS_PARTS = new Set(["wnba", "women", "womens", "aflw", "nrlw", "nwsl"]);
  return String(sportKey || "").toLowerCase().split("_").some((p) => WOMENS_PARTS.has(p));
}

function isWomensSeries(series) {
  return /\bwomen/i.test(String(series?.title || ""));
}

/**
 * Whether a series may represent this sport at all, before any name scoring.
 * Returns null when eligible, or a short reason string when not.
 */
export function ineligibleReason(series, sportKey) {
  const core = seriesCore(series?.ticker);
  if (!core) return "empty core";
  if ((NEVER_BIND[sportKey] || []).includes(series.ticker)) return "blocked: a different country's league";
  if (isExhibitionCore(core)) return "exhibition series";
  if (MARKET_TYPE_SUFFIX.test(core)) return `market-type series (${core})`;

  const rule = SPORT_TAGS[sportFamily(sportKey)];
  const tags = seriesTags(series);
  if (rule && tags.length) {
    if (!tags.some((t) => rule.accept.includes(t))) {
      return `tagged ${tags.join("/")}, not ${rule.accept.join("/")}`;
    }
    if (rule.reject && tags.some((t) => rule.reject.includes(t))) {
      return `tagged ${tags.join("/")}, which excludes ${sportFamily(sportKey)}`;
    }
  }

  const wantWomen = isWomensKey(sportKey);
  const isWomen = isWomensSeries(series);
  if (wantWomen !== isWomen) {
    const t = series.title || series.ticker;
    return wantWomen ? `women's competition, series "${t}" is not` : `series "${t}" is a women's competition`;
  }
  return null;
}

/** The distinctive parts of an odds-feed sport key, plus any known aliases. */
export function distinctiveTokens(sportKey) {
  const parts = String(sportKey || "").toLowerCase().split("_").filter(Boolean);
  const kept = parts.filter((p) => !GENERIC_TOKENS.has(p));
  const base = kept.length ? kept : parts;

  const out = new Set();
  for (const p of base) out.add(p);

  const allParts = parts.filter((p) => !["americanfootball", "basketball", "baseball", "icehockey", "soccer", "tennis", "cricket", "golf", "mma", "boxing"].includes(p));
  if (allParts.length > 1) out.add(allParts.join(""));
  if (base.length > 1) out.add(base.join(""));

  // Aliases match on whole segments only ("wnba" must not inherit "nba").
  const joined = allParts.join("_");
  const segments = new Set(parts);
  for (const [key, words] of Object.entries(ALIASES)) {
    const keyParts = key.split("_");
    const isWholeKey = joined === key;
    const isSegmentMatch = keyParts.every((kp) => segments.has(kp));
    if (isWholeKey || isSegmentMatch) {
      for (const w of words) out.add(w);
    }
  }
  return [...out].filter((t) => t.length >= 2);
}

/**
 * Scores a series against a sport's tokens. Eligibility is checked separately
 * by ineligibleReason(); this is name evidence only.
 */
export function scoreSeries(series, tokens) {
  const core = seriesCore(series.ticker);
  if (!core) return 0;
  if (isExhibitionCore(core)) return 0;

  const lowerCore = core.toLowerCase();
  let best = 0;

  // 1. A token IS the core. MLB, NHL, EPL, LALIGA, ODI, WTA.
  for (const t of tokens) {
    const tok = t.replace(/[^a-z0-9]/g, "");
    if (tok && tok === lowerCore) best = Math.max(best, 100);
  }
  if (best) return best;

  // 2. ABBREVIATED CORES (ARGPREMDIV <- arg ... div). Anchored, ordered, and
  //    now at least TWO chunks: one 3-letter hit ("mar" from martial ->
  //    MARMAD, "afl" from aflw -> AFL) is a coincidence, not an abbreviation.
  const singleWordTokens = tokens.filter((t) => t.length >= 4 && !/\s/.test(t));
  let pos = 0, hits = 0, covered = 0;
  for (const t of singleWordTokens) {
    const tok = t.replace(/[^a-z0-9]/g, "");
    for (let n = Math.min(tok.length, 6); n >= 3; n--) {
      const at = lowerCore.indexOf(tok.slice(0, n), pos);
      if (at < 0) continue;
      if (hits === 0 && at !== 0) continue;
      pos = at + n; hits++; covered += n; break;
    }
  }
  if (hits >= 2 && covered * 2 >= lowerCore.length) return 40 + covered * 2 + hits;

  // 3. Whole-word title match, only if every distinctive single word is present.
  const title = String(series.title || "").toLowerCase();
  if (title) {
    const words = new Set(title.split(/[^a-z0-9]+/).filter(Boolean));
    const singles = tokens.filter((t) => t.length >= 3 && !/\s/.test(t));
    if (singles.length) {
      const allPresent = singles.every((t) => words.has(t.replace(/[^a-z0-9]/g, "")));
      if (allPresent) return 20;
    }
  }

  return 0;
}

/** The pinned series for a key, exact first, then by prefix. */
export function pinnedFor(sportKey) {
  if (PINNED_SERIES[sportKey]) return PINNED_SERIES[sportKey];
  for (const [prefix, ticker] of PINNED_PREFIXES) {
    if (String(sportKey || "").startsWith(prefix)) return ticker;
  }
  return null;
}

async function fetchSeries(kalshiGet) {
  // Category is exact and case-sensitive upstream; both spellings are tried.
  const seen = new Map();
  for (const category of ["Sports", "sports"]) {
    try {
      const res = await kalshiGet(`${V2}/series`, `?category=${category}`);
      const list = res?.series || res?.series_list || [];
      for (const s of list) if (s?.ticker && !seen.has(s.ticker)) seen.set(s.ticker, s);
      if (seen.size) break;
    } catch {
      // try the next spelling
    }
  }
  return [...seen.values()];
}

/**
 * Pure mapping step, split out so it can be run against a saved live series
 * list without a network call. Returns { map, found, pinned, missed,
 * ambiguous, rejected }.
 */
export function buildSeriesMap(series, sportKeys = []) {
  const byTicker = new Map(series.map((s) => [s.ticker, s]));
  const map = { ...CONFIRMED_SERIES };
  const found = [];
  const pinned = [];
  const missed = [];
  const ambiguous = [];
  const rejected = [];

  for (const sportKey of sportKeys) {
    if (CONFIRMED_SERIES[sportKey]) continue;

    // --- 1. Pins ---------------------------------------------------------
    const pin = pinnedFor(sportKey);
    if (pin) {
      const s = byTicker.get(pin);
      if (!s) {
        rejected.push(`${sportKey} -> ${pin} (pinned, but not in today's live series list)`);
      } else {
        const why = ineligibleReason(s, sportKey);
        if (why) {
          rejected.push(`${sportKey} -> ${pin} (pinned, but ${why})`);
        } else {
          map[sportKey] = pin;
          pinned.push(`${sportKey} -> ${pin}`);
          continue;
        }
      }
    }

    // --- 2. Moneyline title phrases (2026-09-24) --------------------------
    const byTitle = titleMoneylineMatch(series, sportKey);
    if (byTitle?.ticker) {
      map[sportKey] = byTitle.ticker;
      found.push(`${sportKey} -> ${byTitle.ticker} (title)`);
      continue;
    }
    if (byTitle?.ambiguous) {
      ambiguous.push(`${sportKey} -> ${byTitle.ambiguous.join(" / ")} (title)`);
      missed.push(sportKey);
      continue;
    }

    // --- 3. Discovery ----------------------------------------------------
    const tokens = distinctiveTokens(sportKey);
    if (!tokens.length) { missed.push(sportKey); continue; }

    let bestScore = 0;
    let winners = [];
    for (const s of series) {
      const sc = scoreSeries(s, tokens);
      if (sc <= 0) continue;
      const why = ineligibleReason(s, sportKey);
      if (why) {
        if (sc >= 20) rejected.push(`${sportKey} -> ${s.ticker} (${why})`);
        continue;
      }
      if (sc > bestScore) { bestScore = sc; winners = [s]; }
      else if (sc === bestScore) winners.push(s);
    }

    if (!winners.length || bestScore < 20) { missed.push(sportKey); continue; }

    let distinct = [...new Set(winners.map((w) => w.ticker))];
    // Moneyline tie-break: exactly one game/match/fight series among the tied.
    if (distinct.length > 1) {
      const ml = distinct.filter(isMoneylineSeries);
      if (ml.length === 1) distinct = ml;
    }
    if (distinct.length > 1) {
      ambiguous.push(`${sportKey} -> ${distinct.join(" / ")}`);
      missed.push(sportKey);
      continue;
    }

    map[sportKey] = distinct[0];
    found.push(`${sportKey} -> ${distinct[0]}`);
  }

  return { map, found, pinned, missed, ambiguous, rejected };
}

/**
 * Builds sportKey -> Kalshi series ticker for every sport the odds feed offers.
 * Returns the confirmed rows unchanged if discovery fails, so a Kalshi outage
 * degrades coverage rather than stopping trading.
 */
export async function discoverSeriesMap(kalshiGet, sportKeys = []) {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.map;

  let series = [];
  try {
    series = await fetchSeries(kalshiGet);
  } catch (err) {
    appendLog(`Series discovery failed (${err.message}) - falling back to the confirmed sports.`, "warn");
    return { ...CONFIRMED_SERIES };
  }

  if (!series.length) {
    appendLog("Series discovery returned nothing - falling back to the confirmed sports.", "warn");
    return { ...CONFIRMED_SERIES };
  }

  const { map, found, pinned, missed, ambiguous, rejected } = buildSeriesMap(series, sportKeys);

  appendLog(
    `Series discovery: ${series.length} Kalshi sports series seen, ` +
    `${Object.keys(map).length} sports addressable` +
    (pinned.length ? `. Pinned: ${pinned.join(", ")}` : "") +
    (found.length ? `. Matched: ${found.join(", ")}` : "") +
    (ambiguous.length ? `. REFUSED as ambiguous: ${ambiguous.join(", ")}` : "")
  );
  if (rejected.length) {
    appendLog(`Series discovery: rejected ${rejected.length} wrong-sport/wrong-type binding(s): ${rejected.slice(0, 12).join("; ")}`);
  }
  if (missed.length) {
    appendLog(
      `Series discovery: no Kalshi series for ${missed.length} sport(s) - they are not scanned and cost nothing. ` +
      `First few: ${missed.slice(0, 8).join(", ")}`
    );
  }

  cache = { map, at: Date.now(), seriesCount: series.length, found, pinned, missed, ambiguous, rejected };
  return map;
}

/** What discovery last concluded, for the dashboard. */
export function lastDiscovery() {
  if (!cache) return null;
  return {
    version: DISCOVERY_VERSION,
    at: new Date(cache.at).toISOString(),
    seriesCount: cache.seriesCount,
    addressable: Object.keys(cache.map).length,
    pinned: cache.pinned || [],
    found: cache.found,
    missed: cache.missed,
    ambiguous: cache.ambiguous || [],
    rejected: cache.rejected || [],
    map: cache.map,
  };
}

export function clearSeriesCache() { cache = null; }
