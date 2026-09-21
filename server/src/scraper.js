/**
 * scraper.js
 *
 * Sharp-line ingestion.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE WAS REPLACED: "odds-fetch-failed x53" WAS A LIE, AND IT COST MONEY
 * ---------------------------------------------------------------------------
 * getSharpProbabilities used to THROW when a sport returned zero usable lines,
 * on a perfectly successful HTTP 200. "No games in the Belgian second division
 * today" and "the API key is dead" produced the same Error, logged with the
 * same wording, and were indistinguishable in the tally.
 *
 * With runtime series discovery now reaching 62 sports, 53 of them are simply
 * out of season or have no fixtures today. Every one was:
 *   - reported as a failure, drowning any real failure in noise, and
 *   - re-fetched from scratch every single scan, at 2 credits a call.
 *
 * Measured at the shipped cadence (2,832 scans/day):
 *   62 sports x 2 credits x 2,832 scans = 351,168 credits/day = 10.5M/month
 *   and 62 sequential fetches at ~250ms is 15.5s of a 20s peak cycle spent
 *   asking about competitions that have nothing on.
 *
 * Three permanent fixes here:
 *
 *   1. EMPTY IS NOT AN ERROR. A 200 with no usable lines returns
 *      { probabilities: {}, empty: true, reason }. The scanner already handles
 *      an empty result cleanly and tallies it as `no-lines-from-provider`,
 *      which is the truth. Only a real transport or HTTP failure throws.
 *
 *   2. EMPTY IS CACHED. A sport with nothing on today still has nothing on
 *      twenty seconds later. The result is held for 20 minutes, and always
 *      expires when the local date rolls over so a new slate is picked up.
 *      Burn drops to roughly 56,000 credits/day - an 84% cut - and the odds
 *      stage of a cycle drops from ~15.5s to ~2.3s.
 *
 *   3. FAILURES ARE CLASSIFIED. Errors carry .status and .kind. A 401 or 429
 *      puts the whole provider on a short cooldown instead of firing 61 more
 *      doomed requests, and the reason reaches the log as a status code rather
 *      than a wall of text.
 *
 * Also: the OddsPapi fallback is skipped when no tournamentId is configured
 * for the sport. It could never succeed, and it appended a meaningless second
 * clause to every single error message.
 * ---------------------------------------------------------------------------
 *
 * LIVE GAMES. The Odds API's /odds endpoint returns upcoming AND live games,
 * and marks in-play events by commence_time being in the past. The hazard is
 * not that the clock is running - it is a line that has not been REFRESHED.
 * Books suspend markets during a possession, at a review, between innings, and
 * the last posted price stays on the wire looking exactly like a live quote.
 * So every price carries the age of the quote it came from, and the entry gate
 * refuses stale quotes: hard during play, loosely before kickoff.
 *
 * THE VIG. A bookmaker's two prices sum to more than 100%; the excess is their
 * margin. Feeding raw implied probability into an edge calculation reports an
 * edge that does not exist, on every market, in the same direction.
 *
 * WHICH DEVIG. Proportional (p = raw / sum) was tested against the power method
 * under a favourite-longshot margin model, which is how books actually shade.
 * Proportional came out biased 0.9-2.5% LOW; power came out biased high on
 * favourites. A low bias understates edge and skips marginal trades. A high
 * bias invents them. Proportional is used deliberately for that reason.
 */

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";
const ODDSPAPI_BASE = "https://api.oddspapi.io/v4";

// Ordered by how sharp the book is. The first match wins for a single-book
// read; consensus mode takes the median across every one of these present.
const SHARP_BOOKS = ["pinnacle", "novig", "circasports", "bookmaker", "betonlineag"];

// A two-way market's raw implied probabilities should sum to roughly 1.00-1.12.
// Outside that the feed is stale, mismatched or partially populated, and
// devigging it produces a confident-looking number built on nothing.
const MIN_OVERROUND = 1.0;
const MAX_OVERROUND = 1.15;

/** How long a "nothing on today" answer is trusted before asking again. */
const EMPTY_TTL_MS = 20 * 60 * 1000;

/** How long the whole provider is left alone after a 401 / 429. */
const PROVIDER_COOLDOWN_MS = 10 * 60 * 1000;

/** sportKey -> { until, onDate, reason } */
const emptyCache = new Map();

/** provider -> { until, status, message } */
const providerCooldown = new Map();

