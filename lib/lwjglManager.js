/**
 * lwjglManager.js — LWJGL ARM64 compatibility shim for legacy Minecraft
 * =====================================================================
 *
 * Problem: LWJGL 3.2.1 (shipped with Minecraft 1.13 – 1.18.2) does not
 * contain native libraries for Apple Silicon (arm64). On macOS ARM64,
 * the JVM throws:
 *   java.lang.UnsatisfiedLinkError: Failed to locate library: liblwjgl.dylib
 *
 * Solution: Automatically swap in LWJGL 3.3.3 (or newer) which ships
 * official arm64 native binaries. We do this by:
 *   1. Checking if the fix is needed (macOS arm64 + version 1.13–1.18.2).
 *   2. Downloading LWJGL 3.3.3 JARs and native libraries.
 *   3. Generating a patched version JSON that replaces the old LWJGL
 *      library entries with the new ones.
 *   4. Pointing MCLC at the patched version JSON via overrides.versionJson.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ---------------------------------------------------------------------------
// LWJGL version to use for the swap
// ---------------------------------------------------------------------------
// LWJGL 3.3.3 is the first version with full Apple Silicon (arm64) support.
// The Maven artifact coordinates are:
//   org.lwjgl:lwjgl:3.3.3
//   org.lwjgl:lwjgl-glfw:3.3.3  (etc.)
// Native classifier for macOS arm64: "natives-macos-arm64"
const LWJGL_VERSION = '3.3.3';
const LWJGL_MAVEN_BASE = 'https://repo1.maven.org/maven2/org/lwjgl';

// LWJGL modules needed by Minecraft
const LWJGL_MODULES = [
    'lwjgl',
    'lwjgl-glfw',
    'lwjgl-opengl',
    'lwjgl-openal',
    'lwjgl-stb',
    'lwjgl-tinyfd',
];

const NATIVE_CLASSIFIER = 'natives-macos-arm64';
const NATIVE_CLASSIFIER_GENERIC = 'natives-macos';

// ---------------------------------------------------------------------------
// Affected version range
// ---------------------------------------------------------------------------

/**
 * Check if the given Minecraft version needs the LWJGL ARM64 swap.
 * @param {string} mcVersion - e.g. "1.18.2", "1.16.5"
 * @returns {boolean}
 */
function needsLwjglSwap(mcVersion) {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return false;

    const parts = mcVersion.split('.').map(Number);
    if (parts.length < 2) return false;

    const major = parts[0];  // 1
    const minor = parts[1];  // 18, 17, etc.
    const patch = parts[2] || 0;

    // Minecraft 1.13 – 1.18.2 used LWJGL 3.2.x which lacks arm64 natives
    if (major !== 1) return false;
    if (minor < 13) return false;   // Pre-1.13 uses LWJGL 2
    if (minor > 18) return false;   // 1.19+ uses LWJGL 3.3.1+ which has arm64
    if (minor === 18 && patch > 2) return false; // 1.18.2 is the last affected

    return true;
}

// ---------------------------------------------------------------------------
// LWJGL Maven URL helpers
// ---------------------------------------------------------------------------

/**
 * Get the download URL for an LWJGL module JAR (the main artifact, not natives).
 * Example: org.lwjgl:lwjgl:3.3.3
 *   → /org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar
 */
function getJarUrl(module) {
    const jarName = `${module}-${LWJGL_VERSION}.jar`;
    return `${LWJGL_MAVEN_BASE}/${module}/${LWJGL_VERSION}/${jarName}`;
}

/**
 * Get the download URL for an LWJGL module native JAR for a given classifier.
 * @param {string} module - LWJGL module name
 * @param {string} classifier - e.g. 'natives-macos-arm64' or 'natives-macos'
 */
function getNativeJarUrl(module, classifier) {
    const jarName = `${module}-${LWJGL_VERSION}-${classifier}.jar`;
    return `${LWJGL_MAVEN_BASE}/${module}/${LWJGL_VERSION}/${jarName}`;
}

/**
 * Get the expected local filename for a downloaded JAR.
 */
