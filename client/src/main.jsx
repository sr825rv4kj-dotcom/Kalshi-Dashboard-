import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const isOurApi = API_BASE ? url.startsWith(API_BASE) : url.startsWith("/api/");

  if (isOurApi && !url.includes("/api/auth/") && !url.includes("/api/health")) {
    const token = localStorage.getItem("kalshi_dashboard_token");
    if (token) {
      init = { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } };
    }
  }

  const response = await originalFetch(input, init);

  if (response.status === 401 && isOurApi) {
    localStorage.removeItem("kalshi_dashboard_token");
    window.location.reload();
  }

  return response;
};

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode><App /></React.StrictMode>
);
