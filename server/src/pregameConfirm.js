/**
 * pregameConfirm.js
 *
 * PRE-GAME WAITING PERIOD (2026-10-01, account holder's call).
 *
 * A pre-game edge is not bought the first time it appears. The bot watches the
 * game first and buys only when the SAME side has qualified - every entry rule
 * passed, 30% minimum return included - on consecutive scans that span a
 * minimum time, and the sharp line has not drifted away from that side while
 * it watched:
 *
 *   - minScans qualifying scans in a row (default 3)
 *   - spanning at least minMinutes (default 3)
 *   - no gap longer than maxGapSeconds between them (default 180) - a scan
 *     that stops qualifying lets the streak lapse and the watch starts over
 *   - the other side of the same game qualifying instead restarts the watch
 *     on that side
 *   - the sharp fair value may not fall more than maxDriftPoints (default 2)
 *     below where it stood when the watch began - money moving against the
 *     side is the line telling the bot something, and the watch restarts
 *
 * A one-scan blip - a stale line, a book that has not caught up yet - is gone
 * by the second or third read and is never bought. Live games are not
 * affected. Kalshi and Polymarket keep separate watches.
 */

export const PREGAME_CONFIRM_VERSION = "2026-10-01-pregame-confirm";

const watches = new Map();   // `${venue}|${gameKey}` -> { team, firstAt, lastAt, scans, firstFair, lastFair }

export function pregameConfirmSettings(config = {}) {
  const p = config.pregameConfirm || {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return {
    enabled: p.enabled !== false,
    minScans: num(p.minScans, 3),
    minMinutes: num(p.minMinutes, 3),
    maxGapSeconds: num(p.maxGapSeconds, 180),
    maxDriftPoints: num(p.maxDriftPoints, 2),
  };
}

/**
 * Records one qualifying pre-game sighting and says whether the side is now
 * confirmed. Pure apart from the in-memory watch table; `now` is injectable.
 *
 *   venue    "kalshi" | "polymarket"
 *   gameKey  identifies the game (sport + start time + both teams)
 *   team     the side that qualified this scan
 *   fairPct  the sharp fair value for that side, in percent
 */
export function observePregame({ venue, gameKey, team, fairPct }, config = {}, now = Date.now()) {
  const s = pregameConfirmSettings(config);
  if (!s.enabled) return { ready: true, scans: 0, minutes: 0, why: "waiting period off" };
  const key = `${venue}|${gameKey}`;
  let w = watches.get(key);
  let restart = null;
  if (!w) restart = "first sighting";
  else if (w.team !== team) restart = `side switched from ${w.team} to ${team}`;
  else if ((now - w.lastAt) / 1000 > s.maxGapSeconds) restart = `no qualifying read for ${Math.round((now - w.lastAt) / 1000)}s`;
  else if (Number(fairPct) < w.firstFair - s.maxDriftPoints) {
    restart = `sharp line drifted ${(w.firstFair - Number(fairPct)).toFixed(1)} pts away (${w.firstFair.toFixed(1)}% -> ${Number(fairPct).toFixed(1)}%)`;
  }
  if (restart) {
    w = { team, firstAt: now, lastAt: now, scans: 1, firstFair: Number(fairPct), lastFair: Number(fairPct) };
    watches.set(key, w);
  } else {
    w.scans += 1;
    w.lastAt = now;
    w.lastFair = Number(fairPct);
  }
  const minutes = (now - w.firstAt) / 60000;
  const ready = w.scans >= s.minScans && minutes >= s.minMinutes;
  const why = ready
    ? `confirmed: ${w.scans} qualifying reads over ${minutes.toFixed(1)} min, line ${w.firstFair.toFixed(1)}% -> ${w.lastFair.toFixed(1)}%`
    : `watching before buying: ${w.scans}/${s.minScans} qualifying reads, ${minutes.toFixed(1)}/${s.minMinutes} min` +
      (restart && restart !== "first sighting" ? ` (restarted: ${restart})` : "");
  return { ready, scans: w.scans, minutes, why, restarted: restart };
}

/** Forget a game's watch (after a buy, or when the game starts). */
export function clearPregame(venue, gameKey) {
  watches.delete(`${venue}|${gameKey}`);
}

/** Drop watches untouched for an hour - games that started or went away. */
export function prunePregame(now = Date.now()) {
  for (const [k, w] of watches) if (now - w.lastAt > 60 * 60 * 1000) watches.delete(k);
}

export function pregameWatchReport() {
  return [...watches.entries()].map(([k, w]) => ({
    key: k, team: w.team, scans: w.scans,
    minutes: Math.round(((w.lastAt - w.firstAt) / 60000) * 10) / 10,
    firstFair: w.firstFair, lastFair: w.lastFair,
  }));
}
