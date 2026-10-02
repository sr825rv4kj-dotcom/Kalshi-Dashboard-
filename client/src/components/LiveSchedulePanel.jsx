import React, { useEffect, useState } from "react";

/**
 * Live Schedule - the calendar that decides when the bot scans.
 *
 * Built by the server from the odds feed's free events list (every sport the
 * feed has in season, rebuilt every 10 minutes). A sport is scanned on Kalshi
 * and Polymarket only while one of its games is live or starts within 65
 * minutes; the countdown shows when the next one begins. The open-trade cap
 * on each exchange (5-10, by balance) is shown alongside.
 */

function prettySport(key) {
  return String(key || "")
    .replace(/^americanfootball_/, "")
    .replace(/^basketball_/, "")
    .replace(/^baseball_/, "")
    .replace(/^icehockey_/, "")
    .replace(/^soccer_/, "")
    .replace(/^tennis_/, "tennis ")
    .replace(/^cricket_/, "cricket ")
    .replace(/_/g, " ")
    .toUpperCase();
}

function clock(ms) {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function localTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function Venues({ g }) {
  return (
    <span style={{ fontSize: 12.5, opacity: 0.85 }}>
      {g.kalshi ? "Kalshi" : <s>Kalshi</s>} · {g.polymarket ? "Polymarket" : <s>Polymarket</s>}
    </span>
  );
}

// Label left, time or status right (the shared card-head class has no layout).
const HEAD = { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 };

const STATUS_LABEL = {
  live: "Live - scanning",
  "starting-soon": "Starting within 65 min - scanning",
  later: "Later today - waits",
  "none-24h": "No games in the next 24h",
  "calendar-error": "Calendar read failed - scanned anyway",
};

export default function LiveSchedulePanel({ apiBase }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [showAll, setShowAll] = useState(false);
  const [showSports, setShowSports] = useState(false);

  async function refresh() {
    try {
      const res = await fetch(`${apiBase}/api/schedule`);
      const body = await res.json();
      if (body.error) throw new Error(body.error);
      setData(body);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 30000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, []);

  const cap = data?.openTradeCap || {};
  const k = cap.kalshi;
  const p = cap.polymarket;
  const next = data?.next;
  const nextMs = next ? Date.parse(next.commence) - now : NaN;
  const scanStartsMs = next ? nextMs - (data?.leadMinutes ?? 30) * 60000 : NaN;
  const live = data?.live || [];
  const upcoming = (data?.upcoming || []).filter((g) => Date.parse(g.commence) > now);
  const shown = showAll ? upcoming : upcoming.slice(0, 8);

  return (
    <div className="panel">
      <h2>Live Schedule</h2>
      <p className="setup-copy">
        The bot scans a sport on Kalshi and Polymarket only while one of its games
        is live or starts within 65 minutes (pre-game buys open 60 minutes out). The calendar comes from the odds feed
        the bot prices against and rebuilds itself every 10 minutes.
      </p>

      {error && <div className="error-banner" style={{ marginTop: 12 }}>{error}</div>}
      {!data && !error && <div className="ledger-reason">Loading the schedule...</div>}

      {data && !data.ready && (
        <div className="error-banner" style={{ marginTop: 12 }}>
          Schedule not available ({data.reason}). The bot is scanning the way it did
          before - every in-season sport on a clock-based timer - until it is.
        </div>
      )}

      {data && data.ready && (
        <>
          <div className="ledger-figures ledger-summary">
            <div>
              <span>Live now</span>
              <strong className={data.counts?.liveGames ? "pos" : ""}>{data.counts?.liveGames ?? 0}</strong>
            </div>
            <div><span>Scanning</span><strong>{data.counts?.scanning ?? 0} sport(s)</strong></div>
            <div><span>Next 24h</span><strong>{data.counts?.upcoming24h ?? 0}</strong></div>
          </div>

          <div className="ledger-figures ledger-summary" style={{ marginTop: 8 }}>
            <div>
              <span>Kalshi open</span>
              <strong>{k && k.cap != null ? `${k.open} of ${k.cap}` : "—"}</strong>
            </div>
            <div>
              <span>Polymarket open</span>
              <strong>{p && p.cap != null ? `${p.open} of ${p.cap}` : "—"}</strong>
            </div>
            <div>
              <span>Scan every</span>
              <strong>{data.cadence?.seconds ?? "—"}s</strong>
            </div>
          </div>

          {next && (
            <div className="ledger-card" style={{ marginTop: 12 }}>
              <div className="ledger-card-head" style={HEAD}>
                <span>Next start · {prettySport(next.sportKey)}</span>
                <span className="pos">{clock(nextMs)}</span>
              </div>
              <div style={{ marginTop: 6, fontSize: 15 }}>
                {next.home ?? "?"} v {next.away ?? "?"} · {localTime(next.commence)}
              </div>
              <div className="ledger-reason">
                {scanStartsMs > 0 ? `Scanning for it starts in ${clock(scanStartsMs)}.` : "Being scanned now."}
              </div>
            </div>
          )}

          <div className="bot-subsection">
            <h3 style={{ margin: "12px 0 6px" }}>Live now ({live.length})</h3>
            {!live.length && <div className="ledger-reason">No game live right now.</div>}
            {live.map((g) => (
              <div key={`${g.sportKey}-${g.id}`} className="ledger-card">
                <div className="ledger-card-head" style={HEAD}>
                  <span>{prettySport(g.sportKey)}</span>
                  <span className="pos">{Math.max(0, Math.round((now - Date.parse(g.commence)) / 60000))} min in</span>
                </div>
                <div style={{ marginTop: 6, fontSize: 15 }}>{g.home ?? "?"} v {g.away ?? "?"}</div>
                <div className="ledger-reason"><Venues g={g} /></div>
              </div>
            ))}
          </div>

          <div className="bot-subsection">
            <h3 style={{ margin: "12px 0 6px" }}>Coming up</h3>
            {!upcoming.length && <div className="ledger-reason">Nothing on the calendar for the next 24 hours.</div>}
            {shown.map((g) => {
              const ms = Date.parse(g.commence) - now;
              return (
                <div key={`${g.sportKey}-${g.id}`} className="ledger-card">
                  <div className="ledger-card-head" style={HEAD}>
                    <span>{prettySport(g.sportKey)} · {localTime(g.commence)}</span>
                    <span>{clock(ms)}</span>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 15 }}>{g.home ?? "?"} v {g.away ?? "?"}</div>
                  <div className="ledger-reason"><Venues g={g} /></div>
                </div>
              );
            })}
            {upcoming.length > 8 && (
              <button type="button" className="ledger-toggle" onClick={() => setShowAll((v) => !v)} style={{ marginTop: 8 }}>
                {showAll ? "Show fewer" : `Show all ${upcoming.length}`}
              </button>
            )}
          </div>

          <button type="button" className="ledger-toggle" onClick={() => setShowSports((v) => !v)} style={{ marginTop: 12 }}>
            {showSports ? "Hide sports" : `Every sport (${(data.sports || []).length})`}
          </button>
          {showSports && (data.sports || []).map((sp) => (
            <div key={sp.sportKey} className="ledger-card">
              <div className="ledger-card-head" style={HEAD}>
                <span>{prettySport(sp.sportKey)}</span>
                <span className={sp.status === "live" || sp.status === "starting-soon" ? "pos" : sp.status === "calendar-error" ? "neg" : ""}>
                  {STATUS_LABEL[sp.status] || sp.status}
                </span>
              </div>
              <div className="ledger-reason">
                {sp.live ? `${sp.live} live · ` : ""}
                {sp.gamesNext24h} in the next 24h
                {sp.next ? ` · next ${localTime(sp.next)}` : ""} · <Venues g={sp} />
                {sp.error ? ` · ${sp.error}` : ""}
              </div>
            </div>
          ))}

          <div className="ledger-reason" style={{ marginTop: 10 }}>
            Calendar built {ago(data.builtAt)} · rebuilds every {data.refreshMinutes} min
            {data.botRunning === false ? " · bot is stopped" : ""}
          </div>
        </>
      )}
    </div>
  );
}
