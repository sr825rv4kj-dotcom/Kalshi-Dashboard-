/**
 * paperTrader.js  (2026-10-11)
 *
 * PAPER STRATEGIES - other ways of trading, scored on the bot's real live
 * prices without spending a cent. Real money trades only the configured lane
 * (50-59c). Every market the Kalshi scanner prices is also offered to each
 * paper strategy below; a strategy that would have bought records a paper
 * position at the REAL ask, sized at a flat $5 with Kalshi's real taker fee,
 * one position per game per strategy. Positions settle from Kalshi's own
 * market result (yes / no), read from the exchange - nothing is simulated.
 *
 * Strategies (fair = the bot's sharp-line fair value; "return" = expected
 * return after fees, on the shrunk fair value the real bot prices with unless
 * noted; the real bot's 18% plausibility cap applies to all):
 *
 *   fifty_59     50-59c, return 0.5-8%          - the live rule, uncapped, so
 *                                                 it can be compared 1:1
 *   dip_35_49    35-49c, return 5%+             - the old dip lane
 *   fav_70_89    70-89c, 65%+ to win, return 0.5%+ - favorites
 *   best_day     in-play, 35-59c, 30%+ return on the UNSHRUNK fair value
 *                                               - the Sep 26-27 formula
 *   avg_down     a REAL open Kalshi position whose ask has fallen 10c+ below
 *                its entry: one paper add at that ask (the "double down" idea)
 *   nhl_flip / mlb_flip / nba_flip / soccer_flip   (2026-10-13) THE FLIP:
 *                whenever the live rule (fifty_59) would buy a team in that
 *                sport group, buy "NO" on that same market instead - the bet
 *                against the bot's pick (for hockey, baseball and basketball
 *                that is the other team; in soccer it is the other team OR a
 *                draw). Priced at the real "no" ask read from Kalshi, settled
 *                from the same market result ("no" wins).
 *
 * Since 2026-10-13 20:08 PT these sports also trade the flip for REAL money
 * (flipTrader.js - the other team's YES); the paper flip keeps scoring the
 * NO side alongside it.
 *
 * Never places, cancels or sizes a real order. Stored in
 * DATA_DIR/paper-trades.json, written atomically.
 */

import fs from "fs";
import path from "path";
import { DATA_DIR } from "./paths.js";
import { atomicWriteFileSync, loadState } from "./stateStore.js";
import { scheduleFeeCents } from "./tradeLedgerStore.js";
import { kalshiGet, hasCredentialsConfigured } from "./kalshiClient.js";

export const PAPER_VERSION = "2026-10-13-flip-groups";

const FILE = path.join(DATA_DIR, "paper-trades.json");
const STAKE_DOLLARS = 5;
const SHRINK = 0.5;
const MAX_PLAUSIBLE_EDGE = 0.18;
const SETTLE_EVERY_MS = 5 * 60 * 1000;
const AVG_DOWN_EVERY_MS = 60 * 1000;
const AVG_DOWN_DROP_CENTS = 10;

export const STRATEGIES = {
  fifty_59: "50-59c, 0.5-8% return (live rule)",
  dip_35_49: "35-49c dips, 5%+ return",
  fav_70_89: "70-89c favorites, 65%+ to win",
  best_day: "Best-day formula: in-play 35-59c, 30%+ raw return",
  avg_down: "Average down: add after a 10c+ drop",
  nhl_flip: "NHL flip: bet against the bot's pick",
  mlb_flip: "MLB flip: bet against the bot's pick",
  nba_flip: "NBA preseason flip: bet against the bot's pick",
  soccer_flip: "Soccer flip (Brazil A/B, MLS): bet against the bot's pick",
};

/** Which flip strategy (if any) scores a sport. */
export const FLIP_GROUPS = {
  icehockey_nhl: "nhl_flip",
  icehockey_nhl_preseason: "nhl_flip",
  baseball_mlb: "mlb_flip",
  basketball_nba_preseason: "nba_flip",
  soccer_brazil_serie_b: "soccer_flip",
  soccer_brazil_campeonato: "soccer_flip",
  soccer_usa_mls: "soccer_flip",
};
const flipInFlight = new Set();

let book = null;
let timersStarted = false;

function load() {
  if (book) return book;
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
    book = { positions: Array.isArray(saved.positions) ? saved.positions : [] };
  } catch {
    book = { positions: [] };
  }
  return book;
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    atomicWriteFileSync(FILE, JSON.stringify(book));
  } catch { /* paper trading must never affect real trading */ }
}

const eventOf = (ticker) => String(ticker || "").slice(0, String(ticker || "").lastIndexOf("-"));

