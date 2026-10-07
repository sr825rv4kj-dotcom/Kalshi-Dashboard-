import React, { useEffect, useState } from "react";

/**
 * MONEY REMINDERS (2026-10-06).
 *
 * A banner at the top of every tab when an account needs money: Kalshi or
 * Polymarket cash too low for the next bet, or a Kalshi shard with $0 that is
 * refusing orders. The same alert goes to the phone once through Telegram.
 * Tap × once read - it stays closed for the rest of the day (server/src/fundsAlerts.js).
 */

function resolveBase(apiBase) {
  if (typeof apiBase === "string" && apiBase && apiBase !== "undefined") return apiBase;
  const env = import.meta.env.VITE_API_BASE;
  if (typeof env === "string" && env && env !== "undefined") return env;
  return "";
}

const TONE = {
  critical: { border: "#e5484d", background: "rgba(229, 72, 77, 0.12)" },
  warning: { border: "#f5a524", background: "rgba(245, 165, 36, 0.12)" },
};

export default function FundsAlertBanner({ apiBase }) {
  const base = resolveBase(apiBase);
  const [alerts, setAlerts] = useState([]);

  async function load() {
    try {
      const res = await fetch(`${base}/api/alerts`);
      if (!res.ok) return;
      const data = await res.json();
      setAlerts(Array.isArray(data.alerts) ? data.alerts : []);
    } catch { /* a reminder banner must never break the page */ }
  }

  async function dismiss(id) {
    setAlerts((list) => list.filter((a) => a.id !== id));
    try {
      await fetch(`${base}/api/alerts/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } catch { /* closed on screen either way */ }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);

  if (!alerts.length) return null;

  return (
    <div style={{ margin: "0 0 12px" }}>
      {alerts.map((a) => {
        const tone = TONE[a.severity] || TONE.warning;
        return (
          <div key={a.id} role="alert"
            style={{
              position: "relative", borderLeft: `4px solid ${tone.border}`, background: tone.background,
              borderRadius: 10, padding: "12px 40px 12px 14px", marginBottom: 8,
            }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{a.title}</div>
            <div style={{ fontSize: 14, opacity: 0.9 }}>{a.text}</div>
            <div style={{ fontSize: 13, marginTop: 6, opacity: 0.8 }}>{a.action}</div>
            <button type="button" aria-label="Close" onClick={() => dismiss(a.id)}
              style={{
                position: "absolute", top: 6, right: 6, width: 32, height: 32, border: "none",
                background: "transparent", color: "inherit", fontSize: 22, lineHeight: "32px",
                cursor: "pointer", padding: 0,
              }}>
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
