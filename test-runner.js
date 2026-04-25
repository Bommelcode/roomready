const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const win = new BrowserWindow({ 
    width: 1280, height: 820, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: __dirname + '/preload.js' }
  })
  const errors = []
  win.webContents.on('console-message', (_, level, msg) => {
    const lvl = ['log','warn','error'][level]
    if (lvl === 'error' || lvl === 'warn') {
      errors.push('[' + lvl + '] ' + msg.slice(0, 400))
    }
  })
  win.webContents.on('render-process-gone', (e, d) => {
    console.log('CRASH:', d.reason, d.exitCode)
    process.exit(1)
  })
  win.loadFile('renderer.html')
  setTimeout(() => {
    console.log('=== ERRORS (' + errors.length + ') ===')
    errors.forEach(e => console.log(e))
    app.quit()
  }, 5000)
})
