// --- Electron Preload (crash-safe) ---
// Wrapping the entire preload in try-catch ensures that even if
// a require() fails or an API is unavailable (e.g. in packaged builds),
// the renderer still gets a safe fallback exposing leanAPI with null invoke,
// so the UI can degrade gracefully instead of silently breaking.

(function () {
  let contextBridge, ipcRenderer, clipboard, nativeImage, fs, path;
  let initialTheme = 'light';

  // --- Phase 1: load dependencies (each wrapped individually) ---
  try {
    const electron = require('electron');
    contextBridge = electron.contextBridge;
    ipcRenderer = electron.ipcRenderer;
    clipboard = electron.clipboard;
    nativeImage = electron.nativeImage;
  } catch (e) {
    console.error('[lean-preload] Failed to load electron modules:', e);
  }

  try { fs = require('fs'); } catch (e) { console.error('[lean-preload] Failed to load fs:', e); }
  try { path = require('path'); } catch (e) { console.error('[lean-preload] Failed to load path:', e); }

  // --- Phase 2: initial theme (best-effort, never fails) ---
  try {
    const appRootArg = process.argv && process.argv.find(a => a.startsWith('--app-root='));
    const appRoot = appRootArg ? appRootArg.slice('--app-root='.length) : (path ? path.join(__dirname) : __dirname);
    const settingsPath = path ? path.join(appRoot, 'settings.json') : null;
    if (settingsPath && fs && fs.existsSync && fs.existsSync(settingsPath)) {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      initialTheme = (s._global && s._global.theme) || 'light';
    }
  } catch (e) { /* ignore — theme will default to 'light' */ }

  // --- Phase 3: expose API (partial exposure if modules failed) ---
  const api = { initialTheme, platform: process.platform };

  if (ipcRenderer) {
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

    api.invoke = function (channel, ...args) {
      if (!ALLOWED_INVOKES.has(channel)) {
        throw new Error('IPC invoke blocked: "' + channel + '" is not in the allowed list.');
      }
      return ipcRenderer.invoke(channel, ...args);
    };

    api.on = function (channel, callback) {
      if (!ALLOWED_EVENTS.has(channel)) {
        throw new Error('IPC event blocked: "' + channel + '" is not in the allowed list.');
      }
      ipcRenderer.on(channel, function (_event, ...args) { callback(_event, ...args); });
    };

    api.send = function (channel, ...args) {
      if (channel !== 'restart-and-install') {
        throw new Error('IPC send blocked: "' + channel + '" is not in the allowed list.');
      }
      ipcRenderer.send(channel, ...args);
    };

    api.removeAllListeners = function (channel) {
      if (!ALLOWED_EVENTS.has(channel)) return;
      ipcRenderer.removeAllListeners(channel);
    };
  }

  if (clipboard && nativeImage) {
    api.copyImageFromPath = function (filePath) {
      try {
        var img = nativeImage.createFromPath(filePath);
        clipboard.writeImage(img);
        return true;
      } catch (e) {
        return false;
      }
    };
  }

  // --- Phase 4: expose to renderer ---
  try {
    if (contextBridge && contextBridge.exposeInMainWorld) {
      contextBridge.exposeInMainWorld('leanAPI', api);
    } else {
      window.leanAPI = api;
    }
  } catch (e) {
    // Ultimate fallback — if even contextBridge fails, set on window directly
    try { window.leanAPI = api; } catch (e2) { /* unreachable */ }
  }
})();
