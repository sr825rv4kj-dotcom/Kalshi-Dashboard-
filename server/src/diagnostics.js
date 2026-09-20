/**
 * Deep diagnostic + manual trade test. Registers /api/diagnose/v2 and
 * /api/test-trade.
 *
 * The test-trade route exists because every layer reported healthy while zero
 * orders reached the exchange. It places one real contract with no edge check,
 * no sizing logic and no position cap, and returns Kalshi's raw response - so
 * the execution path is proven or disproven outright.
 */
import fs from "fs";
import crypto from "crypto";
import { kalshiGet, kalshiPost, kalshiDelete } from "./kalshiClient.js";
import { tradableBankroll } from "./botController.js";
import { loadConfig } from "./configStore.js";
import { loadState } from "./stateStore.js";
import { getSharpProbabilities } from "./scraper.js";
import { resolveTicker, getFetchReport, SPORT_SERIES_MAP } from "./tickerResolver.js";
import { discoverActiveSports } from "./sportsDiscovery.js";
import { assessOpportunity } from "./riskManager.js";

const V2 = "/trade-api/v2";

function toCents(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n <= 1 ? n * 100 : n);
}

function bestLevel(levels) {
  let best = null;
  for (const lvl of levels ?? []) {
    const rawPrice = Array.isArray(lvl) ? lvl[0] : (lvl?.price ?? lvl?.yes_price ?? lvl?.no_price);
    const rawSize = Array.isArray(lvl) ? lvl[1] : (lvl?.size ?? lvl?.count ?? lvl?.quantity);
    const price = toCents(rawPrice);
    if (price == null) continue;
    if (!best || price > best.price) best = { price, size: Number(rawSize ?? 0) || 0 };
  }
  return best;
}

/** Reads the book and returns the ask plus the raw shape, for inspection. */
async function bookPrice(ticker) {
  const book = await kalshiGet(`${V2}/markets/${ticker}/orderbook`);
    const ob = book?.orderbook_fp ?? book?.orderbook ?? book ?? {};

  const sideFor = (prefix) => {
    for (const [k, v] of Object.entries(ob)) {
      if (Array.isArray(v) && k.toLowerCase().startsWith(prefix)) return v;
    }
    return [];
  };
  const noLevels = sideFor("no");
  const yesLevels = sideFor("yes");


  const bestNo = bestLevel(noLevels);
  const bestYes = bestLevel(yesLevels);

  let askCents = 0;
  let source = "none";
  if (bestNo && bestNo.price > 0 && bestNo.price < 100) {
    askCents = 100 - bestNo.price;
    source = "book-no-bid";
  } else if (bestYes && bestYes.price > 0 && bestYes.price < 99) {
    askCents = bestYes.price + 1;
    source = "book-yes-bid+1";
  }

  return {
    askCents, source,
    bestNoBid: bestNo, bestYesBid: bestYes,
    topLevelKeys: Object.keys(book ?? {}),
    bookKeys: Object.keys(ob),
    yesCount: yesLevels.length,
    noCount: noLevels.length,
    rawSample: JSON.stringify(ob).slice(0, 400),
  };
}

function credentialsStage() {
  try {
    const keyId = process.env.KALSHI_API_KEY_ID;
    const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH;
    const keyPem = process.env.KALSHI_PRIVATE_KEY_PEM;
    const fileExists = Boolean(keyPath && fs.existsSync(keyPath));

    let fingerprint = null;
    let keyError = null;
    try {
      const pem = fileExists ? fs.readFileSync(keyPath, "utf8") : (keyPem || "").replace(/\\n/g, "\n");
      const pub = crypto.createPublicKey(pem);
      fingerprint = crypto.createHash("sha256")
        .update(pub.export({ type: "spki", format: "der" }))
        .digest("hex").slice(0, 16);
    } catch (err) {
      keyError = err.message;
    }

    return {
      keyId: keyId ? `${keyId.slice(0, 8)}...` : null,
      source: fileExists ? "saved in app" : keyPem ? "KALSHI_PRIVATE_KEY_PEM env var" : "none",
      envVarAlsoSet: Boolean(keyPem),
      keyFileExists: fileExists,
      fingerprint,
      keyError,
    };
  } catch (err) {
    return { error: err.message };
  }
}

