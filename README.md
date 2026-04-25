# RoomReady

Portable Electron desktop-tool voor AV-technici die conferentieruimtes opleveren. Sluit een laptop aan op de zaal-USB en verifieer camera, mic, speaker en latency in 30 seconden. Compatibel met Logitech MeetUp/Rally, Poly Studio, Jabra PanaCast, Shure MXA en andere USB-speakerphones / -cams. UI in het Nederlands; code en comments in het Engels.

Naast de room-test is er een **AV-inventarisatiemodule** die per ruimte alle aangesloten devices scant (Logitech HID, USB UVC cameras, EDID-displays via PowerShell), serienummers vastlegt, optioneel firmwareversies ophaalt via Logitech Sync API of CollabOS xAPI, en exporteert naar CSV.

## Quick start

```powershell
# Eenmalig — ontwikkelen vanuit source
npm install                  # installeert electron + @electron/asar (devDeps)
npm run start                # draait de app vanuit de dev-tree, ziet edits live

# Wijzigingen verwerken in de geïnstalleerde RoomReady.exe
npm run pack                 # repackt ../resources/app.asar (excludes node_modules etc.)

# Smoke test (5s headless renderer load)
npm run smoke
```

De portable Windows-build (`RoomReady.exe`) wordt gemaakt met `electron-builder` (zie `maak-exe.bat`). De build is one-file, geen installer; pakt zichzelf bij start uit naar `%TEMP%`.

## Documentatie

- **[ROOMREADY-SPEC.md](ROOMREADY-SPEC.md)** — canonieke specificatie van wat de app doet en waarom (lees dit voor niet-triviale wijzigingen).
- **[CLAUDE.md](CLAUDE.md)** — gids voor Claude Code / nieuwe contributors: architectuur, hard constraints, gotchas (incl. de `ELECTRON_RUN_AS_NODE` env-var trap die een hele middag heeft gekost).
- **[CHANGELOG.md](CHANGELOG.md)** — versiegeschiedenis met *waarom*-context per versie. Iedere release heeft een snapshot in `.snapshots/vX.Y.Z/` als rollback.

## Structuur

| | |
|---|---|
| `main.js` | Electron main process — IPC handlers, VISCA UDP/TCP, PowerShell-scans voor inventaris, drag-drop ZIP update, kiosk-state |
| `preload.js` | Smalle `rrBridge` contextBridge surface |
| `renderer.html` | Hele hoofd-UI, monolithisch (~5900 lijnen, vanilla HTML/JS, geen bundler) |
| `inventory.html` | Eigen `BrowserWindow` voor de AV-inventaris module |
| `preview.html` | Klantscherm voor tweede monitor |
| `quotes.js` | ~865 KB base64 TTS-quotes, lazy-loaded bij Spraak AEC-signaal |
| `audio/` | TTS MP3 samples voor Speaker+Mic test |
| `.snapshots/` | Per-versie rollback-kopie (5 files: main/preload/renderer/preview/inventory + package.json) |

## Hard constraints

Anti-patterns die echt productie-problemen hebben veroorzaakt en niet teruggebracht moeten worden — zie [CLAUDE.md §"Hard constraints"](CLAUDE.md). De belangrijkste:

- Géén `use-fake-ui-for-media-stream` Chromium flag (verbergt devices uit `enumerateDevices`)
- Géén Windows master-volume manipulatie via `csc.exe` of COM (corrumpeert de hele audio service)
- Géén `{ exact: 'default' }` of `{ exact: 'communications' }` aan `getUserMedia` doorgeven (virtuele aliases, crashen pipeline)
- Géén gecombineerde audio+video+PTZ in één `getUserMedia` call (verbergt alternatieve mics)
- `app.getPath('userData')` lazy aanroepen — **niet** op module-niveau (zie v3.3.2 incident)
