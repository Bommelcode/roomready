# RoomReady — complete specificatie voor herbouw

Versie doelspecs: **v4.0.0** (clean rebuild)  
Platform: **Windows 10/11 portable** (Electron)  
Taal: **Nederlands (UI)**, Engels in code/commentaar  
Gebruiker: AV-technicus die conferentieruimtes (BYOD) test en oplevert

---

## 1. Doel & context

RoomReady is een desktop-tool voor AV-technici die conferentieruimtes testen na installatie of bij klachten. De typische setup: een vergaderzaal met een Logitech MeetUp/Rally Bar (of vergelijkbare USB speakerphone), een PC/laptop die via USB is aangesloten, en een extern scherm. De technicus sluit zijn laptop aan via de zaal-USB, opent RoomReady, en kan binnen 30 seconden verifiëren of camera + mic + speaker + AEC correct werken.

Primair scherm: technicus. Extern scherm (optioneel): klant — die ziet een simpelere "Room Ready / Bezig / Niet Klaar" statusweergave.

## 2. Technische stack

- **Electron 29.x** (portable Windows build)
- **electron-builder** met `portable` target (geen installer, één .exe)
- Geen framework — gewoon HTML/CSS/JS in `renderer.html`
- Geen bundler, geen npm dependencies behalve Electron + builder
- Bestanden: `main.js`, `preload.js`, `renderer.html`, `preview.html`, `quotes.js` (optional, 1.3MB base64 TTS audio lazy-loaded)
- Build command: `npx electron-builder --win portable`
- Output: `dist/win-unpacked/RoomReady.exe`

## 3. Electron main process (main.js)

**Houd dit minimaal. Alleen toevoegen wat strikt nodig is.**

### 3.1 App configuratie

```js
// Portable data persistence — zorg dat Chromium niet elke start als 'nieuw' behandelt
const path = require('path')
const fixedUserData = path.join(app.getPath('appData'), 'RoomReady')
app.setPath('userData', fixedUserData)

// Unieke Windows-identity voor taakbalk en meldingen
app.setAppUserModelId('nl.silstranders.roomready')
```

### 3.2 BrowserWindow

- 1280×820, minWidth 960, minHeight 680
- `backgroundColor: '#0e1219'`
- `nodeIntegration: false`, `contextIsolation: true`, preload.js verplicht
- `icon: path.join(__dirname, 'icon.ico')`

### 3.3 Permissies

```js
session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
  cb(['media','camera','microphone','audioCapture','videoCapture',
      'pan-tilt-zoom','camera-pan-tilt-zoom'].includes(permission))
})
session.defaultSession.setPermissionCheckHandler(() => true)
```

### 3.4 Chromium flags — BELANGRIJK

**NIET gebruiken:**
- `use-fake-ui-for-media-stream` — verbergt devices uit enumerateDevices()
- `AudioServiceOutOfProcess` / `HardwareMediaKeyHandling` flags
- Geen polling van Windows COM-interfaces (GEEN csc.exe helpers voor volume)

**Wel gebruiken:**
- `log-level 3` (mute niet-kritieke Chromium logs)

### 3.5 IPC handlers die main.js exposed

- `open-external` — `shell.openExternal(url)`
- `open-camera-settings` — opent Windows camera privacy settings
- `list-displays` — `screen.getAllDisplays()` voor monitor-keuze
- `open-preview` / `close-preview` — opent preview.html op externe monitor
- `visca-udp` / `visca-tcp` — stuur VISCA-commando naar IP-camera
- `apply-update` — drag-drop ZIP update (PowerShell + UAC flow)

**NIET toevoegen:**
- Volume-controle via csc.exe of COM — volume is in-app digitaal via Web Audio GainNode
- Audio device enumeration — alles gaat via navigator.mediaDevices in renderer

## 4. Renderer architectuur

Alles in één `renderer.html`. Inline `<style>` en `<script>`. Geen bundler.

