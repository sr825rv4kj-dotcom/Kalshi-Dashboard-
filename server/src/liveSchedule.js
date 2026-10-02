/**
 * liveSchedule.js
 *
 * THE LIVE SCHEDULE (2026-09-28). One calendar, built from the same odds feed
 * the bot prices against, decides WHEN each sport is scanned on BOTH Kalshi
 * and Polymarket. No more scanning sports that have nothing on, and no more
 * sleeping on a game because its sport was parked.
 *
 * WHERE THE CALENDAR COMES FROM. The Odds API's events endpoint:
 *   GET /v4/sports/{sport}/events  - "Returns a list of in-play and pre-match
 *   events" with the commence time of each, and "This endpoint does not count
 *   against the usage quota" (the-odds-api.com/liveapi/guides/v4). So the
 *   whole calendar - every active sport - is rebuilt every 10 minutes for 0
 *   credits. It is the same feed the bot trades on, so a game on the calendar
 *   is a game the bot has a line for; a calendar from anywhere else could list
 *   games the bot can never price.
 *
 * HOW IT DRIVES THE BOT, per sport:
 *   LIVE   a listed game has started (and is inside its sport's longest
 *          running time) - scanned every cycle, 20 seconds.
 *   SOON   a game starts within 65 minutes - scanned, so the last pre-game
 *          line is on record for the in-game check the moment it kicks off.
 *   QUIET  nothing live or within 65 minutes - not scanned, 0 credits.
 * With nothing live or soon anywhere, the cycle slows to 60 seconds (held
 * positions are still checked, settlements still booked).
 *
 * NEVER WORSE THAN BEFORE. If the calendar cannot be built (odds feed down,
 * key missing) or is more than 35 minutes old, the bot falls back to exactly
 * the previous behaviour. A sport whose calendar read failed, or that turned
 * active after the last rebuild, is scanned as before - an error never hides
 * a sport.
 *
 * OPEN-TRADE CAP BY BALANCE (same file, used by both exchanges): money in
 * open trades is held to 75% of that exchange's equity at the current stake,
 * never fewer than 5 open trades and never more than 10.
 */

import { appendLog } from "./stateStore.js";
import { allActiveSportKeys } from "./sportsDiscovery.js";
import { getSeriesMap } from "./tickerResolver.js";
import { mappedSports } from "./polymarket/pmMarkets.js";
import { currentCadenceSeconds, describeCadence } from "./cadence.js";

export const LIVE_SCHEDULE_VERSION = "2026-10-01-lead-65m";

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";
const REFRESH_MS = 10 * 60 * 1000;
const STALE_MS = 35 * 60 * 1000;
// 2026-10-01: 30 -> 65 minutes. Pre-game buys open 60 minutes before the
// start (config.entryWindowHours = 1), so a sport must already be scanned by
// then; the extra 5 minutes has its line on record when the window opens.
export const LEAD_MS = 65 * 60 * 1000;
const AHEAD_MS = 24 * 60 * 60 * 1000;
const LIVE_CADENCE_SECONDS = 20;
const IDLE_CADENCE_SECONDS = 60;
const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 15 * 1000;

// Longest a game of each sport can still be running after its start time.
// Deliberately generous: ending a live window early would sleep on a game,
// staying a little long only costs a scan of a finished board.
const RUN_HOURS = [
  [/^cricket_test/, 5 * 24 + 2],
  [/^cricket_odi/, 10],
  [/^cricket/, 5],
  [/^americanfootball/, 4.5],
  [/^baseball/, 5],
  [/^basketball/, 3],
  [/^icehockey/, 3.5],
  [/^soccer/, 3],
  [/^tennis/, 5],
  [/^(mma|boxing)/, 8],
  [/^rugby/, 2.5],
  [/^aussierules/, 3.5],
  [/^lacrosse/, 3],
  [/^handball/, 2],
];
const DEFAULT_RUN_HOURS = 4;

export function runMsFor(sportKey) {
  const hit = RUN_HOURS.find(([re]) => re.test(String(sportKey || "")));
  return (hit ? hit[1] : DEFAULT_RUN_HOURS) * 60 * 60 * 1000;
}

// --- Open-trade cap by balance -------------------------------------------------------

export const MIN_OPEN_TRADES = 5;
export const MAX_OPEN_TRADES = 10;
export const DEPLOY_SHARE = 0.75;

/**
 * How many trades may be open at once on one exchange: as many stakes as fit
 * in 75% of that exchange's equity, never fewer than 5, never more than 10.
 * e.g. $70 at $5 stakes -> 10; $45 at $5 -> 6; $30 at $5 -> 5.
 */
export function openTradeCap({ equity, stake }) {
  const e = Number(equity);
  const s = Number(stake);
  if (!(e > 0) || !(s > 0)) return MIN_OPEN_TRADES;
  return Math.max(MIN_OPEN_TRADES, Math.min(MAX_OPEN_TRADES, Math.floor((e * DEPLOY_SHARE) / s)));
}

// --- The calendar ----------------------------------------------------------------------

