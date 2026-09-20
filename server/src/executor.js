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

export const EXECUTOR_VERSION = "2026-09-19-shard-routing-2";

const ALLOCATION_PATH = `${V2}/portfolio/target_balance_allocation`;

/**
 * Kalshi splits collateral across exchange shards. A market names its shard in
 * market.exchange_index, and an order against a shard holding no collateral is
 * rejected - even when the account has cash, because the cash is sitting on a
 * different shard. This tracks which shard the balance was last moved to so it
 * is only reallocated when it actually needs to move.
 */
let allocatedShard = null;

async function allocateAllTo(exchangeIndex) {
  await kalshiPost(ALLOCATION_PATH, {
    allocations: [{ exchange_index: exchangeIndex, percent: 100 }],
    resting_margin_reservation: "max",
  });
  allocatedShard = exchangeIndex;
  appendLog(`Moved free collateral to exchange shard ${exchangeIndex}.`);
  // Allocation is asynchronous; give the exchange a moment to settle it.
  await new Promise((r) => setTimeout(r, 2000));
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
  if (exchangeIndex != null) body.exchange_index = exchangeIndex;

  let res;
  try {
    res = await kalshiPost(ORDERS_PATH, body);
  } catch (err) {
    // Kalshi reports a shard with no collateral as either
    // insufficient_shard_balance (404) or the generic insufficient_balance
    // (400). Both mean the same thing when the account plainly has cash:
    // the money is sitting on a different shard than this market trades on.
    const isBalanceIssue = /insufficient_(shard_)?balance/.test(String(err.message));
    if (isBalanceIssue && exchangeIndex != null) {
      appendLog(`Shard ${exchangeIndex} has no collateral for ${ticker} - reallocating.`, "warn");
      await allocateAllTo(exchangeIndex);
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
  reason = null, edgePct = null, teamName = null, sportKey = null, commenceTime = null,
}) {
  if (contracts <= 0) return { filled: 0 };

  const config = loadConfig();

  // Cross the spread by this much. At 0 the order quotes the ask exactly and
  // never takes, so it expires unfilled on an IOC.
  const slippage = config.entrySlippageCents ?? 1;
  const limitCents = clampPrice(priceCents + slippage);

  appendLog(
    `Placing entry order: BUY ${contracts}x ${ticker} @ ${limitCents}c ` +
    `(ask ${priceCents}c + ${slippage}c cross)`
  );

  let result;
  try {
    if (exchangeIndex != null && allocatedShard != null && allocatedShard !== exchangeIndex) {
      await allocateAllTo(exchangeIndex);
    }
    result = await placeIOC({ ticker, side: "bid", limitCents, contracts, exchangeIndex });
  } catch (err) {
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
