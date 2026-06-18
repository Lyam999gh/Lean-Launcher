/**
 * javaManager.js — Dynamic Java Runtime downloader & resolver
 * ============================================================
 *
 * Replaces the old bundled-JRE approach with on-demand Java downloading.
 *
 * Responsibilities:
 *   1. Map a Minecraft version to the required Java version (class-file version).
 *   2. Download the correct OpenJDK (Adoptium) JRE for the current platform.
 *   3. Cache downloaded JREs so they are only fetched once.
 *   4. Provide a simple API for the rest of the launcher to resolve Java.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

// ---------------------------------------------------------------------------
// Minecraft version → Java version mapping
// ---------------------------------------------------------------------------
//
// Source: https://minecraft.wiki/w/Java_Edition_versi_program
// Minecraft  | Required Java | Class version
// -----------+---------------+---------------
// 1.17+      | Java 17       | 61.0
// 1.18–1.20  | Java 17       | 61.0
// 1.20.5+    | Java 21       | 65.0
// 1.21.4+    | Java 21       | 65.0
// Future     | Java 25       | 69.0
//
// We store the *minimum* Java major version needed.

const MC_JAVA_REQUIREMENTS = [
    // [minMcVersion, requiredJavaMajor, label]
    // Minecraft 26+ (e.g., 26.1.2) requires Java 25.
    ['26.0',   25, 'Java 25'],   // modern snapshots / future releases
    ['1.20.5', 21, 'Java 21'],
    ['1.17',   17, 'Java 17'],
    // Floor: all older versions (pre-1.17) use Java 8.
    // Matches Mojang's "jre-legacy" classification for Java Edition.
    ['0',      8,  'Java 8'],
];

const ADOPTIUM_API_BASE = 'https://api.adoptium.net/v3/assets';
const ZULU_API_BASE = 'https://api.azul.com/metadata/v1/zulu/packages';

/**
 * Return the minimum Java major version required by a given Minecraft version.
 * Falls back to Java 17 (the oldest supported Minecraft modern version).
 */
function getRequiredJavaVersion(minecraftVersion) {
    for (const [minVer, javaMajor] of MC_JAVA_REQUIREMENTS) {
        if (compareVersions(minecraftVersion, minVer) >= 0) {
            return javaMajor;
        }
    }
    return 8; // safe floor (Java 8)
}

/**
 * Simple numeric version comparator (handles "1.20.5" style).
 * Returns > 0 if a > b, < 0 if a < b, 0 if equal.
 */
function compareVersions(a, b) {
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);
    const len = Math.max(aParts.length, bParts.length);
    for (let i = 0; i < len; i++) {
        const an = aParts[i] || 0;
        const bn = bParts[i] || 0;
        if (an !== bn) return an - bn;
    }
    return 0;
}

// ---------------------------------------------------------------------------
// Adoptium API helpers
// ---------------------------------------------------------------------------

/**
 * Determine the Adoptium `os` and `arch` values for the current platform.
 */
function getAdoptiumPlatform() {
    const archMap = {
        x64: 'x64',
        arm64: 'aarch64',
        ia32: 'x32',
    };
    const osMap = {
        darwin: 'mac',
        win32: 'windows',
        linux: 'linux',
    };

    const arch = archMap[process.arch] || 'x64';
    const plat = osMap[process.platform] || 'linux';

    return { os: plat, arch };
}

/**
 * Azul Zulu API: fetch ARM64 Java 8 JDK for macOS Apple Silicon.
 * Adoptium does not publish Java 8 for mac/aarch64, but Azul does.
 *
 * @param {number} javaMajor - must be 8
 * @returns {Promise<{url: string, fileName: string, sha256: string, version: string}>}
 */
