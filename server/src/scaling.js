/**
 * scaling.js
 *
 * STAKE TIERS + DOUBLE-DOWN (2026-09-26, account holder's call)
 *
 * 1. THE STAKE GROWS WITH THE ACCOUNT.
 *    The stake is read from the account's equity - cash plus what the open
 *    positions are worth, the same number the Kalshi app shows as the
 *    portfolio total - every scan. Each threshold the equity clears raises
 *    the stake; above the last fixed tier it becomes a percentage of equity,
 *    so it keeps climbing with no ceiling other than stakeMaxDollars.
 *
 *    Default tiers, as multiples of flatStakeDollars ($5):
 *        under $75      1x    $5
 *        $75            1.5x  $7.50
 *        $150           2x    $10
 *        $300           3x    $15
 *        $500           5x    $25
 *        $1,000+        3% of equity  ($30 at $1,000, $60 at $2,000, ...)
 *
 *    It works both ways: if equity falls back under a threshold the stake
 *    steps back down with it. That is what stops one bad night at a big
 *    stake from taking back a week of growth. Changing flatStakeDollars moves
 *    every fixed tier with it. stakeTiers: [] switches tiering off (flat stake).
 *
 * 2. DOUBLE-DOWN (EXPERIMENTAL).
 *    A game the bot already holds may get ONE more stake of the same size when
 *    all of these are true at once:
 *      - the game is live and the team the bot backed is ahead,
 *      - it has stayed ahead on doubleDown.leadScans scans in a row, the first
 *        of them at least doubleDown.leadMinutes ago (a lead that held, not one
 *        that just happened),
 *      - the sharp line and the in-game model agree (the same check every live
 *        entry passes),
 *      - the add-on is expected to return at least doubleDown.minReturnPct
 *        (35%) after fees, at the price the order can actually fill at,
 *      - the price is inside the live band (35-70c) and there is a free slot,
 *      - the game has not already been doubled.
 *    Never on the opponent's side of a held game. Never twice on one game.
 *
 *    Expect these to be RARE. A team that is ahead is priced as ahead, so a
 *    35% expected return on a leader needs the market to be lagging the game
 *    by a lot. The bot does not force them; it takes one only when the
 *    numbers are there. An add-on puts two stakes on one game, and it uses one
 *    of the open-position slots while it is held.
 */

import { loadState, saveState } from "./stateStore.js";

export const SCALING_VERSION = "2026-09-26-stake-tiers-double-down";

export const DEFAULT_STAKE_TIERS = [
  { at: 0, x: 1 },
  { at: 75, x: 1.5 },
  { at: 150, x: 2 },
  { at: 300, x: 3 },
  { at: 500, x: 5 },
  { at: 1000, pct: 0.03 },
];

export const DEFAULT_DOUBLE_DOWN = {
  enabled: true,
  minReturnPct: 35,
  leadScans: 3,
  leadMinutes: 5,
};

