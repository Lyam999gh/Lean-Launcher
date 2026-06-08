const { contextBridge, ipcRenderer, clipboard, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

// --- Read initial theme before page render (avoids flash) ---
let initialTheme = 'light';
try {
  const settingsPath = path.join(__dirname, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    initialTheme = (s._global && s._global.theme) || 'light';
  }
} catch {};

// --- Whitelist of allowed IPC channels ---
const ALLOWED_INVOKES = new Set([
  'get-global-settings', 'save-global-settings',
  'get-settings', 'save-settings', 'get-all-settings',
  'get-system-memory', 'check-session',
  'get-auth-accounts', 'activate-auth-account', 'remove-auth-account',
  'login-account', 'login-offline',
  'launch-game', 'cancel-launch',
  'window-minimize', 'window-maximize-toggle', 'window-close',
  'read-changelog',
  'list-instance-directory', 'read-instance-file', 'write-instance-file',
  'upload-instance-files', 'copy-files-into-instance-folder',
  'open-instance-folder', 'delete-custom-version', 'rename-custom-version',
  'validate-java-path',
  'list-screenshots', 'delete-screenshot', 'open-screenshot', 'open-screenshots-folder'
]);

const ALLOWED_EVENTS = new Set([
  'auth-device-code', 'launch-update', 'launch-crash-report',
  'update-available', 'download-progress', 'update-downloaded', 'update-error'
]);

// --- Expose a safe, minimal API to the renderer ---
contextBridge.exposeInMainWorld('leanAPI', {
  // Initial theme (read synchronously before page render)
  initialTheme,

  // Current OS platform for CSS targeting
  platform: process.platform,

  // IPC invoke (request → response)
  invoke(channel, ...args) {
    if (!ALLOWED_INVOKES.has(channel)) {
      throw new Error(`IPC invoke blocked: "${channel}" is not in the allowed list.`);
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  // IPC event listener (main → renderer)
  on(channel, callback) {
    if (!ALLOWED_EVENTS.has(channel)) {
      throw new Error(`IPC event blocked: "${channel}" is not in the allowed list.`);
    }
    ipcRenderer.on(channel, (_event, ...args) => callback(_event, ...args));
  },

  // IPC send (fire-and-forget, renderer → main)
  send(channel, ...args) {
    if (channel !== 'restart-and-install') {
      throw new Error(`IPC send blocked: "${channel}" is not in the allowed list.`);
    }
    ipcRenderer.send(channel, ...args);
  },

  // Remove all listeners for a specific channel
  removeAllListeners(channel) {
    if (!ALLOWED_EVENTS.has(channel)) return;
    ipcRenderer.removeAllListeners(channel);
  },

  // Clipboard — copy image to clipboard
  copyImageFromPath(filePath) {
    try {
      const img = nativeImage.createFromPath(filePath);
      clipboard.writeImage(img);
      return true;
    } catch {
      return false;
    }
  }
});
