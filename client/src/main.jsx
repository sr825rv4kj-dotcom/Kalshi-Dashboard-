import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

/**
 * Every /api route on the backend sits behind a session-token gate, but the
 * components call fetch() directly without setting an Authorization header -
 * so every request came back 401 "Not authenticated", including saving Kalshi
 * credentials. Patching fetch once here attaches the token to every API call,
 * rather than threading it through eighteen components by hand.
 */
const TOKEN_KEY = "kalshi_dashboard_token";
const nativeFetch = window.fetch.bind(window);

window.fetch = function (input, init) {
  const url = typeof input === "string" ? input : (input && input.url) || "";
  if (!url.includes("/api/")) return nativeFetch(input, init);

  let token = null;
  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch {
    token = null; // Safari private mode - just send the request unauthenticated
  }
  if (!token) return nativeFetch(input, init);

    const next = { ...(init || {}) };
  const headers = new Headers((init && init.headers) || {});
  if (!headers.has("Authorization")) headers.set("Authorization", "Bearer " + token);
  next.headers = headers;

  return nativeFetch(input, next).then((res) => {
    // A stored token that the server rejects would otherwise strand you: the
    // login screen is skipped because a token exists, but every call 401s.
    // Clearing it and reloading drops you back to a working login.
    if (res.status === 401 && !url.includes("/api/auth/")) {
      try {
        localStorage.removeItem(TOKEN_KEY);
      } catch {
        // ignore
      }
      window.location.reload();
    }
    return res;
  });
};


/**
 * Without this, any error thrown while rendering leaves an empty <div id="root">
 * and you get a white screen with no way to see why - which is unworkable on a
 * phone where there's no console. This catches it and prints the actual error.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    console.error("[render error]", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    const box = {
      margin: "24px 16px",
      padding: "16px",
      borderRadius: "12px",
      background: "#fff",
      color: "#1c1c1e",
      fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
      lineHeight: 1.45,
    };
    const pre = {
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      fontFamily: "ui-monospace, Menlo, monospace",
      fontSize: "12px",
      background: "rgba(120,120,128,0.12)",
      padding: "12px",
      borderRadius: "8px",
      marginTop: "10px",
    };

    return (
      <div style={box}>
        <h2 style={{ margin: "0 0 6px", fontSize: "19px" }}>The dashboard failed to load</h2>
        <p style={{ margin: 0, fontSize: "15px", color: "rgba(60,60,67,.6)" }}>
          This is the error that caused it.
        </p>
        <div style={pre}>{String(this.state.error?.stack || this.state.error)}</div>
        {this.state.info?.componentStack && (
          <div style={pre}>{this.state.info.componentStack}</div>
        )}
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