/** Pure: contracts, fee and cost of a flat $5 paper buy at this price. */
export function paperSize(priceCents, stakeDollars = STAKE_DOLLARS) {
  const p = Number(priceCents);
  let n = Math.max(1, Math.floor((stakeDollars * 100) / p));
  while (n > 1 && n * p + scheduleFeeCents(p, n) > stakeDollars * 100) n -= 1;
  const feeCents = scheduleFeeCents(p, n);
  return { contracts: n, feeCents, costDollars: (n * p + feeCents) / 100 };
}

/** Pure: expected return % after fees at this price, on a given fair value. */
export function expectedReturnPct(fair, priceCents, contracts) {
  const fee = scheduleFeeCents(priceCents, contracts) / contracts;
  return ((fair * 100 - priceCents - fee) / priceCents) * 100;
}

/** Pure: which scan strategies would buy this market. */
export function strategiesFor({ askCents, fair, live }) {
  const a = Number(askCents);
  const p = Number(fair);
  if (!(a > 0 && a < 100) || !(p > 0 && p < 1)) return [];
  if (p - a / 100 > MAX_PLAUSIBLE_EDGE) return [];
  const { contracts } = paperSize(a);
  const shrunk = a / 100 + SHRINK * (p - a / 100);
  const ret = expectedReturnPct(shrunk, a, contracts);
  const raw = expectedReturnPct(p, a, contracts);
  const out = [];
  if (a >= 50 && a <= 59 && ret >= 0.5 && ret <= 8) out.push("fifty_59");
  if (a >= 35 && a <= 49 && ret >= 5) out.push("dip_35_49");
  if (a >= 70 && a <= 89 && p >= 0.65 && ret >= 0.5) out.push("fav_70_89");
  if (live && a >= 35 && a <= 59 && raw >= 30) out.push("best_day");
  return out;
}

function hasPosition(strategy, ticker) {
  const ev = eventOf(ticker);
  return load().positions.some((x) => x.strategy === strategy && (x.event === ev || x.ticker === ticker));
}

function record({ strategy, ticker, side = "yes", sportKey, teamName, askCents, fair, live, commenceTime, note }) {
  const { contracts, feeCents, costDollars } = paperSize(askCents);
  load().positions.push({
    strategy, ticker, side, event: eventOf(ticker), sportKey: sportKey ?? null, team: teamName ?? null,
    priceCents: Number(askCents), fair: Number.isFinite(Number(fair)) ? Math.round(Number(fair) * 1000) / 1000 : null,
    live: !!live, contracts, feeCents, costDollars, commenceTime: commenceTime ?? null, note: note ?? null,
    openedAt: new Date().toISOString(), result: null, netDollars: null, settledAt: null,
  });
}

/**
 * Called by the Kalshi scanner for every market it priced (before the real
 * lane rules). Never throws.
 */
export function paperObserve({ ticker, sportKey, teamName, askCents, fair, live, commenceTime }) {
  try {
    startPaperTimers();
    let added = false;
    for (const s of strategiesFor({ askCents, fair, live })) {
      if (hasPosition(s, ticker)) continue;
      record({ strategy: s, ticker, sportKey, teamName, askCents, fair, live, commenceTime });
      added = true;
    }
    if (added) save();
    const flip = FLIP_GROUPS[String(sportKey)];
    if (flip && strategiesFor({ askCents, fair, live }).includes("fifty_59")) {
      flipAgainst({ strategy: flip, ticker, sportKey, teamName, askCents, live, commenceTime }).catch(() => {});
    }
  } catch { /* never affects the scan */ }
}

/**
 * THE FLIP: the live rule would buy `teamName` on `ticker`; record a paper buy
 * of "NO" on that same market at its real no ask, read fresh from Kalshi.
 */
async function flipAgainst({ strategy, ticker, sportKey, teamName, askCents, live, commenceTime }) {
  const ev = eventOf(ticker);
  if (!ev || flipInFlight.has(ev) || hasPosition(strategy, ticker)) return;
  if (!hasCredentialsConfigured()) return;
  flipInFlight.add(ev);
  try {
    const m = await readMarket(ticker);
    // NO ask straight from Kalshi; if absent, 100 minus the YES bid - the same
    // price in Kalshi's binary book (selling YES at the bid = buying NO).
    const yesBid = centsField(m, "yes_bid");
    const noAsk = centsField(m, "no_ask") ?? (yesBid ? 100 - yesBid : null);
    if (!(noAsk >= 1 && noAsk <= 99)) return;
    record({
      strategy, ticker, side: "no", sportKey,
      teamName: `against ${teamName ?? ticker}`,
      askCents: noAsk, fair: null, live, commenceTime,
      note: `bot would buy ${teamName ?? ticker} at ${askCents}c; NO bought at ${noAsk}c`,
    });
    save();
  } finally {
    flipInFlight.delete(ev);
  }
}

