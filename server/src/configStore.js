/**
 * configStore.js
 *
 * Config lives in two places and that has caused real trouble: the repo copy
 * in server/config/bot-config.json is only a seed, and paths.js copies it to
 * the Railway volume once and never again. Editing the repo file therefore
 * changed nothing on a running instance, so strategy parameters that were
 * "fixed" in a commit went on trading with their old values.
 *
 * This fixes it properly:
 *
 *   - every strategy parameter has a DEFAULT DEFINED IN CODE, right here,
 *     where it is version-controlled and visible
 *   - the persisted file supplies overrides, so anything changed from the
 *     dashboard still wins
 *   - STRATEGY_VERSION stamps the persisted file. When code ships a newer
 *     strategy version than the file carries, the strategy keys are reset to
 *     the new defaults once and the stamp is updated. Account-level settings -
 *     milestones, costs, sports, provider order, environment - are never
 *     touched by that migration.
 *
 * So a deploy that changes how the bot trades actually changes how the bot
 * trades, while everything the user set from the dashboard survives.
 */
import fs from "fs";
import path from "path";
import { CONFIG_DIR } from "./paths.js";

const CONFIG_PATH = path.join(CONFIG_DIR, "bot-config.json");

/** Bump this whenever a STRATEGY_KEYS default below changes meaningfully. */
export const STRATEGY_VERSION = 11;

/**
 * Keys the migration is allowed to reset. Anything not listed here is the
 * user's, and is preserved across every deploy.
 */
export const STRATEGY_KEYS = [
  "allowLiveGames", "holdToSettlement", "entryWindowHours", "minMinutesBeforeStart",
  "maxLineAgeSecondsLive", "maxLineAgeSecondsPregame",
  "minEntryPriceCents", "maxEntryPriceCents", "maxPlausibleEdge", "minEvCentsPerContract",
  "maxSpreadCents", "minLiquidity", "kellyFraction", "maxRiskPctPerTrade",
  "perPositionStopLossPct", "takeProfitPct", "trailingStopPct", "exitBelowCost",
  "blowoutExitBelowCents", "blowoutExitCollapsePct", "blowoutExitMaxSpreadCents",
  "ceilingExitAtCents", "ceilingExitMaxSpreadCents",
  "maxModelDisagreementPoints", "reentryCooldownMinutes",
  "dailyLossHaltPct", "feeMultiplier", "circuitBreakerFailures", "maxConcurrentPositions",
  "survivalMode", "milestoneTiers",
];

