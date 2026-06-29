const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, shell, dialog, nativeImage } = require('electron');

// --- App identity (fixes Dock name, keychain label, and menu bar name on macOS) ---
// Must be called BEFORE any require('./index.js') so both files see the same userData path
app.setName('Lean Launcher');

// Force macOS to pick up the custom app icon even in dev mode.
// In production the .icns in the bundle handles the Dock icon automatically,
// so this hook is a no-op there (but harmless).
app.on('ready', () => {
  if (process.platform !== 'darwin') return;
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, 'icon.png');
  if (fs.existsSync(iconPath)) {
    const dockIcon = nativeImage.createFromPath(iconPath);
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
  }
});

const { autoUpdater } = require('electron-updater');
const { loginAccount, getAuthAccounts, setActiveAuthAccount, removeAuthAccount } = require('./index.js');

// --- GPU acceleration (safe flags — no stutter, no frame pacing issues) ---
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
// enable-zero-copy removed: causes bubble/canvas clipping and backdrop-filter
// rendering artifacts on macOS and some Windows configurations.

let mainWindow = null;

const appRoot = app.isPackaged ? app.getPath('userData') : __dirname;

// Pass app root to preload via additionalArguments (more reliable
// than env vars on macOS for child process inheritance)
const appRootArg = `--app-root=${appRoot}`;

function copyDirectoryContentsRecursive(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return 0;
  fs.mkdirSync(targetDir, { recursive: true });

  let copied = 0;
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copied += copyDirectoryContentsRecursive(sourcePath, targetPath);
      continue;
    }

    if (!entry.isFile()) continue;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    copied += 1;
  }

  return copied;
}

function createWindow() {
  // icon.png is bundled via extraResources to Resources/icon.png in packaged builds,
  // and lives alongside the source in dev mode.
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, 'icon.png');
  const iconNative = nativeImage.createFromPath(iconPath);

  // Set Dock icon on macOS
  if (process.platform === 'darwin' && !iconNative.isEmpty()) {
    try {
      app.dock.setIcon(iconNative);
    } catch { /* ignore if dock not available (e.g. headless) */ }
  }

  const win = new BrowserWindow({
    width: 950, height: 700,
    minWidth: 720, minHeight: 500,
    frame: false,
    icon: iconNative.isEmpty() ? iconPath : iconNative,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
      additionalArguments: [appRootArg],
      preload: path.join(__dirname, 'preload.js')
    },
  });
  // Register console-message listener BEFORE loadFile to capture preload logs
  if (!app.isPackaged || process.env.LEAN_LAUNCHER_DEBUG) {
    try {
      win.webContents.on('console-message', (event) => {
        const levelNames = ['V','I','W','E'];
        const prefix = (event.level != null && event.level < levelNames.length) ? levelNames[event.level] : '?';
        const src = event.sourceId ? ` [${event.sourceId}:${event.lineNumber}]` : '';
        console.log(`[renderer ${prefix}]${src} ${event.message}`);
      });
    } catch(e) {
      // Fallback to deprecated signature for older Electron
      win.webContents.on('console-message', (event, level, message) => {
        const prefix = ['V','I','W','E'][Math.min(level, 3)];
        console.log(`[renderer ${prefix}] ${message}`);
      });
    }
  }
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  mainWindow = win;
  return win;
}

function showOrCreateMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return createWindow();
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return mainWindow;
}

ipcMain.handle('login-account', async () => {
  try { return { success: true, result: await loginAccount() }; }
  catch (error) {
    const msg = typeof error?.message === 'string' ? error.message
              : typeof error?.ts === 'string' ? error.ts
              : typeof error === 'string' ? error
              : String(error);
    return { success: false, error: msg, cancelled: Boolean(error?.cancelled) };
  }
});

