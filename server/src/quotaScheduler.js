const DEFAULT_MIN_INTERVAL_MINUTES = 15;
const DEFAULT_BUFFER_DAYS = 28;

export function computeAdaptiveIntervalMinutes({
  remainingCredits, creditsPerScan,
  minIntervalMinutes = DEFAULT_MIN_INTERVAL_MINUTES,
  bufferDays = DEFAULT_BUFFER_DAYS,
}) {
  const remaining = Number(remainingCredits);
  if (!Number.isFinite(remaining) || remaining <= 0 || !creditsPerScan) return null;
  const scansAffordable = Math.floor(remaining / creditsPerScan);
  if (scansAffordable <= 0) return null;
  const bufferMinutes = bufferDays * 24 * 60;
  const computed = bufferMinutes / scansAffordable;
  return Math.max(minIntervalMinutes, Math.round(computed));
}
