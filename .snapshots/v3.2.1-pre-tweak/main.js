const { app, BrowserWindow, session, ipcMain, shell, dialog, screen } = require('electron')
const dgram = require('dgram')
const net   = require('net')

const path = require('path')
const { execFile, exec } = require('child_process')
const os   = require('os')
const fs   = require('fs')

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

  // ── Samples (TTS audio voor Speaker+Mic test) ──────────────
  function samplesDir() {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'samples')
      : path.join(__dirname, 'samples')
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

  // ── Externe monitor preview ────────────────────────────────────
  let previewWin = null

  ipcMain.handle('list-displays', () => {
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
  })

  ipcMain.handle('open-preview', (_, { displayId }) => {
    if (previewWin && !previewWin.isDestroyed()) { previewWin.close(); previewWin = null }

    const displays = screen.getAllDisplays()
    const primary  = screen.getPrimaryDisplay()
    let target = displays.find(d => d.id === displayId)
    if (!target) target = displays.find(d => d.id !== primary.id) || primary

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
    previewWin.loadFile('preview.html')
    previewWin.once('ready-to-show', () => previewWin.show())
    previewWin.on('closed', () => { previewWin = null })
    return { ok: true }
  })

  ipcMain.handle('close-preview', () => {
    if (previewWin && !previewWin.isDestroyed()) { previewWin.close(); previewWin = null }
    return { ok: true }
  })

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

  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    // PTZ (pan/tilt/zoom) is een APARTE permission in Chromium — moet los toegestaan worden
    cb(['media', 'camera', 'microphone', 'audioCapture', 'videoCapture',
        'pan-tilt-zoom', 'camera-pan-tilt-zoom'].includes(permission))
  })
  session.defaultSession.setPermissionCheckHandler(() => true)

  win.loadFile('renderer.html')
  win.once('ready-to-show', () => win.show())
}

// Mute niet-essentiële Chromium log lines
app.commandLine.appendSwitch('log-level', '3')
// NB: NIET 'use-fake-ui-for-media-stream' gebruiken — die flag is voor automated testing
// en heeft een neveneffect dat Chromium na de eerste getUserMedia call bepaalde devices
// niet meer teruggeeft in enumerateDevices(). Permissies zijn hierboven al geregeld via
// session.setPermissionRequestHandler, dus de flag is niet nodig.
app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
