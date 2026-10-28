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
import { atomicWriteFileSync } from "./stateStore.js";

const CONFIG_PATH = path.join(CONFIG_DIR, "bot-config.json");

/** Bump this whenever a STRATEGY_KEYS default below changes meaningfully. */
export const STRATEGY_VERSION = 14;

/**
 * Keys the migration is allowed to reset. Anything not listed here is the
 * user's, and is preserved across every deploy.
 */
export const STRATEGY_KEYS = [
  "allowLiveGames", "holdToSettlement", "entryWindowHours", "minMinutesBeforeStart",
  "maxLineAgeSecondsLive", "maxLineAgeSecondsPregame",
  "minEntryPriceCents", "maxEntryPriceCents", "maxPlausibleEdge",
  "minEvCentsPerContract", "minEvCentsPerTrade", "entrySlippageCents", "maxWalkupCents",
  "maxSpreadCents", "minLiquidity", "kellyFraction", "maxRiskPctPerTrade",
  "perPositionStopLossPct", "takeProfitPct", "trailingStopPct", "exitBelowCost",
  "blowoutExitBelowCents", "blowoutExitCollapsePct", "blowoutExitMaxSpreadCents",
  "ceilingExitAtCents", "ceilingExitMaxSpreadCents", "ceilingExitOnlyWhenNeeded",
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
  maxLineAgeSecondsPregame: 900,     // 15 minutes (2026-09-30: same as in play)

  // Hold to settlement. Kalshi charges a fee on every trade and nothing at
  // settlement, so a flip costs two fees and a hold costs one. Worth +4 to
  // +7c per contract at the prices traded here.
  holdToSettlement: true,

  // NO ENTRY WINDOW. Zero disables the look-ahead limit entirely: a line 12
  // hours before kickoff is still a real line, and the price band, edge bar and
  // EV floor already decide whether it is worth taking. The window was refusing
  // markets before any of those ever got to run - your logs showed tennis
  // dropping 2 of 10 lines on this alone.
  entryWindowHours: 1,          // 60 minutes (2026-10-01): pre-game buys only this close to the start
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
  // zones. Raising the ceiling is nearly free: high prices are favourites, where
  // the sharp line and the exchange disagree least and devigging error is
  // smallest.
  //
  // The floor moves to 12c rather than all the way to 1c, deliberately. A
  // devigging error of one point is 8% of a 12c price and 20% of a 5c price,
  // and required edge at 12c is only 1.5 points - so below about 10c the model
  // error is the same size as the edge being measured. Opening 1-11c needs a
  // book-quality gate (how many sharp books priced it, and how far apart they
  // were) that the entry gate does not read yet. Until then, 12c.
  minEntryPriceCents: 35,
  // 95, not 97. ceilingExitAtCents is 97 and the take-out test is `bid >= 97`,
  // so a position entered at a 97c ask was eligible for its own exit the moment
  // the bid ticked up one cent. Demonstrated end to end: buy 97c x3, bid moves
  // 96 -> 97, sold at 96c, round trip -9c against -3c for simply holding. The
  // entry band now stops two cents clear of the exit trigger.
  maxEntryPriceCents: 92,      // 2026-10-03: favorites up to 92c (win chance 65%+ rule)

  maxPlausibleEdge: 0.18,       // a wider gap than this is a stale feed, not an edge

  // THE EV FLOOR IS NOW PER TRADE, NOT PER CONTRACT.
  //
  // A per-contract floor applied the same number to a 14-contract position at
  // 12c and a 1-contract position at 95c. One of those is 14c of expected
  // value and the other is 1c. Measured across the band, that floor also
  // demanded MORE edge than the edge threshold at every single price, so the
  // edge threshold was dead code and tuning it did nothing.
  minEvCentsPerContract: 0,     // off - kept as a key so an old config still loads
  minEvCentsPerTrade: 1,        // the trade, as a whole, must expect at least a cent

  // THE ORDER LIMIT IS THE BAR, NOT THE ASK PLUS A FIXED CENT.
  //
  // The entry limit is now the HIGHEST price at which the edge still clears the
  // fee plus the buffer, capped at this many cents above the ask. The trade is
  // then judged at that limit - the worst fill it can take - so a fill anywhere
  // inside the band still clears every gate by construction. Verified over 5,310
  // (ask, sharp, fill) combinations across the whole band: zero fills with
  // expected value at or below zero.
  //
  // This is free because Kalshi is a central limit order book and a taker pays
  // the MAKER's price: a limit buy at 52c against resting offers at 49/50/51
  // fills at 49, 50 and 51. The walk-up costs nothing when the book is where it
  // was seen, and only pays up when it has genuinely moved.
  //
  // 4c is deliberate. A limit ten cents above the screen price is not patience,
  // it is an invitation to be picked off by a book that has gone stale.
  maxWalkupCents: 4,

  // Fallback only. Used when a caller has no walk-up limit to work from - the
  // executor still needs SOMETHING above the ask or an immediate-or-cancel
  // order quotes the ask exactly and expires unfilled.
  entrySlippageCents: 1,

  // THE SPREAD GATE WAS A LEFTOVER FROM WHEN THIS BOT FLIPPED POSITIONS.
  //
  // At 6c it refused 18 of 92 lines in a single scan - a fifth of the board -
  // for a risk that does not apply to a position held to settlement.
  //
  // The bot buys YES by selling NO to a resting bidder, so an "ask" of 49c
  // derived from a 51c NO bid is a REAL, fillable order, not an estimate. And
  // the value of holding it does not depend on the book at all:
  //
  //     EV = p*100 - price - fee
  //
  // The spread does not appear in that expression, because settlement is FREE
  // and pays 100 or 0 whatever the book looks like at the time. Measured at a
  // 56% sharp line against a 49c fill, EV held is +5.0c per contract at a 2c
  // spread and +5.0c at a 29c spread - identical. It is only selling back that
  // a wide book punishes, and the two exits that sell already carry their own
  // spread guards (3c on the ceiling exit, 2c on the blowout).
  //
  // Liquidity is still checked, separately and properly: passesLiquidityFilter
  // requires 1.5x the order size resting at the price. That is the real guard.
  //
  // 25c rather than off entirely - a spread wider than that suggests the sharp
  // line and this Kalshi market may not be pricing the same thing.
  maxSpreadCents: 25,
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
  // v14: only take the ceiling exit when the slot or the cash is actually
  // needed (at the position cap, or cash below one stake). Otherwise hold -
  // settlement pays the same 100c without the 1c/contract exit fee. The nine
  // ceiling exits to date (96-99c) all sold with free slots available.
  ceilingExitOnlyWhenNeeded: true,

  // The one real exit: a rout. Deep enough that it fires on blowouts, not noise.
  //
  // It fired on HOU and lost money doing it: it sold 5 contracts at the 10c BID
  // while the ask was ~17c, taking $0.45 for something worth about $0.70 held.
  // Settlement is free; selling pays a fee AND the whole spread, which on a 10c
  // contract is proportionally enormous. So the exit now also requires a TIGHT
  // book - proof there is a real buyer near fair value, not a void to dump into.
  //
  // Lowered from 12c because minEntryPriceCents is now 12c. Leaving both at 12
  // would mean a position entered at the floor sat one tick away from its own
  // exit trigger, and any ordinary dip would sell it at a fee plus the spread.
  blowoutExitBelowCents: 7,
  blowoutExitCollapsePct: 0.6,
  blowoutExitMaxSpreadCents: 2,

  // How far an in-play sharp line may sit from the in-game model before it is
  // treated as a stale pre-game number rather than a live quote.
  maxModelDisagreementPoints: 12,

  // v14: 60 -> 360. A game the bot has already exited stays off-limits for the
  // rest of that game, not just an hour - a baseball or soccer match can still
  // be live 60 minutes after an exit, and buying back in pays a second entry fee
  // on a thesis the bot already closed.
  reentryCooldownMinutes: 360,
  dailyLossHaltPct: 0.15,
  feeMultiplier: 0.07,
  circuitBreakerFailures: 3,

  // Survival mode: flat bets and a stricter edge bar at a small balance.
  //
  // The concurrency cap was 3, and that number was chosen when the bot FLIPPED
  // positions - a slot freed up in minutes, so it was never the binding
  // constraint. Holding to settlement changed that completely: a slot is now
  // occupied for a whole game, three-plus hours. On a full Sunday slate the bot
  // filled all three slots in minutes and then logged "at the concurrent
  // position cap" every twenty seconds for the rest of the afternoon, with
  // $12.89 of $18.89 sitting idle through the busiest window of the week.
  //
  // Ten slots at $1.75, up from six at $2. Near-identical capital at risk,
  // spread across ten independent games instead of six. With a small edge per
  // trade, what turns that edge into a reliable return is the NUMBER of
  // independent bets, not the size of any one of them - six slots were filling
  // within minutes of a full slate and then sitting at the cap while the rest
  // of the board went untraded.
  //
  // At ~$20 tradable this deploys up to $17.50 and keeps a small buffer. On a
  // smaller balance the one-contract floor still applies, so fewer slots simply
  // fill rather than any order being rejected.
  survivalMode: {
    balanceThreshold: 40,
    flatBetDollars: 1.75,
    maxConcurrentPositions: 10,
    // Was 1.25. The strategy has produced +37.6% ROI over 18 completed trades,
    // so taxing every survival-mode entry by a further 25% of required edge was
    // no longer buying safety - it was the difference between a 2.5% bar and a
    // 3.1% one on trades that already clear break-even.
    edgeMultiplier: 1.0,
  },

  // A held position ties up its slot for the length of a game, so concurrency
  // is the throughput limit, not stake size.
  //
  // These caps used to go DOWN as the balance went up - 12 slots at $40, then
  // 10 at $100; 14 at $500, then 12 at $2,500. Crossing a milestone would have
  // REDUCED how many games the bot could hold at once, which is backwards and
  // would have looked exactly like the bot mysteriously slowing down after a
  // good run. They are monotonic now.
  milestoneTiers: [
    { at: 0,     kellyFraction: 0.25, maxConcurrentPositions: 10, maxStakeDollars: 3,   reservePct: 0.00 },
    // First tier clear of survival mode: real Kelly sizing, more slots, because
    // the constraint above $40 is opportunity rather than ruin.
    { at: 40,    kellyFraction: 0.25, maxConcurrentPositions: 12, maxStakeDollars: 8,   reservePct: 0.00 },
    { at: 100,   kellyFraction: 0.25, maxConcurrentPositions: 14, maxStakeDollars: 15,  reservePct: 0.10 },
    { at: 500,   kellyFraction: 0.25, maxConcurrentPositions: 16, maxStakeDollars: 50,  reservePct: 0.20 },
    { at: 2500,  kellyFraction: 0.30, maxConcurrentPositions: 18, maxStakeDollars: 200, reservePct: 0.30 },
    { at: 10000, kellyFraction: 0.30, maxConcurrentPositions: 20, maxStakeDollars: 600, reservePct: 0.40 },
  ],

  // --- 2026-09-24: fair-value exits, CLV kill switch, earned sizing --------
  // Added WITHOUT a strategy-version bump on purpose: a bump would reset every
  // strategy key to its default and wipe dashboard edits. New keys reach a
  // running instance through the {...DEFAULTS, ...stored} merge on their own.
  //
  // "shadow" logs every sell it WOULD make, with real numbers, and sells
  // nothing. Set to "live" once the shadow decisions check out in the Kalshi
  // app. "off" disables it.
  fairValueExit: "shadow",
  fairValueExitMarginCents: 2,     // sell only when the bid beats fair by this much after fees
  fairValueMaxAgeSeconds: 420,     // sharp reading older than this -> no exit decision

  clvKillSwitch: true,             // false = measure and report, never block
  clvKillMode: "report",           // "report" = measure only (settled results decide cuts); "block" = old gate
  clvMinSample: 15,                // marks a segment needs before it can be killed or proven
  clvZ: 1.0,                       // standard errors of confidence for kill / proven
  clvKillBelowCents: 0,            // kill when mean CLV + z*SE is below this
  clvReviveAboveCents: 0,          // revive when shadow mean CLV since the kill reaches this
  clvLiveHorizonMinutes: 5,        // in-play mark taken this long after the fill
  clvMaxMarkSpreadCents: 10,       // wider book than this gives no mid - retried, never guessed
  clvMarksPerCycle: 20,
  clvGatedSizing: true,            // Kelly only on sports with proven CLV; flat stake elsewhere

  // Sports never scanned. MMA is off until the UFC side inversion is fixed:
  // KXUFCFIGHT-...AMAMAC-MAC priced at 68c against a 27.8% sharp line.
  // 2026-10-02 (account holder's call): tennis and EuroLeague off. Tennis at
  // the China/Japan Opens went 1-9 (-$30.6), EuroLeague 1-5 (-$11.97).
  // An entry ending in "*" is a prefix (sportRules.js): "tennis_*" covers
  // every tournament key. Delete an entry to turn that sport back on.
  disabledSports: ["mma_mixed_martial_arts", "tennis_*", "basketball_euroleague"],

  // PAPER-ONLY SPORTS (2026-10-13, sportRules.js paperOnlySport). Still
  // scanned and scored by the paper strategies (paperTrader.js), but no real
  // buy on either exchange - Polymarket only copies Kalshi's trades. Same
  // "*" prefix rule as disabledSports. Delete an entry to trade it again.
  paperOnlySports: [],

  // FLIP SPORTS (2026-10-13, flipTrader.js). The normal formula runs; when it
  // picks a team, the OTHER team in that game is bought instead, same stake.
  flipSports: [],

  // PER-SPORT PRICE FLOOR (2026-10-02, sportRules.js). Raised over the normal
  // band for that sport only, pre-game and live, both exchanges, resting bids
  // included. NHL (regular + preseason, Kalshi): entries under 45c won 2 of
  // 13; at 45c and up, 4 of 5.
  sportMinEntryCents: { icehockey_nhl: 45, icehockey_nhl_preseason: 45 },

  // FAIR SHRINK (2026-10-02, sportRules.js). Share of the model's edge
  // (fair - price) treated as real for limits, sizing and expected return.
  // Kalshi realized 48% of the edge it claimed over the 44 trades that
  // recorded one, so 0.5. The 18% plausibility gate still reads the RAW edge.
  // 1 = off.
  fairShrink: 0.5,

  // LIVE GAMES ONLY (2026-09-23). The account's own record, 59 closed trades:
  //   live      32 trades, 18 won, +$12.99
  //   pre-game  27 trades,  7 won, -$10.03  (-$9.13 excluding the old flipping)
  // Pre-game Kalshi prices sit at the sharp line; the edge is Kalshi lagging
  // the sharp books DURING play. Pre-game buys and pre-game resting bids are
  // off. Set to false to allow pre-game entries again.
  // 2026-09-30: ALL SPORTS, LIVE OR WITHIN 10 MINUTES OF START. liveOnly false
  // lets a game that has not started be bought, but entryWindowHours (below)
  // limits that to the last 10 minutes before the start, when the sharp line
  // is at its most accurate. Earlier pre-game entries lost (-28% over 21).
  liveOnly: false,

  // PRE-POLYMARKET RULE (2026-10-01): a live game with no live score is not
  // bought, as before 2026-09-29. true = trade it on a fresh sharp line.
  tradeWithoutLiveScore: false,

  // PRE-GAME HARD STOP (2026-10-01) - scanner.js pregameStopStatus. After this
  // many pre-game LOSSES in a day (Pacific), no more pre-game buys that day;
  // never more than maxOpen pre-game positions at once. Live buys unaffected;
  // the whole bot still halts at dailyLossHaltPct.
  pregameStop: { maxLossesPerDay: 2, maxOpen: 3 },

  // PRE-GAME WAITING PERIOD (2026-10-01) - pregameConfirm.js. A pre-game edge
  // is bought only once the same side has qualified on minScans consecutive
  // reads over minMinutes, and the sharp line has not drifted more than
  // maxDriftPoints away from that side. Both exchanges. Live games unaffected.
  // live (2026-10-01): the same wait for live games - 4 reads over 2+ minutes,
  // fair value may not drop 3+ points (a score against the side restarts it).
  // 2026-10-03 (account holder): evaluate for 1 minute, enter within 2 -
  // 3 reads over 1+ minute, the price reader waits at most 2 minutes for the low.
  pregameConfirm: {
    enabled: true, minScans: 3, minMinutes: 1, maxGapSeconds: 180, maxDriftPoints: 2,
    live: { enabled: true, minScans: 3, minMinutes: 1, maxGapSeconds: 90, maxDriftPoints: 3 },
    reader: { enabled: true, toleranceCents: 1, maxWatchMinutes: 2 },
  },

  // RESTING BIDS (makerEngine.js). allowLive (2026-10-01): in live games too -
  // a bid at the price that returns minExpectedReturnPct, max 2 at once, half
  // stake, 5-minute life, re-confirmed every scan.
  maker: { enabled: true, allowLive: true, liveStakeFactor: 1 },   // 2026-10-03 night: resting bids full stake (was half)

  // MODELLED SPORTS ONLY (2026-09-30): new live buys only in sports with a
  // calibrated in-game model (liveModel.js SPORT_PARAMS). Tennis, preseason and
  // minor leagues ran on a generic model and lost. Held positions in any sport
  // are still managed and sold. Set false to allow every sport again.
  // 2026-09-30: restored to false with the original Kalshi rules - every sport
  // trades as it did before. Set true to buy only modelled sports.
  modeledSportsOnly: false,

  // TRADE LIST (2026-09-30, from the account's own settled trades): new buys
  // only in these sports. 128 closed trades: football 33 trades +$45.97 (+59%
  // ROI, 55% win rate); every other sport together 95 trades -$23.97 (-10%,
  // 41% win rate) - MLB 35 trades -$10.37, tennis -$20.6, preseason NHL
  // -$9.70, Euroleague -$11.97. Held positions in any sport are still managed.
  // Empty list = every sport (subject to modeledSportsOnly). Left EMPTY from
  // 2026-09-30 (account holder: all sports on the odds feed trade); fill it to
  // restrict buying to those sports again.
  entrySports: [],

  // Live buys under this price are refused - see scanner.js (all three live
  // buys at 13-16c lost; the fee is 20-40% of the stake down there).
  minLiveEntryPriceCents: 20,

  // STAKE AND RETURN FLOOR (2026-09-25, account holder's call).
  //   flatStakeDollars: every entry sized to this stake (null = old sizing)
  //   minExpectedReturnPct: skip any trade expected to return less than this
  //     percent of what it risks, after fees (10%, account holder's call)
  flatStakeDollars: 5,          // 2026-10-05: back to $5 (account holder; was $8 from 2026-10-03)

  // LEARNING + WIN-RATE FOCUS (2026-09-25) - see outcomeLearner.js
  // 2026-09-29: 35-70c -> 25-80c (account holder: live games get traded).
  // The account's settled live record: 25-80c 80 trades +$57.97 (+25.1% ROI),
  // 35-70c 62 trades +$54.23 (+26.7%) - same return, 18 more trades.
  liveBandMinCents: 35,          // live buys only between these prices (restored 2026-09-30)
  liveBandMaxCents: 92,         // 2026-10-03: live favorites up to 92c
  streakBrakeLosses: 4,          // halve the stake after this many straight losses
  survivalStartingSlots: 3,      // positions at once in survival mode until earned
  learnerMinTrades: 8,           // trades a sport/band needs before it can be cut
  // 2026-09-29: 30% -> 10% (account holder's call). Every trade must expect
  // at least 10% after the exchange fee, and the order limit is pulled down
  // to the highest price that still returns 10% - so the walk-up never buys
  // a thin edge (at 0% the Red Sox limit was 32c for 1.7% expected; at 10%
  // it is 29c, the ask, for 12.4%). The account's settled live record by
  // expected return at entry:
  //   0-5%    28 trades +$10.89 (+27.0% ROI)
  //   5-10%    7 trades  +$6.23 (+53.4%)
  //   10-20%   7 trades  +$4.51 (+38.3%)
  //   20-30%   8 trades  -$1.10  (-8.3%)
  //   30%+    37 trades +$37.90 (+23.0%)
  // The 30% floor refused the 10-30% trades and cut entries to 1-2 a day.
  // 2026-09-30: RESTORED to 30% - the original Kalshi rule (see the one-time
  // update "2026-09-30-restore-original-kalshi" below).
  // 2026-10-02: 12.5% on the SHRUNK fair value (fairShrink 0.5) - the same
  // trades the 30% raw rule took (worked through at 35, 40 and 60c), now
  // priced on the edge the account actually realizes.
  // 2026-10-02 (night, account holder's call): 5% on the shrunk fair value =
  // +5% expected profit after fees on the edge the account actually keeps
  // (about 13-15% on the raw model edge). The account's settled record by
  // expected return at entry shows the higher bar bought nothing extra:
  //   0-5% 28 trades +27% ROI | 5-10% 7 +53% | 10-20% 7 +38% | 20-30% 8 -8% | 30%+ 37 +23%
  // 2026-10-03: the dip lane's minimum (see lanes below) and the resting
  // bids' minimum. Trades are bought best expected return first and labelled
  // by tier (65% / 30% / 15% / 5% / 2%, sportRules.js RETURN_TIERS).
  minExpectedReturnPct: 5,

  // TWO TRADE LANES (2026-10-03, account holder: keep every strategy, priority
  // on profit) - sportRules.js. Kalshi record by entry price: 35-49c 72 trades
  // +$35.91; 50-69c 20 trades -$4.67; 70c+ 7 trades -$2.35.
  //   dip:      35-49c, any win chance, 5% minimum expected return
  //   favorite: 65%+ to win, up to 92c, 0.5% minimum expected return (any real profit)
  //   middle:   50-92c under 65% to win, 0.5-8% expected return (8%+ at these
  //             prices: 4 trades, 1 won, -$12.49; 0-8%: 14 trades, 11 won, +$6.10)
  // enabled: false switches a lane off.
  lanes: {
    dip: { enabled: true, minCents: 35, maxCents: 49, minReturnPct: 5 },
    favorite: { enabled: true, minWinProbability: 0.65, maxCents: 92, minReturnPct: 0.5 },
    middle: { enabled: true, minCents: 50, maxCents: 92, minReturnPct: 0.5, maxReturnPct: 8 },
  },

  // STAKE TIERS + DOUBLE-DOWN (2026-09-26, account holder's call) - scaling.js
  //   stakeTiers: equity thresholds. x = multiple of flatStakeDollars,
  //     pct = share of equity (keeps climbing). Steps back down if equity falls.
  //     [] = no tiers, flat stake only.
  //   stakeMaxDollars: hard ceiling on any single stake.
  //   doubleDown: one more stake on a held live game whose team has stayed
  //     ahead for leadScans scans / leadMinutes, only at minReturnPct+ expected.
  //     false switches it off.
  stakeTiers: [
    { at: 0, x: 1 },        // under $75: $5
    { at: 75, x: 1.5 },     // $7.50
    { at: 150, x: 2 },      // $10
    { at: 300, x: 3 },      // $15
    { at: 500, x: 5 },      // $25
    { at: 1000, pct: 0.03 },// 3% of equity: $30 at $1,000, $60 at $2,000
  ],
  stakeMaxDollars: 500,
  doubleDown: { enabled: true, minReturnPct: 15, leadScans: 3, leadMinutes: 5 },   // 15% shrunk = 35% raw

  // POLYMARKET US (2026-09-27) - polymarket/pmEngine.js. Same strategy as
  // Kalshi on a second exchange, one bet per game across both.
  //   enabled: connect and self-check whenever keys are present
  //   trading: "auto" = trade once the live self-check passes; "on"; "off"
  //   no limit on open Polymarket bets (removed 2026-09-28, account holder's
  //   call) - cash on the account is the only limit, as on Kalshi
  // 2026-09-30: trading "off" - connected and visible, no buying (account holder).
  // 2026-10-01: "auto" - same rules as Kalshi (account holder).
  // 2026-10-02: entrySports - new Polymarket buys only in these sports
  // (Kalshi's settled winners: NFL 13-6 +$31.64, NCAAF +$14.33). [] = all.
  // A game held on one exchange is never bought on the other.
  polymarket: { enabled: true, trading: "auto", shortSide: "auto", entrySports: ["americanfootball_nfl", "americanfootball_ncaaf"], mirrorKalshi: true, mirrorMaxExtraCents: 2, mirrorMaxMinutes: 10, mirrorMaxBelowCents: 5, flatStakeDollars: 3.5,
    // Polymarket stake tiers (2026-10-03 night, account holder): $2.50 under $50,
    // $5 at $50, $7.50 at $100, $10 at $150, $15 at $300, $25 at $500, 3% from $1,000.
    stakeTiers: [{ at: 0, x: 1 }, { at: 50, x: 10 / 7 }, { at: 100, x: 15 / 7 }, { at: 150, x: 20 / 7 }, { at: 300, x: 30 / 7 }, { at: 500, x: 50 / 7 }, { at: 1000, pct: 0.03 }] },

  // IN-GAME SWING TRADING (2026-09-29, account holder's plan) - swingEngine.js.
  // Buy the dip (price under what the score and clock say the team is worth),
  // sell the rally, repeat as many times as the game allows. On BOTH exchanges.
  //   halfAtFair: sell half once the bid, after the sell fee, is back at fair
  //     value and the sale is a profit
  //   targetPct: sell the rest at +65% on what was paid, fees included
  //   blowoutBelowPct: sell everything when score + clock give the team under
  //     this chance AND the market agrees (mid at or under
  //     blowoutMarketMaxCents); close games are ridden out
  //   reentryMinutes: a fully sold game can be bought again after this
  //     cool-off (reentryCooldownMinutes applies only with swing off)
  //   dailyGoalPct: the daily profit goal, % of start-of-day equity (Pacific
  //     day), shown on the Trading Desk - tracked, it never stops trading
  //   enabled: false = the old behaviour (hold to settlement)
  // 2026-09-30: enabled false - hold to settlement, as originally.
  // 2026-10-01: OFF (account holder) - every position is held to the end of
  // the game, win or loss.
  swing: {
    enabled: false,
    halfAtFair: true,
    targetPct: 65,
    blowoutBelowPct: 10,
    blowoutMarketMaxCents: 20,
    minProfitCents: 1,
    reentryMinutes: 3,
    dailyGoalPct: 40,
  },

  // --- Account-level, never touched by the strategy migration ------------
  oddsProviderOrder: ["the-odds-api", "oddspapi"],
  oddsPapiTournamentIds: {},
  scanIntervalMinutes: 15,
  nonSportsEnabled: false,
  autoStartOnBoot: true,
  milestones: [100, 500, 1000, 5000, 10000, 50000],
  monthlyCosts: { hosting: 25, oddsApi: 129, other: 0 },
};

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeRaw(obj) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // 2026-10-04: temp file + rename - a restart mid-write can never leave a
  // half-written config (which would read as {} and wipe dashboard settings).
  atomicWriteFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2));
}

