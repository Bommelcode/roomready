# RoomReady Changelog

Elke iteratie = een snapshot in `.snapshots/vX.Y.Z/`.  
Nieuwste bovenaan. Als iets breekt: kopieer de bestanden van de laatste werkende snapshot terug.

## Terug naar vorige versie

```bash
# Vervang X.Y.Z met gewenste versie
cp .snapshots/vX.Y.Z/* /home/claude/logitech-tester/
```

---

## v3.4.5 — Same-groupId AEC detectie + mute-UX (C-light) + inventaris robustness

**Datum:** 2026-04-25
**Status:** Diagnostiek-iteratie afgerond op echte hardware; release-clean

**Achtergrond:**

Op een laptop met Realtek mic + Realtek speaker (zelfde audio-chip) bleek de Speaker+Mic test consistent `-100 dB · ruis -100 dB · Δ 0 dB` te geven en de Latency-meting alleen sporadisch een puls te detecteren (alterneert tussen attempts 1 en 5). Oorzaak: hardware-AEC in de gedeelde audio-chip cancelt het testsignaal — de spec-aanpak is gemaakt voor échte conference-bars met fysiek gescheiden mic en speaker. De label-match van `measureLatency` (`echo cancel`/`speakerphone`/`rally`/`meetup`) miste het Realtek-on-Realtek scenario omdat die labels niets met "echo cancel" te maken hebben.

**Fixes:**

**1. Same-groupId detectie** — nieuwe helper `isSameAudioGroup()` die check of de geselecteerde mic en speaker in `enumerateDevices` dezelfde `groupId` rapporteren. Chromium gebruikt `groupId` om devices op dezelfde fysieke audio-chip te koppelen. Toegepast op:
- `measureLatency`: bestaande `aecDevice` early-return uitgebreid met `sameGroup` als tweede pad
- `qtTestSpeaker`: nieuwe pre-check vóór de chord wordt afgespeeld