Structuur:
```
<header>           ← logo, knoppen (RoomTest, Teams, Update), thema-toggle
<div id="device-bar">  ← Camera/Mic/Speaker dropdowns + testvolume-slider
<main grid>
  ├ Mic input meter
  ├ Audio analyse (oscilloscope + spectrum)
  ├ Echo cancellation test (tone/pink/speech + curve + result)
  ├ Loopback (delay slider)
  ├ Camera preview
  ├ Video analyse (histogram + vectorscope)
  ├ PTZ controls (digital zoom fallback)
  └ Camera controls (brightness/contrast/saturation/sharpness/etc)
<div id="qt-panel">  ← RoomTest resultaten (cam/mic/aec stappen)
<div id="room-ready-overlay">  ← success celebration
<div id="aec-calib-modal">  ← volume calibratie modal
```

## 5. Device discovery — kritisch

### 5.1 Volgorde

```js
async function initDevices() {
  // STAP 1: permissies APART ophalen (niet gecombineerd!)
  //   Gecombineerd audio+video+PTZ kan Chromium dwingen tot device-koppeling
  //   waarbij alternatieve mics uit enumerateDevices verdwijnen.
  
  // 1a. Audio permissie
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true })
    s.getTracks().forEach(t => t.stop())
  } catch(e) {}
  
  // 1b. Video permissie met PTZ-hint, met fallback zonder PTZ
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      video: { pan: true, tilt: true, zoom: true }
    })
    s.getTracks().forEach(t => t.stop())
  } catch(e) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true })
      s.getTracks().forEach(t => t.stop())
    } catch(e2) {}
  }
  
  // STAP 2: enumerate (nu met labels omdat permissies zijn verleend)
  const devices = await navigator.mediaDevices.enumerateDevices()
  
  // STAP 3: populate dropdowns met scoring
  // STAP 4: start live mic, start camera
}
```

### 5.2 Device scoring

Voor elke categorie (camera/mic/speaker) een `scoreX(label)` functie die hoger = relevanter teruggeeft.

**Bonuspunten:**
- "echo cancel" / "AEC" → +120 tot +150 (meeste waarschijnlijk een conferentiebar)
- Specifieke merken: Logitech MeetUp/Rally (+120), Poly Studio (+80), Jabra Panacast (+80), Shure MXA (+70), Crestron/Biamp/QSC (+60 tot +70)

**Strafpunten:**
- "built-in", "microphone array", "realtek", "intern" → -60 (laptop mics zijn zelden goed voor vergaderzaal)
- "headset" → -50 (persoonlijk apparaat, niet voor room-use)
- Virtuele audio-bronnen: "ndi", "dante", "vb-cable", "voicemeeter", "virtual" → -80 tot -100 (leveren doorgaans digitale stilte)

### 5.3 Dropdown populatie

```js
function fillSelect(sel, devices, scoreFn, prevValue) {
  // Filter Default/Communications aliases als er een kale entry bestaat
  const hasRealIds = devices.some(d =>
    d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
  const filtered = hasRealIds
    ? devices.filter(d => d.deviceId !== 'default' && d.deviceId !== 'communications')
    : devices
  // Sorteer op score descending, vul select
  ...
}
```

### 5.4 getUserMedia deviceId — kritisch

**NOOIT** `'default'` of `'communications'` als `{ exact: ... }` doorgeven aan getUserMedia. Dit zijn virtuele Chromium aliases, niet echte device IDs. Crasht de audio pipeline.

```js
const useExact = micId && micId !== 'default' && micId !== 'communications'
const stream = await navigator.mediaDevices.getUserMedia({
  audio: {
    deviceId: useExact ? { exact: micId } : undefined,
    echoCancellation: false, noiseSuppression: false, autoGainControl: false
  }
})
```

## 6. Live mic monitor

Continu actieve monitor die alleen wordt gepauzeerd tijdens AEC-test of RoomTest.

