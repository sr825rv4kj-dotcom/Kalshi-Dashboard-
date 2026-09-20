/**
 * scraper.js
 *
 * Sharp-line ingestion. Everything downstream - the edge, the size, the
 * decision to trade at all - is measured against the probabilities this file
 * produces, so an error here is not a small error.
 *
 * THE VIG. A bookmaker's two prices sum to more than 100%; the excess is their
 * margin. Feeding raw implied probability into an edge calculation reports an
 * edge that does not exist, on every market, in the same direction.
 *
 * The OddsPapi path did exactly that - `1 / price`, with no devigging. Measured
 * against a 4.5% book margin that is +2.2% of phantom edge at 50c rising to
 * +3.6% at 80c, against a real edge bar of roughly 4-5%. It manufactured
 * qualifying trades out of nothing whenever that provider was in use.
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
  if (!apiKey) throw new Error("THE_ODDS_API_KEY not set");

  const url = `${ODDS_API_BASE}/sports/${sportKey}/odds?apiKey=${apiKey}&regions=us,eu&markets=h2h&oddsFormat=decimal`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The-Odds-API ${res.status}: ${await res.text()}`);

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

    for (const book of sharpBooks) {
      const h2h = (book.markets || []).find((m) => m.key === "h2h");
      if (!h2h || !Array.isArray(h2h.outcomes) || h2h.outcomes.length < 2) continue;

      const raw = h2h.outcomes.map((o) => (o.price > 0 ? 1 / o.price : 0));
      if (raw.some((r) => !(r > 0))) continue;

      const fair = devig(raw);
      if (!fair) continue;                       // implausible overround - drop this book

      booksUsed.push(book.key);
      h2h.outcomes.forEach((o, i) => {
        const name = o.name.toLowerCase();
        if (!byTeam.has(name)) byTeam.set(name, []);
        byTeam.get(name).push(fair[i]);
      });
    }

    if (!booksUsed.length) { rejected.badOverround++; continue; }

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
      };
    }
  }

  return { probabilities, quota, provider: "the-odds-api", rejected };
}

/**
 * OddsPapi. This path previously returned `1 / price` with the margin still in
 * it. Outcomes are now grouped by fixture and devigged together, which is the
 * only way the margin can be removed at all.
 */
async function fromOddsPapi(sportKey, tournamentId) {
  const apiKey = process.env.ODDSPAPI_API_KEY;
  if (!apiKey) throw new Error("ODDSPAPI_API_KEY not set");
  if (!tournamentId) throw new Error(`No OddsPapi tournamentId configured for ${sportKey}`);

  const url = `${ODDSPAPI_BASE}/odds-by-tournaments?bookmaker=pinnacle&tournamentIds=${tournamentId}&apiKey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OddsPapi ${res.status}: ${await res.text()}`);

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
      };
    });
  }

  return { probabilities, quota: {}, provider: "oddspapi", rejected };
}

export async function getSharpProbabilities(sportKey, { oddsPapiTournamentId, providerOrder } = {}) {
  const order = providerOrder && providerOrder.length ? providerOrder : ["the-odds-api", "oddspapi"];
  const errors = [];

  for (let i = 0; i < order.length; i++) {
    const providerName = order[i];
    try {
      const result = providerName === "oddspapi"
        ? await fromOddsPapi(sportKey, oddsPapiTournamentId)
        : await fromTheOddsApi(sportKey);

      if (Object.keys(result.probabilities).length > 0) {
        return i > 0 ? { ...result, fallbackReason: errors.join("; ") } : result;
      }
      const r = result.rejected || {};
      errors.push(
        `${providerName}: no usable sharp lines for today ` +
        `(${r.notToday ?? 0} not today, ${r.noSharpBook ?? 0} no sharp book, ${r.badOverround ?? 0} implausible overround)`
      );
    } catch (err) {
      errors.push(`${providerName}: ${err.message}`);
    }
  }
  throw new Error(`All odds providers failed or returned nothing for ${sportKey}. ${errors.join(" | ")}`);
}