/**
 * ONE-TIME SETTING UPDATES. Each runs once per volume (its id is recorded in
 * the saved file) and changes ONLY the keys it names - every other saved
 * setting is left exactly as it is. A value changed by hand afterwards is
 * never touched again.
 */
const ONE_TIME_UPDATES = [
  {
    id: "2026-09-29-trade-every-live-edge",
    apply: (c) => {
      c.minExpectedReturnPct = 0;
      c.liveBandMinCents = 25;
      c.liveBandMaxCents = 80;
    },
    note: "minimum expected return 30% -> 0% (any positive edge after fees), live price band 35-70c -> 25-80c",
  },
  {
    // Runs after the one above (on a volume that already ran it, only this
    // one runs): the account holder chose 10%, bought at the ask.
    id: "2026-09-29-min-return-10-at-ask",
    apply: (c) => { c.minExpectedReturnPct = 10; },
    note: "minimum expected return -> 10% after fees; the order never pays above the price that still returns 10%",
  },
  {
    // RESTORE THE ORIGINAL KALSHI RULES (2026-09-30, account holder's call).
    // The Kalshi-only record before Polymarket and the swing exits: Sep 20-26,
    // 89 closed trades, +$51 net. Runs last, so it wins on a fresh volume too.
    id: "2026-09-30-restore-original-kalshi",
    apply: (c) => {
      c.minExpectedReturnPct = 30;
      c.liveBandMinCents = 35;
      c.liveBandMaxCents = 70;
      c.modeledSportsOnly = false;
      c.swing = { ...DEFAULTS.swing, ...(c.swing || {}), enabled: false };
      c.polymarket = { ...DEFAULTS.polymarket, ...(c.polymarket || {}), trading: "off" };
    },
    note: "original Kalshi rules restored: 30% minimum return, 35-70c live band, hold to settlement (swing off), Polymarket buying off",
  },
  {
    id: "2026-09-30-football-only",
    apply: (c) => { c.entrySports = ["americanfootball_nfl", "americanfootball_ncaaf"]; },
    note: "new buys only in NFL and NCAAF, the sports with a proven record on this account",
  },
  {
    // 2026-09-30, account holder's call: every sport on the odds feed trades;
    // pre-game only in the last 10 minutes before the start; early exits on.
    // The account's settled record: held to settlement +2.0% over 91 trades,
    // exited early +24.0% over 37; in play +10.2% over 107, pre-game -28.4%
    // over 21 (all of it earlier than 10 minutes out).
    id: "2026-09-30-all-sports-pregame-10min",
    apply: (c) => {
      c.entrySports = [];
      c.modeledSportsOnly = false;
      c.liveOnly = false;
      c.entryWindowHours = 1 / 6;
      c.maxLineAgeSecondsPregame = 900;
      c.minEntryPriceCents = 35;
      c.maxEntryPriceCents = 70;
      c.swing = { ...DEFAULTS.swing, ...(c.swing || {}), enabled: true };
    },
    note: "all sports; pre-game buys only in the last 10 minutes before the start; price band 35-70c; early exits (swing) on",
  },
  {
    // BACK TO THE PRE-POLYMARKET EDGE (2026-10-01, account holder's call):
    // Kalshi only, buy and hold to the end of the game (no swing selling),
    // 30% minimum expected return, 35-70c, no live buy without a live score,
    // every sport. Pre-game buys open in the last 10 minutes, behind the
    // pre-game hard stop. Daily halt stays at 15%.
    id: "2026-10-01-pre-polymarket-edge",
    apply: (c) => {
      c.swing = { ...DEFAULTS.swing, ...(c.swing || {}), enabled: false };
      c.polymarket = { ...DEFAULTS.polymarket, ...(c.polymarket || {}), trading: "off" };
      c.minExpectedReturnPct = 30;
      c.liveBandMinCents = 35;
      c.liveBandMaxCents = 70;
      c.minEntryPriceCents = 35;
      c.maxEntryPriceCents = 70;
      c.entrySports = [];
      c.modeledSportsOnly = false;
      c.liveOnly = false;
      c.entryWindowHours = 1 / 6;
      c.tradeWithoutLiveScore = false;
      c.pregameStop = { maxLossesPerDay: 2, maxOpen: 3 };
      c.holdToSettlement = true;
      c.blowoutExit = false;
      c.fairValueExit = "shadow";
      c.dailyLossHaltPct = 0.15;
    },
    note: "pre-Polymarket edge: Kalshi only, hold every position to the end, 30% min return, 35-70c, live buys need a live score, all sports; pre-game in the last 10 min with a hard stop (2 losses/day, 3 open)",
  },
  {
    // POLYMARKET ON THE SAME RULES AS KALSHI (2026-10-01, account holder's
    // call): every rule above applies to Polymarket too (pmEngine.js) - hold
    // to the end, 30% min return, 35-70c, live score required, pre-game hard
    // stop counted on Polymarket's own trades, survival-mode cap, stake tiers
    // from Polymarket's own equity, its own 15% daily halt. "auto" trades once
    // the live self-check passes.
    id: "2026-10-01-polymarket-same-rules",
    apply: (c) => { c.polymarket = { ...DEFAULTS.polymarket, ...(c.polymarket || {}), trading: "auto" }; },
    note: "Polymarket trading back on (auto) under the same rules as Kalshi",
  },
  {
    // LIVE RESTING BIDS ON KALSHI (2026-10-01, account holder's call) -
    // makerEngine.js. Settings not named here keep their defaults there.
    id: "2026-10-01-live-resting-bids",
    apply: (c) => { c.maker = { ...(c.maker || {}), enabled: true, allowLive: true }; },
    note: "Kalshi live resting bids on: bid at the price that returns the 30% minimum, max 2 at once, half stake, 5-minute life",
  },
  {
    // PRE-GAME WINDOW 60 MINUTES (2026-10-01, account holder's call), both
    // exchanges - they share entryWindowHours. Every other pre-game rule is
    // unchanged: 30% min return, 35-70c, line under 15 minutes old, the
    // pre-game hard stop (2 losses a day, 3 open), the 15% daily halt.
    id: "2026-10-01-pregame-60min",
    apply: (c) => { c.entryWindowHours = 1; },
    note: "pre-game buys open 60 minutes before the start, on Kalshi and Polymarket",
  },
  {
    id: "2026-10-01-pregame-waiting-period",
    apply: (c) => { c.pregameConfirm = { enabled: true, minScans: 3, minMinutes: 3, maxGapSeconds: 180, maxDriftPoints: 2 }; },
    note: "pre-game waiting period: same side must qualify on 3 reads over 3+ minutes, line not drifting more than 2 pts away",
  },
  {
    id: "2026-10-01-live-waiting-period",
    apply: (c) => {
      c.pregameConfirm = { ...(c.pregameConfirm || {}), live: { enabled: true, minScans: 4, minMinutes: 2, maxGapSeconds: 90, maxDriftPoints: 3 } };
    },
    note: "live waiting period: same side must qualify on 4 reads over 2+ minutes, fair value not dropping 3+ pts; candidates tried best expected return first",
  },
  {
    // FIX ORDER 1-5 (2026-10-02, account holder's call), from the 138-trade
    // export: one exchange per game (code: scanner.js / pmEngine.js),
    // Polymarket buys only NFL + NCAAF, tennis and EuroLeague off, NHL floor
    // 45c, fair value shrunk to the realized 50% with the return floors
    // re-set so the same trades qualify. Every other setting is untouched.
    id: "2026-10-02-fix-order-1-5",
    apply: (c) => {
      const off = new Set(Array.isArray(c.disabledSports) ? c.disabledSports.map(String) : ["mma_mixed_martial_arts"]);
      off.add("tennis_*");
      off.add("basketball_euroleague");
      c.disabledSports = [...off];
      c.polymarket = { ...DEFAULTS.polymarket, ...(c.polymarket || {}), entrySports: ["americanfootball_nfl", "americanfootball_ncaaf"] };
      c.sportMinEntryCents = { ...(c.sportMinEntryCents || {}), icehockey_nhl: 45, icehockey_nhl_preseason: 45 };
      c.fairShrink = 0.5;
      c.minExpectedReturnPct = 12.5;
      if (c.doubleDown !== false) c.doubleDown = { ...DEFAULTS.doubleDown, ...(c.doubleDown || {}), minReturnPct: 15 };
    },
    note: "one exchange per game; Polymarket buys NFL + NCAAF only; tennis + EuroLeague off; NHL floor 45c; fair value shrunk 50% (min return 12.5% shrunk = 30% raw, double-down 15% = 35% raw)",
  },
  {
    // MINIMUM RETURN 5% ON THE REALIZED EDGE (2026-10-02 night, account
    // holder's call). Both exchanges and resting bids read this one key.
    // Every other filter is unchanged: live score required, price reader,
    // 35-70c band, NHL 45c floor, plausibility gate, daily halt.
    id: "2026-10-02-min-return-5-shrunk",
    apply: (c) => { c.minExpectedReturnPct = 5; },
    note: "minimum expected return 12.5% -> 5% on the shrunk (realized) fair value - about 13-15% on the raw model edge",
  },
  {
    // THREE LANES (2026-10-03, account holder's call): the proven dip lane
    // (35-49c, 5% min), a middle lane (50-92c, 0.5-8%) and a favorite lane (65%+ to win, up to 92c, 0.5% min),
    // ranked by expected return - best first; evaluate 1 minute, enter within 2.
    // Both exchanges. Live score, model pricing, NHL floor, plausibility cap
    // and daily halt unchanged.
    id: "2026-10-03-three-lanes",
    apply: (c) => {
      c.lanes = {
        dip: { enabled: true, minCents: 35, maxCents: 49, minReturnPct: 5 },
        favorite: { enabled: true, minWinProbability: 0.65, maxCents: 92, minReturnPct: 0.5 },
        middle: { enabled: true, minCents: 50, maxCents: 92, minReturnPct: 0.5, maxReturnPct: 8 },
      };
      c.minExpectedReturnPct = 5;
      c.maxEntryPriceCents = 92;
      c.liveBandMaxCents = 92;
      c.pregameConfirm = {
        ...(c.pregameConfirm || {}),
        enabled: true, minScans: 3, minMinutes: 1,
        live: { ...((c.pregameConfirm || {}).live || {}), enabled: true, minScans: 3, minMinutes: 1 },
        reader: { ...((c.pregameConfirm || {}).reader || {}), enabled: true, toleranceCents: 1, maxWatchMinutes: 2 },
      };
    },
    note: "three lanes: dip 35-49c (5% min), middle 50-92c (0.5-8%), favorite 65%+ to win up to 92c (0.5% min); best expected return first (tiers 65/30/15/5/2/0.5%); evaluate 1 min, enter within 2",
  },
  {
    // BIGGER KALSHI BETS + POLYMARKET MIRRORS KALSHI (2026-10-03 night,
    // account holder's call). Kalshi: base stake $5 -> $8 (tiers scale from it:
    // $12 at $75 equity, $16 at $150 ...) and live resting bids at the full
    // stake instead of half - nothing else on Kalshi changes. Polymarket: copies
    // every Kalshi position (same team, same game) at no more than 2c above
    // Kalshi's fill, on its own stake tiers ($2.50 under $50, $5 at $50, $7.50
    // at $100, $10 at $150, $15 at $300, $25 at $500, 3% from $1,000). The losing-streak brake
    // (half stake after 4 straight losses) still applies to both.
    id: "2026-10-03-kalshi-8-pm-mirror",
    apply: (c) => {
      c.flatStakeDollars = 8;
      c.maker = { ...(c.maker || {}), liveStakeFactor: 1 };
      c.polymarket = { ...DEFAULTS.polymarket, ...(c.polymarket || {}), mirrorKalshi: true, mirrorMaxExtraCents: 2, flatStakeDollars: 2.5, stakeTiers: [{ at: 0, x: 1 }, { at: 50, x: 2 }, { at: 100, x: 3 }, { at: 150, x: 4 }, { at: 300, x: 6 }, { at: 500, x: 10 }, { at: 1000, pct: 0.03 }] };
    },
    note: "Kalshi base stake $8 (was $5), resting bids full stake; Polymarket mirrors every Kalshi position (same team, <= 2c above Kalshi's price), Polymarket stake $2.50 under $50 equity, $5 at $50, $7.50 at $100, $10 at $150, $15 at $300, $25 at $500, 3% from $1,000",
  },
  {
    // STAKES DOWN (2026-10-05, account holder's call): Kalshi base back to $5
    // ($7.50 at $75 equity, $10 at $150 ...); Polymarket base $3.50 ($5 at $50,
    // $7.50 at $100, $10 at $150, $15 at $300, $25 at $500, 3% from $1,000).
    // Monday 2026-10-05 at $8: two Kalshi losses (-$7.79, -$7.48) hit the 15%
    // daily halt by 2:33pm. Mirror also tightened: within 10 min of Kalshi's
    // fill, no more than 5c below Kalshi's price.
    id: "2026-10-05-stakes-5-and-3.50",
    apply: (c) => {
      c.flatStakeDollars = 5;
      c.polymarket = { ...DEFAULTS.polymarket, ...(c.polymarket || {}), flatStakeDollars: 3.5, mirrorMaxMinutes: 10, mirrorMaxBelowCents: 5, stakeTiers: [{ at: 0, x: 1 }, { at: 50, x: 10 / 7 }, { at: 100, x: 15 / 7 }, { at: 150, x: 20 / 7 }, { at: 300, x: 30 / 7 }, { at: 500, x: 50 / 7 }, { at: 1000, pct: 0.03 }] };
    },
    note: "Kalshi base stake $5 (was $8); Polymarket base $3.50 ($5 at $50 equity); mirror only within 10 min of Kalshi's fill and within 5c of its price",
  },
  {
    // KEEP WHAT WORKS (2026-10-10, account holder's call: "use what works and
    // drop what doesn't"). From the account's 270 closed trades (export
    // 2026-10-10 05:53Z):
    //   Polymarket        65 trades  -$36.21  copies of Kalshi's picks (same
    //                                         result on every shared game),
    //                                         paying its own fees - off.
    //                                         Back on: Controls > Polymarket > Auto
    //   NHL (regular)     10 trades   2 won vs 4.3 implied, -$22.13 - off
    //   Kalshi pre-game   32 trades  -$6.00 (-13%); in-play is where the
    //                                         profit is - in-play only
    // Kalshi with these and the 60-69c block replayed: 148 trades, +$72.00
    // (+14.7%) - the 57 trades it skips netted -$45.85.
    id: "2026-10-10-keep-what-works",
    apply: (c) => {
      const off = new Set(Array.isArray(c.disabledSports) ? c.disabledSports : []);
      off.add("icehockey_nhl");
      c.disabledSports = [...off];
      c.liveOnly = true;
      c.polymarket = { ...DEFAULTS.polymarket, ...(c.polymarket || {}), trading: "off" };
    },
    note: "Polymarket buying off; NHL off; Kalshi trades in-play only",
  },
  {
    // BACK TO THE BEST-DAY FORMULA (2026-10-10, account holder's call: "go
    // back to the day I earned the most and keep that formula"). Sep 26-27,
    // +$41.45 over 33 trades, every one of them: $5 flat, IN-PLAY, bought at
    // 35-52c, only when the expected return was 30%+ (on the unshrunk fair
    // value - the shrink came in on Oct 2).
    //
    // That formula across the account's whole Kalshi record (in-play, 35-59c,
    // no NHL): 103 trades, won 54 vs 44.1 the prices implied, +$70.02 (+18.7%),
    // and still +$17.23 since Sep 30. Everything added since (middle and
    // favorite lanes up to 92c, 0.5% minimum returns, pre-game, NHL):
    // 102 trades, -$43.87.
    //
    //   one lane:  35-59c (60-69c stays blocked), 30% minimum expected return
    //   no shrink: fairShrink 1, as on the best days
    //   in-play only, $5 flat on the existing stake tiers, NHL and Polymarket
    //   off - kept from 2026-10-10-keep-what-works
    // Every fix since (state file, schedule, resolver, 60-69c block, learner,
    // reader, counters, reminders) stays.
    id: "2026-10-10-best-day-formula",
    apply: (c) => {
      c.flatStakeDollars = 5;
      c.liveOnly = true;
      c.fairShrink = 1;
      c.minExpectedReturnPct = 30;
      c.minEntryPriceCents = 35;
      c.liveBandMinCents = 35;
      c.maxEntryPriceCents = 59;
      c.liveBandMaxCents = 59;
      c.lanes = {
        dip: { enabled: true, minCents: 35, maxCents: 59, minReturnPct: 30 },
        middle: { ...(c.lanes?.middle || {}), enabled: false },
        favorite: { ...(c.lanes?.favorite || {}), enabled: false },
      };
    },
    note: "best-day formula: in-play only, 35-59c, 30% min expected return, no fair shrink, $5 flat; middle and favorite lanes off",
  },
  {
    // 50-59c ONLY (2026-10-11, account holder's call: "50-59c is the most
    // profit and safety"). The account's Kalshi trades bought at 50-59c:
    //   28 trades, 21 won (75%), +$24.07 (+23.7%)
    //   expected return 0.5-8% at entry:  24 trades, 20 won, +$36.56
    //   expected return 30%+ at entry:     4 trades,  1 won, -$12.49
    // At these prices a big claimed edge has meant a stale line, so the lane
    // takes small edges (0.5% minimum) and refuses "too good" ones (8% ceiling),
    // measured on the shrunk fair value those winning trades were priced on.
    //   - one lane, 50-59c; dip and favorite lanes off
    //   - in-play AND pre-game (50-59c pre-game won 4 of 5)
    //   - every sport, NHL back on (its 50-59c trades won 6 of 6)
    //   - daily loss halt 10% (was 15%); no per-trade stop loss - the
    //     account's stop-loss and blowout exits lost $24.86 together
    //   - Polymarket copies Kalshi's trades again, never below Kalshi's price
    //     (so never under 50c) and never into 60c+ (60-69c stays blocked)
    id: "2026-10-11-fifty-to-fifty-nine",
    apply: (c) => {
      c.flatStakeDollars = 5;
      c.liveOnly = false;
      c.fairShrink = 0.5;
      c.minExpectedReturnPct = 0.5;
      c.minEntryPriceCents = 50;
      c.liveBandMinCents = 50;
      c.maxEntryPriceCents = 59;
      c.liveBandMaxCents = 59;
      c.dailyLossHaltPct = 0.10;
      c.lanes = {
        dip: { ...(c.lanes?.dip || {}), enabled: false },
        middle: { enabled: true, minCents: 50, maxCents: 59, minReturnPct: 0.5, maxReturnPct: 8 },
        favorite: { ...(c.lanes?.favorite || {}), enabled: false },
      };
      c.disabledSports = (Array.isArray(c.disabledSports) ? c.disabledSports : []).filter((s) => s !== "icehockey_nhl");
      c.polymarket = { ...DEFAULTS.polymarket, ...(c.polymarket || {}), trading: "auto", mirrorKalshi: true, mirrorMaxExtraCents: 2, mirrorMaxBelowCents: 0, flatStakeDollars: 3.5 };
    },
    note: "50-59c only (0.5-8% expected return), in-play and pre-game, all sports incl. NHL, 10% daily halt, Polymarket mirrors Kalshi at 50-59c",
  },
  {
    // AT MOST 3 OPEN BETS (2026-10-11, account holder's call: "1-3 bots until
    // the balance goes up"). A fixed cap on open positions, on each exchange,
    // resting bids included - replaces the 5-10 cap by balance. Raise it later
    // by changing maxConcurrentPositions.
    id: "2026-10-11-max-3-open",
    apply: (c) => { c.maxConcurrentPositions = 3; },
    note: "at most 3 open bets at a time on each exchange (resting bids count)",
  },
  {
    // NHL TO PAPER (2026-10-13, account holder's call: "a lot of losses mainly
    // nhl... purposely bet on what [you] think would be the losing team").
    // The account's Kalshi NHL trades: 2 won of 13 vs 5.9 the prices implied
    // (z -2.2), -$31.89; since the 50-59c plan 0 of 3, -$9.76. The other side
    // of those games would have made +$20.30 - in hindsight, on 8 trades.
    // Real money stops on NHL; the paper "nhl_flip" strategy bets the other
    // team every time the live rule would have bought one, at the real ask,
    // so the flip is proven or disproven before any money goes on it.
    id: "2026-10-13-nhl-paper-only",
    apply: (c) => {
      const off = new Set(Array.isArray(c.paperOnlySports) ? c.paperOnlySports.map(String) : []);
      off.add("icehockey_nhl");
      c.paperOnlySports = [...off];
    },
    note: "NHL: no real-money bets; still priced and scored on paper (live rule vs the flip)",
  },
  {
    // LOSING SPORTS TO PAPER (2026-10-13, account holder's call: "look at all
    // other high losing sports... try the same things again"). Kalshi trades
    // held to the result, won vs the prices implied, from the account's
    // closed trades (2026-10-14 02:36Z export):
    //   NHL preseason        3 of 9  vs 3.7   -$9.70
    //   MLB                 12 of 34 vs 15.0  -$5.72  (z -1.1)
    //   NBA preseason        7 of 14 vs 8.9   -$8.71  (z -1.1)
    //   Brazil Serie B       1 of 8  vs 2.8   -$11.65 (z -1.35)
    //   Brazil Serie A       0 of 2  vs 0.8   -$9.76
    //   MLS                  0 of 2  vs 0.9   -$9.28
    // No real-money bets on these; paper flips (paperTrader.js FLIP_GROUPS)
    // bet NO on every pick the live rule would have made. Tennis, EuroLeague
    // and MMA stay switched off entirely (disabledSports).
    id: "2026-10-13-losing-sports-paper-only",
    apply: (c) => {
      const off = new Set(Array.isArray(c.paperOnlySports) ? c.paperOnlySports.map(String) : []);
      for (const k of ["icehockey_nhl", "icehockey_nhl_preseason", "baseball_mlb", "basketball_nba_preseason",
        "soccer_brazil_serie_b", "soccer_brazil_campeonato", "soccer_usa_mls"]) off.add(k);
      c.paperOnlySports = [...off];
    },
    note: "NHL, NHL preseason, MLB, NBA preseason, Brazil Serie A/B, MLS: no real-money bets; scored on paper (live rule vs the flip)",
  },
  {
    // REAL-MONEY FLIP (2026-10-13 20:08 PT, account holder's call: "Bet on
    // the opposite teams. All losing teams that have lost consistently use
    // same formula just bet on opposite what bot thinks is going to win. Same
    // with mlb"). The sports the bot has lost in, from the account's closed
    // Kalshi trades: NHL, NHL preseason, MLB, NBA preseason, Brazil Serie A,
    // Brazil Serie B, MLS. They come off paper-only and trade for real, flipped
    // (flipTrader.js): the 50-59c formula runs unchanged, and when it picks a
    // team the other team is bought at its own ask, $5 flat. Tennis, EuroLeague
    // and MMA stay switched off (disabledSports).
    id: "2026-10-13-flip-losing-sports",
    apply: (c) => {
      const flip = ["icehockey_nhl", "icehockey_nhl_preseason", "baseball_mlb", "basketball_nba_preseason",
        "soccer_brazil_serie_b", "soccer_brazil_campeonato", "soccer_usa_mls"];
      c.paperOnlySports = (Array.isArray(c.paperOnlySports) ? c.paperOnlySports : []).filter((k) => !flip.includes(k));
      const set = new Set(Array.isArray(c.flipSports) ? c.flipSports.map(String) : []);
      for (const k of flip) set.add(k);
      c.flipSports = [...set];
    },
    note: "FLIP for real: NHL, NHL preseason, MLB, NBA preseason, Brazil Serie A/B, MLS - when the formula picks a team, the other team is bought ($5)",
  },
  {
    // MORE BETS (2026-10-16, account holder's call: "more bets deployed right
    // now. No new formula" -> "6 open, 25% halt"). At $45 equity the 10% halt
    // was $4.50, so a single $5 loss stopped the day. Same formula, same $5.
    //   - at most 6 open bets on each exchange (was 3)
    //   - daily loss halt 25% (was 10%) - about $11 on $45
    // Soccer flips also buy the tie (flipTrader.js, no config needed).
    id: "2026-10-16-six-open-25-halt",
    apply: (c) => {
      c.maxConcurrentPositions = 6;
      c.dailyLossHaltPct = 0.25;
    },
    note: "at most 6 open bets per exchange, daily loss halt 25%; soccer flips buy the other team and the tie",
  },
  {
    // FLIP ALL SOCCER (2026-10-17, account holder's call: "fix all recent
    // losses"; standing rule from 2026-10-13: "All losing teams that have lost
    // consistently use same formula just bet on opposite"). The account's
    // closed trades (2026-10-17 23:49Z export):
    //   Kalshi soccer at 50-59c, all time:   13 won of 31 vs 16.9 implied, -$27.16
    //   soccer since Oct 14, both exchanges: 13 won of 36 vs 19.9 implied, -$39.70
    //   soccer on Oct 17:                     4 won of 13 vs  7.3 implied, -$23.63
    //   everything else at 50-59c on Kalshi since Oct 12: 10 of 19, +$9.00
    // Every soccer league is flipped now (the "*" prefix): the formula's pick
    // is not bought; the other team AND the tie are, $5 each (flipTrader.js).
    id: "2026-10-17-flip-all-soccer",
    apply: (c) => {
      const set = new Set(Array.isArray(c.flipSports) ? c.flipSports.map(String) : []);
      set.add("soccer_*");
      c.flipSports = [...set];
    },
    note: "every soccer league flipped: the bot's pick is not bought - the other team and the tie are ($5 each)",
  },
  {
    // 80-99c ONLY (2026-10-18 13:51 PT, account holder's call: "Use 80-99
    // style bets only for now"). Same formula - sharp fair value vs the ask,
    // 0.5-8% expected return after fees on the shrunk fair value - on one
    // band, 80-99c, every sport, in-play and pre-game, $5 flat.
    //   - flips OFF: the other side of an 80-99c pick costs 1-20c, a long
    //     shot (Halmstad was bought at 8c on 2026-10-18 and lost)
    //   - dip and favorite lanes off; Polymarket still copies Kalshi
    // Account record at 80c+ (2026-10-18 20:32Z export): 12 of 14 won, +$0.17
    // net - wins of $0.17-0.66, losses of $4.36 and $0.82.
    id: "2026-10-18-eighty-to-ninety-nine",
    apply: (c) => {
      c.minEntryPriceCents = 80;
      c.liveBandMinCents = 80;
      c.maxEntryPriceCents = 99;
      c.liveBandMaxCents = 99;
      c.lanes = {
        dip: { ...(c.lanes?.dip || {}), enabled: false },
        middle: { enabled: true, minCents: 80, maxCents: 99, minReturnPct: 0.5, maxReturnPct: 8 },
        favorite: { ...(c.lanes?.favorite || {}), enabled: false },
      };
      c.flipSports = [];
    },
    note: "80-99c only, same formula (0.5-8% expected return), every sport, $5 flat; flips off",
  },
  {
    // ARBITRAGE ON (2026-10-18, account holder's call: "Build arbitrage
    // engine"). arbEngine.js: Kalshi team A + Polymarket team B for under
    // $1.00 a pair after worst-case fees, only in sports that cannot end in a
    // tie. 2c a pair minimum, $0.10 a trade minimum, $10 a trade maximum,
    // 3 games at once. Both legs held to settlement.
    id: "2026-10-18-arbitrage-on",
    apply: (c) => {
      c.arbitrage = {
        ...(c.arbitrage || {}),
        enabled: true, minLockedCents: 2, minLockedDollars: 0.10, maxCostDollars: 10, maxOpenArbs: 3,
        everySeconds: 30, runWhileHalted: true,
      };
    },
    note: "arbitrage on: Kalshi + Polymarket pairs under $1.00 after fees, no-tie sports only, $10 max a trade",
  },
  {
    // 70-99c (2026-10-18 14:11 PT, account holder's call: "Let's try 70-99 ...
    // slow and steady more predictable returns"). Same formula and lane rules
    // as 80-99c, band widened down to 70c. 60-69c stays blocked
    // (blockedEntryCents). Account record, both exchanges (2026-10-18 20:32Z):
    //   70-79c: 22 won of 31 (71%) vs 75% implied, -$7.42
    //   80-89c: 11 won of 13 (85%) vs 84% implied, -$0.29
    id: "2026-10-18-seventy-to-ninety-nine",
    apply: (c) => {
      c.minEntryPriceCents = 70;
      c.liveBandMinCents = 70;
      c.maxEntryPriceCents = 99;
      c.liveBandMaxCents = 99;
      c.lanes = {
        dip: { ...(c.lanes?.dip || {}), enabled: false },
        middle: { enabled: true, minCents: 70, maxCents: 99, minReturnPct: 0.5, maxReturnPct: 8 },
        favorite: { ...(c.lanes?.favorite || {}), enabled: false },
      };
      c.flipSports = [];
    },
    note: "70-99c, same formula (0.5-8% expected return), every sport, $5 flat; 60-69c still blocked; flips off",
  },
  {
    // STREAK COUNTER + 65% TO WIN (2026-10-18 16:27 PT, account holder's call:
    // "streak counter ... only able to deploy more with more wins. One loss
    // draws deployments back to 1" and "all games to be bet on 65% odds or
    // better ... mandatory").
    //   - open bets allowed = 1 + wins in a row, back to 1 after any loss,
    //     at most 6 (streakCounter.js); starts fresh at 1 from this update
    //   - every bet needs a sharp fair value of 65%+ to win (scanner.js)
    // Arbitrage pairs pay whoever wins, so neither rule applies to them.
    id: "2026-10-18-streak-and-65",
    apply: (c) => {
      const max = Number(c.maxConcurrentPositions) > 0 ? Number(c.maxConcurrentPositions) : 6;
      c.streak = { enabled: true, since: new Date().toISOString(), max };
      c.minWinProbability = 0.65;
    },
    note: "streak counter on (1 bet + 1 per win in a row, back to 1 after a loss, max 6); every bet must be 65%+ to win",
  },
  {
    // 60%+ ON EVERY ENTRY (2026-10-24 13:04 PT, account holder's call: "change
    // all entry betting odds to 60% or higher for all games"). Price 60-99c
    // and a sharp fair value of 60%+ to win; the 60-69c block is lifted.
    // Same formula (0.5-8% expected return), $5 flat, streak counter on.
    // Account record at 60-69c, both exchanges (2026-10-18 20:32Z export):
    // 17 won of 34 (50%) vs 64% implied, -$42.81.
    id: "2026-10-24-sixty-plus",
    apply: (c) => {
      c.minEntryPriceCents = 60;
      c.liveBandMinCents = 60;
      c.maxEntryPriceCents = 99;
      c.liveBandMaxCents = 99;
      c.minWinProbability = 0.60;
      c.blockedEntryCents = [];
      c.lanes = {
        dip: { ...(c.lanes?.dip || {}), enabled: false },
        middle: { enabled: true, minCents: 60, maxCents: 99, minReturnPct: 0.5, maxReturnPct: 8 },
        favorite: { ...(c.lanes?.favorite || {}), enabled: false },
      };
    },
    note: "60-99c, 60%+ to win on every bet, 60-69c block lifted; same formula, $5 flat, streak counter on",
  },
  {
    // 55%+ CLEARS (2026-10-24 13:06 PT, account holder's call: "Make 55% bets
    // clear"). Price 55-99c and a sharp fair value of 55%+ to win; nothing in
    // between blocked. Same formula (0.5-8% expected return), $5 flat,
    // streak counter on.
    id: "2026-10-24-fifty-five-plus",
    apply: (c) => {
      c.minEntryPriceCents = 55;
      c.liveBandMinCents = 55;
      c.maxEntryPriceCents = 99;
      c.liveBandMaxCents = 99;
      c.minWinProbability = 0.55;
      c.blockedEntryCents = [];
      c.lanes = {
        dip: { ...(c.lanes?.dip || {}), enabled: false },
        middle: { enabled: true, minCents: 55, maxCents: 99, minReturnPct: 0.5, maxReturnPct: 8 },
        favorite: { ...(c.lanes?.favorite || {}), enabled: false },
      };
    },
    note: "55-99c, 55%+ to win on every bet; same formula, $5 flat, streak counter on",
  },
  {
    // POLYMARKET OFF (2026-10-24 13:09 PT, account holder's call: "Turn off all
    // Polymarket trading"). No new Polymarket buys of any kind: the copy of
    // Kalshi's bets stops (polymarket.trading "off", pmEngine tradingActive)
    // and arbitrage stops too, since every arbitrage needs a Polymarket leg.
    // Positions already open on Polymarket are still tracked to settlement.
    id: "2026-10-24-polymarket-off",
    apply: (c) => {
      c.polymarket = { ...DEFAULTS.polymarket, ...(c.polymarket || {}), trading: "off" };
      c.arbitrage = { ...(c.arbitrage || {}), enabled: false };
    },
    note: "Polymarket trading off (no copies, no arbitrage); open Polymarket positions still settle",
  },
  {
    // KEEP WHAT WINS (2026-10-27, account holder's call: "Help me make
    // effective changes to build the portfolio" / "$5 to make 5.50 ... is not
    // a good investment"). The account's Kalshi bets since the 2026-10-24
    // restart (2026-10-28 01:18Z export), 87 bets, +$2.69:
    //   NFL 11 of 12 +$19.13, NCAAF 8 of 8 +$8.45, NHL 8 of 9 +$4.78
    //     -> 27 of 29, +$32.36
    //   every other sport: 34 of 58, -$29.67 (NBA 7 of 13 -$12.12)
    //   85-99c: 11 of 13 won but +$0.20-0.60 a win vs -$4.38 a loss
    //   (85-89c -$6.39) - risking $5 to make cents
    //   - new bets only in NFL, college football and NHL (entrySports)
    //   - price 55-84c (no more 85-99c bets)
    // Everything else unchanged: 55%+ to win, 0.5-8% expected return, $5,
    // streak counter, 25% daily halt, Polymarket off.
    id: "2026-10-27-football-nhl-55-84",
    apply: (c) => {
      c.entrySports = ["americanfootball_nfl", "americanfootball_ncaaf", "icehockey_nhl"];
      c.maxEntryPriceCents = 84;
      c.liveBandMaxCents = 84;
      c.lanes = {
        dip: { ...(c.lanes?.dip || {}), enabled: false },
        middle: { enabled: true, minCents: Number(c.minEntryPriceCents) || 55, maxCents: 84, minReturnPct: 0.5, maxReturnPct: 8 },
        favorite: { ...(c.lanes?.favorite || {}), enabled: false },
      };
    },
    note: "new bets only in NFL, NCAAF and NHL; price 55-84c (no 85-99c bets)",
  },
];

