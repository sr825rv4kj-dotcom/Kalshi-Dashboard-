import React, { useEffect, useState } from "react";
export default function SystemStatusBar({ apiBase }) {
  const [status, setStatus] = useState(null);
  const [tickerCounts, setTickerCounts] = useState(null);

  async function refresh() {
    try {
      const [statusRes, tickerRes] = await Promise.all([
        fetch(`${apiBase}/api/system-status`).then((r) => r.json()),
        fetch(`${apiBase}/api/ticker-map/status`).then((r) => r.json()),
      ]);
      setStatus(statusRes); setTickerCounts(tickerRes);
    } catch { /* handled elsewhere */ }
  }
  useEffect(() => { refresh(); const i = setInterval(refresh, 30000); return () => clearInterval(i); }, []);

  if (!status) return null;
  const items = [
    { label: "Kalshi", ok: status.kalshi.connected, detail: status.kalshi.error || "connected" },
    { label: "The-Odds-API", ok: status.theOddsApi.configured, detail: status.theOddsApi.configured ? "saved" : "not set" },
    { label: "OddsPapi", ok: status.oddsPapi.configured, detail: status.oddsPapi.configured ? "saved" : "not set (fallback)" },
    { label: "Bot", ok: status.botRunning, detail: status.botRunning ? `running (${status.environment})` : "stopped" },
    { label: "Ticker map", ok: (tickerCounts?.sportsTickerCount ?? 0) > 0, detail: `${tickerCounts?.sportsTickerCount ?? 0} sports, ${tickerCounts?.polymarketTickerCount ?? 0} non-sports` },
    { label: "Auto-start", ok: status.autoStartOnBoot, detail: status.autoStartOnBoot ? "on" : "off" },
  ];
  return (
    <div className="system-status-bar">
      {items.map((item) => (
        <div key={item.label} className="system-status-item">
          <span className={`status-chip ${item.ok ? "chip-ok" : "chip-warn"}`}>{item.ok ? "✓" : "!"}</span>
          <span className="system-status-label">{item.label}</span>
          <span className="system-status-detail muted">{item.detail}</span>
        </div>
      ))}
    </div>
  );
}
