/**
 * cadence.js
 *
 * Scan cadence by time of day. Sized to use the paid odds tier properly
 * rather than ration it.
 *
 * Faster scanning shortens the gap between a price moving and the bot
 * seeing it. It does not create opportunities that aren't there - the edge
 * threshold and market conditions decide whether anything trades.
 *
 * The real ceiling on speed is Kalshi's own rate limits, not odds credits:
 * every scan also makes Kalshi events/markets calls for ticker resolution.
 *
 * Hours are US Eastern, where most of Kalshi's sports volume sits.
 */

const PEAK_SECONDS = 20;        // 11am - 12am ET: games live, prices moving
const SHOULDER_SECONDS = 60;    // 7am - 11am ET: lines forming, early starts
const OVERNIGHT_SECONDS = 300;  // 12am - 7am ET: overseas fixtures only

export function currentCadenceSeconds(now = new Date()) {
  const etHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }).format(now)
  );

  if (etHour >= 11 || etHour === 0) return PEAK_SECONDS;
  if (etHour >= 7 && etHour < 11) return SHOULDER_SECONDS;
  return OVERNIGHT_SECONDS;
}

export function describeCadence(now = new Date()) {
  const seconds = currentCadenceSeconds(now);
  if (seconds === PEAK_SECONDS) return { seconds, phase: "peak" };
  if (seconds === SHOULDER_SECONDS) return { seconds, phase: "shoulder" };
  return { seconds, phase: "overnight" };
}

/** Rough monthly credit burn at the current cadence, for the dashboard. */
export function estimateMonthlyCredits(activeSportCount = 6) {
  const creditsPerScan = activeSportCount * 2;
  let scansPerDay = 0;
  for (let h = 0; h < 24; h++) {
    const probe = new Date(Date.UTC(2026, 0, 1, (h + 5) % 24, 0));
    scansPerDay += 3600 / currentCadenceSeconds(probe);
  }
  return Math.round(scansPerDay * creditsPerScan * 30);
}
