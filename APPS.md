# Packaged apps — iOS, Android, desktop

The web app at <https://stock-analysis-engine.vercel.app> is the product. These
shells wrap the *same build* so it can install like a native app. There is no
second codebase: fix something in `frontend/` and every target gets it on the
next build.

```
frontend/dist  ──┬──►  apps/mobile   (Capacitor)  ──┬──► ios/      Xcode project
                 │                                  └──► android/  Gradle project
                 └──►  apps/desktop  (Electron)     ────► Windows / macOS / Linux
```

`apps/` deliberately has no package.json at the repo root: Vercel would install
Electron on every deploy.

## What actually differs in a packaged build

Two things, both handled automatically — worth knowing because both fail
*silently* if you build the wrong way.

**Asset paths.** Vite emits absolute `/assets/...`, which is correct on the web
and useless in a bundle, where it resolves to the filesystem root. The shells
build with `--mode app`, which switches `base` to `./`. Build without it and you
get a **blank window with no error**. The web build must keep `/` — a relative
base breaks deep links there.

**API origin.** The web app is same-origin with its API. A packaged app is not:
it runs from `capacitor://localhost`, `http://localhost` or `file://`, so
`/api/...` points at the bundle. `frontend/src/runtime.js` detects the shell and
switches to an absolute base; the backend allows those origins via CORS with
credentials off. Override the base with `VITE_API_BASE` in `frontend/.env.app`
to point a build at your own backend.

The service worker is deliberately **not** registered in a packaged build — the
shell already ships the assets, so a worker would only add a staler second copy,
and it cannot register on `file://` anyway.

## Desktop (Electron) — built and verified

```bash
cd apps/desktop
npm install
npm start          # builds the web app, then opens the window
npm run dist:win   # or dist:mac / dist:linux -> apps/desktop/release/
```

Built here: `Stock Analysis Setup 0.1.0.exe` (80 MB installer) plus
`release/win-unpacked/Stock Analysis.exe`, copied to `dist/` at the repo root.
Verified: the window opens, the app mounts, the bundled `index.html` references
its assets relatively (`./assets/...`, the blank-window trap above), and a
`file://` page fetches live quotes from the deployed API (`AAPL 338.98`). The
window remembers its size and position, and external links open in your real
browser rather than stranding you in a chrome-less window with no back button.

### If `dist:win` fails on symlinks

```
Cannot create symbolic link : A required privilege is not held by the client
```

electron-builder unpacks a code-signing toolchain that contains macOS symlinks,
and Windows refuses to create them without elevation. Turn on **Developer Mode**
(Settings > System > For developers) and rebuild. Failing that, extract the
archive by hand, excluding the `darwin` directory, into
`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` — the
builder finds the cache already populated and skips the step. Nothing is being
signed either way; the toolchain is downloaded unconditionally.

## Android — one command, not yet built

```powershell
cd apps/mobile
powershell -ExecutionPolicy Bypass -File build-apk.ps1
```

That script does the whole thing: builds the web app with `--mode app`, runs
`cap sync android`, copies the project to an ASCII path (see below), runs
`gradlew assembleDebug`, and drops the APK in `apps/mobile/dist/`. Install it
with `adb install -r apps/mobile/dist/app-debug.apk`, or copy the file to the
phone and open it.

To drive it from Android Studio instead:

```bash
cd apps/mobile
npm install
npx cap sync android      # copies the latest web build into the project
npm run open:android      # opens Android Studio
```

**No APK has been produced yet.** This sandbox blocks `dl.google.com`, which is
the only source for the Android Gradle Plugin, so the build stops at dependency
resolution:

```
Could not resolve com.android.tools.build:gradle:8.2.1
```

`github.com` and `repo1.maven.org` both answer from here, so it is that one host
specifically. On a normal connection it is a one-off download. Everything before
that step — web build, sync, the ASCII copy, the wrapper starting Gradle — runs
clean, so treat only the compile itself as unproven.

### Why the script copies the project first

**This repo lives under `OneDrive\ドキュメント`, and Gradle cannot build from
there.** The JVM mangles the path and the wrapper fails before compiling:

```
Error: Could not find or load main class org.gradle.wrapper.GradleWrapperMain
```

It is the same defect that breaks JavaFX in this workspace, and the usual
escape hatch does not apply: PowerShell resolves an 8.3 short path straight back
to the long one. So the script robocopies to `%TEMP%\sae-android-build` and
builds there. If you move this repo somewhere ASCII-only, the copy becomes
harmless overhead rather than a requirement.

## iOS

```bash
cd apps/mobile
npx cap add ios      # macOS only — needs Xcode and CocoaPods
npx cap sync ios
npm run open:ios
```

Not scaffolded here: `cap add ios` requires macOS. Everything it needs is
already in `capacitor.config.json`, so it should be a single command on a Mac.
Submitting to the App Store needs a paid Apple Developer account; Android APKs
you can build and sideload for free.

## After changing the web app

```bash
cd apps/mobile  && npx cap sync      # refresh both native projects
cd apps/desktop && npm start         # rebuilds automatically
```

`cap sync` copies `frontend/dist` into the native projects. Forgetting it is the
usual reason a change "didn't apply" — the shell is still running the previous
copy.

## Icons

Android launcher icons are generated into every density bucket from the same
candle artwork as the favicon, including the adaptive foreground with its safe
zone. Electron uses `apps/desktop/icon.png`. To regenerate after an artwork
change, re-run the icon script in `frontend/public/` and `npx cap sync`.
