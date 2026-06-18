/**
 * nativesManager.js — Flat native library extraction for Minecraft
 *
 * Goal: Extract .dylib/.dll/.so from each version's native classifier JARs
 * into a flat directory (no subdirectories) and return that path for
 * -Djava.library.path.
 *
 * For modern versions (≥1.19) Minecraft bundles its own native loading
 * via LWJGL's SharedLibraryExtractPath, so this module is primarily
 * used for pre-1.19 versions where MCLC's built-in extraction may not
 * handle ARM64 macOS correctly.
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function isNativeLib(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return ext === '.dylib' || ext === '.dll' || ext === '.so' || ext === '.jnilib';
}

function getNativesFolderName(mcVersion, options = {}) {
  const parts = mcVersion.split('.');
  const major = parseInt(parts[1], 10);
  if (options.isMacArm64 && major >= 19) {
    return `${mcVersion}-arm64`;
  }
  return mcVersion;
}

function getNativesPath(mcRoot, mcVersion, options = {}) {
  const folder = getNativesFolderName(mcVersion, options);
  return path.resolve(mcRoot, 'natives', folder);
}

/**
 * Pre-extract native libraries from the version JSON's classifiers.
 * Downloads JARs if needed, extracts flat, cleans subdirectories.
 */
async function ensureNatives(mcRoot, mcVersion, versionJson, options = {}) {
  const nativesPath = getNativesPath(mcRoot, mcVersion, options);
  const parts = mcVersion.split('.');
  const minor = parseInt(parts[1], 10);

  // Modern versions handle natives internally
  if (minor >= 19) {
    ensureDir(nativesPath);
    return nativesPath;
  }

  // Already extracted?
  if (fs.existsSync(nativesPath)) {
    const files = fs.readdirSync(nativesPath).filter(f => {
      const full = path.join(nativesPath, f);
      return fs.statSync(full).isFile() && isNativeLib(f);
    });
    if (files.length > 0) return nativesPath;
  }

  if (options.onProgress) options.onProgress('Extracting native libraries...', 34);
  try { fs.rmSync(nativesPath, { recursive: true, force: true }); } catch {}
  ensureDir(nativesPath);

  const librariesDir = path.join(mcRoot, 'libraries');
  const libs = versionJson.libraries || [];

  for (const lib of libs) {
    if (!lib.downloads || !lib.downloads.classifiers) continue;
    const cl = lib.downloads.classifiers;
    let nativeEntry = null;

    const isOsx = process.platform === 'darwin';
    if (isOsx) {
      if (options.isMacArm64) {
        nativeEntry = cl['natives-macos-arm64'] || cl['natives-osx-arm64'] || cl['natives-macos'] || cl['natives-osx'];
      } else {
        nativeEntry = cl['natives-macos'] || cl['natives-osx'];
      }
    } else if (process.platform === 'win32') {
      nativeEntry = cl['natives-windows'];
    } else {
      nativeEntry = cl['natives-linux'];
    }
    if (!nativeEntry) continue;

    const jarName = nativeEntry.path.split('/').pop();
    const jarDir = path.join(librariesDir, nativeEntry.path.split('/').slice(0, -1).join('/'));
    const jarPath = path.join(jarDir, jarName);
    if (!fs.existsSync(jarPath)) continue;

    try {
      const zip = new AdmZip(jarPath);
      const entries = zip.getEntries();
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        if (!isNativeLib(entry.entryName)) continue;
        const flatName = path.basename(entry.entryName);
        const dest = path.join(nativesPath, flatName);
        if (fs.existsSync(dest)) continue;
        zip.extractEntryTo(entry, nativesPath, false, true);
        // Flatten if entry has subdirs
        const extracted = path.join(nativesPath, entry.entryName);
        if (extracted !== dest && fs.existsSync(extracted)) {
          fs.renameSync(extracted, dest);
        }
      }
    } catch (err) {
      console.warn(`[NATIVES] Failed to extract ${jarName}: ${err.message}`);
    }
  }

  // Clean subdirectories
  try {
    const entries = fs.readdirSync(nativesPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subFiles = fs.readdirSync(path.join(nativesPath, entry.name));
        for (const f of subFiles) {
          const src = path.join(nativesPath, entry.name, f);
          const dst = path.join(nativesPath, f);
          if (!fs.existsSync(dst)) {
            fs.renameSync(src, dst);
          }
        }
        try { fs.rmSync(path.join(nativesPath, entry.name), { recursive: true, force: true }); } catch {}
      }
    }
  } catch {}

  const finalCount = fs.readdirSync(nativesPath).filter(f => isNativeLib(f)).length;
  if (options.onProgress) options.onProgress(`Native libraries ready (${finalCount} files)`, 36);
  return nativesPath;
}

module.exports = { getNativesPath, getNativesFolderName, ensureNatives, isNativeLib };
