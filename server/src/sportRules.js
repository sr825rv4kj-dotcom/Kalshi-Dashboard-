/**
 * sportRules.js  (2026-10-02)
 *
 * Per-sport rules shared by the Kalshi scanner, the Kalshi maker, the live
 * schedule and the Polymarket engine. No imports on purpose - every module
 * can use it without an import cycle.
 *
 * Source: the account's own 138 closed trades (export 2026-10-02 02:13Z).
 *
 *   disabledSports      exact sport keys, or a prefix ending in "*"
 *                       ("tennis_*" = every tennis tournament key)
 *   sportMinEntryCents  per-sport price floor, raised over the normal band.
 *                       NHL: entries under 45c won 2 of 13, at 45c+ won 4 of 5
 *   polymarket.entrySports  sports Polymarket may BUY in. Kalshi's settled
 *                       winners: NFL 13-6 (+$31.64), NCAAF (+$14.33).
 *                       Polymarket outside them: 12 trades, 3 wins, -$23
 *   fairShrink          share of the model's edge (fair - price) treated as
 *                       real. Kalshi realized 48% of its claimed edge over
 *                       the 44 trades that recorded one -> 0.5
 */

/** Is this sport switched off? Supports exact keys and "prefix*" entries. */
export function sportDisabled(sportKey, config = {}) {
  const key = String(sportKey || "");
  const list = Array.isArray(config.disabledSports) ? config.disabledSports : [];
  for (const raw of list) {
    const k = String(raw || "").trim();
    if (!k) continue;
    if (k.endsWith("*")) {
      if (key.startsWith(k.slice(0, -1))) return true;
    } else if (k === key) {
      return true;
    }
  }
  return false;
}

