const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('micpro', {
  platform: process.platform,
  version: () => ipcRenderer.invoke('app:version'),
  setHotkeys: (map) => ipcRenderer.invoke('hotkeys:set', map),
  onHotkey: (fn) => {
    const handler = (_e, action) => fn(action);
    ipcRenderer.on('hotkey', handler);
    return () => ipcRenderer.removeListener('hotkey', handler);
  },
  setCloseToTray: (v) => ipcRenderer.invoke('app:close-to-tray', v),
  saveFile: (data, defaultName, filters) => ipcRenderer.invoke('file:save', { data, defaultName, filters }),
  openPresetFile: () => ipcRenderer.invoke('file:open-json'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
});
