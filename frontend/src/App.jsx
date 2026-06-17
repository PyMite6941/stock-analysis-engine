import { useState } from "react";
import HomePage from "./components/HomePage.jsx";
import AnalysisView from "./components/AnalysisView.jsx";

// Lightweight view switch: market-overview home ↔ full analysis page.
// Searching/clicking a standing on the home page opens the analysis view for it.
export default function App() {
  const [route, setRoute] = useState({ view: "home", query: null });

  if (route.view === "analysis") {
    return (
      <AnalysisView
        key={route.query}             // remount so a new search re-seeds the watchlist
        initialSymbols={route.query}
        onHome={() => setRoute({ view: "home", query: null })}
      />
    );
  }
  return <HomePage onSearch={(q) => setRoute({ view: "analysis", query: q })} />;
}
