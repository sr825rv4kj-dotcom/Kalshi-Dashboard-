const GAMMA_BASE = "https://gamma-api.polymarket.com";

export async function getPolymarketProbability(slug) {
  const url = `${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url, { headers: { "User-Agent": "kalshi-dashboard/1.0" } });
  if (!res.ok) throw new Error(`Polymarket Gamma API ${res.status}: ${await res.text()}`);

  const events = await res.json();
  const event = events[0];
  if (!event || !event.markets || !event.markets.length) return null;

  const market = event.markets[0];
  let outcomes, prices;
  try {
    outcomes = JSON.parse(market.outcomes);
    prices = JSON.parse(market.outcomePrices);
  } catch {
    throw new Error(`Could not parse outcomes/prices for Polymarket slug "${slug}"`);
  }

  const yesIndex = outcomes.findIndex((o) => o.toLowerCase() === "yes");
  if (yesIndex === -1) return null;

  return { trueProbability: parseFloat(prices[yesIndex]), slug, active: market.active, closed: market.closed, volume: market.volume };
}
