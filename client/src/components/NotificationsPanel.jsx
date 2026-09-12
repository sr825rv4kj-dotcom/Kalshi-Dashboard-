import React, { useEffect, useState } from "react";

export default function NotificationsPanel({ apiBase }) {
  const [status, setStatus] = useState(null);
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedMessage, setSavedMessage] = useState(null);

  async function refresh() {
    try {
      const res = await fetch(`${apiBase}/api/settings/telegram/status`);
      setStatus(await res.json());
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { refresh(); }, []);

  async function handleSave(e) {
    e.preventDefault();
    setError(null); setSavedMessage(null);
    if (!botToken && !chatId) { setError("Enter both your bot token and chat ID."); return; }
    setSaving(true);
    try {
      const res = await fetch(`${apiBase}/api/settings/telegram`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: botToken || undefined, chatId: chatId || undefined }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setBotToken(""); setChatId("");
      setSavedMessage("Saved. You'll get a Telegram message on your next trade, milestone, or halt.");
      refresh();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div className="panel">
      <h2>Push Notifications (Telegram)</h2>
      <p className="setup-copy">
        Real Telegram alerts for trade entries, exits, milestones crossed, and daily halts.
        One-time setup: message <code>@BotFather</code> on Telegram, send <code>/newbot</code>,
        copy the token it gives you. Then message <code>@userinfobot</code> to get your chat ID.
      </p>
      <form onSubmit={handleSave}>
        <label className="field-label">Bot token {status?.configured && <span className="pos">(currently saved)</span>}</label>
        <input type="password" value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="123456:ABC-DEF..." />
        <label className="field-label">Chat ID</label>
        <input type="text" value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="e.g. 998877665" />
        {error && <div className="error-banner setup-error">{error}</div>}
        {savedMessage && <div className="file-chip" style={{ marginTop: 12 }}>{savedMessage}</div>}
        <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save notification settings"}</button>
      </form>
    </div>
  );
}