```js
let liveMicStream = null, liveMicCtx = null, liveMicAnimId = null
let sharedMicAnalyser = null  // hergebruikt door RoomTest voor mic-level check

async function startLiveMic() {
  stopLiveMic()
  const micId = selMic.value
  const useExact = micId && micId !== 'default' && micId !== 'communications'
  liveMicStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: useExact ? { exact: micId } : undefined,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false
    }
  })
  liveMicCtx = new AudioContext()
  if (liveMicCtx.state === 'suspended') await liveMicCtx.resume()
  
  const src = liveMicCtx.createMediaStreamSource(liveMicStream)
  const ana = liveMicCtx.createAnalyser()
  ana.fftSize = 2048; ana.smoothingTimeConstant = 0.5
  src.connect(ana)
  sharedMicAnalyser = ana
  
  // tick loop via requestAnimationFrame
  // - update #mm-fill (width = v*400%, capped 100%)
  // - update #mic-db-label (20*log10(v) rounded)
  // - update #mic-peak-label (peak met 2s hold)
  // - draw spectrum + oscilloscope
}

function stopLiveMic() {
  if (liveMicAnimId) cancelAnimationFrame(liveMicAnimId)
  if (liveMicCtx) { try { liveMicCtx.close() } catch(e){} }
  if (liveMicStream) liveMicStream.getTracks().forEach(t => t.stop())
  // null alles, reset UI
}
```

## 7. Volume systeem

**In-app digitaal volume, NOOIT Windows master.**

Geschiedenis-les: Windows master-volume manipulatie via csc.exe/COM-interfaces heeft in eerdere versies de hele Windows audio capture stack Windows-wijd kapot gemaakt. Nooit meer doen.

```js
let currentVolume = 0.30
try {
  const saved = parseFloat(localStorage.getItem('rr-volume'))
  if (!isNaN(saved) && saved >= 0 && saved <= 1) currentVolume = saved
} catch(e) {}

const activeGainNodes = new Set()
function registerGainNode(gn) { activeGainNodes.add(gn) }
function unregisterGainNode(gn) { activeGainNodes.delete(gn) }

function onVolumeChange(val) {
  const v = parseFloat(val) / 100
  currentVolume = v
  localStorage.setItem('rr-volume', v.toString())
  activeGainNodes.forEach(gn => {
    try { gn.gain.setTargetAtTime(v, gn.context.currentTime, 0.01) } catch(e) {}
  })
}
```

Elke test die geluid afspeelt maakt een `volGain` aan met `gain.value = currentVolume`, registreert hem, en unregistreert na afloop. De slider werkt dan live tijdens een actieve test.

## 8. AEC-test — volledige spec

Dit is het belangrijkste functionele onderdeel. Vorige implementatie had 6 fundamentele problemen die hieronder zijn opgelost.

### 8.1 Meet-methodologie: dB demping

Oude aanpak: ratio signal/baseline, score 0-10, breedband RMS. Probleem: gevoelig voor omgevingsruis, geen discriminatie tussen AEC-adaptation en steady-state, volume-afhankelijk.

**Nieuwe aanpak**: `demping = peak_adaptation_dB - steady_state_dB`

```
≥ 25 dB demping → "uitstekend" (groen)
15–25 dB        → "goed" (groen)
5–15 dB         → "zwak" (geel)
< 5 dB          → "geen AEC" (rood)
```

Als steady-state binnen 3 dB van noise floor zit → demping is ruis-gelimiteerd, tonen als `≥ X dB`.

### 8.2 Signaal: tone arpeggio (primair)

```js
const AEC_TONE_FREQS = [220, 277.18, 329.63, 440]  // A3, C#4, E4, A4 arpeggio
const vols = [0.36, 0.26, 0.20, 0.16]  // afgewogen voor clipping-safe mix
```

**NIET harder dan deze volumes.** User heeft expliciet +3dB verzoek teruggetrokken — deze waarden zijn de balans.

Pink noise en speech zijn secundaire signalen, tone is default.

Speech: `audioEl.volume = 0.707` (−3 dB t.o.v. full scale).

### 8.3 Frequentie-selectieve meting