function getJarFileName(module, native = false, classifier) {
    if (native) return `${module}-${LWJGL_VERSION}-${classifier || NATIVE_CLASSIFIER}.jar`;
    return `${module}-${LWJGL_VERSION}.jar`;
}

// ---------------------------------------------------------------------------
// LWJGL 3.2.x artifact names in the Minecraft version JSON
// ---------------------------------------------------------------------------

/**
 * Given an LWJGL 3.3.3 module name, return the equivalent LWJGL 3.2.x name
 * that appears in the Minecraft version JSON libraries list.
 * Example: "lwjgl-glfw" → "lwjgl.glfw"
 */
function getLegacyModuleName(module) {
    return module.replace('lwjgl-', 'lwjgl.');
}

/**
 * Check if a library entry in the version JSON is an LWJGL library
 * that needs to be replaced.
 */
function isLwjglLibrary(lib) {
    if (!lib || !lib.name) return false;
    const name = lib.name;
    // Matches: org.lwjgl:lwjgl, org.lwjgl:lwjgl.glfw, etc.
    return /^org\.lwjgl:lwjgl/.test(name);
}

/**
 * Check if a library entry is an LWJGL native classifier entry.
 */
function isLwjglNativeLibrary(lib) {
    if (!isLwjglLibrary(lib)) return false;
    if (!lib.downloads || !lib.downloads.classifiers) return false;
    // Minecraft 1.13–1.18.2 uses "natives-osx" as the classifier for macOS
    return !!(lib.downloads.classifiers['natives-osx'] || lib.downloads.classifiers['natives-macos']);
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

async function downloadFile(url, destPath) {
    const dir = path.dirname(destPath);
    await fs.promises.mkdir(dir, { recursive: true });

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            await fs.promises.writeFile(destPath, buffer);
            return;
        } catch (err) {
            if (attempt === maxRetries - 1) throw err;
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
    }
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Cache directory for LWJGL 3.3.3 JARs.
 */
function getCacheDir(appRoot) {
    return path.join(appRoot, 'lwjgl-cache', LWJGL_VERSION);
}

/**
 * Cache directory for extracted native libraries.
 */
function getNativesDir(appRoot) {
    return path.join(appRoot, 'lwjgl-cache', 'natives', LWJGL_VERSION);
}

/**
 * Ensure all LWJGL 3.3.3 JARs (both main artifacts and natives) are
 * downloaded and cached locally.
 *
 * @param {string} appRoot - Launcher app root
 * @param {Function} [onProgress] - Progress callback
 */
async function ensureLwjglCached(appRoot, onProgress) {
    const cacheDir = getCacheDir(appRoot);
    const nativesDir = getNativesDir(appRoot);
    const extractDir = path.join(appRoot, 'lwjgl-cache', 'extracted');

    await fs.promises.mkdir(cacheDir, { recursive: true });
    await fs.promises.mkdir(nativesDir, { recursive: true });

    const downloads = [];

    // Main artifact JARs
    for (const mod of LWJGL_MODULES) {
        const jarPath = path.join(cacheDir, getJarFileName(mod, false));
        if (!fs.existsSync(jarPath)) {
            downloads.push({
                url: getJarUrl(mod),
                dest: jarPath,
                label: `${mod}.jar`,
            });
        }
    }

    // Native JARs for ARM64 — these contain the actual arm64 .dylib files
    for (const mod of LWJGL_MODULES) {
        const jarPath = path.join(cacheDir, getJarFileName(mod, true, NATIVE_CLASSIFIER));
        if (!fs.existsSync(jarPath)) {
            downloads.push({
                url: getNativeJarUrl(mod, NATIVE_CLASSIFIER),
                dest: jarPath,
                label: `${mod}-${NATIVE_CLASSIFIER}.jar`,
            });
        }
    }

    // Also download the generic macOS native JARs (needed for modules like
    // lwjgl-openal where the arm64 native JAR may not exist on Maven Central)
    for (const mod of LWJGL_MODULES) {
        const jarPath = path.join(cacheDir, getJarFileName(mod, true, NATIVE_CLASSIFIER_GENERIC));
        if (!fs.existsSync(jarPath)) {
            downloads.push({
                url: getNativeJarUrl(mod, NATIVE_CLASSIFIER_GENERIC),
                dest: jarPath,
                label: `${mod}-${NATIVE_CLASSIFIER_GENERIC}.jar`,
            });
        }
    }

    // Download any missing files (fail softly — some native variants may not exist)
    for (let i = 0; i < downloads.length; i++) {
        const dl = downloads[i];
        if (onProgress) onProgress(`Downloading LWJGL ${dl.label}...`);
        try {
            await downloadFile(dl.url, dl.dest);
        } catch {
            console.warn(`[LWJGL] Could not download ${dl.url} — skipping`);
        }
    }

    // Extract native .dylib files from native JARs.
    // Each native JAR contains .dylib files like liblwjgl.dylib, libglfw.dylib, etc.
    // We try both classifiers: arm64-specific first, then fall back to generic macOS.
    const needsExtract = downloads.length > 0 ||
        !fs.readdirSync(nativesDir).some(f => f.endsWith('.dylib'));
    if (needsExtract) {
        if (onProgress) onProgress('Extracting LWJGL native libraries...');
        await fs.promises.mkdir(extractDir, { recursive: true });

        for (const classifier of [NATIVE_CLASSIFIER, NATIVE_CLASSIFIER_GENERIC]) {
            for (const mod of LWJGL_MODULES) {
                const nativeJar = path.join(cacheDir, getJarFileName(mod, true, classifier));
                if (!fs.existsSync(nativeJar)) continue;

                const modExtractDir = path.join(extractDir, mod, classifier);
                await fs.promises.mkdir(modExtractDir, { recursive: true });

                try {
                    await execPromise('unzip', ['-q', '-o', nativeJar, '-d', modExtractDir]);
                } catch {
                    try {
                        await execPromise('jar', ['xf', nativeJar, '-C', modExtractDir]);
                    } catch {
                        continue; // skip this classifier for this module
                    }
                }

                // Copy .dylib files to the natives directory.
                // LWJGL 3.3.3 native JARs store .dylib files under paths like:
                //   macos/arm64/org/lwjgl/liblwjgl.dylib
                //   macos/arm64/org/lwjgl/openal/libopenal.dylib
                // We need to find ALL .dylib files recursively and copy them.
                const dylibFiles = findDylibFilesRecursive(modExtractDir);
                for (const src of dylibFiles) {
                    const fileName = path.basename(src);
                    const dst = path.join(nativesDir, fileName);
                    fs.copyFileSync(src, dst);
                    try { fs.chmodSync(dst, 0o755); } catch { /* ignore */ }
                }
            }
        }

        if (onProgress) onProgress(`LWJGL ${LWJGL_VERSION} ARM64 natives ready`);
    }

    return { cacheDir, nativesDir };
}

/**
 * Recursively find all .dylib files under a directory.
 * LWJGL 3.3.3 native JARs place .dylib files under paths like:
 *   macos/arm64/org/lwjgl/liblwjgl.dylib
 *   macos/arm64/org/lwjgl/openal/libopenal.dylib
 */
function findDylibFilesRecursive(dirPath) {
    const results = [];
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                results.push(...findDylibFilesRecursive(fullPath));
            } else if (entry.isFile() && entry.name.endsWith('.dylib')) {
                results.push(fullPath);
            }
        }
    } catch { /* permission or missing dir */ }
    return results;
}

