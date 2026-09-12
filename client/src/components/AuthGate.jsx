import React, { useEffect, useState } from "react";
import { getTodaysTheme, applyTheme } from "../theme.js";

const TOKEN_KEY = "kalshi_dashboard_token";

export function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export default function AuthGate({ apiBase, children }) {
  useEffect(() => { applyTheme(getTodaysTheme()); }, []);

  const [checking, setChecking] = useState(true);
  const [hasAccount, setHasAccount] = useState(null);
  const [authenticated, setAuthenticated] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function checkStatus() {
    try {
      const res = await fetch(`${apiBase}/api/auth/status`);
      const data = await res.json();
      setHasAccount(data.hasAccount);

      const token = getStoredToken();
      setAuthenticated(Boolean(token));
    } catch {
      setHasAccount(false);
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => { checkStatus(); }, []);

  async function handleSetup(e) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) { setError("Passwords don't match."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    setBusy(true);
    try {
      const res = await fetch(`${apiBase}/api/auth/setup`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Setup failed.");
      localStorage.setItem(TOKEN_KEY, data.token);
      setAuthenticated(true);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function handleLogin(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${apiBase}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Login failed.");
      localStorage.setItem(TOKEN_KEY, data.token);
      setAuthenticated(true);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  if (checking) return <div className="app"><p className="muted">Loading...</p></div>;

  if (authenticated) return children;

  return (
    <div className="app">
      <div className="masthead"><h1>Portfolio Ledger</h1></div>
      <div className="setup-screen">
        <div className="panel setup-panel">
          <h2>{hasAccount ? "Log in" : "Create your login"}</h2>
          <p className="setup-copy">
            {hasAccount
              ? "This protects your dashboard, since it may be reachable over the internet once deployed."
              : "Set a password to protect this dashboard. You'll only need to log in again if you clear your browser data or switch devices."}
          </p>
          <form onSubmit={hasAccount ? handleLogin : handleSetup}>
            <label className="field-label">Email</label>
            <input type="text" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
            <label className="field-label">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={hasAccount ? "current-password" : "new-password"} />
            {!hasAccount && (
              <>
                <label className="field-label">Confirm password</label>
                <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" />
              </>
            )}
            {error && <div className="error-banner setup-error">{error}</div>}
            <button type="submit" disabled={busy}>{busy ? "Working..." : hasAccount ? "Log in" : "Create account"}</button>
          </form>
        </div>
      </div>
    </div>
  );
}
