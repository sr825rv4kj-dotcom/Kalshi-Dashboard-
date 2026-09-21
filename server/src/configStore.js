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
export const STRATEGY_VERSION = 8;

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
  maxLineAgeSecondsLive: 180,        // 3 minutes
  maxLineAgeSecondsPregame: 1800,    // 30 minutes

  // Hold to settlement. Kalshi charges a fee on every trade and nothing at
  // settlement, so a flip costs two fees and a hold costs one. Worth +4 to
  // +7c per contract at the prices traded here.
  holdToSettlement: true,

  entryWindowHours: 8,          // how far AHEAD of kickoff to look; does not limit live games
  minMinutesBeforeStart: 0,     // raise this to stop entering right on the whistle

  // --- Price band --------------------------------------------------------
  // Below 25c the whole-cent fee dominates: at 8c it is 25% of the stake.
  // Above 88c there is not enough upside left to cover being wrong.
  minEntryPriceCents: 25,
  maxEntryPriceCents: 88,

  maxPlausibleEdge: 0.18,       // a wider gap than this is a stale feed, not an edge
  minEvCentsPerContract: 2,     // absolute floor - thin percentage edges are not worth capital
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
  blowoutExitBelowCents: 12,
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
  // Six slots puts ~64% of the balance to work and leaves a real buffer. Six
  // at $2 is deliberately preferred over three at $4: identical exposure, but
  // the outcome is spread across six independent games instead of three. With
  // a small edge, diversification beats concentration every time.
  // Survival mode ends at $40 rather than $60. The strategy has now produced
  // +37.6% ROI over 18 completed trades, so holding it at flat $2 bets and a
  // 1.25x edge penalty well past the point it proved itself was costing
  // opportunity, not buying safety.
  survivalMode: {
    balanceThreshold: 40,
    flatBetDollars: 2,
    maxConcurrentPositions: 6,
    edgeMultiplier: 1.25,
  },

  milestoneTiers: [
    // Raised across the board for the same reason as survival mode: a held
    // position ties up its slot for the length of a game, not for minutes.
    { at: 0,     kellyFraction: 0.25, maxConcurrentPositions: 6,  maxStakeDollars: 4,   reservePct: 0.00 },
    // First tier clear of survival mode: real Kelly sizing and twice the
    // concurrency, because the constraint above $40 is opportunity, not ruin.
    { at: 40,    kellyFraction: 0.25, maxConcurrentPositions: 8,  maxStakeDollars: 8,   reservePct: 0.00 },
    { at: 100,   kellyFraction: 0.25, maxConcurrentPositions: 10, maxStakeDollars: 15,  reservePct: 0.10 },
    { at: 500,   kellyFraction: 0.25, maxConcurrentPositions: 14, maxStakeDollars: 50,  reservePct: 0.20 },
    { at: 2500,  kellyFraction: 0.30, maxConcurrentPositions: 12, maxStakeDollars: 200, reservePct: 0.30 },
    { at: 10000, kellyFraction: 0.30, maxConcurrentPositions: 16, maxStakeDollars: 600, reservePct: 0.40 },
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
      `(pre-game only, hold to settlement, ${DEFAULTS.minEntryPriceCents}-${DEFAULTS.maxEntryPriceCents}c band). ` +
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
      : `held to settlement, except a take-out at ${c.ceilingExitAtCents}c+ and a blowout below ${c.blowoutExitBelowCents}c`,
    priceBand: `${c.minEntryPriceCents}c - ${c.maxEntryPriceCents}c`,
    minEv: `${c.minEvCentsPerContract}c per contract`,
    sizing: `${(c.kellyFraction * 100).toFixed(0)}% Kelly, max ${(c.maxRiskPctPerTrade * 100).toFixed(0)}% of bankroll per trade`,
  };
}
