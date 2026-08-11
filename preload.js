const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  getInfo: () => ipcRenderer.invoke('get-info'),
  getSources: () => ipcRenderer.invoke('get-sources'),
  getPeers: () => ipcRenderer.invoke('get-peers'),
  getDisplayInfo: () => ipcRenderer.invoke('get-display-info'),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  toggleFullscreen: (desired) => ipcRenderer.invoke('toggle-fullscreen', desired),
  setStreaming: (on) => ipcRenderer.invoke('set-streaming', on),
  virtualDisplay: (opts) => ipcRenderer.invoke('virtual-display', opts),
  onVirtualDisplayChanged: (cb) => ipcRenderer.on('virtual-display-changed', (_e, active) => cb(active)),
  onPeersChanged: (cb) => ipcRenderer.on('peers-changed', (_e, peers) => cb(peers)),
  onSenderDiscovered: (cb) => ipcRenderer.on('sender-discovered', (_e, info) => cb(info)),
});
