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

export async function enterPosition({ ticker, side, priceCents, contracts, reason = null, edgePct = null }) {
  if (contracts <= 0) return { filled: 0 };

  const clientOrderId = newClientOrderId();
  const body = {
    ticker, client_order_id: clientOrderId, side, action: "buy", type: "limit", count: contracts,
    [side === "yes" ? "yes_price" : "no_price"]: priceCents,
  };

  appendLog(`Placing entry order: ${side.toUpperCase()} ${contracts}x ${ticker} @ ${priceCents}c`);
  const placeRes = await kalshiPost(`${V2}/portfolio/orders`, body);
  const orderId = placeRes.order?.order_id;
  if (!orderId) throw new Error(`Kalshi did not return an order_id: ${JSON.stringify(placeRes)}`);

  await new Promise((r) => setTimeout(r, 5000));
  const statusRes = await kalshiGet(`${V2}/portfolio/orders/${orderId}`);
  const order = statusRes.order;
  const filled = order.taker_fill_count ?? order.filled_count ?? 0;

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
    state.positions.push({ ticker, side, entryPriceCents: priceCents, contracts: filled, openedAt: new Date().toISOString() });
    saveState(state);
    appendLog(`Filled ${filled}x ${ticker} (${side}) @ ${priceCents}c`);
  }

  const config = loadConfig();
  recordTrade({
    action: "enter", ticker, side, contracts, priceCents, filled,
    reason: reason || "no reason recorded", edgePct, environment: config.environment,
  });

  if (filled > 0) {
    const { botToken, chatId } = getTelegramCredentials();
    notifyEntry({ botToken, chatId, ticker, side, contracts: filled, priceCents, reason, environment: config.environment })
      .catch(() => {});
  }

  return { filled };
}

export async function exitPosition(position, reason) {
  const { ticker, side, contracts } = position;
  const sellSide = side;
  let remaining = contracts;
  let attempts = 0;

  while (remaining > 0 && attempts < 3) {
    const book = await kalshiGet(`${V2}/markets/${ticker}/orderbook`);
    const levels = side === "yes" ? book.orderbook?.yes : book.orderbook?.no;
    const bestBid = levels && levels.length ? levels[0][0] : null;

    if (!bestBid) {
      appendLog(`No resting bids for ${ticker} on exit attempt ${attempts + 1}`, "warn");
      attempts++;
      continue;
    }

    const body = {
      ticker, client_order_id: newClientOrderId(), side: sellSide, action: "sell", type: "limit", count: remaining,
      [side === "yes" ? "yes_price" : "no_price"]: bestBid,
    };
    const placeRes = await kalshiPost(`${V2}/portfolio/orders`, body);
    const orderId = placeRes.order?.order_id;
    await new Promise((r) => setTimeout(r, 2000));
    const statusRes = await kalshiGet(`${V2}/portfolio/orders/${orderId}`);
    const filled = statusRes.order?.taker_fill_count ?? 0;
    remaining -= filled;
    attempts++;
  }

  if (remaining > 0) {
    appendLog(
      `CRITICAL: could not fully exit ${ticker} after 3 attempts, ${remaining} contracts still open. ` +
      `Market is illiquid - manual intervention needed in the Kalshi app.`, "error"
    );
  } else {
    appendLog(`Exited ${ticker} (${reason}): all ${contracts} contracts closed.`);
  }

  const config = loadConfig();
  recordTrade({
    action: "exit", ticker, side, contracts, priceCents: position.entryPriceCents,
    filled: contracts - remaining, reason, edgePct: null, environment: config.environment,
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
