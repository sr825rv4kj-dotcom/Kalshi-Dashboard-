/**
 * Fee-aware edge threshold + position sizing.
 *
 * Two constants here were sized for a bankroll two orders of magnitude larger
 * than the live one and made trading arithmetically impossible: a 1% per-trade
 * risk cap (19c on a $19.67 account - less than one contract) and a 50-contract
 * liquidity floor on a strategy that buys 2-3. Both are now relative to what
 * the account is actually trying to do.
 */

const DEFAULT_FEE_MULTIPLIER = 0.07;

export function perContractFee(price, multiplier = DEFAULT_FEE_MULTIPLIER) {
  const raw = multiplier * price * (1 - price);
  return Math.ceil(raw * 100) / 100;
}

export function roundTripFeeCost(entryPrice, exitPrice, multiplier = DEFAULT_FEE_MULTIPLIER) {
  return perContractFee(entryPrice, multiplier) + perContractFee(exitPrice, multiplier);
}

/**
 * Scales the safety buffer with the fee itself rather than a flat percentage,
 * so high-confidence (90c+) contracts stay reachable.
 */
export function requiredEdgeThreshold({
  price,
  multiplier = DEFAULT_FEE_MULTIPLIER,
  expectSameDayExit = true,
  minTickBuffer = 0.01,
  feeSafetyMultiplier = 0.5,
}) {
  const entryFee = perContractFee(price, multiplier);
  const exitFee = expectSameDayExit ? perContractFee(price, multiplier) : 0;
  const roundTripFees = entryFee + exitFee;
  const safetyBuffer = Math.max(minTickBuffer, roundTripFees * feeSafetyMultiplier);
  return roundTripFees + safetyBuffer;
}

export function evaluateEdge({ observedEdge, price, multiplier = DEFAULT_FEE_MULTIPLIER, expectSameDayExit = true }) {
  const requiredEdge = requiredEdgeThreshold({ price, multiplier, expectSameDayExit });
  const margin = observedEdge - requiredEdge;
  return { qualifies: margin > 0, requiredEdge, observedEdge, margin };
}

/**
 * Kelly sizing with a floor. Kelly is a percentage rule, and percentages of a
 * small bankroll round to zero contracts - which reads in the logs as "no
 * opportunity" when it is really "cannot express any opportunity". If the edge
 * qualifies and the account can afford one contract, it buys at least one.
 */
export function fractionalKellySize({
  bankroll,
  trueProbability,
  price,
  kellyFraction = 0.10,
  multiplier = DEFAULT_FEE_MULTIPLIER,
  maxRiskPctPerTrade = 0.10,
  minContracts = 1,
  maxStakeDollars = null,
}) {
  if (price <= 0 || price >= 1) return { contracts: 0, dollarsAtRisk: 0, reason: "invalid price" };

  const feeCost = perContractFee(price, multiplier);
  const netEdge = trueProbability - price - feeCost;
  if (netEdge <= 0) return { contracts: 0, dollarsAtRisk: 0, reason: "no positive edge after fees" };

  const b = (1 - price) / price;
  const p = trueProbability;
  const q = 1 - p;
  const rawKelly = (b * p - q) / b;

  const scaledKelly = Math.max(0, rawKelly * kellyFraction);
  const cappedKelly = Math.min(scaledKelly, maxRiskPctPerTrade);
  let dollarsAtRisk = bankroll * cappedKelly;
  if (maxStakeDollars != null) dollarsAtRisk = Math.min(dollarsAtRisk, maxStakeDollars);

  let contracts = Math.floor(dollarsAtRisk / price);

  // The floor: round up to one contract when the edge is real and the balance
  // covers it. Without this the bot never places a trade below ~$50 bankroll.
  if (contracts < minContracts) {
    const affordable = Math.floor(bankroll / price);
    if (affordable >= minContracts) contracts = minContracts;
  }

  if (contracts * price > bankroll) contracts = Math.floor(bankroll / price);

  return {
    contracts,
    dollarsAtRisk: contracts * price,
    rawKelly, scaledKelly, cappedKelly, netEdge,
    reason: contracts > 0 ? "ok" : "bankroll cannot afford a single contract at this price",
  };
}