**Niet breedband RMS** — dat vangt omgevingsruis. Alleen de energie in de bins waar het signaal zit.

```js
const AEC_TONE_FREQS = [220, 277.18, 329.63, 440]
function measureToneEnergy(fftData, sampleRate, fftSize) {
  let maxBand = 0
  for (const f of AEC_TONE_FREQS) {
    const e = freqBandEnergy(fftData, sampleRate, fftSize, f, 30)  // ±15 Hz
    if (e > maxBand) maxBand = e
  }
  return maxBand
}
function freqBandEnergy(fftData, sampleRate, fftSize, targetHz, bandwidthHz) {
  const binFreq = sampleRate / fftSize
  const loBin = Math.max(0, Math.floor((targetHz - bandwidthHz/2) / binFreq))
  const hiBin = Math.min(fftData.length - 1, Math.ceil((targetHz + bandwidthHz/2) / binFreq))
  let sum = 0
  for (let i = loBin; i <= hiBin; i++) sum += fftData[i]
  return sum / Math.max(1, hiBin - loBin + 1)
}
```

Analyser MOET configuratie hebben:
```js
ana.fftSize = 4096
ana.smoothingTimeConstant = 0  // GEEN temporal averaging voor burst-detectie
ana.minDecibels = -100
ana.maxDecibels = 0
```

Met `minDecibels=-100, maxDecibels=0`: `dbFromByte(v) = -100 + (v / 255) * 100`.

### 8.4 Testflow — drie fasen

**Fase 1: ruisvloer (1.5s)**  
Mic luistert, speaker stil. Mediaan van alle frames = `noiseFloorDb`.  
Mediaan is robuuster tegen outliers dan gemiddelde.

**Fase 2: calibratie-burst + modal**  
- 600ms 1 kHz sinus burst (bewust andere frequentie dan hoofd-signaal om AEC-pre-convergentie te vermijden)
- Differentiële meting: eerst 150ms ruisvloer in 1 kHz-band, dan burst-peak, peak − baseline = zuivere signal-above-noise
- Meetvenster: burst-duur + 500ms tail (vangt speaker output latency van Realtek WDM-KS / Dante Virtual Soundcard op)
- Modal ALTIJD tonen na calibratie (visuele bevestiging van volume)
- Statuskleuren in modal:
  - ≥ -25 dBFS → groen "Volume OK" → **auto-sluit na 1 sec**
  - -40 tot -25 dBFS → geel "Marginaal" → blijft open
  - < -40 dBFS → rood "Te laag" → blijft open
- Slider in modal past live currentVolume aan, replay-knop speelt burst opnieuw
- Ok/annuleer knoppen; annuleer breekt test af

**Fase 3: hoofdmeting (4s tone)**  
Scheduler vereisten — KRITISCH:

```js
// Envelope én oscillator scheduling op dezelfde t0, NA alle awaits
const t0 = spkCtx.currentTime
outGain.gain.cancelScheduledValues(t0)
outGain.gain.setValueAtTime(0, t0)
outGain.gain.linearRampToValueAtTime(1, t0 + 0.15)
outGain.gain.setValueAtTime(1, t0 + dur - 0.2)
outGain.gain.linearRampToValueAtTime(0, t0 + dur)
oscs.forEach(o => { o.start(t0); o.stop(t0 + dur + 0.02) })
```

**NIET**: envelope schedulen bij oscillator-aanmaak en oscillator pas starten na `await audioEl.play()`. Tussen die twee heeft de audio clock door-getikt en is de fade-in al voorbij → "afgebroken" klank, inconsistente duur.

Meetvenster: hardStop via `setTimeout(..., sigDuration + 100)` om rAF-throttling te overrulen. Geen afhankelijkheid van UI-rendering voor test-timing.

### 8.5 Audio routing

**Direct naar `spkCtx.destination`. GEEN MediaStream→Audio element bridge.**