function applyOneTimeUpdates(stored) {
  const done = new Set(Array.isArray(stored.oneTimeUpdates) ? stored.oneTimeUpdates : []);
  let changed = false;
  for (const u of ONE_TIME_UPDATES) {
    if (done.has(u.id)) continue;
    u.apply(stored);
    done.add(u.id);
    changed = true;
    console.log(`[config] One-time update ${u.id}: ${u.note}`);
  }
  if (changed) {
    stored.oneTimeUpdates = [...done];
    writeRaw(stored);
  }
  return stored;
}

/**
 * Applies the one-time updates and the strategy migration if the persisted
 * file predates this build, then returns defaults merged with the file.
 */
export function loadConfig() {
  const stored = applyOneTimeUpdates(readRaw());

  if ((stored.strategyVersion ?? 0) < STRATEGY_VERSION) {
    const migrated = { ...stored };
    for (const key of STRATEGY_KEYS) migrated[key] = DEFAULTS[key];
    migrated.strategyVersion = STRATEGY_VERSION;
    migrated.strategyMigratedAt = new Date().toISOString();
    writeRaw(migrated);
    console.log(
      `[config] Strategy parameters migrated to v${STRATEGY_VERSION} ` +
      `(live trading on, held to settlement, ${DEFAULTS.minEntryPriceCents}-${DEFAULTS.maxEntryPriceCents}c band, ` +
      `up to ${DEFAULTS.survivalMode.maxConcurrentPositions} concurrent, entries priced at the fill). ` +
      `Account settings preserved.`
    );
    return { ...DEFAULTS, ...migrated };
  }

  return { ...DEFAULTS, ...stored };
}