let schedule = null;          // { at, sports: { key: { ok, error?, games: [...] } }, activeCount }
let refreshing = null;
let loopHandle = null;
let lastError = null;
let lastIdleLogAt = 0;

async function fetchEvents(sportKey, apiKey) {
  const url = `${ODDS_API_BASE}/sports/${encodeURIComponent(sportKey)}/events?apiKey=${apiKey}&dateFormat=iso`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 120);
      throw new Error(`HTTP ${res.status}${body ? `: ${body}` : ""}`);
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error("unexpected response shape");
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

/** Rebuilds the calendar for every active sport. Never throws. */
export async function refreshSchedule(config = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const apiKey = process.env.THE_ODDS_API_KEY;
      if (!apiKey) { lastError = "THE_ODDS_API_KEY is not set"; return; }
      const keys = await allActiveSportKeys();
      if (!keys.length) { lastError = "the odds feed returned no active sports"; return; }
      const off = new Set(Array.isArray(config.disabledSports) ? config.disabledSports.map(String) : []);
      const list = keys.filter((k) => !off.has(k));
      const now = Date.now();
      const sports = {};
      let next = 0;
      const worker = async () => {
        while (next < list.length) {
          const sportKey = list[next++];
          try {
            const rows = await fetchEvents(sportKey, apiKey);
            const runMs = runMsFor(sportKey);
            const games = rows
              .map((r) => ({ id: r.id, home: r.home_team ?? null, away: r.away_team ?? null, commence: r.commence_time }))
              .filter((g) => {
                const t = Date.parse(g.commence);
                return Number.isFinite(t) && t >= now - runMs && t <= now + AHEAD_MS;
              })
              .sort((a, b) => Date.parse(a.commence) - Date.parse(b.commence));
            sports[sportKey] = { ok: true, games };
          } catch (err) {
            sports[sportKey] = { ok: false, error: err.message, games: [] };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
      const okCount = Object.values(sports).filter((s) => s.ok).length;
      if (!okCount) {
        lastError = `no sport's calendar could be read (${Object.values(sports)[0]?.error ?? "unknown error"})`;
        return;
      }
      const before = schedule;
      schedule = { at: Date.now(), sports, activeCount: keys.length, off: [...off] };
      lastError = null;
      if (!before) {
        const p = schedulePlan();
        appendLog(
          `Live schedule built: ${okCount} sports, ${p.liveGames} game(s) live, ${p.soonGames} starting within 30 min` +
          (p.next ? `, next start ${p.next.home ?? ""} v ${p.next.away ?? ""} (${p.next.sportKey}) at ${p.next.commence.slice(11, 16)}Z` : "") +
          ". Scanning now follows the schedule on Kalshi and Polymarket."
        );
      }
    } catch (err) {
      lastError = err.message;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Starts the 10-minute rebuild. Safe to call more than once. */
export function startScheduleLoop(getConfig) {
  if (loopHandle) return;
  const run = () => refreshSchedule(typeof getConfig === "function" ? getConfig() : {}).catch(() => {});
  run();
  loopHandle = setInterval(run, REFRESH_MS);
}

export function stopScheduleLoop() {
  if (loopHandle) clearInterval(loopHandle);
  loopHandle = null;
}

/**
 * What to scan right now. ready=false means "no trustworthy calendar - use
 * the old behaviour". When ready:
 *   scan   - sports to scan (live + soon + any whose calendar read failed)
 *   known  - sports the calendar covers (a sport NOT in here is scanned too)
 */
export function schedulePlan(now = Date.now()) {
  if (!schedule) return { ready: false, reason: lastError || "schedule not built yet" };
  if (now - schedule.at > STALE_MS) return { ready: false, reason: `schedule is ${Math.round((now - schedule.at) / 60000)} minutes old` };

  const live = new Map();
  const soon = new Map();
  const scan = new Set();
  const failed = [];
  const known = new Set(Object.keys(schedule.sports));
  let next = null;
  let liveGames = 0, soonGames = 0;

  for (const [sportKey, entry] of Object.entries(schedule.sports)) {
    if (!entry.ok) { failed.push(sportKey); scan.add(sportKey); continue; }
    const runMs = runMsFor(sportKey);
    for (const g of entry.games) {
      const t = Date.parse(g.commence);
      if (t <= now && now - t <= runMs) {
        if (!live.has(sportKey)) live.set(sportKey, []);
        live.get(sportKey).push(g);
        liveGames++;
        scan.add(sportKey);
      } else if (t > now) {
        if (t - now <= LEAD_MS) {
          if (!soon.has(sportKey)) soon.set(sportKey, []);
          soon.get(sportKey).push(g);
          soonGames++;
          scan.add(sportKey);
        }
        if (!next || t < Date.parse(next.commence)) next = { sportKey, ...g };
      }
    }
  }
  return { ready: true, at: schedule.at, live, soon, scan, known, failed, next, liveGames, soonGames };
}

/** Should this sport be scanned now? True when there is no trustworthy calendar. */
export function shouldScanSport(sportKey, plan = schedulePlan()) {
  if (!plan.ready) return true;
  return plan.scan.has(sportKey) || !plan.known.has(sportKey);
}

/** Seconds until the next bot cycle. */
export function cycleSeconds(now = Date.now()) {
  const plan = schedulePlan(now);
  if (!plan.ready) return currentCadenceSeconds(new Date(now));
  return plan.scan.size ? LIVE_CADENCE_SECONDS : IDLE_CADENCE_SECONDS;
}

export function describeScheduleCadence(now = Date.now()) {
  const plan = schedulePlan(now);
  if (!plan.ready) return { ...describeCadence(new Date(now)), source: "clock (no schedule yet)", reason: plan.reason };
  if (plan.scan.size) return { seconds: LIVE_CADENCE_SECONDS, phase: "live games", source: "live schedule" };
  return {
    seconds: IDLE_CADENCE_SECONDS, phase: "idle", source: "live schedule",
    nextStart: plan.next ? plan.next.commence : null,
  };
}

/** One log line at most every 10 minutes while nothing is live or starting. */
export function logIdleOnce(plan) {
  const now = Date.now();
  if (now - lastIdleLogAt < 10 * 60 * 1000) return;
  lastIdleLogAt = now;
  const n = plan.next;
  appendLog(
    "Live schedule: no game live or starting within 30 minutes - not scanning." +
    (n ? ` Next: ${n.home ?? "?"} v ${n.away ?? "?"} (${n.sportKey}) at ${n.commence.slice(11, 16)}Z, ` +
      `scanning starts ${Math.max(0, Math.round((Date.parse(n.commence) - LEAD_MS - now) / 60000))} min from now.`
      : " Nothing on the calendar for the next 24 hours.")
  );
}

// --- Report for the dashboard and the monitor ------------------------------------------

function pmListedSet() {
  try { return new Set(Object.keys(mappedSports())); } catch { return new Set(); }
}
const pmListed = (set, k) => set.has(k) || /^tennis_(atp|wta)/.test(k);

export function scheduleReport(now = Date.now()) {
  const plan = schedulePlan(now);
  const base = {
    version: LIVE_SCHEDULE_VERSION,
    ready: plan.ready,
    reason: plan.ready ? null : plan.reason,
    builtAt: schedule ? new Date(schedule.at).toISOString() : null,
    ageSeconds: schedule ? Math.round((now - schedule.at) / 1000) : null,
    refreshMinutes: REFRESH_MS / 60000,
    leadMinutes: LEAD_MS / 60000,
    cadence: describeScheduleCadence(now),
  };
  if (!plan.ready) return { ...base, live: [], upcoming: [], sports: [] };

  let series = {};
  try { series = getSeriesMap() || {}; } catch { series = {}; }
  const pm = pmListedSet();
  const tag = (sportKey) => ({ kalshi: series[sportKey] || null, polymarket: pmListed(pm, sportKey) });

  const live = [];
  for (const [sportKey, games] of plan.live) {
    for (const g of games) live.push({ sportKey, ...g, minutesIn: Math.round((now - Date.parse(g.commence)) / 60000), ...tag(sportKey) });
  }
  live.sort((a, b) => Date.parse(a.commence) - Date.parse(b.commence));

  const upcoming = [];
  for (const [sportKey, entry] of Object.entries(schedule.sports)) {
    if (!entry.ok) continue;
    for (const g of entry.games) {
      const t = Date.parse(g.commence);
      if (t > now) upcoming.push({ sportKey, ...g, minutesUntil: Math.round((t - now) / 60000), ...tag(sportKey) });
    }
  }
  upcoming.sort((a, b) => Date.parse(a.commence) - Date.parse(b.commence));

  const sports = Object.entries(schedule.sports).map(([sportKey, entry]) => {
    const liveN = plan.live.get(sportKey)?.length || 0;
    const soonN = plan.soon.get(sportKey)?.length || 0;
    const nextGame = entry.games.find((g) => Date.parse(g.commence) > now) || null;
    return {
      sportKey,
      status: !entry.ok ? "calendar-error" : liveN ? "live" : soonN ? "starting-soon" : entry.games.length ? "later" : "none-24h",
      live: liveN, soon: soonN, next: nextGame ? nextGame.commence : null,
      gamesNext24h: entry.games.filter((g) => Date.parse(g.commence) > now).length,
      error: entry.ok ? null : entry.error,
      ...tag(sportKey),
    };
  }).sort((a, b) => {
    const rank = { live: 0, "starting-soon": 1, later: 2, "calendar-error": 3, "none-24h": 4 };
    return (rank[a.status] - rank[b.status]) || String(a.next || "~").localeCompare(String(b.next || "~")) || a.sportKey.localeCompare(b.sportKey);
  });

  return {
    ...base,
    counts: {
      sports: sports.length,
      liveSports: plan.live.size, liveGames: plan.liveGames,
      soonGames: plan.soonGames, scanning: plan.scan.size,
      upcoming24h: upcoming.length, calendarErrors: plan.failed.length,
    },
    next: plan.next,
    live,
    upcoming: upcoming.slice(0, 60),
    sports,
  };
}