/**
 * Liquidity is now measured against the order being placed, not an absolute
 * number. Requiring 50 resting contracts to buy 2 rejected most of the book.
 */
export function passesLiquidityFilter({ restingContracts, wantContracts = 1, minContracts = 0, coverageMultiple = 2 }) {
  const needed = Math.max(minContracts, Math.ceil(wantContracts * coverageMultiple));
  return restingContracts >= needed;
}

export function assessOpportunity({
  bankroll,
  trueProbability,
  price,
  restingContracts,
  multiplier = DEFAULT_FEE_MULTIPLIER,
  kellyFraction = 0.10,
  minLiquidity = 0,
  maxRiskPctPerTrade = 0.10,
  maxStakeDollars = null,
  maxPlausibleEdge = 0.25,
  survivalMode = null,
}) {
  const observedEdge = trueProbability - price;

  // A sportsbook line is priced pre-game; Kalshi's price is live. When a game
  // turns, Kalshi moves and the book does not, and the gap reads as an enormous
  // edge on a team that is actually losing. An edge this large is virtually
  // always stale data rather than mispricing, so it is refused rather than
  // traded - this is the check that stops the bot buying blowout losers at 6c.
  if (maxPlausibleEdge && observedEdge > maxPlausibleEdge) {
    return {
      action: "skip",
      reason: `edge ${(observedEdge * 100).toFixed(1)}% exceeds the ${(maxPlausibleEdge * 100).toFixed(0)}% plausibility ceiling - the sharp line is almost certainly stale against a live price`,
    };
  }

  const inSurvivalMode = survivalMode && bankroll < survivalMode.balanceThreshold;
  const edgeMultiplier = inSurvivalMode ? survivalMode.edgeMultiplier || 1 : 1;

  const baseRequiredEdge = requiredEdgeThreshold({ price, multiplier });
  const requiredEdge = baseRequiredEdge * edgeMultiplier;
  const margin = observedEdge - requiredEdge;
  const edgeCheck = { qualifies: margin > 0, requiredEdge, observedEdge, margin };

  if (!edgeCheck.qualifies) {
    return {
      action: "skip",
      reason: `edge ${(observedEdge * 100).toFixed(2)}% below required ${(requiredEdge * 100).toFixed(2)}%` +
        (inSurvivalMode ? " (survival mode - stricter bar)" : ""),
    };
  }

  // Size first, then check liquidity against that size. The old order checked
  // liquidity against a fixed 50 before knowing it only wanted 2.
  let sizing;
  if (inSurvivalMode) {
    const flatDollars = survivalMode.flatBetDollars || 1;
    let contracts = Math.floor(flatDollars / price);
    if (contracts < 1 && bankroll >= price) contracts = 1;
    sizing = {
      contracts, dollarsAtRisk: contracts * price, mode: "survival-flat",
      reason: contracts > 0 ? "ok" : "bankroll cannot afford a single contract at this price",
    };
  } else {
    sizing = fractionalKellySize({
      bankroll, trueProbability, price, kellyFraction, multiplier, maxRiskPctPerTrade, maxStakeDollars,
    });
  }

  if (sizing.contracts <= 0) return { action: "skip", reason: sizing.reason };

  const liquidityOk = passesLiquidityFilter({
    restingContracts, wantContracts: sizing.contracts, minContracts: minLiquidity,
  });
  if (!liquidityOk) {
    return {
      action: "skip",
      reason: `insufficient liquidity (${restingContracts} resting, need ${Math.ceil(sizing.contracts * 2)} for ${sizing.contracts} contracts)`,
    };
  }

  return { action: "candidate", edgeCheck, sizing, survivalMode: inSurvivalMode };
}
