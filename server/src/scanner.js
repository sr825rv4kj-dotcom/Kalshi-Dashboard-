/**
 * scanner.js
 *
 * Scans one sport: pulls sharp lines, resolves each team to a live Kalshi
 * ticker, prices it from the order book, and enters positions that clear the
 * edge check.
 *
 * ---------------------------------------------------------------------------
 * RESTING BIDS (2026-09-22)
 * ---------------------------------------------------------------------------
 * A market refused "edge-too-small" is no longer a dead end. It is handed to
 * makerEngine.js, which rests a post-only bid at the highest price that clears
 * the quarter-size MAKER fee. Tonight's slate: 16 of 20 MLB markets were in
 * exactly that state - fairly priced for a taker, profitable for a maker.
 * A bid on a market refused for any other reason is cancelled, and a taker
 * entry on a game cancels any bid resting on that game first.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * THE ORDER LIMIT IS THE BAR (2026-09-21)
 * ---------------------------------------------------------------------------
 * riskManager now returns a WALK-UP LIMIT: the highest price at which this
 * opportunity still clears the edge test, capped a few cents above the ask.
 * That limit is passed straight through to the executor instead of a flat
 * ask+1c cross, which widens the fill window from one cent to as many as four
 * without moving the bar - the limit IS the bar, so any fill inside the band is
 * positive by construction.
 *
 * Also here: the "best YES bid + 1c" price fallback is gone. It invented an ask
 * when the book had no offers at all, reported resting BUY size as offer size,
 * and hardcoded the spread to 1c so the spread gate could never fire. Every one
 * of those was a guaranteed no-fill dressed up as a candidate.
 *
 * And every resolver refusal is now tallied by its CAUSE - wrong-date,
 * opponent-side-only, none-tradeable - so "no matching Kalshi market" stops
 * being one dead end and becomes a list of named, fixable things.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * EARLIER: A CRASH THAT SILENTLY STOPPED TRADING
 * ---------------------------------------------------------------------------
 * The in-play corroboration block called bump() on five paths. bump was
 * declared with `const` AFTER that block. `const` is in the temporal dead
 * zone until its declaration executes, so every one of those calls threw:
 *
 *     ReferenceError: Cannot access 'bump' before initialization
 *
 * It threw only when a live game was VETOED - no live score match, the game
 * could not be modelled, or the model disagreed with the line. That is the
 * ordinary case during a full slate, which is why this looked intermittent.
 *
 * What the throw cost, every time it fired:
 *   1. The rest of THIS sport was abandoned mid-scan.
 *   2. botController's `for (const sportKey of activeSports)` loop is not
 *      guarded per sport, so EVERY SPORT AFTER IT was never scanned at all.
 *   3. The throw reached runCycle's catch, which counts it as a cycle failure.
 *      Three in a row trips the circuit breaker and halts ALL trading.
 *   4. markExchangeReachable() never ran, so the breaker never saw a healthy
 *      exchange to reset against.
 *
 * Two fixes, both permanent:
 *   - tally and bump are now declared at the TOP of scanSport, before any
 *     code that can reach them.
 *   - the entire body is wrapped. scanSport can no longer throw. A failure in
 *     one sport is logged, tallied as `scanner-error`, and the next sport is
 *     scanned normally. Exchange-level failures still reach the breaker from
 *     botController, which is the correct boundary for those.
 * ---------------------------------------------------------------------------
 *
 * LIVE GAMES ARE TRADED. There is no waiting period: if a game is on and the
 * book is quoting it, the bot can trade it. What is refused is a price the
 * GAME STATE contradicts - the sharp line must be corroborated by an in-game
 * model built from the live score (liveModel.js), and the entry uses the MORE
 * CONSERVATIVE of the two.
 */

import { kalshiGet } from "./kalshiClient.js";
import { getSharpProbabilities } from "./scraper.js";
import { assessOpportunity, feePerContractCents, flatBetContracts } from "./riskManager.js";
import { enterPosition, readShardBalances } from "./executor.js";
import { appendLog, loadState, saveState } from "./stateStore.js";
import { resolveTicker } from "./tickerResolver.js";
import { getLiveScores, findLiveGameForTeam } from "./scoresFetcher.js";
import { corroboratedProbability, fractionRemaining, paramsFor } from "./liveModel.js";
import { workCandidate, cancelResting, getRestingOrders, cancelPendingOnEvent } from "./makerEngine.js";
import { recordFairFromProbabilities } from "./fairValue.js";
import { clvVerdict, recordShadow } from "./clvTracker.js";
import { learnedBlock, streakStakeFactor } from "./outcomeLearner.js";

const V2 = "/trade-api/v2";

export const SCANNER_VERSION = "2026-09-25-learner-35-70-band";

// Kalshi reports a tradeable market as "active", not "open".
const TRADEABLE = new Set(["open", "active"]);

