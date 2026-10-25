/**
 * flipTrader.js  (2026-10-13)
 *
 * REAL-MONEY FLIP - account holder's call: "bet on the opposite teams... just
 * bet on opposite what bot thinks is going to win. Same with mlb."
 *
 * In a flip sport (config.flipSports), every candidate goes through the bot's
 * normal formula unchanged - lane, edge, learner, waiting period, cap, daily
 * halt. When the formula says BUY team A, the scanner instead buys team B,
 * the other team in the same game, on Kalshi at team B's own real ask, sized
 * to the same flat stake. One position per game, as always.
 *
 * The other team is read from the game's own ticker: Kalshi event tickers end
 * in the two team codes (KXNHLGAME-26OCT13FLACBJ, KXMLBGAME-26OCT122000LADMIL),
 * so team A's code is removed and the market whose ticker ends in what is
 * left is team B's. If the codes cannot be matched, a game with exactly two
 * team markets uses the other one; anything else is skipped, never guessed.
 *
 * SOCCER TIES (2026-10-16, account holder's call: "Tie in soccer flips"): in
 * a soccer flip the TIE is bought too, at its own real ask, same flat stake -
 * two bets, so only the bot's own pick winning loses. The tie market is the
 * one whose ticker ends in TIE / DRAW / DRW / TIED (the codes
 * tickerResolver.js already treats as non-team); failing that, in a game with
 * exactly three markets, the one that is neither team.
 *
 * Learner blocks on the bot's own pick do NOT stop a flip in these sports -
 * the bot's picks losing there is the reason for flipping.
 */

import { kalshiGet } from "./kalshiClient.js";

export const FLIP_VERSION = "2026-10-16-soccer-tie";

const V2 = "/trade-api/v2";

/** Is this sport flipped? "*" suffix = prefix, as in disabledSports. */
export function flipSport(sportKey, config = {}) {
  const key = String(sportKey || "");
  const list = Array.isArray(config.flipSports) ? config.flipSports : [];
  return list.some((raw) => {
    const k = String(raw || "").trim();
    if (!k) return false;
    return k.endsWith("*") ? key.startsWith(k.slice(0, -1)) : k === key;
  });
}

const eventOf = (ticker) => String(ticker || "").slice(0, String(ticker || "").lastIndexOf("-"));
const suffixOf = (ticker) => String(ticker || "").slice(String(ticker || "").lastIndexOf("-") + 1);

/** Pure: the team codes at the end of an event ticker ("FLACBJ", "LADMIL"). */
export function teamCodes(eventTicker) {
  const mid = String(eventTicker || "").slice(String(eventTicker || "").indexOf("-") + 1);
  return mid.replace(/^\d{2}[A-Z]{3}\d+/, "");
}

const TIE_CODES = new Set(["TIE", "DRAW", "DRW", "TIED"]);

/** Soccer sport keys get the tie leg. */
export function isSoccer(sportKey) {
  return String(sportKey || "").startsWith("soccer_");
}

/** Pure: the draw market among the game's markets, or null. */
export function tieOf(ticker, opponentTicker, markets) {
  const list = (Array.isArray(markets) ? markets : []).filter((m) => m && m.ticker);
  const coded = list.filter((m) => TIE_CODES.has(suffixOf(m.ticker).toUpperCase()));
  if (coded.length === 1) return coded[0];
  if (list.length === 3) {
    const rest = list.filter((m) => m.ticker !== ticker && m.ticker !== opponentTicker);
    if (rest.length === 1) return rest[0];
  }
  return null;
}

/** Pure: the opponent's market among the game's markets, or null. */
export function opponentOf(ticker, markets) {
  const list = (Array.isArray(markets) ? markets : [])
    .filter((m) => m && m.ticker && m.ticker !== ticker && !TIE_CODES.has(suffixOf(m.ticker).toUpperCase()));
  const mine = suffixOf(ticker);
  const codes = teamCodes(eventOf(ticker));
  let oppCode = null;
  if (mine && codes.length > mine.length) {
    if (codes.startsWith(mine)) oppCode = codes.slice(mine.length);
    else if (codes.endsWith(mine)) oppCode = codes.slice(0, codes.length - mine.length);
  }
  if (oppCode) {
    const hit = list.filter((m) => suffixOf(m.ticker) === oppCode);
    if (hit.length === 1) return hit[0];
  }
  return list.length === 1 ? list[0] : null;
}

function cents(m, key) {
  const d = Number(m?.[`${key}_dollars`]);
  if (Number.isFinite(d) && d > 0) return Math.round(d * 100);
  const v = Number(m?.[key]);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v <= 1 ? Math.round(v * 100) : Math.round(v);
}

function leg(m) {
  const status = String(m.status || "").toLowerCase();
  if (status && !["active", "open"].includes(status)) return { error: `${m.ticker} is ${status}` };
  const askCents = cents(m, "yes_ask");
  if (!(askCents >= 1 && askCents <= 99)) return { error: `${m.ticker} has no usable ask` };
  return { ticker: m.ticker, teamName: m.yes_sub_title || suffixOf(m.ticker), askCents, exchangeIndex: m.exchange_index ?? null };
}

/**
 * The other team's market and its live ask, read from Kalshi now - and, with
 * withTie, the draw market too. Returns { ticker, teamName, askCents,
 * exchangeIndex, tie } or { error }. tie is a leg, { error }, or null.
 */
export async function findOpponent(ticker, { withTie = false } = {}) {
  const ev = eventOf(ticker);
  if (!ev) return { error: "no event ticker" };
  const data = await kalshiGet(`${V2}/markets`, `?event_ticker=${encodeURIComponent(ev)}`);
  const markets = data?.markets;
  const opp = opponentOf(ticker, markets);
  if (!opp) return { error: `could not identify the other team in ${ev}` };
  const o = leg(opp);
  if (o.error) return o;
  let tie = null;
  if (withTie) {
    const t = tieOf(ticker, opp.ticker, markets);
    tie = t ? leg(t) : { error: `no tie market found in ${ev}` };
    if (!tie.error) tie.teamName = "Tie";
  }
  return { ...o, tie };
}