/** The per-sport price floor in cents, or 0 when the sport has none. */
export function sportMinEntryCents(sportKey, config = {}) {
  const map = config.sportMinEntryCents && typeof config.sportMinEntryCents === "object" ? config.sportMinEntryCents : {};
  const n = Number(map[sportKey]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The config one sport is scanned with: the normal config, with the price
 * floor (pre-game and live) raised to the sport's own floor where it has one.
 * Never lowers anything.
 */
export function withSportRules(config = {}, sportKey) {
  const floor = sportMinEntryCents(sportKey, config);
  if (!floor) return config;
  return {
    ...config,
    minEntryPriceCents: Math.max(Number(config.minEntryPriceCents ?? 0), floor),
    liveBandMinCents: Math.max(Number(config.liveBandMinCents ?? 0), floor),
    minLiveEntryPriceCents: Math.max(Number(config.minLiveEntryPriceCents ?? 0), floor),
  };
}

/** May Polymarket open a new position in this sport? Empty list = every sport. */
export function polymarketSportAllowed(sportKey, config = {}) {
  const pm = config.polymarket && typeof config.polymarket === "object" ? config.polymarket : {};
  const list = Array.isArray(pm.entrySports) ? pm.entrySports : DEFAULT_PM_ENTRY_SPORTS;
  if (!list.length) return true;
  return list.includes(sportKey);
}

export const DEFAULT_PM_ENTRY_SPORTS = ["americanfootball_nfl", "americanfootball_ncaaf"];

/**
 * MODEL PRICING WHEN THE LINE IS STALE (2026-10-02 night, account holder's
 * call: "do not skip trades"). In play, when the sharp line and the score
 * model are more than maxModelDisagreementPoints apart, the line is the stale
 * one - the betting feed's books trail the game. Instead of skipping, the game
 * is priced on the score model (built from the pre-game closing line plus the
 * live score and clock) and goes through every normal gate: price band, the
 * realized-edge minimum return, the 18% plausibility cap, the price reader.
 *
 * Tonight's vetoed games, checked against final scores: the model's side won
 * Pittsburgh (35-33) and Golden State (77-73); the stale line's side lost on
 * Virginia Tech.
 *
 * Not for soccer: the model has no draw, so it overrates the trailing side
 * (Gimnasia down 1-0 read 29%). Off with livePricing.modelWhenStale = false.
 */
export function modelPricingAllowed(sportKey, config = {}) {
  const lp = config.livePricing && typeof config.livePricing === "object" ? config.livePricing : {};
  if (lp.modelWhenStale === false) return false;
  const excluded = Array.isArray(lp.excludePrefixes) ? lp.excludePrefixes : ["soccer_"];
  return !excluded.some((p) => String(sportKey || "").startsWith(String(p)));
}

/**
 * THREE TRADE LANES (2026-10-03, account holder's call: keep every strategy,
 * use each where it fits, priority on profit; 50-92c is vital). From the
 * account's Kalshi record by entry price:
 *
 *   35-49c   72 trades  +$35.91  +16%   <- the proven lane, kept
 *   50-69c   20 trades   -$4.67         <- underdogs/coin flips here lost
 *   70c+      7 trades   -$2.35         <- favorites: small sample
 *
 *   DIP lane       ask 35-49c, any win chance, needs dip.minReturnPct (5%)
 *                  expected return on the realized edge
 *   FAVORITE lane  win chance favorite.minWinProbability (65%) or better,
 *                  ask up to favorite.maxCents (92c), favorite.minReturnPct (0.5%)
 *   MIDDLE lane    ask 50-92c, under 65% to win, expected return between
 *                  middle.minReturnPct (0.5%) and middle.maxReturnPct (8%).
 *                  The account's 27 Kalshi trades at 50-92c, by realized edge
 *                  at entry:
 *                    8%+    4 trades  1 won  -$12.49  (a gap that big at these
 *                                                      prices was a bad line)
 *                    0-8%  14 trades 11 won   +$6.10
 *                  So the middle lane takes the modest edges and refuses the
 *                  "too good" ones.
 *
 * Every candidate from all lanes is ranked by expected return and the best
 * is bought first.
 * Win chance is read from the fair value BEFORE the realized-edge shrink.
 */
export const DEFAULT_LANES = {
  dip: { enabled: true, minCents: 35, maxCents: 49, minReturnPct: 5 },
  favorite: { enabled: true, minWinProbability: 0.65, maxCents: 92, minReturnPct: 0.5 },
  middle: { enabled: true, minCents: 50, maxCents: 92, minReturnPct: 0.5, maxReturnPct: 8 },
};

export function lanesOf(config = {}) {
  const l = config.lanes && typeof config.lanes === "object" ? config.lanes : {};
  return {
    dip: { ...DEFAULT_LANES.dip, ...(l.dip || {}) },
    favorite: { ...DEFAULT_LANES.favorite, ...(l.favorite || {}) },
    middle: { ...DEFAULT_LANES.middle, ...(l.middle || {}) },
  };
}

/**
 * Which lane a candidate trades in, or null. A side that fits both (65%+ to
 * win at 49c or less) is a favorite bought at a dip price - it takes the
 * favorite lane, whose wider price range never cuts its order limit short.
 */
export function laneFor({ winProbability, askCents }, config = {}) {
  const L = lanesOf(config);
  const p = Number(winProbability);
  const a = Number(askCents);
  if (L.favorite.enabled !== false && p >= Number(L.favorite.minWinProbability) && a <= Number(L.favorite.maxCents)) {
    return { name: "favorite", maxCents: Number(L.favorite.maxCents), minReturnPct: Number(L.favorite.minReturnPct) };
  }
  if (L.dip.enabled !== false && a >= Number(L.dip.minCents) && a <= Number(L.dip.maxCents)) {
    return { name: "dip", maxCents: Number(L.dip.maxCents), minReturnPct: Number(L.dip.minReturnPct) };
  }
  if (L.middle.enabled !== false && a >= Number(L.middle.minCents) && a <= Number(L.middle.maxCents)) {
    return { name: "middle", maxCents: Number(L.middle.maxCents), minReturnPct: Number(L.middle.minReturnPct), maxReturnPct: Number(L.middle.maxReturnPct) };
  }
  return null;
}

export function laneMiss({ winProbability, askCents }, config = {}) {
  const L = lanesOf(config);
  return `${askCents}c at a ${(Number(winProbability) * 100).toFixed(0)}% win chance fits no lane - ` +
    `dip lane buys ${L.dip.minCents}-${L.dip.maxCents}c, middle lane ${L.middle.minCents}-${L.middle.maxCents}c, ` +
    `favorite lane needs ${(L.favorite.minWinProbability * 100).toFixed(0)}%+ to win (up to ${L.favorite.maxCents}c)`;
}

/**
 * RETURN TIERS (2026-10-03): every qualifying trade is labelled by its
 * expected return after fees on the realized edge. Candidates are already
 * bought best expected return first; the tier makes that visible in the log
 * and on the Scanner tab. Below the last tier's floor nothing is bought.
 */
export const RETURN_TIERS = [65, 30, 15, 5, 2, 0.5];
export function returnTierOf(pct) {
  const p = Number(pct);
  if (!Number.isFinite(p)) return null;
  for (const t of RETURN_TIERS) if (p >= t) return `${t}%+ tier`;
  return null;
}

/**
 * BLOCKED PRICE RANGE (2026-10-09, account holder's call: "delete 60-69c
 * trades"). Across both exchanges, buys at 60-69c: 34 trades, 17 won against
 * 21.8 their prices implied, -$42.81 - the average win $1.43, the average
 * loss $4.80. 50-59c over the same period: 32 trades, +$29.30.
 *
 * Nothing is bought inside a blocked range - not by a taker order, not by a
 * walk-up limit (capped one cent under the range), not by a resting bid, and
 * not by Polymarket's copy of a Kalshi trade. config.blockedEntryCents
 * replaces the default; [] removes the block.
 */
export const DEFAULT_BLOCKED_ENTRY_CENTS = [{ min: 60, max: 69 }];

function blockedRanges(config = {}) {
  const list = Array.isArray(config.blockedEntryCents) ? config.blockedEntryCents : DEFAULT_BLOCKED_ENTRY_CENTS;
  return list
    .map((r) => ({ min: Number(r?.min), max: Number(r?.max) }))
    .filter((r) => Number.isFinite(r.min) && Number.isFinite(r.max) && r.min <= r.max);
}

/** The blocked range a price falls in, or null. */
export function blockedEntryRange(priceCents, config = {}) {
  const p = Number(priceCents);
  if (!Number.isFinite(p)) return null;
  return blockedRanges(config).find((r) => p >= r.min && p <= r.max) || null;
}

/**
 * The highest limit that cannot fill inside a blocked range: an order with an
 * ask under a range and a limit reaching into it is capped one cent under it.
 */
export function limitBelowBlocked(askCents, limitCents, config = {}) {
  let limit = Number(limitCents);
  const ask = Number(askCents);
  for (const r of blockedRanges(config)) {
    if (ask < r.min && limit >= r.min) limit = r.min - 1;
  }
  return limit;
}

/** The fair-value shrink factor, clamped to (0, 1]. 1 = no shrink. */
export function fairShrinkOf(config = {}) {
  const n = Number(config.fairShrink);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(1, n);
}

/**
 * Fair value pulled toward the price being paid:
 *   shrunk = price + w * (fair - price)
 * so the edge used for sizing, limits and expected return is w x the model's
 * edge - what the account has actually realized. Anchored at the ask, the
 * price the order pays.
 */
export function shrinkFair(fairProbability, askCents, w = 1) {
  const p = Number(fairProbability);
  const a = Number(askCents) / 100;
  if (!Number.isFinite(p) || !Number.isFinite(a) || a <= 0 || a >= 1 || !(w > 0) || w >= 1) return p;
  return a + w * (p - a);
}
