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

  reentryCooldownMinutes: 60,
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
 * Applies the strategy migration if the persisted file predates this build,
 * then returns defaults merged with whatever the file holds.
 */
export function loadConfig() {
  const stored = readRaw();

  if ((stored.strategyVersion ?? 0) < STRATEGY_VERSION) {
    const migrated = { ...stored };
    for (const key of STRATEGY_KEYS) migrated[key] = DEFAULTS[key];
    migrated.strategyVersion = STRATEGY_VERSION;
    migrated.strategyMigratedAt = new Date().toISOString();
    writeRaw(migrated);
    console.log(
      `[config] Strategy parameters migrated to v${STRATEGY_VERSION} ` +
      `(live trading on, held to settlement, ${DEFAULTS.minEntryPriceCents}-${DEFAULTS.maxEntryPriceCents}c band, ` +
      `up to ${DEFAULTS.survivalMode.maxConcurrentPositions} concurrent). Account settings preserved.`
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
      : `held to settlement, except a take-out at ${c.ceilingExitAtCents}c+ and a blowout below ${c.blowoutExitBelowCents}c`,
    priceBand: `${c.minEntryPriceCents}c - ${c.maxEntryPriceCents}c`,
    minEv: `${c.minEvCentsPerContract}c per contract`,
    sizing: `${(c.kellyFraction * 100).toFixed(0)}% Kelly, max ${(c.maxRiskPctPerTrade * 100).toFixed(0)}% of bankroll per trade`,
    concurrency: `up to ${c.survivalMode?.maxConcurrentPositions ?? "tier"} positions at once ` +
      `(flat $${c.survivalMode?.flatBetDollars ?? "-"} while the balance is under $${c.survivalMode?.balanceThreshold ?? "-"})`,
  };
}
