/**
 * fairValue.js
 *
 * FAIR-VALUE EXITS (2026-09-24)
 *
 * The account's own record: positions EXITED EARLY returned +15.9% over 32
 * trades, positions HELD to settlement returned -8.7% over 26. "Always hold"
 * was the fee maths talking, not the data.
 *
 * The rule here is the one that makes both sides of that true at once:
 *
 *     HOLD is worth   fair * 100              (settlement pays free)
 *     SELL is worth   bid - slippage - fee    (one exit fee, crosses 1c)
 *
 *     Sell when SELL > HOLD + margin.
 *
 * When the Kalshi bid rises ABOVE the sharp line's probability, the edge has
 * flipped to the other side of the trade: someone is paying more for the
 * contract than it is worth. Holding at that point is buying it again at the
 * bid. This takes that money instead.
 *
 * Every number feeding the rule is real:
 *   - `fair` is the latest devigged sharp probability for that team, recorded
 *     by the scanner on every scan (and refreshed for held sports when the bot
 *     is at its position cap and not scanning).
 *   - the bid is read from Kalshi's live order book at decision time.
 *
 * Guards, each of which refuses rather than guesses:
 *   - STALE FAIR: no sharp reading in the last fairValueMaxAgeSeconds, or the
 *     sharp quote itself older than the live/pre-game line-age limit.
 *   - SUSPECT MAPPING: sharp and Kalshi disagree by more than the plausibility
 *     ceiling. That is the MMA side-inversion signature (sharp 27.8% vs 68c) -
 *     the position is on a different contract from the team the line prices,
 *     and acting on it would be acting on a bug.
 *
 * MODE: config.fairValueExit = "shadow" | "live" | "off". Ships as "shadow":
 * every decision is logged as WOULD SELL with the real bid and the real fair
 * value, and kept in a list the dashboard can read (/api/fair-value). Flip to
 * "live" once those decisions have been checked against the Kalshi app.
 */

import { orderFeeCents } from "./riskManager.js";

export const FAIR_VALUE_VERSION = "2026-09-24-fair-value-exit";

/** sportKey|team -> { prob, lineAgeSeconds, isLive, recordedAt } */
const fairCache = new Map();

/** Recent shadow/live decisions, newest first, for the dashboard. */
const decisions = [];
const MAX_DECISIONS = 100;

/** Last logged bid per position, so shadow mode does not repeat itself every cycle. */
const lastLogged = new Map();

function keyOf(sportKey, teamName) {
  return `${String(sportKey || "").toLowerCase()}|${String(teamName || "").toLowerCase().trim()}`;
}

/** Called by the scanner for every line it reads, held or not. */
export function recordFair(sportKey, teamName, prob, { lineAgeSeconds = null, isLive = null } = {}) {
  const p = Number(prob);
  if (!sportKey || !teamName || !(p > 0 && p < 1)) return;
  fairCache.set(keyOf(sportKey, teamName), {
    prob: p,
    lineAgeSeconds: Number.isFinite(Number(lineAgeSeconds)) ? Number(lineAgeSeconds) : null,
    isLive: isLive === true,
    recordedAt: Date.now(),
  });
  if (fairCache.size > 5000) {
    // Oldest first - Map preserves insertion order.
    const drop = fairCache.size - 4000;
    let i = 0;
    for (const k of fairCache.keys()) { if (i++ >= drop) break; fairCache.delete(k); }
  }
}

/** Records every team in a getSharpProbabilities() result. */
export function recordFairFromProbabilities(sportKey, probabilities) {
  for (const [teamName, info] of Object.entries(probabilities || {})) {
    recordFair(sportKey, teamName, info?.trueProbability, {
      lineAgeSeconds: info?.lineAgeSeconds ?? null,
      isLive: info?.isLive ?? null,
    });
  }
}

export function getFair(sportKey, teamName) {
  const row = fairCache.get(keyOf(sportKey, teamName));
  if (!row) return null;
  return { ...row, ageSeconds: (Date.now() - row.recordedAt) / 1000 };
}

export function fairValueMode(config) {
  const m = String(config?.fairValueExit ?? "shadow").toLowerCase();
  return m === "live" || m === "off" ? m : "shadow";
}

/**
 * The decision. Pure apart from reading the cache - returns
 *   { action: "sell", line, fairCents, sellNetCents } |
 *   { action: "hold", why } | { action: "refuse", code, why }
 */
