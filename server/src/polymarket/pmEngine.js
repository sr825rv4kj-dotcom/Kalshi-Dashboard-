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
 * ONE BET PER GAME ACROSS BOTH EXCHANGES. A game held on Kalshi is not bought
 * on Polymarket and vice versa - two bets on one game is double the risk,
 * not double the edge. Kalshi scans first each cycle; Polymarket then takes
 * the games whose Kalshi price did not clear the bar but whose Polymarket
 * price does.
 *
 * SWITCHED ON BY A LIVE SELF-CHECK, NOT BY GUESSWORK. Before the first order,
 * the engine checks the real API: the keys sign correctly and read the
 * balance, real games are found and each side is tied to a team by id, and a
 * PREVIEW order (validated by Polymarket, never executed) comes back in the
 * expected form. trading: "auto" trades only once all of that passes.
 *
 * BACKING THE NO SIDE. Polymarket's docs describe the NO-side order price two
 * different ways. Until a live preview shows which one the exchange uses,
 * the engine only buys a team when it is the market's YES side (every soccer
 * team, and one side of every other game). The self-check reads the answer
 * from the preview and turns the NO side on by itself.
 *
 * Every failure is contained: nothing here can stop or slow the Kalshi bot.
 */

import { loadState, appendLog } from "../stateStore.js";
import { recordTrade } from "../tradeLedgerStore.js";
import { entryTiming, getRecentLines, rememberLines } from "../scanner.js";
import { getSharpProbabilities } from "../scraper.js";
import { getLiveScores, findLiveGameForTeam } from "../scoresFetcher.js";
import { corroboratedProbability, fractionRemaining, paramsFor, pregamePrior } from "../liveModel.js";
import { assessOpportunity, feePerContractCents, flatBetContracts } from "../riskManager.js";
import { learnedBlock, streakStakeFactor } from "../outcomeLearner.js";
import { tieredStake } from "../scaling.js";
import { getRestingOrders } from "../makerEngine.js";
import { notifyEntry } from "../notifier.js";
import { getTelegramCredentials } from "../telegramStore.js";
import { pmGet, pmPost, pmConfigured, pmClientStats, pmCredentialReport, dollarsOf, centsOf, numberOf, PM_CLIENT_VERSION } from "./pmClient.js";
import { leagueSlugFor, leagueSlugsFor, getSportEvents, mappedSports, getLeagues, getLeagueEvents, matchEvent, winnerSideFor, sidePrice, pmMarketsReport } from "./pmMarkets.js";
import { pmPositions, savePmPositions, pmMeta, updatePmMeta, heldOnPolymarket, heldOnKalshi, normName } from "./pmState.js";

export const PM_ENGINE_VERSION = "2026-09-28-verified-leagues";
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
    maxOpenPositions: 3,
    ...(config.polymarket && typeof config.polymarket === "object" ? config.polymarket : {}),
  };
}

function tradingActive(settings, meta) {
  if (settings.enabled === false || settings.trading === "off") return false;
  if (!pmConfigured()) return false;
  if (settings.trading === "on") return meta.selfCheck?.balanceOk === true;
  return meta.selfCheck?.passed === true;
}

