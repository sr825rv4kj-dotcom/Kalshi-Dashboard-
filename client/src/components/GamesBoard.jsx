import React, { useEffect, useState } from "react";
import { getTeamColor } from "./teamColors.js";

function formatKickoff(iso) {
  if (!iso) return "TBD";
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export default function GamesBoard({ apiBase }) {
  const [games, setGames] = useState([]);
  const [sportsScanned, setSportsScanned] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function refresh() {
    try {
      setError(null);
      const res = await fetch(`${apiBase}/api/games/live-feed`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setGames(data.games ?? []);
      setSportsScanned(data.sportsScanned ?? []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 60000); // refresh every minute - live status changes
    return () => clearInterval(i);
  }, []);

  return (
    <div className="panel">
      <div className="bot-panel-header">
        <h2>Live Feed - All Sports</h2>
        <span className="muted" style={{ fontSize: 11, fontFamily: "IBM Plex Mono, monospace" }}>
          {sportsScanned.length} in-season sport{sportsScanned.length === 1 ? "" : "s"} scanned
        </span>
      </div>
      <p className="setup-copy">Everything the bot can currently see and consider, across every in-season sport in your pool.</p>
      {loading && <p className="muted">Loading games...</p>}
      {error && <div className="error-banner">{error}</div>}
      {!loading && !error && games.length === 0 && (
        <div className="empty-state">No open Kalshi markets found right now across any in-season sport.</div>
      )}
      <div className="games-grid">
        {games.map((game) => (
          <div key={game.eventTicker} className={`game-card ${game.isLive ? "game-card-live" : ""}`}>
            {game.isLive && <div className="live-badge">LIVE</div>}
            <div className="game-card-sport">{game.sportKey}</div>
            <div className="game-card-teams">
              <div className="game-card-team">
                <span className="team-dot" style={{ background: getTeamColor(game.teamA) }} />
                {game.teamA}
              </div>
              {game.teamB && (
                <div className="game-card-team">
                  <span className="team-dot" style={{ background: getTeamColor(game.teamB) }} />
                  {game.teamB}
                </div>
              )}
            </div>
            <div className="game-card-time">{game.isLive ? "In progress" : formatKickoff(game.startTime)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
