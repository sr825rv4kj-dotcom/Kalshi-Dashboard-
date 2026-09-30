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

export const EXECUTOR_VERSION = "2026-09-29-partial-sells";

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

/**
 * Total fee Kalshi charged on a fill, in whole cents. `average_fee_paid` is a
 * per-contract dollar string ("0.0175"); rounding it to cents BEFORE
 * multiplying would turn 1.75c into 2c on every contract.
 */
function totalFeeCents(raw, filled) {
  const perContract = Number(raw?.average_fee_paid);
  if (!Number.isFinite(perContract) || !(filled > 0)) return null;
  return Math.round(perContract * 100 * filled * 1e6) / 1e6;
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

  // EXCHANGE_INDEX IS SENT - AND REMOVING IT WAS A MISTAKE.
  //
  // Every fill in the account's history (Sep 19 19:39 through Sep 22 06:52 -
  // lanus +162%, the Blackhawks, the Blues, Sri Lanka) was placed by a version
  // of this file that sent the market's own exchange_index. The 12:23 version
  // removed it on the belief that omitting it auto-routes. Kalshi's sharding
  // guide says otherwise, verbatim:
  //
  //   "If exchange_index is omitted and market_ticker is provided, auto-routes
  //    using market_ticker. Otherwise, defaults to exchange index 0."
  //
  // This body carries `ticker`, not `market_ticker`, so omission sent every
  // order to shard 0 - where a shard-3 MLB market does not exist. Zero fills
  // followed. And auto-routing would not have helped anyway: it routes the
  // ORDER to the market's shard, it does not move COLLATERAL there.
  //
  // So the order goes to the market's own shard, exactly as it did for every
  // trade that ever filled. Whether that shard HAS money is decided by the
  // target balance allocation set in the Kalshi UI - see the balance-error
  // handler below, which says so in the log.
  if (exchangeIndex != null) body.exchange_index = exchangeIndex;

  let res;
  try {
    res = await kalshiPost(ORDERS_PATH, body);
  } catch (err) {
    // Kalshi reports a shard with no collateral as either
    // insufficient_shard_balance (404) or the generic insufficient_balance
    // (400). Both mean the same thing when the account plainly has cash: the
    // money is on a different shard from the one this market trades on.
    const isBalanceIssue = /insufficient_(shard_)?balance/.test(String(err.message));
    if (isBalanceIssue && exchangeIndex != null) {
      // NO AUTOMATIC REALLOCATION. The bot used to POST
      // {exchange_index: N, percent: 100} here - an instruction to put the
      // ENTIRE balance on this one shard. It never demonstrably moved money
      // (the production log shows $0.00 on the shard after 9s and after 60s),
      // and if Kalshi ever did act on it, it would overwrite the account's
      // own allocation and starve every other shard, so the next market on the
      // other shard would fail and flip it back. The allocation belongs to the
      // account holder, set once in the Kalshi UI; Kalshi then rebalances to it
      // every 10 seconds on its own.
      throw tagBalanceError(new Error(
        `insufficient_shard_balance on shard ${exchangeIndex} - fund it by setting a target ` +
        `allocation at kalshi.com/account/exchange-indexes`
      ));
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
        `${ticker}: shard ${exchangeIndex} holds no collateral, so Kalshi refused the order. ` +
        `Fix once, permanently: set a target balance allocation that funds shard ${exchangeIndex} at ` +
        `kalshi.com/account/exchange-indexes - Kalshi then keeps it funded every 10 seconds. ` +
        `Trading continues on funded shards meanwhile.`, "warn"
      );
      return { filled: 0, skipped: "shard-unfunded" };
    }
    appendLog(`Entry order rejected for ${ticker}: ${err.message}`, "error");
    throw err;
  }

  const { filled, priceCents: fillPrice } = result;

  // The position's openedAt is also its LOT ID in the ledger, so every later
  // sale of it is matched to this exact buy (tradeLedgerStore.js).
  const openedAt = new Date().toISOString();
  const entryFeeTotal = filled > 0 ? totalFeeCents(result.raw, filled) : 0;
  if (filled > 0) {
    const state = loadState();
    state.positions.push({
      ticker, side: "yes", entryPriceCents: fillPrice, contracts: filled,
      openedAt, teamName, sportKey, commenceTime, exchangeIndex,
      // The fee actually charged, per contract - the swing exits measure
      // profit against it (null: Kalshi did not report one).
      entryFeePerContractCents: Number.isFinite(entryFeeTotal) ? entryFeeTotal / filled : null,
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
    feeCents: entryFeeTotal,
    lotId: filled > 0 ? openedAt : undefined,
  });

  if (filled > 0) {
    const { botToken, chatId } = getTelegramCredentials();
    notifyEntry({ botToken, chatId, ticker, side: "yes", contracts: filled, priceCents: fillPrice, reason, environment: config.environment })
      .catch(() => {}); // notification failures never block trading
  }

  return { filled, fillPrice };
}