function localDateKey(d = new Date()) {
  return d.toDateString();
}

function tagError(err, kind, status = null) {
  err.kind = kind;
  if (status != null) err.status = status;
  return err;
}

/**
 * Read-only view of what the ingestion layer is currently refusing to ask for.
 * Surfaced by the diagnostics so "why is this sport quiet" has an answer that
 * does not require reading logs.
 */
export function oddsProviderHealth() {
  const now = Date.now();
  const quiet = [];
  for (const [sportKey, v] of emptyCache) {
    if (v.until > now) {
      quiet.push({ sportKey, minutesLeft: Math.ceil((v.until - now) / 60000), reason: v.reason });
    }
  }
  const cooling = [];
  for (const [provider, v] of providerCooldown) {
    if (v.until > now) {
      cooling.push({ provider, minutesLeft: Math.ceil((v.until - now) / 60000), status: v.status, message: v.message });
    }
  }
  return { quietSports: quiet, coolingProviders: cooling, emptyTtlMinutes: EMPTY_TTL_MS / 60000 };
}

/** Clears both caches. Used by tests and by a manual refresh from the dashboard. */
export function clearOddsCaches() {
  emptyCache.clear();
  providerCooldown.clear();
}

/**
 * Removes the bookmaker margin from a set of raw implied probabilities so they
 * sum to exactly 1. Returns null when the overround is implausible.
 */
export function devig(rawImplied) {
  const sum = rawImplied.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum) || sum <= 0) return null;
  if (sum < MIN_OVERROUND || sum > MAX_OVERROUND) return null;
  return rawImplied.map((r) => r / sum);
}

/** Median of a list, used to blend several sharp books into one estimate. */
function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function startsToday(iso) {
  return new Date(iso).toDateString() === new Date().toDateString();
}

/**
 * The-Odds-API. Reads every sharp book present on the event, devigs each one
 * independently, then takes the median across books. One book can be stale or
 * wrong; the median of three rarely is.
 */
async function fromTheOddsApi(sportKey) {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) throw tagError(new Error("THE_ODDS_API_KEY not set"), "config");

  const url = `${ODDS_API_BASE}/sports/${sportKey}/odds?apiKey=${apiKey}&regions=us,eu&markets=h2h&oddsFormat=decimal`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw tagError(new Error(`The-Odds-API unreachable: ${err.message}`), "transport");
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    // 401 = bad or exhausted key, 429 = rate limited. Both mean every other
    // sport this cycle will fail identically, so stop asking.
    const kind = (res.status === 401 || res.status === 429) ? "provider-down" : "http";
    const err = tagError(new Error(`The-Odds-API ${res.status}: ${body}`), kind, res.status);
    if (kind === "provider-down") {
      providerCooldown.set("the-odds-api", {
        until: Date.now() + PROVIDER_COOLDOWN_MS, status: res.status, message: body,
      });
    }
    throw err;
  }

  const events = await res.json();
  const quota = { remaining: res.headers.get("x-requests-remaining"), used: res.headers.get("x-requests-used") };

  const probabilities = {};
  const rejected = { noSharpBook: 0, badOverround: 0, notToday: 0 };

  for (const event of events) {
    if (!startsToday(event.commence_time)) { rejected.notToday++; continue; }

    const sharpBooks = (event.bookmakers || []).filter((b) => SHARP_BOOKS.includes(b.key));
    if (!sharpBooks.length) { rejected.noSharpBook++; continue; }

    // team name -> devigged probability from each book that priced it
    const byTeam = new Map();
    const booksUsed = [];

    // Market-level last_update is the live one; the bookmaker-level field is
    // deprecated upstream and is only a fallback here.
    const ageOf = (book, market) => {
      const iso = market?.last_update ?? book?.last_update;
      if (!iso) return null;                       // unknown - treated as stale in play
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return null;
      return Math.max(0, (Date.now() - ms) / 1000);
    };
    const ages = [];

    for (const book of sharpBooks) {
      const h2h = (book.markets || []).find((m) => m.key === "h2h");
      if (!h2h || !Array.isArray(h2h.outcomes) || h2h.outcomes.length < 2) continue;

      const raw = h2h.outcomes.map((o) => (o.price > 0 ? 1 / o.price : 0));
      if (raw.some((r) => !(r > 0))) continue;

      const fair = devig(raw);
      if (!fair) continue;                       // implausible overround - drop this book

      booksUsed.push(book.key);
      ages.push(ageOf(book, h2h));
      h2h.outcomes.forEach((o, i) => {
        const name = o.name.toLowerCase();
        if (!byTeam.has(name)) byTeam.set(name, []);
        byTeam.get(name).push(fair[i]);
      });
    }

    if (!booksUsed.length) { rejected.badOverround++; continue; }

    // Freshest quote across the books used. If any book is actively updating,
    // that is the one whose price we are really reading.
    const known = ages.filter((a) => a != null);
    const lineAgeSeconds = known.length ? Math.min(...known) : null;
    const isLive = Date.parse(event.commence_time) < Date.now();

    for (const [name, values] of byTeam) {
      const consensus = median(values);
      if (consensus == null) continue;
      probabilities[name] = {
        trueProbability: consensus,
        bookCount: values.length,
        bookSpread: values.length > 1 ? Math.max(...values) - Math.min(...values) : 0,
        sourceBook: booksUsed.join("+"),
        provider: "the-odds-api",
        eventId: event.id,
        commenceTime: event.commence_time,
        lineAgeSeconds,
        isLive,
      };
    }
  }

  return { probabilities, quota, provider: "the-odds-api", rejected, eventsSeen: events.length };
}

