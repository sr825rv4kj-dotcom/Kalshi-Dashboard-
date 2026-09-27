import React, { useEffect, useState } from "react";

/**
 * Polymarket US - second exchange, same strategy.
 *
 * Shows whether the bot is connected, whether it is trading, the Polymarket
 * balance and open bets, the live self-check, and what the last scan did.
 * Keys are entered here once; the secret is never shown again.
 */

const STEP_LABEL = {
  keys: "API keys",
  "signed-balance": "Signed request (balance)",
  leagues: "Leagues found",
  "games-and-sides": "Games matched to teams",
  prices: "Live prices",
  "preview-buy-yes": "Test order accepted (YES)",
  "preview-buy-no": "Test order accepted (NO side)",
  preview: "Test order",
};

const REASON_LABEL = {
  "pm-pregame": "Game not started (live only)",
  "pm-held-on-kalshi": "Already bet on Kalshi",
  "pm-already-held": "Already held here",
  "pm-game-not-listed": "Game not listed on Polymarket",
  "pm-league-not-listed": "League not on Polymarket",
  "pm-return-too-small": "Expected return under the minimum",
  "pm-edge-too-small": "No edge at this price",
  "pm-price-below-floor": "Price under the live band",
  "pm-price-above-ceiling": "Price over the live band",
  "pm-spread-too-wide": "Spread too wide",
  "pm-model-disagrees": "In-game model disagrees",
  "pm-no-live-score": "No live score for the game",
  "pm-no-side-not-confirmed": "Needs the NO side (turns on after the check)",
  "pm-would-trade": "Would trade (trading not on yet)",
  "pm-at-cap": "At the Polymarket position limit",
  "pm-no-fill": "Order sent, nothing filled",
  "pm-order-error": "Order error",
  "pm-learned-block": "Skipped - sport/band has been losing",
  "pm-halted-for-day": "Paused for today (loss limit)",
  "pm-balance-failed": "Couldn't read the Polymarket balance",
  "pm-game-ambiguous": "Game matched more than once - skipped",
  "pm-side-unknown": "Couldn't tie a market side to the team",
  "pm-side-ambiguous": "Team on more than one side - skipped",
  "pm-no-winner-market": "No open winner market",
  "pm-market-not-open": "Market paused or closed",
  "pm-price-failed": "Couldn't read the price",
  "pm-events-failed": "Couldn't read the games list",
  "pm-order-rejected": "Order rejected by Polymarket",
};

function money(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `$${Number(n).toFixed(2)}`;
}

