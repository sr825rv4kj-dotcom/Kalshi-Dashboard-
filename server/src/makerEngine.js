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
import { feeCentsAt, requiredEdgeThreshold, fractionalKellySize, feePerContractCents, flatBetContracts } from "./riskManager.js";
import { notifyEntry } from "./notifier.js";
import { getTelegramCredentials } from "./telegramStore.js";
import { currentCadenceSeconds } from "./cadence.js";

export const MAKER_VERSION = "2026-09-22-fill-or-toss";

const V2 = "/trade-api/v2";
const ORDERS_V2 = `${V2}/portfolio/events/orders`;
const ORDERS_READ = `${V2}/portfolio/orders`;

/** Kalshi's maker multiplier on the series that carry one. */
export const MAKER_FEE_MULTIPLIER = 0.0175;

/**
 * THE SERIES THAT CHARGE MAKER FEES - verbatim from Kalshi's published fee
 * schedule (kalshi.com/docs/kalshi-fee-schedule.pdf, July 2026 update). Every
 * other series has a maker multiplier of zero.
 *
 * The first version assumed 0.0175 on EVERY series. On MLB that is wrong -
 * KXMLBGAME is not on this list - and it cost a full cent on every bid: on
 * tonight's board it held all seven bids one cent further from the best bid
 * than the arithmetic required, which is a cent further from being filled.
 */
const MAKER_FEE_SERIES = new Set([
  "KXAAAGASM", "KXGDP", "KXPAYROLLS", "KXU3", "KXEGGS", "KXCPI", "KXCPIYOY", "KXFEDDECISION", "KXFED",
  "KXNBA", "KXNBAEAST", "KXNBAWEST", "KXNBASERIES", "KXNBAGAME", "KXNHL", "KXNHLEAST", "KXNHLWEST",
  "KXNHLSERIES", "KXNHLGAME", "KXINDY500", "KXPGA", "KXUSOPEN", "KXPGARYDER", "KXTHEOPEN", "KXPGASOLHEIM",
  "KXFOMENSINGLES", "KXFOWOMENSINGLES", "KXWMENSINGLES", "KXWWOMENSINGLES", "KXUSOMENSINGLES",
  "KXUSOWOMENSINGLES", "KXAOMENSINGLES", "KXAOWOMENSINGLES", "KXNFLGAME", "KXUEFACL", "KXNBAFINALSMVP",
  "KXCONNSMYTHE", "KXFOMEN", "KXFOWOMEN", "KXNATHANSHD", "KXNATHANDOGS", "KXCLUBWC", "KXTOURDEFRANCE",
  "KXNASCARRACE",
]);

/** The maker multiplier for this market: 0.0175 on a listed series, 0 otherwise. */
export function makerMultiplierFor(ticker) {
  const series = String(ticker || "").split("-")[0].toUpperCase();
  return MAKER_FEE_SERIES.has(series) ? MAKER_FEE_MULTIPLIER : 0;
}

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
    // FILL OR TOSS. A bid gets this long to be filled. Unfilled, it is
    // cancelled, and that market is not bid again at the same price or lower
    // for the cooldown - only if the sharp line moves enough to justify a
    // HIGHER bid. No bid sits on the book for hours waiting on a dip.
    maxRestMinutes: m.maxRestMinutes ?? 10,
    tossCooldownMinutes: m.tossCooldownMinutes ?? 30,
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

/** Pure: has this bid used up its time on the book? */
export function bidExpired(order, now = Date.now(), s = makerSettings()) {
  const placed = Date.parse(order && order.placedAt);
  return Number.isFinite(placed) && now - placed > s.maxRestMinutes * 60_000;
}

/**
 * Pure: does a recent toss on this market block a new bid at `priceCents`?
 * Blocked unless the new bid is HIGHER than the tossed one - a higher bid
 * means the sharp line moved in its favour, which is new information; the
 * same bid again is just the same unfilled order back on the book.
 */
