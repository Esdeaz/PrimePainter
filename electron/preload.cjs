const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('primeDesktop', Object.freeze({
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  setDirty: value => ipcRenderer.send('project:dirty', value),
  openFile: kind => ipcRenderer.invoke('file:open', kind),
  saveFile: (filename, data) => ipcRenderer.invoke('file:save', filename, data),
}));
