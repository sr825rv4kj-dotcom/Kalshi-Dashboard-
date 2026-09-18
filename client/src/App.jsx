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
import BackgroundSettings from "./components/BackgroundSettings.jsx";
import BotConfigPanel from "./components/BotConfigPanel.jsx";
import DiagnosticPanel from "./components/DiagnosticPanel.jsx";
import { getTodaysTheme, applyTheme, setTheme, getTheme, THEME_KEYS } from "./theme.js";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

function DashboardApp() {
  const [theme, setThemeState] = useState(() => getTodaysTheme());
  useEffect(() => { applyTheme(theme); }, [theme]);

  const [checkingConfig, setCheckingConfig] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);

  // Set when you choose "Skip for now". Without it, the first failing Kalshi
  // call bounced you straight back to the credentials screen - the error text
  // contains "credential"/"401", which used to re-arm setNeedsSetup below.
  const [skippedSetup, setSkippedSetup] = useState(false);

  const [balance, setBalance] = useState(null);
  const [positions, setPositions] = useState([]);
  const [orders, setOrders] = useState([]);
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
      const [balanceRes, positionsRes, ordersRes, pnlRes] = await Promise.all([
        fetch(`${API_BASE}/api/balance`).then((r) => r.json()),
        fetch(`${API_BASE}/api/positions`).then((r) => r.json()),
        fetch(`${API_BASE}/api/orders?limit=25`).then((r) => r.json()),
        fetch(`${API_BASE}/api/pnl-history`).then((r) => r.json()),
      ]);
      if (balanceRes.error) throw new Error(balanceRes.error);
      if (positionsRes.error) throw new Error(positionsRes.error);
      if (ordersRes.error) throw new Error(ordersRes.error);
      if (pnlRes.error) throw new Error(pnlRes.error);

      setBalance(balanceRes.balanceDollars);
      setPositions(positionsRes.positions ?? []);
      setOrders(ordersRes.orders ?? []);
      setPnlSeries(pnlRes.series ?? []);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message);
      // Only auto-redirect to setup if you haven't deliberately skipped it.
      // The banner's "Update credentials" button is always available instead.
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
          {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Syncing"}
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
        <h2>Cumulative P&L</h2>
        <PnlChart series={pnlSeries} />
      </div>

      <div className="grid">
        <div className="panel"><h2>Open Positions</h2><PositionsTable positions={positions} /></div>
        <div className="panel"><h2>Recent Orders</h2><OrdersTable orders={orders} /></div>
      </div>

      <BotControlPanel apiBase={API_BASE} />
      <DiagnosticPanel apiBase={API_BASE} />
      <BotConfigPanel apiBase={API_BASE} />
      <GamesBoard apiBase={API_BASE} />
      <MilestonesPanel apiBase={API_BASE} />
      <TradeLedgerPanel apiBase={API_BASE} />
      <NotificationsPanel apiBase={API_BASE} />
      <CostTrackingPanel apiBase={API_BASE} />
      <ApiKeysPanel apiBase={API_BASE} />
      <div className="panel">
        <h2>Appearance</h2>
        <div className="env-pill-group" style={{ width: "fit-content" }}>
          {THEME_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className={`env-pill ${theme.key === key ? "env-pill-active" : ""}`}
              onClick={() => setThemeState(setTheme(key))}
            >
              {getTheme(key).name}
            </button>
          ))}
        </div>
      </div>
      <BackgroundSettings apiBase={API_BASE} />
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