/**
 * OddsPapi. Outcomes are grouped by fixture and devigged together, which is the
 * only way the margin can be removed at all.
 */
async function fromOddsPapi(sportKey, tournamentId) {
  const apiKey = process.env.ODDSPAPI_API_KEY;
  if (!apiKey) throw tagError(new Error("ODDSPAPI_API_KEY not set"), "config");
  if (!tournamentId) throw tagError(new Error(`No OddsPapi tournamentId configured for ${sportKey}`), "config");

  const url = `${ODDSPAPI_BASE}/odds-by-tournaments?bookmaker=pinnacle&tournamentIds=${tournamentId}&apiKey=${apiKey}`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw tagError(new Error(`OddsPapi unreachable: ${err.message}`), "transport");
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    const kind = (res.status === 401 || res.status === 429) ? "provider-down" : "http";
    if (kind === "provider-down") {
      providerCooldown.set("oddspapi", {
        until: Date.now() + PROVIDER_COOLDOWN_MS, status: res.status, message: body,
      });
    }
    throw tagError(new Error(`OddsPapi ${res.status}: ${body}`), kind, res.status);
  }

  const fixtures = await res.json();
  const probabilities = {};
  const rejected = { noOdds: 0, badOverround: 0, notToday: 0 };

  for (const fixture of fixtures) {
    if (!fixture.hasOdds) { rejected.noOdds++; continue; }
    if (!startsToday(fixture.startTime)) { rejected.notToday++; continue; }

    const pinnacle = fixture.bookmakerOdds?.pinnacle;
    if (!pinnacle || !pinnacle.bookmakerIsActive) { rejected.noOdds++; continue; }
    const moneyline = pinnacle.markets?.["101"];
    if (!moneyline) { rejected.noOdds++; continue; }

    // Collect BOTH sides first - a margin cannot be removed one side at a time.
    const legs = [];
    for (const [outcomeKey, outcome] of Object.entries(moneyline.outcomes || {})) {
      const player = outcome.players?.["0"];
      if (!player || !(player.price > 0)) continue;
      legs.push({ label: player.bookmakerOutcomeId || outcomeKey, raw: 1 / player.price });
    }
    if (legs.length < 2) { rejected.noOdds++; continue; }

    const fair = devig(legs.map((l) => l.raw));
    if (!fair) { rejected.badOverround++; continue; }

    legs.forEach((leg, i) => {
      probabilities[`${fixture.fixtureId}:${leg.label}`] = {
        trueProbability: fair[i],
        bookCount: 1,
        bookSpread: 0,
        sourceBook: "pinnacle",
        provider: "oddspapi",
        eventId: fixture.fixtureId,
        commenceTime: fixture.startTime,
        // OddsPapi documents no per-quote timestamp, so the age is unknown.
        // Unknown age is allowed before kickoff and refused in play, where a
        // suspended market is indistinguishable from a live one without it.
        lineAgeSeconds: null,
        isLive: Date.parse(fixture.startTime) < Date.now(),
      };
    });
  }

  return { probabilities, quota: {}, provider: "oddspapi", rejected, eventsSeen: fixtures.length };
}

