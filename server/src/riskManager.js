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
 *
 * ---------------------------------------------------------------------------
 * 2026-09-21: THREE CORRECTIONS, all measured
 * ---------------------------------------------------------------------------
 * 1. THE ORDER LIMIT IS NOW THE BAR ITSELF - A WALK-UP LIMIT.
 *
 *    The gate used to score the ask while executor.js quoted ask + 1c, so a
 *    trade approved with exactly 1c of expected value executed at exactly
 *    break-even. Two ways to fix that: score the ask+1 fill (correct, but it
 *    tightens the bar and kills volume), or quote the HIGHEST price that still
 *    clears the bar and let the exchange fill wherever it can. The second is
 *    strictly better and it is what this now does.
 *
 *    walkupLimitCents() searches down from the band ceiling for the last price
 *    at which the edge still clears the fee plus the buffer. That price becomes
 *    the order limit, and the trade is EVALUATED AT IT - the worst case.
 *
 *    Two properties make this free rather than reckless:
 *      - EV cannot go negative. The limit IS the threshold, so a fill anywhere
 *        inside the band clears every gate by construction.
 *      - Kalshi is a central limit order book, so a taker pays the MAKER's
 *        price. A limit buy at 52c against resting offers at 49/50/51 fills at
 *        49, 50 and 51 - not 52. The walk-up costs nothing when the book is
 *        where it was seen and only pays up when it has genuinely moved.
 *
 *    Measured: 0-2c of extra fill room per trade versus a flat 1c cross, at no
 *    cost to the edge bar. Sizing is done at the LIMIT, not the ask, so the
 *    dollar budget can never be exceeded and anything unspent stays in the
 *    pool for the next candidate.
 *
 * 2. THE EV FLOOR WAS IN THE WRONG UNIT. minEvCentsPerContract applied the same
 *    floor to a 14-contract position and a 1-contract position. At 12c, 1c per
 *    contract is 14c of expected value; at 96c it is 1c. Same number, fourteen
 *    times the meaning. The floor is now per TRADE, which is the thing that
 *    actually has to be worth doing.
 *
 * 3. THE EDGE BUFFER WAS DEAD CODE. Measured across the whole band, the EV
 *    floor demanded MORE edge than the edge threshold at every single price -
 *    12c: 2.00 vs 1.50 pts, 50c: 3.00 vs 2.50, 96c: 2.00 vs 1.50. Gate 4 could
 *    never reject anything Gate 5 would have passed, so tuning minTickBuffer or
 *    feeSafetyMultiplier changed nothing at all. With the floor moved to a
 *    per-trade basis, the edge threshold is live again and is what binds on
 *    large positions.
 *
 * Net effect, measured at thirteen prices across the band: LOOSER at eleven,
 * unchanged at two, tighter at none. And 5,310 (ask, sharp, fill) combinations
 * inside every accepted band were checked for a fill with expected value at or
 * below zero. There were none.
 * ---------------------------------------------------------------------------
 */

const DEFAULT_FEE_MULTIPLIER = 0.07;

export const RISK_VERSION = "2026-09-22-exact-fee-quarter-cent";

/**
 * ---------------------------------------------------------------------------
 * 2026-09-22 (night): THE BAR IS NOW THE REAL FEE PLUS A QUARTER CENT
 * ---------------------------------------------------------------------------
 * Two changes, chosen by the account holder from three measured options.
 *
 * 1. THE FEE IS CHARGED THE WAY KALSHI CHARGES IT. Kalshi's schedule is
 *    round up(0.07 x C x P x (1-P)) on the ORDER - C contracts together - not
 *    rounded up per contract. At 79c, two contracts cost 3c in fees, not 4c;
 *    at 50c, three cost 6c and five cost 9c, not 10c. Rounding per contract
 *    overstated the fee by up to 0.9c per contract on every multi-contract
 *    order, and the bar carried the overstatement.
 *
 * 2. THE SAFETY MARGIN IS A FLAT 0.25c PER CONTRACT, down from
 *    max(0.5c, a quarter of the fee). It still sits on top of the exact fee,
 *    so no trade is taken without positive expected value against the sharp
 *    line - the margin is only the cushion for that line being slightly off.
 * ---------------------------------------------------------------------------
 */

