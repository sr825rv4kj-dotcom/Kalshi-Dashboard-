import React from "react";
import { venueLabel } from "./VenueTabs.jsx";

/**
 * Available balance for the selected account - Kalshi, Polymarket, or both
 * added together - with what is tied up in open bets and the total account
 * value underneath, the same three figures the exchanges' own apps show.
 */

function usd(n) {
  return n == null || !Number.isFinite(Number(n))
    ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export default function BalanceBlock({ accounts, venue = "all" }) {
  const k = accounts?.kalshi;
  const p = accounts?.polymarket;
  const pmOn = !!p?.configured;
  const side = venue === "kalshi" ? k : venue === "polymarket" ? p : accounts?.combined;

  let note = null;
  if (venue === "polymarket" && !pmOn) note = "Polymarket not connected - add keys in the Polymarket panel.";
  else if (venue === "polymarket" && p && !p.ok) note = `Polymarket unreachable${p.at ? " - showing the last reading" : ""}: ${p.error ?? ""}`;
  else if (venue === "kalshi" && k && !k.ok) note = `Kalshi unreachable: ${k.error ?? ""}`;
  else if (venue === "all" && ((k && !k.ok) || (pmOn && !p.ok))) note = "One account could not be read - the total may be incomplete.";

  return (
    <div className="balance-block">
      <div className="balance-label">Available Balance · {venueLabel(venue)}</div>
      <div className="balance-value">{usd(side?.cash)}</div>

      <div style={{ position: "relative", display: "flex", gap: 18, marginTop: 12, flexWrap: "wrap", fontVariantNumeric: "tabular-nums" }}>
        <div>
          <div className="balance-label" style={{ fontSize: 10 }}>In open bets</div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{usd(side?.positionsValue)}</div>
        </div>
        <div>
          <div className="balance-label" style={{ fontSize: 10 }}>Account value</div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{usd(side?.equity)}</div>
        </div>
      </div>

      {venue === "all" && (
        <div style={{ position: "relative", marginTop: 12, fontSize: 13, color: "var(--label-secondary)", fontVariantNumeric: "tabular-nums" }}>
          Kalshi {usd(k?.equity)} · Polymarket {pmOn ? usd(p?.equity) : "not connected"}
        </div>
      )}

      {note && <div style={{ position: "relative", marginTop: 10, fontSize: 12.5, color: "var(--orange)" }}>{note}</div>}
    </div>
  );
}