function centsField(m, key) {
  const d = Number(m?.[`${key}_dollars`]);
  if (Number.isFinite(d) && d > 0) return Math.round(d * 100);
  const v = Number(m?.[key]);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v <= 1 ? Math.round(v * 100) : Math.round(v);
}

async function readMarket(ticker) {
  const data = await kalshiGet(`/trade-api/v2/markets/${encodeURIComponent(ticker)}`);
  return data.market || data;
}

/** AVERAGE DOWN: real open Kalshi positions whose ask fell 10c+ below entry. */
async function checkAverageDown() {
  if (!hasCredentialsConfigured()) return;
  let positions = [];
  try { positions = loadState().positions || []; } catch { positions = []; }
  let added = false;
  for (const pos of positions.slice(0, 10)) {
    if (!pos?.ticker || hasPosition("avg_down", pos.ticker)) continue;
    try {
      const m = await readMarket(pos.ticker);
      const ask = centsField(m, "yes_ask");
      if (ask && ask >= 5 && ask <= Number(pos.entryPriceCents) - AVG_DOWN_DROP_CENTS) {
        record({
          strategy: "avg_down", ticker: pos.ticker, sportKey: pos.sportKey, teamName: pos.teamName,
          askCents: ask, fair: null, live: true, commenceTime: pos.commenceTime,
          note: `real entry ${pos.entryPriceCents}c, added at ${ask}c`,
        });
        added = true;
      }
    } catch { /* next minute */ }
  }
  if (added) save();
}

/** Settle open paper positions from Kalshi's market result. */
async function settleOpen() {
  if (!hasCredentialsConfigured()) return;
  const open = load().positions.filter((x) => !x.result);
  let changed = false;
  for (const x of open.slice(0, 25)) {
    if (x.commenceTime && Date.now() < Date.parse(x.commenceTime) + 60 * 60 * 1000) continue;
    try {
      const m = await readMarket(x.ticker);
      const r = String(m.result || "").toLowerCase();
      if (r !== "yes" && r !== "no") continue;
      x.result = r;
      x.won = r === (x.side || "yes");
      x.netDollars = Math.round(((x.won ? x.contracts : 0) - x.costDollars) * 100) / 100;
      x.settledAt = new Date().toISOString();
      changed = true;
    } catch { /* retried next round */ }
  }
  if (changed) save();
}

export function startPaperTimers() {
  if (timersStarted) return;
  timersStarted = true;
  const s = setInterval(() => { settleOpen().catch(() => {}); }, SETTLE_EVERY_MS);
  const a = setInterval(() => { checkAverageDown().catch(() => {}); }, AVG_DOWN_EVERY_MS);
  for (const t of [s, a]) if (typeof t.unref === "function") t.unref();
}

/** Pure: one scorecard per strategy from a list of paper positions. */
export function scorecards(positions) {
  return Object.entries(STRATEGIES).map(([key, label]) => {
    const all = positions.filter((x) => x.strategy === key);
    const done = all.filter((x) => x.result);
    const won = (x) => (x.won != null ? x.won : x.result === (x.side || "yes"));
    const wins = done.filter(won).length;
    const net = done.reduce((t, x) => t + x.netDollars, 0);
    const cost = done.reduce((t, x) => t + x.costDollars, 0);
    return {
      key, label,
      trades: all.length, open: all.length - done.length, settled: done.length, wins,
      expectedWins: Math.round(done.reduce((t, x) => t + x.priceCents / 100, 0) * 10) / 10,
      net: Math.round(net * 100) / 100,
      roiPct: cost > 0 ? Math.round((net / cost) * 1000) / 10 : null,
      recent: all.slice(-5).reverse().map((x) => `${x.team ?? x.ticker} @ ${x.priceCents}c ${x.result ? (won(x) ? "won" : "lost") + ` ${x.netDollars >= 0 ? "+" : ""}${x.netDollars.toFixed(2)}` : "open"}`),
    };
  });
}

export function paperReport() {
  startPaperTimers();
  const positions = load().positions;
  return {
    version: PAPER_VERSION,
    since: positions.length ? positions[0].openedAt : null,
    note: "Paper only - flat $5 at the real ask, real taker fee, settled from Kalshi's own result. No money is spent. Paper flips bet NO on the bot's pick (NHL, MLB, NBA preseason, Brazil A/B, MLS); real money flips those sports too (other team's YES).",
    strategies: scorecards(positions),
  };
}