function execPromise(cmd, args) {
    return new Promise((resolve, reject) => {
        const child = execFile(cmd, args, { maxBuffer: 1024 * 1024 * 100, timeout: 60000 });
        let stderr = '';
        child.stderr?.on('data', (d) => { stderr += d.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`"${cmd}" exited with code ${code}: ${stderr.trim()}`));
        });
    });
}

/**
 * Get the classpath entries for the LWJGL 3.3.3 JARs.
 * Returns BOTH main artifact JARs and native JARs so LWJGL can
 * auto-extract .dylib files from the native JARs at runtime.
 *
 * @param {string} appRoot - Launcher app root
 * @returns {string[]} Array of absolute paths to JAR files
 */
function getLwjglClasspath(appRoot) {
    const cacheDir = getCacheDir(appRoot);
    const entries = [];

    for (const mod of LWJGL_MODULES) {
        // Main artifact JAR (Java classes)
        const jarPath = path.join(cacheDir, getJarFileName(mod, false));
        if (fs.existsSync(jarPath)) entries.push(jarPath);

        // Native JAR (contains .dylib files for LWJGL's auto-extraction)
        const nativeJarPath = path.join(cacheDir, getJarFileName(mod, true, NATIVE_CLASSIFIER));
        if (fs.existsSync(nativeJarPath)) entries.push(nativeJarPath);
    }

    return entries;
}

