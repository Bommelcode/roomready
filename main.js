const { app, BrowserWindow, session, ipcMain, shell, dialog, screen, Menu } = require('electron')
const dgram = require('dgram')
const net   = require('net')
const http  = require('http')
const https = require('https')

const path = require('path')

// Windows AppUserModelID — bepaalt hoe de Shell pinned shortcuts identificeert
// en groepeert. Zonder dit toont Windows soms 'Electron' als titel/icoon op
// de pinned-taskbar entry. Moet vóór elke window-creatie worden gezet.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.bommelcode.roomready')
}
const { execFile, exec } = require('child_process')
const os   = require('os')
const fs   = require('fs')

// Pad naar kiosk-state bestand (lazy — app.getPath mag pas na whenReady)
let _kioskStatePath = null
function kioskStatePath() {
  if (!_kioskStatePath) {
    _kioskStatePath = path.join(app.getPath('userData'), 'kiosk-state.json')
  }
  return _kioskStatePath
}
function readKioskState() {
  try {
    const p = kioskStatePath()
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'))
    }
  } catch(e) {}
  return { enabled: true }  // Default: kiosk aan bij eerste start
}
function writeKioskState(s) {
  try {
    fs.writeFileSync(kioskStatePath(), JSON.stringify(s, null, 2))
  } catch(e) { console.error('[KIOSK] writeState fail:', e) }
}

function buildMenu(mainWin) {
  const state = readKioskState()
  const template = [
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Kiosk Mode',
          type: 'checkbox',
          checked: state.enabled,
          click: (menuItem) => {
            const newState = { enabled: menuItem.checked }
            writeKioskState(newState)
            mainWin.webContents.send('kiosk-toggled', newState.enabled)
          }
        }
      ]
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'AV Inventaris…', accelerator: 'CmdOrCtrl+I', click: () => openInventoryWindow() }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Over RoomReady…', click: () => showAboutDialog(mainWin) },
        { type: 'separator' },
        { label: 'RoomReady op GitHub', click: () => shell.openExternal('https://github.com/') }
      ]
    }
  ]
  return Menu.buildFromTemplate(template)
}

// About-dialog met versie-info, productnaam en credits.
function showAboutDialog(parentWin) {
  const pkg = require('./package.json')
  const electronVer = process.versions.electron || '?'
  const chromeVer   = process.versions.chrome   || '?'
  const nodeVer     = process.versions.node     || '?'
  dialog.showMessageBox(parentWin || undefined, {
    type: 'info',
    title: 'Over RoomReady',
    message: 'RoomReady',
    detail: [
      'Versie ' + (pkg.version || '?'),
      pkg.description || '',
      '',
      'Electron ' + electronVer,
      'Chromium '  + chromeVer,
      'Node '      + nodeVer,
    ].filter(Boolean).join('\n'),
    buttons: ['Sluiten'],
    defaultId: 0,
    icon: path.join(__dirname, 'icon.ico'),
    noLink: true,
  }).catch(() => {})
}