export const DEFAULTS = {
  environment: "production",
  confirmedProductionAt: null,

  // --- What the bot is allowed to trade ---------------------------------
  // LIVE GAMES ARE ON. There is no waiting period: if a game is running and
  // the book is quoting it, it is tradeable. An earlier build refused in-play
  // games on the assumption that the sharp line freezes at kickoff - that was
  // wrong, the odds feed serves live in-play prices.
  allowLiveGames: true,

  // The real guard, and the one that replaced it: quote freshness. A book that
  // has SUSPENDED its market leaves the last price on the wire, looking exactly
  // like a live quote, while the exchange keeps moving - and that gap reads as
  // a huge edge on a team that just fell behind. In play a quote older than
  // this is treated as suspended. Before kickoff a line legitimately sits
  // still, so the tolerance is wide.
  //
  // 180s was the single biggest blocker in production: real quotes from this
  // feed arrive 383s old, because the odds API refreshes on its own cadence
  // rather than per tick. The gate was measuring the FEED's publishing rhythm
  // and calling it a suspended market.
  //
  // It is also the weaker of two overlapping guards. A timestamp cannot tell
  // you a line is wrong - it only tells you when it was written. The in-game
  // model compares the line against the LIVE SCORE, which is what actually
  // caught HOU (sharp 40% vs model 16%) and PHI (86% vs 71%). That check does
  // the real work; this one now only rejects quotes so old they are obviously
  // abandoned.
  maxLineAgeSecondsLive: 900,        // 15 minutes
  maxLineAgeSecondsPregame: 7200,    // 2 hours

  // Hold to settlement. Kalshi charges a fee on every trade and nothing at
  // settlement, so a flip costs two fees and a hold costs one. Worth +4 to
  // +7c per contract at the prices traded here.
  holdToSettlement: true,

  // NO ENTRY WINDOW. Zero disables the look-ahead limit entirely: a line 12
  // hours before kickoff is still a real line, and the price band, edge bar and
  // EV floor already decide whether it is worth taking. The window was refusing
  // markets before any of those ever got to run - your logs showed tennis
  // dropping 2 of 10 lines on this alone.
  entryWindowHours: 0,
  minMinutesBeforeStart: 0,     // raise this to stop entering right on the whistle

  // --- Price band --------------------------------------------------------
  // THE OLD 25-88c BAND WAS BACKWARDS. It was set on "the fee dominates at low
  // prices", which compares the fee to the STAKE. The number that decides a
  // trade is EV against CAPITAL, and Kalshi's fee is a step function:
  //
  //     ceil(0.07 * p * (1-p) * 100)  =  1c for 1-17c and 83-99c
  //                                      2c for 18-82c
  //
  // (Algebraically: p(1-p) <= 1/7 at p <= 0.1727 and p >= 0.8273.)
  //
  // So the fee is CHEAPEST at both ends and most expensive in the middle. The
  // same flat 3-point edge returns, held to settlement:
  //
  //     15c   fee 1c   +12.5% on capital
  //     25c   fee 2c    +3.7%      <- the old floor
  //     50c   fee 2c    +1.9%
  //     90c   fee 1c    +2.2%      <- was blocked by the old ceiling
  //
  // The band was keeping only the expensive middle and refusing both cheap
  // zones. The ceiling moves to 97c, which is free: high prices are favourites,
  // where the sharp line and the exchange disagree least and devigging error is
  // smallest. It stops at 97 because ceilingExitAtCents is 97 - entering above
  // the level the bot immediately exits at would be a round trip for nothing.
  //
  // The floor moves to 12c rather than all the way to 1c, deliberately. A
  // devigging error of one point is 8% of a 12c price and 20% of a 5c price,
  // and required edge at 12c is only 1.5 points - so below about 10c the model
  // error is the same size as the edge being measured. Opening 1-11c needs a
  // book-quality gate (how many sharp books priced it, and how far apart they
  // were) that the entry gate does not read yet. Until then, 12c.
  minEntryPriceCents: 12,
  maxEntryPriceCents: 97,

  maxPlausibleEdge: 0.18,       // a wider gap than this is a stale feed, not an edge
  // Absolute EV floor per contract. Dropped from 2c to 1c: at $2 flat bets a
  // 1c edge on 5 contracts is 5c of expected value, which is small but real,
  // and the 2c floor was throwing away everything between break-even and there.
  minEvCentsPerContract: 1,
  maxSpreadCents: 6,            // a wide book means the quote is not a real price
  minLiquidity: 0,              // coverage is checked against order size, not an absolute

  // --- Sizing ------------------------------------------------------------
  kellyFraction: 0.25,
  maxRiskPctPerTrade: 0.20,
  maxConcurrentPositions: null, // null = use the milestone tier

  // --- Exits -------------------------------------------------------------
  // These three are deliberately null/false: each of them cost more in fees
  // than it ever saved in price. Kept as keys so the dashboard can show that
  // they are off on purpose rather than missing.
  perPositionStopLossPct: null,
  takeProfitPct: null,
  trailingStopPct: null,
  exitBelowCost: false,         // compared bid to entry; the bid is ALWAYS below entry right after buying

  // CEILING EXIT. Once a contract is bid at or above this, the trade is over -
  // there is almost no upside left, it is holding a slot the cap needs, and the
  // risk is absurdly one-sided: 5 contracts at 97c risk $4.85 to win $0.15, and
  // 3% of the time the whole $4.85 is gone. Selling costs exactly 1c per
  // contract anywhere in the 92-99c range, which redeploying more than covers.
  //
  // Set this to 99 to only take out near-certainties, or lower it toward 95 to
  // free capital sooner and carry less tail risk. The give-up is 1c either way.
  ceilingExitAtCents: 97,
  ceilingExitMaxSpreadCents: 3,

  // The one real exit: a rout. Deep enough that it fires on blowouts, not noise.
  //
  // It fired on HOU and lost money doing it: it sold 5 contracts at the 10c BID
  // while the ask was ~17c, taking $0.45 for something worth about $0.70 held.
  // Settlement is free; selling pays a fee AND the whole spread, which on a 10c
  // contract is proportionally enormous. So the exit now also requires a TIGHT
  // book - proof there is a real
