/**
 * makerEngine.js
 *
 * RESTING BIDS - trading the markets that are priced too tightly to take.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (2026-09-22)
 * ---------------------------------------------------------------------------
 * A full MLB slate, 20 tradeable markets, entered 0. Sixteen were refused
 * "edge-too-small": Kalshi's ask sat within ~2.5 points of the sharp line,
 * which is exactly what TAKING costs - the 0.07 taker fee (2c at 50c) plus a
 * half-point buffer, paid on top of the spread.
 *
 * Kalshi charges resting (maker) orders a quarter of that: 0.0175 x P x (1-P),
 * and zero on series without a maker multiplier. A bid that rests on the book
 * and gets hit pays at most 1c at 50c, and it buys at the BID side of the
 * spread instead of the ask. The same market that is worth nothing to a taker
 * is worth +1 to +3c per contract to a maker.
 *
 * ---------------------------------------------------------------------------
 * THE RULES - every one of them is about not being picked off
 * ---------------------------------------------------------------------------
 *  1. The bid is the highest price that still clears the MAKER fee plus the
 *     same half-point buffer the taker path uses. Never higher. A fill anywhere
 *     at or below it is positive expected value by construction. The maker fee
 *     is assumed on every series, so a series that charges none is a bonus.
 *  2. Post-only. The order can never cross and pay the taker fee.
 *  3. Pre-game only by default. A resting bid in a live game is filled
 *     precisely when the game has turned against it, faster than the odds feed
 *     can say so.
 *  4. It expires on its own two minutes before first pitch/kickoff
 *     (expiration_time), and is cancelled if the exchange pauses the market.
 *     A restart, a crash or a dead scan cannot leave it resting into a game.
 *  5. Re-checked every scan. If the sharp line moves, the bid moves with it or
 *     is cancelled. An order not re-confirmed by a scan within three scan
 *     intervals is cancelled - no bid rests on a line nobody is watching.
 *  6. Only priced off a FRESH sharp quote (default 20 min). An unknown quote
 *     age is refused - a resting order must never sit on a line of unknown age.
 *  7. One game, one exposure: no resting bid on a game already held, and never
 *     two bids on the same game.
 *  8. Positions plus resting bids never exceed the position cap. When a taker
 *     entry or a fill takes a slot, the newest resting bids are cancelled to
 *     make room.
 *  9. Never chases itself: our own bid is usually the best bid, so "best bid +
 *     1c" would ratchet the price up every scan. An order that is still the
 *     best bid is left exactly where it is.
 * ---------------------------------------------------------------------------
 */

import { kalshiGet, kalshiPost, kalshiDelete } from "./kalshiClient.js";
import { appendLog, loadState, saveState } from "./stateStore.js";
import { recordTrade, scheduleFeeCents } from "./tradeLedgerStore.js";
import { feeCentsAt, requiredEdgeThreshold, fractionalKellySize } from "./riskManager.js";
import { notifyEntry } from "./notifier.js";
import { getTelegramCredentials } from "./telegramStore.js";
import { currentCadenceSeconds } from "./cadence.js";

export const MAKER_VERSION = "2026-09-22-resting-bids";

const V2 = "/trade-api/v2";
const ORDERS_V2 = `${V2}/portfolio/events/orders`;
const ORDERS_READ = `${V2}/portfolio/orders`;

/** Kalshi's maker multiplier where one applies. Assumed everywhere - conservative. */
export const MAKER_FEE_MULTIPLIER = 0.0175;

/** Every setting, with the default that applies when config.maker omits it. */
export function makerSettings(config = {}) {
  const m = config.maker || {};
  return {
    enabled: m.enabled !== false,
    allowLive: m.allowLive === true,
    minMinutesBeforeStart: m.minMinutesBeforeStart ?? 5,
    expireBeforeStartSeconds: m.expireBeforeStartSeconds ?? 120,
    maxLineAgeSeconds: m.maxLineAgeSeconds ?? 1200,
    minEvCentsPerTrade: m.minEvCentsPerTrade ?? 1,
    staleScans: m.staleScans ?? 3,
  };
}

function eventKeyOf(ticker) {
  const parts = String(ticker).split("-");
  return parts.length > 1 ? `${parts[0]}-${parts[1]}` : String(ticker);
}

function dollarsToCents(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n <= 1 ? n * 100 : n);
}

