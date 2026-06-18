/**
 * launchExecutor.js — Clean-spawn Minecraft process on macOS
 *
 * Provides buildCleanEnvironment() to scrub Electron/Node vars and
 * clear DYLD_LIBRARY_PATH / DYLD_FRAMEWORK_PATH on macOS.
 */

const child_process = require('child_process');
const fs = require('fs');

/**
 * Build a clean environment object for the Minecraft child process:
 *  - Clears DYLD_LIBRARY_PATH / DYLD_FRAMEWORK_PATH on macOS
 *  - Strips ELECTRON_ / NODE_ / CHROME_ / VSCODE_ env vars
 *  - Preserves HOME, PATH, LANG, TMPDIR
 */
function buildCleanEnvironment() {
  const env = { ...process.env };

  // macOS: clear dynamic loader paths that would inject Node's
  // rendering context into the JVM
  delete env.DYLD_LIBRARY_PATH;
  delete env.DYLD_FRAMEWORK_PATH;
  delete env.DYLD_FALLBACK_LIBRARY_PATH;
  delete env.DYLD_FALLBACK_FRAMEWORK_PATH;
  delete env.DYLD_INSERT_LIBRARIES;

  // macOS: clear DISPLAY so LWJGL never tries X11
  delete env.DISPLAY;

  // Strip Electron/Node/Chrome/VS Code vars
  for (const key of Object.keys(env)) {
    if (key.startsWith('ELECTRON_') ||
        key.startsWith('NODE_') ||
        key.startsWith('NPM_') ||
        key.startsWith('CHROME_') ||
        key.startsWith('VSCODE_')) {
      delete env[key];
    }
  }

  // macOS: ensure essential GUI vars survive
  if (process.platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = '';
    env.DYLD_FRAMEWORK_PATH = '';
  }

  return env;
}

/**
 * Spawn Minecraft with a clean environment.
 * Returns the child process.
 */
function spawnMinecraft(javaPath, launchArguments, cwd) {
  const env = buildCleanEnvironment();

  // Sanitize: remove empty strings from argument list
  const sanitizedArgs = launchArguments.filter(a => typeof a === 'string' && a.trim().length > 0);

  const child = child_process.spawn(javaPath, sanitizedArgs, {
    cwd: cwd,
    env: env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Log stdout/stderr
  if (child.stdout) {
    child.stdout.on('data', (data) => {
      console.log('[MC stdout]', data.toString('utf-8').trimEnd());
    });
  }
  if (child.stderr) {
    child.stderr.on('data', (data) => {
      console.error('[MC stderr]', data.toString('utf-8').trimEnd());
    });
  }

  child.on('error', (err) => {
    console.error('[LAUNCH ERROR]', err.message);
  });

  child.on('close', (code, signal) => {
    console.log(`[LAUNCH] Minecraft exited code=${code}${signal ? ` signal=${signal}` : ''}`);
  });

  return child;
}

module.exports = { buildCleanEnvironment, spawnMinecraft };