export function fairValueExitDecision(position, quote, config) {
  if (fairValueMode(config) === "off") return { action: "hold", why: "fair-value exit off" };

  const bid = quote?.bid;
  if (bid == null || !(bid > 0)) return { action: "hold", why: "no bid to sell into" };

  const fair = getFair(position.sportKey, position.teamName);
  if (!fair) return { action: "refuse", code: "no-fair", why: "no sharp reading for this team yet" };

  const maxAge = config.fairValueMaxAgeSeconds ?? 420;
  if (fair.ageSeconds > maxAge) {
    return { action: "refuse", code: "stale-fair", why: `sharp reading is ${Math.round(fair.ageSeconds)}s old (limit ${maxAge}s)` };
  }

  const started = position.commenceTime ? Date.parse(position.commenceTime) <= Date.now() : fair.isLive;
  const lineLimit = started ? (config.maxLineAgeSecondsLive ?? 900) : (config.maxLineAgeSecondsPregame ?? 7200);
  if (fair.lineAgeSeconds == null && started) {
    return { action: "refuse", code: "no-line-age", why: "in play and the sharp quote has no timestamp" };
  }
  if (fair.lineAgeSeconds != null && fair.lineAgeSeconds > lineLimit) {
    return { action: "refuse", code: "stale-line", why: `sharp quote is ${Math.round(fair.lineAgeSeconds)}s old (limit ${lineLimit}s)` };
  }

  const fairCents = fair.prob * 100;
  const ref = quote.ask != null ? (bid + quote.ask) / 2 : bid;
  const plausible = (config.maxPlausibleEdge ?? 0.18) * 100 + 5;
  if (Math.abs(ref - fairCents) > plausible) {
    return {
      action: "refuse", code: "suspect-mapping",
      why: `sharp ${fairCents.toFixed(1)}% vs Kalshi ${ref.toFixed(1)}c is a ${Math.abs(ref - fairCents).toFixed(0)}pt gap - ` +
        `the position may be on a different contract from the team the line prices; not acting on it`,
    };
  }

  const slip = config.exitSlippageCents ?? 1;
  const sellPrice = Math.max(1, bid - slip);
  const contracts = Math.max(1, position.contracts || 1);
  const feePer = orderFeeCents(sellPrice, contracts, config.feeMultiplier ?? 0.07) / contracts;
  const sellNetCents = sellPrice - feePer;
  const margin = config.fairValueExitMarginCents ?? 2;

  if (sellNetCents >= fairCents + margin) {
    const entry = position.entryPriceCents || 0;
    const line =
      `fair-value: bid ${bid}c nets ${sellNetCents.toFixed(1)}c after the ${feePer.toFixed(2)}c fee and ${slip}c cross, ` +
      `vs ${fairCents.toFixed(1)}c held (sharp ${fair.prob * 100 >= 10 ? (fair.prob * 100).toFixed(1) : (fair.prob * 100).toFixed(2)}%, ` +
      `line ${fair.lineAgeSeconds == null ? "age n/a" : `${Math.round(fair.lineAgeSeconds)}s old`}) - ` +
      `the market is paying ${(sellNetCents - fairCents).toFixed(1)}c more than the contract is worth. ` +
      `Entry ${entry}c, ${sellNetCents - entry >= 0 ? "+" : ""}${(sellNetCents - entry).toFixed(1)}c/contract realised.`;
    return { action: "sell", line, fairCents, sellNetCents, bid };
  }
  return {
    action: "hold",
    why: `bid nets ${sellNetCents.toFixed(1)}c vs ${fairCents.toFixed(1)}c fair (+${margin}c margin needed)`,
  };
}

/**
 * Shadow-mode logging gate: true the first time a position shows a sell, and
 * again only if the bid has moved 3c+ since. Keeps the log readable.
 */
export function shouldLogShadow(position, bid) {
  const k = `${position.ticker}|${position.openedAt}`;
  const prev = lastLogged.get(k);
  if (prev != null && Math.abs(prev - bid) < 3) return false;
  lastLogged.set(k, bid);
  if (lastLogged.size > 500) lastLogged.delete(lastLogged.keys().next().value);
  return true;
}

export function recordDecision(row) {
  decisions.unshift({ at: new Date().toISOString(), ...row });
  if (decisions.length > MAX_DECISIONS) decisions.length = MAX_DECISIONS;
}

export function fairValueReport(config) {
  return {
    version: FAIR_VALUE_VERSION,
    mode: fairValueMode(config),
    marginCents: config.fairValueExitMarginCents ?? 2,
    maxAgeSeconds: config.fairValueMaxAgeSeconds ?? 420,
    cachedLines: fairCache.size,
    decisions,
  };
}