/**
 * Where the collateral actually is, cached briefly.
 *
 * Kalshi splits an account's cash across exchange shards, and an order against
 * a shard holding nothing is rejected however good the trade is. The scanner
 * used to discover that one market at a time, at the cost of a blocking
 * collateral move per miss. Knowing up front which shards are funded means the
 * funded ones get traded FIRST, while a move is requested in the background
 * for the rest.
 *
 * One call every 30s across every sport, not one per market.
 */
let shardCache = { at: 0, balances: null };
async function fundedShards() {
  if (Date.now() - shardCache.at < 30_000) return shardCache.balances;
  const balances = await readShardBalances();
  shardCache = { at: Date.now(), balances };
  return balances;
}

/**
 * Where a game sits relative to its start time.
 *
 * `live` is the important field: true means the clock is running and the
 * entry needs the in-game model to second the sharp line.
 */
export function entryTiming(commenceTime, { entryWindowHours = 8, minMinutesBeforeStart = 0 } = {}) {
  if (!commenceTime) {
    return { ok: false, live: false, reason: "no start time on the line - cannot tell whether the game has begun" };
  }

  const startMs = new Date(commenceTime).getTime();
  if (!Number.isFinite(startMs)) {
    return { ok: false, live: false, reason: `unreadable start time "${commenceTime}"` };
  }

  const minutesUntilStart = (startMs - Date.now()) / 60000;

  // In play. Always eligible - freshness, not the clock, decides whether the
  // quote is any good, and that is checked at the entry gate.
  if (minutesUntilStart <= 0) {
    return { ok: true, live: true, minutesUntilStart };
  }
  if (minutesUntilStart < minMinutesBeforeStart) {
    return {
      ok: false, live: false, minutesUntilStart,
      reason: `starts in ${minutesUntilStart.toFixed(0)}m, inside the ${minMinutesBeforeStart}m pre-kickoff cutoff`,
    };
  }
  if (entryWindowHours && minutesUntilStart > entryWindowHours * 60) {
    return {
      ok: false, live: false, minutesUntilStart,
      reason: `starts in ${(minutesUntilStart / 60).toFixed(1)}h, outside the ${entryWindowHours}h window`,
    };
  }
  return { ok: true, live: false, minutesUntilStart };
}

function eventKeyOf(ticker) {
  const parts = String(ticker).split("-");
  return parts.length > 1 ? `${parts[0]}-${parts[1]}` : String(ticker);
}

/**
 * Normalizes a price to cents. The book quotes in dollars (0.43); anything at
 * or below 1 is treated as a decimal, anything above as cents already.
 */
function toCents(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = n <= 1 ? n * 100 : n;
  return Math.round(cents);
}

/** Highest-priced level in a book side. Kalshi's ordering is not guaranteed. */
function bestLevel(levels) {
  let best = null;
  for (const lvl of levels ?? []) {
    const rawPrice = Array.isArray(lvl) ? lvl[0] : (lvl?.price ?? lvl?.yes_price ?? lvl?.no_price);
    const rawSize = Array.isArray(lvl) ? lvl[1] : (lvl?.size ?? lvl?.count ?? lvl?.quantity);
    const price = toCents(rawPrice);
    if (price == null) continue;
    const size = Number(rawSize ?? 0) || 0;
    if (!best || price > best.price) best = { price, size };
  }
  return best;
}

/**
 * Price to buy YES, in order of reliability:
 *   1. market.yes_ask when the endpoint populates it
 *   2. 100c minus the best NO bid - buying YES means selling NO to a bidder
 *   3. nothing - an empty NO side means there are no YES offers to take
 *
 * Also returns the spread, which is a liquidity signal in its own right: a
 * 15c-wide book means the fill price is a guess and the edge is imaginary.
 */
