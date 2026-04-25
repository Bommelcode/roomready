const { contextBridge, ipcRenderer } = require('electron')

let _webUtils = null
try { _webUtils = require('electron').webUtils } catch(e) {}

contextBridge.exposeInMainWorld('rrBridge', {
  openExternal:       (url)         => ipcRenderer.invoke('open-external', url),
  applyUpdate:        (zipPath)     => ipcRenderer.invoke('apply-update', zipPath),
  openCameraSettings: ()            => ipcRenderer.invoke('open-camera-settings'),
  viscaUdp:           (ip,port,cmd) => ipcRenderer.invoke('visca-udp', ip, port, cmd),
  viscaTcp:           (ip,port,cmd) => ipcRenderer.invoke('visca-tcp', ip, port, cmd),
  listDisplays:       ()            => ipcRenderer.invoke('list-displays'),
  openPreview:        (opts)        => ipcRenderer.invoke('open-preview', opts),
  closePreview:       ()            => ipcRenderer.invoke('close-preview'),
  listSamples:        ()            => ipcRenderer.invoke('list-samples'),
  readSample:         (filename)    => ipcRenderer.invoke('read-sample', filename),
  readQuotesJson:     ()            => ipcRenderer.invoke('read-quotes-json'),
  kioskGetState:      ()            => ipcRenderer.invoke('kiosk-get-state'),
  kioskSetState:      (enabled)     => ipcRenderer.invoke('kiosk-set-state', enabled),
  onKioskToggled:     (cb) => {
    const fn = (_evt, enabled) => cb(enabled)
    ipcRenderer.on('kiosk-toggled', fn)
    return () => ipcRenderer.removeListener('kiosk-toggled', fn)
  },
  getFilePath: (file) => {
    try { if (_webUtils?.getPathForFile) return _webUtils.getPathForFile(file) } catch(e) {}
    try { if (file?.path) return file.path } catch(e) {}
    return null
  }
})