ipcMain.handle('launch-game', async (event, payload) => {
  const { startLeanClient, getGlobalSettings } = require('./index.js');
  const senderWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const closeOnBoot = Boolean(getGlobalSettings()?.closeOnBoot);

  try { 
    const result = await startLeanClient(payload, (msg, prog) => {
          if (!senderWindow || senderWindow.isDestroyed()) return;
          event.sender.send('launch-update', { msg, prog });
      }, (launchEvent) => {
          if (!launchEvent || typeof launchEvent !== 'object') return;

          if (launchEvent.type === 'booted') {
            if (closeOnBoot && senderWindow && !senderWindow.isDestroyed()) {
              senderWindow.hide();
            }
            return;
          }

          if (launchEvent.type === 'launch-failed') {
            // MCLC-level failure (Java not found, timeout, etc.) — tell the UI immediately
            const visibleWindow = showOrCreateMainWindow();
            if (visibleWindow && !visibleWindow.isDestroyed()) {
              visibleWindow.webContents.send('launch-failed', {
                reason: launchEvent.reason || 'unknown',
                message: launchEvent.message || 'Minecraft failed to launch.'
              });
            }
            return;
          }

          if (launchEvent.type === 'game-exit') {
            if (closeOnBoot) showOrCreateMainWindow();
            // Notify the UI that the game exited
            if (senderWindow && !senderWindow.isDestroyed()) {
              event.sender.send('launch-failed', {
                reason: launchEvent.crashed ? 'crash' : 'exit',
                message: launchEvent.crashed
                  ? `Minecraft exited unexpectedly (code ${launchEvent.code || 'unknown'}).`
                  : 'Minecraft exited.'
              });
            }
            return;
          }

          if (launchEvent.type === 'crash') {
            const visibleWindow = showOrCreateMainWindow();
            if (visibleWindow && !visibleWindow.isDestroyed()) {
              visibleWindow.webContents.send('launch-crash-report', launchEvent.report || {});
            }
          }
      });
      return { success: true, result }; 
  }
  catch (error) {
    // Launch threw synchronously (e.g., Java validation failed, auth refresh failed)
    // Use a robust chain: .message string → .ts string (msmc error code) → JSON → String
    const msg = typeof error?.message === 'string' ? error.message
              : typeof error?.ts === 'string' ? error.ts
              : typeof error === 'string' ? error
              : String(error);
    if (senderWindow && !senderWindow.isDestroyed()) {
      event.sender.send('launch-failed', { reason: 'error', message: msg });
    }
    return { success: false, error: msg };
  }
});

ipcMain.handle('cancel-launch', () => {
  const { cancelLaunchProcess } = require('./index.js');
  if (cancelLaunchProcess) cancelLaunchProcess();
  return { success: true };
});

ipcMain.handle('get-global-settings', () => require('./index.js').getGlobalSettings());
ipcMain.handle('save-global-settings', (_, glob) => require('./index.js').saveGlobalSettings(glob));

ipcMain.handle('get-auth-accounts', () => getAuthAccounts());

ipcMain.handle('get-settings', (_, version) => require('./index.js').getInstanceSettings(version));
ipcMain.handle('save-settings', (_, { version, settings }) => {
    const { loadSettings, saveSettings } = require('./index.js');
    const all = loadSettings();
    all[version] = settings;
    saveSettings(all);
    return { success: true };
});

ipcMain.handle('get-all-settings', () => require('./index.js').loadSettings());

ipcMain.handle('get-system-memory', () => {
  const totalBytes = os.totalmem();
  return { totalMb: Math.round(totalBytes / (1024 * 1024)) };
});

ipcMain.handle('validate-java-path', (_, javaPath) => {
  if (!javaPath || typeof javaPath !== 'string') return { valid: false, error: 'No path provided.' };
  if (!fs.existsSync(javaPath))
    return { valid: false, error: `Java executable not found at:\n${javaPath}` };
  return { valid: true };
});

function validateVersionName(version) {
  if (!version || typeof version !== 'string') return false;
  // Reject path traversal attempts and invalid characters
  if (version.includes('..') || version.includes('/') || version.includes('\\')) return false;
  if (version.length === 0 || version.length > 64) return false;
  return true;
}

ipcMain.handle('open-instance-folder', async (_, version) => {
  if (!validateVersionName(version)) return { success: false, error: 'Invalid version name' };
  const instancePath = path.join(appRoot, 'minecraft', 'instances', version);
  if (!fs.existsSync(instancePath)) fs.mkdirSync(instancePath, { recursive: true });
  await shell.openPath(instancePath);
  return { success: true };
});

ipcMain.handle('delete-custom-version', (_, version) => {
  if (!validateVersionName(version)) return { success: false, error: 'Invalid version name' };
  const { loadSettings, saveSettings } = require('./index.js');
  const all = loadSettings();
  delete all[version];
  saveSettings(all);

  const instancePath = path.join(appRoot, 'minecraft', 'instances', version);
  if (fs.existsSync(instancePath)) {
    fs.rmSync(instancePath, { recursive: true, force: true });
  }
  return { success: true };
});