function shortSideActive(settings, meta) {
  if (settings.shortSide === "off") return false;
  return meta.selfCheck?.shortConvention === "no-price";
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
          if (r.ok) { tied++; if (r.long && sampleList.length < 6) sampleList.push({ ev, r }); } else if (r.code !== "pm-no-winner-market") untied++;
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
  for (const cand of sampleList) {
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

      // NO side: send a NO price q between the YES bid and 1 - bid, so the
      // order could not trade under either reading; the echo shows the reading.
      // Needs a market whose YES bid is under 46c: take the first sampled one.
      let noSample = bid < 0.46 ? { slug: sample.r.slug, bid } : null;
      for (const cand of sampleList) {
        if (noSample) break;
        try {
          const p2 = await sidePrice(cand.r.slug, true);
          if (p2.open && p2.bidCents != null && p2.bidCents < 46) noSample = { slug: cand.r.slug, bid: p2.bidCents / 100 };
        } catch { /* next */ }
      }
      if (noSample) {
        const nb = noSample.bid;
        const q = Math.round((nb + 0.25 * (1 - 2 * nb)) * 100) / 100;
        const ps = await pmPost("/v1/order/preview", previewBody(noSample.slug, "ORDER_INTENT_BUY_SHORT", q), { auth: true });
        const so = ps.order || ps;
        const e = dollarsOf(so.price);
        // Only an UNAMBIGUOUS answer turns the NO side on. An echo of q marked
        // SELL could mean either reading, and misreading it would pay up to
        // 1 - limit for a NO contract - so that case stays off until the raw
        // preview has been checked by hand.
        let convention = "unknown";
        if (e != null && Math.abs(e - (1 - q)) < 0.006 && /SELL/.test(String(so.side || ""))) convention = "no-price";
        else if (e != null && Math.abs(e - q) < 0.006 && /BUY/.test(String(so.side || ""))) convention = "no-price";
        else if (e != null && Math.abs(e - q) < 0.006) convention = "unconfirmed";
        out.previewShort = { market: noSample.slug, yesBid: nb, sentNoPrice: q, side: so.side, intent: so.intent, price: so.price, state: so.state };
        out.shortConvention = convention;
        step("preview-buy-no", convention === "no-price", `sent BUY NO @ $${q.toFixed(2)} -> ${so.side ?? "?"} @ ${e ?? "?"}: ${convention === "no-price" ? "confirmed - NO side on" : "format not confirmed - NO side stays off (YES-side bets unaffected)"}`);
      } else {
        out.shortConvention = pmMeta().selfCheck?.shortConvention ?? "unknown";
        step("preview-buy-no", false, "no sampled market has a YES bid under 46c for a safe NO preview - retried next check");
      }
    } catch (err) {
      out.previewLongOk = out.previewLongOk ?? false;
      step("preview", false, err.message);
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

async function placeEntry({ c, limitCents, contracts, convention }) {
  if (!c.side.long && convention !== "no-price") throw new Error("NO-side order format not confirmed");
  const priceDollars = limitCents / 100;
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
  // A NO fill may be reported as the YES price it sold at. Read it as the
  // price that is at or under our NO limit.
  let fillCents = fill.avgPx != null ? fill.avgPx * 100 : null;
  if (!c.side.long && fillCents != null && fillCents > limitCents + 0.5 && 100 - fillCents <= limitCents + 0.5) fillCents = 100 - fillCents;
  return { orderId: res.id ?? null, filled: fill.shares, fillCents: fillCents != null ? Math.round(fillCents * 10) / 10 : null, feeCents: Math.round(fill.commission * 100), rejected: fill.rejected };
}

// --- The scan ----------------------------------------------------------------------------

async function linesForCycle(config) {
  const recent = getRecentLines(30 * 60 * 1000);
  const out = new Map();
  for (const [sportKey, entry] of recent) {
    if (Date.now() - entry.at <= LINE_MAX_AGE_MS) { out.set(sportKey, entry); continue; }
    // Kalshi did not scan this sport this cycle (at its cap, or parked). Only
    // refetch for sports Polymarket actually lists, so no credit is wasted.
    try {
      if (!(await leagueSlugFor(sportKey))) continue;
      const tournamentId = (config.oddsPapiTournamentIds || {})[sportKey];
      const r = await getSharpProbabilities(sportKey, { oddsPapiTournamentId: tournamentId, providerOrder: config.oddsProviderOrder });
      rememberLines(sportKey, r);
      out.set(sportKey, { at: Date.now(), probabilities: r.probabilities || {}, provider: r.provider });
    } catch { /* this sport sits out one cycle */ }
  }
  return out;
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
  const shortOn = shortSideActive(settings, meta);
  const convention = meta.selfCheck?.shortConvention;
  let resting = [];
  try { resting = Object.values(getRestingOrders()); } catch { resting = []; }

  const lines = await linesForCycle(config);
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

      if (heldOnKalshi({ sportKey, commenceTime, teamNames, restingOrders: resting })) { bump("pm-held-on-kalshi", teamNames.join(" vs ")); continue; }
      if (heldOnPolymarket({ sportKey, commenceTime, teamNames })) { bump("pm-already-held", teamNames.join(" vs ")); continue; }

      try { events ??= await getSportEvents(sportKey); } catch (err) { bump("pm-events-failed", err.message); break; }
      const ev = matchEvent(events, teamNames, commenceTime);
      if (!ev || ev.ambiguous) { bump(ev?.ambiguous ? "pm-game-ambiguous" : "pm-game-not-listed", `${teamNames.join(" vs ")} (${slug})`); continue; }

      for (const t of teams) {
        if (isDraw(t.name)) continue;
        const side = winnerSideFor(ev, t.name);
        if (!side.ok) { bump(side.code, side.reason); continue; }
        if (!side.long && !shortOn) { bump("pm-no-side-not-confirmed", `${t.name}: needs the NO side, which turns on after the self-check confirms its order format`); continue; }
        const opponent = teamNames.find((n) => normName(n) !== normName(t.name)) ?? null;
        const c = { sportKey, teamName: t.name, opponent, commenceTime, timing, prob: t.info.trueProbability, lineAgeSeconds: t.info.lineAgeSeconds ?? null, ev, side };

        // Price.
        let px;
        try { px = await sidePrice(side.slug, side.long); } catch (err) { bump("pm-price-failed", `${side.slug}: ${err.message}`); continue; }
        if (!px.open) { bump("pm-market-not-open", `${side.slug}: ${px.state}`); continue; }
        if (px.askCents == null || px.askCents <= 0 || px.askCents >= 100) { bump("pm-no-price", side.slug); continue; }
        const askCents = Math.ceil(px.askCents - 1e-9);
        const maxSpread = config.maxSpreadCents ?? 25;
        if (maxSpread && px.spreadCents != null && px.spreadCents > maxSpread) { bump("pm-spread-too-wide", `${side.slug}: ${px.spreadCents}c`); continue; }

        // In-game model, exactly as the Kalshi scan does it.
        if (timing.live) {
          if (!paramsFor(sportKey)) { bump("pm-no-model"); continue; }
          try { scores ??= (await getLiveScores(sportKey)).events || []; } catch { scores = []; }
          const game = findLiveGameForTeam(scores, t.name);
          if (!game) { bump("pm-no-live-score", t.name); continue; }
          const frac = fractionRemaining(sportKey, commenceTime);
          const corr = corroboratedProbability({
            sportKey, sharpProbability: c.prob, lead: game.lead, fracRemaining: frac,
            pregameProbability: pregamePrior({ sportKey, teamName: t.name, commenceTime }),
          });
          if (!corr.usable) { bump("pm-unmodellable", t.name); continue; }
          if (corr.disagreementPoints > (config.maxModelDisagreementPoints ?? 12)) {
            bump("pm-model-disagrees", `${t.name}: sharp ${(c.prob * 100).toFixed(0)}% vs model ${(corr.modelProbability * 100).toFixed(0)}%`);
            continue;
          }
          c.prob = corr.probability;
          c.liveContext = `${game.homeTeam} ${game.homeScore}-${game.awayScore} ${game.awayTeam}, ${(frac * 100).toFixed(0)}% left, model ${(corr.modelProbability * 100).toFixed(0)}%`;
        }

        const learned = learnedBlock({ sportKey, priceCents: askCents }, config);
        if (learned.blocked) { bump("pm-learned-block", learned.reason); continue; }

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
        if (assessment.action === "skip") { bump(`pm-${assessment.code || "skip"}`, `${t.name} ${askCents}c (sharp ${(c.prob * 100).toFixed(1)}%): ${assessment.reason}`); continue; }

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
          bump("pm-return-too-small", `${t.name} ${askCents}c (sharp ${(c.prob * 100).toFixed(1)}%): ${r.pct.toFixed(1)}% expected, under ${minReturnPct}%`);
          continue;
        }
        let contracts = countAt(limit);
        const perContract = (limit + feePerContractCents(limit, contracts, PM_FEE)) / 100;
        if (contracts * perContract > bankroll) contracts = Math.floor(bankroll / perContract);
        const minQty = numberOf(side.market?.minimumTradeQty) ?? 1;
        if (contracts < Math.max(1, minQty)) { bump("pm-size-zero", `${t.name}: $${bankroll.toFixed(2)} buying power`); continue; }
        const r = returnAt(limit);
        const dollarsIn = contracts * perContract;
        const reason =
          `Polymarket: ${timing.live ? "In-play" : "Pre-game"} edge on "${t.name}" ` +
          `(sharp ${(c.prob * 100).toFixed(1)}% vs $${(askCents / 100).toFixed(2)} ask, limit $${(limit / 100).toFixed(2)}, ` +
          `${contracts} contracts, $${dollarsIn.toFixed(2)} in, expected +$${((r.ev * contracts) / 100).toFixed(2)} (${r.pct.toFixed(1)}%))` +
          (c.liveContext ? ` | ${c.liveContext}` : "");

        if (!active) { bump("pm-would-trade", reason); continue; }
        if (halted) { bump("pm-halted", t.name); continue; }
        if (paused) continue;
        if (pmPositions().length >= Number(settings.maxOpenPositions ?? 3)) { bump("pm-at-cap", `${pmPositions().length} open`); continue; }

        let result;
        try {
          appendLog(`Polymarket order: BUY ${side.long ? "YES" : "NO"} ${contracts}x ${side.slug} (${t.name}) at up to $${(limit / 100).toFixed(2)} - ${reason}`);
          result = await placeEntry({ c, limitCents: limit, contracts, convention });
        } catch (err) {
          bump("pm-order-error", `${side.slug}: ${err.message}`);
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
        if (result.rejected) { bump("pm-order-rejected", `${side.slug}: ${result.rejected}`); continue; }
        if (!(result.filled > 0) || result.fillCents == null) { bump("pm-no-fill", `${side.slug}: nothing at or under $${(limit / 100).toFixed(2)}`); continue; }

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
        try {
          const { botToken, chatId } = getTelegramCredentials();
          notifyEntry({ botToken, chatId, ticker, side: side.long ? "yes" : "no", contracts: filled, priceCents: result.fillCents, reason, environment: "production" }).catch(() => {});
        } catch { /* notifications never block trading */ }
        entered++;
        break;   // one side per game
      }
    }
  }

  const lastScan = { at: new Date().toISOString(), active, seen, entered, reasons: tally, samples, stake: stakeDecision.stake * brake.factor, equity: Math.round(equity * 100) / 100 };
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
    const due = !last || Date.now() - last > (meta.selfCheck?.passed ? SELF_CHECK_EVERY_MS : SELF_CHECK_RETRY_MS);
    if (due) { try { await runSelfCheck(config); } catch (err) { appendLog(`Polymarket self-check error: ${err.message}`, "warn"); } }

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
  const settings = pmSettings(config);
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
