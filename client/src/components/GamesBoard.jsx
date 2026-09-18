import React, { useEffect, useState } from "react";

/**
 * Team colors are derived from the team name rather than read from a lookup
 * file. That keeps this component self-contained - an earlier version imported
 * "../teamColors.js" and broke the whole build when that file moved, which is
 * not a risk worth carrying for a decorative dot. Hue comes from a hash of the
 * name, with saturation and lightness fixed so every color stays legible.
 */
function teamColor(name) {
  if (!name) return "hsl(0 0% 60%)";
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) % 360;
  }
  return `hsl(${hash} 62% 48%)`;
}

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
    const i = setInterval(refresh, 60000);
    return () => clearInterval(i);
  }, []);

  return (
    <div className="panel">
      <div className="bot-panel-header">
        <h2>Live Feed</h2>
        <span className="muted" style={{ fontSize: 13 }}>
          {sportsScanned.length} sport{sportsScanned.length === 1 ? "" : "s"} active
        </span>
      </div>
      <p className="setup-copy">
        Everything the bot can currently see, across every in-season sport.
      </p>

      {loading && <p className="muted">Loading games...</p>}
      {error && <div className="error-banner">{error}</div>}
      {!loading && !error && games.length === 0 && (
        <div className="empty-state">No open Kalshi markets found right now.</div>
      )}

      <div className="games-grid">
        {games.map((game) => (
          <div key={game.eventTicker} className={`game-card ${game.isLive ? "game-card-live" : ""}`}>
            {game.isLive && <div className="live-badge">LIVE</div>}
            <div className="game-card-sport">{game.sportKey}</div>
            <div className="game-card-teams">
              <div className="game-card-team">
                <span className="team-dot" style={{ background: teamColor(game.teamA) }} />
                {game.teamA}
              </div>
              {game.teamB && (
                <div className="game-card-team">
                  <span className="team-dot" style={{ background: teamColor(game.teamB) }} />
                  {game.teamB}
                </div>
              )}
            </div>
            <div className="game-card-time">
              {game.isLive ? "In progress" : formatKickoff(game.startTime)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