async function getAzulDownload(javaMajor) {
    if (javaMajor !== 8) {
        throw new Error(`Azul fallback only supports Java 8, requested ${javaMajor}`);
    }

    // Azul metadata API: query for the latest GA release of Zulu 8 for macOS ARM64
    const url = `${ZULU_API_BASE}/?os=macos&arch=aarch64&java_version=${javaMajor}&package_type=jdk&release_status=ga&latest=true`;

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Azul API returned ${response.status} for Java ${javaMajor} on macos/aarch64`);
    }

    const packages = await response.json();
    if (!packages || packages.length === 0) {
        throw new Error(`Azul API returned no packages for Java ${javaMajor} on macos/aarch64`);
    }

    const pkg = packages[0];
    const downloadUrl = pkg.download_url || (pkg.url ? `${pkg.url}` : null);
    if (!downloadUrl) {
        throw new Error(`Azul package has no download URL: ${JSON.stringify(pkg)}`);
    }

    // Build a reasonable filename from the URL
    const fileName = downloadUrl.split('/').pop() || `zulu${javaMajor}-macos-arm64.tar.gz`;

    return {
        url: downloadUrl,
        fileName: fileName,
        sha256: pkg.sha_256 || '',
        version: pkg.java_version || `${javaMajor}.0.0`,
        releaseName: pkg.name || `Zulu ${javaMajor}`,
    };
}

/**
 * Fetch the download URL for an Adoptium JDK (JRE) for a given Java major version.
 *
 * Uses the v3 version-range API: /v3/assets/version/[MAJOR,MAJOR+1)
 * which handles both GA (stable) and EA (early-access) releases.
 *
 * @param {number} javaMajor - e.g. 21, 25
 * @param {string} [imageType=jre] - 'jre' or 'jdk'
 * @returns {Promise<{url: string, fileName: string, sha256: string, version: string}>}
 */
async function getAdoptiumDownload(javaMajor, imageType = 'jre', adoptArchOverride) {
    const { os: adoptOs, arch: defaultArch } = getAdoptiumPlatform();
    const adoptArch = adoptArchOverride || defaultArch;

    // ----------------------------------------------------------------
    // Strategy: try GA (stable) releases first, then fall back to EA.
    // Also try both 'jre' and 'jdk' image types — for some combos
    // (e.g. Java 8 on mac/aarch64) only a JDK image is published.
    // ----------------------------------------------------------------
    const nextMajor = javaMajor + 1;
    const versionRange = `%5B${javaMajor}%2C${nextMajor}%29`; // URL-encoded [21,22)

    for (const image of [imageType, 'jdk']) {
        for (const releaseType of ['ga', 'ea']) {
            const url = `${ADOPTIUM_API_BASE}/version/${versionRange}?image_type=${image}&os=${adoptOs}&architecture=${adoptArch}&release_type=${releaseType}&page_size=1&sort_method=DEFAULT&sort_order=DESC`;

            const response = await fetch(url);
            if (!response.ok) {
                if (response.status === 404) continue;
                throw new Error(`Adoptium API returned ${response.status} for Java ${javaMajor} (${adoptOs}/${adoptArch}, ${releaseType}, ${image})`);
            }

            const assets = await response.json();
            if (!assets || assets.length === 0) continue;

            const release = assets[0];
            const binaries = release.binaries;
            if (!binaries || binaries.length === 0) continue;

            const binary = binaries[0];
            const pkg = binary.package;

            return {
                url: pkg.link,
                fileName: pkg.name,
                sha256: pkg.checksum,
                version: release.version_data.semver,
                releaseName: release.release_name,
            };
        }
    }

    // Neither GA nor EA found — throw a descriptive error
    throw new Error(
        `No Adoptium ${imageType} (or jdk) found for Java ${javaMajor} on ${adoptOs}/${adoptArch}. ` +
        `Checked both GA (stable) and EA (early-access) releases. ` +
        `This Java version may not yet be available from Adoptium.`
    );
}

// ---------------------------------------------------------------------------
// JRE discovery paths
// ---------------------------------------------------------------------------

/**
 * Get the directory where downloaded/cached JREs are stored.
 * Uses the launcher's appRoot so it persists across sessions.
 *
 * @param {string} appRoot - The launcher's application root directory
 * @returns {string} Path to the JRE cache directory
 */
function getJreCacheDir(appRoot) {
    return path.join(appRoot, 'jre-cache');
}

/**
 * Return the expected directory name for a given Java major version on the current platform.
 * Example: "jdk-21-mac-aarch64" or "jdk-17-windows-x64"
 */
function getJreDirName(javaMajor) {
    const { os: adoptOs, arch: adoptArch } = getAdoptiumPlatform();
    return `jdk-${javaMajor}-${adoptOs}-${adoptArch}`;
}

/**
 * Return the full path to the java executable inside an extracted JRE.
 * Works for all three platforms.
 * Returns null if the directory doesn't exist or no java binary is found.
 */
function getJavaBinaryPath(jreExtractDir) {
    // Safety: if the directory doesn't exist yet, return null so the caller
    // proceeds to download.
    if (!fs.existsSync(jreExtractDir)) return null;

    const javaBinary = process.platform === 'win32' ? 'java.exe' : 'java';

    // Adoptium archives unpack to a directory named like "jdk-21.0.5+9-jre"
    // Inside that: bin/java (mac/linux) or bin/java.exe (windows)
    // On macOS the binary is at: jdk-XX.X.X+XX-jre/Contents/Home/bin/java
    if (process.platform === 'darwin') {
        // macOS .jdk bundle layout: <bundle>/Contents/Home/bin/java
        let entries;
        try { entries = fs.readdirSync(jreExtractDir, { withFileTypes: true }); } catch { return null; }
        const dirs = entries.filter(e => e.isDirectory());
        // Try each subdirectory
        for (const dir of dirs) {
            const candidate = path.join(jreExtractDir, dir.name, 'Contents', 'Home', 'bin', javaBinary);
            if (fs.existsSync(candidate)) return candidate;
        }
        // Fallback: flat layout
        const flatCandidate = path.join(jreExtractDir, 'Contents', 'Home', 'bin', javaBinary);
        if (fs.existsSync(flatCandidate)) return flatCandidate;
    }

    // Windows/Linux: bin/java
    let entries;
    try { entries = fs.readdirSync(jreExtractDir, { withFileTypes: true }); } catch { return null; }
    const dirs = entries.filter(e => e.isDirectory());
    for (const dir of dirs) {
        const candidate = path.join(jreExtractDir, dir.name, 'bin', javaBinary);
        if (fs.existsSync(candidate)) return candidate;
    }

    // Direct fallback
    const directCandidate = path.join(jreExtractDir, 'bin', javaBinary);
    if (fs.existsSync(directCandidate)) return directCandidate;

    return null;
}

// ---------------------------------------------------------------------------
// Archive extraction
// ---------------------------------------------------------------------------

/**
 * Extract a .tar.gz or .zip archive to a target directory.
 * Uses native Node.js zlib + tar, or falls back to platform tools.
 */
async function extractArchive(archivePath, targetDir) {
    const ext = path.extname(archivePath).toLowerCase();
    const isGz = ext === '.gz' || archivePath.endsWith('.tar.gz');
    const isZip = ext === '.zip';

    if (isZip && process.platform === 'win32') {
        // Use PowerShell's Expand-Archive on Windows
        await execPromise('powershell', [
            '-NoProfile',
            '-Command',
            `Expand-Archive -Path "${archivePath}" -DestinationPath "${targetDir}" -Force`,
        ]);
    } else if (isZip) {
        // Use unzip on macOS/Linux
        await execPromise('unzip', ['-q', '-o', archivePath, '-d', targetDir]);
    } else if (isGz) {
        await execPromise('tar', ['-xzf', archivePath, '-C', targetDir]);
    } else {
        throw new Error(`Unsupported archive format: ${ext}`);
    }
}

function execPromise(cmd, args) {
    return new Promise((resolve, reject) => {
        const child = execFile(cmd, args, { maxBuffer: 1024 * 1024 * 100, timeout: 120000 });
        let stderr = '';
        child.stderr?.on('data', (d) => { stderr += d.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`"${cmd} ${args.join(' ')}" exited with code ${code}: ${stderr.trim()}`));
        });
    });
}

/**
 * Strip the macOS quarantine extended attribute (com.apple.quarantine)
 * from a directory tree.  Downloaded archives extracted via HTTP inherit
 * this attribute from the parent archive, which can cause Gatekeeper to
 * block execution of the java binary or native library loading.
 *
 * @param {string} dirPath - Directory to recursively strip quarantine from
 */
function stripQuarantine(dirPath) {
    if (process.platform !== 'darwin') return;
    if (!dirPath || !fs.existsSync(dirPath)) return;
    try {
        require('child_process').execFileSync(
            '/usr/bin/xattr',
            ['-rd', 'com.apple.quarantine', dirPath],
            { timeout: 10000, stdio: 'ignore' }
        );
    } catch {
        // xattr may fail silently (e.g., on non-APFS filesystems);
        // this is non-critical — the JRE may still work.
    }
}

// ---------------------------------------------------------------------------
// Download progress helper
// ---------------------------------------------------------------------------

async function downloadFileWithProgress(url, destinationPath, javaMajor, onProgress) {
    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minute timeout

        try {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
            await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });

            const { Readable } = require('stream');
            const nodeStream = Readable.fromWeb(response.body);
            const writer = fs.createWriteStream(destinationPath);
            let downloadedBytes = 0;

            nodeStream.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                if (onProgress && contentLength > 0) {
                    const percent = Math.round((downloadedBytes / contentLength) * 100);
                    onProgress(`Downloading Java ${javaMajor}... ${percent}%`);
                }
            });

            await new Promise((resolve, reject) => {
                nodeStream.pipe(writer);
                writer.on('finish', resolve);
                writer.on('error', reject);
                nodeStream.on('error', reject);
            });

            return destinationPath;
        } catch (error) {
            lastError = error;
            try { if (fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath); } catch { /* ignore */ }
            if (attempt < maxRetries - 1) {
                if (onProgress) onProgress(`Retrying Java download (attempt ${attempt + 2}/${maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            }
        } finally {
            clearTimeout(timeoutId);
        }
    }
    throw lastError || new Error('Download failed after retries');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the correct Java runtime is available for a given Minecraft version.
 *
 * On Apple Silicon Macs, when the Minecraft version uses LWJGL 2 (< 1.13),
 * we download an x86_64 (Intel) JDK so Rosetta 2 can load the x86_64-only
 * native libraries.  For all other configurations we use the native arch.
 *
 * This is the main entry point for the launcher. It:
 *  1. Determines the required Java version.
 *  2. Checks if a compatible JRE is already cached.
 *  3. Downloads and extracts it if not.
 *  4. Returns the path to the java executable.
 *
 * @param {string} minecraftVersion - e.g. "1.21.4", "1.20"
 * @param {string} appRoot - The launcher's app root (for the jre-cache directory)
 * @param {Function} [onProgress] - Optional progress callback (msg, percent)
 * @param {object} [options] - Optional overrides
 * @param {string} [options.adoptArch] - Force a specific Adoptium arch, e.g. 'x64' or 'aarch64'
 * @returns {Promise<{javaPath: string, javaVersion: string, downloaded: boolean}>}
 */