/** The game a ticker belongs to - the same rule scanner.js and botController.js use. */
export function eventKeyOfTicker(ticker) {
  const parts = String(ticker).split("-");
  return parts.length > 1 ? `${parts[0]}-${parts[1]}` : String(ticker);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Pure: the stake for this equity.
 * Returns { stake, tierAt, tierLabel, nextAt, nextStake }.
 */
export function tieredStake(config = {}, equity) {
  const base = Number(config.flatStakeDollars);
  const eq = Number(equity);
  const maxStake = Number(config.stakeMaxDollars ?? 500);
  if (!(base > 0)) return { stake: null, tierAt: null, tierLabel: "flat stake off", nextAt: null, nextStake: null };

  const tiers = Array.isArray(config.stakeTiers) ? config.stakeTiers : DEFAULT_STAKE_TIERS;
  const valid = tiers
    .filter((t) => t && Number.isFinite(Number(t.at)) && (Number(t.x) > 0 || Number(t.pct) > 0))
    .sort((a, b) => Number(a.at) - Number(b.at));
  if (!valid.length || !Number.isFinite(eq)) {
    return { stake: round2(Math.min(base, maxStake)), tierAt: 0, tierLabel: "flat", nextAt: null, nextStake: null };
  }

  const stakeOf = (t, e) => (Number(t.pct) > 0 ? e * Number(t.pct) : base * Number(t.x));

  // Monotonic: the stake at any equity is the largest stake of every tier
  // reached, so a percentage tier can never pay LESS than the tier below it.
  let stake = base;
  let active = null;
  for (const t of valid) {
    if (eq >= Number(t.at)) {
      stake = Math.max(stake, stakeOf(t, eq));
      active = t;
    }
  }
  stake = Math.min(stake, maxStake > 0 ? maxStake : stake);

  const next = valid.find((t) => Number(t.at) > eq) || null;
  return {
    stake: round2(stake),
    tierAt: active ? Number(active.at) : 0,
    tierLabel: active
      ? (Number(active.pct) > 0 ? `${(Number(active.pct) * 100).toFixed(1)}% of equity from $${active.at}` : `${active.x}x from $${active.at}`)
      : "base",
    nextAt: next ? Number(next.at) : null,
    nextStake: next ? round2(Math.min(Math.max(stake, stakeOf(next, Number(next.at))), maxStake > 0 ? maxStake : Infinity)) : null,
  };
}

// --- Last decision, for the monitor and for logging tier changes -----------
let lastStake = null;

/**
 * Records this scan's stake and returns a log line when the tier changed
 * (null otherwise), so the log shows every step up or down exactly once.
 */
export function noteStake(decision, equity) {
  const prev = lastStake;
  lastStake = { ...decision, equity: round2(Number(equity) || 0), at: new Date().toISOString() };
  if (!prev || prev.tierAt === decision.tierAt) return null;
  const dir = decision.tierAt > prev.tierAt ? "UP" : "DOWN";
  return `Stake tier ${dir}: equity $${lastStake.equity.toFixed(2)} ` +
    `${dir === "UP" ? "cleared" : "fell under"} $${dir === "UP" ? decision.tierAt : prev.tierAt} - ` +
    `stake now $${decision.stake.toFixed(2)} per trade (was $${prev.stake.toFixed(2)})` +
    (decision.nextAt != null ? `. Next step at $${decision.nextAt}.` : ".");
}

export function stakeReport(config = {}) {
  return {
    version: SCALING_VERSION,
    current: lastStake,
    tiers: Array.isArray(config.stakeTiers) ? config.stakeTiers : DEFAULT_STAKE_TIERS,
    baseStake: config.flatStakeDollars ?? null,
    stakeMaxDollars: config.stakeMaxDollars ?? 500,
    doubleDown: doubleDownConfig(config),
    doubledDown: (() => { try { return loadState().doubledDown || {}; } catch { return {}; } })(),
    leadWatch: Object.entries(leadWatch).map(([ticker, w]) => ({
      ticker, scansAhead: w.scans, aheadSince: new Date(w.since).toISOString(), lead: w.lead,
    })),
  };
}

// --- Double-down ------------------------------------------------------------

export function doubleDownConfig(config = {}) {
  const dd = config.doubleDown;
  if (dd === false) return { ...DEFAULT_DOUBLE_DOWN, enabled: false };
  if (dd && typeof dd === "object") return { ...DEFAULT_DOUBLE_DOWN, ...dd };
  return { ...DEFAULT_DOUBLE_DOWN };
}

/**
 * Pure: may this ticker take an add-on? Needs the positions list and the
 * doubled-down record. Returns { ok, reason, held }.
 */
export function addOnEligibleFrom({ ticker, positions, doubledDown, enabled }) {
  if (!enabled) return { ok: false, reason: "double-down off" };
  const ev = eventKeyOfTicker(ticker);
  const onEvent = (positions || []).filter((p) => eventKeyOfTicker(p.ticker) === ev);
  if (!onEvent.length) return { ok: false, reason: "not held" };
  if (onEvent.some((p) => p.ticker !== ticker)) return { ok: false, reason: "held on the other side" };
  if (onEvent.length > 1) return { ok: false, reason: "already doubled" };
  if ((doubledDown || {})[ev]) return { ok: false, reason: "already doubled" };
  if (onEvent[0].note) return { ok: false, reason: `position flagged: ${onEvent[0].note}` };
  return { ok: true, reason: null, held: onEvent[0] };
}

export function addOnEligible(ticker, config = {}) {
  try {
    const st = loadState();
    return addOnEligibleFrom({
      ticker, positions: st.positions, doubledDown: st.doubledDown, enabled: doubleDownConfig(config).enabled,
    });
  } catch (err) {
    return { ok: false, reason: `state unreadable: ${err.message}` };
  }
}

// Scans on which a held team has been ahead, in a row. In memory: a restart
// starts the count again, which only ever delays an add-on.
const leadWatch = {};

/** Pure-ish: update the lead record for a held ticker and say whether it has held. */
export function observeLead(ticker, lead, config = {}, now = Date.now()) {
  const dd = doubleDownConfig(config);
  const l = Number(lead);
  if (!Number.isFinite(l) || l <= 0) {
    delete leadWatch[ticker];
    return { held: false, scans: 0, minutes: 0, lead: Number.isFinite(l) ? l : null };
  }
  const w = leadWatch[ticker] ?? (leadWatch[ticker] = { scans: 0, since: now, lead: l });
  w.scans += 1;
  w.lead = l;
  const minutes = (now - w.since) / 60000;
  return {
    held: w.scans >= Number(dd.leadScans) && minutes >= Number(dd.leadMinutes),
    scans: w.scans, minutes, lead: l,
  };
}

export function forgetLead(ticker) {
  delete leadWatch[ticker];
}

/** Record a filled add-on so the game is never doubled again. */
export function markDoubledDown(ticker) {
  try {
    const st = loadState();
    st.doubledDown = st.doubledDown || {};
    st.doubledDown[eventKeyOfTicker(ticker)] = new Date().toISOString();
    const keepAfter = Date.now() - 3 * 24 * 60 * 60 * 1000;
    for (const [k, iso] of Object.entries(st.doubledDown)) {
      if (Date.parse(iso) < keepAfter) delete st.doubledDown[k];
    }
    saveState(st);
  } catch { /* the positions list still blocks a third stake on this game */ }
  forgetLead(ticker);
}