// Inventaris-venster openen (gedeeld door menu Tools en IPC inv-open).
// Hergebruikt 'n bestaande window door focus i.p.v. een nieuwe te spawnen.
function openInventoryWindow() {
  if (inventoryWin && !inventoryWin.isDestroyed()) {
    inventoryWin.focus()
    return { ok: true, reused: true }
  }
  inventoryWin = new BrowserWindow({
    width: 1200, height: 780,
    minWidth: 900, minHeight: 600,
    title: 'RoomReady — AV Inventaris',
    backgroundColor: '#0e1219',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  inventoryWin.setMenuBarVisibility(false)
  inventoryWin.loadFile('inventory.html')
  if (process.env.RR_INV_DEVTOOLS) {
    inventoryWin.webContents.once('did-finish-load', () => {
      inventoryWin.webContents.openDevTools({ mode: 'right' })
    })
  }
  inventoryWin.on('closed', () => { inventoryWin = null })
  return { ok: true, reused: false }
}
let inventoryWin = null  // module-level zodat menu en IPC dezelfde ref delen

// ── Window ────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 820,
    minWidth: 960, minHeight: 680,
    title: 'RoomReady',
    backgroundColor: '#0e1219',
    icon: path.join(__dirname, 'icon.ico'),
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  ipcMain.handle('open-external',       (_, url) => shell.openExternal(url))
  ipcMain.handle('open-camera-settings',()        => shell.openExternal('ms-settings:privacy-webcam'))

  // ── Windows audio (Core Audio COM via vooraf-gecompileerde helper) ──
  // Helper-exe wordt synchroon gespawned per actie en exit'et binnen ms.
  // Geen runtime csc/Add-Type, geen AudioServiceOutOfProcess, geen blijvende
  // COM-handles. Zie CLAUDE.md voor de regels rond Windows audio control.
  function audioHelperPath() {
    // Dev tree: app/helpers/audio-control.exe.
    // Packaged: helpers/ staat naast resources/ (sibling van app.asar). De
    // pack.js / electron-builder zet 'm daar buiten de asar omdat .exe's
    // niet vanuit een asar gespawnd kunnen worden.
    if (app.isPackaged) {
      return path.join(process.resourcesPath, '..', 'helpers', 'audio-control.exe')
    }
    return path.join(__dirname, 'helpers', 'audio-control.exe')
  }
  function audioHelperRun(args) {
    return new Promise(resolve => {
      const exe = audioHelperPath()
      if (!fs.existsSync(exe)) {
        resolve({ ok: false, error: 'audio-control.exe niet gevonden op ' + exe })
        return
      }
      execFile(exe, args, { windowsHide: true, timeout: 5000 }, (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || '').trim() || err.message
          resolve({ ok: false, error: msg, code: err.code })
        } else {
          resolve({ ok: true, stdout: (stdout || '').trim() })
        }
      })
    })
  }
  ipcMain.handle('audio-list', async () => {
    const r = await audioHelperRun(['list'])
    if (!r.ok) return { ok: false, error: r.error }
    try { return { ok: true, devices: JSON.parse(r.stdout) } }
    catch (e) { return { ok: false, error: 'parse error: ' + e.message } }
  })
  ipcMain.handle('audio-get-defaults', async () => {
    const r = await audioHelperRun(['get-defaults'])
    if (!r.ok) return { ok: false, error: r.error }
    try { return Object.assign({ ok: true }, JSON.parse(r.stdout)) }
    catch (e) { return { ok: false, error: 'parse error: ' + e.message } }
  })
  ipcMain.handle('audio-get', async (_, id) => {
    const r = await audioHelperRun(['get', String(id)])
    if (!r.ok) return { ok: false, error: r.error }
    try { return { ok: true, device: JSON.parse(r.stdout) } }
    catch (e) { return { ok: false, error: 'parse error: ' + e.message } }
  })
  ipcMain.handle('audio-set-volume', async (_, id, pct) => {
    const r = await audioHelperRun(['set-volume', String(id), String(pct)])
    return { ok: r.ok, error: r.ok ? null : r.error }
  })
  ipcMain.handle('audio-set-mute', async (_, id, muted) => {
    const r = await audioHelperRun(['set-mute', String(id), muted ? 'true' : 'false'])
    return { ok: r.ok, error: r.ok ? null : r.error }
  })

  // ── Samples (TTS audio voor Speaker+Mic test) ──────────────
  function samplesDir() {
    if (app.isPackaged) return path.join(process.resourcesPath, 'samples')
    // Dev tree (npm run start): probeer eerst app/samples, anders ../resources/samples
    // (de prod-locatie naast de geïnstalleerde RoomReady.exe).
    const local = path.join(__dirname, 'samples')
    if (fs.existsSync(local)) return local
    return path.join(__dirname, '..', 'resources', 'samples')
  }
  ipcMain.handle('list-samples', () => {
    try {
      const dir = samplesDir()
      if (!fs.existsSync(dir)) return []
      return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.wav')).sort()
    } catch(e) { return [] }
  })
  ipcMain.handle('read-sample', (_, filename) => {
    try {
      if (!filename || /[\\/]/.test(filename)) return null
      const full = path.join(samplesDir(), filename)
      if (!fs.existsSync(full)) return null
      const buf = fs.readFileSync(full)
      return buf.toString('base64')
    } catch(e) { return null }
  })
  ipcMain.handle('read-quotes-json', () => {
    try {
      const full = path.join(samplesDir(), 'quotes.json')
      if (!fs.existsSync(full)) return null
      return fs.readFileSync(full, 'utf-8')
    } catch(e) { return null }
  })

  // ── Externe monitor preview ────────────────────────────────────
  let previewWin = null

  ipcMain.handle('list-displays', () => {
    try {
      const displays = screen.getAllDisplays()
      const primary  = screen.getPrimaryDisplay()
      return displays.map(d => ({
        id: d.id,
        label: d.label || ('Scherm ' + d.id),
        bounds: d.bounds,
        isPrimary: d.id === primary.id,
        size: d.size,
        scaleFactor: d.scaleFactor
      }))
    } catch (e) {
      console.warn('[main] list-displays error:', e.message)
      return []
    }
  })

  ipcMain.handle('open-preview', (_, args) => {
    try {
      const displayId = args?.displayId
      if (previewWin && !previewWin.isDestroyed()) { previewWin.close(); previewWin = null }

      const displays = screen.getAllDisplays()
      const primary  = screen.getPrimaryDisplay()
      let target = displays.find(d => d.id === displayId)
      if (!target) target = displays.find(d => d.id !== primary.id) || primary
      if (!target) return { ok: false, error: 'Geen geschikt scherm gevonden' }

      const b = target.bounds
      previewWin = new BrowserWindow({
        x: b.x, y: b.y, width: b.width, height: b.height,
        fullscreen: true,
        autoHideMenuBar: true,
        backgroundColor: '#0a0f18',
        title: 'RoomReady',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, 'preload.js')
        }
      })
      previewWin.setMenuBarVisibility(false)
      // loadFile retourneert een promise — vang rejections (display kan tussen window-creatie
      // en load weg zijn met meerdere schermen) zodat het niet bubbelt naar een unhandled rejection.
      previewWin.loadFile('preview.html').catch(e => {
        console.warn('[main] preview loadFile failed:', e.message)
      })
      const thisWin = previewWin
      thisWin.once('ready-to-show', () => {
        try { if (!thisWin.isDestroyed()) thisWin.show() } catch(_){}
      })
      thisWin.on('closed', () => {
        if (previewWin === thisWin) previewWin = null
      })
      return { ok: true, displayId: target.id }
    } catch (e) {
      console.warn('[main] open-preview error:', e.message)
      previewWin = null
      return { ok: false, error: e.message }
    }
  })

  // Renderer → main → preview: stap-info doorsturen voor RoomTest.
  // BroadcastChannel werkt soms niet betrouwbaar tussen Electron-windows
  // (separate renderer processen, session-isolatie afhankelijk van versie).
  // IPC-relay is robuust.
  ipcMain.handle('preview-broadcast', (_, payload) => {
    try {
      if (previewWin && !previewWin.isDestroyed()) {
        previewWin.webContents.send('preview-update', payload)
      }
    } catch (e) { console.warn('[main] preview-broadcast error:', e.message) }
    return { ok: true }
  })

  ipcMain.handle('close-preview', () => {
    try {
      if (previewWin && !previewWin.isDestroyed()) { previewWin.close() }
    } catch (e) {
      console.warn('[main] close-preview error:', e.message)
    }
    previewWin = null
    return { ok: true }
  })

  // Als het externe scherm losgetrokken wordt, sluit het preview-venster netjes —
  // anders blijft 'ie hangen op een coordinate-block dat niet meer bestaat en kunnen
  // volgende open-preview calls falen op stale state.
  const handleDisplayRemoved = () => {
    try {
      if (!previewWin || previewWin.isDestroyed()) return
      const winBounds = previewWin.getBounds()
      const stillExists = screen.getAllDisplays().some(d => {
        const b = d.bounds
        return winBounds.x >= b.x && winBounds.x < b.x + b.width &&
               winBounds.y >= b.y && winBounds.y < b.y + b.height
      })
      if (!stillExists) {
        previewWin.close()
        previewWin = null
      }
    } catch (e) {
      console.warn('[main] display-removed cleanup error:', e.message)
    }
  }
  screen.on('display-removed', handleDisplayRemoved)

  // Display changes naar renderer broadcasten zodat de Extern-Scherm
  // dropdown automatisch ververst (nieuw aangesloten monitor verschijnt
  // dan zonder dat de operator hoeft te klikken / app te herstarten).
  const broadcastDisplays = () => {
    try {
      if (win && !win.isDestroyed()) win.webContents.send('display-changed')
    } catch (e) { /* noop */ }
  }
  screen.on('display-added',           broadcastDisplays)
  screen.on('display-removed',         broadcastDisplays)
  screen.on('display-metrics-changed', broadcastDisplays)

  // ── VISCA over UDP ─────────────────────────────────────────────
  ipcMain.handle('visca-udp', (_, ip, port, hexCmd) => {
    return new Promise(resolve => {
      try {
        const sock = dgram.createSocket('udp4')
        const buf  = Buffer.from(hexCmd, 'hex')
        sock.send(buf, 0, buf.length, port, ip, err => {
          sock.close()
          resolve({ ok: !err, error: err?.message })
        })
        setTimeout(() => { try { sock.close() } catch(e) {} resolve({ ok: false, error: 'Timeout' }) }, 1000)
      } catch(e) { resolve({ ok: false, error: e.message }) }
    })
  })

  // ── VISCA over TCP ─────────────────────────────────────────────
  ipcMain.handle('visca-tcp', (_, ip, port, hexCmd) => {
    return new Promise(resolve => {
      try {
        const client = new net.Socket()
        const buf = Buffer.from(hexCmd, 'hex')
        let done = false
        const finish = (ok, err) => {
          if (done) return; done = true
          try { client.destroy() } catch(e) {}
          resolve({ ok, error: err })
        }
        client.setTimeout(1500)
        client.connect(port, ip, () => {
          client.write(buf)
          setTimeout(() => finish(true, null), 200)
        })
        client.on('error', e => finish(false, e.message))
        client.on('timeout', () => finish(false, 'Timeout'))
      } catch(e) { resolve({ ok: false, error: e.message }) }
    })
  })

  // ── Update via drag-and-drop zip ────────────────────────────
  ipcMain.handle('apply-update', async (_, zipPath) => {
    const tmpDir  = path.join(os.tmpdir(), 'rr_update_' + Date.now())
    const appDir  = path.dirname(process.execPath)
    const exePath = process.execPath
    const ps1Path = path.join(os.tmpdir(), 'rr_update.ps1')
    const vbsPath = path.join(os.tmpdir(), 'rr_update.vbs')
    const logPath = path.join(os.tmpdir(), 'rr_update.log')

    // Stap 1: uitpakken
    try { fs.mkdirSync(tmpDir, { recursive: true }) }
    catch(e) { return { ok: false, error: 'Map aanmaken mislukt: ' + e.message } }

    const psUnzip = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g,"''")}' -DestinationPath '${tmpDir.replace(/'/g,"''")}' -Force`
    const unzipOk = await new Promise(resolve => {
      exec(`powershell -NoProfile -NonInteractive -Command "${psUnzip}"`,
        { windowsHide: true, timeout: 60000 }, (err) => {
          if (err) console.error('Unzip fout:', err.message)
          resolve(!err)
        })
    })
    if (!unzipOk) return { ok: false, error: 'Uitpakken mislukt — is het een geldige ZIP?' }

    // Stap 2: zoek de map met resources/app.asar
    const findUnpacked = (dir) => {
      try {
        if (fs.existsSync(path.join(dir, 'resources', 'app.asar'))) return dir
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
          if (f.isDirectory()) { const r = findUnpacked(path.join(dir, f.name)); if (r) return r }
        }
      } catch(e) {}
      return null
    }
    const srcDir = findUnpacked(tmpDir)
    if (!srcDir) return { ok: false, error: 'Geen geldige RoomReady-map gevonden in ZIP' }

    // Stap 3: schrijf PS1 (gebruikt dubbele aanhalingstekens voor paden)
    const q = (p) => p.replace(/"/g, '`"')  // escape " voor PowerShell strings
    const ps1 = [
      `$log = "${q(logPath)}"`,
      `"Update gestart: $(Get-Date)" | Out-File $log`,
      `Start-Sleep -Seconds 2`,
      `$src = "${q(srcDir)}"`,
      `$dst = "${q(appDir)}"`,
      `$exe = "${q(exePath)}"`,
      `$tmp = "${q(tmpDir)}"`,
      `"Kopieer van $src naar $dst" | Out-File $log -Append`,
      `$r = robocopy $src $dst /E /IS /IT /IM /NP /NFL /NDL /NJH /NJS`,
      `"Robocopy exitcode: $LASTEXITCODE" | Out-File $log -Append`,
      `if ($LASTEXITCODE -ge 8) { "FOUT: kopiëren mislukt" | Out-File $log -Append; exit 1 }`,
      `"Klaar, start app" | Out-File $log -Append`,
      `Start-Process $exe`,
      `Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue`,
    ].join('\r\n')

    // Stap 4: schrijf VBScript die PS1 elevated uitvoert via ShellExecute
    // ShellExecute "runas" is de meest betrouwbare UAC-methode op Windows
    const vbs = [
      'Set oShell = CreateObject("Shell.Application")',
      `oShell.ShellExecute "powershell.exe", "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & "${q(ps1Path)}" & """", "", "runas", 1`,
    ].join('\r\n')

    try {
      fs.writeFileSync(ps1Path, ps1, 'utf8')
      fs.writeFileSync(vbsPath, vbs, 'utf8')
    } catch(e) {
      return { ok: false, error: 'Script schrijven mislukt: ' + e.message }
    }

    // Stap 5: start VBS (triggert UAC) en sluit app
    const { spawn } = require('child_process')
    spawn('wscript.exe', [vbsPath], {
      detached: true, windowsHide: false, stdio: 'ignore'
    }).unref()

    setTimeout(() => { app.exit(0) }, 800)
    return { ok: true }
  })

  // ══════════════════════════════════════════════════════════════
  // AV INVENTARISATIE — Logitech HID, USB UVC (Avonic), Display EDID
  // ══════════════════════════════════════════════════════════════
  // (inventoryWin staat module-level zodat 't menu en IPC dezelfde ref delen)

  function runPowerShellJson(script, timeoutMs = 30000) {
    return new Promise((resolve) => {
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            // Stderr is vaak leeg als $ErrorActionPreference='SilentlyContinue' actief is.
            // Surface alles wat we hebben: exit code, signal, killed-flag, stderr, stdout.
            const parts = []
            if (err.code != null) parts.push('exit=' + err.code)
            if (err.killed) parts.push('killed=true')
            if (err.signal) parts.push('signal=' + err.signal)
            const se = (stderr || '').trim()
            const so = (stdout || '').trim()
            if (se) parts.push('stderr=' + se.slice(0, 500))
            if (so) parts.push('stdout=' + so.slice(0, 500))
            if (!parts.length) parts.push(err.message.slice(0, 500))
            return resolve({ ok: false, error: parts.join(' | '), data: [] })
          }
          const out = (stdout || '').trim()
          if (!out) return resolve({ ok: true, data: [] })
          try {
            const parsed = JSON.parse(out)
            const arr = Array.isArray(parsed) ? parsed : [parsed]
            resolve({ ok: true, data: arr })
          } catch (e) {
            resolve({ ok: false, error: 'JSON parse: ' + e.message + ' — stdout: ' + out.slice(0, 200), data: [] })
          }
        })
    })
  }

  // PNPDeviceID → { vid, pid, instance }.
  // Format: USB\VID_046D&PID_0866\1234ABCD   (serial bij iSerialNumber)
  //     of: USB\VID_046D&PID_0866\6&2A51B47D&0&2  (Windows-generated — géén serial)
  const PNP_RE = /^USB\\VID_([0-9A-Fa-f]{4})&PID_([0-9A-Fa-f]{4})(?:&[^\\]*)?\\(.+)$/
  function parsePnpId(pnp) {
    const m = PNP_RE.exec(pnp || '')
    if (!m) return { vid: null, pid: null, instance: null, hasRealSerial: false }
    const instance = m[3]
    // Windows-generated PnP path bevat '&' — iSerialNumber descriptor bevat dat (bijna) nooit
    const hasRealSerial = !instance.includes('&')
    return { vid: m[1].toUpperCase(), pid: m[2].toUpperCase(), instance, hasRealSerial }
  }

  // ── Logitech HID scan ────────────────────────────────────────
  // Alle USB-devices onder VID 046D, plus DEVPKEY_Device_SerialNumber ophalen
  // via Get-PnpDeviceProperty voor devices die iSerialNumber wel exposen maar
  // waar Windows dit niet in de PNPDeviceID heeft gezet.
  const PS_LOGITECH = `
$ErrorActionPreference = 'SilentlyContinue'
# WMI-side pre-filter (LIKE met %) is ordes sneller dan client-side Where-Object
# omdat we Win32_PnPEntity niet volledig hoeven te materialiseren.
$devs = Get-CimInstance Win32_PnPEntity -Filter "PNPDeviceID LIKE 'USB\\VID_046D%'"
$rows = foreach ($d in $devs) {
  $sn = $null
  try {
    $prop = Get-PnpDeviceProperty -InstanceId $d.PNPDeviceID -KeyName 'DEVPKEY_Device_SerialNumber' -ErrorAction SilentlyContinue
    if ($prop -and $prop.Data) { $sn = [string]$prop.Data }
  } catch {}
  $parent = $null
  try {
    $pprop = Get-PnpDeviceProperty -InstanceId $d.PNPDeviceID -KeyName 'DEVPKEY_Device_Parent' -ErrorAction SilentlyContinue
    if ($pprop -and $pprop.Data) { $parent = [string]$pprop.Data }
  } catch {}
  [PSCustomObject]@{
    Name         = $d.Name
    PNPDeviceID  = $d.PNPDeviceID
    Manufacturer = $d.Manufacturer
    Service      = $d.Service
    PNPClass     = $d.PNPClass
    Status       = $d.Status
    DeviceSerial = $sn
    Parent       = $parent
  }
}
if ($rows) { $rows | ConvertTo-Json -Depth 3 -Compress } else { '[]' }
`
  // Composite USB devices exposen per fysiek ding één composite parent (zonder
  // &MI_XX in de PNPDeviceID) plus per interface één kind-entry. De interfaces
  // noemen zichzelf via DEVPKEY_Device_Parent de PNPDeviceID van de parent.
  // Strategie: groepeer interfaces onder hun parent-PNPDeviceID, en leen hun
  // beschrijvende naam ("HD Pro Webcam C920") als de parent "USB Composite Device" heet.
  const GENERIC_NAME_RE = /^(USB Composite Device|USB Input Device|USB Mass Storage Device|USB Audio Device|Unknown)$/i
  function dedupeComposite(rows) {
    const groups = new Map()  // groupKey → { entries: [{row,p,isInterface}], primary?: entry }
    for (const row of rows) {
      const p = parsePnpId(row.PNPDeviceID || '')
      if (!p.vid) continue
      if (/^USB\\ROOT_HUB/i.test(row.PNPDeviceID || '')) continue
      const isInterface = /&MI_[0-9A-Fa-f]{2}\\/.test(row.PNPDeviceID || '')
      // Interface → groep op parent's PNPDeviceID (composite parent).
      // Non-interface (parent of single-interface device) → groep op zichzelf.
      const groupKey = isInterface ? (row.Parent || row.PNPDeviceID) : row.PNPDeviceID
      if (!groups.has(groupKey)) groups.set(groupKey, { entries: [] })
      groups.get(groupKey).entries.push({ row, p, isInterface })
    }

    const result = []
    for (const [groupKey, g] of groups) {
      // Kies primair: liefst een non-interface die dezelfde PNPDeviceID heeft als groupKey.
      let primary = g.entries.find(e => !e.isInterface && e.row.PNPDeviceID === groupKey)
      if (!primary) primary = g.entries.find(e => !e.isInterface)
      if (!primary) primary = g.entries[0]  // alleen interfaces beschikbaar (rare edge case)

      const { row, p } = primary
      const serial = row.DeviceSerial || (p.hasRealSerial ? p.instance : '')

      // Leen naam/class van een interface als primary's naam generic is
      let name = row.Name || ''
      let pnpClass = row.PNPClass || ''
      if (GENERIC_NAME_RE.test(name)) {
        const better = g.entries.find(e =>
          e.isInterface && e.row.Name && !GENERIC_NAME_RE.test(e.row.Name))
        if (better) {
          name = better.row.Name
          if (!pnpClass || pnpClass === 'USB') pnpClass = better.row.PNPClass || pnpClass
        }
      }

      result.push({
        vid: p.vid,
        pid: p.pid,
        pnpDeviceId: row.PNPDeviceID,
        name,
        manufacturer: row.Manufacturer || '',
        service: row.Service || '',
        pnpClass,
        status: row.Status || '',
        serialNumber: serial,
        instance: p.instance,
        hasRealSerial: !!serial,
      })
    }
    return result
  }

  ipcMain.handle('inv-scan-logitech', async () => {
    const r = await runPowerShellJson(PS_LOGITECH)
    if (!r.ok) return { ok: false, error: r.error, devices: [] }
    return { ok: true, devices: dedupeComposite(r.data) }
  })

  // ── USB peripheral scan (alle USB, exclusief Logitech + root-hubs) ──
  // Brede scan: cameras, microfoons, audio interfaces, HID controllers, etc.
  // Filteren doen we in renderer via PnPClass; root-hubs en generic hubs worden
  // hier al weggegooid omdat die nooit interessant zijn voor inventarisatie.
  const PS_USB = `
$ErrorActionPreference = 'SilentlyContinue'
# WMI-side pre-filter zoals bij PS_LOGITECH — voorkomt timeout op machines
# met honderden PnP-devices. ROOT_HUB en USBHUB-services filteren we daarna
# client-side (compound NOT-conditions in WQL zijn fragiel).
$rows = Get-CimInstance Win32_PnPEntity -Filter "PNPDeviceID LIKE 'USB\\%'" | Where-Object {
  $_.PNPDeviceID -notlike 'USB\\ROOT_HUB*' -and
  $_.Service -ne 'USBHUB' -and
  $_.Service -ne 'USBHUB3'
} | ForEach-Object {
  $sn = $null
  try {
    $prop = Get-PnpDeviceProperty -InstanceId $_.PNPDeviceID -KeyName 'DEVPKEY_Device_SerialNumber' -ErrorAction SilentlyContinue
    if ($prop -and $prop.Data) { $sn = [string]$prop.Data }
  } catch {}
  $parent = $null
  try {
    $pprop = Get-PnpDeviceProperty -InstanceId $_.PNPDeviceID -KeyName 'DEVPKEY_Device_Parent' -ErrorAction SilentlyContinue
    if ($pprop -and $pprop.Data) { $parent = [string]$pprop.Data }
  } catch {}
  [PSCustomObject]@{
    Name         = $_.Name
    PNPDeviceID  = $_.PNPDeviceID
    Manufacturer = $_.Manufacturer
    Service      = $_.Service
    PNPClass     = $_.PNPClass
    Status       = $_.Status
    DeviceSerial = $sn
    Parent       = $parent
  }
}
if ($rows) { $rows | ConvertTo-Json -Depth 3 -Compress } else { '[]' }
`
  // Avonic-naming: sinds juni 2022 firmware = "Avonic XXXX" met XXXX = laatste 4 hex van MAC
  const AVONIC_NEW = /^Avonic\s+([0-9A-Fa-f]{4})\b/i
  const AVONIC_OLD = /^FHD\s+Camera\b/i
  function classifyUsb(name) {
    if (!name) return { brand: 'unknown', modelHint: null, partialMac: null }
    let m = AVONIC_NEW.exec(name)
    if (m) return { brand: 'avonic', modelHint: `Avonic (MAC...${m[1].toUpperCase()})`, partialMac: m[1].toUpperCase() }
    if (AVONIC_OLD.test(name)) return { brand: 'avonic', modelHint: 'Avonic (FHD Camera, pre-2022 firmware)', partialMac: null }
    return { brand: 'other', modelHint: name, partialMac: null }
  }
  ipcMain.handle('inv-scan-usb', async () => {
    const r = await runPowerShellJson(PS_USB)
    if (!r.ok) return { ok: false, error: r.error, devices: [] }
    // Logitech filter vóór dedup, anders valt een Logitech-parent uit als enige entry
    const nonLogi = r.data.filter(row => {
      const p = parsePnpId(row.PNPDeviceID || '')
      return p.vid && p.vid !== '046D'
    })
    const deduped = dedupeComposite(nonLogi)
    // Classificeer na dedup zodat de class-info van de beste naam gebruikt wordt
    const out = deduped.map(d => {
      const { brand, modelHint, partialMac } = classifyUsb(d.name || '')
      return { ...d, brand, modelHint, partialMac }
    })
    return { ok: true, devices: out }
  })

  // ── Display / EDID scan ─────────────────────────────────────
  const PNPID_VENDORS = {
    SAM: 'Samsung', SEC: 'Samsung', LGD: 'LG', GSM: 'LG', LGE: 'LG',
    DEL: 'Dell', HWP: 'HP', NEC: 'NEC', SNY: 'Sony', PHL: 'Philips',
    ACI: 'Asus', AUO: 'AU Optronics', BNQ: 'BenQ', EIZ: 'EIZO',
    VIZ: 'Vizio', IVM: 'Iiyama', SHP: 'Sharp', VSC: 'ViewSonic',
    BOE: 'BOE', CMN: 'Chimei Innolux', MEI: 'Panasonic', PAN: 'Panasonic',
    TOS: 'Toshiba', HIT: 'Hitachi',
  }
  const PS_DISPLAYS = `
$ErrorActionPreference = 'SilentlyContinue'
$rows = Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorID | ForEach-Object {
  function Decode($arr) {
    if ($null -eq $arr) { return "" }
    ($arr | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join ''
  }
  [PSCustomObject]@{
    Manufacturer = Decode $_.ManufacturerName
    Model        = Decode $_.UserFriendlyName
    ProductCode  = Decode $_.ProductCodeID
    Serial       = Decode $_.SerialNumberID
    Year         = $_.YearOfManufacture
    Week         = $_.WeekOfManufacture
    InstanceName = $_.InstanceName
    Active       = $_.Active
  }
}
if ($rows) { $rows | ConvertTo-Json -Depth 3 -Compress } else { '[]' }
`
  ipcMain.handle('inv-scan-displays', async () => {
    const r = await runPowerShellJson(PS_DISPLAYS, 15000)
    if (!r.ok) return { ok: false, error: r.error, displays: [] }
    const out = []
    for (const row of r.data) {
      if (row.Active === false) continue
      const code = ((row.Manufacturer || '') + '').toUpperCase().trim()
      out.push({
        manufacturerCode: code,
        manufacturer: PNPID_VENDORS[code] || code || 'Unknown',
        model: ((row.Model || '') + '').trim(),
        productCode: ((row.ProductCode || '') + '').trim(),
        serialNumber: ((row.Serial || '') + '').trim(),
        year: (typeof row.Year === 'number' && row.Year > 0) ? row.Year : null,
        week: row.Week || null,
        instanceName: ((row.InstanceName || '') + '').trim(),
      })
    }
    return { ok: true, displays: out }
  })

  // ── Room / device persistence ───────────────────────────────
  function inventoryStorePath() {
    return path.join(app.getPath('userData'), 'inventory.json')
  }
  ipcMain.handle('inv-store-load', () => {
    try {
      const p = inventoryStorePath()
      if (!fs.existsSync(p)) return { rooms: [], devices: {} }
      return JSON.parse(fs.readFileSync(p, 'utf-8'))
    } catch (e) {
      return { rooms: [], devices: {}, error: e.message }
    }
  })
  ipcMain.handle('inv-store-save', (_, data) => {
    try {
      const p = inventoryStorePath()
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  // ── Firmware resolvers ──────────────────────────────────────
  function httpJson(url, { method = 'GET', headers = {}, timeout = 10000 } = {}) {
    return new Promise((resolve) => {
      try {
        const u = new URL(url)
        const lib = u.protocol === 'https:' ? https : http
        const req = lib.request({
          method,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          headers,
          timeout,
        }, (res) => {
          const chunks = []
          res.on('data', c => chunks.push(c))
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8')
            try {
              resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: JSON.parse(body) })
            } catch {
              resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body })
            }
          })
        })
        req.on('error', (e) => resolve({ ok: false, error: e.message }))
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }) })
        req.end()
      } catch (e) {
        resolve({ ok: false, error: e.message })
      }
    })
  }

  // Logitech Sync API — haalt alle enrolled devices op, geindexeerd op SN.
  // Door main.js te doen vermijden we CORS en hoeft de bearer-token niet in de renderer.
  ipcMain.handle('inv-firmware-sync', async (_, { bearerToken, baseUrl }) => {
    const base = (baseUrl || 'https://api.sync.logitech.com').replace(/\/+$/, '')
    const r = await httpJson(`${base}/v1/devices`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      timeout: 10000,
    })
    if (!r.ok) return { ok: false, error: r.error || ('HTTP ' + r.status) }
    const devices = (r.body && r.body.devices) || []
    const index = {}
    for (const d of devices) {
      const sn = (d.serialNumber || '').trim()
      if (sn) index[sn] = d.firmwareVersion || null
    }
    return { ok: true, index, count: devices.length }
  })

  // CollabOS xAPI — lokale call per device (Rally Bar familie, RoomMate).
  ipcMain.handle('inv-firmware-xapi', async (_, { ip, username, password }) => {
    const auth = Buffer.from(`${username || 'admin'}:${password || ''}`).toString('base64')
    const r = await httpJson(`http://${ip}/xapi/v1/status/SystemUnit/Software/Version`, {
      headers: { Authorization: `Basic ${auth}` },
      timeout: 4000,
    })
    if (!r.ok) return { ok: false, error: r.error || ('HTTP ' + r.status) }
    const fw = (r.body && (r.body.value || r.body.Value)) || null
    return { ok: true, firmware: fw }
  })

  // ── CSV export ──────────────────────────────────────────────
  // Kolom-volgorde en -labels zoals gevraagd voor de inventarislijst
  // (exacte Nederlandse headers in het CSV-bestand).
  const CSV_HEADERS = [
    'stad', 'adres', 'ruimte_naam', 'sap_nummer', 'sap_sub_nummer',
    'artikel_nummer', 'artikel_omschrijving', 'ip_adres', 'mac_adres',
    'firmwareversie', 'serienummer', 'cmdb_nummer', 'opmerking',
    'stroom_groep', 'data_aansluiting',
    // aanvullende kolommen voor techneuten
    'kamernummer', 'type', 'model', 'manufacturer', 'vid', 'pid',
  ]
  const CSV_HEADER_LABELS = {
    stad: 'Stad', adres: 'Adres', ruimte_naam: 'Ruimte naam',
    sap_nummer: 'SAP nummer', sap_sub_nummer: 'SAP sub nummer',
    artikel_nummer: 'Artikel nummer', artikel_omschrijving: 'Artikel omschrijving',
    ip_adres: 'Ip adres', mac_adres: 'Mac adres',
    firmwareversie: 'Firmwareversie', serienummer: 'Serienummer',
    cmdb_nummer: 'CMDB nummer', opmerking: 'Opmerking',
    stroom_groep: 'Stroom groep', data_aansluiting: 'Data aansluiting',
    kamernummer: 'Kamernummer', type: 'Type', model: 'Model',
    manufacturer: 'Fabrikant', vid: 'USB VID', pid: 'USB PID',
  }
  function csvEscape(v) {
    if (v === null || v === undefined) return ''
    const s = String(v)
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
    return s
  }
  ipcMain.handle('inv-export-csv', async (_, { rows }) => {
    const res = await dialog.showSaveDialog({
      title: 'Exporteer inventaris',
      defaultPath: `inventarislijst-${new Date().toISOString().slice(0,10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (res.canceled || !res.filePath) return { ok: false, canceled: true }
    try {
      const headerLine = CSV_HEADERS.map(h => csvEscape(CSV_HEADER_LABELS[h] || h)).join(',')
      const lines = [headerLine]
      for (const row of rows || []) {
        lines.push(CSV_HEADERS.map(h => csvEscape(row[h])).join(','))
      }
      // BOM zodat Excel UTF-8 correct pakt, puntkomma niet nodig omdat Excel met
      // UTF-8 BOM + comma's gewoon meeleest
      fs.writeFileSync(res.filePath, '﻿' + lines.join('\r\n'), 'utf-8')
      return { ok: true, path: res.filePath, count: rows.length }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  // ── Open inventory window ───────────────────────────────────
  // Delegeert naar de module-level helper zodat 't menu Tools→Inventaris
  // en de (verwijderde) renderer-knop dezelfde window-instance hergebruiken.
  ipcMain.handle('inv-open', () => openInventoryWindow())

  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    // PTZ (pan/tilt/zoom) is een APARTE permission in Chromium — moet los toegestaan worden
    cb(['media', 'camera', 'microphone', 'audioCapture', 'videoCapture',
        'pan-tilt-zoom', 'camera-pan-tilt-zoom'].includes(permission))
  })
  session.defaultSession.setPermissionCheckHandler(() => true)

  win.loadFile('renderer.html')
  win.once('ready-to-show', () => { win.maximize(); win.show() })

  // Menu installeren met Kiosk Mode toggle
  Menu.setApplicationMenu(buildMenu(win))

  // IPC: renderer leest initial kiosk-state bij opstart
  ipcMain.handle('kiosk-get-state', () => readKioskState())
  ipcMain.handle('kiosk-set-state', (_, enabled) => {
    writeKioskState({ enabled: !!enabled })
    // Menu herbouwen zodat checkbox meeloopt
    Menu.setApplicationMenu(buildMenu(win))
    return true
  })
}

// Mute niet-essentiële Chromium log lines
app.commandLine.appendSwitch('log-level', '3')
// NB: NIET 'use-fake-ui-for-media-stream' gebruiken — die flag is voor automated testing
// en heeft een neveneffect dat Chromium na de eerste getUserMedia call bepaalde devices
// niet meer teruggeeft in enumerateDevices(). Permissies zijn hierboven al geregeld via
// session.setPermissionRequestHandler, dus de flag is niet nodig.
app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
