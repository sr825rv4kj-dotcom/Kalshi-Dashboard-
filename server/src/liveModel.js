/**
 * liveModel.js
 *
 * An in-game win-probability estimate, used to CORROBORATE the sharp line on
 * markets that are already in play.
 *
 * Why this exists. Three live NFL positions were opened and two of them were
 * bought at prices only a stale line could justify:
 *
 *   PHI bought at 82c  -> the sharp line had to be quoting >= 86%.
 *                         The game was TIED 17-17 with a quarter left.
 *   HOU bought at 36c  -> the sharp line had to be quoting >= 40%.
 *                         HOU were DOWN 7 in the second half.
 *
 * No live book quotes an 86% favourite in a tied game, or a 40% dog down a
 * touchdown after halftime. Those are pre-game numbers. The odds feed returns
 * in-play events, and the record's timestamp does refresh, but for these
 * markets the h2h PRICE was still the pre-game one - so a freshness check on
 * last_update cannot see it. The only thing that can is the score.
 *
 * The method. The pre-game line is not thrown away, it is used as what it
 * actually is: a prior on team strength. That prior is converted to an
 * expected margin, decayed by how much of the game is left, added to the
 * current lead, and scaled by the remaining volatility:
 *
 *   priorMargin     = sigma * invNorm(pregameProbability)
 *   remainingEdge   = priorMargin * fractionRemaining
 *   z               = (lead + remainingEdge) / (sigma * sqrt(fractionRemaining))
 *   winProbability  = normalCdf(z)
 *
 * Checked against the three real positions above, with the real scores:
 *
 *   team   model   Kalshi   raw sharp line
 *   HOU     14%      16%        40%     <- model off by 2, line off by 24
 *   PHI     71%      65%        86%     <- model off by 6, line off by 21
 *   MIN     63%      49%        42%     <- model off by 14, line off by 7
 *
 * Better on two of three, and far better where it mattered. It is NOT precise
 * enough to be trusted as truth on its own - the MIN row is 14 points out,
 * because this knows nothing about possession, field position or injuries.
 * So it is used as a second opinion, never as the price.
 */

/** Abramowitz-Stegun error function; accurate to ~1e-7, no dependencies. */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

export function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Inverse normal CDF by bisection - called a handful of times per scan. */
export function normalInv(p) {
  if (!(p > 0)) return -6;
  if (p >= 1) return 6;
  let lo = -6, hi = 6;
  for (let i = 0; i < 120; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Per-sport scoring volatility (standard deviation of final margin) and the
 * typical WALL-CLOCK length of a game, which is how time remaining is
 * estimated - the scores feed carries no game clock.
 */
export const SPORT_PARAMS = {
  americanfootball_nfl:   { sigma: 13.5, wallClockMinutes: 195 },
  americanfootball_ncaaf: { sigma: 16.5, wallClockMinutes: 210 },
  basketball_nba:         { sigma: 11.5, wallClockMinutes: 145 },
  basketball_ncaab:       { sigma: 10.5, wallClockMinutes: 125 },
  icehockey_nhl:          { sigma: 2.2,  wallClockMinutes: 150 },
  baseball_mlb:           { sigma: 4.2,  wallClockMinutes: 180 },
  soccer_epl:             { sigma: 1.6,  wallClockMinutes: 115 },
  soccer_spain_la_liga:   { sigma: 1.6,  wallClockMinutes: 115 },
  soccer_germany_bundesliga: { sigma: 1.7, wallClockMinutes: 115 },
  soccer_italy_serie_a:   { sigma: 1.5,  wallClockMinutes: 115 },
  soccer_usa_mls:         { sigma: 1.7,  wallClockMinutes: 115 },
};

/**
 * Fallback for a sport with no calibrated numbers.
 *
 * Returning null used to mean every in-play market in that sport was dropped
 * in silence - tennis sat in the sports pool all day being refused with no
 * trace. A wide sigma makes the model deliberately unconfident, so the
 * corroboration gate leans on the sharp line rather than on numbers nobody
 * calibrated, but the market at least gets considered.
 */
const GENERIC_PARAMS = { sigma: 12, wallClockMinutes: 150, generic: true };

export function paramsFor(sportKey, { allowGeneric = true } = {}) {
  return SPORT_PARAMS[sportKey] || (allowGeneric ? GENERIC_PARAMS : null);
}

/**
 * Fraction of the game still to play, estimated from wall clock since kickoff.
 *
 * The scores endpoint does not publish a game clock, so this is deliberately
 * coarse. It only has to be roughly right: the model is a sanity check, and
 * being a few minutes out moves the estimate by a point or two. Clamped to
 * [0.02, 1] so a long stoppage cannot make the estimate go negative and a
 * just-started game cannot divide by ~0.
 */
export function fractionRemaining(sportKey, commenceTime, now = Date.now()) {
  const p = paramsFor(sportKey);
  if (!p || !commenceTime) return null;
  const startMs = Date.parse(commenceTime);
  if (!Number.isFinite(startMs)) return null;
  const elapsedMin = (now - startMs) / 60000;
  if (elapsedMin <= 0) return 1;
  return Math.max(0.02, Math.min(1, 1 - elapsedMin / p.wallClockMinutes));
}

/**
 * In-game win probability for the team whose current margin is `lead`.
 * Returns null when the sport has no parameters - the caller must then treat
 * the market as un-modellable rather than guess.
 */
export function liveWinProbability({ sportKey, pregameProbability, lead, fracRemaining }) {
  const p = paramsFor(sportKey);
  if (!p) return null;
  if (fracRemaining == null) return null;
  if (fracRemaining <= 0.02) return lead > 0 ? 0.99 : lead < 0 ? 0.01 : 0.5;

  const prior = Math.min(0.99, Math.max(0.01, Number(pregameProbability) || 0.5));
  const priorMargin = p.sigma * normalInv(prior);
  const remainingEdge = priorMargin * fracRemaining;
  const z = (lead + remainingEdge) / (p.sigma * Math.sqrt(fracRemaining));
  return Math.min(0.99, Math.max(0.01, normalCdf(z)));
}

/**
 * The probability the entry gate should actually use for an in-play market.
 *
 * It takes the MORE CONSERVATIVE of the sharp line and the live model, so a
 * trade needs both to agree there is value. This does not require the model to
 * be right - only to be a second witness. When the line is stale the model
 * vetoes it; when the model is off, the line vetoes the model.
 *
 * Returns { probability, modelProbability, disagreementPoints, usable }.
 */
export function corroboratedProbability({ sportKey, sharpProbability, lead, fracRemaining }) {
  const model = liveWinProbability({
    sportKey, pregameProbability: sharpProbability, lead, fracRemaining,
  });
  if (model == null) {
    return { probability: null, modelProbability: null, disagreementPoints: null, usable: false };
  }
  return {
    probability: Math.min(sharpProbability, model),
    modelProbability: model,
    disagreementPoints: Math.abs(sharpProbability - model) * 100,
    usable: true,
  };
}