export function tossBlocks(tossed, priceCents, now = Date.now(), s = makerSettings()) {
  if (!tossed) return false;
  const at = Date.parse(tossed.at);
  if (!Number.isFinite(at) || now - at > s.tossCooldownMinutes * 60_000) return false;
  return priceCents <= tossed.priceCents;
}

function readTossed(state = loadState()) {
  const t = state.makerTossed;
  return t && typeof t === "object" && !Array.isArray(t) ? t : {};
}

function recordToss(order) {
  const state = loadState();
  const tossed = readTossed(state);
  tossed[order.ticker] = { at: new Date().toISOString(), priceCents: order.priceCents };
  const cutoff = Date.now() - 24 * 3600_000;
  for (const [k, v] of Object.entries(tossed)) if (Date.parse(v.at) < cutoff) delete tossed[k];
  state.makerTossed = tossed;
  saveState(state);
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
export function maxMakerBidCents({ trueProbability, askCents, minEntryPriceCents = 12, maxEntryPriceCents = 95, multiplier = MAKER_FEE_MULTIPLIER, contractsAt = () => 1 }) {
  const ceiling = Math.min(maxEntryPriceCents || 99, 99, askCents > 0 ? askCents - 1 : 99);
  const floor = Math.max(1, minEntryPriceCents || 1);
  for (let c = ceiling; c >= floor; c--) {
    const edge = trueProbability - c / 100;
    const required = requiredEdgeThreshold({ price: c / 100, multiplier, expectRoundTrip: false, contracts: contractsAt(c) });
    if (edge > required) return c;
  }
  return null;
}

/** Expected value per contract of a maker fill at `priceCents`, held to settlement. */
export function makerEvCents(trueProbability, priceCents, multiplier = MAKER_FEE_MULTIPLIER, contracts = 1) {
  return trueProbability * 100 - priceCents - feePerContractCents(priceCents, contracts, multiplier);
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
export function planBid({ trueProbability, bidCents, askCents, existingPriceCents = null, minEntryPriceCents, maxEntryPriceCents, multiplier = MAKER_FEE_MULTIPLIER, contractsAt = () => 1 }) {
  const maxBid = maxMakerBidCents({ trueProbability, askCents, minEntryPriceCents, maxEntryPriceCents, multiplier, contractsAt });
  if (maxBid == null) return { priceCents: null, maxBid: null, reason: "no price below the ask clears the maker fee" };

  if (existingPriceCents != null && existingPriceCents <= maxBid && existingPriceCents < askCents
      && (bidCents == null || bidCents <= existingPriceCents)) {
    return { priceCents: existingPriceCents, maxBid, keep: true, reason: "still the best bid" };
  }

  const target = bidCents != null && bidCents > 0 ? Math.min(maxBid, bidCents + 1) : maxBid;
  if (target < (minEntryPriceCents || 1) || (askCents > 0 && target >= askCents)) {
    return { priceCents: null, maxBid, reason: "no room between the bid and the ask" };
  }
  // Already resting at exactly the price it would be re-placed at. Leave it:
  // cancelling and re-placing at the same price only gives up queue position.
  // (Production 21:23-21:25: every bid sat below a better outside bid at its
  // own ceiling, so each scan "re-priced" it to the price it already had.)
  if (existingPriceCents != null && existingPriceCents === target) {
    return { priceCents: existingPriceCents, maxBid, keep: true, reason: "already at the best qualifying price" };
  }
  return { priceCents: target, maxBid, keep: false, reason: target === maxBid ? "at the highest qualifying price" : "one cent over the best bid" };
}

function sizeFor({ bankroll, trueProbability, priceCents, config, multiplier = MAKER_FEE_MULTIPLIER }) {
  const fee = feeCentsAt(priceCents, multiplier);
  const perContract = (priceCents + fee) / 100;
  const sm = config.survivalMode;
  if (sm && bankroll < sm.balanceThreshold) {
    let n = flatBetContracts(sm.flatBetDollars || 1, priceCents, multiplier);
    if (n * perContract > bankroll) n = Math.floor(bankroll / perContract);
    return n;
  }
  const s = fractionalKellySize({
    bankroll, trueProbability, price: priceCents / 100,
    kellyFraction: config.kellyFraction ?? 0.25, multiplier,
    maxRiskPctPerTrade: config.maxRiskPctPerTrade ?? 0.2, maxStakeDollars: config.maxStakeDollars ?? null,
  });
  return s.contracts || 0;
}

// ---------------------------------------------------------------------------
// Exchange calls
// ---------------------------------------------------------------------------

/**
 * Sends the cancel. Returns { sent, reducedBy, note }.
 *
 * The first attempt goes to the order's own shard; a retry (attempt >= 2)
 * auto-routes by market ticker instead, so a wrong stored shard cannot leave
 * an order uncancellable.
 */
async function cancelOnExchange(order, attempt = 1) {
  const t = encodeURIComponent(order.ticker);
  const query = order.exchangeIndex != null && attempt < 2
    ? `?exchange_index=${order.exchangeIndex}&market_ticker=${t}`
    : `?exchange_index=-1&market_ticker=${t}`;
  try {
    const res = await kalshiDelete(`${ORDERS_V2}/${order.orderId}`, query);
    return { sent: true, reducedBy: countOf(res.reduced_by), note: `reduced_by ${res.reduced_by ?? "?"}` };
  } catch (err) {
    // 404: nothing to cancel - already filled, expired or cancelled. The next
    // sync reads the order and books any fill; it is not an error.
    if (/\b404\b/.test(String(err.message))) return { sent: true, reducedBy: 0, note: "404 - already off the book" };
    appendLog(`Could not cancel resting bid ${order.ticker} (${String(err.message).slice(0, 160)}) - will retry next cycle.`, "warn");
    return { sent: false, reducedBy: 0, note: String(err.message).slice(0, 80) };
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
  const mult = makerMultiplierFor(order.ticker);
  const feeCents = feeCentsReported != null ? feeCentsReported : (mult > 0 ? scheduleFeeCents(priceCents, contracts, true) : 0);
  state.restingOrders = resting;
  saveState(state);

  const ev = makerEvCents(order.trueProbability ?? 0, priceCents, mult, contracts);
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

/**
 * Requests a cancel. Returns true once the request is on its way.
 *
 * CANCELS ARE ASYNCHRONOUS. Production, 21:23:34: every order read back as
 * "resting" the instant after a successful cancel, and read back as gone on
 * the very next cycle 20 seconds later. Treating the instant read-back as a
 * failure produced a wall of false "not confirmed" warnings.
 *
 * So the order stays TRACKED, marked cancelPending, until a later sync sees
 * Kalshi report it off the book - and books any contracts it filled in the
 * meantime. While a cancel is pending, no replacement bid is placed on that
 * game and no taker entry is made on it, so the game can never be bought twice.
 */
export async function cancelResting(ticker, why) {
  const order = readResting()[ticker];
  if (!order) return true;
  if (order.cancelPendingAt) return true;               // already requested; sync confirms it
  const r = await cancelOnExchange(order, 1);
  if (!r.sent) return false;
  writeResting((all) => {
    if (all[ticker]) { all[ticker].cancelPendingAt = new Date().toISOString(); all[ticker].cancelAttempts = 1; all[ticker].cancelWhy = why; }
  });
  appendLog(`Cancel requested for resting bid ${ticker} @ ${order.priceCents}c (${r.note}) - ${why}.`);
  return true;
}

/** True while this ticker, or any ticker on the same game, has a cancel still clearing. */
export function cancelPendingOnEvent(ticker) {
  const ev = eventKeyOf(ticker);
  return Object.values(readResting()).some((o) => o.cancelPendingAt && eventKeyOf(o.ticker) === ev);
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
        if (order.cancelPendingAt) {
          appendLog(`Cancel confirmed: resting bid ${order.ticker} @ ${order.priceCents}c is off the book (${status}).`);
        }
        continue;
      }
      if (order.cancelPendingAt) {
        // Still resting a full cycle after the cancel was sent. Re-send, the
        // second time auto-routed by ticker in case the stored shard is wrong.
        const waited = now - Date.parse(order.cancelPendingAt);
        if (waited > 15_000) {
          const attempt = (order.cancelAttempts || 1) + 1;
          const r = await cancelOnExchange(order, attempt);
          writeResting((all) => { if (all[order.ticker]) { all[order.ticker].cancelAttempts = attempt; all[order.ticker].cancelPendingAt = new Date().toISOString(); } });
          appendLog(
            `Resting bid ${order.ticker} still on the book ${Math.round(waited / 1000)}s after cancel - re-sent ` +
            `(attempt ${attempt}, ${r.note}).`, attempt >= 3 ? "warn" : "info"
          );
        }
        continue;
      }
      if (bidExpired(order, now)) {
        const s = makerSettings();
        if (await cancelResting(order.ticker, `unfilled after ${s.maxRestMinutes} min - tossed`)) {
          recordToss(order);
          out.tossed = (out.tossed || 0) + 1;
        }
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
      const all = Object.values(readResting());
      const live = all.filter((o) => !o.cancelPendingAt).sort((a, b) => Date.parse(b.placedAt) - Date.parse(a.placedAt));
      let excess = positions + all.length - cap;
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
    if (existing && existing.cancelPendingAt) {
      return { action: "none", line: `${c.ticker}: waiting for the previous bid's cancel to clear` };
    }
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
    if (!existing && cancelPendingOnEvent(c.ticker)) return { action: "none", line: "a cancel on this game is still clearing" };
    if (otherSide) return { action: "none", line: `already bidding the other side (${otherSide.ticker})` };

    const mult = makerMultiplierFor(c.ticker);
    const sm = config.survivalMode;
    const contractsAt = sm && bankroll < sm.balanceThreshold
      ? (px) => flatBetContracts(sm.flatBetDollars || 1, px, mult)
      : () => 1;
    const plan = planBid({
      multiplier: mult,
      contractsAt,
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
      const tossed = readTossed()[c.ticker];
      if (tossBlocks(tossed, plan.priceCents, Date.now(), s)) {
        const mins = Math.round((Date.now() - Date.parse(tossed.at)) / 60000);
        return { action: "none", line: `${c.ticker}: ${tossed.priceCents}c bid went unfilled and was tossed ${mins}m ago - not re-posting at ${plan.priceCents}c` };
      }
      const positions = loadState().positions.length;
      if (cap && positions + restingCount() >= cap) return { action: "none", line: `no free slot (${positions} held + ${restingCount()} bids, cap ${cap})` };
    }

    const contracts = sizeFor({ bankroll, trueProbability: c.trueProbability, priceCents: plan.priceCents, config, multiplier: mult });
    if (contracts < 1) return refuse("bankroll cannot fund one contract");
    const evCents = makerEvCents(c.trueProbability, plan.priceCents, mult, contracts);
    if (evCents * contracts < s.minEvCentsPerTrade) {
      return refuse(`expected value ${(evCents * contracts).toFixed(2)}c for the trade is under the ${s.minEvCentsPerTrade}c floor`);
    }

    if (existing) {
      // Re-price in two steps: cancel now, place the new bid once Kalshi has
      // confirmed the old one is off the book (next cycle). Never two bids live.
      const ok = await cancelResting(c.ticker, `re-pricing ${existing.priceCents}c -> ${plan.priceCents}c`);
      return { action: ok ? "repriced" : "none", line: ok ? `${c.ticker}: re-pricing ${existing.priceCents}c -> ${plan.priceCents}c (new bid after the cancel clears)` : "cancel failed - left as is" };
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
      `max ${plan.maxBid}c], EV ${evCents.toFixed(1)}c/contract after ` +
      (mult > 0 ? `the <=${feeCentsAt(plan.priceCents, mult)}c maker fee` : `no maker fee (series not on Kalshi's maker-fee list)`) + `, ` +
      `expires ${Math.round(minutesToStart - s.expireBeforeStartSeconds / 60)}m from now`;
    appendLog(line);
    return { action: existing ? "repriced" : "rested", line };
  } catch (err) {
    return { action: "error", line: `maker path failed: ${err.message}` };
  }
}
