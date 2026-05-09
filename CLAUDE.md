# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Origin of this tree

This directory is **extracted from `../resources/app.asar`** of an installed RoomReady build (parent dir `C:\RoomReady\` contains the Electron runtime and the original `app.asar`). Edits here do **not** affect the running `RoomReady.exe` — the exe loads the `.asar`, not the unpacked files. To iterate locally you either need to:

1. Run from source: `npm run start` (alias for `electron .`) — sees edits live, no repack needed.
2. Repack into the production exe: `npm run pack` — writes `../resources/app.asar` so the next `RoomReady.exe` launch picks up the changes. Exclusion list lives in `pack.js` (excludes `node_modules`, `.node`, `.snapshots`, `.claude`, `package-lock.json`).

This directory **is** a git repository (origin: GitHub `Bommelcode/roomready`, private). `package.json` lists `electron` and `@electron/asar` as devDependencies; install them once with `npm install`. `node_modules/` and `.node/` are gitignored — see `.gitignore`.

## What RoomReady is

Portable Electron desktop app for AV technicians commissioning conference rooms (Logitech MeetUp/Rally, Poly Studio, Jabra PanaCast, etc. — any USB speakerphone/camera). Lets a tech plug a laptop into a room's USB bar and verify camera + mic + speaker + AEC in under 30 seconds. UI language is **Dutch**; code and comments are **English**. The canonical design doc is `ROOMREADY-SPEC.md` — read it before making non-trivial changes. `CHANGELOG.md` records per-version intent (one snapshot per version under `.snapshots/vX.Y.Z/` in the dev tree, not shipped in the asar).

## Build, run, test

```bash
npm run start                    # electron . — run the dev tree directly
npm run pack                     # repack ../resources/app.asar so RoomReady.exe picks up edits
npm run smoke                    # electron test-runner.js — 5s headless renderer load + warn/error capture

# Portable .exe build (separate flow — needs electron-builder ad-hoc):
npx electron-builder --win portable      # → dist/win-unpacked/RoomReady.exe
./maak-exe.bat                            # Windows wrapper around the above
```

There is no linter and no unit-test suite. Verification is manual against the 15-point matrix in `ROOMREADY-SPEC.md` §22. The `smoke` harness is the only automated check and only catches renderer load-time errors.

**Heads-up: if Electron exits in 0.5s with no window, check `$env:ELECTRON_RUN_AS_NODE`.** Some IDE-spawned shells (incl. Claude Code's child shells) inherit `ELECTRON_RUN_AS_NODE=1` at process scope, which forces every Electron binary into Node-only mode (no Chromium, no window). `Remove-Item Env:\ELECTRON_RUN_AS_NODE` (PowerShell) or `unset ELECTRON_RUN_AS_NODE` (bash) before running. A normal user desktop session does not have this set.

## Architecture

Three-process Electron app with vanilla HTML/CSS/JS — **no framework, no bundler, no build step for the renderer**.

- **`main.js`** (~325 lines) — Electron main process. Single `BrowserWindow` (1280×820, `contextIsolation: true`, `nodeIntegration: false`). Registers all IPC handlers inside `createWindow()`. Owns the optional second-screen `previewWin`. Handles VISCA (UDP + TCP), sample-file reads, display enumeration, kiosk-state persistence (`userData/kiosk-state.json`), and the drag-drop ZIP update flow (unzip to %TEMP% → write PS1 + VBS → VBS triggers UAC → robocopy → relaunch).
- **`preload.js`** — Thin `contextBridge.exposeInMainWorld('rrBridge', …)` surface. All renderer↔main calls go through `window.rrBridge.*`. Also wraps `webUtils.getPathForFile` for drag-drop.
- **`renderer.html`** (~5900 lines, monolithic) — The entire UI. Inline `<style>` and `<script>`. Structure follows `ROOMREADY-SPEC.md` §4: header → device bar → grid (mic meter, audio analysis, AEC, loopback, camera preview, video analysis, PTZ, camera controls) → RoomTest panel → overlays/modals.
- **`preview.html`** — Minimal view shown on the second monitor for the customer: idle bars / "Bezig met test" / "Room = Ready" / "Niet klaar". Driven via IPC from the main window.
- **`inventory.html`** — AV-inventarisatie venster (eigen `BrowserWindow`, geopend via header-knop "Inventaris"). Scant Logitech HID, USB UVC en displays via PowerShell in main.js, persisteert rooms + devices in `userData/inventory.json`, CSV-export. Schema 1:1 compatibel met de upstream Python/PyQt6 versie (`inventory/` module). **Geen `node-hid`** — serials komen via `Get-PnpDeviceProperty DEVPKEY_Device_SerialNumber` + PNPDeviceID parsing.
- **`quotes.js`** (~865 KB) — Auto-generated base64-encoded gTTS MP3 quotes, **lazy-loaded** only when the user picks the "Spraak" (speech) AEC signal. Don't import eagerly.
- **`index.html` / `mic-test.html`** — Legacy / scratch files not loaded by `main.js` (which calls `win.loadFile('renderer.html')`). Treat as vestigial unless a task explicitly references them.
- **`../resources/samples/`** — 20 `quoteNN.wav` files plus `quotes.json` (filename → spoken text). Read via the `list-samples` / `read-sample` / `read-quotes-json` IPC handlers in `main.js` (these resolve `process.resourcesPath/samples` when packaged, `__dirname/samples` when running from source).

### IPC surface (preload.js → main.js)

`openExternal`, `applyUpdate`, `openCameraSettings`, `viscaUdp`, `viscaTcp`, `listDisplays`, `openPreview`, `closePreview`, `listSamples`, `readSample`, `readQuotesJson`, `kioskGetState`, `kioskSetState`, `onKioskToggled`, `getFilePath`, `invOpen`, `invScanLogitech`, `invScanUsb`, `invScanDisplays`, `invStoreLoad`, `invStoreSave`, `invFirmwareSync`, `invFirmwareXapi`, `invExportCsv`. When adding a renderer feature that needs OS access, extend both `main.js` (`ipcMain.handle`) and `preload.js` (expose on `rrBridge`) — the renderer cannot use Node APIs directly.

## Hard constraints (load-bearing — from spec §16 "anti-patterns")

These have all caused real, shipped regressions. Do not reintroduce them:

1. **Never** add the `use-fake-ui-for-media-stream` Chromium flag — it hides devices from `enumerateDevices()`.
2. **Windows audio control: nuanced.** A prior version corrupted the Windows audio service system-wide; the exact mechanism wasn't preserved. Following the v3.4.8 retry, the rule is:
   - **OK** — pre-compiled native helper (`helpers/audio-control.exe`, source in `audio-control.cs`) using Core Audio COM (`IMMDeviceEnumerator`, `IAudioEndpointVolume`) for read + per-endpoint volume/mute. Spawned per-action via `child_process.execFile`, COM objects released via `Marshal.ReleaseComObject`, no persistent handles, no callbacks/notifiers.
   - **OK** — in-app digital `GainNode`s tracked via `activeGainNodes` for test playback shaping. This was always allowed and is still the right tool for test-internal volume scaling.
   - **NEVER** — runtime C# compilation via `csc.exe` / `Add-Type -TypeDefinition`. The previous attempt did this and it's the most-likely root cause of the system-wide breakage. If you need a new COM call, add it to the pre-compiled helper and rebuild it once at dev time.
   - **NEVER** — `AudioServiceOutOfProcess` class loading or any direct interaction with `audiosrv` / `audiodg.exe` beyond what Core Audio APIs expose to userspace.
   - **NEVER** — registry writes under `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\...` or audio-policy stores. Use COM Set methods only.
   - **NEVER** — registering `IAudioEndpointVolumeCallback` from Electron. Subscriptions across process boundaries leak handles when the renderer reloads. Poll instead (current implementation: 2s interval).
3. **Never** pass `{ exact: 'default' }` or `{ exact: 'communications' }` to `getUserMedia` — those are virtual Chromium aliases and crash the pipeline. Always gate with `useExact = id && id !== 'default' && id !== 'communications'`.
4. **Never** bridge test audio through `createMediaStreamDestination()` + `<audio>` + `setSinkId()` — use `setSinkId()` on the `AudioContext` itself (Chrome 110+) and connect directly to `spkCtx.destination`.
5. **Never** request audio + video + PTZ permissions in a single combined `getUserMedia` — request audio, then video-with-PTZ (with a plain-video fallback), **separately**, before calling `enumerateDevices()`. Combined requests can hide alternative mics from enumeration.
6. **AEC test**: frequency-selective FFT energy only (bins ±15 Hz around `[220, 277.18, 329.63, 440]` Hz), `fftSize=4096`, `smoothingTimeConstant=0`, `minDecibels=-100`, `maxDecibels=0`. Never broadband RMS. Never smoothing ≠ 0 (smears the peak). Tone volumes `[0.36, 0.26, 0.20, 0.16]` are balanced for clipping-safe mix — don't raise them.
7. **AEC scheduling**: compute `t0 = spkCtx.currentTime` **after all `await`s**, then schedule envelope and oscillator `start`/`stop` against that same `t0`. Scheduling at oscillator-construction time and starting after an `await audioEl.play()` produces "cut-off" tone artifacts.
8. **RoomTest ordering**: render the Mic-niveau step result **before** the AEC step begins — the AEC calibration modal blocks on user input, and a deferred mic render will appear frozen on its spinner.
9. **`app.getPath('userData')` is not valid before `app.whenReady()`.** Wrap any path that depends on it in a lazy getter (see `kioskStatePath()` in `main.js`). Doing this at module top-level silently crashes main-process init and the renderer hangs on IPC calls that never return.

## Conventions worth knowing

- **DOM IDs follow the spec naming** (`qt-*` for RoomTest rows, `aec-curve` / `qt-aec-curve` for the two adaptation canvases, `sel-camera/mic/speaker` for dropdowns, `vol-slider`, `mm-fill`, `aec-calib-modal`, etc. — full list in spec §19). The internal prefix `qt-` predates the "RoomTest" rename and intentionally remains.
- **Device scoring** (spec §5.2) boosts conference-bar labels (Logitech MeetUp/Rally, Poly Studio, Jabra PanaCast, Shure MXA, etc.) and penalises built-in/headset/virtual devices (VB-Cable, Voicemeeter, NDI, Dante). When adding a new brand, follow that scoring shape.
- **Versioning**: bump in **both** `package.json` and the renderer header badge string. Add a `CHANGELOG.md` entry describing *why* before shipping — the changelog is the institutional memory of why specific anti-patterns exist.
- **No `console.log` spam in production** (e.g. no `[MIC] heartbeat` loops). Diagnostic logging is fine during development but remove before release.
- **Portable build quirk**: the exe extracts to `%TEMP%` on launch, so `app.setPath('userData', …)` to `appData/RoomReady` is required for settings persistence — don't "clean that up" as unused code.
