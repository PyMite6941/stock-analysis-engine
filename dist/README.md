# Built artifacts

Not in git — these are build outputs, rebuilt from source with the commands
below. See [../APPS.md](../APPS.md) for the full story.

| File | What it is |
|---|---|
| `Stock Analysis Setup 0.1.0.exe` | Windows installer. Run it; the app appears in the Start menu. |
| `Stock-Analysis-debug.apk` | Android app, once built (see below). |

## Rebuild

```bash
# Windows installer  ->  apps/desktop/release/
cd apps/desktop && npm install && npm run dist:win

# Android APK        ->  apps/mobile/dist/
cd apps/mobile && powershell -ExecutionPolicy Bypass -File build-apk.ps1
```

The desktop build needs one bit of setup on Windows: electron-builder unpacks a
code-signing toolchain containing symlinks, and creating those needs Developer
Mode enabled (Settings > System > For developers). Without it the build fails
with `Cannot create symbolic link : A required privilege is not held`. The
already-extracted cache in `%LOCALAPPDATA%\electron-builder\Cache` works around
it on this machine.

## Install the APK on a phone

```bash
adb install -r apps/mobile/dist/app-debug.apk
```

Or copy the .apk to the phone and open it — Android will ask permission to
install from an unknown source, which is expected for an app that has not gone
through the Play Store.
