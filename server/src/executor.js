import { kalshiGet, kalshiPost } from "./kalshiClient.js";
import { appendLog, loadState, saveState } from "./stateStore.js";
import { recordTrade } from "./tradeLedgerStore.js";
import { loadConfig } from "./configStore.js";
import { notifyEntry, notifyExit } from "./notifier.js";
import { getTelegramCredentials } from "./telegramStore.js";

const V2 = "/trade-api/v2";

/**
 * Kalshi retired the v1 order endpoint (HTTP 410 deprecated_v1_order_endpoint).
 * The v2 order API differs in four ways that all matter:
 *   - path is /portfolio/events/orders, not /portfolio/orders
 *   - side is "bid" (buy YES) or "ask" (sell YES), not "yes"/"no"
 *   - price and count are fixed-point STRINGS in dollars ("0.31", "3.00")
 *   - time_in_force and self_trade_prevention_type are required
 * It also returns the fill synchronously, so immediate-or-cancel removes the
 * poll-then-cancel dance entirely: the order either takes liquidity now or
 * ceases to exist.
 */
const ORDERS_PATH = `${V2}/portfolio/events/orders`;

export const EXECUTOR_VERSION = "2026-09-22-auto-routed";

const ALLOCATION_PATH = `${V2}/portfolio/target_balance_allocation`;

/**
 * Kalshi splits collateral across exchange shards. A market names its shard in
 * market.exchange_index, and an order against a shard holding no collateral is
 * rejected even when the account has cash, because the cash is sitting on a
 * different shard. This tracks which shard the balance was last moved to.
 */
let allocatedShard = null;

/**
 * Per-shard balance in DOLLARS, from balance_breakdown.
 *
 * The unit is detected rather than assumed. The top-level `balance` on this
 * same response is known to be cents - every other caller in this codebase
 * divides it by 100 - but nothing documents the unit of the per-shard rows,
 * and getting it wrong is expensive in both directions: read cents as dollars
 * and the collateral wait passes instantly against an unfunded shard, so the
 * order fails and the trade is dropped; read dollars as cents and every shard
 * looks broke and nothing ever trades.
 *
 * So the rows are compared against the total, which is a known quantity. If
 * they sum to roughly the total they are cents; if they sum to roughly a
 * hundredth of it they are dollars. When the sum is unusable the code falls
 * back to treating them as cents, which matches the top-level field.
 */
async function shardBalanceDollars(exchangeIndex) {
  try {
    const bal = await kalshiGet(`${V2}/portfolio/balance`);
    const rows = bal.balance_breakdown ?? [];
    if (!rows.length) return 0;

    const totalCents = Number(bal.balance);
    let sum = 0;
    let mine = null;
    for (const r of rows) {
      const v = Number(r.balance) || 0;
      sum += v;
      if (Number(r.exchange_index) === Number(exchangeIndex)) mine = v;
    }
    if (mine == null) return 0;

    let divisor = 100;                       // default: rows are cents, like bal.balance
    if (Number.isFinite(totalCents) && totalCents > 0 && sum > 0) {
      const asCents = Math.abs(sum - totalCents) / totalCents;
      const asDollars = Math.abs(sum * 100 - totalCents) / totalCents;
      divisor = asDollars < asCents ? 1 : 100;
    }
    return mine / divisor;
  } catch {
    return null; // unknown - caller should not block on it
  }
}

/**
 * Every shard's balance in dollars, as { exchangeIndex: dollars }.
 * Lets the scanner trade what is funded instead of chasing money around.
 */
export async function readShardBalances() {
  try {
    const bal = await kalshiGet(`${V2}/portfolio/balance`);
    const rows = bal.balance_breakdown ?? [];
    if (!rows.length) return null;

    const totalCents = Number(bal.balance);
    let sum = 0;
    for (const r of rows) sum += Number(r.balance) || 0;

    let divisor = 100;
    if (Number.isFinite(totalCents) && totalCents > 0 && sum > 0) {
      const asCents = Math.abs(sum - totalCents) / totalCents;
      const asDollars = Math.abs(sum * 100 - totalCents) / totalCents;
      divisor = asDollars < asCents ? 1 : 100;
    }

    const out = {};
    for (const r of rows) out[Number(r.exchange_index)] = (Number(r.balance) || 0) / divisor;
    return out;
  } catch {
    return null;
  }
}

