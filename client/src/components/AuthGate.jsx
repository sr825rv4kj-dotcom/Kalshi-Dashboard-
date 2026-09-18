import React, { useEffect, useState } from "react";
import { getTodaysTheme, applyTheme } from "../theme.js";

const TOKEN_KEY = "kalshi_dashboard_token";

export function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private browsing - the session still works for this tab.
  }
}

function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
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

  /**
   * Checks the token against the server rather than trusting that one exists.
   * A stale token used to wave you straight past this screen, after which
   * every request failed with 401 and there was no way back to the login form.
   */
  async function checkStatus() {
    try {
      const res = await fetch(`${apiBase}/api/auth/status`);
      const data = await res.json();
      setHasAccount(Boolean(data.hasAccount));

      const token = getStoredToken();
      if (!token) { setAuthenticated(false); return; }

      const verify = await fetch(`${apiBase}/api/auth/verify`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (verify.ok) {
        setAuthenticated(true);
      } else {
        clearToken();
        setAuthenticated(false);
      }
    } catch {
      setHasAccount(false);
      setAuthenticated(false);
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => { checkStatus(); }, []);

  async function submitAuth(e, path) {
    e.preventDefault();
    setError(null);
    if (path === "setup") {
      if (password !== confirmPassword) { setError("Passwords don't match."); return; }
      if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    }
    setBusy(true);
    try {
      const res = await fetch(`${apiBase}/api/auth/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Could not sign you in.");
      storeToken(data.token);
      setPassword("");
      setConfirmPassword("");
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
              ? "This protects your dashboard, since it's reachable over the internet."
              : "Set a password to protect this dashboard. You'll only need it again if you clear your browser data or switch devices."}
          </p>
          <form onSubmit={(e) => submitAuth(e, hasAccount ? "login" : "setup")}>
            <label className="field-label">Email</label>
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              autoComplete="username" autoCapitalize="off" autoCorrect="off"
            />
            <label className="field-label">Password</label>
            <input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete={hasAccount ? "current-password" : "new-password"}
            />
            {!hasAccount && (
              <>
                <label className="field-label">Confirm password</label>
                <input
                  type="password" value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </>
            )}
            {error && <div className="error-banner setup-error">{error}</div>}
            <button type="submit" disabled={busy}>
              {busy ? "Working..." : hasAccount ? "Log in" : "Create account"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