function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export default function PolymarketPanel({ apiBase }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [keyId, setKeyId] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const [showKeys, setShowKeys] = useState(false);

  async function refresh() {
    try {
      const res = await fetch(`${apiBase}/api/polymarket/status`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20000);
    return () => clearInterval(t);
  }, []);

  async function post(path, body, label) {
    setBusy(label); setError(null); setMessage(null);
    try {
      const res = await fetch(`${apiBase}${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function saveKeys(e) {
    e.preventDefault();
    if (!keyId && !secretKey) { setError("Paste the Key ID and the Secret Key."); return; }
    const data = await post("/api/polymarket/keys", { keyId: keyId || undefined, secretKey: secretKey || undefined }, "keys");
    if (data) {
      setKeyId(""); setSecretKey(""); setShowKeys(false);
      setMessage(data.selfCheck?.passed ? "Saved - connection check passed." : "Saved. Connection check results below.");
      refresh();
    }
  }

  async function setTrading(mode) {
    const data = await post("/api/polymarket/settings", { trading: mode }, "mode");
    if (data) setStatus(data);
  }

  async function runCheck() {
    const data = await post("/api/polymarket/selfcheck", {}, "check");
    if (data) { setMessage(data.passed ? "Check passed." : "Check finished - see the steps below."); refresh(); }
  }

  if (!status) {
    return (
      <div className="panel">
        <h2>Polymarket</h2>
        {error ? <div className="error-banner">{error}</div> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  const mode = status.settings?.trading ?? "auto";
  const pill = !status.configured
    ? { text: "Not connected", cls: "status-off" }
    : status.tradingActive
      ? { text: "Trading", cls: "status-on" }
      : { text: "Watching", cls: "status-off" };
  const sc = status.selfCheck;
  const scan = status.lastScan;
  const reasons = scan ? Object.entries(scan.reasons || {}).sort((a, b) => b[1] - a[1]).slice(0, 5) : [];
  const positions = status.positions || [];
  const acct = status.account;

  return (
    <div className="panel bot-panel">
      <div className="bot-panel-header">
        <h2>Polymarket</h2>
        <span className={`status-dot ${pill.cls}`}>{pill.text}</span>
      </div>

      {!status.configured && (
        <p className="setup-copy">
          Trades Polymarket US with the same strategy as Kalshi, one bet per game across both. Create a key at
          polymarket.us/developer (after identity check in the Polymarket US app), then paste it below.
        </p>
      )}

      {status.configured && (
        <div className="bot-subsection">
          <div className="cost-row"><span>Cash</span><strong>{money(acct?.cash)}</strong></div>
          <div className="cost-row"><span>Account value</span><strong>{money(acct?.equity)}</strong></div>
          <div className="cost-row"><span>Open bets</span><strong>{positions.length} / {status.settings?.maxOpenPositions ?? 3}</strong></div>
          {scan?.stake != null && <div className="cost-row"><span>Stake per trade</span><strong>{money(scan.stake)}</strong></div>}
          {status.haltedForDay && <div className="error-banner" style={{ marginTop: 10 }}>Paused for today - loss limit reached.</div>}
          {status.pausedUntil && <div className="error-banner" style={{ marginTop: 10 }}>Paused after 3 failed orders until {new Date(status.pausedUntil).toLocaleTimeString()}.</div>}
        </div>
      )}

      {status.configured && (
        <div className="bot-subsection" style={{ marginTop: 14 }}>
          <span className="field-label">Trading</span>
          <div className="env-pill-group">
            {[
              ["auto", "Auto"],
              ["on", "On"],
              ["off", "Off"],
            ].map(([v, label]) => (
              <button key={v} type="button" disabled={busy === "mode"}
                className={`env-pill ${mode === v ? "env-pill-active" : ""}`} onClick={() => setTrading(v)}>
                {label}
              </button>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
            Auto trades once the connection check below has passed. {status.noSideActive ? "Both sides of a game can be bought." : "Until the NO-side test passes, it only buys a team listed as the market's YES side."}
          </p>
        </div>
      )}

      {positions.length > 0 && (
        <div className="bot-subsection" style={{ marginTop: 14 }}>
          <span className="field-label">Open on Polymarket</span>
          {positions.map((p) => (
            <div key={p.ticker + p.openedAt} className="cost-row">
              <span style={{ textTransform: "capitalize" }}>{p.teamName}{p.opponent ? <span className="muted" style={{ textTransform: "none" }}> vs {p.opponent}</span> : null}</span>
              <strong>{p.contracts} @ {money(p.entryPriceCents / 100)}</strong>
            </div>
          ))}
        </div>
      )}

      {sc && (
        <div className="bot-subsection" style={{ marginTop: 14 }}>
          <span className="field-label">Connection check {sc.passed ? <span className="pos">passed</span> : <span className="neg">not passed</span>} · {ago(sc.at)}</span>
          {(sc.steps || []).map((s, i) => (
            <div key={i} style={{ fontSize: 13.5, lineHeight: 1.45, marginBottom: 6 }}>
              <span className={s.ok ? "pos" : "neg"}>{s.ok ? "✓" : "✗"}</span>{" "}
              <strong>{STEP_LABEL[s.name] || s.name}</strong>
              <div className="muted" style={{ fontSize: 12.5, marginLeft: 18, wordBreak: "break-word" }}>{s.detail}</div>
            </div>
          ))}
          <button type="button" onClick={runCheck} disabled={busy === "check"} style={{ marginTop: 6 }}>
            {busy === "check" ? "Checking…" : "Run check now"}
          </button>
        </div>
      )}

      {scan && (
        <div className="bot-subsection" style={{ marginTop: 14 }}>
          <span className="field-label">Last scan · {ago(scan.at)} · {scan.seen} live sides · {scan.entered} entered</span>
          {reasons.length === 0 && <p className="muted" style={{ fontSize: 13 }}>No live games on shared sports right now.</p>}
          {reasons.map(([code, n]) => (
            <div key={code} className="cost-row">
              <span style={{ fontSize: 13.5 }}>{REASON_LABEL[code] || code}</span>
              <strong>{n}</strong>
            </div>
          ))}
          {scan.samples?.["pm-would-trade"] && (
            <p className="muted" style={{ fontSize: 12.5, marginTop: 6, wordBreak: "break-word" }}>{scan.samples["pm-would-trade"]}</p>
          )}
        </div>
      )}

      {(!status.configured || showKeys) ? (
        <form onSubmit={saveKeys} style={{ marginTop: 14 }}>
          <label className="field-label">Key ID</label>
          <input value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="Polymarket US Key ID" autoComplete="off" />
          <label className="field-label" style={{ marginTop: 10 }}>Secret Key</label>
          <input type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} placeholder="Shown once when you create the key" autoComplete="off" />
          <button type="submit" disabled={busy === "keys"} style={{ marginTop: 12 }}>{busy === "keys" ? "Saving + checking…" : "Save keys"}</button>
        </form>
      ) : (
        <button type="button" onClick={() => setShowKeys(true)} style={{ marginTop: 14 }}>Replace keys</button>
      )}

      {error && <div className="error-banner setup-error">{error}</div>}
      {message && <div className="file-chip" style={{ marginTop: 12 }}>{message}</div>}
    </div>
  );
}
