/**
 * Portfolio + risk-assessment routes. Reads real Kalshi data only.
 */
import { kalshiGet } from "../kalshiClient.js";
import { assessOpportunity } from "../riskManager.js";

const V2 = "/trade-api/v2";

export function registerPortfolioRoutes(app) {
  app.get("/api/balance", async (_req, res) => {
    try {
      const data = await kalshiGet(`${V2}/portfolio/balance`);
      res.json({ balanceDollars: (data.balance ?? 0) / 100 });
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

  app.get("/api/orders", async (req, res) => {
    try {
      const limit = req.query.limit || "50";
      const data = await kalshiGet(`${V2}/portfolio/orders`, `?limit=${limit}`);
      const orders = (data.orders ?? []).map((o) => ({
        orderId: o.order_id,
        ticker: o.ticker,
        side: o.side,
        action: o.action,
        status: o.status,
        priceCents: o.yes_price ?? o.no_price,
        count: o.remaining_count ?? o.original_count ?? o.count,
        createdTime: o.created_time,
      }));
      res.json({ orders });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/pnl-history", async (req, res) => {
    try {
      const limit = req.query.limit || "200";
      const data = await kalshiGet(`${V2}/portfolio/settlements`, `?limit=${limit}`);
      const settlements = (data.settlements ?? []).map((s) => ({
        ticker: s.ticker,
        settledTime: s.settled_time,
        revenueDollars: (s.revenue ?? 0) / 100,
        yesTotalCostDollars: (s.yes_total_cost ?? 0) / 100,
        noTotalCostDollars: (s.no_total_cost ?? 0) / 100,
      }));

      const sorted = [...settlements].sort((a, b) => new Date(a.settledTime) - new Date(b.settledTime));
      let cumulative = 0;
      const series = sorted.map((s) => {
        const cost = s.yesTotalCostDollars + s.noTotalCostDollars;
        const pnl = s.revenueDollars - cost;
        cumulative += pnl;
        return { date: s.settledTime, ticker: s.ticker, pnl, cumulativePnl: cumulative };
      });

      res.json({ series });
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
