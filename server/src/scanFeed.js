/**
 * scanFeed.js
 *
 * THE SCANNER TAB (2026-09-28). What each exchange's scanner decided about
 * every game it looked at, one row per team, in plain words - kept apart for
 * Kalshi and Polymarket so the two are never confused.
 *
 * The scanners already count their refusals ("model-disagrees x2") and keep
 * ONE example per reason. That answers "is something broken" but not "why
 * wasn't THIS game bought on Polymarket". This feed keeps the latest verdict
 * for every team each scanner priced, with the price, the fair value from the
 * betting line, and the exact rule that stopped it (or the fill).
 *
 * In memory only - it refills within one scan cycle after a restart. Rows
 * older than 15 minutes drop off (the game was not looked at since, which
 * means it finished or left the live schedule). A "bought" row stays for the
 * full 15 minutes even while later scans skip the game as already held.
 */

export const SCAN_FEED_VERSION = "2026-09-28-scanner-tab";

const KEEP_MS = 15 * 60 * 1000;
const MAX_ROWS = 200;
const VENUES = ["kalshi", "polymarket"];
const feeds = { kalshi: new Map(), polymarket: new Map() };
const lastScanAt = { kalshi: null, polymarket: null };

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const round1 = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 10) / 10 : null);

/** Marks that a scan ran (so "no rows" can be told apart from "not scanning"). */
export function noteScan(venue) {
  if (VENUES.includes(venue)) lastScanAt[venue] = new Date().toISOString();
}

/**
 * Records one decision. row: { sportKey, team, opponent?, commenceTime?,
 * market?, priceCents?, fairPct?, verdict: "bought"|"skipped"|"tried", code, why }.
 * Never throws.
 */
export function noteDecision(venue, row) {
  try {
    const f = feeds[venue];
    if (!f || !row || !row.team) return;
    const key = `${row.sportKey || ""}|${norm(row.team)}`;
    const now = new Date().toISOString();
    const prev = f.get(key);
    if (prev && prev.verdict === "bought" && row.verdict !== "bought" && Date.now() - Date.parse(prev.at) < KEEP_MS) {
      prev.lastCheckedAt = now;
      return;
    }
    f.set(key, {
      venue,
      sportKey: row.sportKey ?? null,
      team: row.team,
      opponent: row.opponent ?? null,
      commenceTime: row.commenceTime ?? null,
      market: row.market ?? null,
      priceCents: round1(row.priceCents),
      fairPct: round1(row.fairPct),
      verdict: row.verdict || "skipped",
      code: row.code || null,
      why: row.why ? String(row.why).slice(0, 320) : null,
      at: now,
      lastCheckedAt: now,
      firstSeenAt: prev?.firstSeenAt ?? now,
    });
    if (f.size > MAX_ROWS) {
      const oldest = [...f.entries()].sort((a, b) => Date.parse(a[1].lastCheckedAt) - Date.parse(b[1].lastCheckedAt))[0];
      if (oldest) f.delete(oldest[0]);
    }
  } catch { /* the feed must never affect trading */ }
}

/** Latest verdicts for one exchange, newest first, bought on top. */
export function scanFeedReport(venue, now = Date.now()) {
  const f = feeds[venue];
  if (!f) return { venue, lastScanAt: null, rows: [] };
  for (const [k, r] of f) if (now - Date.parse(r.lastCheckedAt) > KEEP_MS) f.delete(k);
  const rows = [...f.values()].sort((a, b) =>
    (a.verdict === "bought" ? 0 : 1) - (b.verdict === "bought" ? 0 : 1) ||
    Date.parse(b.lastCheckedAt) - Date.parse(a.lastCheckedAt)
  );
  return {
    venue,
    version: SCAN_FEED_VERSION,
    lastScanAt: lastScanAt[venue],
    rows,
    counts: {
      teams: rows.length,
      bought: rows.filter((r) => r.verdict === "bought").length,
      skipped: rows.filter((r) => r.verdict !== "bought").length,
    },
  };
}

/** Both exchanges, trimmed, for the monitor. */
export function scanFeedMonitor() {
  const out = {};
  for (const v of VENUES) {
    const r = scanFeedReport(v);
    out[v] = { lastScanAt: r.lastScanAt, counts: r.counts, rows: r.rows.slice(0, 30) };
  }
  return out;
}
