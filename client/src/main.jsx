import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

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
        <p style={{ margin: 0, fontSize: "15px", color: "rgba(60,60,67,0.6)" }}>
          This is the error that caused it. Reloading rarely helps - the message below is what to fix.
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
