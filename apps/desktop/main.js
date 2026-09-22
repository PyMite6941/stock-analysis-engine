// Electron shell. The renderer is the same built web app, loaded from disk.
//
// Two things make this more than a browser in a box:
//   * the window remembers its size and position between launches;
//   * external links open in the real browser rather than replacing the app,
//     so clicking a news story cannot strand the user in a chrome-less window
//     with no back button.

const { app, BrowserWindow, shell, Menu } = require("electron");
const path = require("path");
const fs = require("fs");

// Packaged, the web build is copied into resources/app by electron-builder.
// Running from source, it is two directories up.
const WEB_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "app")
  : path.join(__dirname, "..", "..", "frontend", "dist");

const STATE_FILE = path.join(app.getPath("userData"), "window-state.json");

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch { /* first run, or a corrupt file — fall through to defaults */ }
  return { width: 1400, height: 900 };
}

function saveState(win) {
  try {
    if (win.isMinimized() || win.isFullScreen()) return;
    const [width, height] = win.getSize();
    const [x, y] = win.getPosition();
    fs.writeFileSync(STATE_FILE, JSON.stringify({ width, height, x, y }));
  } catch { /* losing window position is not worth surfacing */ }
}

function createWindow() {
  const state = readState();
  const win = new BrowserWindow({
    ...state,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: "#0d1117",   // avoids a white flash before the app paints
    title: "Stock Analysis",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // The renderer is our own build, but it fetches remote data and renders
      // remote text, so it gets no Node access regardless.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const index = path.join(WEB_DIR, "index.html");
  if (!fs.existsSync(index)) {
    // A clear message beats a blank window when someone runs this before
    // building the web app.
    win.loadURL("data:text/html," + encodeURIComponent(
      `<body style="background:#0d1117;color:#e6edf3;font:14px system-ui;padding:40px">
        <h2>Web build missing</h2>
        <p>Expected <code>${index}</code>.</p>
        <p>Run <code>npm run build:web</code> in <code>apps/desktop</code> first.</p>
      </body>`));
  } else {
    win.loadFile(index);
  }

  // Anything that isn't this app opens in the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  let saveTimer;
  const queueSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveState(win), 400);
  };
  win.on("resize", queueSave);
  win.on("move", queueSave);
  win.on("close", () => saveState(win));

  return win;
}

app.whenReady().then(() => {
  // Keep the standard edit/view menu (copy, paste, zoom, devtools) but drop
  // the Electron boilerplate help items.
  const template = Menu.getApplicationMenu()?.items
    ?.filter((i) => i.role !== "help");
  if (template) Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // macOS convention is to stay alive with no windows; everywhere else quits.
  if (process.platform !== "darwin") app.quit();
});