**2. C-light mute-UX** — nieuwe knop "🔊 Geluid…" naast "▶ Test nu" in de Speaker+Mic kaart. Opent direct `ms-settings:sound` via `openExternal` zodat de gebruiker mute/volume kan checken. **Geen** programmatische `IAudioEndpointVolume::SetMute` call (zie spec anti-pattern #2 — die heeft v3.1.x de Windows audio service kapot gemaakt). Speaker+Mic test geeft nu ook expliciet "speaker mogelijk gemute of volume 0%" hint als chord en ruisvloer beide rond -100 dB zijn.

**3. Latency-trigger soepeler** — was `max(baseline*5, baseline+0.02)`, nu `max(baseline*3, baseline+0.005)`. Op laptops met zwakke speaker→mic koppeling blijft de burst-RMS rond 0.01-0.04 boven ~0.005 baseline; oude drempel raakte niet binnen 5 attempts, nieuwe wel binnen 1-2.

**4. Inventaris-scan WMI pre-filter** — `Get-CimInstance Win32_PnPEntity` materialiseert ALLE PnP-devices op de machine (op een kantoorlaptop kan dat 200+ zijn) en doet daarna client-side `Where-Object`-filter. Dat liep regelmatig over de 30s timeout heen → SIGTERM → "killed=true" foutmelding. Nu pre-filter via `-Filter "PNPDeviceID LIKE 'USB\\VID_046D%'"` (resp. `'USB\\%'` voor de generieke USB-scan); WMI doet de filter server-side, ordes sneller.

**5. Verbose PowerShell-fouten in main.js** — `runPowerShellJson` retourneerde alleen `err.message` ("Command failed: ..." — niet nuttig). Nu surface't het exit-code, kill-flag, signal, stderr én eerste 500 chars van stdout zodat een renderer-side error-bericht concrete info geeft.

**Cleanup:** tijdelijke `[LAT-DIAG]`/`[INV-DIAG]` console-warns uit measureLatency en runScan verwijderd (hadden hun werk gedaan).

---

## v3.4.4 — Fix v3.4.3 regressie: auto-restart contention + Snelle Test mic-step

**Datum:** 2026-04-25
**Status:** Fix voor regressie geïntroduceerd in v3.4.3

**Probleem:**

v3.4.3 stopte `liveMicStream` aan het begin van `measureLatency()` om contention met de eigen test-stream te vermijden. Onverwachte interactie: er staat een `'ended'` event-listener op de live-mic track ([renderer.html:2987](renderer.html#L2987)) die 800ms na disconnect **automatisch** `startLiveMic()` aanroept (legitiem voor unplug-during-monitor recovery). `stopLiveMic()` triggert die listener; tijdens een 2+ seconden durende latency-test fired de setTimeout midden in de meting → live monitor herstart → twee mic-consumers → resultaat onvoorspelbaar én Snelle Test's mic-stap kreeg liveMicStream in een rommelige staat na afloop.

**Fix:**

Nieuwe globale flag `liveMicInhibit`. `measureLatency` zet die op `true` bij het stoppen, de 'ended'-listener slaat auto-restart over zolang de flag staat, en de `finally` van `measureLatency` herstart de live monitor zelf vóór `liveMicInhibit = false`. Knop wordt pas weer enabled na de manual restart, zodat snelle tweede klikken niet in een halve herstart vallen.

**Tijdelijk in deze release:** `[LAT-DIAG]`-logs in `measureLatency` (zichtbaar als `console.warn` in DevTools) om de oorspronkelijke alternatie verder te diagnosticeren mocht die niet automatisch opgelost zijn door dit. Worden verwijderd in v3.4.5 zodra de oorzaak vaststaat.

---

## v3.4.3 — Latency meting alterneerde: liveMicStream contention opgelost

**Datum:** 2026-04-25
**Status:** Bug-fix gemeld door gebruiker — "om en om wel/geen ruispuls gemeten"

**Probleem:**

`measureLatency()` opende een eigen `getUserMedia` op de geselecteerde mic terwijl `liveMicStream` (de header-monitor) op dezelfde mic actief was. Op Windows met exclusive-mode USB-mics (Logitech MeetUp/Rally, Jabra PanaCast) krijgt de tweede consumer regelmatig stale of silent buffers tot de eerste consumer écht los is — niet altijd, maar consistent **alternerend** afhankelijk van wie het exclusive lock houdt op het moment van de tweede `getUserMedia`. Resultaat: één meting werkt, de volgende geeft "ruispuls niet gedetecteerd" (mic ziet niets boven baseline), volgende werkt weer, etc.

Andere tests vermijden dit doordat `runQuickTest()` `stopLiveMic()` aanroept vóór de speaker-stap. `measureLatency` is standalone (eigen knop) en deed dat niet.

**Fix:**

1. **Stop live-mic voor de meting**, restart na afloop (in `finally`). Zelfde patroon als RoomTest hanteert.
2. **`await spkCtx.close()`** zodat het speaker-device écht vrijkomt voordat een snelle herhaalde klik een nieuwe `spkCtx` probeert te claimen.
3. Try/catch verbouwd naar try/catch/finally zodat `prog.style.display='none'` + `btn.disabled=false` ook bij een uitzondering halverwege herstellen.

---

## v3.4.2 — Inventaris-module robustness: scan-knop, error surface, defensive sort

**Datum:** 2026-04-25
**Status:** Follow-up audit op v3.4.0 inventaris-module (eerder buiten v3.4.1 hard-constraint scope gevallen)

**Drie defensive fixes in `inventory.html`:**

**Fix 1 — Scan-knop blijft nooit meer hangen:**

`runScan()` had geen try/finally. Als een IPC-call zou throwen i.p.v. `{ok:false}` terug te geven (theoretisch — main.js vangt errors, maar IPC-bridge breakage kan), bleef de Scan-knop voor altijd disabled en kon de gebruiker niets meer scannen zonder app-restart. Nu in try/finally; bij exception toont de progress-strook een rode foutmelding.

**Fix 2 — Load-errors zichtbaar voor gebruiker:**

`main.js` retourneert bij file-read-failure `{rooms:[], devices:{}, error: e.message}`, maar `loadStore()` ignoreerde het `error`-veld. Resultaat: lege inventaris-UI zonder uitleg na bv. corruptie van `userData/inventory.json`. Nu wordt het bericht in de progress-strook getoond én naar console gelogd zodat de gebruiker de oorzaak ziet.

**Fix 3 — Defensive `localeCompare` bij sorteren:**

Twee `.sort()` callbacks (`renderRooms` regel 833, `buildCsvRows` regel 1011) riepen `.localeCompare` aan op `room_number`/`name`. Voor legacy data (Python v0.1 schema, partieel gemigreerde rooms) kan een veld undefined zijn, wat throws. Nu gewrapt met `(x || '')`.

**Niet meegenomen (bewust):**

Plain-text opslag van Logitech Sync bearer-token + xAPI-wachtwoord in `userData/inventory.json` blijft staan. Encryptie via Electron `safeStorage` is een aparte UX-keuze (eenmalige master-password? OS-keychain?) en valt buiten deze patch-cyclus.

---

## v3.4.1 — Hard-constraint cleanup: split getUserMedia, gate alias-IDs, kill log spam

**Datum:** 2026-04-25
**Status:** Cleanup-release na audit tegen CLAUDE.md anti-patterns

**Probleem:** Audit liet drie schendingen zien van expliciet gedocumenteerde hard constraints. Twee daarvan zijn echte regressies tegenover de spec, één was opgespaarde debug-noise.

**Fix 1 — gecombineerde getUserMedia gesplitst (anti-pattern #5):**

`initDevices()` riep `getUserMedia({ video, audio })` in één call met PTZ-hint. Spec §5.1 + CLAUDE.md anti-pattern #5 schrijven expliciet voor: eerst `audio: true` apart, dan `video: { pan, tilt, zoom }` met fallback naar plain `video: true`. Combined requests kunnen alternatieve mics uit `enumerateDevices()` verbergen — dit was de aanleiding van de constraint en zat in v3.4.0 weer terug. Nu opnieuw gesplitst conform spec.

**Fix 2 — `'default'`/`'communications'` gating toegevoegd (anti-pattern #3):**

Vier `getUserMedia` calls in renderer.html sloegen de filter `selMic.value !== 'default' && selMic.value !== 'communications'` over (Loopback, Speaker+Mic test, qtCheckMicLevel, qtTestLatency). Aliases zijn virtuele Chromium-IDs en crashen de pipeline als ze als `{exact:…}` doorkomen. `fillSelect` filtert ze in praktijk al weg, maar de defense-in-depth is nu hersteld.

**Fix 3 — console-spam opgeruimd:**

- `[MIC] heartbeat tick`-log (elke ~1s tijdens live mic-monitor) verwijderd. CLAUDE.md noemt dit letterlijk als voorbeeld van "niet doen in productie". CHANGELOG v3.1.11 had ze opzettelijk aangehouden voor debugging — nu klaar.
- `camLog()` schrijft niet meer naar console; de `window._camDiag` ringbuffer blijft beschikbaar voor inspectie via DevTools.

**Versie bump:** package.json 3.4.0 → 3.4.1, header-badge v3.3.5 → v3.4.1 (badge liep al een minor achter op package.json).

---

## v3.4.0 — AV inventarisatie module (Logitech USB, UVC cameras, display EDID)

**Datum:** 2026-04-24
**Status:** Port van Python/PyQt6 inventory-module naar Electron renderer

**Nieuwe feature:** aparte "Inventaris" knop in de header opent een eigen venster (`inventory.html`) waarmee je rooms aanmaakt en devices per ruimte inventariseert. Scant:

- **Logitech HID** via `Win32_PnPEntity` + `Get-PnpDeviceProperty DEVPKEY_Device_SerialNumber`, filter op VID 046D. Model-catalogus (MeetUp, MeetUp 2, Rally Bar-familie, Brio, Rally Speaker/Mic Pod, Tap/Tap IP) matcht op PID zodat modelnaam mooi in de tabel verschijnt.
- **USB UVC cameras** (Avonic + overige niet-Logitech) via dezelfde WMI-query, gefilterd op `PNPClass in (Camera,Image,Media,USB)` of Name matcht `camera|webcam|video`. Avonic wordt herkend aan `"Avonic XXXX"` (nieuwe firmware juni 2022+) of `"FHD Camera"` (oud).
- **Displays** via `root\wmi → WmiMonitorID`, met PNPID→merk lookup (SAM=Samsung, LGD=LG, DEL=Dell, etc.). Manufacturer/model/serial/productiejaar komen rechtstreeks uit EDID. Tip bij gebruik: HDMI direct laptop→paneel, niet via BYOD-passthrough.

**Serienummers zijn het doel.** Waar mogelijk: `DEVPKEY_Device_SerialNumber` (Windows' geparsede iSerialNumber USB descriptor). Fallback: de instance_id uit PNPDeviceID als dat geen Windows-gegenereerd pad is (geen `&` erin). Voor devices zonder iSerialNumber zie je de volledige PNPDeviceID als unique-ID.

**Persistentie:** `userData/inventory.json` — schema 1:1 compatibel met de Python-variant (`rooms[]`, `devices{}`, `device_unique_ids` per room, source='logitech_hid' | 'usb_uvc' | 'display'). Python v0.1/0.2 veldnaam `device_serials` wordt bij load gemigreerd naar `device_unique_ids`.

**Firmware lookup (optioneel):**
- Logitech Sync API: bearer token + één call `/v1/devices`, geindexeerd op SN. Alle HTTP(S) gebeurt in main.js zodat CORS + token-exposure niet via renderer lopen.
- CollabOS xAPI: per collabos-device (Rally Bar familie, RoomMate) een lokale call naar `http://<ip>/xapi/v1/status/SystemUnit/Software/Version`. Mapping SN→IP configureerbaar via het firmware-dialog.

**CSV export:** headers matchen `inventory/excel_writer.py` COLS-layout. UTF-8 BOM zodat Excel correct inleest. Geen `exceljs` dependency — respecteert project-regel "geen npm deps behalve Electron + builder".

**Nieuwe IPC handlers** in main.js: `inv-open`, `inv-scan-logitech`, `inv-scan-usb`, `inv-scan-displays`, `inv-store-load`, `inv-store-save`, `inv-firmware-sync`, `inv-firmware-xapi`, `inv-export-csv`. Preload expose via `rrBridge.inv*`.

**NIET:**
- Geen `node-hid` — zou native rebuild per Electron-versie vereisen. Windows PnP levert de serial voor het overgrote deel van devices die iSerialNumber exposen.
- Geen Excel schrijven (openpyxl equivalent). CSV dekt het inventarisatie-gebruik en Excel opent het direct.
- Geen IP-scan / mDNS discovery voor xAPI. User levert SN→IP mapping zelf aan.

---

## v3.3.2 — Kritieke fix: `app.getPath` moduleload-crash

**Datum:** 2026-04-23  
**Status:** Direct follow-up op v3.3.1

**Probleem:** Bij test van v3.3.1 opstarten: app toont alleen device-selectie, main content blijft leeg. DevTools niet nodig om te diagnostiseren — het was mijn fout:

In v3.3.0 introduceerde ik:
```
const kioskStatePath = path.join(app.getPath('userData'), 'kiosk-state.json')
```
Dit op module-niveau (top van main.js). `app.getPath('userData')` is niet geldig vóór `app.whenReady()`. Het crasht de main-process init silently voordat alle IPC handlers geregistreerd zijn. Renderer-side: `window.rrBridge.kioskGetState()` en `listSamples()` etc. hangen zonder return-waarde, initDevices() hangt daardoor in zijn async chain, en de rest van de init-code in de `;(async () => {...})()` IIFE wordt nooit bereikt — dus Mic Input card, Speaker+Mic card, Loopback en de rest renderen nooit.

**Fix:** `kioskStatePath` is nu een lazy function die pas bij eerste call `app.getPath` aanroept. Tegen die tijd is de app definitely ready.

---

## v3.3.1 — Kiosk fixes (pre-emptive)

**Datum:** 2026-04-23  
**Status:** Drie fixes nog vóór v3.3.0 in productie kwam

**Fix 1 — verkeerde functie-naam:** `kioskStartQuickTest` riep `startQuickTest()` aan, maar de feitelijke test-runner heet `runQuickTest()`. Zou de Snelle Test-knop direct gebroken hebben.

**Fix 2 — labels-leeg probleem:** Chromium geeft pas mediadevice-labels terug na een succesvolle `getUserMedia`. Bij app-start zou `kioskDetectSets()` vaak Scherm A tonen terwijl er wel een vergaderset hing. Nu: als enumerateDevices geen labels geeft, doe eerst een throw-away getUserMedia voor permission, dan opnieuw enumerateren.

**Fix 3 — USB-device-handle race:** bij klikken op Snelle Test: `kioskStopCamPreview` retourneert direct, maar Windows heeft ~200ms nodig om de USB-handle echt vrij te geven. Nieuwe 250ms sleep tussen stream-stop en `runQuickTest()` voorkomt "device in use" errors.

---

## v3.3.0 — Kiosk Mode voor vergaderzalen met USB-detectie

**Datum:** 2026-04-22  
**Status:** Nog niet getest — major feature

**Nieuwe kiosk-modus:** volledig aparte user-flow voor AV-technici die vergaderzalen opzetten. App toont een fullscreen overlay die luistert naar USB-plugs; zodra een bekende vergaderset is aangesloten, krijgt de gebruiker twee simpele keuzes. De normale app blijft volledig beschikbaar voor wie kiosk niet inschakelt.

**Activering:**
- **View → Kiosk Mode** menu-item (checkbox-style)
- Persistent via `kiosk-state.json` in userData (app start automatisch in kiosk als flag aan)
- Bij uit-zetten binnen kiosk: knop **✕ Exit kiosk** rechtsonder → confirm → terug naar normale modus
- State-change tussen renderer en main via nieuwe IPC: `kiosk-get-state`, `kiosk-set-state`, `kiosk-toggled` event

**Scherm A — geen vergaderset aangesloten:**
- Fullscreen donkere achtergrond met radial gradient
- 🔌 icon met pulsing-animatie
- Titel "Sluit vergaderzaal aan"
- Subtekst met lijst van herkende merken

**Scherm B — vergaderset gedetecteerd:**
- Tweekoloms layout
- Links: live camera preview (16:9, geselecteerde vergaderset-cam) + mic niveau-meter (RMS-bar + dB-waarde)
- Rechts: gedetecteerde sets lijst (klikbaar bij meerdere), info-block met camera/mic/speaker labels, twee grote knoppen: **⚡ Snelle test** (oranje, primair) en **🔬 Analyse** (secundair)

**Detectielogica:**
- `enumerateDevices` gefilterd op label-matching tegen `KIOSK_BRANDS` tabel (24+ merken/modellen): Logitech MeetUp/Rally/ConferenceCam/BCC950/BRIO/Group, Poly Studio X30/50/70/P15, Jabra PanaCast 20/50, Yealink MeetingEye/UVC, Bose VB1/VB-S, Avonic CM40/70/73
- Camera primair herkend → mic en speaker gekoppeld via `groupId` match
- **Audio-only sets** (Jabra Speak, Poly Sync, Plantronics Calisto) ook gedetecteerd zonder camera
- `devicechange` event listener voor live updates (400ms debounce)
- `enumerateDevices` resultaten gefilterd op `kioskMatchBrand()` — als er geen hex-ID mic of speaker is, fallback naar Windows default voor speaker

**Snelle test actie:**
- Pas geselecteerde devices toe op hoofd-app dropdowns (camera/mic/speaker)
- Open extern testpattern op tweede display (als beschikbaar): animated SMPTE-achtige kleurbalken (grijs/geel/cyan/groen/magenta/rood/blauw) met brightness pulsing
- Kiosk-overlay verbergt tijdelijk, `startQuickTest()` runt
- Polling op `qtRunning`: zodra test klaar → 3s extra voor "Kamer gereed" → kiosk-overlay terug + her-scan

**Analyse actie:**
- Pas devices toe, kiosk-overlay weg
- App toegankelijk voor grondige analyse
- Kiosk-overlay komt pas terug bij disconnect+reconnect van USB

**Preview.html (extern scherm):**
- Nieuwe `#test-bars` grid (7 kleuren) onder de `state-testing` spinner
- CSS animatie `barShift`: brightness/saturation pulsing per balk met staggered delays

**CSS:**
- Volledig eigen namespace `kiosk-*` en `#kiosk-overlay`
- `body.kiosk-active` verbergt alle main-app UI (devicebar, header, main, qt-panel)
- Donkere gradient achtergrond, grote knoppen met hover/active states, soepele transitions

**Menu:**
- Nieuwe applicatie-menu via `Menu.buildFromTemplate` — File/Edit/View/Window/Help met standard-rollen
- View menu bevat Kiosk Mode checkbox die persistent state schakelt en live event naar renderer stuurt

---

## v3.2.2 — Rename, random samples met quote-display, PTZ zonder digitale zoom

**Datum:** 2026-04-22  
**Status:** Nog niet getest

**Wijzigingen:**

**UI-rename:** "A-akkoord" heet nu "Testtoon" in de Speaker+Mic radio buttons. Intern blijft de value `chord` en de functies (`makeChord`, etc.) behouden.

**Samples random i.p.v. rouleren + quote-tekst tonen:**
- `speakerPickSample()` kiest nu `Math.floor(Math.random() * list.length)` met no-repeat guard (twee opeenvolgende tests krijgen nooit dezelfde sample)
- Nieuwe `samples/quotes.json` meegeleverd (1452 bytes, 20 entries) met `{filename: quote-tekst}` mapping
- Nieuwe IPC handler `read-quotes-json` in main.js, bridge `readQuotesJson()` in preload.js
- `speakerLoadSampleList()` laadt tegelijk de quotes-mapping
- `speakerQuoteFor(filename)` lookup met fallback naar stripped filename
- Spraak-info veldje toont nu `💬 "To be, or not to be..."` i.p.v. `🔉 quote01.wav`
- Radio-toggle info toont `💬 20 quotes beschikbaar (willekeurig)` i.p.v. samples-aantal

**Digitale zoom weg uit PTZ-card geen-hardware branch:**
- In de branch `!hasPan && !hasTilt && !hasZoom && !viscaActive` werd tot nu een digitale zoom slider (100-400%) getoond
- Die slider is verwijderd — in plaats daarvan toont de card nu alleen een informatief bericht "Geen PTZ-mogelijkheden gedetecteerd"
- Badge: "Geen PTZ" i.p.v. "Digitale zoom"
- VISCA-tip blijft staan
- Andere branches (camera heeft wel hardware pan/tilt of zoom) zijn onaangeraakt
- `applyZoom()` en `stepZoom()` functies blijven bestaan voor het geval VISCA digitale zoom later terug wil

---

## v3.2.1 — Fades, TTS samples, sluitbare resultaatbalk, volumeslider weg

**Datum:** 2026-04-22  
**Status:** Nog niet getest

**Nieuw:**

**Fade in/out op alle test-signalen (50ms ramp):**
- A-akkoord: nieuwe `env` GainNode tussen oscillators en output. Bij `play()` ramp 0→1, bij stop scheduled ramp 1→0 vóór oscillator-stop. Voorkomt click/pop.
- Roze ruis: Paul Kellet pink noise generator met identieke fade-envelope
- Spraak: fade-in bij start, fade-out gescheduled net voor buffer-einde

**TTS samples via Piper:**
- 20 quotes gegenereerd met Piper TTS (`en_GB-jenny_dioco-medium` voice — neurale kwaliteit, niet SAPI-robot)
- Public-domain literaire + tech/test quotes
- 2,5 MB totaal in `samples/` folder, 1,4–4,8s per sample
- Rouleren in volgorde (elke keer volgende sample, geen herhaling)
- Volledige sample speelt af — `chordMs` slider wordt genegeerd voor speech
- Via `extraResources` in electron-builder config mee-gepackt; via `rrBridge.listSamples()` en `readSample()` uit de renderer

**Signaal-radio's terug in Speaker+Mic card:**
- A-akkoord / Roze ruis / Spraak (TTS)
- `spk-speech-info` veld toont huidige sample filename bij spraak-modus
- Meetband automatisch per signaaltype:
  - chord: user-tunable via bandLoHz/bandHiHz sliders (default 200-700)
  - pink: 100-5000 Hz vast
  - speech: 300-3000 Hz vast (ITU-T)

**Volumeslider uit header weg:**
- `currentVolume = 1.0` hardcoded
- `onVolumeChange()` en `initVolumeUI()` zijn no-ops
- localStorage key `rr-volume` wordt geleegveegd bij opstart
- `registerGainNode()` mechanisme blijft (gebruik door Loopback)

**RoomTest bij pass: modal sluit 0,5s na laatste stap (was 2s), Room Ready direct zichtbaar.**

**Sluitbare resultaatbalk (`qt-panel`):**
- Nieuwe [×] knop rechtsboven in de balk — klik sluit de balk
- De Kamer Gereed kaart (`qt-summary`) is nu klikbaar — klik sluit ook
- CSS: nieuwe `dismissed` class met opacity+max-height 0 transition
- Balk reopent bij nieuwe RoomTest run (verwijdert `dismissed` class)

---

## v3.2.0 — Back to basics: AEC eruit, Speaker + Mic test erin

**Datum:** 2026-04-22  
**Status:** Major cleanup — nog niet getest

**Motivatie (na twee dagen debuggen):**
AEC-demping meten in dB via een consumer app met willekeurige mic+speaker combinaties bleek te veel variabelen te bevatten om betrouwbaar te zijn (mic-richting, AEC-snelheid, sample-rate verschillen, Windows communications-aliassen, DSP-filtering). Een AV-technicus heeft die meting ook niet nodig — hij moet weten: werkt de mic, werkt de speaker.

**Verwijderd (~1347+ regels code):**
- **AEC module volledig**: card met signaaltype radio's, curve canvas, meter, calibratie-modal, start/stop knoppen, resultaat-box
- **AEC Settings paneel** (v3.1.13+): alle slider-instellingen, localStorage persistence
- **Audio Diagnose card** (v3.1.14): real-time raw byte meters, RMS meter, 9-band spectrum, signaal-path snapshot, Play test, Diagnose-sequence, Dump→Console
- **Permanent mic-meter in header** (v3.1.14): "📡 Mic live" bar
- **Endpoint warning banner** (v3.1.15): Communications/Default alias-check (niet nodig meer)
- **Alle functies**: `startAecTest`, `stopAecTest`, `aecMakeMainSignal`, `aecMakeCalibBurst`, `aecRunCalibration`, `aecShowCalibModal`, `aecCurveDraw`, `aecEvaluate`, `measureToneEnergy`, `measureSpeechBand`, `measureBroadband`, `freqBandEnergy`, `fftByteToDb`, `aecCheckEndpoint`, `aecShowEndpointWarning`, `loadQuotes`, `aecGetSignalType`, en alle `diag*` functies
- **AEC_TONE_FREQS`, `AEC_SIGNAL_DURATION`, `AEC_DEFAULTS`, `AEC_SAFE_RANGES` constants
- **qtTestAEC** vervangen door `qtTestSpeaker`

**Nieuw — Speaker + Mic test (RoomTest stap 3):**
- Speelt een **A-majeur akkoord** (root-third-fifth via 3 sinussen) via de gekozen speaker
- Mic meet tegelijkertijd breedband energie in de akkoord-frequentieband (default 200-700 Hz)
- Fase 1: ruisvloer meten (default 500ms)
- Fase 2: akkoord afspelen (default 2000ms)
- Evaluatie op basis van Δ dB boven ruisvloer:
  - Δ ≥ 10 dB → pass
  - Δ ≥ 3 dB → warn ("mic richting/afstand?")
  - Δ < 3 dB → fail ("geen signaal")
- **Twee doelen in één test**: technicus hoort het akkoord (speaker OK), mic-detectie boven drempel (mic OK)

**Nieuw — Speaker + Mic card met DEV settings paneel:**
- Card "🔊 Speaker + Mic" op de plek waar AEC-card stond
- **▶ Test nu** knop — draait de test standalone (zonder hele RoomTest overlay)
- Resultaat-box met pass/warn/fail styling
- **⚙ Settings DEV** knop — klapt finetuning-paneel open met sliders voor:
  - Timing: noiseMs (100-3000), chordMs (300-6000)
  - Akkoord: chordRootHz (80-880, toont noot-naam zoals A3), chordAmp (0.1-2.0)
  - Analyse: fftSize (1024/2048/4096/8192), bandLoHz (50-2000), bandHiHz (200-4000)
  - Microfoon: micGain (0.1-20×, toont dB), echoCancellation/autoGainControl/noiseSuppression toggles
  - Drempels: thresholdPass (3-30), thresholdWarn (0-15)
- Pending-changes systeem (rode rand bij unsafe range, waarschuwing bij niet-opgeslagen wijzigingen)
- Persistent in localStorage onder `rr-speaker-settings`

**RoomTest stappen nu:**
1. 📷 Camera
2. 🎤 Mic niveau
3. 🔊 Speaker + Mic (A-akkoord via speaker, mic detecteert)

**Behouden onveranderd:** Mic input card met meter+oscilloscoop+spectrum, Loopback, Camera preview, PTZ, Camera info, Camera controls, Video analyse

**Orphan localStorage keys** (niet opgeruimd, breken niks): `rr-aec-settings`

---

## v3.1.15 — Communications/Default endpoint filter + waarschuwing

**Datum:** 2026-04-22  
**Status:** Nog niet getest

**Context van het probleem (uit v3.1.14 diagnose):**

Diagnose-test op Mbox/DPA toonde: mic-stream blijft actief maar registreert nauwelijks verschil tussen silence en signal segments (avg 72 vs 75, pink zelfs lager dan silence). Check van `micTrack.label` onthulde dat Chromium het mic-endpoint opende met prefix `Communications - Line 1/2 (...)` — ondanks `{exact: deviceId}` constraint. Dit is een Windows audio-alias die anti-feedback ducking activeert tijdens speaker-output, zelfs bij pro-audio apparaten zonder AEC.

**Optie 1 — groupId+label filter in `fillSelect`:**
- Elke fysieke mic verschijnt in Windows met drie deviceIDs (alledrie echte hex IDs, zelfde groupId): één kale, één `Default - X`, één `Communications - X`
- Nieuwe filter: groepeer op `groupId`, als er een entry is zonder `Default -` / `Communications -` prefix in het label → verberg de prefix-variants uit de dropdown
- Alleen als er uitsluitend aliases zijn in een groep → toon ze allemaal
- Geldt voor mic, camera, speaker dropdowns

**Optie 2 — endpoint-check na `getUserMedia` + waarschuwing:**
- Nieuwe helpers `aecCheckEndpoint(stream)` en `aecShowEndpointWarning(ep)`
- Controleren na elke `getUserMedia` of resulterende track-label `Default -` of `Communications -` prefix heeft
- Als ja: persistente gele banner verschijnt in AEC card met uitleg en fix-instructie (Windows Sound Settings → Set as Default Device)
- Toegepast in `startAecTest`, `qtTestAEC` én `diagEnsureMic` (consistent gedrag)
- Test gaat wel door, alleen een waarschuwing — user weet waarom meting mogelijk afwijkt

**Niet meegenomen:** experimentele `suppressLocalAudioPlayback` constraint of sampleRate-matching. Alleen de twee gekozen opties.

---

## v3.1.14 — Audio Diagnose stack (3 lagen) + permanent mic-meter

**Datum:** 2026-04-22  
**Status:** Nog niet getest — diagnose-release

**Nieuw:**

**Laag 1 — live logs in AEC-test:**
- `[AEC-STATE]` logs bij fase-overgangen: context states, sampleRates, mic track muted/readyState, setSinkId succes/error
- `[AEC-LIVE]` console-log elke 200ms tijdens hoofdmeting: raw max FFT-byte + bij welke frequentie, per-tone-band max, mic active+muted status

**Laag 2 — nieuwe "🔬 Audio Diagnose" card tussen AEC en Loopback:**
- Real-time **mic raw byte max** bar + getal
- Real-time **RMS (time-domain)** bar (los van FFT — als FFT gek doet, zie je het hier ook)
- Real-time **9-band spectrum** (50/100/200/500/1k/2k/5k/10k/20k Hz) als mini-bars
- **Signaal-path snapshot** paneel dat elke 500ms automatisch ververst: beide audio contexts (state, sampleRate), mic stream active, mic track settings, geselecteerde devices, actieve settings
- **▶ Play test** knop — speelt huidig signaal continu via gekozen speaker zodat je de mic-meters live ziet reageren. 30s auto-stop. Onafhankelijk van de meetlogica.
- **⚗ Diagnose-test** knop — gescripte 10s sequence (stilte-tone-stilte-pink-stilte, elk 2s), meet in elk segment max byte, eindigt met interpretatie-tabel in paneel ("Δ tone vs silence", flags of mic wegvalt)
- **Dump→Console** knop — alles in één JSON naar console voor copy-paste

**Laag 3 — gescripte sequence** (onderdeel van Laag 2 knop "Diagnose-test" hierboven)

**Permanent mic-meter in header:**
- "📡 Mic live" bar naast testvolume
- Live groen bar die altijd (of app nu in een test zit of niet) laat zien of de mic binnen komt
- Als deze naar 0 valt weet je direct dat de stream dood is

**Diagnose-stack heeft eigen mic-stream** — open een eigen stream via `getUserMedia` bij app-start (na 2s vertraging), sluit zich niet wanneer AEC-test start. Onafhankelijk meetkanaal.

**Geen functionele wijzigingen** aan AEC-test-logica of evaluatie.

---

## v3.1.13 — AEC Settings paneel + mic gain (nieuwe iteratie na rollback)

**Datum:** 2026-04-22  
**Status:** Nog niet getest

**Nieuw:**
- **AEC Settings paneel** terug (eerder verwijderd bij rollback naar v3.1.12)
- **Mic gain** toegevoegd: digitale `GainNode` tussen mic-source en analyser. Range 0.1× tot 20×. Default 1.0×. Toont live dB-label naast de slider (×2.0 = +6 dB, ×10 = +20 dB)
- Peak-window primary+fallback logica uit v3.1.14 terug
- Alle settings uit v3.1.14 terug: timing, signaal, analyse, mic constraints, evaluatie drempels
- Persistent in localStorage onder `rr-aec-settings`
- Pending-changes systeem: wijzigingen pas actief na "Opslaan"
- Rode rand + waarschuwing bij waardes buiten `AEC_SAFE_RANGES`

**Gebruik:** Als het signaal-naar-ruis verhouding van de mic te laag is voor een goede meting, verhoog `Mic gain` in het paneel (bv. ×3 of ×5) en Opslaan. Dit boost digitaal na de mic-capture.

**Belangrijk:** digitale gain versterkt zowel signaal als ruis evenredig. Als de mic helemaal geen signaal ontvangt (bv. DSP-filtering in het apparaat), dan helpt digitale gain niet. Dan is er in software niks aan te doen.

**Niet meegenomen uit v3.1.14–v3.1.16:** stereo ChannelMerger, pink/speech envelope-fix, RoomTest signaaltype-consistency, diagnose Play-test. Die komen later eventueel terug als aparte iteraties.

---

## ROLLBACK naar v3.1.12 (vanaf v3.1.16)

**Datum:** 2026-04-22

v3.1.13 t/m v3.1.16 verlaten. v3.1.12 is nu de werkbasis.

Wat verloren in deze rollback:
- stereo fix via ChannelMerger (v3.1.13)
- peak-window primary+fallback logica (v3.1.14)
- AEC Settings paneel (v3.1.14)
- pink/speech envelope-timing fix (v3.1.15)
- RoomTest AEC signaal-type consistency met standalone (v3.1.15)
- Play test diagnose-knop (v3.1.16)
- [AEC-DIAG] bin-dump logs tijdens meting (v3.1.16)

Snapshots van v3.1.13–v3.1.16 blijven bewaard in `.snapshots/` voor referentie.

---

## v3.1.16 — AEC diagnose-tools: Play test + bin dump

**Datum:** 2026-04-22  
**Status:** Nog niet getest — tijdelijke diagnose-hulpmiddelen

**Nieuw:**
- **"▶ Play test" knop** in Settings panel: speelt huidig signaal (tone/pink/speech) continu af uit gekozen speaker met live-mic-monitor. Live bin-waardes worden getoond in monospace block in het paneel. Max 30s per run, Stop-knop beschikbaar.
- **[AEC-DIAG] console-log** tijdens de echte AEC-meting: elke 200ms raw FFT bin-waardes per tone-frequentie (220/277/330/440 Hz), zowel max-byte (0-255) als berekende dBFS.

**Doel:** vaststellen of het test-signaal überhaupt de mic-FFT bereikt in de verwachte frequentieband. Als bij tone-test `220Hz=2 max=5(-80dB)` getoond wordt terwijl je de speaker hoort brommen, dan weten we dat de mic-DSP (MeetUp AEC of anderszins) het signaal verwijdert vóór FFT.

**Geen functionele wijzigingen** aan meetlogica of evaluatie — pure observatie-laag.

---

## v3.1.15 — pink/speech fix + RoomTest consistent

**Datum:** 2026-04-22  
**Status:** Nog niet getest

**Drie gerelateerde fixes:**

**1. Pink noise envelope fix** — `outGain.gain` werd gescheduled bij aanmaak van het signaal i.p.v. in `play()`. Tussen aanmaak en play ging de audio-clock door, waardoor de envelope al afgelopen was tegen de tijd dat de buffer source startte. Nu: envelope op verse `t0` in `play()`, zelfde patroon als tone.

**2. Speech envelope fix + MediaElementSource timing** — idem envelope-bug als pink. Plus: `createMediaElementSource()` werd in `play()` aangeroepen — verplaatst naar vóór de return, want het kan maar één keer per audio element.

**3. RoomTest AEC gebruikt nu `aecMakeMainSignal()` + type-branching** — RoomTest had eigen inline tone-generator die altijd alleen tone speelde, ongeacht gekozen signaaltype. En hij gebruikte alleen `measureToneEnergy`. Nu volledig consistent met standalone AEC: signaal-generator én meting honoreren tone/pink/speech keuze. Anti-pattern #3 (code dupliceren tussen RoomTest en AEC) hiermee opgelost.

**Regressie check:** tone-test in beide testpaden blijft identiek werken.

---

## v3.1.14 — peak-window fix + AEC Settings Panel (DEV)

**Datum:** 2026-04-22  
**Status:** Nog niet getest

**Wat toegevoegd — peak-window fix (Fix B):**
- Peak = `max(peak in eerste 200ms, peak in eerste 800ms)` — vangt zowel snelle (MeetUp) als trage AEC
- Default peakPrimaryMs=200, peakFallbackMs=800
- Steady begint na peakFallback (niet meer vanaf peakPrimary)
- Beide tests (standalone + RoomTest) gebruiken dezelfde logic

**Wat toegevoegd — Settings Panel:**
- Knop "⚙ Settings DEV" naast Start/Stop AEC
- Uitklapbaar paneel, blijft open tijdens testen
- Complete controls voor:
  - Timing: noiseMs, peakPrimaryMs, peakFallbackMs, measureMs
  - Signaal: toneAmpMaster, pinkAmp, channelMode (stereo/mono/L/R)
  - Analyse: fftSize, smoothing, toneBandwidthHz, minDecibels, maxDecibels
  - Mic constraints: echoCancellation, autoGainControl, noiseSuppression (toggles)
  - Evaluatie: thresholdExcellent/Good/Weak, sanityMinDbfs
- Pending-changes systeem: wijzigingen worden niet live toegepast tot "Opslaan"
- Rode rand + waarschuwingstekst bij waardes buiten `AEC_SAFE_RANGES`
- "Defaults" knop (met confirmatie) en "Opslaan" knop
- Persistent via localStorage (`rr-aec-settings`)
- Dirty-indicator "⚠ Niet-opgeslagen wijzigingen"

**Wat veranderd — bestaande meting gebruikt nu settings:**
- `startAecTest()` en `qtTestAEC()` gebruiken `aecSettings.*` overal i.p.v. hardcoded waardes
- `fftByteToDb()`, `measureToneEnergy()`, `aecEvaluate()` gebruiken settings
- RoomTest AEC is nu 100% identiek aan standalone (alleen curve-canvas ID verschilt)

**Let op:**
- Settings-paneel is expliciet "DEV MODE" gemarkeerd — later te verwijderen
- Wijzigingen in paneel worden pas actief na "Opslaan"-knop
- Bij waardes buiten veilige range: rode rand + tekst, maar geen harde blokkade (jij weet wat je doet)

---

## v3.1.13 — stereo tone via ChannelMerger

**Datum:** 2026-04-22  
**Status:** Nog niet getest

**Wat veranderd:**
- Tone-branch in `aecMakeMainSignal()`: `ChannelMergerNode(2)` tussengevoegd, elke oscillator.gain nu verbonden met zowel input 0 (L) als input 1 (R) van de merger
- Pink-branch in `aecMakeMainSignal()`: idem, BufferSource → merger(L+R) → outGain
- RoomTest `qtTestAEC()` inline tone-generator: idem

**Waarom:**
Test-tone kwam alleen uit linker speaker van stereo apparaten (bv MeetUp). Met merger krijgen beide kanalen hetzelfde signaal.

**Ongewijzigd:** speech-branch (HTML audio, al stereo), timing, amplitudes, setSinkId.

---

## v3.1.12 — setSinkId toegevoegd aan AEC-test

**Datum:** 2026-04-22  
**Status:** Nog niet getest

**Wat veranderd:**
- `await spkCtx.setSinkId(selSpeaker.value)` toegevoegd in `startAecTest()` (standalone)
- Idem toegevoegd in `qtTestAEC()` (RoomTest)

**Waarom:**
In v3.1.11 (en waarschijnlijk eerder ook) speelde de AEC-test de tone af op Windows default speaker i.p.v. de door gebruiker gekozen speaker in de dropdown. Loopback werkte wel omdat die de `setSinkId` call wel deed. Symptoom: tone hoorbaar in Loopback, niet in AEC-test, mic meet alleen kamerruis.

---

## v3.1.11 — calibratie weg, logs opgeschoond, adapt-window 800ms

**Datum:** 2026-04-22  
**Status:** Nog niet getest

**Wat veranderd:**
- `aecRunCalibration()` + `aecShowCalibModal()` aanroepen weg uit `startAecTest()` (standalone)
- Idem weg uit `qtTestAEC()` (RoomTest) — "Calibratie afgebroken" state ook weg
- Fases hernummerd: AEC-test ① ruisvloer → ② meting (RoomTest ook)
- Verbose `[AEC-DIAG]` / `[RoomTest-AEC-DIAG]` logs weg
- Verbose `[AEC] main spkCtx / main sig play` logs weg
- Eén compacte eindlog per test:
  `[AEC] 22 dB demping · goed — peak -45 · steady -67 · ruis -85 dBFS`
- **adapt-window 500ms → 800ms** — geeft langzamer convergerende AECs ruimte om in peak-fase te verschijnen

**Ongewijzigd gebleven (op verzoek):**
- Tone-amplitudes `[0.36, 0.26, 0.20, 0.16]` (+3 dB gaf vervorming)
- `[MIC] heartbeat` logs blijven (nuttig voor mic-debugging)
- Functies `aecRunCalibration`, `aecShowCalibModal`, `aecMakeCalibBurst` blijven in code (ongebruikt, maar aanwezig)
- Modal HTML `aec-calib-modal` blijft in DOM (verborgen)

---

## v3.1.10 — AEC-diagnostiek toegevoegd

**Datum:** 2026-04-22  
**Status:** Nog niet getest. Gebouwd op v3.1.8-baseline (calibratie blijft erin, wordt nog weer weggehaald als meting werkt).

**Wat toegevoegd:**
- `[AEC-DIAG]` console log na ruisvloer-fase in standalone AEC-test (min/max/mediaan)
- `[AEC-DIAG]` console log na meting in standalone AEC-test (adapt/steady/overall stats)
- `[RoomTest-AEC-DIAG]` idem voor de RoomTest AEC-stap
- Sanity-check in standalone AEC: als `overallMax < -60 dBFS` → "Geen signaal gemeten" fail state i.p.v. onzinnige demping-meting
- RoomTest AEC sanity-check veranderd van `peakDb < -60` naar `overallMax < -60` (signaal dat alleen in steady-fase hoorbaar is telt nu wel mee)

**Doel:** bepalen waarom MeetUp mic -81 dB meet. Logs tonen of het signaal überhaupt binnenkomt, waar in de tijd, en hoeveel.

**Niet aangeraakt:** meetlogica zelf, tone generation, FFT settings, volume.

---

## v3.1.9 — GEBROKEN, NIET GEBRUIKEN

**Datum:** 2026-04-22  
**Status:** User meldde dat mic-tests plotseling -81 dB gaven en Realtek intern niet werkte. Teruggerold naar v3.1.8.

**Wat veranderd:** volume-calibratie verwijderd. Achteraf: verwijdering zelf niet de oorzaak, maar v3.1.9 bevatte ook een mogelijk artefact. Verder onderzoek via v3.1.10.

---

## v3.1.8 — BASELINE (snapshot opgeslagen)

**Datum:** 2026-04-22  
**Status:** Werkt op Realtek mic. C920-mic bekend niet-zichtbaar in dropdown (Chromium weigert hem in enumerateDevices, oorzaak niet gevonden).

**Functioneel:**
- AEC-test met tone signaal werkt: reproduceerbare demping-meting in dB
- Calibratie-modal toont altijd, auto-sluit bij groene status
- Adaptation curve tekent live tijdens AEC-fase
- RoomTest doorloopt alle 3 stappen zonder vastlopen
- Volume-slider (in-app digital, geen Windows master) werkt live
- Device enumeration apart per audio/video om PTZ-coupling te vermijden
- Tone timing deterministisch (scheduled op audio clock)
- Direct naar spkCtx.destination, geen MediaStream-bridge
- `use-fake-ui-for-media-stream` flag verwijderd

**Anti-patterns expliciet verwijderd:**
- Geen csc.exe voor Windows volume
- Geen COM polling
- Geen MediaStream→Audio bridge
- Geen `{exact: 'default'}` constraints

**Bekende open issues:**
- C920 ingebouwde mic verschijnt niet in Chromium's enumerateDevices (Windows ziet hem wel)
- Realtek mic gain kan laag zijn (Windows setting)

---

## v3.1.9 — GEBROKEN, NIET GEBRUIKEN

**Datum:** 2026-04-22  
**Status:** User meldde dat mic-tests plotseling -81 dB gaven en Realtek intern niet werkte. Teruggerold naar v3.1.8.

**Wat veranderd:** volume-calibratie verwijderd. Achteraf: verwijdering zelf niet de oorzaak, maar v3.1.9 bevatte ook een mogelijk artefact. Verder onderzoek via v3.1.10.

---

## v3.1.8 — BASELINE (snapshot opgeslagen)

**Datum:** 2026-04-22  
**Status:** Werkt op Realtek mic. C920-mic bekend niet-zichtbaar in dropdown (Chromium weigert hem in enumerateDevices, oorzaak niet gevonden).

**Functioneel:**
- AEC-test met tone signaal werkt: reproduceerbare demping-meting in dB
- Calibratie-modal toont altijd, auto-sluit bij groene status
- Adaptation curve tekent live tijdens AEC-fase
- RoomTest doorloopt alle 3 stappen zonder vastlopen
- Volume-slider (in-app digital, geen Windows master) werkt live
- Device enumeration apart per audio/video om PTZ-coupling te vermijden
- Tone timing deterministisch (scheduled op audio clock)
- Direct naar spkCtx.destination, geen MediaStream-bridge
- `use-fake-ui-for-media-stream` flag verwijderd

**Anti-patterns expliciet verwijderd:**
- Geen csc.exe voor Windows volume
- Geen COM polling
- Geen MediaStream→Audio bridge
- Geen `{exact: 'default'}` constraints

**Bekende open issues:**
- C920 ingebouwde mic verschijnt niet in Chromium's enumerateDevices (Windows ziet hem wel)
- Realtek mic gain kan laag zijn (Windows setting)