/**
 * ASKS KALSHI TO MOVE COLLATERAL, AND DOES NOT STAND THERE WATCHING.
 *
 * This is now a LAST RESORT and should essentially never run. Orders no longer
 * pin themselves to a shard (see placeIOC), so Kalshi routes them itself and
 * there is nothing to move. It is kept only for the case where Kalshi rejects
 * an auto-routed order for balance anyway.
 *
 * It used to poll for a full SIXTY SECONDS, inside the scan loop, before
 * giving up on one market. From the live log:
 *
 *     6:19:18  Shard 3 has no collateral for ...NYMTEX-NYM - reallocating.
 *     6:20:19  Shard 3 holds $0.00 of the $1.76 needed after 60s.
 *     6:20:19  Skipping ...NYMTEX-NYM: collateral has not reached shard 3 yet.
 *
 * Sixty-one seconds, one market, no trade - and at a 20s cadence that is three
 * entire scan cycles skipped, every time. The request is now fired, the market
 * is skipped, and the next scan takes it. A short probe is kept only so the
 * log can say whether money actually started moving.
 */
async function requestCollateralMove(exchangeIndex, needDollars = 0, { probeMs = 9000 } = {}) {
  try {
    // The response was previously discarded, which left the one call that
    // mattered completely unobservable: it returned 2xx while moving nothing,
    // and nothing in the log could show that. It is logged now.
    const res = await kalshiPost(ALLOCATION_PATH, {
      allocations: [{ exchange_index: exchangeIndex, percent: 100 }],
      resting_margin_reservation: "max",
    });
    appendLog(`Allocation request for shard ${exchangeIndex} accepted by Kalshi: ${JSON.stringify(res).slice(0, 300)}`);
  } catch (err) {
    appendLog(`Could not request collateral for shard ${exchangeIndex}: ${err.message}`, "warn");
    return false;
  }
  allocatedShard = exchangeIndex;

  // Short probe: three quick looks, not twenty. Enough to report progress,
  // far too short to stall a scan.
  const steps = Math.max(1, Math.round(probeMs / 3000));
  let last = null;
  for (let i = 0; i < steps; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const have = await shardBalanceDollars(exchangeIndex);
    if (have == null) break;
    last = have;
    if (have >= needDollars) {
      appendLog(`Collateral reached shard ${exchangeIndex}: $${have.toFixed(2)} (needed $${needDollars.toFixed(2)}).`);
      return true;
    }
  }

  appendLog(
    `Collateral requested for shard ${exchangeIndex} ($${needDollars.toFixed(2)} needed, ` +
    `$${last == null ? "?" : last.toFixed(2)} there now). Not waiting - Kalshi settles this on its own ` +
    `and the next scan will pick the market up.`
  );
  return false;
}

/** Marks an error as a collateral-routing failure rather than a system fault. */
function tagBalanceError(err) {
  err.isShardFunding = true;
  return err;
}

