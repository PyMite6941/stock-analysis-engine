// Runs before the app, with no Node exposed to it.
//
// The single flag tells frontend/src/runtime.js that it is inside the desktop
// shell, so it uses an absolute API base instead of a relative "/api/..." that
// would resolve against file:// and fetch nothing.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("__SAE_DESKTOP__", true);
contextBridge.exposeInMainWorld("__SAE_PLATFORM__", process.platform);