/**
 * Sells a held position - all of it, or `count` contracts of it.
 *
 * PARTIAL SELLS (2026-09-29, swing trading): the swing engine sells half a
 * position when the price climbs back to fair value and keeps the rest for
 * the +65% target. With `count` below the position size, only that many are
 * sold; the rest stays in state as the same position with the smaller count.
 * `keep` (e.g. { soldHalf: true }) is merged in only when the WHOLE requested
 * count sold - a half sale that filled 1 of 5 is not a half sale.
 * `floorCents` is the lowest price the sell may fill at (default: best bid
 * minus the exit slippage) - a profit-taking sell never dumps below the price
 * it was decided at.
 *
 * SAFETY, in this order:
 *   - state is written BEFORE the ledger, so a ledger failure can never make
 *     the next check sell the same contracts again;
 *   - the record written back is the CURRENT one from state minus what sold
 *     (a maker fill booked meanwhile is kept);
 *   - a partial sale whose order failed with an unknown result is not
 *     re-sent: the position is flagged exitUncertainAt and its count is
 *     re-read from Kalshi before the next sale (botController.js);
 *   - the exit price recorded is the average of every fill, not the last.
 */
export async function exitPosition(position, reason, { count = null, keep = null, floorCents = null } = {}) {
  const { ticker } = position;
  const held = Number(position.contracts) || 0;
  const contracts = count != null ? Math.max(0, Math.min(held, Math.floor(count))) : held;
  if (!(contracts > 0)) return { closed: 0, remaining: held, soldCents: null };
  const partial = contracts < held;
  const exchangeIndex = position.exchangeIndex ?? null;
  const config = loadConfig();
  // Sell UNDER the best bid so the order crosses and takes.
  const slippage = config.exitSlippageCents ?? 1;

  let remaining = contracts;
  let attempts = 0;
  let proceedsCents = 0;
  let exitFeeCents = 0;
  let exitFeeKnown = true;
  let uncertain = false;

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
    if (floorCents != null && bestBid < floorCents) {
      appendLog(`${ticker}: best bid ${bestBid}c is under the ${floorCents}c sell floor - not selling this time (${reason})`);
      break;
    }

    const limitCents = clampPrice(floorCents != null ? Math.max(floorCents, bestBid - slippage) : bestBid - slippage);
    try {
      const res = await placeIOC({ ticker, side: "ask", limitCents, contracts: remaining, reduceOnly: true, exchangeIndex });
      if (res.filled > 0) {
        const f = totalFeeCents(res.raw, res.filled);
        if (f == null) exitFeeKnown = false; else exitFeeCents += f;
        proceedsCents += res.priceCents * res.filled;
        remaining -= res.filled;
        appendLog(`Sold ${res.filled}x ${ticker} @ ${res.priceCents}c (${reason})`);
      }
    } catch (err) {
      appendLog(`Exit order rejected for ${ticker}: ${err.message}`, "error");
      // The order's fate is unknown - it may have executed. A PARTIAL sale is
      // not re-sent (a retry could sell past the half); its count is re-read
      // from Kalshi before the next sale. A full exit may retry: reduce-only
      // caps it at what the account actually holds.
      if (partial) { uncertain = true; break; }
    }

    if (remaining > 0) await new Promise((r) => setTimeout(r, 1000));
  }

  const sold = contracts - remaining;
  const avgExitCents = sold > 0 ? Math.round((proceedsCents / sold) * 10) / 10 : null;
  if (remaining > 0 && !partial && floorCents == null) {
    appendLog(
      `CRITICAL: could not fully exit ${ticker} after ${attempts} attempts, ${remaining} contracts still open. ` +
      `Market is illiquid - manual intervention needed in the Kalshi app.`, "error"
    );
  } else if (remaining > 0) {
    appendLog(`${ticker} (${reason}): sold ${sold} of ${contracts} - ${remaining} not filled at or above the sell price; still held.`, "warn");
  } else {
    appendLog(`Exited ${ticker} (${reason}): ${contracts}${partial ? ` of ${held}` : ""} contracts sold @ ${avgExitCents}c.`);
  }

  // 1. STATE FIRST - from the current record, minus what sold.
  let left = held - sold;
  const state = loadState();
  const idx = state.positions.findIndex((p) => p.ticker === position.ticker && p.openedAt === position.openedAt);
  if (idx >= 0) {
    const cur = state.positions[idx];
    left = Math.max(0, (Number(cur.contracts) || 0) - sold);
    if (left <= 0) {
      state.positions.splice(idx, 1);
    } else {
      const next = { ...cur, contracts: left };
      if (partial && remaining === 0 && keep) Object.assign(next, keep);
      if (!partial && remaining > 0) next.note = "exit incomplete";
      if (uncertain) next.exitUncertainAt = new Date().toISOString();
      state.positions[idx] = next;
    }
    saveState(state);
  }

  // 2. THE LEDGER. A full exit is always written (a zero fill is ignored by
  // the trade pairing), a partial one only when something sold.
  if (sold > 0 || !partial) {
    try {
      recordTrade({
        action: "exit", ticker, side: "yes", contracts, priceCents: position.entryPriceCents,
        exitPriceCents: avgExitCents,
        filled: sold, reason, edgePct: null, environment: config.environment,
        feeCents: exitFeeKnown ? exitFeeCents : null,
        teamName: position.teamName ?? null,
        sportKey: position.sportKey ?? null,
        commenceTime: position.commenceTime ?? null,
        lotId: position.openedAt ?? undefined,
      });
    } catch (err) {
      appendLog(`LEDGER WRITE FAILED for the sale of ${sold}x ${ticker} @ ${avgExitCents}c (${reason}): ${err.message} - the position itself is updated.`, "error");
    }
    try {
      const { botToken, chatId } = getTelegramCredentials();
      notifyExit({ botToken, chatId, ticker, side: "yes", contracts, reason, closed: sold, remaining: left })
        .catch(() => {});
    } catch { /* notifications never block trading */ }
  }

  return { closed: sold, remaining: left, soldCents: avgExitCents, uncertain };
}
