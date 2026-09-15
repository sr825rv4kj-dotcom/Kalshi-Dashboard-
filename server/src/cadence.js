/**
 * cadence.js
 *
 * Decides how often to scan based on time of day, so the bot leans in when
 * US sports are actually running and backs off overnight when there is
 * nothing live to trade. No interval to configure.
 *
 * Hours are US Eastern, where the large majority of Kalshi's sports volume
 * sits. Overnight still scans - just rarely - so an early match or an
 * overseas fixture is never missed entirely.
 */

const PEAK_MINUTES = 3;       // 12pm - 11pm ET: games in progress
const SHOULDER_MINUTES = 10;  // 9am - 12pm ET: lines forming, early starts
const OVERNIGHT_MINUTES = 45; // 11pm - 9am ET: little live, stay cheap

export function currentCadenceMinutes(now = new Date()) {
  const etHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }).format(now)
  );

  if (etHour >= 12 && etHour < 23) return PEAK_MINUTES;
  if (etHour >= 9 && etHour < 12) return SHOULDER_MINUTES;
  return OVERNIGHT_MINUTES;
}

export function describeCadence(now = new Date()) {
  const minutes = currentCadenceMinutes(now);
  if (minutes === PEAK_MINUTES) return { minutes, phase: "peak" };
  if (minutes === SHOULDER_MINUTES) return { minutes, phase: "shoulder" };
  return { minutes, phase: "overnight" };
}
