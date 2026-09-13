import React, { useEffect, useState } from "react";
import { getTeamColor } from "../teamColors.js";

function formatKickoff(iso) {
  if (!iso) return "TBD";
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export default function GamesBoard({ apiBase }) {
  const [sportKeys, setSportKeys] = useState([]);
  const [selectedSport, setSelectedSport] = useState("americanfootball_nfl");
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`${apiBase}/api/games/sports`)
      .then((r) => r.json())
      .then((d) => setSportKeys(d.sportKeys ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedSport) return;
    setLoading(true); setError(null);
    fetch(`${apiBase}/api/games/${selectedSport}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setGames(d.games ?? []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [selectedSport]);

  return (
    <div className="panel">
      <div className="bot-panel-header">
        <h2>Games Board</h2>
        <select value={selectedSport} onChange={(e) => setSelectedSport(e.target.value)} style={{ width: "auto" }}>
          {sportKeys.map((key) => <option key={key} value={key}>{key}</option>)}
        </select>
      </div>
      {loading && <p className="muted">Loading games...</p>}
      {error && <div className="error-banner">{error}</div>}
      {!loading && !error && games.length === 0 && (
        <div className="empty-state">No open Kalshi markets found for this sport right now.</div>
      )}
      <div className="games-grid">
        {games.map((game) => (
          <div key={game.eventTicker} className="game-card">
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
            <div className="game-card-time">{formatKickoff(game.startTime)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
