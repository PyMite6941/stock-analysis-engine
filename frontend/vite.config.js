import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy /api to the FastAPI backend so the browser talks to one origin in dev.
// `--mode app` builds for the packaged shells (Capacitor / Electron).
//
// The only thing that has to change is `base`. On the web the app is served
// from the domain root, so absolute "/assets/..." is correct and must stay:
// a relative base there breaks deep links and the prerendered routes. Inside a
// packaged shell the page is loaded from file:// (Electron) or a bundle root
// (Capacitor), where "/assets/..." resolves to the filesystem root and nothing
// loads at all — a blank window with no error.
export default defineConfig(({ mode }) => ({
  base: mode === "app" ? "./" : "/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  // `vite preview` serves the real production build, which is the only way to
  // exercise the service worker locally — it deliberately does not register in
  // dev. Without this proxy the previewed app has no backend to talk to.
  preview: {
    port: 4173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
}));
