// Bridges media/panel.js and the Electron main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('catYoink', {
  send: (m) => ipcRenderer.send('panel', m),
});

// Main -> page: delivered as a normal window 'message' event, which panel.js listens for.
ipcRenderer.on('panel', (_e, m) => window.postMessage(m, '*'));
