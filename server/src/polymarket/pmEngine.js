/**
 * polymarket/pmEngine.js
 *
 * POLYMARKET US - SAME STRATEGY, SECOND EXCHANGE (2026-09-27)
 *
 * Trades Polymarket US exactly the way the bot trades Kalshi, with the same
 * inputs and the same rules - nothing here is a separate strategy:
 *
 *   - the same sharp lines (read from the Kalshi scan of the same cycle, so
 *     the odds API is not paid twice)
 *   - live games only, with the same in-game model check (pre-game prior)
 *   - the same 35-70c live band, 25c spread limit, 18% plausibility ceiling
 *   - the same 30% minimum expected return AFTER Polymarket's own fee
 *     (0.0695 x C x p x (1-p), a little under Kalshi's 0.07)
 *   - the same stake tiers, read from the POLYMARKET account's equity
 *   - the same losing-streak brake and learned sport/band blocks, fed by one
 *     shared trade ledger, so both exchanges learn from all results
 *   - held to settlement, like Kalshi
 *
 * SAME TRADES ON BOTH EXCHANGES (2026-09-28, account holder's rule - replaces
 * "one bet per game across both exchanges", which gave every game to Kalshi
 * because Kalshi scans first). A game held on Kalshi may also be bought here,
 * on the SAME team, when Polymarket's own price clears the same rules; the
 * other team is never bought. One bet per game still applies on each
 * exchange by itself.
 *
 * SWITCHED ON BY A LIVE SELF-CHECK, NOT BY GUESSWORK. Before the first order,
 * the engine checks the real API: the keys sign correctly and read the
 * balance, real games are found and each side is tied to a team by id, and a
 * PREVIEW order (validated by Polymarket, never executed) comes back in the
 * expected form. trading: "auto" trades only once all of that passes.
 *
 * BACKING THE NO SIDE - PER POLYMARKET'S OWN DOCS (2026-09-28).
 * docs.polymarket.us/api-reference/orders/overview: "The price.value field
 * always represents the long side's price, regardless of which order intent
 * you use." Their worked example: market aec-cbb-usc-iowa, YES = USC, NO =
 * Iowa - "Buy Iowa at 0.83" is ORDER_INTENT_BUY_SHORT with price.value 0.17.
 * The partner data model says the same: "BUY q NO @ p = SELL q YES @ (1 - p)".
 * So a NO order is sent as BUY_SHORT at (1 - our NO limit). The self-check
 * sends one PREVIEW in exactly that form (validated, never executed - "Preview
 * an order before submission to validate parameters") and the NO side turns
 * on once Polymarket accepts it as a BUY_SHORT.
 *
 * Every failure is contained: nothing here can stop or slow the Kalshi bot.
 */

import { loadState, appendLog } from "../stateStore.js";
import { recordTrade } from "../tradeLedgerStore.js";
import { entryTiming, getRecentLines, rememberLines } from "../scanner.js";
import { getSharpProbabilities } from "../scraper.js";
import { getLiveScores, findLiveGameForTeam } from "../scoresFetcher.js";
import { corroboratedProbability, fractionRemaining, paramsFor, pregamePrior, rememberPregame, flushPregamePriors } from "../liveModel.js";
import { allActiveSportKeys } from "../sportsDiscovery.js";
import { schedulePlan, shouldScanSport, openTradeCap } from "../liveSchedule.js";
import { noteDecision, noteScan } from "../scanFeed.js";
import { getSeriesMap } from "../tickerResolver.js";
import { assessOpportunity, feePerContractCents, flatBetContracts } from "../riskManager.js";
import { learnedBlock, streakStakeFactor } from "../outcomeLearner.js";
import { tieredStake } from "../scaling.js";
import { getRestingOrders } from "../makerEngine.js";
import { notifyEntry } from "../notifier.js";
import { getTelegramCredentials } from "../telegramStore.js";
import { pmGet, pmPost, pmConfigured, pmClientStats, pmCredentialReport, dollarsOf, centsOf, numberOf, PM_CLIENT_VERSION } from "./pmClient.js";
import { leagueSlugFor, leagueSlugsFor, getSportEvents, mappedSports, getLeagues, getLeagueEvents, matchEvent, winnerSideFor, sidePrice, pmMarketsReport } from "./pmMarkets.js";
import { pmPositions, savePmPositions, pmMeta, updatePmMeta, heldOnPolymarket, kalshiTeamOnGame, normName } from "./pmState.js";

export const PM_ENGINE_VERSION = "2026-09-29-no-score-fresh-line";
export const PM_FEE = 0.0695;

const SELF_CHECK_EVERY_MS = 30 * 60 * 1000;
const SELF_CHECK_RETRY_MS = 5 * 60 * 1000;
const MISSING_GRACE_MS = 30 * 60 * 1000;
const LINE_MAX_AGE_MS = 120 * 1000;

export function pmSettings(config = {}) {
  return {
    enabled: true,
    trading: "auto",        // "auto" | "on" | "off"
    shortSide: "auto",      // "auto" | "on" | "off"
    ...(config.polymarket && typeof config.polymarket === "object" ? config.polymarket : {}),
  };
}

function tradingActive(settings, meta) {
  if (settings.enabled === false || settings.trading === "off") return false;
  if (!pmConfigured()) return false;
  if (settings.trading === "on") return meta.selfCheck?.balanceOk === true;
  return meta.selfCheck?.passed === true;
}

// The documented NO-order format ("long-price") is the only one that turns the
// NO side on. Anything an older build recorded ("no-price", "unconfirmed",
// "unknown") is ignored: the new self-check runs on the first cycle after this
// build starts (its version differs) and records the documented result.
const DOCUMENTED_SHORT_FORMAT = "long-price";
// Builds whose self-check sends the NO preview in the documented format. A
// confirmation from any of them stands: the order format does not change
// between builds, so a new build does not switch the NO side off.
const DOCUMENTED_FORMAT_VERSIONS = new Set(["2026-09-28-no-side-per-docs", "2026-09-28-live-schedule", "2026-09-28-same-trades-both", "2026-09-28-scanner-tab", PM_ENGINE_VERSION]);

function shortConfirmed(sc) {
  return sc?.shortConvention === DOCUMENTED_SHORT_FORMAT && DOCUMENTED_FORMAT_VERSIONS.has(sc?.version);
}

function shortSideActive(settings, meta) {
  if (settings.shortSide === "off") return false;
  return shortConfirmed(meta.selfCheck);
}

/** The price.value Polymarket expects: always the YES (long) side's price. */
/** A live game with no score may trade only on a sharp line of KNOWN age, updated within the limit (default 120s). */
function freshLineOk(lineAgeSeconds, config = {}) {
  const n = Number(config.noScoreMaxLineAgeSeconds);
  const max = Number.isFinite(n) && n > 0 ? n : 120;
  const age = Number.isFinite(Number(lineAgeSeconds)) && lineAgeSeconds != null ? Math.round(Number(lineAgeSeconds)) : null;
  return { ok: age != null && age <= max, age, max };
}

function longSidePriceCents(long, limitCents) {
  const limit = Math.floor(limitCents);          // never pay above our limit
  return long ? limit : 100 - limit;             // BUY NO at L  ==  SELL YES at (100 - L)
}

const isDraw = (n) => /^(draw|tie)$/i.test(String(n || "").trim());

// --- Account -------------------------------------------------------------------------

export async function readPmAccount() {
  const bal = await pmGet("/v1/account/balances", { auth: true });
  const rows = bal.balances || [];
  const usd = rows.find((r) => !r.currency || r.currency === "USD") || rows[0] || {};
  const cash = numberOf(usd.currentBalance) ?? 0;
  const buyingPower = numberOf(usd.buyingPower, usd.currentBalance) ?? 0;
  return { cash, buyingPower, raw: usd };
}

