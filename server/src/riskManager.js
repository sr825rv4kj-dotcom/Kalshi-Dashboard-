/**
 * riskManager.js
 *
 * Edge evaluation and position sizing, built on one fact that governs
 * everything else:
 *
 *   KALSHI CHARGES A FEE ON EVERY TRADE. SETTLEMENT IS FREE.
 *
 * A contract bought and held until the game settles pays ONE fee. A contract
 * bought and sold back pays TWO. The old model assumed a round trip and
 * therefore demanded roughly double the edge it actually needed, which
 * rejected the majority of genuinely profitable entries while still allowing
 * live-game trades whose "edge" was really a stale sportsbook line.
 *
 * Measured, at the prices this bot actually trades:
 *   - round-trip fees are 8-20% of stake; a single fee is 4-10%
 *   - holding to settlement is worth +4 to +7c per contract versus flipping
 *     at the old take-profit target
 *   - a 5% stop-loss costs 12-25% of stake, of which the FEES are the larger
 *     half: the price move is 1-3c, the two fees are 4c
 *
 * So this module prices a hold-to-settlement binary, and nothing else.
 */

const DEFAULT_FEE_MULTIPLIER = 0.07;

/** Kalshi rounds the fee UP to a whole cent per contract, per trade. */
export function feeCentsAt(priceCents, multiplier = DEFAULT_FEE_MULTIPLIER) {
  const p = priceCents / 100;
  if (!(p > 0 && p < 1)) return 0;
  return Math.ceil(multiplier * p * (1 - p) * 100);
}

/** Dollars-per-contract fee, kept for callers that work in probability space. */
export function perContractFee(price, multiplier = DEFAULT_FEE_MULTIPLIER) {
  return feeCentsAt(Math.round(price * 100), multiplier) / 100;
}

/**
 * Expected value per contract, in cents, for buying YES at `priceCents` when
 * the true probability is `trueProbability` and the contract is HELD to
 * settlement.
 *
 *   win  (prob p):  +100c, minus the entry price and the one entry fee
 *   lose (prob 1-p): -entry price, minus the same fee
 *
 *   EV = p*100 - priceCents - fee(priceCents)
 */
export function evPerContractCents({ trueProbability, priceCents, multiplier = DEFAULT_FEE_MULTIPLIER }) {
  return trueProbability * 100 - priceCents - feeCentsAt(priceCents, multiplier);
}

/**
 * The edge a price must show before it is worth taking. One fee, plus a
 * buffer that absorbs devigging error in the sharp line.
 *
 * `expectRoundTrip` exists for callers that genuinely intend to sell back;
 * the bot does not, so it defaults to false.
 */
export function requiredEdgeThreshold({
  price,
  multiplier = DEFAULT_FEE_MULTIPLIER,
  expectRoundTrip = false,
  minTickBuffer = 0.015,
  feeSafetyMultiplier = 0.5,
}) {
  const priceCents = Math.round(price * 100);
  const entryFee = feeCentsAt(priceCents, multiplier) / 100;
  const fees = expectRoundTrip ? entryFee * 2 : entryFee;
  const safetyBuffer = Math.max(minTickBuffer, fees * feeSafetyMultiplier);
  return fees + safetyBuffer;
}

export function evaluateEdge({ observedEdge, price, multiplier = DEFAULT_FEE_MULTIPLIER, expectRoundTrip = false }) {
  const requiredEdge = requiredEdgeThreshold({ price, multiplier, expectRoundTrip });
  const margin = observedEdge - requiredEdge;
  return { qualifies: margin > 0, requiredEdge, observedEdge, margin };
}

/**
 * Kelly for a binary held to settlement. Now that the bot holds, Kelly is the
 * right rule: it assumes you collect the full binary payoff, which is exactly
 * what settlement pays.
 *
 * The one-contract floor stays. Kelly on a small bankroll rounds to zero
 * contracts, which reads in the logs as "no opportunity" when it is really
 * "cannot express this opportunity".
 */
