# Build the Android APK.
#
# Gradle cannot run from this repo's own path: it lives under
# a path with non-ASCII characters, and the JVM fails to load GradleWrapperMain before
# compiling anything. So this copies the project to an ASCII-only directory,
# builds there, and brings the APK back.
#
#   powershell -ExecutionPolicy Bypass -File build-apk.ps1
#   powershell -ExecutionPolicy Bypass -File build-apk.ps1 -Release

param([switch]$Release)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$work = Join-Path $env:TEMP "sae-android-build"
$task = if ($Release) { "assembleRelease" } else { "assembleDebug" }
$kind = if ($Release) { "release" } else { "debug" }

Write-Host "1/4  Building the web app (app mode: relative asset paths)…"
Push-Location (Join-Path $here "..\..\frontend")
npm install --silent
npm run build -- --mode app
Pop-Location

Write-Host "2/4  Syncing it into the native project…"
Push-Location $here
npx cap sync android
Pop-Location

Write-Host "3/4  Copying to an ASCII path ($work)…"
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Force -Path $work | Out-Null
robocopy $here $work /E /NFL /NDL /NJH /NJS /NP /XD node_modules\.cache | Out-Null

Write-Host "4/4  Gradle $task …"
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk" }
if (-not $env:JAVA_HOME)    { $env:JAVA_HOME    = "C:\Program Files\Android\Android Studio\jbr" }
Push-Location (Join-Path $work "android")
& .\gradlew.bat $task --no-daemon
$code = $LASTEXITCODE
Pop-Location

if ($code -ne 0) {
  Write-Host "`nGradle failed (exit $code)." -ForegroundColor Red
  Write-Host "If it says 'Could not resolve com.android.tools.build:gradle', your"
  Write-Host "network is blocking dl.google.com — that host is the only source for"
  Write-Host "the Android Gradle Plugin."
  exit $code
}

$apk = Get-ChildItem "$work\android\app\build\outputs\apk\$kind" -Filter *.apk |
       Select-Object -First 1
$out = Join-Path $here "dist"
New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-Item $apk.FullName (Join-Path $out $apk.Name) -Force
Write-Host ""
$final = Join-Path $out $apk.Name
Write-Host "APK -> $final" -ForegroundColor Green
Write-Host "Install on a connected phone with:"
Write-Host "  adb install -r '$final'"
