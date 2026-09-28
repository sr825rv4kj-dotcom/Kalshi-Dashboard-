import React from "react";

/**
 * Account switcher: Kalshi, Polymarket, or both combined. Drives the balance,
 * P&L chart, open positions, Statement and Trade Log. The choice is
 * remembered on this device.
 */

export const VENUES = [
  ["kalshi", "Kalshi"],
  ["polymarket", "Polymarket"],
  ["all", "Combined"],
];

export function venueLabel(v) {
  return (VENUES.find(([k]) => k === v) || VENUES[2])[1];
}

export function readVenue() {
  try {
    const v = localStorage.getItem("kx-venue");
    return VENUES.some(([k]) => k === v) ? v : "all";
  } catch {
    return "all";
  }
}

export function saveVenue(v) {
  try { localStorage.setItem("kx-venue", v); } catch { /* storage blocked - still works for this visit */ }
}

export default function VenueTabs({ venue, onChange }) {
  return (
    <div className="env-pill-group" role="tablist" aria-label="Account"
      style={{ display: "flex", width: "100%", boxSizing: "border-box", marginBottom: 14 }}>
      {VENUES.map(([v, label]) => (
        <button key={v} type="button" role="tab" aria-selected={venue === v}
          className={`env-pill ${venue === v ? "env-pill-active" : ""}`}
          style={{ flex: 1, padding: "10px 6px" }}
          onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}
