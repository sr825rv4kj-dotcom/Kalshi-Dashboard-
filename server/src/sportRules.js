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
