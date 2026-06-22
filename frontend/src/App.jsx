import { useState, useEffect } from "react";
import HomePage from "./components/HomePage.jsx";
import AnalysisView from "./components/AnalysisView.jsx";
import LoginPage from "./components/LoginPage.jsx";

const AUTH_KEY = "sae:api_key";

export default function App() {
  const [route, setRoute] = useState({ view: "home", query: null });
  const [theme, setTheme] = useState(() => localStorage.getItem("sae:theme") || "dark");
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem(AUTH_KEY));
  const [needsAuth, setNeedsAuth] = useState(null); // null=checking, true/false

  useEffect(() => {
    document.documentElement.className = theme === "light" ? "light" : "";
    localStorage.setItem("sae:theme", theme);
  }, [theme]);

  // On mount, check if the backend requires auth.
  useEffect(() => {
    async function check() {
      try {
        const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
        const r = await fetch("/api/health", { headers });
        if (r.status === 401) {
          sessionStorage.removeItem(AUTH_KEY);
          setApiKey(null);
          setNeedsAuth(true);
        } else {
          if (apiKey) sessionStorage.setItem(AUTH_KEY, apiKey);
          setNeedsAuth(false);
        }
      } catch {
        setNeedsAuth(true);
      }
    }
    check();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  if (needsAuth === null) {
    return <div className="login-page"><div className="login-card"><p>Connecting…</p></div></div>;
  }

  if (needsAuth) {
    return <LoginPage onAuthenticated={(key) => {
      sessionStorage.setItem(AUTH_KEY, key);
      setApiKey(key);
      setNeedsAuth(false);
    }} />;
  }

  const shared = { theme, toggleTheme };

  if (route.view === "analysis") {
    return (
      <AnalysisView
        key={route.query}
        initialSymbols={route.query}
        onHome={() => setRoute({ view: "home", query: null })}
        {...shared}
      />
    );
  }
  return <HomePage onSearch={(q) => setRoute({ view: "analysis", query: q })} {...shared} />;
}