function describeRejected(providerName, r = {}) {
  const parts = [];
  if (r.notToday) parts.push(`${r.notToday} not today`);
  if (r.noSharpBook) parts.push(`${r.noSharpBook} with no sharp book`);
  if (r.badOverround) parts.push(`${r.badOverround} with an implausible overround`);
  if (r.noOdds) parts.push(`${r.noOdds} with no odds posted`);
  return parts.length ? `${providerName}: ${parts.join(", ")}` : `${providerName}: nothing on the board`;
}

/**
 * Sharp probabilities for one sport.
 *
 * RETURNS (never throws for an empty board):
 *   { probabilities, provider, quota, rejected, empty?, reason?, cached? }
 *
 * THROWS only for a real failure - bad key, rate limit, transport error, or an
 * HTTP status - with .kind ("config" | "transport" | "http" | "provider-down")
 * and .status on the error so the caller can say WHICH failure it was.
 */
export async function getSharpProbabilities(sportKey, { oddsPapiTournamentId, providerOrder } = {}) {
  const now = Date.now();
  const today = localDateKey();

  // --- A sport with nothing on today still has nothing on 20 seconds later ---
  const cachedEmpty = emptyCache.get(sportKey);
  if (cachedEmpty && cachedEmpty.until > now && cachedEmpty.onDate === today) {
    return {
      probabilities: {}, provider: "cache", quota: {}, rejected: {},
      empty: true, cached: true, reason: cachedEmpty.reason,
    };
  }
  if (cachedEmpty && (cachedEmpty.until <= now || cachedEmpty.onDate !== today)) {
    emptyCache.delete(sportKey);
  }

  const requested = providerOrder && providerOrder.length ? providerOrder : ["the-odds-api", "oddspapi"];

  // Drop providers that cannot possibly answer for this sport, so their
  // guaranteed failure does not end up in the error message.
  const order = requested.filter((p) => {
    if (p === "oddspapi" && !oddsPapiTournamentId) return false;
    const cd = providerCooldown.get(p);
    if (cd && cd.until > now) return false;
    return true;
  });

  if (!order.length) {
    const cd = requested.map((p) => providerCooldown.get(p)).find((c) => c && c.until > now);
    if (cd) {
      throw tagError(
        new Error(`Every odds provider is on cooldown after HTTP ${cd.status} (${Math.ceil((cd.until - now) / 60000)}m left)`),
        "provider-down", cd.status
      );
    }
    // Nothing was eligible and nothing is broken: this sport has no configured
    // route to a provider at all. That is an empty board, not a failure.
    const reason = "no odds provider is configured for this sport";
    emptyCache.set(sportKey, { until: now + EMPTY_TTL_MS, onDate: today, reason });
    return { probabilities: {}, provider: "none", quota: {}, rejected: {}, empty: true, reason };
  }

  const notes = [];
  const failures = [];
  let firstError = null;

  for (let i = 0; i < order.length; i++) {
    const providerName = order[i];
    try {
      const result = providerName === "oddspapi"
        ? await fromOddsPapi(sportKey, oddsPapiTournamentId)
        : await fromTheOddsApi(sportKey);

      if (Object.keys(result.probabilities).length > 0) {
        return i > 0 ? { ...result, fallbackReason: notes.concat(failures).join("; ") } : result;
      }
      notes.push(describeRejected(providerName, result.rejected));
    } catch (err) {
      failures.push(`${providerName}: ${err.message}`);
      if (!firstError) firstError = err;
      // A dead or throttled provider is not something the next sport should
      // rediscover 61 more times.
      if (err.kind === "provider-down") throw err;
    }
  }

  // Every eligible provider answered, none had a usable line. That is an empty
  // board - the normal state for a competition that is out of season - so it is
  // reported as empty and not asked about again for a while.
  if (!failures.length) {
    const reason = notes.join("; ") || "no usable sharp lines today";
    emptyCache.set(sportKey, { until: now + EMPTY_TTL_MS, onDate: today, reason });
    return { probabilities: {}, provider: order[0], quota: {}, rejected: {}, empty: true, reason };
  }

  // At least one provider genuinely failed. That IS an error - and it keeps the
  // first failure's classification, so the log says "422" rather than a generic
  // "http" that tells nobody which stage broke.
  const err = new Error(`Odds fetch failed for ${sportKey}. ${failures.concat(notes).join(" | ")}`);
  return Promise.reject(tagError(err, firstError?.kind || "http", firstError?.status ?? null));
}