/**
 * Generate a patched version JSON that replaces old LWJGL 3.2.x libraries
 * with LWJGL 3.3.3 references, pointing to our cached JARs.
 *
 * MCLC reads the version JSON from disk and uses it to resolve libraries.
 * By modifying the JSON's `libraries` array, we cause MCLC to download
 * our LWJGL 3.3.3 JARs into the standard libraries directory, OR we can
 * skip the download by having the files already in place.
 *
 * However, the simplest approach is to use overrides.classes to inject
 * the LWJGL 3.3.3 JARs into the classpath, and overrides.natives to
 * point to our natives. But overrides.classes replaces the ENTIRE
 * classpath, which is too aggressive.
 *
 * Instead, we patch the version JSON on disk BEFORE MCLC reads it.
 * This is the cleanest approach.
 *
 * @param {object} versionJson - The parsed version JSON from Mojang
 * @param {string} appRoot - Launcher app root (for LWJGL cache paths)
 * @returns {object} Patched version JSON
 */
function patchVersionJson(versionJson, appRoot) {
    if (!versionJson || !Array.isArray(versionJson.libraries)) return versionJson;

    const patched = JSON.parse(JSON.stringify(versionJson)); // deep clone

    // Filter OUT old LWJGL libraries (both main artifacts and natives)
    patched.libraries = patched.libraries.filter(lib => !isLwjglLibrary(lib));

    // Add LWJGL 3.3.3 library entries pointing to Maven Central.
    // MCLC will download these JARs into its standard libraries directory
    // and add them to the classpath.
    for (const mod of LWJGL_MODULES) {
        const legacyName = getLegacyModuleName(mod);
        const jarFile = getJarFileName(mod, false);
        const nativeJarFileArm64 = getJarFileName(mod, true, NATIVE_CLASSIFIER);
        const nativeJarFileGeneric = getJarFileName(mod, true, NATIVE_CLASSIFIER_GENERIC);
        const mavenBase = `https://repo1.maven.org/maven2/org/lwjgl/${mod}/${LWJGL_VERSION}`;
        const jarPath = `org/lwjgl/${mod}/${LWJGL_VERSION}/${jarFile}`;
        const nativeJarPathArm64 = `org/lwjgl/${mod}/${LWJGL_VERSION}/${nativeJarFileArm64}`;

        // 1. Main artifact (no natives) — adds the Java class JAR to the classpath
        patched.libraries.push({
            name: `org.lwjgl:${legacyName}:${LWJGL_VERSION}`,
            downloads: {
                artifact: {
                    path: jarPath,
                    url: `${mavenBase}/${jarFile}`,
                    sha1: '',
                    size: 0,
                },
            },
        });

        // 2. Native artifact for the classpath (downloads.artifact, no classifiers).
        //    This adds the -natives-macos-arm64.jar to the classpath so LWJGL's
        //    native loader can find and auto-extract the .dylib files from it.
        //    Without this, the .dylib files are never loaded by LWJGL's native
        //    library resolver.
        patched.libraries.push({
            name: `org.lwjgl:${legacyName}:${LWJGL_VERSION}:${NATIVE_CLASSIFIER}`,
            downloads: {
                artifact: {
                    path: nativeJarPathArm64,
                    url: `${mavenBase}/${nativeJarFileArm64}`,
                    sha1: '',
                    size: 0,
                },
            },
        });

        // 3. Native classifier entries for MCLC's getNatives() extraction
        //    (downloads.classifiers). These provide the fallback extract path
        //    when the classpath approach doesn't work.
        for (const classifier of [NATIVE_CLASSIFIER, NATIVE_CLASSIFIER_GENERIC]) {
            const nativeJarFile = getJarFileName(mod, true, classifier);
            const nativeJarPath = `org/lwjgl/${mod}/${LWJGL_VERSION}/${nativeJarFile}`;
            const mclcClassifier = classifier === NATIVE_CLASSIFIER_GENERIC ? 'natives-macos' : 'natives-osx';

            patched.libraries.push({
                name: `org.lwjgl:${legacyName}:${LWJGL_VERSION}`,
                natives: { osx: '*' },
                downloads: {
                    classifiers: {
                        [mclcClassifier]: {
                            path: nativeJarPath,
                            url: `${mavenBase}/${nativeJarFile}`,
                            sha1: '',
                            size: 0,
                        },
                    },
                },
                rules: [
                    {
                        action: 'allow',
                        os: { name: 'osx' },
                    },
                ],
            });
        }
    }

    return patched;
}

