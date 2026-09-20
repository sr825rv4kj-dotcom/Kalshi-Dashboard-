import React, { useEffect, useState } from "react";
import BalanceBlock from "./components/BalanceBlock.jsx";
import PositionsTable from "./components/PositionsTable.jsx";
import OrdersTable from "./components/OrdersTable.jsx";
import PnlChart from "./components/PnlChart.jsx";
import CredentialsSetup from "./components/CredentialsSetup.jsx";
import BotControlPanel from "./components/BotControlPanel.jsx";
import SystemStatusBar from "./components/SystemStatusBar.jsx";
import ApiKeysPanel from "./components/ApiKeysPanel.jsx";
import TradeLedgerPanel from "./components/TradeLedgerPanel.jsx";
import MilestonesPanel from "./components/MilestonesPanel.jsx";
import CostTrackingPanel from "./components/CostTrackingPanel.jsx";
import AuthGate from "./components/AuthGate.jsx";
import NotificationsPanel from "./components/NotificationsPanel.jsx";
import GamesBoard from "./components/GamesBoard.jsx";
import WallpaperPanel from "./components/WallpaperPanel.jsx";
import BotConfigPanel from "./components/BotConfigPanel.jsx";
import DiagnosticPanel from "./components/DiagnosticPanel.jsx";
import SelfCheckPanel from "./components/SelfCheckPanel.jsx";
import { applyWallpaper, readLocal, defaultSettings } from "./wallpapers.js";

const RAW_BASE = import.meta.env.VITE_API_BASE;
const API_BASE =
  typeof RAW_BASE === "string" && RAW_BASE && RAW_BASE !== "undefined" ? RAW_BASE : "";

// Paint the wallpaper from local storage before React renders anything. The
// server copy arrives a moment later and takes over; without this the screen
// flashes plain black on every load while that call is in flight.
try {
  applyWallpaper((readLocal() || defaultSettings()).active);
} catch {
  // a wallpaper must never be the reason the dashboard fails to start
}

function DashboardApp() {
  const [checkingConfig, setCheckingConfig] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);

  // Set when you choose "Skip for now". Without it, the first failing Kalshi
  // call bounced straight back to the credentials screen - the error text
  // contains "credential"/"401", which used to re-arm setNeedsSetup below.
  const [skippedSetup, setSkippedSetup] = useState(false);

  const [balance, setBalance] = useState(null);
  const [positions, setPositions] = useState([]);
  const [pnlSeries, setPnlSeries] = useState([]);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  async function checkConfigured() {
    try {
      const res = await fetch(`${API_BASE}/api/credentials/status`);
      const data = await res.json();
      const configured = Boolean(data.configured);
      if (configured) setSkippedSetup(false);
      setNeedsSetup(!configured && !skippedSetup);
    } catch {
      setNeedsSetup(!skippedSetup);
    } finally {
      setCheckingConfig(false);
    }
  }

  async function loadAll() {
    try {
      setError(null);
      const [balanceRes, positionsRes, pnlRes] = await Promise.all([
        fetch(`${API_BASE}/api/balance`).then((r) => r.json()),
        fetch(`${API_BASE}/api/positions`).then((r) => r.json()),
        fetch(`${API_BASE}/api/pnl-history`).then((r) => r.json()),
      ]);
      if (balanceRes.error) throw new Error(balanceRes.error);
      if (positionsRes.error) throw new Error(positionsRes.error);
      if (pnlRes.error) throw new Error(pnlRes.error);

      setBalance(balanceRes.balanceDollars);
      setPositions(positionsRes.positions ?? []);
      setPnlSeries(pnlRes.series ?? []);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message);
      if (!skippedSetup && /key|credential|401|403/i.test(err.message)) {
        setNeedsSetup(true);
      }
    }
  }

  useEffect(() => { checkConfigured(); }, []);

  useEffect(() => {
    if (checkingConfig || needsSetup) return;
    loadAll();
    const interval = setInterval(loadAll, 60000);
    return () => clearInterval(interval);
  }, [checkingConfig, needsSetup]);

  if (checkingConfig) return <div className="app"><p className="muted">Checking configuration...</p></div>;

  if (needsSetup) {
    return (
      <div className="app">
        <div className="masthead"><h1>Portfolio Ledger</h1></div>
        <CredentialsSetup
          apiBase={API_BASE}
          onSaved={() => { setSkippedSetup(false); setNeedsSetup(false); setError(null); }}
          onSkip={() => { setSkippedSetup(true); setNeedsSetup(false); setError(null); }}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <div className="masthead">
        <h1>Portfolio Ledger</h1>
        <span className="clock">
          {lastUpdated
            ? `Updated ${lastUpdated.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
            : "Syncing"}
        </span>
      </div>

      <SystemStatusBar apiBase={API_BASE} />

      {skippedSetup && (
        <div className="error-banner">
          No Kalshi API key saved - balance, positions and trading are offline.
          <div className="error-action">
            <button onClick={() => { setSkippedSetup(false); setNeedsSetup(true); }}>Add credentials</button>
          </div>
        </div>
      )}

      {error && !skippedSetup && (
        <div className="error-banner">
          Could not reach backend or Kalshi API: {error}
          <div className="error-action">
            <button onClick={() => { setSkippedSetup(false); setNeedsSetup(true); }}>Update credentials</button>
          </div>
        </div>
      )}

      <BalanceBlock balance={balance} />

      <div className="chart-panel panel">
        <h2>Cumulative P&amp;L</h2>
        <PnlChart series={pnlSeries} />
      </div>

      <div className="grid">
        <div className="panel"><h2>Open Positions</h2><PositionsTable positions={positions} /></div>
        <div className="panel"><h2>Statement</h2><OrdersTable /></div>
      </div>

      <BotControlPanel apiBase={API_BASE} />
      <SelfCheckPanel apiBase={API_BASE} />
      <DiagnosticPanel apiBase={API_BASE} />
      <BotConfigPanel apiBase={API_BASE} />
      <GamesBoard apiBase={API_BASE} />
      <MilestonesPanel apiBase={API_BASE} />
      <TradeLedgerPanel apiBase={API_BASE} />
      <NotificationsPanel apiBase={API_BASE} />
      <CostTrackingPanel apiBase={API_BASE} />
      <ApiKeysPanel apiBase={API_BASE} />
      <WallpaperPanel apiBase={API_BASE} />
    </div>
  );
}

export default function App() {
  return (
    <AuthGate apiBase={API_BASE}>
      <DashboardApp />
    </AuthGate>
  );
}