async function resolveJava(minecraftVersion, appRoot, onProgress, options) {
    const javaMajor = getRequiredJavaVersion(minecraftVersion);

    // Always use the native ARM64 architecture on Apple Silicon.
    // LWJGL 2.9.4 ships official arm64 native libraries, so an ARM64 JDK
    // loads them directly without needing Rosetta 2.
    const isArm64Mac  = process.platform === 'darwin' && process.arch === 'arm64';

    const { os: adoptOs } = getAdoptiumPlatform();
    const adoptArch = options?.adoptArch || getAdoptiumPlatform().arch;

    const cacheDir = getJreCacheDir(appRoot);
    const dirName = `jdk-${javaMajor}-${adoptOs}-${adoptArch}`;
    const extractDir = path.join(cacheDir, dirName);

    const label = `Java ${javaMajor}`;
    if (onProgress) onProgress(`Minecraft ${minecraftVersion} requires ${label}`, 1);

    // Step 1: Check if already extracted
    const existingBinary = getJavaBinaryPath(extractDir);
    if (existingBinary && fs.existsSync(existingBinary)) {
        if (onProgress) onProgress(`Using cached ${label}`, 3);
        try {
            const version = await validateJavaBinary(existingBinary);
            return { javaPath: existingBinary, javaVersion: version, downloaded: false };
        } catch {
            if (onProgress) onProgress(`Cached ${label} is corrupted, re-downloading...`, 1);
            try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    }

    // Step 2: Download from Adoptium (or Azul Zulu for ARM64 Java 8)
    if (onProgress) onProgress(`Downloading ${label}...`, 2);
    const needsArm64Azul = isArm64Mac && javaMajor === 8 && options?.adoptArch !== 'x64';
    const downloadInfo = needsArm64Azul
        ? await getAzulDownload(javaMajor)
        : await getAdoptiumDownload(javaMajor, 'jre', adoptArch);
    const archivePath = path.join(cacheDir, downloadInfo.fileName);

    if (!fs.existsSync(archivePath)) {
        await downloadFileWithProgress(downloadInfo.url, archivePath, javaMajor, onProgress);
    }

    // Step 3: Extract
    if (onProgress) onProgress(`Extracting ${label}...`, 3);
    await fs.promises.mkdir(extractDir, { recursive: true });
    await extractArchive(archivePath, extractDir);

    // macOS: strip quarantine xattr from extracted JRE so Gatekeeper
    // doesn't interfere with Java execution or native library loading.
    stripQuarantine(extractDir);

    // Step 4: Locate the binary
    const javaPath = getJavaBinaryPath(extractDir);
    if (!javaPath || !fs.existsSync(javaPath)) {
        throw new Error(`Failed to locate java binary after extraction in ${extractDir}`);
    }
    if (process.platform !== 'win32') {
        try { fs.chmodSync(javaPath, 0o755); } catch { /* ignore */ }
    }

    // Step 5: Validate
    const version = await validateJavaBinary(javaPath);
    if (onProgress) onProgress(`${label} ready`, 4);

    return { javaPath, javaVersion: version, downloaded: true };
}

/**
 * Resolve an x86_64 (Intel) Java runtime for legacy Minecraft on ARM64 Macs.
 * Convenience wrapper around resolveJava with adoptArch forced to 'x64'.
 *
 * @deprecated Use resolveJava(mcVersion, appRoot, onProgress) which
 *             auto-detects the arch requirement.  Kept for API compat.
 * @param {number} javaMajor - e.g. 8, 17
 * @param {string} appRoot - Launcher app root
 * @param {Function} [onProgress] - Progress callback
 * @returns {Promise<string>} Absolute path to the x86_64 java binary
 */
async function resolveJavaForLegacy(javaMajor, appRoot, onProgress) {
    const result = await resolveJava('1.8.9', appRoot, onProgress, { adoptArch: 'x64' });
    return result.javaPath;
}

/**
 * Resolve an x86_64 (Intel) Java runtime for legacy Minecraft on ARM64 Macs.
 *
 * macOS automatically translates x86_64 binaries through Rosetta 2 at the
 * kernel level — we just need to provide an x86_64 Java binary.  The kernel
 * will see the Mach-O header is x86_64 and transparently invoke Rosetta 2
 * for the entire process, including all dlopen() calls for x86_64 .dylib.
 *
 * This downloads from Adoptium using architecture=x64 (Intel) instead of
 * the usual aarch64, caches it separately in jre-cache-x86/, and returns
 * the path to the java binary.
 *
 * @param {number} javaMajor - e.g. 8, 17
 * @param {string} appRoot - Launcher app root
 * @param {Function} [onProgress] - Progress callback
 * @returns {Promise<string>} Absolute path to the x86_64 java binary
 */
async function resolveJavaForLegacy(javaMajor, appRoot, onProgress) {
    // Override architecture to x64 (Intel) instead of the host architecture
    const originalArch = process.arch;
    const adoptArch = 'x64';
    const adoptOs = process.platform === 'darwin' ? 'mac'
                  : process.platform === 'win32'  ? 'windows'
                  : 'linux';

    const cacheDir = path.join(appRoot, 'jre-cache-x86');
    const dirName = `jdk-${javaMajor}-${adoptOs}-x64`;
    const extractDir = path.join(cacheDir, dirName);

    if (onProgress) onProgress(`Resolving x86_64 Java ${javaMajor} for Rosetta 2...`, 2);

    // Step 1: Check cache
    const existingBinary = getJavaBinaryPath(extractDir);
    if (existingBinary && fs.existsSync(existingBinary)) {
        if (onProgress) onProgress(`Using cached x86_64 Java ${javaMajor}`, 3);
        try {
            const version = await validateJavaBinary(existingBinary);
            console.log(`[JAVA] x86_64 Java ${version} cached at ${existingBinary}`);
            return existingBinary;
        } catch {
            if (onProgress) onProgress('Cached x86_64 Java corrupted, re-downloading...', 1);
            try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    }

    // Step 2: Download x86_64 JDK from Adoptium
    if (onProgress) onProgress(`Downloading x86_64 Java ${javaMajor}...`, 2);
    const nextMajor = javaMajor + 1;
    const versionRange = `%5B${javaMajor}%2C${nextMajor}%29`;

    let downloadInfo = null;
    for (const releaseType of ['ga', 'ea']) {
        const url = `${ADOPTIUM_API_BASE}/version/${versionRange}?image_type=jre&os=${adoptOs}&architecture=${adoptArch}&release_type=${releaseType}&page_size=1&sort_method=DEFAULT&sort_order=DESC`;
        const response = await fetch(url);
        if (!response.ok) { if (response.status === 404) continue; throw new Error(`Adoptium API ${response.status} for Java ${javaMajor} x86_64`); }
        const assets = await response.json();
        if (!assets || assets.length === 0) continue;
        const release = assets[0];
        if (!release.binaries || release.binaries.length === 0) continue;
        const binary = release.binaries[0];
        const pkg = binary.package;
        downloadInfo = { url: pkg.link, fileName: pkg.name, sha256: pkg.checksum, version: release.version_data.semver };
        break;
    }
    if (!downloadInfo) throw new Error(`No x86_64 Adoptium JRE found for Java ${javaMajor}`);

    const archivePath = path.join(cacheDir, downloadInfo.fileName);
    if (!fs.existsSync(archivePath)) {
        await downloadFileWithProgress(downloadInfo.url, archivePath, `x86_64 ${javaMajor}`, onProgress);
    }

    // Step 3: Extract
    if (onProgress) onProgress(`Extracting x86_64 Java ${javaMajor}...`, 3);
    await fs.promises.mkdir(extractDir, { recursive: true });
    await extractArchive(archivePath, extractDir);

    // Step 4: Locate binary
    const javaPath = getJavaBinaryPath(extractDir);
    if (!javaPath || !fs.existsSync(javaPath)) {
        throw new Error(`Failed to locate x86_64 java binary in ${extractDir}`);
    }
    if (process.platform !== 'win32') {
        try { fs.chmodSync(javaPath, 0o755); } catch { /* ignore */ }
    }

    // Step 5: Validate
    const version = await validateJavaBinary(javaPath);
    if (onProgress) onProgress(`x86_64 Java ${version} ready`, 4);
    console.log(`[JAVA] Downloaded x86_64 Java ${version} at ${javaPath}`);

    return javaPath;
}

/**
 * Parse a Java version string (e.g. "1.8.0_392", "17.0.9", "21.0.1")
 * and return the major version number.
 *   "1.8.0_392"  → 8
 *   "17.0.9"     → 17
 *   "21.0.1"     → 21
 * Returns 0 if the string cannot be parsed.
 */
function parseJavaMajorVersion(versionStr) {
    if (!versionStr || typeof versionStr !== 'string') return 0;
    // Handle pre-Java-9 format: "1.8.0_392" → 8
    const legacyMatch = versionStr.match(/^1\.(\d+)/);
    if (legacyMatch) return parseInt(legacyMatch[1], 10);
    // Handle Java 9+ format: "17.0.9" → 17
    const majorMatch = versionStr.match(/^(\d+)/);
    return majorMatch ? parseInt(majorMatch[1], 10) : 0;
}

/**
 * Run `java -version` and parse the output to verify a binary works.
 * Returns the version string on success, throws on failure.
 */
function validateJavaBinary(javaPath) {
    return new Promise((resolve, reject) => {
        const child = execFile(javaPath, ['-version'], { timeout: 15000 });
        let stderrOutput = '';
        child.stderr.on('data', (data) => { stderrOutput += data.toString(); });
        child.on('error', (err) => reject(new Error(`Cannot execute Java: ${err.message}`)));
        child.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(`Java exited with code ${code}: ${stderrOutput.trim()}`));
            }
            const versionMatch = stderrOutput.match(/version\s+"([^"]+)"/) || stderrOutput.match(/version\s+(\S+)/);
            const version = versionMatch ? versionMatch[1] : 'unknown';
            resolve(version);
        });
    });
}

/**
 * Get the minimum Java major version required for a Minecraft version.
 * Useful for showing the user what will be downloaded before launching.
 */
function getRequiredJavaMajor(minecraftVersion) {
    return getRequiredJavaVersion(minecraftVersion);
}

/**
 * Get a human-readable label like "Java 21" for a Minecraft version.
 */
function getRequiredJavaLabel(minecraftVersion) {
    const major = getRequiredJavaVersion(minecraftVersion);
    return `Java ${major}`;
}

/**
 * Clear the JRE cache (e.g., if the user wants to force re-download).
 */
function clearJreCache(appRoot) {
    const cacheDir = getJreCacheDir(appRoot);
    if (fs.existsSync(cacheDir)) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }
}

module.exports = {
    resolveJava,
    resolveJavaForLegacy,
    validateJavaBinary,
    getRequiredJavaMajor,
    getRequiredJavaLabel,
    clearJreCache,
    getJreCacheDir,
    compareVersions,
    parseJavaMajorVersion,
    getAzulDownload,
};