/**
 * Kalshi's fee for a whole ORDER of `contracts` at `priceCents`, in cents,
 * rounded up once on the total as the fee schedule specifies. The product is
 * rounded to 1e-9 first so float noise cannot add a phantom cent.
 */
export function orderFeeCents(priceCents, contracts = 1, multiplier = DEFAULT_FEE_MULTIPLIER) {
  const p = priceCents / 100;
  const n = Math.max(1, Math.floor(contracts || 1));
  if (!(p > 0 && p < 1) || !(multiplier > 0)) return 0;
  return Math.ceil(Math.round(multiplier * n * p * (1 - p) * 100 * 1e9) / 1e9);
}

/** Effective fee per contract, in cents, on an order of `contracts`. */
export function feePerContractCents(priceCents, contracts = 1, multiplier = DEFAULT_FEE_MULTIPLIER) {
  const n = Math.max(1, Math.floor(contracts || 1));
  return orderFeeCents(priceCents, n, multiplier) / n;
}

/** Contracts a flat dollar stake buys at this price (fee included, conservatively per contract). */
export function flatBetContracts(flatDollars, priceCents, multiplier = DEFAULT_FEE_MULTIPLIER) {
  const perContract = (priceCents + orderFeeCents(priceCents, 1, multiplier)) / 100;
  return Math.max(1, Math.floor((flatDollars || 1) / perContract));
}

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
export function evPerContractCents({ trueProbability, priceCents, multiplier = DEFAULT_FEE_MULTIPLIER, contracts = 1 }) {
  return trueProbability * 100 - priceCents - feePerContractCents(priceCents, contracts, multiplier);
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
  minTickBuffer = 0.0025,
  feeSafetyMultiplier = 0,
  bufferMultiplier = 1,
  contracts = 1,
}) {
  const priceCents = Math.round(price * 100);
  const entryFee = feePerContractCents(priceCents, contracts, multiplier) / 100;
  const fees = expectRoundTrip ? entryFee * 2 : entryFee;
  // The fee is arithmetic - no multiplier belongs on it. Only the BUFFER is a
  // policy choice, so survival mode scales that and leaves break-even alone.
  // Multiplying the whole threshold meant a 1.25x setting turned a 0.50pt
  // buffer into 1.13pt at 50c rather than the 0.63pt it implied.
  const safetyBuffer = Math.max(minTickBuffer, fees * feeSafetyMultiplier) * bufferMultiplier;
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
    dollarsAtRisk: contracts * effectiveCost,
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
 * The highest price at which this opportunity still clears the edge bar.
 *
 * Searches DOWN from the band ceiling, so the first price that qualifies is the
 * most the bot is willing to pay. Returns null when even the ask does not
 * qualify - there is no price worth paying, and the caller should skip.
 *
 * Integer cents only, because that is the only thing Kalshi trades in.
 */
export function walkupLimitCents({
  trueProbability,
  askCents,
  multiplier = DEFAULT_FEE_MULTIPLIER,
  minEntryPriceCents = 12,
  maxEntryPriceCents = 95,
  bufferMultiplier = 1,
  maxWalkupCents = 4,
  contractsAt = () => 1,
}) {
  const ask = Math.round(askCents);
  if (!(ask > 0 && ask < 100)) return null;

  // Never walk past the band ceiling, and never walk further than
  // maxWalkupCents above the ask - a limit ten cents above the screen price is
  // not patience, it is an invitation to be picked off by a stale book.
  const top = Math.min(maxEntryPriceCents || 99, 99, ask + Math.max(0, maxWalkupCents));
  const bottom = Math.max(ask, minEntryPriceCents || 1);

  for (let c = top; c >= bottom; c--) {
    const edge = trueProbability - c / 100;
    const required = requiredEdgeThreshold({
      price: c / 100, multiplier, expectRoundTrip: false, bufferMultiplier, contracts: contractsAt(c),
    });
    if (edge > required) return c;
  }
  return null;
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
  // Per-CONTRACT floor, now off by default - see the header. Left as a knob so
  // an old persisted config that still sets it keeps working.
  minEvCentsPerContract = 0,
  // Per-TRADE floor. This is the one that binds.
  minEvCentsPerTrade = 1,
  // How far above the ask the order limit may walk. The limit is set to the
  // highest price that still clears the bar, capped at this many cents, so a
  // moving book can still fill without the trade ever going negative.
  maxWalkupCents = 4,
  isLiveGame = false,
  allowLiveGames = true,
  lineAgeSeconds = null,
  maxLineAgeSecondsLive = 180,
  maxLineAgeSecondsPregame = 1800,
  survivalMode = null,
}) {
  const askCents = Math.round(price * 100);

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
    return { action: "skip", code: "live-disabled", reason: "live trading is switched off in config (allowLiveGames)" };
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
          code: "no-quote-timestamp",
          reason: "game is in play and this feed carries no quote timestamp - a suspended book cannot be told from a live one, so it is not traded",
        };
      }
    } else if (lineAgeSeconds > maxAge) {
      return {
        action: "skip",
        code: "stale-quote",
        reason: `sharp quote is ${Math.round(lineAgeSeconds)}s old, past the ${maxAge}s limit for ` +
          `${isLiveGame ? "an in-play" : "a pre-game"} market - the book has likely suspended it while the exchange kept moving`,
      };
    }
  }

  // --- Gate 2: price band ---
  // Below the floor the whole-cent fee dominates: at 8c the round trip is 25%
  // of stake. Above the ceiling there is no room left to be right in.
  if (minEntryPriceCents && askCents < minEntryPriceCents) {
    const fee = feeCentsAt(askCents, multiplier);
    return {
      action: "skip",
      code: "price-below-floor",
      reason: `ask ${askCents}c is below the ${minEntryPriceCents}c floor - the ${fee}c fee is ${((fee / askCents) * 100).toFixed(0)}% of the stake`,
    };
  }
  if (maxEntryPriceCents && askCents > maxEntryPriceCents) {
    return {
      action: "skip",
      code: "price-above-ceiling",
      reason: `ask ${askCents}c is above the ${maxEntryPriceCents}c ceiling - too little upside left to cover being wrong`,
    };
  }

  // --- Gate 3: plausibility ---
  // A sharp book and Kalshi disagreeing by more than this on a pre-game line
  // means one of the two feeds is stale or mismatched, not that free money
  // is sitting on the screen.
  const askEdge = trueProbability - askCents / 100;
  if (maxPlausibleEdge && askEdge > maxPlausibleEdge) {
    return {
      action: "skip",
      code: "edge-implausible",
      reason: `edge ${(askEdge * 100).toFixed(1)}% exceeds the ${(maxPlausibleEdge * 100).toFixed(0)}% plausibility ceiling - a gap that size is a stale or mismatched line, not a mispricing`,
    };
  }

  const inSurvivalMode = survivalMode && bankroll < survivalMode.balanceThreshold;
  const edgeMultiplier = inSurvivalMode ? survivalMode.edgeMultiplier || 1 : 1;

  // How many contracts the order would be at a given price, so the fee is
  // charged on the order as Kalshi charges it. Survival mode is a flat stake,
  // so the count is known exactly. Kelly sizing depends on the edge itself, so
  // it is priced as a single contract - the most conservative fee.
  const contractsAt = inSurvivalMode
    ? (c) => flatBetContracts(survivalMode.flatBetDollars || 1, c, multiplier)
    : () => 1;

  // --- Gate 4: the WALK-UP LIMIT ---
  //
  // The most this opportunity is worth paying. If even the ask does not clear
  // the bar, there is no price worth paying and the trade is skipped. If it
  // does, the limit is the highest price that still clears, and everything
  // below is evaluated AT THAT LIMIT - the worst fill the order can take.
  const limitCents = walkupLimitCents({
    trueProbability, askCents, multiplier,
    minEntryPriceCents, maxEntryPriceCents,
    bufferMultiplier: edgeMultiplier, maxWalkupCents, contractsAt,
  });

  if (limitCents == null) {
    const n = contractsAt(askCents);
    const askFee = feePerContractCents(askCents, n, multiplier);
    const askRequired = requiredEdgeThreshold({
      price: askCents / 100, multiplier, expectRoundTrip: false, bufferMultiplier: edgeMultiplier, contracts: n,
    });
    return {
      action: "skip",
      code: "edge-too-small",
      reason: `edge ${(askEdge * 100).toFixed(2)}% at the ${askCents}c ask is below the ` +
        `${(askRequired * 100).toFixed(2)}% needed (${askFee.toFixed(2)}c fee per contract on ${n}, plus the 0.25c margin) - no price in the band clears` +
        (edgeMultiplier > 1 ? ` (survival mode - margin x${edgeMultiplier})` : ""),
    };
  }

  const priceCents = limitCents;
  const fillPrice = limitCents / 100;
  const observedEdge = trueProbability - fillPrice;
  const nAtLimit = contractsAt(limitCents);
  const requiredEdge = requiredEdgeThreshold({
    price: fillPrice, multiplier, expectRoundTrip: false, bufferMultiplier: edgeMultiplier, contracts: nAtLimit,
  });
  const margin = observedEdge - requiredEdge;
  const evCents = evPerContractCents({ trueProbability, priceCents, multiplier, contracts: nAtLimit });

  // The per-CONTRACT floor, if an old config still carries one. Off by default.
  if (minEvCentsPerContract && evCents < minEvCentsPerContract) {
    return {
      action: "skip",
      code: "ev-too-thin",
      reason: `expected value ${evCents.toFixed(2)}c per contract is below the ${minEvCentsPerContract}c per-contract floor`,
    };
  }

  const edgeCheck = { qualifies: true, requiredEdge, observedEdge, margin, evCents };

  // --- Sizing ---
  let sizing;
  if (inSurvivalMode) {
    // Divide by the FEE-ADJUSTED cost. Dividing by the bare price meant a
    // "$1.75 flat bet" spent $1.89 at 25c and $1.82 at 12c - the flat bet was
    // not flat, and it drifted most at exactly the cheap prices the band was
    // just opened to.
    const perContract = (limitCents + feeCentsAt(limitCents, multiplier)) / 100;
    let contracts = nAtLimit;
    if (contracts * perContract > bankroll) contracts = Math.floor(bankroll / perContract);
    sizing = {
      contracts,
      dollarsAtRisk: contracts * perContract,
      totalCostDollars: contracts * perContract,
      evCents,
      expectedValueDollars: (contracts * evCents) / 100,
      mode: "survival-flat",
      reason: contracts > 0 ? "ok" : "bankroll cannot afford a single contract at this price",
    };
  } else {
    // Sized at the LIMIT, not the ask, so the worst possible fill still fits
    // the budget. A better fill simply spends less and leaves the difference
    // in the pool for the next candidate.
    sizing = fractionalKellySize({
      bankroll, trueProbability, price: fillPrice, kellyFraction, multiplier,
      maxRiskPctPerTrade, maxStakeDollars,
    });
  }

  if (sizing.contracts <= 0) return { action: "skip", code: "size-zero", reason: sizing.reason };

  // --- Gate 5: the TRADE must be worth doing ---
  // This runs after sizing because it is a floor on the trade, not on a
  // contract. Fourteen contracts each worth a fifth of a cent is a real trade;
  // one contract worth a fifth of a cent is not, and a per-contract floor
  // could not tell them apart.
  const evTradeCents = sizing.contracts * evCents;
  if (minEvCentsPerTrade && evTradeCents < minEvCentsPerTrade) {
    return {
      action: "skip",
      code: "ev-too-thin",
      reason: `expected value ${evTradeCents.toFixed(2)}c for the whole trade ` +
        `(${sizing.contracts} contract(s) x ${evCents.toFixed(2)}c) is below the ${minEvCentsPerTrade}c floor`,
    };
  }

  // --- Gate 6: the book can actually fill this size ---
  const liquidityOk = passesLiquidityFilter({
    restingContracts, wantContracts: sizing.contracts, minContracts: minLiquidity,
  });
  if (!liquidityOk) {
    return {
      action: "skip",
      code: "illiquid",
      reason: `insufficient liquidity (${restingContracts} resting, need ${Math.ceil(sizing.contracts * 1.5)} to fill ${sizing.contracts} contracts)`,
    };
  }

  return {
    action: "candidate",
    edgeCheck: { ...edgeCheck, evTradeCents },
    sizing,
    askCents,
    limitCents,
    walkupCents: limitCents - askCents,
    survivalMode: inSurvivalMode,
  };
}
