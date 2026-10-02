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
  maxEntryPriceCents: 70,

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
  pregameConfirm: {
    enabled: true, minScans: 3, minMinutes: 3, maxGapSeconds: 180, maxDriftPoints: 2,
    live: { enabled: true, minScans: 4, minMinutes: 2, maxGapSeconds: 90, maxDriftPoints: 3 },
  },

  // RESTING BIDS (makerEngine.js). allowLive (2026-10-01): in live games too -
  // a bid at the price that returns minExpectedReturnPct, max 2 at once, half
  // stake, 5-minute life, re-confirmed every scan.
  maker: { enabled: true, allowLive: true },

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
  flatStakeDollars: 5,

  // LEARNING + WIN-RATE FOCUS (2026-09-25) - see outcomeLearner.js
  // 2026-09-29: 35-70c -> 25-80c (account holder: live games get traded).
  // The account's settled live record: 25-80c 80 trades +$57.97 (+25.1% ROI),
  // 35-70c 62 trades +$54.23 (+26.7%) - same return, 18 more trades.
  liveBandMinCents: 35,          // live buys only between these prices (restored 2026-09-30)
  liveBandMaxCents: 70,
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
  minExpectedReturnPct: 12.5,

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
  polymarket: { enabled: true, trading: "auto", shortSide: "auto", entrySports: ["americanfootball_nfl", "americanfootball_ncaaf"] },

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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2));
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
    entries: c.liveOnly === false ? "live and pre-game" : "LIVE GAMES ONLY - no pre-game buys or resting bids",
  };
}
