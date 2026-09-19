import { kalshiGet, kalshiPost, kalshiDelete } from "./kalshiClient.js";
import { appendLog, loadState, saveState } from "./stateStore.js";
import { recordTrade } from "./tradeLedgerStore.js";
import { loadConfig } from "./configStore.js";
import { notifyEntry, notifyExit } from "./notifier.js";
import { getTelegramCredentials } from "./telegramStore.js";

const V2 = "/trade-api/v2";

function newClientOrderId() {
  return `dash_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Contract prices are 1-99c; anything outside that is rejected by Kalshi. */
function clampPrice(cents) {
  return Math.max(1, Math.min(99, Math.round(cents)));
}

/**
 * Kalshi reports fills in a few different shapes depending on how the order
 * crossed. Taking the real average fill price matters: booking the limit price
 * as cost basis overstates what you paid and makes the below-cost exit fire on
 * positions that are actually flat.
 */
function readFill(order, fallbackCents) {
  const filled = order?.taker_fill_count ?? order?.filled_count ?? 0;

  let avg = order?.average_fill_price ?? null;
  if (!avg && filled > 0 && order?.taker_fill_cost) {
    avg = Math.round(order.taker_fill_cost / filled);
  }

  const price = avg && avg > 0 ? clampPrice(avg) : fallbackCents;
  return { filled, price };
}


export async function enterPosition({ ticker, side, priceCents, contracts, reason = null, edgePct = null, teamName = null, sportKey = null, commenceTime = null }) {
  if (contracts <= 0) return { filled: 0 };

  const config = loadConfig();

  // Cross the spread by this much. At 0 the order quotes the ask exactly and
  // rests behind everyone already there; in a live market the ask has usually
  // moved before the order lands, so it never fills. 1-2c buys the fill.
  const slippage = config.entrySlippageCents ?? 1;
  const limitCents = clampPrice(priceCents + slippage);
  const waitMs = (config.fillWaitSeconds ?? 6) * 1000;

  const clientOrderId = newClientOrderId();
  const body = {
    ticker, client_order_id: clientOrderId, side, action: "buy", type: "limit", count: contracts,
    [side === "yes" ? "yes_price" : "no_price"]: limitCents,
  };

  appendLog(
    `Placing entry order: ${side.toUpperCase()} ${contracts}x ${ticker} @ ${limitCents}c ` +
    `(ask ${priceCents}c + ${slippage}c cross)`
  );
  const placeRes = await kalshiPost(`${V2}/portfolio/orders`, body);
  const orderId = placeRes.order?.order_id;
  if (!orderId) throw new Error(`Kalshi did not return an order_id: ${JSON.stringify(placeRes)}`);

  // Poll rather than sleeping once: a crossing order usually fills instantly,
  // and waiting the full window on every entry adds latency for no reason.
  let order = null;
  let filled = 0;
  let fillPrice = limitCents;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const statusRes = await kalshiGet(`${V2}/portfolio/orders/${orderId}`);
    order = statusRes.order;
    const read = readFill(order, limitCents);
    filled = read.filled;
    fillPrice = read.price;
    if (filled >= contracts) break;
  }

  if (filled < contracts) {
    try {
      await kalshiDelete(`${V2}/portfolio/orders/${orderId}`);
      appendLog(`Partial/no fill on ${ticker}: filled ${filled}/${contracts}, cancelled remainder.`, "warn");
    } catch (err) {
      appendLog(`Failed to cancel remainder of order ${orderId}: ${err.message}`, "error");
    }
  }

  if (filled > 0) {
    const state = loadState();
    state.positions.push({
      ticker, side, entryPriceCents: fillPrice, contracts: filled,
      openedAt: new Date().toISOString(), teamName, sportKey, commenceTime,
    });
    saveState(state);
    appendLog(`Filled ${filled}x ${ticker} (${side}) @ ${fillPrice}c`);
  }

  recordTrade({
    action: "enter", ticker, side, contracts, priceCents: fillPrice, filled,
    reason: reason || "no reason recorded", edgePct, environment: config.environment,
    teamName, sportKey, commenceTime,
  });

  if (filled > 0) {
    const { botToken, chatId } = getTelegramCredentials();
    notifyEntry({ botToken, chatId, ticker, side, contracts: filled, priceCents: fillPrice, reason, environment: config.environment })
      .catch(() => {}); // notification failures never block trading
  }

  return { filled, fillPrice };
}

export async function exitPosition(position, reason) {
  const { ticker, side, contracts } = position;
  const config = loadConfig();
  // Same logic in reverse: sell UNDER the best bid so the order crosses.
  const slippage = config.exitSlippageCents ?? 1;

  const sellSide = side;
  let remaining = contracts;
  let attempts = 0;
  let lastExitPriceCents = null;

  while (remaining > 0 && attempts < 3) {
    const book = await kalshiGet(`${V2}/markets/${ticker}/orderbook`);
    const levels = side === "yes" ? book.orderbook?.yes : book.orderbook?.no;
    const bestBid = levels && levels.length ? levels[0][0] : null;

    if (!bestBid) {
      appendLog(`No resting bids for ${ticker} on exit attempt ${attempts + 1}`, "warn");
      attempts++;
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    const limitCents = clampPrice(bestBid - slippage);
    const body = {
      ticker, client_order_id: newClientOrderId(), side: sellSide, action: "sell", type: "limit", count: remaining,
      [side === "yes" ? "yes_price" : "no_price"]: limitCents,
    };
    const placeRes = await kalshiPost(`${V2}/portfolio/orders`, body);
    const orderId = placeRes.order?.order_id;
    await new Promise((r) => setTimeout(r, 2000));
    const statusRes = await kalshiGet(`${V2}/portfolio/orders/${orderId}`);
    const read = readFill(statusRes.order, limitCents);
    if (read.filled > 0) lastExitPriceCents = read.price;
    remaining -= read.filled;
    attempts++;

    if (remaining > 0 && orderId) {
      try { await kalshiDelete(`${V2}/portfolio/orders/${orderId}`); } catch { /* already gone */ }
    }
  }

  if (remaining > 0) {
    appendLog(
      `CRITICAL: could not fully exit ${ticker} after 3 attempts, ${remaining} contracts still open. ` +
      `Market is illiquid - manual intervention needed in the Kalshi app.`, "error"
    );
  } else {
    appendLog(`Exited ${ticker} (${reason}): all ${contracts} contracts closed @ ${lastExitPriceCents}c.`);
  }

  recordTrade({
    action: "exit", ticker, side, contracts, priceCents: position.entryPriceCents,
    exitPriceCents: lastExitPriceCents,
    filled: contracts - remaining, reason, edgePct: null, environment: config.environment,
    teamName: position.teamName ?? null,
    sportKey: position.sportKey ?? null,
    commenceTime: position.commenceTime ?? null,
  });

  const { botToken, chatId } = getTelegramCredentials();
  notifyExit({ botToken, chatId, ticker, side, contracts, reason, closed: contracts - remaining, remaining })
    .catch(() => {});

  const state = loadState();
  state.positions = state.positions.filter((p) => p !== position);
  if (remaining > 0) state.positions.push({ ...position, contracts: remaining, note: "exit incomplete" });
  saveState(state);

  return { closed: contracts - remaining, remaining };
}