export function fractionalKellySize({
  bankroll,
  trueProbability,
  price,
  kellyFraction = 0.25,
  multiplier = DEFAULT_FEE_MULTIPLIER,
  maxRiskPctPerTrade = 0.20,
  minContracts = 1,
  maxStakeDollars = null,
}) {
  if (price <= 0 || price >= 1) return { contracts: 0, dollarsAtRisk: 0, reason: "invalid price" };

  const priceCents = Math.round(price * 100);
  const evCents = evPerContractCents({ trueProbability, priceCents, multiplier });
  if (evCents <= 0) {
    return { contracts: 0, dollarsAtRisk: 0, evCents, reason: "no positive expected value after the entry fee" };
  }

  // Kelly on the fee-adjusted cost basis: the true price paid per contract is
  // the ask plus the fee, so that is what the odds are computed against.
  const effectiveCost = (priceCents + feeCentsAt(priceCents, multiplier)) / 100;
  const b = (1 - effectiveCost) / effectiveCost;
  const p = trueProbability;
  const q = 1 - p;
  const rawKelly = (b * p - q) / b;

  const scaledKelly = Math.max(0, rawKelly * kellyFraction);
  const cappedKelly = Math.min(scaledKelly, maxRiskPctPerTrade);
  let dollarsAtRisk = bankroll * cappedKelly;
  if (maxStakeDollars != null) dollarsAtRisk = Math.min(dollarsAtRisk, maxStakeDollars);

  let contracts = Math.floor(dollarsAtRisk / effectiveCost);

  if (contracts < minContracts) {
    const affordable = Math.floor(bankroll / effectiveCost);
    if (affordable >= minContracts) contracts = minContracts;
  }
  if (contracts * effectiveCost > bankroll) contracts = Math.floor(bankroll / effectiveCost);

  return {
    contracts,
    dollarsAtRisk: contracts * price,
    totalCostDollars: contracts * effectiveCost,
    expectedValueDollars: (contracts * evCents) / 100,
    evCents, rawKelly, scaledKelly, cappedKelly,
    reason: contracts > 0 ? "ok" : "bankroll cannot afford a single contract at this price",
  };
}

/**
 * Liquidity is measured against the order being placed, not an absolute
 * number. Requiring 50 resting contracts to buy 2 rejected most of the book.
 */
export function passesLiquidityFilter({ restingContracts, wantContracts = 1, minContracts = 0, coverageMultiple = 1.5 }) {
  const needed = Math.max(minContracts, Math.ceil(wantContracts * coverageMultiple));
  return restingContracts >= needed;
}

/**
 * The full entry decision.
 *
 * Gates run cheapest-first, and each returns a reason a human can read in the
 * log, because "no opportunity" with no explanation is what made this bot
 * impossible to debug.
 */
