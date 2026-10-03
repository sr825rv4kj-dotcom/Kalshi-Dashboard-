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

export const PREGAME_CONFIRM_VERSION = "2026-10-02-price-reader";

/*
 * PRICE READER (2026-10-02, account holder's call): the watch now reads the
 * PRICE as well as the line. Every qualifying read records the ask. Once the
 * minimum reads and minutes are met, the side is bought only when the ask is
 * back within reader.toleranceCents of the LOWEST ask seen during the watch -
 * buying the dip, not the spike. While the ask sits higher the bot keeps
 * taking reads (several takes at an entry). After reader.maxWatchMinutes it
 * stops waiting for the low and buys at the current ask if the side still
 * passes every rule, so a real edge is never missed just because the price
 * did not come back. The order limit is capped at low + tolerance while the
 * reader is waiting, so the walk-up can never pay above the range it read.
 *
 *   reader.enabled          default true
 *   reader.toleranceCents   default 1   (buy at or within 1c of the low)
 *   reader.maxWatchMinutes  default 5   (stop waiting for the low after this)
 */

/*
 * LIVE TOO (2026-10-01, account holder's call): every entry now waits, live
 * games included, with their own settings (config.pregameConfirm.live):
 * 4 qualifying reads over at least 2 minutes, and the fair value - which in
 * play comes from the score-checked model - may not drop more than 3 points
 * while it watches (a score against the side restarts the watch). A pre-game
 * watch never carries into the live game: each phase has its own watch.
 */

const watches = new Map();   // `${venue}|${phase}|${gameKey}` -> { team, firstAt, lastAt, scans, firstFair, lastFair, lowAsk, highAsk, lastAsk, asks }

/** Price-reader settings (config.pregameConfirm.reader). */
export function readerSettings(config = {}) {
  const r = (config.pregameConfirm && config.pregameConfirm.reader) || {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return {
    enabled: r.enabled !== false,
    toleranceCents: num(r.toleranceCents, 1),
    maxWatchMinutes: num(r.maxWatchMinutes, 5),
  };
}

export function pregameConfirmSettings(config = {}, phase = "pregame") {
  const p = config.pregameConfirm || {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  if (phase === "live") {
    const l = p.live || {};
    return {
      enabled: p.enabled !== false && l.enabled !== false,
      minScans: num(l.minScans, 4),
      minMinutes: num(l.minMinutes, 2),
      maxGapSeconds: num(l.maxGapSeconds, 90),
      maxDriftPoints: num(l.maxDriftPoints, 3),
    };
  }
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
export function observePregame({ venue, gameKey, team, fairPct, live = false, askCents = null }, config = {}, now = Date.now()) {
  const phase = live ? "live" : "pregame";
  const s = pregameConfirmSettings(config, phase);
  if (!s.enabled) return { ready: true, scans: 0, minutes: 0, why: "waiting period off" };
  const key = `${venue}|${phase}|${gameKey}`;
  let w = watches.get(key);
  let restart = null;
  if (!w) restart = "first sighting";
  else if (w.team !== team) restart = `side switched from ${w.team} to ${team}`;
  else if ((now - w.lastAt) / 1000 > s.maxGapSeconds) restart = `no qualifying read for ${Math.round((now - w.lastAt) / 1000)}s`;
  else if (Number(fairPct) < w.firstFair - s.maxDriftPoints) {
    restart = `sharp line drifted ${(w.firstFair - Number(fairPct)).toFixed(1)} pts away (${w.firstFair.toFixed(1)}% -> ${Number(fairPct).toFixed(1)}%)`;
  }
  const ask = Number.isFinite(Number(askCents)) && Number(askCents) > 0 ? Math.round(Number(askCents)) : null;
  if (restart) {
    w = { team, firstAt: now, lastAt: now, scans: 1, firstFair: Number(fairPct), lastFair: Number(fairPct), lowAsk: ask, highAsk: ask, lastAsk: ask, asks: ask != null ? [ask] : [] };
    watches.set(key, w);
  } else {
    w.scans += 1;
    w.lastAt = now;
    w.lastFair = Number(fairPct);
    if (ask != null) {
      w.lastAsk = ask;
      w.lowAsk = w.lowAsk == null ? ask : Math.min(w.lowAsk, ask);
      w.highAsk = w.highAsk == null ? ask : Math.max(w.highAsk, ask);
      w.asks = [...(w.asks || []), ask].slice(-30);
    }
  }
  const minutes = (now - w.firstAt) / 60000;
  const confirmed = w.scans >= s.minScans && minutes >= s.minMinutes;
  const restartNote = restart && restart !== "first sighting" ? ` (restarted: ${restart})` : "";
  if (!confirmed) {
    return {
      ready: false, scans: w.scans, minutes, restarted: restart, lowAsk: w.lowAsk, maxPriceCents: null,
      why: `watching before buying: ${w.scans}/${s.minScans} qualifying reads, ${minutes.toFixed(1)}/${s.minMinutes} min` +
        (w.lowAsk != null ? `, price ${w.lastAsk}c (low ${w.lowAsk}c, high ${w.highAsk}c)` : "") + restartNote,
    };
  }

  const base = `${w.scans} qualifying reads over ${minutes.toFixed(1)} min, line ${w.firstFair.toFixed(1)}% -> ${w.lastFair.toFixed(1)}%`;
  const r = readerSettings(config);
  if (!r.enabled || ask == null || w.lowAsk == null) {
    return { ready: true, scans: w.scans, minutes, restarted: restart, lowAsk: w.lowAsk, maxPriceCents: null, why: `confirmed: ${base}` };
  }
  const ceiling = w.lowAsk + r.toleranceCents;
  if (ask <= ceiling) {
    return {
      ready: true, scans: w.scans, minutes, restarted: restart, lowAsk: w.lowAsk, maxPriceCents: ceiling,
      why: `confirmed at a good price: ${base}; ask ${ask}c is within ${r.toleranceCents}c of the ${w.lowAsk}c low it read (range ${w.lowAsk}-${w.highAsk}c)`,
    };
  }
  if (minutes >= r.maxWatchMinutes) {
    return {
      ready: true, scans: w.scans, minutes, restarted: restart, lowAsk: w.lowAsk, maxPriceCents: null,
      why: `confirmed after ${minutes.toFixed(1)} min of reads: ${base}; ask ${ask}c never came back to the ${w.lowAsk}c low - ` +
        `still passes every rule, so it is bought rather than missed`,
    };
  }
  return {
    ready: false, scans: w.scans, minutes, restarted: restart, lowAsk: w.lowAsk, maxPriceCents: ceiling,
    why: `reading the price: ask ${ask}c is above the ${w.lowAsk}c low it read (range ${w.lowAsk}-${w.highAsk}c) - ` +
      `waiting for ${ceiling}c or less, up to ${r.maxWatchMinutes} min (${minutes.toFixed(1)} so far)`,
  };
}

/** Forget a game's watch (after a buy, or when the game starts). */
export function clearPregame(venue, gameKey) {
  watches.delete(`${venue}|pregame|${gameKey}`);
  watches.delete(`${venue}|live|${gameKey}`);
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
    lowAsk: w.lowAsk ?? null, highAsk: w.highAsk ?? null, lastAsk: w.lastAsk ?? null,
  }));
}