/**
 * Check if the LWJGL swap is needed and prepare the environment.
 *
 * This is the main entry point. It:
 *  1. Checks if the LWJGL swap is needed (macOS arm64 + version 1.13–1.18.2).
 *  2. Downloads and caches LWJGL 3.3.3 JARs + native .dylib files.
 *  3. Deploys the arm64 .dylib files into a version-specific directory.
 *
 * The caller (index.js) sets overrides.natives to the returned path so
 * MCLC passes -Djava.library.path to the JVM.
 *
 * @param {string} mcVersion - The Minecraft version to launch (e.g. "1.18.2")
 * @param {string} appRoot - Launcher app root (for caches)
 * @param {string} mcRoot - MCLC root directory (unused — kept for API compat)
 * @param {Function} [onProgress] - Progress callback
 * @returns {Promise<{needed: boolean, nativesDir: string|null}>}
 */
async function prepareLwjglArm64Swap(mcVersion, appRoot, mcRoot, onProgress) {
    if (!needsLwjglSwap(mcVersion)) {
        return { needed: false, nativesDir: null };
    }

    if (onProgress) onProgress('Detected legacy Minecraft on Apple Silicon. Preparing ARM64-compatible LWJGL...', 15);

    // 1. Download LWJGL 3.3.3 JARs and extract natives into our cache
    await ensureLwjglCached(appRoot, onProgress);
    const cachedNativesDir = getNativesDir(appRoot);

    // 2. Deploy into a version-specific natives directory that we'll pass
    //    to MCLC via overrides.natives. This becomes -Djava.library.path.
    const deployDir = path.join(appRoot, 'lwjgl-cache', 'deployed-natives', mcVersion);
    await fs.promises.mkdir(deployDir, { recursive: true });

    // Force-overwrite: remove any existing .dylib files first, then deploy
    // fresh copies from our cache. This ensures old 3.2.1 files are removed.
    if (fs.existsSync(deployDir)) {
        const existing = fs.readdirSync(deployDir);
        for (const f of existing) {
            if (f.endsWith('.dylib')) {
                try { fs.unlinkSync(path.join(deployDir, f)); } catch { /* ignore */ }
            }
        }
    }

    // Copy all .dylib files from our cache into the deployment directory
    if (fs.existsSync(cachedNativesDir)) {
        const dylibFiles = findDylibFilesRecursive(cachedNativesDir);
        for (const src of dylibFiles) {
            const fileName = path.basename(src);
            const dst = path.join(deployDir, fileName);
            fs.copyFileSync(src, dst);
            try { fs.chmodSync(dst, 0o755); } catch { /* ignore */ }
        }
        if (onProgress) onProgress(`Deployed ${dylibFiles.length} ARM64 native libraries`, 17);
    }

    return {
        needed: true,
        nativesDir: deployDir,
    };
}