export async function priceFor(ticker, market) {
  const direct = market?.yes_ask ?? 0;
  const directBid = market?.yes_bid ?? 0;
  if (direct > 0 && direct < 100) {
    return {
      askCents: direct,
      askSize: market.yes_ask_size ?? 0,
      bidCents: directBid > 0 ? directBid : null,
      spreadCents: directBid > 0 ? direct - directBid : null,
      source: "market",
    };
  }

  let book = null;
  try {
    book = await kalshiGet(`${V2}/markets/${ticker}/orderbook`);
  } catch (err) {
    return { askCents: 0, askSize: 0, bidCents: null, spreadCents: null, source: `book-error:${err.message.slice(0, 40)}` };
  }

  const ob = book?.orderbook_fp ?? book?.orderbook ?? book ?? {};

  // Kalshi names the sides "yes_dollars" / "no_dollars" on this endpoint and
  // quotes them in dollars (0.43), not cents. Matching on a key prefix keeps
  // this working if the suffix changes again.
  const sideFor = (prefix) => {
    for (const [k, v] of Object.entries(ob)) {
      if (Array.isArray(v) && k.toLowerCase().startsWith(prefix)) return v;
    }
    return [];
  };
  const yesLevels = sideFor("yes");
  const noLevels = sideFor("no");

  const bestYes = bestLevel(yesLevels);
  const bestNo = bestLevel(noLevels);
  const bidCents = bestYes && bestYes.price > 0 ? bestYes.price : null;

  if (bestNo && bestNo.price > 0 && bestNo.price < 100) {
    const askCents = 100 - bestNo.price;
    return {
      askCents, askSize: bestNo.size, bidCents,
      spreadCents: bidCents != null ? askCents - bidCents : null,
      source: "book-no-bid",
    };
  }

  // NO fallback to "best YES bid + 1".
  //
  // Reaching here means the NO side is empty, which means there are no YES
  // offers at all. The old code invented a price one cent above the best BID,
  // reported the size of resting BUY orders as though they were offers, and
  // hardcoded spreadCents to 1 so the spread gate could never fire. The entry
  // gate then approved a trade and the executor sent an order into a book with
  // nothing to take. Every one of those was a guaranteed no-fill dressed up as
  // a candidate.
  if (bestYes && bestYes.price > 0) {
    return {
      askCents: 0, askSize: 0, bidCents,
      spreadCents: null,
      source: `no-offers (best bid ${bestYes.price}c, nothing offered)`,
    };
  }

  const shape = `keys=[${Object.keys(ob).join(",")}] yes=${yesLevels.length} no=${noLevels.length}`;
  return { askCents: 0, askSize: 0, bidCents: null, spreadCents: null, source: `book-empty (${shape})` };
}

/**
 * Records why every candidate was refused, per scan, into state.
 *
 * With every rejection carrying a code, the bottleneck becomes a number: 23
 * markets seen, 14 outside the price band, 6 edge too small, 3 stale line. The
 * gate to loosen stops being a matter of opinion.
 */
export function recordScanTally(sportKey, tally, seen, entered, samples = {}) {
  try {
    const state = loadState();
    state.lastScan = state.lastScan || {};
    state.lastScan[sportKey] = {
      at: new Date().toISOString(),
      seen, entered,
      reasons: tally,
      samples,
    };
    // Keep only sports seen in the last hour so this cannot grow unbounded.
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [k, v] of Object.entries(state.lastScan)) {
      if (Date.parse(v.at) < cutoff) delete state.lastScan[k];
    }
    saveState(state);
  } catch {
    // telemetry must never be the reason a scan fails
  }
}

/**
 * Scan one sport.
 *
 * CONTRACT: this function does not throw. Ever. It returns true only to tell
 * the caller to stop scanning further sports this cycle (position cap hit),
 * and false in every other case including failure. One sport failing must
 * never cost the others their turn, and must never be counted as an exchange
 * outage by the circuit breaker.
 */
export async function scanSport(args) {
  const { sportKey } = args;
  try {
    return await runScan(args);
  } catch (err) {
    // Tally it so the dashboard shows the sport as failing rather than as
    // "no opportunities", which is what a swallowed error looks like.
    appendLog(
      `${sportKey}: scan failed and was contained - ${err && err.message ? err.message : String(err)}. ` +
      `Remaining sports are unaffected.`,
      "error"
    );
    if (err && err.stack) appendLog(`${sportKey}: ${String(err.stack).split("\n").slice(0, 3).join(" | ")}`, "error");
    recordScanTally(sportKey, { "scanner-error": 1 }, 0, 0);
    return false;
  }
}