Vorige versie gebruikte `createMediaStreamDestination()` + `<audio>` + `setSinkId()` om een specifieke speaker te targeten. Dit veroorzaakte:
- Variabele latency (50-300ms extra buffer)
- "Afgebroken" geluid door stream-start race conditions
- Inconsistente test-duur

```js
const spkCtx = new AudioContext()
const envGain = spkCtx.createGain(); envGain.gain.value = 1
const volGain = spkCtx.createGain(); volGain.gain.value = currentVolume
registerGainNode(volGain)
envGain.connect(volGain)
volGain.connect(spkCtx.destination)  // DIRECT
```

Als specifieke speaker nodig is: `spkCtx.setSinkId(id)` wordt sinds Chrome 110 op AudioContext zelf ondersteund. Gebruik dat, geen bridge.

### 8.6 Adaptation curve

Live canvas naast de AEC-resultaten. Technicus ziet hoe de AEC convergeert.

```
<canvas id="aec-curve" width="600" height="90">
```

- Achtergrond: `#0a0d12` (donker)
- Grid horizontale gestippelde lijnen op -20, -40, -60 dBFS
- X-as: tijd (0 tot totale duur), Y-as: -80 tot 0 dBFS
- Curve-lijn: groen `#4ade80`, `lineWidth 1.5`
- Noise floor: grijze gestippelde horizontale lijn
- Steady-state (na meting): gele gestippelde horizontale lijn op rechter helft
- Fase-separators: verticale gestippelde lijnen tussen fases met labels bovenin ("ruisvloer" / "adaptation" / "meting")

Herbruikbaar: accepteert canvas-ID als parameter zodat RoomTest dezelfde functie kan gebruiken met eigen canvas.

### 8.7 Evaluatie-logica

```js
function aecEvaluate(peakDb, steadyDb, noiseFloorDb) {
  const demping = peakDb - steadyDb
  const noiseLimited = (steadyDb - noiseFloorDb) < 3
  let cls, label
  if (demping >= 25)      { cls = 'ok';   label = 'uitstekend' }
  else if (demping >= 15) { cls = 'ok';   label = 'goed' }
  else if (demping >= 5)  { cls = 'warn'; label = 'zwak' }
  else                    { cls = 'err';  label = 'geen AEC' }
  return { demping: Math.round(demping), label, cls, noiseLimited }
}
```

Peak = max waarde uit eerste 500ms van hoofdsignaal (adaptation-fase).  
Steady = mediaan van metingen tussen 500ms en (duration - 200ms).

## 9. RoomTest (voorheen "Snelle Test")

Knop in header. Drie stappen in vaste volgorde:

1. **Camera**: check resolutie, fps, sharpness (histogram analyse)
2. **Mic niveau**: sample 1.5s uit sharedMicAnalyser, rapporteer dB-bereik
3. **Echo cancellation**: volledige AEC-flow inclusief calibratie-modal en adaptation curve

**KRITIEKE volgorde-issue**: mic-stap resultaat MOET worden gerenderd VÓÓR AEC-stap start. Anders blijft "Mic niveau" hangen op "running" spinner omdat AEC-modal op user-input wacht.

```js
// STAP 2: Mic (data verzamelen)
// STAP 2b: Mic RESULTAAT RENDEREN  ← niet pas na AEC!
// STAP 3: stopLiveMic(); AEC-test (blocking met modal)
```

Adaptation curve verschijnt inline onder de qt-aec rij (option b uit de discussie), niet boven het paneel.

Success-overlay "Room = Ready!" verschijnt bij passed=3, warned=0, failed=0. Auto-sluit popover na 2 seconden. Klantscherm schakelt naar 'ready' state.

## 10. Loopback

Speaker-naar-mic-naar-speaker met instelbare delay (slider 0-1000ms default 400ms).

Simpele implementatie:
- Open mic-stream
- Open AudioContext
- MediaStreamSource → DelayNode(configurable) → GainNode(volGain) → destination
- Register volGain zodat live volume-aanpassing werkt
- Timeout 10s default (anders oneindig zelf-oscillatie mogelijk)