export function saveConfig(partial) {
  const stored = readRaw();
  const next = { ...stored, ...partial, strategyVersion: STRATEGY_VERSION };
  writeRaw(next);
  return { ...DEFAULTS, ...next };
}

export function setEnvironment(environment, confirmed) {
  if (environment === "production" && !confirmed) {
    throw new Error("Switching to production requires explicit confirmation of the real-funds warning.");
  }
  return saveConfig({
    environment,
    confirmedProductionAt: environment === "production" ? new Date().toISOString() : null,
  });
}

/** What the dashboard shows so the active strategy is never a guess. */
export function describeStrategy() {
  const c = loadConfig();
  return {
    strategyVersion: c.strategyVersion ?? STRATEGY_VERSION,
    migratedAt: c.strategyMigratedAt ?? null,
    liveGames: c.allowLiveGames !== false
      ? `ENABLED - in-play quotes accepted up to ${c.maxLineAgeSecondsLive}s old`
      : "switched off in config",
    exitPolicy: c.holdToSettlement === false
      ? "active exits enabled"
      : `held to settlement, except a take-out at ${c.ceilingExitAtCents}c+` +
        (c.ceilingExitOnlyWhenNeeded !== false ? " (only when a slot or cash is needed)" : "") +
        (c.blowoutExit === true ? ` and a blowout below ${c.blowoutExitBelowCents}c` : "; blowout exit off"),
    priceBand: `${c.minEntryPriceCents}c - ${c.maxEntryPriceCents}c`,
    minEv: `${c.minEvCentsPerTrade}c per trade` +
      (c.minEvCentsPerContract ? `, ${c.minEvCentsPerContract}c per contract` : ""),
    pricing: `order limit walks up to ${c.maxWalkupCents ?? 4}c above the ask, but only as far as the edge still clears; ` +
      `the trade is judged at that limit, so any fill inside the band is positive by construction`,
    sizing: `${(c.kellyFraction * 100).toFixed(0)}% Kelly, max ${(c.maxRiskPctPerTrade * 100).toFixed(0)}% of bankroll per trade`,
    concurrency: `up to ${c.survivalMode?.maxConcurrentPositions ?? "tier"} positions at once ` +
      `(flat $${c.survivalMode?.flatBetDollars ?? "-"} while the balance is under $${c.survivalMode?.balanceThreshold ?? "-"})`,
    fairValueExit: `${c.fairValueExit ?? "shadow"} - sell when the bid beats the sharp fair value by ${c.fairValueExitMarginCents ?? 2}c after fees`,
    clv: `kill switch ${c.clvKillSwitch === false ? "off" : "on"} (${c.clvMinSample ?? 15} marks, ${c.clvZ ?? 1}x SE); ` +
      `Kelly sizing ${c.clvGatedSizing === false ? "for every sport" : "only on sports with proven CLV"}`,
    disabledSports: (c.disabledSports || []).join(", ") || "none",
    paperOnlySports: (c.paperOnlySports || []).join(", ") || "none",
    flipSports: (c.flipSports || []).join(", ") || "none",
    entries: c.liveOnly === false ? "live and pre-game" : "LIVE GAMES ONLY - no pre-game buys or resting bids",
  };
}

