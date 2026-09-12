const DEFAULT_FEE_MULTIPLIER = 0.07;

export function perContractFee(price, multiplier = DEFAULT_FEE_MULTIPLIER) {
  const raw = multiplier * price * (1 - price);
  return Math.ceil(raw * 100) / 100;
}

export function roundTripFeeCost(entryPrice, exitPrice, multiplier = DEFAULT_FEE_MULTIPLIER) {
  return perContractFee(entryPrice, multiplier) + perContractFee(exitPrice, multiplier);
}

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

export function fractionalKellySize({
  bankroll,
  trueProbability,
  price,
  kellyFraction = 0.10,
  multiplier = DEFAULT_FEE_MULTIPLIER,
  maxRiskPctPerTrade = 0.01,
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
  const dollarsAtRisk = bankroll * cappedKelly;
  const contracts = Math.floor(dollarsAtRisk / price);

  return {
    contracts,
    dollarsAtRisk: contracts * price,
    rawKelly, scaledKelly, cappedKelly, netEdge,
    reason: contracts > 0 ? "ok" : "position size rounds to zero contracts",
  };
}

export function passesLiquidityFilter({ restingContracts, minContracts = 50 }) {
  return restingContracts >= minContracts;
}

export function assessOpportunity({
  bankroll,
  trueProbability,
  price,
  restingContracts,
  multiplier = DEFAULT_FEE_MULTIPLIER,
  kellyFraction = 0.10,
  minLiquidity = 50,
  survivalMode = null,
}) {
  const liquidityOk = passesLiquidityFilter({ restingContracts, minContracts: minLiquidity });
  const observedEdge = trueProbability - price;

  const inSurvivalMode = survivalMode && bankroll < survivalMode.balanceThreshold;
  const edgeMultiplier = inSurvivalMode ? survivalMode.edgeMultiplier || 1 : 1;

  const baseRequiredEdge = requiredEdgeThreshold({ price, multiplier });
  const requiredEdge = baseRequiredEdge * edgeMultiplier;
  const margin = observedEdge - requiredEdge;
  const edgeCheck = { qualifies: margin > 0, requiredEdge, observedEdge, margin };

  if (!liquidityOk) {
    return { action: "skip", reason: `insufficient liquidity (${restingContracts} < ${minLiquidity})` };
  }
  if (!edgeCheck.qualifies) {
    return {
      action: "skip",
      reason: `edge ${(observedEdge * 100).toFixed(2)}% below required ${(requiredEdge * 100).toFixed(2)}%` +
        (inSurvivalMode ? " (survival mode - stricter bar)" : ""),
    };
  }

  let sizing;
  if (inSurvivalMode) {
    const flatDollars = survivalMode.flatBetDollars || 1;
    const contracts = Math.floor(flatDollars / price);
    sizing = {
      contracts, dollarsAtRisk: contracts * price, mode: "survival-flat",
      reason: contracts > 0 ? "ok" : "flat bet size rounds to zero contracts at this price",
    };
  } else {
    sizing = fractionalKellySize({ bankroll, trueProbability, price, kellyFraction, multiplier });
  }

  if (sizing.contracts <= 0) return { action: "skip", reason: sizing.reason };

  return { action: "candidate", edgeCheck, sizing, survivalMode: inSurvivalMode };
}