export function assessOpportunity({
  bankroll,
  trueProbability,
  price,
  restingContracts,
  multiplier = DEFAULT_FEE_MULTIPLIER,
  kellyFraction = 0.25,
  minLiquidity = 0,
  maxRiskPctPerTrade = 0.20,
  maxStakeDollars = null,
  maxPlausibleEdge = 0.18,
  minEntryPriceCents = 25,
  maxEntryPriceCents = 88,
  minEvCentsPerContract = 2,
  isLiveGame = false,
  allowLiveGames = true,
  lineAgeSeconds = null,
  maxLineAgeSecondsLive = 180,
  maxLineAgeSecondsPregame = 1800,
  survivalMode = null,
}) {
  const observedEdge = trueProbability - price;
  const priceCents = Math.round(price * 100);

  // --- Gate 1: the quote must be FRESH ---
  //
  // This gate used to refuse in-play games outright, on the assumption that a
  // sharp line stops updating at kickoff. That assumption was wrong: the odds
  // feed serves live in-play prices, and a live game is a perfectly good thing
  // to trade.
  //
  // What is NOT good to trade is a SUSPENDED quote. Books pull their markets
  // during a possession, a review, a pitching change - and the last posted
  // price stays on the wire looking exactly like a live one. Kalshi keeps
  // moving. The gap between a suspended book and a moving exchange is not
  // mispricing, and buying it means buying the team that just fell behind.
  //
  // Age is the only thing that separates the two, so age is what is checked.
  // In play the tolerance is tight, because a live book that has not ticked in
  // minutes is not quoting. Before kickoff it is loose, because a pre-game line
  // legitimately sits still.
  if (isLiveGame && !allowLiveGames) {
    return { action: "skip", reason: "live trading is switched off in config (allowLiveGames)" };
  }

  const maxAge = isLiveGame ? maxLineAgeSecondsLive : maxLineAgeSecondsPregame;
  if (maxAge) {
    if (lineAgeSeconds == null) {
      // Unknown age. Before kickoff that is fine - the line is not moving
      // anyway. In play it is not: a suspended market and a live one look
      // identical without a timestamp, so this fails closed.
      if (isLiveGame) {
        return {
          action: "skip",
          reason: "game is in play and this feed carries no quote timestamp - a suspended book cannot be told from a live one, so it is not traded",
        };
      }
    } else if (lineAgeSeconds > maxAge) {
      return {
        action: "skip",
        reason: `sharp quote is ${Math.round(lineAgeSeconds)}s old, past the ${maxAge}s limit for ` +
          `${isLiveGame ? "an in-play" : "a pre-game"} market - the book has likely suspended it while the exchange kept moving`,
      };
    }
  }

  // --- Gate 2: price band ---
  // Below the floor the whole-cent fee dominates: at 8c the round trip is 25%
  // of stake. Above the ceiling there is no room left to be right in.
  if (minEntryPriceCents && priceCents < minEntryPriceCents) {
    const fee = feeCentsAt(priceCents, multiplier);
    return {
      action: "skip",
      reason: `price ${priceCents}c is below the ${minEntryPriceCents}c floor - the ${fee}c fee is ${((fee / priceCents) * 100).toFixed(0)}% of the stake`,
    };
  }
  if (maxEntryPriceCents && priceCents > maxEntryPriceCents) {
    return {
      action: "skip",
      reason: `price ${priceCents}c is above the ${maxEntryPriceCents}c ceiling - too little upside left to cover being wrong`,
    };
  }

  // --- Gate 3: plausibility ---
  // A sharp book and Kalshi disagreeing by more than this on a pre-game line
  // means one of the two feeds is stale or mismatched, not that free money
  // is sitting on the screen.
  if (maxPlausibleEdge && observedEdge > maxPlausibleEdge) {
    return {
      action: "skip",
      reason: `edge ${(observedEdge * 100).toFixed(1)}% exceeds the ${(maxPlausibleEdge * 100).toFixed(0)}% plausibility ceiling - a gap that size is a stale or mismatched line, not a mispricing`,
    };
  }

  const inSurvivalMode = survivalMode && bankroll < survivalMode.balanceThreshold;
  const edgeMultiplier = inSurvivalMode ? survivalMode.edgeMultiplier || 1 : 1;

  // --- Gate 4: edge clears one fee plus a buffer ---
  const baseRequiredEdge = requiredEdgeThreshold({ price, multiplier, expectRoundTrip: false });
  const requiredEdge = baseRequiredEdge * edgeMultiplier;
  const margin = observedEdge - requiredEdge;
  const evCents = evPerContractCents({ trueProbability, priceCents, multiplier });

  if (margin <= 0) {
    return {
      action: "skip",
      reason: `edge ${(observedEdge * 100).toFixed(2)}% below the ${(requiredEdge * 100).toFixed(2)}% needed to clear the ${feeCentsAt(priceCents, multiplier)}c fee` +
        (inSurvivalMode ? " (survival mode - stricter bar)" : ""),
    };
  }

  // --- Gate 5: absolute EV floor ---
  // A percentage edge on a cheap contract can still be worth a fraction of a
  // cent per contract. Fractions of a cent do not pay for hosting.
  if (minEvCentsPerContract && evCents < minEvCentsPerContract) {
    return {
      action: "skip",
      reason: `expected value ${evCents.toFixed(2)}c per contract is below the ${minEvCentsPerContract}c floor - the edge is real but too thin to be worth the capital`,
    };
  }

  const edgeCheck = { qualifies: true, requiredEdge, observedEdge, margin, evCents };

  // --- Sizing ---
  let sizing;
  if (inSurvivalMode) {
    const flatDollars = survivalMode.flatBetDollars || 1;
    let contracts = Math.floor(flatDollars / price);
    if (contracts < 1 && bankroll >= price) contracts = 1;
    sizing = {
      contracts, dollarsAtRisk: contracts * price, evCents,
      expectedValueDollars: (contracts * evCents) / 100,
      mode: "survival-flat",
      reason: contracts > 0 ? "ok" : "bankroll cannot afford a single contract at this price",
    };
  } else {
    sizing = fractionalKellySize({
      bankroll, trueProbability, price, kellyFraction, multiplier, maxRiskPctPerTrade, maxStakeDollars,
    });
  }

  if (sizing.contracts <= 0) return { action: "skip", reason: sizing.reason };

  // --- Gate 6: the book can actually fill this size ---
  const liquidityOk = passesLiquidityFilter({
    restingContracts, wantContracts: sizing.contracts, minContracts: minLiquidity,
  });
  if (!liquidityOk) {
    return {
      action: "skip",
      reason: `insufficient liquidity (${restingContracts} resting, need ${Math.ceil(sizing.contracts * 1.5)} to fill ${sizing.contracts} contracts)`,
    };
  }

  return { action: "candidate", edgeCheck, sizing, survivalMode: inSurvivalMode };
}