Meters voor "Mic in" en "Uit" niveaus, beide in dBFS via analyser.

## 11. Camera + PTZ

### 11.1 Camera start

```js
await navigator.mediaDevices.getUserMedia({
  video: {
    deviceId: { exact: camId },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    pan: true, tilt: true, zoom: true
  }
})
```

Fallback zonder PTZ als die faalt.

### 11.2 PTZ controls

- Lees track.getCapabilities() voor pan/tilt/zoom ranges
- Sliders in UI voor handmatige controle
- `track.applyConstraints({ advanced: [{ pan: val }] })` voor controle
- Als geen hardware PTZ: digitale zoom via CSS transform op video element (100%-400%)

### 11.3 VISCA over IP

Voor IP-camera's (Rally Bar, Crestron etc). Main.js handlers `visca-udp` en `visca-tcp`. Renderer stuurt hex-commando's via IPC. Niet-Logitech spul waar Chromium geen PTZ-constraints voor heeft.

## 12. Video analyse

### 12.1 Brightness meter

Sample 160×90 canvas uit video element elke ~200ms, bereken gemiddelde luminantie.  
Gebruik `getContext('2d', { willReadFrequently: true })` om Chromium-waarschuwing te voorkomen.

### 12.2 Histogram

RGB histogram van dezelfde canvas. 256 buckets per kanaal. Kleur per kanaal.

### 12.3 Vectorscope

U/V chrominantie-scatterplot. Gestippelde cirkels voor broadcast-safe ranges. Markers voor R/G/B/C/M/Y doelen.

## 13. Klantscherm (preview.html)

Opent op tweede monitor via IPC. Simpele weergave:
- Video-feed van camera (mirrored)
- Grote status-tekst: "Bezig met test" / "Room = Ready" / "Niet klaar"
- Idle state: kleurbalken SMPTE-stijl
- Ready state: klantvriendelijke groene bevestiging, 5s na succes terug naar idle

Main window stuurt state updates via IPC:
- `setPreviewState('idle' | 'testing' | 'ready' | 'fail')`

## 14. Thema's

Light thema: **Linen** (default, cream+indigo), Studio, Sage, Nordic, Broadcast  
Dark thema: standaard donker, plus varianten

Sun/moon icon popups in header openen thema-menu. Klik op toggle-track switcht tussen light/dark modes. Selectie wordt opgeslagen in localStorage. Oude "Paper" en "Warm" thema's zijn vervangen door Linen.

## 15. Update-mechanisme

Drag-drop ZIP op #btn-update-drop. Via main.js:
1. Uitpakken naar %TEMP%\rr_update_<timestamp>
2. Zoek naar `resources/app.asar` in uitgepakte structuur
3. Schrijf PowerShell script dat kopieert naar app-directory
4. Schrijf VBScript die PS1 elevated start via ShellExecute "runas"
5. Sluit app, VBS triggert UAC, robocopy copy, start nieuwe app

## 16. Anti-patterns (nooit meer doen)

Dit zijn dingen die in eerdere versies problemen gaven:

1. **`use-fake-ui-for-media-stream` Chromium flag** — verbergt devices
2. **csc.exe voor Windows volume master** — corrumpeert audio service
3. **1.2s volume polling** — COM reference leaks in Audio Service
4. **MediaStream bridge voor test-audio** — variabele latency, afgebroken signalen
5. **Envelope schedulen bij oscillator-aanmaak, start na await** — timing mismatch
6. **`{ exact: 'default' }` als getUserMedia constraint** — virtuele ID, crasht pipeline
7. **Breedband RMS voor AEC-meting** — gevoelig voor omgeving
8. **Volume 1.0 hardcoded in tests** — negeert gebruiker-setting
9. **Mic-stap resultaat na AEC-stap renderen in RoomTest** — flow vastlopen
10. **Smoothing != 0 op analyser voor burst-detectie** — peak wordt uitgesmeerd

## 17. Keyboard shortcuts & UX