async function runScan({ sportKey, config, bankroll, tickerMap, atCap, skipEvents, positionCap = null }) {
  // ---------------------------------------------------------------------
  // Declared FIRST. This is the fix. Every path below - including the
  // in-play corroboration block, which runs long before the entry loop -
  // can now reach bump() without hitting the temporal dead zone.
  // ---------------------------------------------------------------------
  const tally = {};
  // ONE WORKED EXAMPLE PER CODE. "no-name-match x4" is a number; it is not a
  // thing anyone can fix. "no-name-match x4 - e.g. Sporting KC: no KXMLSGAME
  // market has it on its YES side among 8 same-date markets" is a bug report.
  const samples = {};
  const bump = (code, example = null) => {
    tally[code] = (tally[code] || 0) + 1;
    if (example && !samples[code]) samples[code] = String(example).slice(0, 220);
  };
  const rejected = [];

  let probResult;
  try {
    const tournamentId = (config.oddsPapiTournamentIds || {})[sportKey];
    probResult = await getSharpProbabilities(sportKey, {
      oddsPapiTournamentId: tournamentId,
      providerOrder: config.oddsProviderOrder,
    });
  } catch (err) {
    appendLog(`${sportKey}: odds fetch failed - ${err.message}`, "warn");
    recordScanTally(sportKey, { "odds-fetch-failed": 1 }, 0, 0);
    return false;
  }

  // Every line read is also the fair value of any position on that team. The
  // fair-value exit (botController) reads it from here - held games included,
  // which are dropped as duplicates below before they are ever priced.
  recordFairFromProbabilities(sportKey, probResult.probabilities);

  const teamEntries = Object.entries(probResult.probabilities || {});
  if (!teamEntries.length) {
    recordScanTally(sportKey, { "no-lines-from-provider": 1 }, 0, 0);
    return false;
  }

  const drops = { live: 0, pregame: 0, window: 0, unresolved: 0, closed: 0, error: 0, duplicate: 0 };
  // "8 not-tradeable" told us nothing actionable. Counting the actual status
  // strings turns it into "status=finalized x8", which is a fixable fact.
  const statusCounts = {};
  let sampleReason = null;
  const openEvents = skipEvents instanceof Set ? skipEvents : new Set();
  const allowLive = config.allowLiveGames !== false;   // live trading is ON unless switched off

  const prepared = await Promise.all(teamEntries.map(async ([teamName, info]) => {
    const { trueProbability, commenceTime } = info;

    const timing = entryTiming(commenceTime, {
      entryWindowHours: config.entryWindowHours ?? 0,
      minMinutesBeforeStart: config.minMinutesBeforeStart ?? 0,
    });

    if (timing.live && !allowLive) {
      drops.live++;
      if (!sampleReason) sampleReason = `${teamName}: live trading switched off in config`;
      return null;
    }
    // LIVE ONLY: a game that has not started is not traded - no buy, no
    // resting bid. Checked before the ticker lookup, so it costs no Kalshi call.
    if (!timing.live && config.liveOnly !== false) { drops.pregame++; return null; }
    if (!timing.ok) { drops.window++; return null; }

    let ticker = tickerMap[teamName];
    if (!ticker) {
      const resolved = await resolveTicker({ sportKey, teamName, commenceTime });
      if (!resolved.ticker) {
        // Tally the CAUSE, not just the count. "33 no matching Kalshi market"
        // was one dead end; "18 wrong-date, 11 opponent-side-only, 4
        // none-tradeable" is three fixable things.
        drops.unresolved++;
        bump(`unresolved:${resolved.code || "unknown"}`, `${teamName}: ${resolved.reason}`);
        if (!sampleReason) sampleReason = `${teamName}: ${resolved.reason}`;
        return null;
      }
      ticker = resolved.ticker;
    }

    if (openEvents.has(eventKeyOf(ticker))) { drops.duplicate++; return null; }

    try {
      const res = await kalshiGet(`${V2}/markets/${ticker}`);
      const market = res.market;
      const status = String(market?.status || "").toLowerCase();
      if (!market || !TRADEABLE.has(status)) {
        const label = status || "missing";
        statusCounts[label] = (statusCounts[label] || 0) + 1;
        drops.closed++;
        if (!sampleReason) sampleReason = `${teamName}: status "${status || "missing"}"`;
        return null;
      }

      const pricing = await priceFor(ticker, market);
      return {
        teamName, trueProbability, commenceTime, ticker, market, timing, pricing, sportKey,
        lineAgeSeconds: info.lineAgeSeconds ?? null,
      };
    } catch (err) {
      drops.error++;
      if (!sampleReason) sampleReason = `${teamName}: ${err.message}`;
      return null;
    }
  }));

  let viable = prepared.filter(Boolean);

  // --- In-play corroboration -------------------------------------------
  // One /scores call per sport per scan, and only when something in play
  // actually needs it - that endpoint is billed separately from /odds.
  const livePending = viable.filter((c) => c.timing.live);
  if (livePending.length) {
    if (!paramsFor(sportKey)) {
      appendLog(
        `${sportKey}: ${livePending.length} in-play market(s) skipped - no in-game model exists for this sport, ` +
        `so a stale line could not be detected.`, "warn"
      );
      for (const c of viable) if (c.timing.live) bump("no-model-for-sport");
      viable = viable.filter((c) => !c.timing.live);
    } else {
      let events = [];
      let scoresError = null;
      try {
        const res = await getLiveScores(sportKey);
        events = res.events || [];
        scoresError = res.error || null;
      } catch (err) {
        scoresError = err.message;
      }

      if (scoresError && !events.length) {
        appendLog(`${sportKey}: live scores unavailable (${scoresError}) - in-play markets skipped this cycle.`, "warn");
        for (const c of viable) if (c.timing.live) bump("live-scores-unavailable");
        viable = viable.filter((c) => !c.timing.live);
      } else {
        const vetoed = [];
        viable = viable.filter((c) => {
          if (!c.timing.live) return true;

          const game = findLiveGameForTeam(events, c.teamName);
          if (!game) {
            vetoed.push(`${c.teamName}: in play but no live score found - cannot check the line against the game`);
            bump("no-live-score-match", `${c.teamName}: in play, no live score row matched this team`);
            return false;
          }

          const frac = fractionRemaining(sportKey, c.commenceTime);
          const corr = corroboratedProbability({
            sportKey, sharpProbability: c.trueProbability, lead: game.lead, fracRemaining: frac,
          });
          if (!corr.usable) {
            vetoed.push(`${c.teamName}: in play, could not model the game state`);
            bump("unmodellable", `${c.teamName}: in play, the game state could not be modelled`);
            return false;
          }

          const maxDisagree = config.maxModelDisagreementPoints ?? 12;
          if (corr.disagreementPoints > maxDisagree) {
            vetoed.push(
              `${c.teamName}: sharp line ${(c.trueProbability * 100).toFixed(0)}% vs in-game model ` +
              `${(corr.modelProbability * 100).toFixed(0)}% (${game.homeScore}-${game.awayScore}, ` +
              `${(frac * 100).toFixed(0)}% left) - ${corr.disagreementPoints.toFixed(0)}pt gap exceeds ${maxDisagree}, line is stale`
            );
            bump("model-disagrees", vetoed[vetoed.length - 1]);
            return false;
          }

          // Trade on the more conservative of the two.
          c.trueProbability = corr.probability;
          c.liveContext =
            `${game.homeTeam} ${game.homeScore}-${game.awayScore} ${game.awayTeam}, ` +
            `${(frac * 100).toFixed(0)}% left, model ${(corr.modelProbability * 100).toFixed(0)}%`;
          return true;
        });

        if (vetoed.length) {
          appendLog(`${sportKey}: ${vetoed.length} in-play market(s) vetoed by the game state. First: ${vetoed[0]}`, "warn");
        }
      }
    }
  }

  appendLog(
    `${sportKey}: ${teamEntries.length} lines -> ${viable.length} tradeable ` +
    `(dropped: ${drops.pregame} not started yet (live-only), ${drops.live} live-disabled, ${drops.unresolved} unresolved, ${drops.window} out-of-window, ` +
    `${drops.closed} not-tradeable, ${drops.duplicate} already held, ${drops.error} fetch error)` +
    (sampleReason ? ` | e.g. ${sampleReason}` : "")
  );

  // Assign the COUNT, not a single bump. The old line called bump() once per
  // key, so "6 unresolved" was recorded in the tally as "dropped:unresolved x1"
  // and the Strategy Review under-reported every bulk drop by its whole size.
  // `unresolved` is already itemised by cause above, so it is not repeated here.
  for (const [k, n] of Object.entries(drops)) {
    if (n && k !== "unresolved") tally[`dropped:${k}`] = n;
  }
  for (const [st, n] of Object.entries(statusCounts)) tally[`status:${st}`] = n;

  const maxSpread = config.maxSpreadCents ?? 25;
  let entered = 0;
  let stopScanning = false;

  // RESTING BIDS (makerEngine.js). A market refused as too tight to TAKE is
  // handed to the maker path, which rests a post-only bid at the highest price
  // that still clears the quarter-size maker fee. Any other refusal cancels a
  // bid already resting on that market - its reason for resting is gone.
  const maker = { rested: 0, repriced: 0, kept: 0, cancelled: 0, filled: 0, none: 0, error: 0 };
  let makerExample = null;
  const heldEvents = new Set(loadState().positions.map((p) => eventKeyOf(p.ticker)));
  const dropResting = async (ticker, why) => {
    if (getRestingOrders()[ticker] && await cancelResting(ticker, why)) maker.cancelled++;
  };

  // FUNDED SHARDS FIRST.
  //
  // A candidate on a shard with no collateral cannot fill until Kalshi moves
  // money, which takes seconds it does not control. A candidate on a funded
  // shard can fill right now. Trying them in book order meant a single
  // unfunded market at the front of the list stalled everything behind it -
  // which is exactly what the live log showed at 6:19am, 61 seconds spent on
  // one MLB market while the rest of the board went untouched.
  //
  // Sorting costs nothing and changes the outcome: the fundable trades happen
  // this scan, and the others are requested and picked up on the next one.
  let balances = null;
  try { balances = await fundedShards(); } catch { /* unknown - keep book order */ }
  if (balances) {
    const fundedFor = (c) => {
      const idx = c.market?.exchange_index;
      if (idx == null) return 1;                       // unknown shard - do not penalise
      return (balances[Number(idx)] ?? 0) > 0 ? 1 : 0;
    };
    viable.sort((a, b) => fundedFor(b) - fundedFor(a));
    const unfunded = viable.filter((c) => fundedFor(c) === 0).length;
    if (unfunded) {
      appendLog(
        `${sportKey}: ${unfunded} of ${viable.length} candidate(s) sit on a shard with no collateral - ` +
        `funded shards are traded first.`
      );
    }
  }

  for (const c of viable) {
    if (openEvents.has(eventKeyOf(c.ticker))) continue;

    const askCents = c.pricing.askCents;
    if (askCents <= 0 || askCents >= 100) {
      bump("no-price", `${c.ticker}: ${c.pricing.source}`);
      rejected.push(`${c.ticker}: ${c.pricing.source}`);
      await dropResting(c.ticker, "no usable price in the book");
      continue;
    }

    // A wide book means the quoted ask is not a price anyone is trading at,
    // and any edge measured against it is measurement error.
    if (maxSpread && c.pricing.spreadCents != null && c.pricing.spreadCents > maxSpread) {
      const wide = `${c.ticker}: ${c.pricing.spreadCents}c spread exceeds the ${maxSpread}c limit`;
      bump("spread-too-wide", wide);
      rejected.push(wide);
      await dropResting(c.ticker, "book too wide to trust");
      continue;
    }

    // --- CLV kill switch + earned sizing (clvTracker.js) -------------------
    // A segment whose closing line value is confidently negative does not
    // trade. The candidate is recorded as a SHADOW at the real ask and marked
    // against the real book later, which is how the segment earns its way back.
    const verdict = clvVerdict({ sportKey, live: c.timing.live, priceCents: askCents }, config);
    if (verdict.killed) {
      const line = `${c.ticker} ${askCents}c: ${verdict.killedBy} is killed on negative CLV - shadow-tracked, not traded`;
      bump("clv-killed", line);
      rejected.push(line);
      recordShadow({
        ticker: c.ticker, sportKey, teamName: c.teamName, askCents,
        trueProbability: c.trueProbability, commenceTime: c.commenceTime, live: c.timing.live,
      }, config);
      await dropResting(c.ticker, `${verdict.killedBy} killed on negative CLV`);
      continue;
    }
    // LEARNED FROM RESULTS (outcomeLearner.js): a sport or price band that has
    // won clearly less often than its prices implied, and lost money, is skipped.
    const learned = learnedBlock({ sportKey, priceCents: askCents }, config);
    if (learned.blocked) {
      const line = `${c.ticker} ${askCents}c: ${learned.reason}`;
      bump("learned-block", line);
      rejected.push(line);
      continue;
    }

    // Kelly sizing is EARNED per sport. Until a sport's CLV is confidently
    // positive, it trades the flat survival stake whatever the balance is.
    const earnedKelly = config.clvGatedSizing === false || verdict.proven;
    // FLAT $5 STAKE (2026-09-25, account holder's call). When flatStakeDollars
    // is set, every entry is sized to that stake regardless of balance or
    // sport - it overrides both survival mode and Kelly. Contracts are still
    // capped by the cash actually available.
    // LOSING-STREAK BRAKE: after config.streakBrakeLosses straight losses the
    // flat stake is halved until the next win. Protects the balance only.
    const brake = streakStakeFactor(config);
    const flatStake = Number(config.flatStakeDollars) * brake.factor;
    const sizingSurvival = Number.isFinite(flatStake) && flatStake > 0
      ? { ...(config.survivalMode || {}), balanceThreshold: Infinity, flatBetDollars: flatStake }
      : earnedKelly
        ? config.survivalMode
        : { ...(config.survivalMode || {}), balanceThreshold: Infinity, flatBetDollars: config.survivalMode?.flatBetDollars ?? 1.75 };

    const assessment = assessOpportunity({
      bankroll,
      trueProbability: c.trueProbability,
      price: askCents / 100,
      restingContracts: c.pricing.askSize,
      multiplier: config.feeMultiplier,
      kellyFraction: config.kellyFraction,
      minLiquidity: config.minLiquidity ?? 0,
      maxRiskPctPerTrade: config.maxRiskPctPerTrade ?? 0.20,
      maxStakeDollars: config.maxStakeDollars ?? null,
      maxPlausibleEdge: config.maxPlausibleEdge ?? 0.18,
      // LIVE FLOOR 20c (2026-09-25). Every live buy under 20c has lost: Londrina
      // 16c, Sao Bernardo 13c, Virtus Bologna 13c, -$4.99 together. At those
      // prices the whole-cent fee is 20-40% of the stake. Live 25-55c is the
      // core of the strategy: 35 trades, +$19.00.
      minEntryPriceCents: c.timing.live
        // LIVE BAND 35-70c (2026-09-25): live buys at 35-70c won 65% of the
        // time against 47% implied (+$14.66 over 26); 20-35c won 40%.
        ? Math.max(config.minEntryPriceCents ?? 25, config.liveBandMinCents ?? config.minLiveEntryPriceCents ?? 20)
        : (config.minEntryPriceCents ?? 25),
      // LIVE GAMES CAP AT 80c (2026-09-23). In play, a buy at 85c risks 85c to
      // win 15c, and the in-game model is a few points coarse - the Angels
      // position (85c -> 4c) erased several small wins in one move. Pre-game
      // keeps the full band.
      maxEntryPriceCents: c.timing.live
        ? Math.min(config.maxEntryPriceCents ?? 88, config.liveBandMaxCents ?? config.maxLiveEntryPriceCents ?? 80)
        : (config.maxEntryPriceCents ?? 88),
      minEvCentsPerContract: config.minEvCentsPerContract ?? 0,
      minEvCentsPerTrade: config.minEvCentsPerTrade ?? 1,
      maxWalkupCents: config.maxWalkupCents ?? 4,
      isLiveGame: c.timing.live,
      allowLiveGames: allowLive,
      lineAgeSeconds: c.lineAgeSeconds,
      maxLineAgeSecondsLive: config.maxLineAgeSecondsLive ?? 900,
      maxLineAgeSecondsPregame: config.maxLineAgeSecondsPregame ?? 7200,
      survivalMode: sizingSurvival,
    });

    if (assessment.action === "skip") {
      const line = `${c.ticker} ${askCents}c [${c.pricing.source}] (sharp ${(c.trueProbability * 100).toFixed(1)}%): ${assessment.reason}`;
      bump(assessment.code || "skip-other", line);
      rejected.push(line);
      if (assessment.code === "edge-too-small") {
        const m = await workCandidate({ c, config, bankroll, cap: positionCap, heldEvents });
        maker[m.action] = (maker[m.action] || 0) + 1;
        if (!makerExample || (m.action !== "none" && m.action !== "kept")) makerExample = m.line;
      } else {
        await dropResting(c.ticker, assessment.reason);
      }
      continue;
    }

    // MINIMUM EXPECTED RETURN (2026-09-25). A trade whose expected profit is a
    // sliver of what it risks is not taken: at +1.5% expected (the Islanders
    // entry: 0.5c expected on a 31c limit) the result is luck, not edge.
    //
    // The order limit is pulled DOWN to the highest price that still returns
    // the minimum. The walk-up limit alone would pay up until the edge was
    // nearly gone, so the check is applied to the price the order can actually
    // fill at, not just to the ask. If even the ask does not return the
    // minimum, the trade is skipped.
    const minReturnPct = Number(config.minExpectedReturnPct ?? 10);
    if (minReturnPct > 0) {
      const flat = Number.isFinite(flatStake) && flatStake > 0 ? flatStake : null;
      const countAt = (px) => (flat ? flatBetContracts(flat, px, config.feeMultiplier ?? 0.07) : assessment.sizing.contracts);
      const returnAt = (px) => {
        const ev = c.trueProbability * 100 - px - feePerContractCents(px, countAt(px), config.feeMultiplier ?? 0.07);
        return { ev, pct: (ev / px) * 100 };
      };
      let limit = null;
      for (let px = assessment.limitCents; px >= askCents; px--) {
        if (returnAt(px).pct >= minReturnPct) { limit = px; break; }
      }
      if (limit == null) {
        const r = returnAt(askCents);
        const line = `${c.ticker} ${askCents}c (sharp ${(c.trueProbability * 100).toFixed(1)}%): expected return ` +
          `${r.pct.toFixed(1)}% at the ask (EV ${r.ev.toFixed(1)}c) is under the ${minReturnPct}% minimum`;
        bump("return-too-small", line);
        rejected.push(line);
        continue;
      }
      if (limit !== assessment.limitCents) {
        const r = returnAt(limit);
        assessment.limitCents = limit;
        assessment.walkupCents = limit - askCents;
        assessment.edgeCheck.evCents = r.ev;
        assessment.edgeCheck.observedEdge = c.trueProbability - limit / 100;
        if (flat) assessment.sizing.contracts = countAt(limit);
        assessment.edgeCheck.evTradeCents = r.ev * assessment.sizing.contracts;
        assessment.sizing.dollarsAtRisk = assessment.sizing.contracts * (limit + feePerContractCents(limit, assessment.sizing.contracts, config.feeMultiplier ?? 0.07)) / 100;
      }
    }

    // THE CAP COUNTS RESTING BIDS (2026-09-24). Checked here, at the moment of
    // a taker entry, not at the top of the loop: the scan must keep running at
    // the cap so resting bids keep being re-confirmed and re-priced, or the
    // maker sync would cancel them all as unconfirmed.
    if (atCap()) {
      const line = `${c.ticker}: taker entry refused - positions plus resting bids are at the cap`;
      bump("at-cap", line);
      rejected.push(line);
      continue;
    }

    // A taker entry beats a resting bid on the same game. Cancel the bid
    // first so the account never ends up holding the game twice.
    let bidOnGame = false;
    for (const o of Object.values(getRestingOrders())) {
      if (eventKeyOf(o.ticker) === eventKeyOf(c.ticker)) {
        bidOnGame = true;
        await dropResting(o.ticker, `taking ${c.ticker} at the ask instead`);
      }
    }
    // Cancels clear asynchronously. Until Kalshi confirms the bid is off the
    // book, taking would risk holding this game twice - wait one cycle.
    if (bidOnGame || cancelPendingOnEvent(c.ticker)) {
      rejected.push(`${c.ticker}: taker entry waits one cycle for a resting bid on this game to clear`);
      continue;
    }

    const startsIn = c.timing.live
      ? `LIVE ${Math.abs(c.timing.minutesUntilStart ?? 0).toFixed(0)}m in` +
        (c.lineAgeSeconds != null ? `, quote ${Math.round(c.lineAgeSeconds)}s old` : "")
      : (c.timing.minutesUntilStart != null ? `${c.timing.minutesUntilStart.toFixed(0)}m to start` : "start time unknown");
    const liveNote = c.liveContext ? ` | ${c.liveContext}` : "";
    const walk = assessment.walkupCents > 0
      ? `, limit ${assessment.limitCents}c (+${assessment.walkupCents}c walk-up)`
      : `, limit ${assessment.limitCents}c`;
    appendLog(
      `Candidate ${c.ticker} (${c.teamName}): sharp ${(c.trueProbability * 100).toFixed(1)}% vs ${askCents}c ` +
      `[${c.pricing.source}]${walk}, edge ${(assessment.edgeCheck.observedEdge * 100).toFixed(1)}% at the limit, ` +
      `EV ${assessment.edgeCheck.evCents.toFixed(1)}c/contract (${assessment.edgeCheck.evTradeCents.toFixed(1)}c the trade), ` +
      `${assessment.sizing.contracts} contracts (max $${assessment.sizing.dollarsAtRisk.toFixed(2)}, ` +
      `${earnedKelly ? "Kelly" : `flat - ${sportKey} CLV not proven yet (${verdict.sportStats.n} marks)`}), ${startsIn}${liveNote}`
    );

    let result = null;
    try {
      result = await enterPosition({
        ticker: c.ticker,
        side: "yes",
        priceCents: askCents,
        limitCents: assessment.limitCents,
        exchangeIndex: c.market?.exchange_index ?? null,
        contracts: assessment.sizing.contracts,
        reason:
          `${c.timing.live ? "In-play" : "Pre-game"} edge via ${probResult.provider} on "${c.teamName}" ` +
          // In DOLLARS (2026-09-25): price per contract, money in, and the
          // expected profit on the whole trade - the numbers that matter.
          `(sharp ${(c.trueProbability * 100).toFixed(1)}% vs $${(askCents / 100).toFixed(2)} ask, limit $${(assessment.limitCents / 100).toFixed(2)}, ` +
          `${assessment.sizing.contracts} contracts, $${assessment.sizing.dollarsAtRisk.toFixed(2)} in, ` +
          `expected +$${(assessment.edgeCheck.evTradeCents / 100).toFixed(2)} ` +
          `(${((assessment.edgeCheck.evCents / assessment.limitCents) * 100).toFixed(1)}%))`,
        edgePct: assessment.edgeCheck.observedEdge * 100,
        teamName: c.teamName,
        sportKey,
        commenceTime: c.commenceTime,
      });
    } catch (err) {
      // One rejected order must not cost the remaining candidates their turn.
      bump("order-error");
      rejected.push(`${c.ticker}: order failed - ${err.message}`);
      continue;
    }

    if (result && result.filled > 0) {
      openEvents.add(eventKeyOf(c.ticker));
      heldEvents.add(eventKeyOf(c.ticker));
      entered += 1;
    } else if (result && result.skipped) {
      // NOT the same thing as an order that expired. The executor reports
      // `skipped: "shard-unfunded"` when Kalshi rejected the order because the
      // account's collateral is sitting on a different exchange shard than the
      // market trades on - the edge was real, the size was there, and the
      // trade was lost to plumbing. Counting that as "order placed but nothing
      // filled" made a funding problem look like an illiquid book, which is
      // the opposite of what it is and points at the wrong fix.
      bump(`skipped:${result.skipped}`, `${c.ticker}: ${result.skipped}`);
      rejected.push(`${c.ticker}: order not placed - ${result.skipped}`);
    } else {
      bump("no-fill", `${c.ticker}: limit ${assessment.limitCents}c, nothing crossed before the order expired`);
    }
  }

  const tallyLine = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} x${n}`)
    .join(", ");
  if (tallyLine) {
    appendLog(`${sportKey}: entered ${entered}. Refusals - ${tallyLine}.`);
  }
  if (rejected.length) {
    appendLog(`${sportKey}: e.g. ${rejected[0]}`);
  }
  const makerTouched = Object.values(maker).some((n) => n > 0);
  if (makerTouched) {
    appendLog(
      `${sportKey}: resting bids - ${maker.rested} placed, ${maker.repriced} re-priced, ${maker.kept} kept, ` +
      `${maker.cancelled} cancelled, ${maker.filled} filled while re-pricing, ${maker.none} not placed, ${maker.error} error(s)` +
      (makerExample ? ` | e.g. ${makerExample}` : "")
    );
  }
  recordScanTally(sportKey, tally, teamEntries.length, entered, samples);
  return stopScanning;
}