export async function readPmPositions() {
  const out = {};
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const res = await pmGet("/v1/portfolio/positions", { auth: true, query: { limit: 100, cursor: cursor || undefined } });
    Object.assign(out, res.positions || {});
    if (res.eof !== false || !res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return out;
}

function netOf(p) {
  return numberOf(p?.netPositionDecimal, p?.netPosition, p?.qtyAvailableDecimal, p?.qtyAvailable) ?? 0;
}

// --- Self-check (real API, nothing executed) ---------------------------------------------

function trimEvent(ev) {
  if (!ev) return null;
  const m = (ev.markets || []).find((x) => /MONEYLINE|DRAWABLE|WINNER/i.test(JSON.stringify([x.sportsMarketType, x.sportsMarketTypeV2])));
  return {
    id: ev.id, slug: ev.slug, title: ev.title, startDate: ev.startDate, live: ev.live, ended: ev.ended,
    teams: (ev.teams || []).map((t) => ({ id: t.id, name: t.name, abbreviation: t.abbreviation, alias: t.alias })),
    winnerMarket: m ? {
      slug: m.slug, title: m.title, question: m.question, sportsMarketType: m.sportsMarketType,
      sportsMarketTypeV2: m.sportsMarketTypeV2, active: m.active, closed: m.closed, line: m.line,
      bestBidQuote: m.bestBidQuote, bestAskQuote: m.bestAskQuote, minimumTradeQty: m.minimumTradeQty,
      marketSides: (m.marketSides || []).map((sd) => ({
        description: sd.description, long: sd.long, teamId: sd.teamId, team: sd.team?.name ?? null, price: sd.price, tradable: sd.tradable,
      })),
    } : null,
    marketTypes: [...new Set((ev.markets || []).map((x) => x.sportsMarketType))],
    // Every winner market (soccer has one per outcome), slimmed.
    winnerMarkets: (ev.markets || []).filter((x) => /MONEYLINE|DRAWABLE|WINNER/i.test(JSON.stringify([x.sportsMarketType, x.sportsMarketTypeV2])))
      .map((x) => ({ slug: x.slug, type: x.sportsMarketType, typeV2: x.sportsMarketTypeV2, title: x.title,
        sides: (x.marketSides || []).map((sd) => `${sd.long ? "YES" : "NO"}=${sd.team?.name ?? sd.description}(${sd.teamId ?? "-"})`) })),
  };
}

function previewBody(slug, intent, priceDollars) {
  return {
    request: {
      marketSlug: slug, type: "ORDER_TYPE_LIMIT", intent,
      price: { value: priceDollars.toFixed(2), currency: "USD" }, quantity: 1,
      tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL", manualOrderIndicator: "MANUAL_ORDER_INDICATOR_AUTOMATIC",
    },
  };
}

export async function runSelfCheck(config = {}) {
  const out = { at: new Date().toISOString(), version: PM_ENGINE_VERSION, steps: [], passed: false };
  const step = (name, ok, detail) => out.steps.push({ name, ok, detail });

  const cred = pmCredentialReport();
  out.credentials = cred;
  if (!pmConfigured()) {
    const seen = cred.variablesSeen.length
      ? ` Found: ${cred.variablesSeen.map((v) => `${v.name} (${v.looksLike})`).join(", ")}.`
      : " No POLYMARKET variables found.";
    step("keys", false, `${cred.keyIdFrom ? "Key ID found" : "Key ID missing"}, ${cred.secretFrom ? "Secret Key found" : "Secret Key missing"}.${seen} Add them in the Polymarket panel, or as Railway variables POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY.`);
    updatePmMeta({ selfCheck: out });
    return out;
  }
  step("keys", true, `Key ID from ${cred.keyIdFrom}, Secret Key from ${cred.secretFrom}`);

  // 1. Signed request: the balance.
  try {
    const acct = await readPmAccount();
    out.balanceOk = true;
    out.balance = { cash: acct.cash, buyingPower: acct.buyingPower };
    step("signed-balance", true, `cash $${acct.cash.toFixed(2)}, buying power $${acct.buyingPower.toFixed(2)}`);
  } catch (err) {
    out.balanceOk = false;
    const hint = err.kind === "auth" ? " - the Key ID or Secret Key is wrong, or the key was revoked"
      : err.kind === "forbidden" ? " - Polymarket refused access (account not approved for API trading yet, or the request came from a blocked location)" : "";
    step("signed-balance", false, `${err.message}${hint}`);
  }

  // 2. Leagues and games.
  const sampleList = [];
  try {
    const leagues = await getLeagues();
    out.leagues = leagues.map((l) => ({ slug: l.slug, name: l.name, abbreviation: l.abbreviation, operational: l.isOperational }));
    out.mapped = {};
    const notListed = [];
    for (const [k, want] of Object.entries(mappedSports())) {
      const have = await leagueSlugsFor(k);
      out.mapped[k] = have.length ? have.join("+") : null;
      if (have.length !== want.length) notListed.push(`${k}(${want.filter((w) => !have.includes(w)).join(",")})`);
    }
    const listed = Object.values(out.mapped).filter(Boolean).length;
    step("leagues", leagues.length > 0 && !notListed.length,
      `${leagues.length} Polymarket leagues; ${listed} of ${Object.keys(out.mapped).length} mapped sports found by exact slug` +
      (notListed.length ? `; MISSING: ${notListed.join(", ")}` : ""));

    let tied = 0, untied = 0;
    const samples = [];
    const sampleSlugs = ["nfl", "mls", "mlb", "wnba", "epl", "nhl", "cfb", "nba"].filter((sl) => Object.values(out.mapped).some((v) => v && v.split("+").includes(sl)));
    for (const slug of sampleSlugs.slice(0, 4)) {
      const events = await getLeagueEvents(slug);
      for (const ev of events.filter((e) => !e.ended && !e.closed).slice(0, 25)) {
        for (const t of (ev.teams || []).slice(0, 2)) {
          const r = winnerSideFor(ev, t.name);
          if (r.ok) {
            tied++;
            // Every YES-side winner market seen is a candidate for the price
            // and NO-preview steps (the NO preview needs a YES bid under 46c,
            // which roughly half of all games have).
            if (r.long && !sampleList.some((s) => s.r.slug === r.slug)) sampleList.push({ ev, r, listBid: dollarsOf(r.market?.bestBidQuote) });
          } else if (r.code !== "pm-no-winner-market") untied++;
        }
      }
      const live = events.find((e) => e.live && !e.ended) || events.find((e) => !e.ended && !e.closed) || events[0];
      if (live) samples.push({ league: slug, events: events.length, first: trimEvent(live) });
    }
    out.sampleEvents = samples;
    out.sideMapping = { tied, untied };
    out.sideMappingOk = tied > 0;
    step("games-and-sides", tied > 0, `${tied} team sides tied to a market side, ${untied} could not be tied${tied ? "" : " - nothing to trade until this is fixed"}`);
  } catch (err) {
    step("games-and-sides", false, err.message);
  }

  // 3. Prices and a preview order (validated by Polymarket, never executed).
  //    The sample is the first listed game whose market is open with a bid.
  let sample = null;
  let px = null;
  for (const cand of sampleList.slice(0, 12)) {
    try {
      const p = await sidePrice(cand.r.slug, true);
      if (p.open && p.bidCents != null) { sample = cand; px = p; break; }
    } catch { /* try the next one */ }
  }
  if (!sample && sampleList.length) step("prices", false, `none of ${sampleList.length} sampled markets is open with a bid right now - retried next check`);
  if (sample && out.balanceOk) {
    try {
      out.sampleBbo = { slug: sample.r.slug, askCents: px.askCents, bidCents: px.bidCents, askSize: px.askSize, state: px.state, raw: px.raw };
      step("prices", px.askCents != null || px.bidCents != null, `${sample.r.slug}: bid ${px.bidCents ?? "-"}c / ask ${px.askCents ?? "-"}c, state ${px.state || "?"}`);

      const bid = (px.bidCents ?? 50) / 100;
      const safeLong = Math.max(0.01, Math.min(0.99, Math.round((bid - 0.05) * 100) / 100));
      const pl = await pmPost("/v1/order/preview", previewBody(sample.r.slug, "ORDER_INTENT_BUY_LONG", safeLong), { auth: true });
      const o = pl.order || pl;
      out.previewLong = { sent: safeLong, side: o.side, price: o.price, state: o.state, raw: o };
      const echo = dollarsOf(o.price);
      out.previewLongOk = !!o && (echo == null || Math.abs(echo - safeLong) < 0.006) && (!o.side || /BUY/.test(o.side));
      step("preview-buy-yes", out.previewLongOk, `sent BUY YES @ $${safeLong.toFixed(2)} -> ${o.side ?? "?"} @ ${echo ?? "?"}, ${o.state ?? "?"}`);

      // NO side, in the DOCUMENTED format: intent BUY_SHORT, price.value = the
      // YES (long) price. A preview never executes, and on top of that the
      // price x is chosen between the YES bid and (1 - YES bid), so it could
      // not trade even if it did, under either reading of the price:
      //   documented: SELL YES at x  -> trades only if YES bid >= x   (it is not)
      //   other:      BUY NO at x    -> trades only if x >= 1 - YES bid (it is not)
      // That needs a market whose YES bid is under 46c. Candidates whose
      // listed bid is already under 46c are checked first, up to 16 of them.
      let noSample = bid < 0.46 && bid > 0.02 ? { slug: sample.r.slug, bid } : null;
      const pool = [...sampleList].sort((a, b) => {
        const ka = a.listBid != null && a.listBid < 0.46 && a.listBid > 0.02 ? 0 : 1;
        const kb = b.listBid != null && b.listBid < 0.46 && b.listBid > 0.02 ? 0 : 1;
        return ka - kb;
      });
      let looked = 0;
      for (const cand of pool) {
        if (noSample || looked >= 16) break;
        if (cand.r.slug === sample.r.slug) continue;
        looked++;
        try {
          const p2 = await sidePrice(cand.r.slug, true);
          if (p2.open && p2.bidCents != null && p2.bidCents < 46 && p2.bidCents > 2) noSample = { slug: cand.r.slug, bid: p2.bidCents / 100 };
        } catch { /* next */ }
      }
      if (noSample) {
        const nb = noSample.bid;
        const x = Math.round((nb + 0.25 * (1 - 2 * nb)) * 100) / 100;   // YES-side price sent
        const ps = await pmPost("/v1/order/preview", previewBody(noSample.slug, "ORDER_INTENT_BUY_SHORT", x), { auth: true });
        const so = ps.order || ps;
        const e = dollarsOf(so.price);
        const intent = String(so.intent || "");
        const side = String(so.side || "");
        const rejected = /REJECT/.test(String(so.state || ""));
        // Accepted as a NO buy: Polymarket echoes intent BUY_SHORT, or the
        // equivalent YES-terms side (SELL), and does not reject it.
        const isShort = intent === "ORDER_INTENT_BUY_SHORT" || (!intent && /SELL/.test(side));
        const priceOk = e != null && (Math.abs(e - x) < 0.006 || Math.abs(e - (1 - x)) < 0.006);
        const confirmed = !rejected && isShort && priceOk;
        out.previewShort = {
          market: noSample.slug, yesBid: nb, sentLongPrice: x, meansNoAtMost: Math.round((1 - x) * 100) / 100,
          side: so.side, intent: so.intent, price: so.price, state: so.state,
        };
        out.shortConvention = confirmed ? DOCUMENTED_SHORT_FORMAT : "not-accepted";
        if (confirmed) out.shortConfirmedAt = out.at;
        step("preview-buy-no", confirmed,
          `sent BUY_SHORT @ YES price $${x.toFixed(2)} (= NO at most $${(1 - x).toFixed(2)}, the documented format) -> ` +
          `${so.intent ?? so.side ?? "?"} @ ${e ?? "?"}, ${so.state ?? "?"}: ` +
          (confirmed ? "accepted - NO side on" : "not accepted as a NO buy - NO side stays off (YES-side bets unaffected)"));
      } else {
        // No market cheap enough for a safe preview right now. A confirmation
        // already on record stands (Polymarket accepted the documented format
        // once; the format does not change) - only a REJECTED preview turns
        // the NO side off.
        const prev = pmMeta().selfCheck;
        if (shortConfirmed(prev)) {
          out.shortConvention = DOCUMENTED_SHORT_FORMAT;
          out.previewShort = prev.previewShort ?? null;
          out.shortConfirmedAt = prev.shortConfirmedAt ?? prev.at;
          step("preview-buy-no", true, `no market under 46c for a new preview right now - Polymarket's acceptance from ${out.shortConfirmedAt} stands, NO side stays on`);
        } else {
          out.shortConvention = "no-sample";
          step("preview-buy-no", false, `none of ${Math.min(16, pool.length)} sampled markets has a YES bid under 46c for a safe NO preview - retried in 10 minutes`);
        }
      }
    } catch (err) {
      out.previewLongOk = out.previewLongOk ?? false;
      step("preview", false, err.message);
    }
  }

  // The preview steps could not run this time (no open sample, or an error
  // before them): a NO-side confirmation already on record stands.
  if (out.shortConvention == null) {
    const prev = pmMeta().selfCheck;
    if (shortConfirmed(prev)) {
      out.shortConvention = DOCUMENTED_SHORT_FORMAT;
      out.previewShort = prev.previewShort ?? null;
      out.shortConfirmedAt = prev.shortConfirmedAt ?? prev.at;
    }
  }

  out.passed = !!(out.balanceOk && out.sideMappingOk && out.previewLongOk);
  updatePmMeta({ selfCheck: out });
  appendLog(`Polymarket self-check ${out.passed ? "PASSED" : "not passed"}: ${out.steps.map((s) => `${s.name} ${s.ok ? "ok" : "FAIL"}`).join(", ")}.`, out.passed ? "info" : "warn");
  return out;
}

// --- Settlement ----------------------------------------------------------------------

export async function reconcilePolymarket() {
  const list = pmPositions();
  if (!list.length) return { settled: 0 };
  let held;
  try { held = await readPmPositions(); } catch (err) {
    return { settled: 0, error: err.message };
  }

  const keep = [];
  let settled = 0;
  for (const p of list) {
    try {
      const h = held[p.slug];
      const net = h ? netOf(h) : 0;
      if (h && net !== 0 && !h.expired) { keep.push({ ...p, cashValue: dollarsOf(h.cashValue), missingSince: undefined }); continue; }

      let yes = null;
      try {
        const s = await pmGet(`/v1/markets/${encodeURIComponent(p.slug)}/settlement`);
        const v = numberOf(s.settlement, s.settlementPrice, s.marketData?.settlement, s.settlement?.value);
        if (v != null) yes = v <= 1 ? v * 100 : v;
      } catch (err) {
        if (err.status !== 404) { keep.push(p); continue; }
      }

      if (yes == null) {
        const first = p.missingSince ? Date.parse(p.missingSince) : Date.now();
        if (h?.expired || Date.now() - first < MISSING_GRACE_MS) { keep.push({ ...p, missingSince: new Date(first).toISOString() }); continue; }
        recordTrade({
          action: "exit", ticker: p.ticker, side: p.long ? "yes" : "no", contracts: p.contracts,
          priceCents: p.entryPriceCents, exitPriceCents: null, filled: p.contracts, reason: "closed-externally",
          environment: "production", teamName: p.teamName, sportKey: p.sportKey, commenceTime: p.commenceTime, feeCents: 0,
        });
        appendLog(`Polymarket ${p.slug}: no longer held and not settled - closed outside the bot. Check the Polymarket app for the exit price.`, "warn");
        settled++;
        continue;
      }

      const ours = Math.round((p.long ? yes : 100 - yes) * 10) / 10;
      const reason = ours >= 99.5 ? "settled-win" : ours <= 0.5 ? "settled-loss" : "settled-push";
      recordTrade({
        action: "exit", ticker: p.ticker, side: p.long ? "yes" : "no", contracts: p.contracts,
        priceCents: p.entryPriceCents, exitPriceCents: ours, filled: p.contracts, reason,
        environment: "production", teamName: p.teamName, sportKey: p.sportKey, commenceTime: p.commenceTime, feeCents: 0,
      });
      const pnl = ((ours - p.entryPriceCents) * p.contracts - (p.entryFeeCents || 0)) / 100;
      appendLog(`Polymarket ${p.teamName} settled ${reason === "settled-win" ? "WON" : reason === "settled-loss" ? "LOST" : `at ${ours}c`}: ${p.contracts} @ ${p.entryPriceCents}c, net ${pnl < 0 ? "-" : "+"}$${Math.abs(pnl).toFixed(2)}.`);
      settled++;
    } catch (err) {
      appendLog(`Polymarket ${p.slug}: settlement check failed (${err.message}) - retrying next cycle.`, "warn");
      keep.push(p);
    }
  }
  if (settled || keep.length !== list.length || keep.some((k, i) => k !== list[i])) savePmPositions(keep);
  return { settled };
}

// --- Orders ---------------------------------------------------------------------------

function fillFrom(res) {
  const execs = Array.isArray(res?.executions) ? res.executions : [];
  let shares = 0, notional = 0, commission = 0, rejected = null;
  for (const e of execs) {
    const type = String(e.type || "");
    if (/REJECTED/.test(type)) rejected = e.orderRejectReason || e.text || "rejected";
    const n = numberOf(e.lastShares) ?? 0;
    const px = dollarsOf(e.lastPx);
    if (n > 0 && px != null && /FILL|TRADE/.test(type)) { shares += n; notional += n * px; }
    commission += dollarsOf(e.commissionNotionalCollected) ?? 0;
  }
  return { known: execs.length > 0, shares, avgPx: shares ? notional / shares : null, commission, rejected };
}

function fillFromOrder(o) {
  const shares = numberOf(o?.cumQuantity) ?? 0;
  return {
    known: !!o, shares, avgPx: dollarsOf(o?.avgPx), commission: dollarsOf(o?.commissionNotionalTotalCollected) ?? 0,
    rejected: /REJECTED/.test(String(o?.state || "")) ? "rejected" : null,
  };
}

async function placeEntry({ c, limitCents, contracts, convention, seenAskCents }) {
  if (!c.side.long && convention !== DOCUMENTED_SHORT_FORMAT) throw new Error("NO-side order format not confirmed by the self-check");
  // price.value is ALWAYS the YES side's price (Polymarket docs). Backing the
  // NO team at up to L cents is BUY_SHORT at a YES price of (100 - L): it only
  // trades against YES bids at or above that, i.e. NO at or under L.
  const priceDollars = longSidePriceCents(c.side.long, limitCents) / 100;
  const body = {
    marketSlug: c.side.slug,
    type: "ORDER_TYPE_LIMIT",
    intent: c.side.long ? "ORDER_INTENT_BUY_LONG" : "ORDER_INTENT_BUY_SHORT",
    price: { value: priceDollars.toFixed(2), currency: "USD" },
    quantity: contracts,
    tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
    manualOrderIndicator: "MANUAL_ORDER_INDICATOR_AUTOMATIC",
    synchronousExecution: true,
    maxBlockTime: "5",
  };
  const res = await pmPost("/v1/orders", body, { auth: true });
  let fill = fillFrom(res);
  if ((!fill.known || (fill.shares === 0 && !fill.rejected)) && res.id) {
    await new Promise((r) => setTimeout(r, 800));
    try {
      const o = await pmGet(`/v1/order/${encodeURIComponent(res.id)}`, { auth: true });
      const f2 = fillFromOrder(o.order || o);
      if (f2.known) fill = f2;
    } catch { /* keep what the create response said */ }
  }
  // A NO fill's price: Polymarket quotes every price on the YES side, so the
  // NO cost is 100 - reported. If the reported number itself is the only
  // reading at or under our NO limit, that one is used; if both readings fit,
  // the one nearest the NO ask we saw a moment ago wins (ties: YES-side, as
  // documented). Getting this right keeps the ledger's P&L exact.
  let fillCents = fill.avgPx != null ? fill.avgPx * 100 : null;
  if (!c.side.long && fillCents != null) {
    const asYesSide = 100 - fillCents;
    const asNoSide = fillCents;
    const fits = (v) => v > 0 && v <= Math.floor(limitCents) + 0.5;
    if (fits(asYesSide) && fits(asNoSide) && Number.isFinite(seenAskCents)) {
      fillCents = Math.abs(asNoSide - seenAskCents) < Math.abs(asYesSide - seenAskCents) ? asNoSide : asYesSide;
    } else if (fits(asNoSide) && !fits(asYesSide)) {
      fillCents = asNoSide;
    } else {
      fillCents = asYesSide;
    }
  }
  return { orderId: res.id ?? null, filled: fill.shares, fillCents: fillCents != null ? Math.round(fillCents * 10) / 10 : null, feeCents: Math.round(fill.commission * 100), rejected: fill.rejected };
}

// --- The scan ----------------------------------------------------------------------------

/*
 * EVERY ODDS-FEED SPORT POLYMARKET LISTS (2026-09-28, evening).
 *
 * Polymarket used to price only the sports the Kalshi scan had just read, so
 * a sport Kalshi does not list (Austrian Bundesliga, Chile, League Two,
 * Greece, Ireland, Superettan, Veikkausliiga...) was never looked at on
 * Polymarket even when Polymarket listed its games.
 *
 * Now the engine takes every sport the odds feed reports ACTIVE, keeps those
 * with a Polymarket league, and:
 *   - reuses the Kalshi scan's lines when they are under 2 minutes old
 *     (no second odds call), otherwise
 *   - fetches the lines itself: every 60 seconds while that sport has a game
 *     in play, every 10 minutes when it only has upcoming games, every 30
 *     minutes when it has nothing from 12h back to 24h ahead. Each fetch is
 *     one odds call (2 credits): 12 credits an hour for an idle league, 4 for
 *     an empty one, 120 while a game is live.
 * Upcoming lines are recorded as pre-game priors, so live games in these
 * sports get the same in-game check as everything else.
 *
 * LIVE SCHEDULE (2026-09-28, liveSchedule.js). When the schedule is built,
 * it decides instead: a sport with a game LIVE is read every 20 seconds (every
 * cycle); a sport with a game starting within 30 minutes is read every 5
 * minutes, so the last pre-game line is on record at kickoff; any other sport
 * is not read at all (0 credits). Without a schedule, the rules above apply.
 */
const pmLineCache = new Map();          // sportKey -> { at, entry, hasLive }
let activeCache = { at: 0, keys: [] };
const SCHEDULE_LIVE_REFRESH_MS = 20 * 1000;
const SCHEDULE_SOON_REFRESH_MS = 5 * 60 * 1000;
const LIVE_REFRESH_MS = 60 * 1000;
const IDLE_REFRESH_MS = 10 * 60 * 1000;
const EMPTY_REFRESH_MS = 30 * 60 * 1000;
const WINDOW_BACK_MS = 12 * 60 * 60 * 1000;   // same rolling window as the Kalshi scan
const WINDOW_AHEAD_MS = 24 * 60 * 60 * 1000;

async function activeOddsSports() {
  if (Date.now() - activeCache.at < 10 * 60 * 1000 && activeCache.keys.length) return activeCache.keys;
  const keys = await allActiveSportKeys();
  if (keys.length) activeCache = { at: Date.now(), keys };
  return keys.length ? keys : activeCache.keys;
}

async function linesForCycle(config) {
  const out = new Map();
  for (const [sportKey, entry] of getRecentLines(LINE_MAX_AGE_MS)) out.set(sportKey, entry);

  const off = new Set(Array.isArray(config.disabledSports) ? config.disabledSports : []);
  let active = [];
  try { active = await activeOddsSports(); } catch { active = []; }
  const now = Date.now();
  let priorsSeen = false;
  const plan = schedulePlan(now);
  // Kalshi's "parked" flag is NOT used here: Kalshi parks a sport when KALSHI's
  // board is empty, and Polymarket can still list those games. Polymarket goes
  // by the live schedule, or - without one - by its own read of the odds feed
  // (a sport whose last read had no game from 12h back to 24h ahead is
  // re-read every 30 minutes, not skipped).
  for (const sportKey of active) {
    if (out.has(sportKey) || off.has(sportKey)) continue;
    if (!shouldScanSport(sportKey, plan)) continue;          // nothing live or within 30 minutes
    let slugs = [];
    try { slugs = await leagueSlugsFor(sportKey); } catch { continue; }
    if (!slugs.length) continue;
    const cached = pmLineCache.get(sportKey);
    const every = plan.ready
      ? (plan.live.has(sportKey) || plan.failed.includes(sportKey) || !plan.known.has(sportKey) ? SCHEDULE_LIVE_REFRESH_MS : SCHEDULE_SOON_REFRESH_MS)
      : cached?.hasLive ? LIVE_REFRESH_MS : cached?.hasGames === false ? EMPTY_REFRESH_MS : IDLE_REFRESH_MS;
    if (cached && now - cached.at < every) { out.set(sportKey, cached.entry); continue; }
    try {
      const tournamentId = (config.oddsPapiTournamentIds || {})[sportKey];
      const r = await getSharpProbabilities(sportKey, { oddsPapiTournamentId: tournamentId, providerOrder: config.oddsProviderOrder });
      const probabilities = r.probabilities || {};
      let hasLive = false;
      let hasGames = false;
      for (const [teamName, info] of Object.entries(probabilities)) {
        const start = Date.parse(info.commenceTime);
        if (!Number.isFinite(start)) continue;
        if (start >= now - WINDOW_BACK_MS && start <= now + WINDOW_AHEAD_MS) hasGames = true;
        if (start <= now) hasLive = true;
        else { rememberPregame({ sportKey, teamName, commenceTime: info.commenceTime, probability: info.trueProbability }); priorsSeen = true; }
      }
      const entry = { at: now, probabilities, provider: r.provider, source: "polymarket" };
      pmLineCache.set(sportKey, { at: now, entry, hasLive, hasGames });
      out.set(sportKey, entry);
    } catch { /* this sport sits out one cycle */ }
  }
  if (priorsSeen) flushPregamePriors();
  return out;
}

/**
 * COVERAGE, sport by sport: for every sport the odds feed reports active,
 * whether Kalshi lists it, whether Polymarket does, and - from the live
 * schedule - whether it is being scanned right now (a game live or starting
 * within 30 minutes) or when its next game starts.
 * Rebuilt at most every 10 minutes; shown on the dashboard and the monitor.
 */
export async function buildCoverage(config) {
  const active = await activeOddsSports();
  let health = {};
  try { health = loadState().sportHealth || {}; } catch { health = {}; }
  const series = getSeriesMap() || {};
  const off = new Set(Array.isArray(config.disabledSports) ? config.disabledSports : []);
  const now = Date.now();
  const plan = schedulePlan(now);
  const when = (sportKey) => {
    if (!plan.ready) return null;
    const liveN = plan.live.get(sportKey)?.length || 0;
    if (liveN) return `${liveN} live - scanning`;
    if (plan.soon.has(sportKey)) return "starting within 30 min - scanning";
    if (plan.failed.includes(sportKey) || !plan.known.has(sportKey)) return "scanning (no calendar for it)";
    return "no game live - waits for the schedule";
  };
  const rows = [];
  for (const sportKey of active) {
    const slugs = await leagueSlugsFor(sportKey).catch(() => []);
    const h = health[sportKey];
    const w = when(sportKey);
    rows.push({
      sportKey,
      kalshi: off.has(sportKey) ? "switched off" : !series[sportKey] ? "not listed on Kalshi"
        : w ? `${series[sportKey]}: ${w}`
        : h && h.parkedUntil > now ? `parked (no games) until ${new Date(h.parkedUntil).toISOString().slice(11, 16)}Z` : `scanning (${series[sportKey]})`,
      polymarket: off.has(sportKey) ? "switched off" : !slugs.length ? "not listed on Polymarket"
        : w ? `${slugs.join("+")}: ${w}` : `scanning (${slugs.join("+")})`,
    });
  }
  rows.sort((a, b) => a.sportKey.localeCompare(b.sportKey));
  const count = (f) => rows.filter(f).length;
  // "Covered" = the exchange lists the sport and it is not switched off: it is
  // scanned whenever the schedule has one of its games live or about to start.
  const covered = (v) => !/^(not listed|switched off)/.test(v);
  return {
    at: new Date().toISOString(),
    activeSports: rows.length,
    kalshiScanning: count((r) => covered(r.kalshi)),
    polymarketScanning: count((r) => covered(r.polymarket)),
    either: count((r) => covered(r.kalshi) || covered(r.polymarket)),
    liveNowSports: plan.ready ? plan.live.size : null,
    schedule: plan.ready ? "live schedule" : `no schedule (${plan.reason})`,
    rows,
  };
}

export async function scanPolymarket(config, settings, active) {
  const tally = {};
  const samples = {};
  const bump = (code, example = null) => {
    tally[code] = (tally[code] || 0) + 1;
    if (example && !samples[code]) samples[code] = String(example).slice(0, 240);
  };
  let seen = 0, entered = 0;
  const meta = pmMeta();
  // SCANNER TAB (scanFeed.js): the latest verdict per team, in plain words.
  const feed = (row) => noteDecision("polymarket", { verdict: "skipped", ...row });
  noteScan("polymarket");

  let account = null;
  try { account = await readPmAccount(); } catch (err) { bump("pm-balance-failed", err.message); }
  const openPm = pmPositions();
  const equity = (account?.cash ?? 0) + openPm.reduce((t, p) => t + (p.cashValue ?? (p.contracts * p.entryPriceCents) / 100), 0);

  // Own daily loss limit, same percentage as Kalshi's.
  const today = new Date().toDateString();
  if (account && meta.dayStartDate !== today) updatePmMeta({ dayStartDate: today, dayStartEquity: equity, haltedForDay: false });
  const dayStart = meta.dayStartDate === today ? Number(meta.dayStartEquity) : equity;
  const haltPct = Number(config.dailyLossHaltPct ?? 0.15);
  if (account && dayStart > 0 && equity < dayStart * (1 - haltPct)) {
    if (!pmMeta().haltedForDay) {
      updatePmMeta({ haltedForDay: true });
      appendLog(`Polymarket paused for today: equity $${equity.toFixed(2)} is down more than ${(haltPct * 100).toFixed(0)}% from $${dayStart.toFixed(2)}.`, "warn");
    }
    bump("pm-halted-for-day");
  }
  const halted = pmMeta().haltedForDay === true;
  const paused = meta.pausedUntil && Date.parse(meta.pausedUntil) > Date.now();
  if (paused) bump("pm-paused-after-failures", `until ${meta.pausedUntil}`);

  const stakeDecision = tieredStake(config, equity);
  const brake = streakStakeFactor(config);
  const stake = Number(stakeDecision.stake) * brake.factor;
  // OPEN-TRADE CAP BY BALANCE (2026-09-28): the same rule as Kalshi, read from
  // the POLYMARKET account - stakes that fit in 75% of its equity, 5 to 10.
  const openCap = openTradeCap({ equity, stake: Number(stakeDecision.stake) || Number(config.flatStakeDollars) || 5 });
  const shortOn = shortSideActive(settings, meta);
  const convention = meta.selfCheck?.shortConvention;
  let resting = [];
  try { resting = Object.values(getRestingOrders()); } catch { resting = []; }

  const lines = await linesForCycle(config);
  if (!meta.coverage?.at || Date.now() - Date.parse(meta.coverage.at) > 10 * 60 * 1000) {
    try { updatePmMeta({ coverage: await buildCoverage(config) }); } catch { /* shown next time */ }
  }
  for (const [sportKey, entry] of lines) {
    let slugs = [];
    try { slugs = await leagueSlugsFor(sportKey); } catch (err) { bump("pm-leagues-failed", err.message); break; }
    if (!slugs.length) { bump("pm-league-not-listed", sportKey); continue; }
    const slug = slugs.join("+");

    // Group the odds feed's teams into games.
    const games = new Map();
    for (const [name, info] of Object.entries(entry.probabilities || {})) {
      const key = info.eventId || `${info.commenceTime}`;
      if (!games.has(key)) games.set(key, []);
      games.get(key).push({ name, info });
    }

    let events = null;
    let scores = null;
    for (const teams of games.values()) {
      const commenceTime = teams[0].info.commenceTime;
      const teamNames = teams.map((t) => t.name).filter((n) => !isDraw(n));
      if (teamNames.length !== 2) continue;
      const timing = entryTiming(commenceTime, { entryWindowHours: config.entryWindowHours ?? 0, minMinutesBeforeStart: config.minMinutesBeforeStart ?? 0 });
      if (!timing.live && config.liveOnly !== false) { bump("pm-pregame"); continue; }
      if (!timing.live && !timing.ok) { bump("pm-window"); continue; }
      seen += 2;

      // SAME TRADES ON BOTH: a game Kalshi holds is still priced here, but only
      // on the team Kalshi holds. One bet per game on Polymarket itself.
      if (heldOnPolymarket({ sportKey, commenceTime, teamNames })) {
        bump("pm-already-held", teamNames.join(" vs "));
        for (const n of teamNames) feed({ sportKey, team: n, opponent: teamNames.find((x) => x !== n), commenceTime, code: "pm-already-held", why: "Already holding this game on Polymarket (one bet per game)" });
        continue;
      }
      const kalshiTeam = kalshiTeamOnGame({ sportKey, commenceTime, teamNames, restingOrders: resting });

      try { events ??= await getSportEvents(sportKey); } catch (err) { bump("pm-events-failed", err.message); break; }
      const ev = matchEvent(events, teamNames, commenceTime);
      if (!ev || ev.ambiguous) {
        const code = ev?.ambiguous ? "pm-game-ambiguous" : "pm-game-not-listed";
        bump(code, `${teamNames.join(" vs ")} (${slug})`);
        const why = ev?.ambiguous
          ? `This game matched ${ev.ambiguous} Polymarket events in ${slug} - skipped rather than guessed`
          : `No Polymarket game in ${slug} has both these teams starting within 12 hours of this time (finished, not listed yet, or not offered)`;
        for (const n of teamNames) feed({ sportKey, team: n, opponent: teamNames.find((x) => x !== n), commenceTime, code, why });
        continue;
      }

      for (const t of teams) {
        if (isDraw(t.name)) continue;
        const opp = teamNames.find((n) => normName(n) !== normName(t.name)) ?? null;
        // What the feed shows for this team so far: filled in as the checks go.
        const at = { market: null, priceCents: null, fairPct: t.info.trueProbability * 100 };
        const skip = (code, why, verdict = "skipped") => {
          bump(code, why);
          feed({ sportKey, team: t.name, opponent: opp, commenceTime, verdict, code, why, ...at });
        };
        if (kalshiTeam && normName(t.name) !== kalshiTeam) {
          skip("pm-opposite-of-kalshi", `Kalshi holds ${kalshiTeam} in this game - only the same team is bought on Polymarket`);
          continue;
        }
        const side = winnerSideFor(ev, t.name);
        if (!side.ok) { skip(side.code, side.reason); continue; }
        at.market = side.slug;
        if (!side.long && !shortOn) { skip("pm-no-side-not-confirmed", `${t.name}: needs the NO side, which turns on once Polymarket accepts the self-check's NO preview in the documented format`); continue; }
        const opponent = teamNames.find((n) => normName(n) !== normName(t.name)) ?? null;
        // The line's age NOW: its age when it was read, plus the time since (a
        // line reused from this cycle's Kalshi scan can be up to 2 minutes old).
        const readAgo = Number.isFinite(Number(entry.at)) ? Math.max(0, (Date.now() - Number(entry.at)) / 1000) : 0;
        const lineAgeNow = t.info.lineAgeSeconds != null && Number.isFinite(Number(t.info.lineAgeSeconds)) ? Number(t.info.lineAgeSeconds) + readAgo : null;
        const c = { sportKey, teamName: t.name, opponent, commenceTime, timing, prob: t.info.trueProbability, lineAgeSeconds: lineAgeNow, ev, side };

        // Price.
        let px;
        try { px = await sidePrice(side.slug, side.long); } catch (err) { skip("pm-price-failed", `${side.slug}: ${err.message}`); continue; }
        if (!px.open) { skip("pm-market-not-open", `Market not open for trading (${px.state})`); continue; }
        if (px.askCents == null || px.askCents <= 0 || px.askCents >= 100) { skip("pm-no-price", "No one is selling this side right now (no ask in the book)"); continue; }
        const askCents = Math.ceil(px.askCents - 1e-9);
        at.priceCents = askCents;
        const maxSpread = config.maxSpreadCents ?? 25;
        if (maxSpread && px.spreadCents != null && px.spreadCents > maxSpread) { skip("pm-spread-too-wide", `Bid-ask spread ${px.spreadCents}c is over the ${maxSpread}c limit`); continue; }

        // In-game model, exactly as the Kalshi scan does it.
        if (timing.live) {
          if (!paramsFor(sportKey)) { skip("pm-no-model", "No in-game model for this sport, so a stale line can't be detected"); continue; }
          try { scores ??= (await getLiveScores(sportKey)).events || []; } catch { scores = []; }
          const game = findLiveGameForTeam(scores, t.name);
          if (!game) {
            // NO SCORE FEED (2026-09-29): the odds feed has no live scores for
            // KBO, NPB, Liiga, cricket, MMA or boxing. The score check exists to
            // catch a STALE line; a line the sharp book repriced within the last
            // two minutes is not stale, so the game trades on it at the sharp
            // price. Same rule as the Kalshi scanner.
            const fresh = freshLineOk(c.lineAgeSeconds, config);
            if (!fresh.ok) {
              skip("pm-no-live-score", `In play with no live score, and the sharp line is ${fresh.age == null ? "of unknown age" : `${fresh.age}s old`} - trading without a score needs a line updated within ${fresh.max}s`);
              continue;
            }
            c.liveContext = `no live score feed for this game - sharp line updated ${fresh.age}s ago`;
          } else {
            const frac = fractionRemaining(sportKey, commenceTime);
            const corr = corroboratedProbability({
              sportKey, sharpProbability: c.prob, lead: game.lead, fracRemaining: frac,
              pregameProbability: pregamePrior({ sportKey, teamName: t.name, commenceTime }),
            });
            if (!corr.usable) { skip("pm-unmodellable", "In play, but the game state could not be modelled"); continue; }
            if (corr.disagreementPoints > (config.maxModelDisagreementPoints ?? 12)) {
              skip("pm-model-disagrees", `Betting line ${(c.prob * 100).toFixed(0)}% vs in-game model ${(corr.modelProbability * 100).toFixed(0)}% (${game.homeScore}-${game.awayScore}, ${(frac * 100).toFixed(0)}% left) - over ${config.maxModelDisagreementPoints ?? 12} points apart, line treated as stale`);
              continue;
            }
            c.prob = corr.probability;
            at.fairPct = c.prob * 100;
            c.liveContext = `${game.homeTeam} ${game.homeScore}-${game.awayScore} ${game.awayTeam}, ${(frac * 100).toFixed(0)}% left, model ${(corr.modelProbability * 100).toFixed(0)}%`;
          }
        }

        const learned = learnedBlock({ sportKey, priceCents: askCents }, config);
        if (learned.blocked) { skip("pm-learned-block", learned.reason); continue; }

        const bankroll = account?.buyingPower ?? 0;
        const assessment = assessOpportunity({
          bankroll, trueProbability: c.prob, price: askCents / 100, restingContracts: px.askSize,
          multiplier: PM_FEE, kellyFraction: config.kellyFraction, minLiquidity: config.minLiquidity ?? 0,
          maxRiskPctPerTrade: config.maxRiskPctPerTrade ?? 0.20, maxStakeDollars: null,
          maxPlausibleEdge: config.maxPlausibleEdge ?? 0.18,
          minEntryPriceCents: timing.live
            ? Math.max(config.minEntryPriceCents ?? 25, config.liveBandMinCents ?? config.minLiveEntryPriceCents ?? 20)
            : (config.minEntryPriceCents ?? 25),
          maxEntryPriceCents: timing.live
            ? Math.min(config.maxEntryPriceCents ?? 88, config.liveBandMaxCents ?? config.maxLiveEntryPriceCents ?? 80)
            : (config.maxEntryPriceCents ?? 88),
          minEvCentsPerContract: config.minEvCentsPerContract ?? 0,
          minEvCentsPerTrade: config.minEvCentsPerTrade ?? 1,
          maxWalkupCents: config.maxWalkupCents ?? 4,
          isLiveGame: timing.live, allowLiveGames: config.allowLiveGames !== false,
          lineAgeSeconds: c.lineAgeSeconds,
          maxLineAgeSecondsLive: config.maxLineAgeSecondsLive ?? 900,
          maxLineAgeSecondsPregame: config.maxLineAgeSecondsPregame ?? 7200,
          survivalMode: { ...(config.survivalMode || {}), balanceThreshold: Infinity, flatBetDollars: stake },
        });
        if (assessment.action === "skip") { skip(`pm-${assessment.code || "skip"}`, `${askCents}c vs fair ${(c.prob * 100).toFixed(1)}%: ${assessment.reason}`); continue; }

        // Same minimum expected return as Kalshi, with Polymarket's fee.
        const minReturnPct = Number(config.minExpectedReturnPct ?? 10);
        const countAt = (p) => flatBetContracts(stake, p, PM_FEE);
        const returnAt = (p) => {
          const ev = c.prob * 100 - p - feePerContractCents(p, countAt(p), PM_FEE);
          return { ev, pct: (ev / p) * 100 };
        };
        let limit = null;
        for (let p = assessment.limitCents; p >= askCents; p--) if (returnAt(p).pct >= minReturnPct) { limit = p; break; }
        if (limit == null) {
          const r = returnAt(askCents);
          skip("pm-return-too-small", `${askCents}c vs fair ${(c.prob * 100).toFixed(1)}%: ${r.pct.toFixed(1)}% expected return, under the ${minReturnPct}% minimum`);
          continue;
        }
        let contracts = countAt(limit);
        const perContract = (limit + feePerContractCents(limit, contracts, PM_FEE)) / 100;
        if (contracts * perContract > bankroll) contracts = Math.floor(bankroll / perContract);
        const minQty = numberOf(side.market?.minimumTradeQty) ?? 1;
        if (contracts < Math.max(1, minQty)) { skip("pm-size-zero", `Not enough buying power ($${bankroll.toFixed(2)}) for one contract`); continue; }
        const r = returnAt(limit);
        const dollarsIn = contracts * perContract;
        const reason =
          `Polymarket: ${timing.live ? "In-play" : "Pre-game"} edge on "${t.name}"${kalshiTeam ? " (same trade as Kalshi)" : ""} ` +
          `(sharp ${(c.prob * 100).toFixed(1)}% vs $${(askCents / 100).toFixed(2)} ask, limit $${(limit / 100).toFixed(2)}, ` +
          `${contracts} contracts, $${dollarsIn.toFixed(2)} in, expected +$${((r.ev * contracts) / 100).toFixed(2)} (${r.pct.toFixed(1)}%))` +
          (c.liveContext ? ` | ${c.liveContext}` : "");

        if (!active) { skip("pm-would-trade", `Would buy, but Polymarket trading is not active: ${reason}`); continue; }
        if (halted) { skip("pm-halted", "Polymarket paused for today by the daily loss limit"); continue; }
        if (paused) { feed({ sportKey, team: t.name, opponent: opp, commenceTime, code: "pm-paused-after-failures", why: `Paused after 3 failed orders, until ${meta.pausedUntil}`, ...at }); continue; }
        // OPEN-TRADE CAP BY BALANCE (2026-09-28, account holder's rule): 5 to 10
        // open bets depending on the Polymarket balance - see openCap above.
        // One bet per game across both exchanges still applies.
        const openNow = pmPositions().length;
        if (openNow >= openCap) {
          skip("pm-at-cap", `${openNow} open of ${openCap} allowed at $${equity.toFixed(2)} equity - waiting for a game to settle`);
          continue;
        }

        let result;
        try {
          appendLog(`Polymarket order: BUY ${side.long ? "YES" : "NO"} ${contracts}x ${side.slug} (${t.name}) at up to $${(limit / 100).toFixed(2)} - ${reason}`);
          result = await placeEntry({ c, limitCents: limit, contracts, convention, seenAskCents: px.askCents });
        } catch (err) {
          skip("pm-order-error", `Order failed: ${err.message}`, "tried");
          const fails = (pmMeta().consecutiveOrderFailures || 0) + 1;
          const patch = { consecutiveOrderFailures: fails };
          if (fails >= 3) {
            patch.pausedUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
            patch.consecutiveOrderFailures = 0;
            appendLog(`Polymarket paused 30 minutes after 3 failed orders in a row. Last: ${err.message}`, "error");
          } else {
            appendLog(`Polymarket order failed (${fails}/3): ${err.message}`, "warn");
          }
          updatePmMeta(patch);
          continue;
        }
        updatePmMeta({ consecutiveOrderFailures: 0 });
        if (result.rejected) { skip("pm-order-rejected", `Polymarket rejected the order: ${result.rejected}`, "tried"); continue; }
        if (!(result.filled > 0) || result.fillCents == null) { skip("pm-no-fill", `Order sent, nothing filled at or under $${(limit / 100).toFixed(2)} before it expired`, "tried"); continue; }

        const filled = Math.floor(result.filled);
        const ticker = `PM:${side.slug}:${side.long ? "YES" : "NO"}`;
        const entryFeeCents = Number.isFinite(result.feeCents) && result.feeCents > 0
          ? result.feeCents
          : Math.round(feePerContractCents(result.fillCents, filled, PM_FEE) * filled);
        const list = pmPositions();
        list.push({
          ticker, slug: side.slug, long: side.long, teamName: t.name, opponent, sportKey, commenceTime,
          contracts: filled, entryPriceCents: result.fillCents, entryFeeCents, openedAt: new Date().toISOString(),
          orderId: result.orderId, eventSlug: ev.slug ?? null,
        });
        savePmPositions(list);
        recordTrade({
          action: "enter", ticker, side: side.long ? "yes" : "no", contracts, priceCents: result.fillCents, filled,
          reason, edgePct: assessment.edgeCheck?.observedEdge != null ? assessment.edgeCheck.observedEdge * 100 : null,
          environment: "production", teamName: t.name, sportKey, commenceTime, feeCents: entryFeeCents,
        });
        appendLog(`Polymarket filled ${filled}x ${t.name} @ ${result.fillCents}c (fee ${(entryFeeCents / 100).toFixed(2)}).`);
        feed({ sportKey, team: t.name, opponent: opp, commenceTime, verdict: "bought", code: "bought", market: side.slug, priceCents: result.fillCents, fairPct: c.prob * 100,
          why: `Bought ${filled} contract(s) at ${result.fillCents}c against a fair value of ${(c.prob * 100).toFixed(1)}%${kalshiTeam ? " - same trade as Kalshi" : ""}${c.liveContext ? ` | ${c.liveContext}` : ""}` });
        try {
          const { botToken, chatId } = getTelegramCredentials();
          notifyEntry({ botToken, chatId, ticker, side: side.long ? "yes" : "no", contracts: filled, priceCents: result.fillCents, reason, environment: "production" }).catch(() => {});
        } catch { /* notifications never block trading */ }
        entered++;
        break;   // one side per game
      }
    }
  }

  const lastScan = { at: new Date().toISOString(), active, seen, entered, reasons: tally, samples, stake: stakeDecision.stake * brake.factor, equity: Math.round(equity * 100) / 100, openCap, open: pmPositions().length };
  updatePmMeta({ lastScan, lastAccount: account ? { cash: account.cash, buyingPower: account.buyingPower, equity: lastScan.equity, at: lastScan.at } : pmMeta().lastAccount });
  // Logged when something changed, a trade went in, or every 10 minutes -
  // not every 20-second cycle, which would push useful lines out of the log.
  if (Object.keys(tally).length) {
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} x${n}`).join(", ");
    const line = `Polymarket: ${active ? "trading" : "watching (not trading yet)"}, entered ${entered}. ${top}.`;
    const prev = pmMeta();
    const stale = !prev.lastLogAt || Date.now() - Date.parse(prev.lastLogAt) > 10 * 60 * 1000;
    const shape = `${active}|${Object.keys(tally).sort().join(",")}`;
    if (entered > 0 || stale || prev.lastLogShape !== shape) {
      appendLog(line);
      updatePmMeta({ lastLogAt: new Date().toISOString(), lastLogShape: shape });
    }
  }
  return lastScan;
}

// --- The cycle ------------------------------------------------------------------------------

let cycleRunning = false;
let lastSelfCheckTry = 0;

/** Called after every Kalshi cycle. Never throws. */
export async function runPolymarketCycle(config) {
  if (cycleRunning) return { skipped: "already running" };
  cycleRunning = true;
  try {
    const settings = pmSettings(config);
    if (settings.enabled === false) return { skipped: "disabled" };
    if (!pmConfigured()) return { skipped: "no keys" };

    const meta = pmMeta();
    const last = meta.selfCheck?.at ? Date.parse(meta.selfCheck.at) : 0;
    // Due: never run, run by an older build (so a new build re-checks at once),
    // failed (every 5 min), passed without the NO side yet (every 10 min), or
    // fully passed (every 30 min).
    const sc = meta.selfCheck;
    const every = !sc?.passed ? SELF_CHECK_RETRY_MS
      : sc.shortConvention !== DOCUMENTED_SHORT_FORMAT ? 2 * SELF_CHECK_RETRY_MS
      : SELF_CHECK_EVERY_MS;
    const due = (!last || sc?.version !== PM_ENGINE_VERSION || Date.now() - last > every) && Date.now() - lastSelfCheckTry > 60 * 1000;
    if (due) {
      lastSelfCheckTry = Date.now();
      try { await runSelfCheck(config); } catch (err) { appendLog(`Polymarket self-check error: ${err.message}`, "warn"); }
    }

    try {
      const { settled } = await reconcilePolymarket();
      if (settled) appendLog(`Polymarket: ${settled} position(s) settled.`);
    } catch (err) { appendLog(`Polymarket settlement check contained: ${err.message}`, "warn"); }

    let state = {};
    try { state = loadState(); } catch { state = {}; }
    if (state.haltedForDay) return { skipped: "Kalshi side halted for the day" };

    const active = tradingActive(settings, pmMeta());
    return await scanPolymarket(config, settings, active);
  } catch (err) {
    try { appendLog(`Polymarket cycle contained: ${err.message}`, "warn"); } catch { /* never break the bot */ }
    return { error: err.message };
  } finally {
    cycleRunning = false;
  }
}

// --- Status ---------------------------------------------------------------------------------

export function pmStatus(config = {}) {
  const { maxOpenPositions: _ignored, ...settings } = pmSettings(config);
  const meta = pmMeta();
  const sc = meta.selfCheck || null;
  return {
    version: PM_ENGINE_VERSION,
    clientVersion: PM_CLIENT_VERSION,
    configured: pmConfigured(),
    credentials: pmCredentialReport(),
    settings,
    tradingActive: tradingActive(settings, meta),
    noSideActive: shortSideActive(settings, meta),
    selfCheck: sc ? { at: sc.at, passed: sc.passed, steps: sc.steps, shortConvention: sc.shortConvention ?? null } : null,
    account: meta.lastAccount ?? null,
    positions: pmPositions().map((p) => ({
      ticker: p.ticker, slug: p.slug, side: p.long ? "YES" : "NO", teamName: p.teamName, opponent: p.opponent,
      sportKey: p.sportKey, contracts: p.contracts, entryPriceCents: p.entryPriceCents, openedAt: p.openedAt,
      costDollars: Math.round((p.contracts * p.entryPriceCents + (p.entryFeeCents || 0))) / 100,
      valueDollars: p.cashValue ?? null,
    })),
    lastScan: meta.lastScan ?? null,
    coverage: meta.coverage ?? null,
    haltedForDay: meta.haltedForDay === true,
    pausedUntil: meta.pausedUntil && Date.parse(meta.pausedUntil) > Date.now() ? meta.pausedUntil : null,
  };
}

/** Everything the monitor needs to verify the integration against real data. */
export function pmMonitorReport(config = {}) {
  const meta = pmMeta();
  return {
    ...pmStatus(config),
    selfCheckDetail: meta.selfCheck ?? null,
    client: pmClientStats(),
    markets: pmMarketsReport(),
  };
}