- Geen aggressieve auto-popups
- Geen modal dialogs behalve calibratie (met duidelijke escape)
- Console-logging alleen voor diagnostiek tijdens development. Productieversie: minimaal log, geen `[MIC] heartbeat` spam
- Fouten in tests: toon warning state met duidelijke oorzaak, niet alleen "Test mislukt"

## 18. Buildproces

```bash
# Versie verhogen in package.json en renderer.html header-badge
# Dan:
rm -rf dist
npx electron-builder --win portable
# Output: dist/win-unpacked/RoomReady.exe
# Voor distributie: zip het hele win-unpacked folder
```

Portable build: geen installer, één uitvoerbaar bestand dat bij opstart naar %TEMP% uitpakt. Daarom is `setPath('userData', ...)` belangrijk om instellingen persistent te houden.

## 19. Device naming conventions

IDs in code:
- `mm-fill` = main mic meter fill bar
- `aec-curve` = standalone AEC adaptation canvas
- `qt-aec-curve` = RoomTest AEC adaptation canvas (inline)
- `aec-calib-modal` = volume calibratie modal
- `sel-camera` / `sel-mic` / `sel-speaker` = device dropdowns
- `vol-slider` / `vol-label` = volume controls
- `btn-quicktest` = RoomTest button (interne naam qt blijft, UI toont "RoomTest")
- `qt-camera` / `qt-mic` / `qt-aec` = RoomTest stap IDs

## 20. Nederlandse UI-strings (referentie)

- "Camera", "Microfoon", "Speaker", "Testvolume"
- "Herlaad" (refresh devices), "Teams" (open Teams)
- "Mic input", "Audio analyse", "Echo cancellation", "Loopback", "PTZ"
- "Testtoon" / "Roze ruis" / "Spraak" (signal types)
- "Calibratie" / "Start AEC" / "Stop"
- "RoomTest" (knop), "Camera", "Mic niveau", "Echo cancel" (stappen)
- "Room = Ready!" (success overlay)
- "Testvolume aanpassen" (calibratie modal)
- "Volume OK voor meting" / "Marginaal" / "Te laag"

## 21. Bekende externe afhankelijkheden

Geen. Geen npm packages behalve Electron + electron-builder.

Optioneel: `quotes.js` met base64-encoded TTS audio voor speech AEC-test. ~1.3 MB, lazy-loaded alleen als user "Spraak" signaal kiest.

## 22. Success criteria — test matrix voor voltooide rebuild

Voordat rebuild als "klaar" geldt, moeten deze tests slagen op een referentie-machine:

1. ✅ App start in <3 sec, camera feed zichtbaar in <2 sec na start
2. ✅ Alle audio-devices uit Apparaatbeheer verschijnen in mic-dropdown (bv Logitech MeetUp, Rally, C920 audio, etc)
3. ✅ `Default -` en `Communications -` aliases verborgen als kale device-entry bestaat
4. ✅ NDI/Dante/virtuele devices onderaan gesorteerd
5. ✅ Volume-slider werkt live tijdens loopback en AEC-test
6. ✅ AEC-test met tone signaal: reproduceerbare demping-meting ±2 dB tussen runs
7. ✅ AEC-calibratie modal verschijnt altijd, auto-sluit bij groene status
8. ✅ RoomTest doorloopt alle 3 stappen zonder vast te lopen op mic-niveau
9. ✅ Adaptation curve tekent live tijdens AEC-fase
10. ✅ Test-duur exact 4 seconden, niet variabel
11. ✅ Tone geluid zonder "afgebroken" artefacten
12. ✅ App werkt zonder internet, geen externe API calls
13. ✅ Update-ZIP drag-drop werkt zonder admin-prompt corruption
14. ✅ Preview op tweede monitor werkt
15. ✅ VISCA IP-commando's aankomen op testbare ONVIF camera

---

**Einde specificatie.**

Bewaar dit document naast de code. Bij elke grote wijziging: herzie dit document, niet alleen de code. Dit is de canonieke bron van wat RoomReady is en hoe het werkt.