function countOf(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function readResting(state = loadState()) {
  const r = state.restingOrders;
  return r && typeof r === "object" && !Array.isArray(r) ? r : {};
}

function writeResting(mutator) {
  const state = loadState();
  const resting = readResting(state);
  mutator(resting);
  state.restingOrders = resting;
  saveState(state);
  return resting;
}

/** Tracked resting bids, keyed by ticker. */
export function getRestingOrders() {
  return readResting();
}

export function restingCount() {
  return Object.keys(readResting()).length;
}

export function restingEventKeys() {
  return new Set(Object.values(readResting()).map((o) => eventKeyOf(o.ticker)));
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * The highest bid, in whole cents, whose expected value clears the MAKER fee
 * plus the buffer. Strictly below the ask, so a post-only order is accepted.
 * Returns null when no price in the band qualifies.
 */
export function maxMakerBidCents({ trueProbability, askCents, minEntryPriceCents = 12, maxEntryPriceCents = 95 }) {
  const ceiling = Math.min(maxEntryPriceCents || 99, 99, askCents > 0 ? askCents - 1 : 99);
  const floor = Math.max(1, minEntryPriceCents || 1);
  for (let c = ceiling; c >= floor; c--) {
    const edge = trueProbability - c / 100;
    const required = requiredEdgeThreshold({ price: c / 100, multiplier: MAKER_FEE_MULTIPLIER, expectRoundTrip: false });
    if (edge > required) return c;
  }
  return null;
}

/** Expected value per contract of a maker fill at `priceCents`, held to settlement. */
export function makerEvCents(trueProbability, priceCents) {
  return trueProbability * 100 - priceCents - feeCentsAt(priceCents, MAKER_FEE_MULTIPLIER);
}

/**
 * Where to rest the bid.
 *
 *   - no qualifying price          -> null (cancel anything resting)
 *   - we already rest and are still the best bid at a price that still
 *     qualifies                     -> keep it exactly where it is
 *   - otherwise                     -> one cent above the best bid, capped at
 *                                      the highest qualifying price
 *
 * Pure, so it can be checked against real book numbers.
 */
export function planBid({ trueProbability, bidCents, askCents, existingPriceCents = null, minEntryPriceCents, maxEntryPriceCents }) {
  const maxBid = maxMakerBidCents({ trueProbability, askCents, minEntryPriceCents, maxEntryPriceCents });
  if (maxBid == null) return { priceCents: null, maxBid: null, reason: "no price below the ask clears the maker fee" };

  if (existingPriceCents != null && existingPriceCents <= maxBid && existingPriceCents < askCents
      && (bidCents == null || bidCents <= existingPriceCents)) {
    return { priceCents: existingPriceCents, maxBid, keep: true, reason: "still the best bid" };
  }

  const target = bidCents != null && bidCents > 0 ? Math.min(maxBid, bidCents + 1) : maxBid;
  if (target < (minEntryPriceCents || 1) || (askCents > 0 && target >= askCents)) {
    return { priceCents: null, maxBid, reason: "no room between the bid and the ask" };
  }
  return { priceCents: target, maxBid, keep: false, reason: target === maxBid ? "at the highest qualifying price" : "one cent over the best bid" };
}

function sizeFor({ bankroll, trueProbability, priceCents, config }) {
  const fee = feeCentsAt(priceCents, MAKER_FEE_MULTIPLIER);
  const perContract = (priceCents + fee) / 100;
  const sm = config.survivalMode;
  if (sm && bankroll < sm.balanceThreshold) {
    let n = Math.floor((sm.flatBetDollars || 1) / perContract);
    if (n < 1 && bankroll >= perContract) n = 1;
    return n;
  }
  const s = fractionalKellySize({
    bankroll, trueProbability, price: priceCents / 100,
    kellyFraction: config.kellyFraction ?? 0.25, multiplier: MAKER_FEE_MULTIPLIER,
    maxRiskPctPerTrade: config.maxRiskPctPerTrade ?? 0.2, maxStakeDollars: config.maxStakeDollars ?? null,
  });
  return s.contracts || 0;
}

// ---------------------------------------------------------------------------
// Exchange calls
// ---------------------------------------------------------------------------

async function cancelOnExchange(order) {
  const query = order.exchangeIndex != null
    ? `?exchange_index=${order.exchangeIndex}&market_ticker=${encodeURIComponent(order.ticker)}`
    : `?exchange_index=-1&market_ticker=${encodeURIComponent(order.ticker)}`;
  try {
    await kalshiDelete(`${ORDERS_V2}/${order.orderId}`, query);
    return true;
  } catch (err) {
    // 404: already gone - filled, expired or cancelled. The fill check below
    // decides which; it is not an error.
    if (/\b404\b/.test(String(err.message))) return true;
    appendLog(`Could not cancel resting bid ${order.ticker} (${err.message}) - will retry next cycle.`, "warn");
    return false;
  }
}

/** Books any contracts filled on this order since last seen. Returns the order's live status. */
async function absorbFills(order) {
  let live = null;
  try {
    const res = await kalshiGet(`${ORDERS_READ}/${order.orderId}`);
    live = res.order || res;
  } catch (err) {
    if (!/\b404\b/.test(String(err.message))) throw err;
  }

  let filled;
  let priceCents = order.priceCents;
  let feesToDateCents = null;
  if (live) {
    filled = countOf(live.fill_count_fp ?? live.fill_count);
    priceCents = dollarsToCents(live.yes_price_dollars) ?? order.priceCents;
    const mf = Number(live.maker_fees_dollars);
    if (Number.isFinite(mf)) feesToDateCents = Math.round(mf * 100 * 1e6) / 1e6;
  } else {
    // Order record gone. Count its fills directly rather than assume none.
    const res = await kalshiGet(`${V2}/portfolio/fills`, `?order_id=${encodeURIComponent(order.orderId)}`);
    filled = (res.fills || []).reduce((n, f) => n + countOf(f.count_fp ?? f.count), 0);
  }

  const delta = filled - (order.filledSeen || 0);
  if (delta > 0) {
    const feeCents = feesToDateCents != null ? Math.max(0, feesToDateCents - (order.feesSeenCents || 0)) : null;
    bookFill(order, delta, priceCents, feeCents, feesToDateCents);
  }

  const status = live ? String(live.status || "").toLowerCase() : "gone";
  return { status, filled };
}

function bookFill(order, contracts, priceCents, feeCentsReported = null, feesToDateCents = null) {
  const state = loadState();
  const existing = state.positions.find((p) => p.ticker === order.ticker && p.source === "maker");
  if (existing) {
    const total = existing.contracts + contracts;
    existing.entryPriceCents = Math.round((existing.entryPriceCents * existing.contracts + priceCents * contracts) / total);
    existing.contracts = total;
  } else {
    state.positions.push({
      ticker: order.ticker, side: "yes", entryPriceCents: priceCents, contracts,
      openedAt: new Date().toISOString(), teamName: order.teamName ?? null, sportKey: order.sportKey ?? null,
      commenceTime: order.commenceTime ?? null, exchangeIndex: order.exchangeIndex ?? null, source: "maker",
    });
  }
  const resting = readResting(state);
  if (resting[order.ticker]) {
    resting[order.ticker].filledSeen = (resting[order.ticker].filledSeen || 0) + contracts;
    if (feesToDateCents != null) resting[order.ticker].feesSeenCents = feesToDateCents;
  }
  order.filledSeen = (order.filledSeen || 0) + contracts;
  if (feesToDateCents != null) order.feesSeenCents = feesToDateCents;
  const feeCents = feeCentsReported != null ? feeCentsReported : scheduleFeeCents(priceCents, contracts, true);
  state.restingOrders = resting;
  saveState(state);

  const ev = makerEvCents(order.trueProbability ?? 0, priceCents);
  const reason =
    `Resting bid filled on "${order.teamName}" (sharp ${((order.trueProbability ?? 0) * 100).toFixed(1)}% vs ${priceCents}c bid, ` +
    `maker fee ${feeCents}c for ${contracts}, EV ${ev.toFixed(1)}c/contract, held to settlement)`;
  appendLog(`Filled ${contracts}x ${order.ticker} @ ${priceCents}c as MAKER - ${reason}`);
  recordTrade({
    action: "enter", ticker: order.ticker, side: "yes", contracts, priceCents, filled: contracts,
    reason, edgePct: ((order.trueProbability ?? 0) - priceCents / 100) * 100, environment: order.environment ?? null,
    feeCents, maker: true,
    teamName: order.teamName ?? null, sportKey: order.sportKey ?? null, commenceTime: order.commenceTime ?? null,
  });
  const { botToken, chatId } = getTelegramCredentials();
  notifyEntry({ botToken, chatId, ticker: order.ticker, side: "yes", contracts, priceCents, reason, environment: order.environment })
    .catch(() => {});
}

/** Cancels one tracked order, books any fills it took first, and stops tracking it. */
export async function cancelResting(ticker, why) {
  const order = readResting()[ticker];
  if (!order) return true;
  const ok = await cancelOnExchange(order);
  if (!ok) return false;
  // VERIFY, do not assume. A 404 can mean "already gone" - or a cancel sent to
  // the wrong shard. Only stop tracking once Kalshi itself says the order is no
  // longer resting; otherwise it would sit on the book with nobody watching it.
  try {
    const { status } = await absorbFills(order);
    if (status === "resting") {
      appendLog(`Cancel of resting bid ${ticker} was not confirmed by Kalshi - still resting, retrying next cycle.`, "warn");
      return false;
    }
  } catch { /* unreadable - keep tracking; the next sync re-reads it */ return false; }
  writeResting((r) => { delete r[ticker]; });
  appendLog(`Cancelled resting bid ${ticker} @ ${order.priceCents}c - ${why}.`);
  return true;
}

export async function cancelAllResting(why) {
  const tickers = Object.keys(readResting());
  for (const t of tickers) await cancelResting(t, why);
  return tickers.length;
}

// ---------------------------------------------------------------------------
// Per-cycle sync - called by botController BEFORE the scan
// ---------------------------------------------------------------------------

/**
 * Books fills, drops orders that finished, cancels orders no scan has
 * re-confirmed, and cancels the newest bids when positions + bids exceed the
 * cap. Never throws.
 */
export async function syncResting({ cap = null } = {}) {
  const out = { filled: 0, dropped: 0, stale: 0, trimmed: 0 };
  let resting;
  try { resting = readResting(); } catch { return out; }

  const staleMs = Math.max(180, makerSettings().staleScans * currentCadenceSeconds()) * 1000;
  const now = Date.now();

  for (const order of Object.values(resting)) {
    try {
      const before = order.filledSeen || 0;
      const { status } = await absorbFills(order);
      if ((order.filledSeen || 0) > before) out.filled += order.filledSeen - before;

      if (status !== "resting") {
        writeResting((r) => { delete r[order.ticker]; });
        out.dropped++;
        continue;
      }
      if (now - Date.parse(order.refreshedAt || order.placedAt) > staleMs) {
        if (await cancelResting(order.ticker, "no scan has re-confirmed its price recently")) out.stale++;
      }
    } catch (err) {
      appendLog(`Resting bid check failed for ${order.ticker} (${err.message}) - retrying next cycle.`, "warn");
    }
  }

  if (cap) {
    try {
      const positions = loadState().positions.length;
      const live = Object.values(readResting()).sort((a, b) => Date.parse(b.placedAt) - Date.parse(a.placedAt));
      let excess = positions + live.length - cap;
      for (const o of live) {
        if (excess <= 0) break;
        if (await cancelResting(o.ticker, `making room - ${positions} position(s) plus bids reached the ${cap} cap`)) {
          excess--; out.trimmed++;
        }
      }
    } catch { /* next cycle */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-candidate decision - called by the scanner
// ---------------------------------------------------------------------------

/**
 * Rests, re-prices, keeps or cancels the bid for one candidate the taker path
 * refused as too tight. Returns { action, line } for the scan log. Never throws.
 */
export async function workCandidate({ c, config, bankroll, cap, heldEvents }) {
  const s = makerSettings(config);
  const existing = readResting()[c.ticker] || null;

  const refuse = async (why) => {
    if (existing) await cancelResting(c.ticker, why);
    return { action: existing ? "cancelled" : "none", line: why };
  };

  try {
    if (!s.enabled) return refuse("resting bids switched off");
    if (c.timing.live && !s.allowLive) return refuse("game is live - resting bids are pre-game only");

    const startMs = Date.parse(c.commenceTime);
    const minutesToStart = (startMs - Date.now()) / 60000;
    if (!Number.isFinite(startMs) || minutesToStart < s.minMinutesBeforeStart) {
      return refuse(`starts in ${Number.isFinite(minutesToStart) ? minutesToStart.toFixed(0) : "?"}m - too close to rest a bid`);
    }
    if (c.lineAgeSeconds == null) return refuse("sharp quote has no timestamp - a resting bid needs a known-fresh line");
    if (c.lineAgeSeconds > s.maxLineAgeSeconds) {
      return refuse(`sharp quote is ${Math.round(c.lineAgeSeconds)}s old, past the ${s.maxLineAgeSeconds}s limit for a resting bid`);
    }

    const ev = eventKeyOf(c.ticker);
    if (heldEvents.has(ev)) return refuse("already holding this game");
    const otherSide = Object.values(readResting()).find((o) => o.ticker !== c.ticker && eventKeyOf(o.ticker) === ev);
    if (otherSide) return { action: "none", line: `already bidding the other side (${otherSide.ticker})` };

    const plan = planBid({
      trueProbability: c.trueProbability,
      bidCents: c.pricing.bidCents,
      askCents: c.pricing.askCents,
      existingPriceCents: existing ? existing.priceCents : null,
      minEntryPriceCents: config.minEntryPriceCents ?? 12,
      maxEntryPriceCents: config.maxEntryPriceCents ?? 95,
    });
    if (plan.priceCents == null) return refuse(plan.reason);

    if (existing && plan.keep) {
      writeResting((r) => { if (r[c.ticker]) { r[c.ticker].refreshedAt = new Date().toISOString(); r[c.ticker].trueProbability = c.trueProbability; } });
      return { action: "kept", line: `${c.ticker} bid ${existing.priceCents}c kept (${plan.reason})` };
    }

    if (!existing) {
      const positions = loadState().positions.length;
      if (cap && positions + restingCount() >= cap) return { action: "none", line: `no free slot (${positions} held + ${restingCount()} bids, cap ${cap})` };
    }

    const contracts = sizeFor({ bankroll, trueProbability: c.trueProbability, priceCents: plan.priceCents, config });
    if (contracts < 1) return refuse("bankroll cannot fund one contract");
    const evCents = makerEvCents(c.trueProbability, plan.priceCents);
    if (evCents * contracts < s.minEvCentsPerTrade) {
      return refuse(`expected value ${(evCents * contracts).toFixed(2)}c for the trade is under the ${s.minEvCentsPerTrade}c floor`);
    }

    if (existing) {
      const ok = await cancelResting(c.ticker, `re-pricing ${existing.priceCents}c -> ${plan.priceCents}c`);
      if (!ok) return { action: "none", line: "cancel failed - left as is" };
      if (loadState().positions.some((p) => eventKeyOf(p.ticker) === ev)) {
        return { action: "filled", line: `${c.ticker} filled while re-pricing` };
      }
    }

    const expireSec = Math.floor(startMs / 1000) - s.expireBeforeStartSeconds;
    const body = {
      ticker: c.ticker,
      client_order_id: `mk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      side: "bid",
      count: Number(contracts).toFixed(2),
      price: (plan.priceCents / 100).toFixed(2),
      time_in_force: "good_till_canceled",
      self_trade_prevention_type: "taker_at_cross",
      post_only: true,
      cancel_order_on_pause: true,
      expiration_time: expireSec,
    };
    const idx = c.market?.exchange_index;
    if (idx != null) body.exchange_index = idx;

    let res;
    try {
      res = await kalshiPost(ORDERS_V2, body);
    } catch (err) {
      const msg = String(err.message);
      if (/insufficient_(shard_)?balance/.test(msg)) {
        return { action: "none", line: `shard ${idx} unfunded - fund it at kalshi.com/account/exchange-indexes` };
      }
      if (/post.?only|would.?cross|cross/i.test(msg)) {
        return { action: "none", line: `book moved to ${plan.priceCents}c before the bid landed - retried next scan` };
      }
      appendLog(`Resting bid rejected for ${c.ticker}: ${msg}`, "error");
      return { action: "error", line: msg.slice(0, 160) };
    }

    const nowIso = new Date().toISOString();
    const order = {
      orderId: res.order_id, ticker: c.ticker, priceCents: plan.priceCents, contracts,
      filledSeen: 0, exchangeIndex: idx ?? null, placedAt: nowIso, refreshedAt: nowIso,
      commenceTime: c.commenceTime, teamName: c.teamName, sportKey: c.sportKey ?? null,
      trueProbability: c.trueProbability, environment: config.environment ?? null,
    };
    writeResting((r) => { r[c.ticker] = order; });

    const immediate = countOf(res.fill_count);
    if (immediate > 0) {
      const per = Number(res.average_fee_paid);
      const fee = Number.isFinite(per) ? Math.round(per * 100 * immediate * 1e6) / 1e6 : null;
      bookFill(order, immediate, dollarsToCents(res.average_fill_price) ?? plan.priceCents, fee, fee);
    }

    const line =
      `Resting bid ${c.ticker} (${c.teamName}): ${contracts}x @ ${plan.priceCents}c ` +
      `[book ${c.pricing.bidCents ?? "-"}/${c.pricing.askCents}c, sharp ${(c.trueProbability * 100).toFixed(1)}%, ` +
      `max ${plan.maxBid}c], EV ${evCents.toFixed(1)}c/contract after the <=${feeCentsAt(plan.priceCents, MAKER_FEE_MULTIPLIER)}c maker fee, ` +
      `expires ${Math.round(minutesToStart - s.expireBeforeStartSeconds / 60)}m from now`;
    appendLog(line);
    return { action: existing ? "repriced" : "rested", line };
  } catch (err) {
    return { action: "error", line: `maker path failed: ${err.message}` };
  }
}
