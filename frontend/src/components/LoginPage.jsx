import { useState } from "react";

export default function LoginPage({ onAuthenticated }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!key.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/health", {
        headers: { Authorization: `Bearer ${key.trim()}` },
      });
      if (r.ok) {
        onAuthenticated(key.trim());
      } else if (r.status === 401) {
        setError("Invalid API key");
      } else {
        setError(`Server error (${r.status})`);
      }
    } catch (e) {
      setError("Cannot reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="logo-mark">📈</div>
        <h1>Stock Analysis Engine</h1>
        <p className="tagline">This instance requires an API key.</p>
        <div className="login-form">
          <input
            autoFocus
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Enter your API key"
            type="password"
          />
          <button onClick={submit} disabled={busy || !key.trim()}>
            {busy ? "Verifying…" : "Sign in"}
          </button>
        </div>
        {error && <p className="error" style={{ marginTop: 12 }}>⚠ {error}</p>}
      </div>
    </div>
  );
}
