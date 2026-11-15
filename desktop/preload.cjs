/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yzgtDesktop', {
  configure: values => ipcRenderer.invoke('desktop:configure', values),
  check: () => ipcRenderer.invoke('desktop:check'),
  start: () => ipcRenderer.invoke('desktop:start'),
});