ipcMain.handle('rename-custom-version', (_, { oldVersion, newVersion }) => {
  if (!validateVersionName(oldVersion) || !validateVersionName(newVersion)) return { success: false, error: 'Invalid version names' };
  if (oldVersion === newVersion) return { success: true };

  const { loadSettings, saveSettings } = require('./index.js');
  const all = loadSettings();

  if (!all[oldVersion]) return { success: false, error: 'Source version not found' };
  if (all[newVersion]) return { success: false, error: 'Target version already exists' };

  all[newVersion] = all[oldVersion];
  delete all[oldVersion];
  saveSettings(all);

  const oldInstancePath = path.join(appRoot, 'minecraft', 'instances', oldVersion);
  const newInstancePath = path.join(appRoot, 'minecraft', 'instances', newVersion);

  if (fs.existsSync(oldInstancePath) && !fs.existsSync(newInstancePath)) {
    fs.renameSync(oldInstancePath, newInstancePath);
  }

  return { success: true };
});

ipcMain.handle('list-instance-directory', (_, { version, relPath }) => {
  if (!validateVersionName(version)) return [];
  const basePath = path.resolve(appRoot, 'minecraft', 'instances', version);
  const targetPath = path.resolve(basePath, relPath || '.');

  if (!targetPath.startsWith(basePath)) return [];
  if (!fs.existsSync(targetPath)) return [];

  const dirents = fs.readdirSync(targetPath, { withFileTypes: true });
  return dirents
    .map(d => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      relPath: path.join(relPath || '', d.name).replace(/\\/g, '/'),
      size: d.isDirectory() ? null : fs.statSync(path.join(targetPath, d.name)).size,
      childCount: d.isDirectory() ? fs.readdirSync(path.join(targetPath, d.name)).length : null
    }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
});

ipcMain.handle('read-instance-file', (_, { version, relPath }) => {
  if (!validateVersionName(version)) return { success: false, error: 'Invalid version name' };
  const basePath = path.resolve(appRoot, 'minecraft', 'instances', version);
  const targetPath = path.resolve(basePath, relPath || '.');

  if (!targetPath.startsWith(basePath)) return { success: false, error: 'Invalid path' };
  if (!fs.existsSync(targetPath)) return { success: false, error: 'File not found' };

  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) return { success: false, error: 'Path is a directory' };

  const content = fs.readFileSync(targetPath, 'utf-8');
  return { success: true, content };
});

ipcMain.handle('write-instance-file', (_, { version, relPath, content }) => {
  if (!validateVersionName(version)) return { success: false, error: 'Invalid version name' };
  const basePath = path.resolve(appRoot, 'minecraft', 'instances', version);
  const targetPath = path.resolve(basePath, relPath || '.');

  if (!targetPath.startsWith(basePath)) return { success: false, error: 'Invalid path' };
  if (!fs.existsSync(targetPath)) return { success: false, error: 'File not found' };

  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) return { success: false, error: 'Path is a directory' };

  fs.writeFileSync(targetPath, String(content ?? ''), 'utf-8');
  return { success: true };
});

ipcMain.handle('upload-instance-files', async (_, { version, relPath }) => {
  if (!validateVersionName(version)) return { success: false, error: 'Invalid version name' };
  const basePath = path.resolve(appRoot, 'minecraft', 'instances', version);
  const targetPath = path.resolve(basePath, relPath || '.');

  if (!targetPath.startsWith(basePath)) return { success: false, error: 'Invalid path' };
  if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });

  const result = await dialog.showOpenDialog({
    title: 'Upload folder',
    defaultPath: targetPath,
    properties: ['openDirectory', 'multiSelections']
  });

  if (result.canceled || !result.filePaths?.length) return { success: true, canceled: true };

  let copied = 0;
  for (const sourcePath of result.filePaths) {
    if (!fs.existsSync(sourcePath)) continue;
    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      copied += copyDirectoryContentsRecursive(sourcePath, targetPath);
      continue;
    }
    if (!stat.isFile()) continue;
    const fileName = path.basename(sourcePath);
    const destinationPath = path.join(targetPath, fileName);
    fs.copyFileSync(sourcePath, destinationPath);
    copied += 1;
  }

  return { success: true, count: copied };
});