export function registerDiagnosticRoutes(app) {
  /**
   * Places ONE contract at the current ask, no edge check, no cap. Optional
   * body: { ticker, contracts, maxPriceCents }. With no ticker it picks the
   * first live market it can price from the active sports.
   */
  app.post("/api/test-trade", async (req, res) => {
    const out = { steps: [] };
    const step = (name, data) => out.steps.push({ name, ...data });

    try {
      const body = req.body || {};
      const contracts = Math.max(1, Math.min(5, Number(body.contracts) || 1));
      const maxPriceCents = Number(body.maxPriceCents) || 95;

      // 1. Choose a market
      let ticker = (body.ticker || "").trim();
      if (!ticker) {
        const config = loadConfig();
        const sports = await discoverActiveSports();
        step("discover", { sports });

        outer:
        for (const sportKey of sports) {
          let probs;
          try {
            probs = await getSharpProbabilities(sportKey, {
              oddsPapiTournamentId: (config.oddsPapiTournamentIds || {})[sportKey],
              providerOrder: config.oddsProviderOrder,
            });
          } catch (err) {
            step("odds", { sportKey, error: err.message });
            continue;
          }
          for (const [teamName, info] of Object.entries(probs.probabilities)) {
            const r = await resolveTicker({ sportKey, teamName, commenceTime: info.commenceTime });
            if (!r.ticker) continue;
            const priced = await bookPrice(r.ticker).catch(() => null);
            if (priced && priced.askCents > 0 && priced.askCents <= maxPriceCents) {
              ticker = r.ticker;
              step("picked", { sportKey, teamName, ticker, priced });
              break outer;
            }
          }
        }
      }

      if (!ticker) {
        step("picked", { error: "No market could be priced. Pass a ticker explicitly." });
        return res.json({ ok: false, ...out });
      }

      // 2. Confirm the market is tradeable
      const mRes = await kalshiGet(`${V2}/markets/${ticker}`);
      const market = mRes.market || {};
      step("market", {
        ticker, status: market.status,
        yes_ask: market.yes_ask, yes_bid: market.yes_bid,
        title: market.title, subtitle: market.yes_sub_title,
      });

      // 3. Price it
      const priced = await bookPrice(ticker);
      step("price", priced);

      const limitCents = Math.max(1, Math.min(99, (priced.askCents || market.yes_ask || 0) + 1));
      if (limitCents <= 1) {
        step("abort", { reason: "No usable price - nothing to buy." });
        return res.json({ ok: false, ...out });
      }
      if (limitCents > maxPriceCents) {
        step("abort", { reason: `Price ${limitCents}c exceeds maxPriceCents ${maxPriceCents}.` });
        return res.json({ ok: false, ...out });
      }

            // 4. Place the order on Kalshi's v2 order API. The v1 endpoint now
      //    returns HTTP 410 deprecated_v1_order_endpoint. Immediate-or-cancel
      //    means the response itself reports the fill - no polling, and no
      //    stray order left resting if it does not take.
      const orderBody = {
        ticker,
        client_order_id: `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        side: "bid",
        count: Number(contracts).toFixed(2),
        price: (limitCents / 100).toFixed(2),
        time_in_force: "immediate_or_cancel",
        self_trade_prevention_type: "taker_at_cross",
        post_only: false,
      };
      step("placing", { endpoint: `${V2}/portfolio/events/orders`, orderBody });

      let placeRes;
      try {
        placeRes = await kalshiPost(`${V2}/portfolio/events/orders`, orderBody);
      } catch (err) {
        step("place-failed", { error: err.message });
        return res.json({ ok: false, ...out });
      }

      const filled = Math.round(Number(placeRes.fill_count ?? 0)) || 0;
      const avgPrice = Number(placeRes.average_fill_price);
      step("fill", {
        filled,
        requested: contracts,
        remaining: placeRes.remaining_count,
        averageFillPriceCents: Number.isFinite(avgPrice) ? Math.round(avgPrice * 100) : null,
        averageFeeCents: Number.isFinite(Number(placeRes.average_fee_paid))
          ? Math.round(Number(placeRes.average_fee_paid) * 100) : null,
        raw: placeRes,
      });



      // 5. Check the fill
      await new Promise((r) => setTimeout(r, 3000));
      const statusRes = await kalshiGet(`${V2}/portfolio/orders/${orderId}`);
      const order = statusRes.order || {};
      const filled = order.taker_fill_count ?? order.filled_count ?? 0;
      step("fill", {
        filled, requested: contracts, status: order.status,
        average_fill_price: order.average_fill_price, raw: order,
      });

      // 6. Cancel anything unfilled so a stray order is not left resting
      if (filled < contracts && orderId) {
        try {
          await kalshiDelete(`${V2}/portfolio/orders/${orderId}`);
          step("cancelled-remainder", { cancelled: contracts - filled });
        } catch (err) {
          step("cancel-failed", { error: err.message });
        }
      }

      return res.json({ ok: filled > 0, ticker, filled, limitCents, ...out });
    } catch (err) {
      step("error", { error: err.message });
      return res.status(500).json({ ok: false, error: err.message, ...out });
    }
  });

  app.get("/api/diagnose/v2", async (_req, res) => {
    const report = { ranAt: new Date().toISOString(), stages: {}, sports: [] };

    try {
      report.stages.credentials = credentialsStage();

      try {
        const bal = await kalshiGet(`${V2}/portfolio/balance`);
        report.stages.kalshi = { ok: true, balanceDollars: (bal.balance ?? 0) / 100 };
      } catch (err) {
        report.stages.kalshi = { ok: false, error: err.message };
      }

      const config = loadConfig();
      const bankroll = report.stages.kalshi?.balanceDollars ?? 0;
      const tiering = tradableBankroll(bankroll, config);
      report.stages.config = {
        environment: config.environment,
        entryWindowHours: config.entryWindowHours,
        minEntryPriceCents: config.minEntryPriceCents,
        perPositionStopLossPct: config.perPositionStopLossPct,
        takeProfitPct: config.takeProfitPct ?? 0.12,
        trailingStopPct: config.trailingStopPct ?? 0.08,
        exitBelowCost: config.exitBelowCost,
        entrySlippageCents: config.entrySlippageCents ?? 1,
        tier: tiering.tier,
        reserve: tiering.reserve,
        tradableBankroll: tiering.tradable,
        openPositions: loadState().positions.length,
      };

      let activeSports = [];
      try {
        activeSports = await discoverActiveSports();
        report.stages.sports = { ok: true, activeSports, seriesMapped: Object.keys(SPORT_SERIES_MAP) };
      } catch (err) {
        report.stages.sports = { ok: false, error: err.message };
      }

      for (const sportKey of activeSports) {
        const entry = { sportKey, samples: [] };

        let probResult = null;
        try {
          probResult = await getSharpProbabilities(sportKey, {
            oddsPapiTournamentId: (config.oddsPapiTournamentIds || {})[sportKey],
            providerOrder: config.oddsProviderOrder,
          });
          entry.odds = {
            ok: true, provider: probResult.provider,
            teamsFound: Object.keys(probResult.probabilities).length,
            quotaRemaining: probResult.quota?.remaining ?? null,
          };
        } catch (err) {
          entry.odds = { ok: false, error: err.message };
          report.sports.push(entry);
          continue;
        }

        for (const [teamName, info] of Object.entries(probResult.probabilities).slice(0, 4)) {
          const sample = { teamName, trueProbability: info.trueProbability, commenceTime: info.commenceTime };
          try {
            const resolved = await resolveTicker({ sportKey, teamName, commenceTime: info.commenceTime });
            sample.ticker = resolved.ticker;
            sample.resolveReason = resolved.reason;

            if (resolved.ticker) {
              const m = await kalshiGet(`${V2}/markets/${resolved.ticker}`);
              const market = m.market || {};
              sample.marketStatus = market.status;

              const priced = await bookPrice(resolved.ticker);
              sample.yesAsk = priced.askCents;
              sample.yesAskSize = priced.bestNoBid?.size ?? 0;
              sample.priceSource = priced.source;
              sample.bookKeys = priced.bookKeys.join(",");
              sample.bookCounts = `yes=${priced.yesCount} no=${priced.noCount}`;

              if (priced.askCents > 0) {
                const verdict = assessOpportunity({
                  bankroll: tiering.tradable,
                  trueProbability: info.trueProbability,
                  price: priced.askCents / 100,
                  restingContracts: sample.yesAskSize,
                  multiplier: config.feeMultiplier,
                  kellyFraction: config.kellyFraction ?? tiering.tier.kellyFraction,
                  minLiquidity: config.minLiquidity ?? 0,
                  maxStakeDollars: tiering.tier.maxStakeDollars,
                  survivalMode: config.survivalMode,
                });
                sample.verdict = verdict.action;
                sample.verdictReason = verdict.reason ?? null;
                sample.edge = verdict.edgeCheck ?? null;
                sample.sizing = verdict.sizing ?? null;
              }
            }
          } catch (err) {
            sample.error = err.message;
          }
          entry.samples.push(sample);
        }

        entry.kalshiFetch = getFetchReport(SPORT_SERIES_MAP[sportKey]);
        report.sports.push(entry);
      }

      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message, partial: report });
    }
  });
}