function newClientOrderId() {
  return `dash_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Contract prices are 1-99c; anything outside that is rejected by Kalshi. */
function clampPrice(cents) {
  return Math.max(1, Math.min(99, Math.round(cents)));
}

/** Kalshi's fixed-point dollar string, e.g. 31 -> "0.31". */
function centsToDollarString(cents) {
  return (clampPrice(cents) / 100).toFixed(2);
}

/** Kalshi's fixed-point count string, e.g. 3 -> "3.00". */
function countString(n) {
  return Number(n).toFixed(2);
}

/** Dollar string back to cents, e.g. "0.3100" -> 31. */
function dollarsToCents(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

/**
 * Places one immediate-or-cancel order and reports what actually filled.
 * Any unfilled remainder is cancelled by the exchange, so nothing is left
 * resting on the book.
 */
async function placeIOC({ ticker, side, limitCents, contracts, reduceOnly = false, exchangeIndex = null }) {
  const body = {
    ticker,
    client_order_id: newClientOrderId(),
    side,                       // "bid" buys YES, "ask" sells YES
    count: countString(contracts),
    price: centsToDollarString(limitCents),
    time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
    post_only: false,
  };
  if (reduceOnly) body.reduce_only = true;

  // EXCHANGE_INDEX IS DELIBERATELY NOT SENT.
  //
  // This one field is why the bot held zero positions with a funded account.
  // Kalshi's API changelog:
  //
  //   "Exchange auto-routing enabled by default when providing market_ticker
  //    and excluding exchange_index parameter."
  //
  // So sending the market's own shard index DISABLES auto-routing and pins the
  // order to that shard. On 2026-09-22 every viable MLB market sat on shard 3,
  // shard 3 held $0.00, and all six positive-EV candidates were rejected -
  // while the account's whole balance sat idle on another shard with NO open
  // positions holding it there.
  //
  // The reallocation dance built around that rejection could never have fixed
  // it. The POST returned 2xx every time - there is no "Could not request
  // collateral" line anywhere in the production log - so Kalshi was accepting
  // the request and treating it as a no-op, and the bot waited on money that
  // was never in transit. Omitting the field hands routing back to Kalshi,
  // which is what it does by default and what it does correctly.
  //
  // The caller still passes exchangeIndex; it is recorded on the position and
  // used by the balance-error fallback below, but it never goes on the order.
  void exchangeIndex;

  let res;
  try {
    res = await kalshiPost(ORDERS_PATH, body);
  } catch (err) {
    // Kalshi reports a shard with no collateral as either
    // insufficient_shard_balance (404) or the generic insufficient_balance
    // (400). Reaching here now means auto-routing itself could not find the
    // money, which is a genuinely different situation from the one this used
    // to fire on constantly.
    const isBalanceIssue = /insufficient_(shard_)?balance/.test(String(err.message));
    if (isBalanceIssue && exchangeIndex != null) {
      appendLog(`Auto-routed order for ${ticker} still refused for balance - requesting collateral on shard ${exchangeIndex}.`, "warn");
      const needDollars = (clampPrice(limitCents) / 100) * Number(contracts) * 1.15; // + fee headroom
      const funded = await requestCollateralMove(exchangeIndex, needDollars);
      if (!funded) {
        // Do not re-send an order that will be rejected again. The move is in
        // flight; the next scan takes this market.
        throw tagBalanceError(new Error(`insufficient_shard_balance (shard ${exchangeIndex}, move requested)`));
      }
      body.client_order_id = newClientOrderId();
      res = await kalshiPost(ORDERS_PATH, body);
    } else {
      throw err;
    }
  }

  const filled = Math.round(Number(res.fill_count ?? 0));
  const avgCents = dollarsToCents(res.average_fill_price);
  const feeCents = dollarsToCents(res.average_fee_paid);

  return {
    orderId: res.order_id ?? null,
    filled: Number.isFinite(filled) ? filled : 0,
    priceCents: avgCents ?? limitCents,
    feeCents: feeCents ?? null,
    remaining: Math.round(Number(res.remaining_count ?? 0)) || 0,
    raw: res,
  };
}

export async function enterPosition({
  ticker, side, priceCents, contracts, exchangeIndex = null,
  limitCents: providedLimit = null,
  reason = null, edgePct = null, teamName = null, sportKey = null, commenceTime = null,
}) {
  if (contracts <= 0) return { filled: 0 };

  const config = loadConfig();

  // THE LIMIT COMES FROM THE ENTRY DECISION.
  //
  // riskManager computes a WALK-UP LIMIT: the highest price at which this
  // opportunity still clears the edge bar, and the price the trade was judged
  // at. Quoting that instead of a flat ask+1c widens the fill window from one
  // cent to as many as four, and cannot produce a negative-expectancy fill
  // because the limit IS the threshold. Kalshi is a central limit order book,
  // so a taker pays the MAKER's price - a limit at 52c against resting offers
  // at 49/50/51 fills at 49, 50 and 51, not 52. The walk-up is free unless the
  // book has genuinely moved away.
  //
  // The flat-cross path stays as a fallback for any caller that has no limit
  // to hand, because an IOC quoted at the ask exactly never takes.
  const slippage = config.entrySlippageCents ?? 1;
  const limitCents = providedLimit != null
    ? clampPrice(Math.max(providedLimit, priceCents))
    : clampPrice(priceCents + slippage);

  appendLog(
    `Placing entry order: BUY ${contracts}x ${ticker} @ ${limitCents}c ` +
    (providedLimit != null
      ? `(ask ${priceCents}c, walk-up limit +${limitCents - priceCents}c - fills anywhere in between)`
      : `(ask ${priceCents}c + ${slippage}c cross)`)
  );

  let result;
  try {
    result = await placeIOC({ ticker, side: "bid", limitCents, contracts, exchangeIndex });
  } catch (err) {
    // A collateral-routing failure is not a system fault. Throwing here tripped
    // the circuit breaker after three markets on an unfunded shard and stopped
    // the bot outright, so it is reported and skipped instead.
    if (err.isShardFunding || /insufficient_(shard_)?balance/.test(String(err.message))) {
      appendLog(
        `${ticker}: collateral is on another shard. Move requested for shard ${exchangeIndex}; ` +
        `this market is picked up on the next scan. Trading continues on funded shards now.`, "warn"
      );
      return { filled: 0, skipped: "shard-unfunded" };
    }
    appendLog(`Entry order rejected for ${ticker}: ${err.message}`, "error");
    throw err;
  }

  const { filled, priceCents: fillPrice } = result;

  if (filled > 0) {
    const state = loadState();
    state.positions.push({
      ticker, side: "yes", entryPriceCents: fillPrice, contracts: filled,
      openedAt: new Date().toISOString(), teamName, sportKey, commenceTime, exchangeIndex,
    });
    saveState(state);
    appendLog(`Filled ${filled}x ${ticker} @ ${fillPrice}c` + (result.feeCents != null ? ` (fee ${result.feeCents}c/contract)` : ""));
  } else {
    appendLog(`No fill on ${ticker} at ${limitCents}c - nothing resting, order expired.`, "warn");
  }

  recordTrade({
    action: "enter", ticker, side: "yes", contracts, priceCents: fillPrice, filled,
    reason: reason || "no reason recorded", edgePct, environment: config.environment,
    teamName, sportKey, commenceTime,
  });

  if (filled > 0) {
    const { botToken, chatId } = getTelegramCredentials();
    notifyEntry({ botToken, chatId, ticker, side: "yes", contracts: filled, priceCents: fillPrice, reason, environment: config.environment })
      .catch(() => {}); // notification failures never block trading
  }

  return { filled, fillPrice };
}

export async function exitPosition(position, reason) {
  const { ticker, contracts } = position;
  const exchangeIndex = position.exchangeIndex ?? null;
  const config = loadConfig();
  // Sell UNDER the best bid so the order crosses and takes.
  const slippage = config.exitSlippageCents ?? 1;

  let remaining = contracts;
  let attempts = 0;
  let lastExitPriceCents = null;

  while (remaining > 0 && attempts < 3) {
    attempts++;

    let bestBid = null;
    try {
      const book = await kalshiGet(`${V2}/markets/${ticker}/orderbook`);
      const ob = book?.orderbook_fp ?? book?.orderbook ?? book ?? {};
      // Selling YES means hitting a YES bid. Side keys carry a "_dollars"
      // suffix and quote in dollars.
      let levels = [];
      for (const [k, v] of Object.entries(ob)) {
        if (Array.isArray(v) && k.toLowerCase().startsWith("yes")) { levels = v; break; }
      }
      for (const lvl of levels) {
        const raw = Array.isArray(lvl) ? lvl[0] : lvl?.price;
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) continue;
        const cents = Math.round(n <= 1 ? n * 100 : n);
        if (bestBid == null || cents > bestBid) bestBid = cents;
      }
    } catch (err) {
      appendLog(`Orderbook read failed on exit of ${ticker}: ${err.message}`, "warn");
    }

    if (!bestBid) {
      appendLog(`No resting YES bids for ${ticker} on exit attempt ${attempts}`, "warn");
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    const limitCents = clampPrice(bestBid - slippage);
    try {
      const res = await placeIOC({ ticker, side: "ask", limitCents, contracts: remaining, reduceOnly: true, exchangeIndex });
      if (res.filled > 0) {
        lastExitPriceCents = res.priceCents;
        remaining -= res.filled;
        appendLog(`Sold ${res.filled}x ${ticker} @ ${res.priceCents}c (${reason})`);
      }
    } catch (err) {
      appendLog(`Exit order rejected for ${ticker}: ${err.message}`, "error");
    }

    if (remaining > 0) await new Promise((r) => setTimeout(r, 1000));
  }

  if (remaining > 0) {
    appendLog(
      `CRITICAL: could not fully exit ${ticker} after ${attempts} attempts, ${remaining} contracts still open. ` +
      `Market is illiquid - manual intervention needed in the Kalshi app.`, "error"
    );
  } else {
    appendLog(`Exited ${ticker} (${reason}): all ${contracts} contracts closed @ ${lastExitPriceCents}c.`);
  }

  recordTrade({
    action: "exit", ticker, side: "yes", contracts, priceCents: position.entryPriceCents,
    exitPriceCents: lastExitPriceCents,
    filled: contracts - remaining, reason, edgePct: null, environment: config.environment,
    teamName: position.teamName ?? null,
    sportKey: position.sportKey ?? null,
    commenceTime: position.commenceTime ?? null,
  });

  const { botToken, chatId } = getTelegramCredentials();
  notifyExit({ botToken, chatId, ticker, side: "yes", contracts, reason, closed: contracts - remaining, remaining })
    .catch(() => {});

  const state = loadState();
  state.positions = state.positions.filter((p) => p.ticker !== position.ticker || p.openedAt !== position.openedAt);
  if (remaining > 0) state.positions.push({ ...position, contracts: remaining, note: "exit incomplete" });
  saveState(state);

  return { closed: contracts - remaining, remaining };
}
