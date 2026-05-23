const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updateAPI', {
  onUpdateAvailable(callback) {
    ipcRenderer.on('update-available', (_event, info) => callback(info));
  },
  onDownloadProgress(callback) {
    ipcRenderer.on('download-progress', (_event, progress) => callback(progress));
  },
  onUpdateDownloaded(callback) {
    ipcRenderer.on('update-downloaded', (_event, info) => callback(info));
  },
  onUpdateError(callback) {
    ipcRenderer.on('update-error', (_event, error) => callback(error));
  },
  restartAndInstall() {
    ipcRenderer.send('restart-and-install');
  },
  removeUpdateListeners() {
    ipcRenderer.removeAllListeners('update-available');
    ipcRenderer.removeAllListeners('download-progress');
    ipcRenderer.removeAllListeners('update-downloaded');
    ipcRenderer.removeAllListeners('update-error');
  }
});
