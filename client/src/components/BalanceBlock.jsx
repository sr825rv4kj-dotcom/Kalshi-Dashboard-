import React from "react";
export default function BalanceBlock({ balance }) {
  const display = balance == null ? "—" : balance.toLocaleString("en-US", { style: "currency", currency: "USD" });
  return (
    <div className="balance-block">
      <div className="balance-label">Available Balance</div>
      <div className="balance-value">{display}</div>
    </div>
  );
}
