/**
 * Portfolio + risk-assessment routes. Reads real Kalshi data only.
 */
import { kalshiGet } from "../kalshiClient.js";
import { assessOpportunity } from "../riskManager.js";
import { getTradeLifecycles } from "../tradeLedgerStore.js";

/**
 * Pure: completed lifecycles -> chart series, oldest close first, running
 * total of net-after-fees. Exported for testing against the real ledger.
 */
export function ledgerSeries(completed) {
  const rows = [...(completed || [])]
    .filter((t) => Number.isFinite(Number(t.netDollars)))
    .sort((a, b) => Date.parse(a.exitTimestamp) - Date.parse(b.exitTimestamp));
  let cumulative = 0;
  return rows.map((t) => {
    cumulative += t.netDollars;
    return {
      date: t.exitTimestamp, ticker: t.ticker, team: t.teamName ?? null, exit: t.exitReason ?? null,
      pnl: Math.round(t.netDollars * 100) / 100, cumulativePnl: Math.round(cumulative * 100) / 100,
    };
  });
}

const V2 = "/trade-api/v2";

/**
 * Kalshi has been migrating to fixed-point dollar strings ("0.43") alongside
 * the older integer-cent fields, and the order objects no longer carry
 * yes_price / remaining_count - which is why the dashboard showed "Entered -"
 * with no amount. Rather than bet on one spelling, take the first field that
 * actually has a value and normalize: anything at or below 1 is dollars,
 * anything above is already cents.
 */
function firstNumber(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v == null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function toCents(raw) {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n <= 1 ? n * 100 : n);
}

function normalizeOrder(o) {
  const priceRaw = firstNumber(o, [
    "yes_price", "no_price", "price",
    "yes_price_dollars", "no_price_dollars", "price_dollars",
    "average_fill_price", "avg_price",
  ]);

  const count = firstNumber(o, [
    "count", "initial_count", "original_count",
    "fill_count", "taker_fill_count", "filled_count",
    "remaining_count",
  ]);

  const filled = firstNumber(o, ["fill_count", "taker_fill_count", "filled_count"]);

  return {
    orderId: o.order_id ?? o.id ?? null,
    ticker: o.ticker ?? null,
    side: o.side ?? null,                       // "yes"/"no" or "bid"/"ask"
    action: o.action ?? (o.side === "bid" ? "buy" : o.side === "ask" ? "sell" : null),
    status: o.status ?? null,
    priceCents: toCents(priceRaw),
    count: count != null ? Math.round(count) : null,
    filled: filled != null ? Math.round(filled) : null,
    createdTime: o.created_time ?? o.created_ts ?? o.ts_ms ?? null,
  };
}

