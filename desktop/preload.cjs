const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apixDesktop', {
  onWorkerRequest: callback => {
    ipcRenderer.on('apix:worker-request', (_event, target) => callback(target));
  },
});