// ---------------------------------------------------------------------------
// LWJGL 2.x macOS version bump (pre-1.13)
// ---------------------------------------------------------------------------
//
// Mojang's version metadata assigns LWJGL 2.9.2 to macOS while Windows/Linux
// get 2.9.4.  Prism Launcher overrides this to use 2.9.4 everywhere.  LWJGL
// 2.9.4 contains important bug fixes that prevent the "textures-atlas" hang
// on macOS (especially under Rosetta 2 on Apple Silicon).

/**
 * Check if the Minecraft version uses LWJGL 2.x (pre-1.13).
 * @param {string} mcVersion - e.g. "1.8.9", "1.12.2"
 * @returns {boolean}
 */
function isLwjgl2(mcVersion) {
    const parts = mcVersion.split('.').map(Number);
    if (parts.length < 2) return false;
    const major = parts[0];
    const minor = parts[1];
    if (major !== 1) return false;
    return minor < 13;
}

/**
 * Check if the LWJGL 2.x macOS version bump is needed.
 * Returns true on macOS when the MC version uses LWJGL 2.x.
 * @param {string} mcVersion
 * @returns {boolean}
 */
function needsLwjgl2MacBump(mcVersion) {
    return process.platform === 'darwin' && isLwjgl2(mcVersion);
}

/**
 * Patch the version JSON to use LWJGL 2.9.4 on macOS instead of 2.9.2.
 *
 * Mojang's metadata assigns LWJGL 2.9.2 to macOS (via OS-specific rules)
 * while Windows/Linux get 2.9.4.  Prism Launcher overrides this to use
 * 2.9.4 everywhere.
 *
 * Additionally, on ARM64 macOS (Apple Silicon), injects ARM64 native
 * classifiers for lwjgl-platform and jinput-platform pointing to
 * community ARM64 builds — exactly as Prism's org.lwjgl.json patch does.
 *
 * The fix:
 *   1. Remove macOS disallow rules from 2.9.4 entries
 *   2. Remove macOS-only 2.9.2 entries entirely
 *   3. Inject ARM64 native classifiers (Prism-equivalent URLs)
 *
 * @param {object} versionJson - The parsed version JSON from Mojang
 * @returns {object} Patched version JSON
 */
function patchLwjgl2MacOS(versionJson) {
    if (!versionJson || !Array.isArray(versionJson.libraries)) return versionJson;
    if (process.platform !== 'darwin') return versionJson;

    const patched = JSON.parse(JSON.stringify(versionJson)); // deep clone

    // ARM64 native classifier URLs — from Prism's org.lwjgl.json patch
    // https://github.com/MinecraftMachina/lwjgl/releases (community ARM64 LWJGL 2.9.4)
    // https://github.com/r58Playz/jinput-m1 (community ARM64 jinput)
    var ARM64_NATIVES = {};
    ARM64_NATIVES['org.lwjgl.lwjgl:lwjgl-platform'] = {
        classifier: 'natives-osx-arm64',
        path: 'org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209-natives-osx-arm64.jar',
        sha1: 'eff546c0b319d6ffc7a835652124c18089c67f36',
        size: 488316,
        url: 'https://github.com/MinecraftMachina/lwjgl/releases/download/2.9.4-20150209-mmachina.2/lwjgl-platform-2.9.4-nightly-20150209-natives-osx.jar',
    };
    ARM64_NATIVES['net.java.jinput:jinput-platform'] = {
        classifier: 'natives-osx-arm64',
        path: 'net/java/jinput/jinput-platform/2.0.5/jinput-platform-2.0.5-natives-osx-arm64.jar',
        sha1: '5189eb40db3087fb11ca063b68fa4f4c20b199dd',
        size: 10031,
        url: 'https://github.com/r58Playz/jinput-m1/raw/main/plugins/OSX/bin/jinput-platform-2.0.5.jar',
    };

    patched.libraries = patched.libraries.map(function (lib) {
        if (!lib || !lib.name) return lib;

        var name = lib.name;

        // --- LWJGL 2.x libraries ---
        var isLwjgl2Lib = /^org\.lwjgl\.lwjgl:(lwjgl|lwjgl_util|lwjgl-platform)/.test(name);

        if (isLwjgl2Lib) {
            var version = lib.name.split(':')[2] || '';

            // Case 1: 2.9.2 entries — remove entirely (macOS-only fallback)
            if (version.indexOf('2.9.2') !== -1) return null;

            // Case 2: 2.9.4 entries — remove disallow-osx rules
            if (version.indexOf('2.9.4') !== -1 && lib.rules) {
                var filtered = lib.rules.filter(function (r) {
                    return !(r.action === 'disallow' && r.os && r.os.name === 'osx');
                });
                if (filtered.length === 0) delete lib.rules;
                else lib.rules = filtered;
            }

            // Case 3: Inject ARM64 native classifier for lwjgl-platform
            // IMPORTANT: lib.name includes the version suffix (e.g. "lwjgl-platform:2.9.4-nightly-20150209")
            // so we must use indexOf() not === to match.
            if (name.indexOf('org.lwjgl.lwjgl:lwjgl-platform') === 0) {
                injectArm64Classifier(lib, ARM64_NATIVES['org.lwjgl.lwjgl:lwjgl-platform']);
            }
            return lib;
        }

        // --- jinput-platform (also needs ARM64 patch for pre-1.13) ---
        if (name.indexOf('net.java.jinput:jinput-platform') === 0) {
            injectArm64Classifier(lib, ARM64_NATIVES['net.java.jinput:jinput-platform']);
        }

        return lib;
    }).filter(Boolean);

    return patched;
}