export function registerPortfolioRoutes(app) {
  app.get("/api/balance", async (_req, res) => {
    try {
      const data = await kalshiGet(`${V2}/portfolio/balance`);
      res.json({
        balanceDollars: (data.balance ?? 0) / 100,
        positionsValueDollars: (data.portfolio_value ?? 0) / 100,
        equityDollars: ((data.balance ?? 0) + (data.portfolio_value ?? 0)) / 100,
        shards: data.balance_breakdown ?? null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/positions", async (_req, res) => {
    try {
      const data = await kalshiGet(`${V2}/portfolio/positions`);
      const positions = (data.market_positions ?? []).map((p) => ({
        ticker: p.ticker,
        position: p.position_fp != null ? Number(p.position_fp) : (p.position ?? 0),
        marketExposureDollars: p.market_exposure_dollars != null
          ? Number(p.market_exposure_dollars)
          : (p.market_exposure ?? 0) / 100,
        realizedPnlDollars: p.realized_pnl_dollars != null
          ? Number(p.realized_pnl_dollars)
          : (p.realized_pnl ?? 0) / 100,
        restingOrdersCount: p.resting_orders_count,
      }))
      // Kalshi keeps returning settled holdings at 0 contracts. Those aren't
      // positions you hold, so they don't belong in an "open positions" table.
      .filter((p) => p.position !== 0);

      res.json({ positions });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Recent orders. Add ?debug=1 to see the raw field names Kalshi returns for
   * the first order - the fastest way to settle a mapping question without
   * another round of guessing.
   */
  app.get("/api/orders", async (req, res) => {
    try {
      const limit = req.query.limit || "50";
      const data = await kalshiGet(`${V2}/portfolio/orders`, `?limit=${limit}`);
      const raw = data.orders ?? [];
      const orders = raw.map(normalizeOrder);

      if (req.query.debug === "1") {
        return res.json({
          orders,
          debug: {
            count: raw.length,
            firstOrderKeys: raw.length ? Object.keys(raw[0]) : [],
            firstOrderRaw: raw.length ? raw[0] : null,
            topLevelKeys: Object.keys(data ?? {}),
          },
        });
      }

      res.json({ orders });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * CUMULATIVE P&L - FROM THE BOT'S OWN TRADE LEDGER (2026-09-24).
   *
   * This chart read Kalshi's /portfolio/settlements and showed -$199.85 over
   * "52 settled trades" while the bot's ledger - every entry and exit with the
   * fee Kalshi charged - showed +$2.96 over 59 closed trades. Two faults:
   *
   *   1. Settlements only cover positions HELD to settlement. Every position the
   *      bot sold early (ceiling take-outs, blowout sells) is missing, so the
   *      line could never match the Statement.
   *   2. Kalshi's settlement list is the whole ACCOUNT, not the bot: anything
   *      settled before the bot existed is in it. The line opened with a single
   *      ~$180 drop - no bot bet has ever been larger than a few dollars.
   *
   * The ledger is the complete record of what the bot actually did, so the
   * chart now plots it: one point per closed trade, net of BOTH fees, in the
   * order the trades closed. Its last point equals the Statement's net.
   *
   * ?source=kalshi still returns the raw account-settlement view (with the
   * fee_cost unit fixed) for anyone who wants the account-level number.
   */
  app.get("/api/pnl-history", async (req, res) => {
    try {
      if (req.query.source !== "kalshi") {
        const series = ledgerSeries(getTradeLifecycles().completed);
        return res.json({ series, source: "bot trade ledger", coverage: "every closed bot trade, net of fees" });
      }

      const limit = req.query.limit || "200";
      const data = await kalshiGet(`${V2}/portfolio/settlements`, `?limit=${limit}`);
      const raw = data.settlements ?? [];
      const num = (v) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

      let unreadable = 0;
      const settlements = [];
      for (const s of raw) {
        // Per Kalshi's schema: revenue is integer CENTS; *_total_cost_dollars and
        // fee_cost are DOLLAR strings.
        const revenueCents = num(s.revenue);
        const yesCost = num(s.yes_total_cost_dollars) ?? (num(s.yes_total_cost) != null ? num(s.yes_total_cost) / 100 : null);
        const noCost = num(s.no_total_cost_dollars) ?? (num(s.no_total_cost) != null ? num(s.no_total_cost) / 100 : null);
        if (revenueCents == null || (yesCost == null && noCost == null)) { unreadable++; continue; }
        settlements.push({
          ticker: s.ticker, settledTime: s.settled_time,
          revenueDollars: revenueCents / 100, costDollars: (yesCost ?? 0) + (noCost ?? 0),
          feeDollars: num(s.fee_cost) ?? 0,
        });
      }
      const sorted = settlements.sort((a, b) => new Date(a.settledTime) - new Date(b.settledTime));
      let cumulative = 0;
      const series = sorted.map((s) => {
        const pnl = s.revenueDollars - s.costDollars - s.feeDollars;
        cumulative += pnl;
        return { date: s.settledTime, ticker: s.ticker, pnl, cumulativePnl: cumulative };
      });
      res.json({ series, unreadable, source: "kalshi account settlements", coverage: "held-to-settlement only, whole account" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Risk assessment (calculation only, never places orders) ---
  app.post("/api/assess", (req, res) => {
    try {
      const { bankroll, trueProbability, price, restingContracts, kellyFraction, minLiquidity } = req.body || {};
      if (typeof bankroll !== "number" || typeof trueProbability !== "number" ||
          typeof price !== "number" || typeof restingContracts !== "number") {
        return res.status(400).json({
          error: "bankroll, trueProbability, price, and restingContracts must all be numbers",
        });
      }
      res.json(assessOpportunity({ bankroll, trueProbability, price, restingContracts, kellyFraction, minLiquidity }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