ipcMain.handle('copy-files-into-instance-folder', (_, { version, relPath, sourcePaths }) => {
  if (!validateVersionName(version)) return { success: false, error: 'Invalid version name' };
  const basePath = path.resolve(appRoot, 'minecraft', 'instances', version);
  const targetPath = path.resolve(basePath, relPath || '.');

  if (!targetPath.startsWith(basePath)) return { success: false, error: 'Invalid path' };
  if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });

  const files = Array.isArray(sourcePaths) ? sourcePaths.filter(Boolean) : [];
  if (!files.length) return { success: false, error: 'No files provided' };

  let copied = 0;
  for (const sourcePath of files) {
    if (!fs.existsSync(sourcePath)) continue;
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) continue;

    const fileName = path.basename(sourcePath);
    const destinationPath = path.join(targetPath, fileName);
    fs.copyFileSync(sourcePath, destinationPath);
    copied++;
  }

  return { success: true, count: copied };
});

ipcMain.handle('window-minimize', () => BrowserWindow.getFocusedWindow()?.minimize());
ipcMain.handle('window-maximize-toggle', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
  return win.isMaximized();
});
ipcMain.handle('window-close', () => BrowserWindow.getFocusedWindow()?.close());

ipcMain.handle('check-session', () => {
  const session = require('./index.js').checkSession();
  if (session) return { success: true, result: session };
  return { success: false };
});

// --- Screenshot Manager ---

ipcMain.handle('list-screenshots', (_, version) => {
  if (!validateVersionName(version)) return [];
  const screenshotsDir = path.join(appRoot, 'minecraft', 'instances', version, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) return [];
  const entries = fs.readdirSync(screenshotsDir, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && /\.(png|jpg|jpeg)$/i.test(e.name))
    .map(e => {
      const filePath = path.join(screenshotsDir, e.name);
      const stat = fs.statSync(filePath);
      return { name: e.name, path: filePath, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
});

ipcMain.handle('delete-screenshot', (_, filePath) => {
  if (!filePath || typeof filePath !== 'string') return { success: false, error: 'Invalid path' };
  if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };
  fs.unlinkSync(filePath);
  return { success: true };
});

ipcMain.handle('open-screenshot', async (_, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return { success: false };
  await shell.openPath(filePath);
  return { success: true };
});

ipcMain.handle('open-screenshots-folder', async (_, version) => {
  if (!validateVersionName(version)) return { success: false, error: 'Invalid version name' };
  const screenshotsDir = path.join(appRoot, 'minecraft', 'instances', version, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
  await shell.openPath(screenshotsDir);
  return { success: true };
});

ipcMain.handle('activate-auth-account', (_, accountId) => {
  try { return { success: true, result: setActiveAuthAccount(accountId) }; }
  catch (error) { return { success: false, error: error?.message || String(error) }; }
});

ipcMain.handle('remove-auth-account', (_, accountId) => {
  try { return { success: true, result: removeAuthAccount(accountId) }; }
  catch (error) { return { success: false, error: error?.message || String(error) }; }
});

ipcMain.handle('login-offline', async (_, username) => {
  try { return { success: true, result: await require('./index.js').loginOffline(username) }; }
  catch (error) { return { success: false, error: error?.message }; }
});

ipcMain.handle('read-changelog', () => {
  const changelogPath = path.join(__dirname, 'changelog.json');
  if (!fs.existsSync(changelogPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(changelogPath, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
});

// --- Auto Updater ---

function setupAutoUpdater(win) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;

  const isDev = process.env.NODE_ENV === 'development';

  autoUpdater.on('checking-for-update', () => {
    if (isDev) console.log('[Updater] Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    if (isDev) console.log('[Updater] Update available:', info.version);
    win.webContents.send('update-available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes || ''
    });
    autoUpdater.downloadUpdate();
  });

  autoUpdater.on('update-not-available', () => {
    if (isDev) console.log('[Updater] No updates available.');
  });

  autoUpdater.on('download-progress', (progress) => {
    win.webContents.send('download-progress', {
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (isDev) console.log('[Updater] Update downloaded:', info.version);
    win.webContents.send('update-downloaded', {
      version: info.version,
      releaseNotes: info.releaseNotes || ''
    });
  });

  autoUpdater.on('error', (error) => {
    console.error('[Updater] Error:', error.message);
    win.webContents.send('update-error', { message: error.message });
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[Updater] Check failed:', err.message);
  });
}

ipcMain.on('restart-and-install', () => {
  autoUpdater.quitAndInstall(false, true);
});

app.whenReady().then(() => {
  const win = createWindow();

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

  if (!process.env.NODE_ENV || process.env.NODE_ENV === 'production') {
    setupAutoUpdater(win);
  } else {
    console.log('[Updater] Skipping auto-update in dev mode.');
  }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});