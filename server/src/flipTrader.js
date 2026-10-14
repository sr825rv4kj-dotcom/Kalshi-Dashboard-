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
 * left is team B's. Soccer events also list a draw market; it is never chosen.
 * If the codes cannot be matched, a game with exactly two markets uses the
 * other one; anything else is skipped, never guessed.
 *
 * Learner blocks on the bot's own pick do NOT stop a flip in these sports -
 * the bot's picks losing there is the reason for flipping.
 */

import { kalshiGet } from "./kalshiClient.js";

export const FLIP_VERSION = "2026-10-13-real-flip";

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

/** Pure: the opponent's market among the game's markets, or null. */
export function opponentOf(ticker, markets) {
  const list = (Array.isArray(markets) ? markets : []).filter((m) => m && m.ticker && m.ticker !== ticker);
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

/**
 * The other team's market and its live ask, read from Kalshi now.
 * Returns { ticker, teamName, askCents, exchangeIndex } or { error }.
 */
export async function findOpponent(ticker) {
  const ev = eventOf(ticker);
  if (!ev) return { error: "no event ticker" };
  const data = await kalshiGet(`${V2}/markets`, `?event_ticker=${encodeURIComponent(ev)}`);
  const opp = opponentOf(ticker, data?.markets);
  if (!opp) return { error: `could not identify the other team in ${ev}` };
  const status = String(opp.status || "").toLowerCase();
  if (status && !["active", "open"].includes(status)) return { error: `${opp.ticker} is ${status}` };
  const askCents = cents(opp, "yes_ask");
  if (!(askCents >= 1 && askCents <= 99)) return { error: `${opp.ticker} has no usable ask` };
  return {
    ticker: opp.ticker,
    teamName: opp.yes_sub_title || suffixOf(opp.ticker),
    askCents,
    exchangeIndex: opp.exchange_index ?? null,
  };
}