/**
 * Inject an ARM64 native classifier into a library entry's downloads.classifiers
 * and natives map, matching Prism's org.lwjgl.json patch structure.
 * @param {object} lib - The library entry to patch
 * @param {object} arm64 - {classifier, path, sha1, size, url}
 */
function injectArm64Classifier(lib, arm64) {
    if (!lib || !arm64) return;
    if (!lib.downloads) lib.downloads = {};
    if (!lib.downloads.classifiers) lib.downloads.classifiers = {};
    lib.downloads.classifiers[arm64.classifier] = {
        path: arm64.path,
        sha1: arm64.sha1,
        size: arm64.size,
        url: arm64.url,
    };
    if (!lib.natives) lib.natives = {};
    lib.natives['osx-arm64'] = arm64.classifier;
}

module.exports = {
    needsLwjglSwap,
    prepareLwjglArm64Swap,
    getLwjglClasspath,
    patchVersionJson,
    needsLwjgl2MacBump,
    patchLwjgl2MacOS,
    patchLwjgl2MacOSMinimal,
    injectArm64Classifier,
};

/**
 * Minimal LWJGL 2.x macOS version bump for Rosetta 2 mode.
 * Only bumps 2.9.2 → 2.9.4 and removes macOS disallow rules.
 * Does NOT inject ARM64 native classifiers — official Mojang
 * x86_64 natives work directly under Rosetta 2 translation.
 */
function patchLwjgl2MacOSMinimal(versionJson) {
    if (!versionJson || !Array.isArray(versionJson.libraries)) return versionJson;
    if (process.platform !== 'darwin') return versionJson;

    const patched = JSON.parse(JSON.stringify(versionJson));

    patched.libraries = patched.libraries.map(function (lib) {
        if (!lib || !lib.name) return lib;
        var name = lib.name;
        var isLwjgl2Lib = /^org\.lwjgl\.lwjgl:(lwjgl|lwjgl_util|lwjgl-platform)/.test(name);

        if (isLwjgl2Lib) {
            var version = lib.name.split(':')[2] || '';
            // Remove 2.9.2 entries entirely (macOS-only fallback)
            if (version.indexOf('2.9.2') !== -1) return null;
            // Remove disallow-osx rules from 2.9.4 entries
            if (version.indexOf('2.9.4') !== -1 && lib.rules) {
                var filtered = lib.rules.filter(function (r) {
                    return !(r.action === 'disallow' && r.os && r.os.name === 'osx');
                });
                if (filtered.length === 0) delete lib.rules;
                else lib.rules = filtered;
            }
        }
        return lib;
    }).filter(Boolean);

    return patched;
}
