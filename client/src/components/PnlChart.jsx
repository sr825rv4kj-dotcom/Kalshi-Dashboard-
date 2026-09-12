import React from "react";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
export default function PnlChart({ series }) {
  if (!series.length) return <div className="empty-state">No settled trades yet.</div>;
  const data = series.map((s) => ({ date: new Date(s.date).toLocaleDateString(), cumulativePnl: Number(s.cumulativePnl.toFixed(2)) }));
  const isPositive = data[data.length - 1].cumulativePnl >= 0;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="pnlFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={isPositive ? "#3ed598" : "#ff6b5e"} stopOpacity={0.35} />
            <stop offset="95%" stopColor={isPositive ? "#3ed598" : "#ff6b5e"} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#202a35" vertical={false} />
        <XAxis dataKey="date" stroke="#7c8a99" tick={{ fontSize: 11, fontFamily: "IBM Plex Mono" }} />
        <YAxis stroke="#7c8a99" tick={{ fontSize: 11, fontFamily: "IBM Plex Mono" }} tickFormatter={(v) => `$${v}`} />
        <Tooltip contentStyle={{ background: "#121821", border: "1px solid #202a35", fontFamily: "IBM Plex Mono", fontSize: 12 }} formatter={(value) => [`$${value}`, "Cumulative P&L"]} />
        <Area type="monotone" dataKey="cumulativePnl" stroke={isPositive ? "#3ed598" : "#ff6b5e"} fill="url(#pnlFill)" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
