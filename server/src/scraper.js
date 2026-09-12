const ODDS_API_BASE = "https://api.the-odds-api.com/v4";
const ODDSPAPI_BASE = "https://api.oddspapi.io/v4";
const SHARP_BOOKS = ["pinnacle", "novig"];

async function fromTheOddsApi(sportKey) {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) throw new Error("THE_ODDS_API_KEY not set");

  const url = `${ODDS_API_BASE}/sports/${sportKey}/odds?apiKey=${apiKey}&regions=us,eu&markets=h2h&oddsFormat=decimal`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The-Odds-API ${res.status}: ${await res.text()}`);

  const events = await res.json();
  const quota = { remaining: res.headers.get("x-requests-remaining"), used: res.headers.get("x-requests-used") };

  const probabilities = {};
  for (const event of events) {
    if (new Date(event.commence_time).toDateString() !== new Date().toDateString()) continue;
    const sharpBookmaker = (event.bookmakers || []).find((b) => SHARP_BOOKS.includes(b.key));
    if (!sharpBookmaker) continue;
    const h2h = sharpBookmaker.markets.find((m) => m.key === "h2h");
    if (!h2h) continue;
    const impliedSum = h2h.outcomes.reduce((sum, o) => sum + 1 / o.price, 0);
    for (const outcome of h2h.outcomes) {
      probabilities[outcome.name.toLowerCase()] = {
        trueProbability: 1 / outcome.price / impliedSum,
        sourceBook: sharpBookmaker.key, provider: "the-odds-api",
        eventId: event.id, commenceTime: event.commence_time,
      };
    }
  }
  return { probabilities, quota, provider: "the-odds-api" };
}

async function fromOddsPapi(sportKey, tournamentId) {
  const apiKey = process.env.ODDSPAPI_API_KEY;
  if (!apiKey) throw new Error("ODDSPAPI_API_KEY not set");
  if (!tournamentId) throw new Error(`No OddsPapi tournamentId configured for ${sportKey}`);

  const url = `${ODDSPAPI_BASE}/odds-by-tournaments?bookmaker=pinnacle&tournamentIds=${tournamentId}&apiKey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OddsPapi ${res.status}: ${await res.text()}`);

  const fixtures = await res.json();
  const probabilities = {};
  for (const fixture of fixtures) {
    if (!fixture.hasOdds) continue;
    if (new Date(fixture.startTime).toDateString() !== new Date().toDateString()) continue;
    const pinnacle = fixture.bookmakerOdds?.pinnacle;
    if (!pinnacle || !pinnacle.bookmakerIsActive) continue;
    const moneyline = pinnacle.markets?.["101"];
    if (!moneyline) continue;
    for (const [outcomeKey, outcome] of Object.entries(moneyline.outcomes || {})) {
      const player = outcome.players?.["0"];
      if (!player || player.price == null) continue;
      const label = player.bookmakerOutcomeId || outcomeKey;
      probabilities[`${fixture.fixtureId}:${label}`] = {
        trueProbability: 1 / player.price, sourceBook: "pinnacle", provider: "oddspapi",
        eventId: fixture.fixtureId, commenceTime: fixture.startTime,
      };
    }
  }
  return { probabilities, quota: {}, provider: "oddspapi" };
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
      errors.push(`${providerName}: returned no usable sharp lines for today`);
    } catch (err) {
      errors.push(`${providerName}: ${err.message}`);
    }
  }
  throw new Error(`All odds providers failed or returned nothing for ${sportKey}. ${errors.join(" | ")}`);
}
