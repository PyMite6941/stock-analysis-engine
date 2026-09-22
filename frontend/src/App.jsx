import { useState, useEffect } from "react";
import HomePage from "./components/HomePage.jsx";
import AnalysisView from "./components/AnalysisView.jsx";
import LoginPage from "./components/LoginPage.jsx";
import InstallBar from "./components/InstallBar.jsx";
import Tour from "./components/Tour.jsx";
import { hasSeenTour } from "./tour.js";
import { loadMode, saveMode } from "./modes.js";
import { apiUrl } from "./runtime.js";

const AUTH_KEY = "sae:api_key";

export default function App() {
  const [route, setRoute] = useState({ view: "home", query: null });
  const [theme, setTheme] = useState(() => localStorage.getItem("sae:theme") || "dark");
  // Mode lives at the top so it survives navigation between home and analysis.
  const [mode, setModeState] = useState(loadMode);
  const [tourOpen, setTourOpen] = useState(false);
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
        const r = await fetch(apiUrl("/api/health"), { headers });
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

  // First visit only: a tour nobody asked for is an annoyance on the second.
  useEffect(() => {
    if (hasSeenTour()) return undefined;
    const t = setTimeout(() => setTourOpen(true), 1200);
    return () => clearTimeout(t);
  }, []);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  const setMode = (id) => { saveMode(id); setModeState(id); };

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

  const shared = { theme, toggleTheme, mode, setMode,
                   onStartTour: () => setTourOpen(true) };

  if (route.view === "analysis") {
    return (
      <>
        <InstallBar />
        <Tour open={tourOpen} mode={mode} onClose={() => setTourOpen(false)} />
        <AnalysisView
          key={route.query}
          initialSymbols={route.query}
          onHome={() => setRoute({ view: "home", query: null })}
          {...shared}
        />
      </>
    );
  }
  return (
    <>
      <InstallBar />
      <Tour open={tourOpen} mode={mode} onClose={() => setTourOpen(false)} />
      <HomePage onSearch={(q) => setRoute({ view: "analysis", query: q })} {...shared} />
    </>
  );
}
