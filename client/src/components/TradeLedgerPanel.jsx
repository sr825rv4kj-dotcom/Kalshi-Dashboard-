import React, { useEffect, useState } from "react";
function formatTimestamp(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
export default function TradeLedgerPanel({ apiBase }) {
  const [trades, setTrades] = useState([]);
  const [error, setError] = useState(null);
  async function refresh() {
    try {
      const res = await fetch(`${apiBase}/api/trade-ledger?limit=50`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setTrades(data.trades ?? []);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { refresh(); const i = setInterval(refresh, 30000); return () => clearInterval(i); }, []);
  return (
    <div className="panel">
      <h2>Trade History (Real Orders Only)</h2>
      <p className="setup-copy">Every entry is a real order placed on Kalshi, with the bot's reasoning at that moment. Permanent - never trimmed.</p>
      {error && <div className="error-banner">{error}</div>}
      {!trades.length ? <div className="empty-state">No trades placed yet.</div> : (
        <table>
          <thead><tr><th>Timestamp</th><th>Action</th><th>Ticker</th><th>Side</th><th>Price</th><th>Filled</th><th>Env</th><th>Reason</th></tr></thead>
          <tbody>{trades.map((t, i) => (
            <tr key={i}>
              <td className="muted" style={{ whiteSpace: "nowrap" }}>{formatTimestamp(t.timestamp)}</td>
              <td className={t.action === "enter" ? "pos" : "neg"}>{t.action}</td>
              <td>{t.ticker}</td><td>{t.side?.toUpperCase()}</td><td>{t.priceCents}c</td>
              <td>{t.filled}/{t.contracts}</td><td className="muted">{t.environment}</td>
              <td style={{ maxWidth: 320 }}>{t.reason}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}
