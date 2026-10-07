import React, { useEffect, useRef, useState } from "react";
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
import ImprovementsPanel from "./components/ImprovementsPanel.jsx";
import SelfCheckPanel from "./components/SelfCheckPanel.jsx";
import StrategyReviewPanel from "./components/StrategyReviewPanel.jsx";
import CoveragePanel from "./components/CoveragePanel.jsx";
import PolymarketPanel from "./components/PolymarketPanel.jsx";
import LiveSchedulePanel from "./components/LiveSchedulePanel.jsx";
import TradingDesk from "./components/TradingDesk.jsx";
import VenueTabs, { readVenue, saveVenue, venueLabel } from "./components/VenueTabs.jsx";
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

const SECTIONS = [["desk", "Desk"], ["performance", "Performance"], ["controls", "Controls"], ["system", "System"]];

function readSection() {
  try {
    const v = localStorage.getItem("kx-section");
    return SECTIONS.some(([k]) => k === v) ? v : "desk";
  } catch {
    return "desk";
  }
}

function DashboardApp() {
  const [checkingConfig, setCheckingConfig] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);

  // Set when you choose "Skip for now". Without it, the first failing Kalshi
  // call bounced straight back to the credentials screen - the error text
  // contains "credential"/"401", which used to re-arm setNeedsSetup below.
  const [skippedSetup, setSkippedSetup] = useState(false);

  // KALSHI / POLYMARKET / COMBINED (2026-09-27). One switch drives the
  // balance, the P&L chart, open positions, the Statement and the Trade Log.
  const [venue, setVenueState] = useState(readVenue);
  // The account on screen right now. A slow response for the account you
  // just switched away from is dropped instead of overwriting the new one.
  const venueRef = useRef(venue);
  const setVenue = (v) => { saveVenue(v); venueRef.current = v; setVenueState(v); };
  const [accounts, setAccounts] = useState(null);
  const [positions, setPositions] = useState([]);
  const [pnlSeries, setPnlSeries] = useState([]);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  // SECTIONS (2026-09-29): Desk (trading now), Performance (results),
  // Controls (settings and keys), System (schedule, coverage, checks).
  const [section, setSectionState] = useState(readSection);
  const setSection = (v) => { try { localStorage.setItem("kx-section", v); } catch { /* still switches */ } setSectionState(v); };

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

  async function loadAll(which = venue) {
    try {
      setError(null);
      const [accountsRes, positionsRes, pnlRes] = await Promise.all([
        fetch(`${API_BASE}/api/accounts`).then((r) => r.json()),
        fetch(`${API_BASE}/api/positions`).then((r) => r.json()),
        fetch(`${API_BASE}/api/pnl-history?venue=${which}`).then((r) => r.json()),
      ]);
      if (which !== venueRef.current) return;
      if (accountsRes.error) throw new Error(accountsRes.error);
      if (pnlRes.error) throw new Error(pnlRes.error);
      setAccounts(accountsRes);
      setPnlSeries(pnlRes.series ?? []);

      // One row shape for both exchanges.
      const kalshiRows = (positionsRes.positions ?? []).map((p) => ({
        venue: "kalshi", ticker: p.ticker, label: p.ticker,
        side: p.position >= 0 ? "YES" : "NO", contracts: Math.abs(p.position),
        exposureDollars: p.marketExposureDollars,
      }));
      const pmRows = (accountsRes.polymarket?.positions ?? []).map((p) => ({
        venue: "polymarket", ticker: p.ticker, label: p.label, side: p.side,
        contracts: p.contracts, exposureDollars: p.valueDollars ?? p.costDollars,
      }));
      setPositions(which === "kalshi" ? kalshiRows : which === "polymarket" ? pmRows : [...kalshiRows, ...pmRows]);

      // Kalshi errors still reach the banner (and the credentials prompt).
      if (positionsRes.error && which !== "polymarket") throw new Error(positionsRes.error);
      setLastUpdated(new Date());
      if (accountsRes.kalshi && !accountsRes.kalshi.ok && which !== "polymarket") throw new Error(accountsRes.kalshi.error);
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
    loadAll(venue);
    const interval = setInterval(() => loadAll(venue), 60000);
    return () => clearInterval(interval);
  }, [checkingConfig, needsSetup, venue]);

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

      <div className="env-pill-group" role="tablist" aria-label="Section"
        style={{ display: "flex", width: "100%", boxSizing: "border-box", margin: "4px 0 14px" }}>
        {SECTIONS.map(([v, text]) => (
          <button key={v} type="button" role="tab" aria-selected={section === v}
            className={`env-pill ${section === v ? "env-pill-active" : ""}`}
            style={{ flex: 1, padding: "10px 4px" }}
            onClick={() => setSection(v)}>
            {text}
          </button>
        ))}
      </div>

      {section === "desk" && (
        <>
          <TradingDesk apiBase={API_BASE} />
          <VenueTabs venue={venue} onChange={setVenue} />
          <BalanceBlock accounts={accounts} venue={venue} />
          <div className="grid">
            <div className="panel"><h2>Open Positions · {venueLabel(venue)}</h2><PositionsTable positions={positions} showVenue={venue === "all"} /></div>
            <div className="panel"><h2>Statement · {venueLabel(venue)}</h2><OrdersTable venue={venue} /></div>
          </div>
        </>
      )}

      {section === "performance" && (
        <>
          <VenueTabs venue={venue} onChange={setVenue} />
          <div className="chart-panel panel">
            <h2>Cumulative P&amp;L · {venueLabel(venue)}</h2>
            <PnlChart series={pnlSeries} />
          </div>
          <TradeLedgerPanel apiBase={API_BASE} venue={venue} />
          <StrategyReviewPanel apiBase={API_BASE} />
          <MilestonesPanel apiBase={API_BASE} />
          <CostTrackingPanel apiBase={API_BASE} />
        </>
      )}

      {section === "controls" && (
        <>
          <BotControlPanel apiBase={API_BASE} />
          <BotConfigPanel apiBase={API_BASE} />
          <PolymarketPanel apiBase={API_BASE} />
          <NotificationsPanel apiBase={API_BASE} />
          <ApiKeysPanel apiBase={API_BASE} />
          <WallpaperPanel apiBase={API_BASE} />
        </>
      )}

      {section === "system" && (
        <>
          <ImprovementsPanel apiBase={API_BASE} />
          <LiveSchedulePanel apiBase={API_BASE} />
          <CoveragePanel apiBase={API_BASE} />
          <SelfCheckPanel apiBase={API_BASE} />
          <DiagnosticPanel apiBase={API_BASE} />
          <GamesBoard apiBase={API_BASE} />
        </>
      )}

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
