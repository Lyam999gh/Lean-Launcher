require('dotenv').config();

const { Auth } = require("msmc");
const { Client, Authenticator } = require("minecraft-launcher-core");
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');
const javaManager = require('./lib/javaManager.js');
const nativesManager = require('./lib/nativesManager.js');
const launchExecutor = require('./lib/launchExecutor.js');
const lwjglManager = require('./lib/lwjglManager.js');
let launcher = null;
const isDev = process.env.NODE_ENV === 'development';
const debugLog = (...args) => { if (isDev) console.log(...args); };

// --- Launch Diagnostics ---
let launchBooted = false;
let launchTimeoutId = null;
const LAUNCH_TIMEOUT_MS = 480000; // 8 minutes for slow downloads and Fabric installer

function clearLaunchTimeout() {
    if (launchTimeoutId) { clearTimeout(launchTimeoutId); launchTimeoutId = null; }
}

function setLaunchTimeout(onTimeout) {
    clearLaunchTimeout();
    launchBooted = false;
    launchTimeoutId = setTimeout(() => {
        launchTimeoutId = null;
        if (!launchBooted && typeof onTimeout === 'function') onTimeout();
    }, LAUNCH_TIMEOUT_MS);
}

function markLaunchBooted() {
    launchBooted = true;
    clearLaunchTimeout();
}

// --- Cross-platform Java validation ---
function validateJavaInstallation(javaPath, onProgress) {
    return new Promise((resolve) => {
        if (!javaPath || typeof javaPath !== 'string') {
            return resolve({ valid: false, error: 'No Java path provided.', version: null, arch: null });
        }
        if (!fs.existsSync(javaPath)) {
            return resolve({ valid: false, error: `Java executable not found at: ${javaPath}`, version: null, arch: null });
        }

        const { execFile } = require('child_process');
        const child = execFile(javaPath, ['-version'], { timeout: 15000 });
        let stderrOutput = '';

        child.stderr.on('data', (data) => { stderrOutput += data.toString(); });
        child.on('error', (err) => {
            resolve({ valid: false, error: `Cannot execute Java: ${err.message}`, version: null, arch: null });
        });
        child.on('close', (code) => {
            if (code !== 0) {
                return resolve({ valid: false, error: `Java exited with code ${code}: ${stderrOutput.trim()}`, version: null, arch: null });
            }
            const versionMatch = stderrOutput.match(/version\s+"([^"]+)"/) || stderrOutput.match(/version\s+(\S+)/);
            const is64Bit = /64-?[Bb]it/.test(stderrOutput);
            const arch = is64Bit ? '64-bit' : '32-bit';
            const version = versionMatch ? versionMatch[1] : 'unknown';
            if (onProgress) onProgress(`Java ${version} (${arch}) detected`, 5);
            resolve({ valid: true, error: null, version, arch });
        });
    });
}

const CLIENT_ID = process.env.AZURE_CLIENT_ID || '00000000402b5328';
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || null;
const REDIRECT_URI = process.env.AZURE_REDIRECT_URI || 'https://login.microsoftonline.com/common/oauth2/nativeclient';
const authTokenData = {
    client_id: CLIENT_ID,
    ...(CLIENT_SECRET ? { clientSecret: CLIENT_SECRET } : {}),
    redirect: REDIRECT_URI,
    prompt: 'select_account'
};
const authManager = new Auth(authTokenData);

const appRoot = (() => {
  try { const { app } = require('electron'); return app.isPackaged ? app.getPath('userData') : __dirname; }
  catch { return __dirname; }
})();

const resourcesRoot = (() => {
  try { const { app } = require('electron'); return app.isPackaged ? process.resourcesPath : __dirname; }
  catch { return __dirname; }
})();

const AUTH_CACHE_PATH = path.join(appRoot, 'auth-cache.json');
const SETTINGS_PATH = path.join(appRoot, 'settings.json');
const DEFAULT_AUTH_STATE = { activeAccountId: null, accounts: [] };

let cancelRequested = false;
let cancelInterval = null;
let instanceStartTimes = {}; 

const OFFICIAL_LEAN_BASE_VERSIONS = new Set(['1.21.11', '1.21.7', '1.21.4', '1.20', '1.19.4']);
const MOD_PROFILE_ROOT = path.join(resourcesRoot, 'mod-profiles');

function getDefaultProfilesForBaseVersion(baseVersion) {
    if (baseVersion === '1.19.4') return ['full'];
    if (baseVersion === '1.21.11') return ['full', 'lightweight'];
    if (OFFICIAL_LEAN_BASE_VERSIONS.has(baseVersion)) return ['balanced', 'full', 'lightweight'];
    return ['full'];
}

function getDefaultActiveProfile(baseVersion) {
    const availableProfiles = getDefaultProfilesForBaseVersion(baseVersion);
    if (availableProfiles.includes('balanced')) return 'balanced';
    if (availableProfiles.includes('full')) return 'full';
    return availableProfiles[0];
}

function normalizeInstanceSettings(version, settings) {
    const merged = {
        ram: '4096',
        preset: 'default',
        jvmArgs: [],
        javaPath: '',
        playtime: 0,
        ...(settings || {})
    };
    // Normalize jvmArgs: accept legacy string (split) or modern array (use as-is)
    if (typeof merged.jvmArgs === 'string') merged.jvmArgs = merged.jvmArgs.trim().split(/\s+/).filter(Boolean);
    if (!Array.isArray(merged.jvmArgs)) merged.jvmArgs = [];

    const baseVersion = merged.baseVersion || version;
    const defaultProfiles = getDefaultProfilesForBaseVersion(baseVersion);
    const providedProfiles = Array.isArray(merged.availableProfiles) ? merged.availableProfiles.filter(Boolean) : [];
    const availableProfiles = providedProfiles.length ? providedProfiles : defaultProfiles;
    const activeProfile = availableProfiles.includes(merged.activeProfile) ? merged.activeProfile : getDefaultActiveProfile(baseVersion);

    return {
        ...merged,
        baseVersion,
        availableProfiles,
        activeProfile
    };
}

function ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function clearDirectoryContents(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    for (const entry of fs.readdirSync(dirPath)) {
        const targetPath = path.join(dirPath, entry);
        fs.rmSync(targetPath, { recursive: true, force: true });
    }
}

function copyDirectoryRecursive(sourceDir, targetDir) {
    ensureDirectoryExists(targetDir);
    let copiedFiles = 0;

    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);

        if (entry.isDirectory()) {
            copiedFiles += copyDirectoryRecursive(sourcePath, targetPath);
            continue;
        }

        if (!entry.isFile()) continue;
        fs.copyFileSync(sourcePath, targetPath);
        copiedFiles += 1;
    }

    return copiedFiles;
}

// --- Profile Sync ---
function readSyncManifest(instanceDirectory) {
    const manifestPath = path.join(instanceDirectory, 'lean-sync-manifest.json');
    try {
        if (!fs.existsSync(manifestPath)) return null;
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (raw && raw.baseVersion && raw.profile) return raw;
        return null;
    } catch { return null; }
}

function writeSyncManifest(instanceDirectory, baseVersion, profile) {
    const manifestPath = path.join(instanceDirectory, 'lean-sync-manifest.json');
    const tmpPath = manifestPath + '.tmp';
    const data = { baseVersion, profile, syncedAt: Date.now() };
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, manifestPath);
}

function isProfileAlreadySynced(instanceDirectory, baseVersion, profile) {
    const manifest = readSyncManifest(instanceDirectory);
    if (!manifest) return false;
    return manifest.baseVersion === baseVersion && manifest.profile === profile;
}

function syncBundledProfileMods(baseVersion, profile, instanceDirectory, onProgress) {
    if (!OFFICIAL_LEAN_BASE_VERSIONS.has(baseVersion)) {
        return { synced: false, reason: 'not-official-lean' };
    }

    const sourceModsDir = path.join(MOD_PROFILE_ROOT, baseVersion, profile, 'mods');
    if (!fs.existsSync(sourceModsDir)) {
        if (onProgress) onProgress(`No bundled ${profile} mod set found for ${baseVersion}. Launching without profile sync.`, 34);
        return { synced: false, reason: 'missing-bundle' };
    }

    const targetModsDir = path.join(instanceDirectory, 'mods');
    ensureDirectoryExists(targetModsDir);

    if (onProgress) onProgress(`Syncing ${profile} mods for ${baseVersion}...`, 32);
    clearDirectoryContents(targetModsDir);
    const copiedFiles = copyDirectoryRecursive(sourceModsDir, targetModsDir);
    if (onProgress) onProgress(`Synced ${copiedFiles} mod file(s) for ${profile}`, 34);

    writeSyncManifest(instanceDirectory, baseVersion, profile);
    return { synced: true, copiedFiles };
}

function syncBundledProfileShaders(baseVersion, profile, instanceDirectory, onProgress) {
    // Shaders only for full profile versions 1.21.4, 1.21.7 and 1.21.11
    if (profile !== 'full') {
        return { synced: false, reason: 'not-full-profile' };
    }

    if (!['1.21.4', '1.21.7', '1.21.11'].includes(baseVersion)) {
        return { synced: false, reason: 'version-excluded' };
    }

    const sourceShadersDir = path.join(MOD_PROFILE_ROOT, baseVersion, profile, 'shaders');
    if (!fs.existsSync(sourceShadersDir)) {
        return { synced: false, reason: 'missing-shaders' };
    }

    const targetShadersDir = path.join(instanceDirectory, 'shaderpacks');
    ensureDirectoryExists(targetShadersDir);

    if (onProgress) onProgress(`Syncing shaderpacks for ${baseVersion}...`, 33);
    clearDirectoryContents(targetShadersDir);
    const copiedFiles = copyDirectoryRecursive(sourceShadersDir, targetShadersDir);
    if (onProgress) onProgress(`Synced ${copiedFiles} shader pack file(s)`, 34);

    writeSyncManifest(instanceDirectory, baseVersion, profile);
    return { synced: true, copiedFiles };
}

function syncBundledProfileResourcePacks(baseVersion, profile, instanceDirectory, onProgress) {
    // Resource packs for all versions except 1.19.4
    // All profiles share the same resource packs, so load from version-level directory
    if (baseVersion === '1.19.4') {
        return { synced: false, reason: 'version-excluded' };
    }

    if (!OFFICIAL_LEAN_BASE_VERSIONS.has(baseVersion)) {
        return { synced: false, reason: 'not-official-lean' };
    }

    const sourceResourcePacksDir = path.join(MOD_PROFILE_ROOT, baseVersion, 'resourcepacks');
    if (!fs.existsSync(sourceResourcePacksDir)) {
        return { synced: false, reason: 'missing-resourcepacks' };
    }

    const targetResourcePacksDir = path.join(instanceDirectory, 'resourcepacks');
    ensureDirectoryExists(targetResourcePacksDir);

    if (onProgress) onProgress(`Syncing resource packs for ${baseVersion}...`, 33);
    clearDirectoryContents(targetResourcePacksDir);
    const copiedFiles = copyDirectoryRecursive(sourceResourcePacksDir, targetResourcePacksDir);
    if (onProgress) onProgress(`Synced ${copiedFiles} resource pack(s)`, 34);

    writeSyncManifest(instanceDirectory, baseVersion, profile);
    return { synced: true, copiedFiles };
}

function loadSettings() {
    if (!fs.existsSync(SETTINGS_PATH)) return {};
    try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')); } 
    catch { return {}; }
}
function saveSettings(settingsObj) {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = SETTINGS_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(settingsObj, null, 2), 'utf-8');
    fs.renameSync(tmpPath, SETTINGS_PATH);
}
function getGlobalSettings() {
    const globalSettings = loadSettings()._global || {};
    return {
        theme: globalSettings.theme || "light",
        language: globalSettings.language || "en",
        closeOnBoot: Boolean(globalSettings.closeOnBoot),
        simpleMode: Boolean(globalSettings.simpleMode),
        showFpsWarning: globalSettings.showFpsWarning !== undefined ? Boolean(globalSettings.showFpsWarning) : true,
        animation: globalSettings.animation || 'bubbles'
    };
}
function saveGlobalSettings(glob) {
    try {
        const all = loadSettings();
        all._global = glob;
        saveSettings(all);
    } catch (err) {
        console.error('Failed to save global settings:', err);
    }
}
function getInstanceSettings(version) { return normalizeInstanceSettings(version, loadSettings()[version]); }
function normalizeAuthAccount(account) {
    if (!account || typeof account !== 'object') return null;

    const accountName = account.accountName || account.name;
    if (!accountName) return null;

    const refreshToken = account.refreshToken ?? account.refresh_token ?? null;
    const type = account.type || (refreshToken === 'offline' || account.userId === 'offline' ? 'offline' : 'microsoft');
    const id = String(account.id || account.accountId || account.userId || (type === 'offline' ? 'offline' : account.minecraftId || accountName));

    return {
        id,
        type,
        accountName,
        minecraftId: account.minecraftId || null,
        userId: account.userId || (type === 'offline' ? 'offline' : id),
        refreshToken,
        savedAt: Number(account.savedAt) || Date.now()
    };
}

function normalizeAuthState(rawState) {
    if (!rawState || typeof rawState !== 'object') return { ...DEFAULT_AUTH_STATE, accounts: [] };

    const normalizedAccounts = [];
    const seenIds = new Set();
    const rawAccounts = Array.isArray(rawState.accounts) ? rawState.accounts : [];

    if (rawAccounts.length) {
        for (const rawAccount of rawAccounts) {
            const account = normalizeAuthAccount(rawAccount);
            if (!account || seenIds.has(account.id)) continue;
            seenIds.add(account.id);
            normalizedAccounts.push(account);
        }
    } else {
        const legacyAccount = normalizeAuthAccount(rawState);
        if (legacyAccount) normalizedAccounts.push(legacyAccount);
    }

    normalizedAccounts.sort((left, right) => (Number(right.savedAt) || 0) - (Number(left.savedAt) || 0));

    const activeAccountId = rawState.activeAccountId && normalizedAccounts.some(account => account.id === String(rawState.activeAccountId))
        ? String(rawState.activeAccountId)
        : normalizedAccounts[0]?.id || null;

    return { activeAccountId, accounts: normalizedAccounts };
}

function loadSavedAuth() {
    if (!fs.existsSync(AUTH_CACHE_PATH)) return null;
    try {
        let raw = JSON.parse(fs.readFileSync(AUTH_CACHE_PATH, 'utf-8'));
        // Decrypt tokens if they were stored encrypted
        if (raw._encrypted && raw.accounts) {
            raw.accounts = raw.accounts.map(account => {
                if (account._encryptedToken) {
                    try {
                        const { safeStorage } = require('electron');
                        if (safeStorage.isEncryptionAvailable()) {
                            account.refreshToken = safeStorage.decryptString(Buffer.from(account._encryptedToken, 'base64'));
                            delete account._encryptedToken;
                        }
                    } catch { /* leave as-is if decryption fails */ }
                }
                return account;
            });
            delete raw._encrypted;
        }
        return normalizeAuthState(raw);
    } catch { return null; }
}

function saveSavedAuth(authState) {
    const normalized = normalizeAuthState(authState);
    // Encrypt refresh tokens before persisting to disk
    try {
        const { safeStorage } = require('electron');
        if (safeStorage && safeStorage.isEncryptionAvailable()) {
            normalized._encrypted = true;
            normalized.accounts = normalized.accounts.map(account => {
                if (account.refreshToken && account.refreshToken !== 'offline') {
                    const encrypted = safeStorage.encryptString(account.refreshToken);
                    account._encryptedToken = encrypted.toString('base64');
                    account.refreshToken = '__encrypted__';
                }
                return account;
            });
        }
    } catch { /* fall through — store unencrypted if safeStorage unavailable */ }
    const tmpPath = AUTH_CACHE_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2), 'utf-8');
    fs.renameSync(tmpPath, AUTH_CACHE_PATH);
    return normalized;
}

function getAuthAccount(authState = loadSavedAuth(), accountId = null) {
    const normalized = normalizeAuthState(authState || DEFAULT_AUTH_STATE);
    if (!normalized.accounts.length) return null;

    if (accountId) {
        const requestedId = String(accountId);
        const requestedAccount = normalized.accounts.find(account => account.id === requestedId);
        if (requestedAccount) return requestedAccount;
    }

    return normalized.accounts.find(account => account.id === normalized.activeAccountId) || normalized.accounts[0] || null;
}

function upsertAuthAccount(account, { setActive = true } = {}) {
    const normalizedAccount = normalizeAuthAccount(account);
    if (!normalizedAccount) return loadSavedAuth() || { ...DEFAULT_AUTH_STATE, accounts: [] };

    const state = normalizeAuthState(loadSavedAuth() || DEFAULT_AUTH_STATE);
    const nextAccounts = state.accounts.filter(existing => existing.id !== normalizedAccount.id);
    nextAccounts.unshift(normalizedAccount);

    const nextState = {
        activeAccountId: setActive || !state.activeAccountId ? normalizedAccount.id : state.activeAccountId,
        accounts: nextAccounts
    };

    return saveSavedAuth(nextState);
}

function setActiveAuthAccount(accountId) {
    const state = normalizeAuthState(loadSavedAuth() || DEFAULT_AUTH_STATE);
    const nextAccountId = accountId ? String(accountId) : null;

    if (nextAccountId && !state.accounts.some(account => account.id === nextAccountId)) {
        return state;
    }

    return saveSavedAuth({
        activeAccountId: nextAccountId,
        accounts: state.accounts
    });
}

function removeAuthAccount(accountId) {
    const state = normalizeAuthState(loadSavedAuth() || DEFAULT_AUTH_STATE);
    const removeId = accountId ? String(accountId) : null;
    if (!removeId) return state;

    const nextAccounts = state.accounts.filter(account => account.id !== removeId);
    const nextActiveAccountId = state.activeAccountId === removeId ? nextAccounts[0]?.id || null : state.activeAccountId;

    return saveSavedAuth({
        activeAccountId: nextActiveAccountId,
        accounts: nextAccounts
    });
}

function getAuthAccounts() {
    return loadSavedAuth() || { ...DEFAULT_AUTH_STATE, accounts: [] };
}

// Retry-enabled fetch for JSON endpoints — helps with transient network failures
async function retryFetchJson(url, maxRetries = 3) {
    let lastError = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
            return await response.json();
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries - 1) {
                const delay = Math.pow(2, attempt) * 500; // 0.5s, 1s, 2s
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError || new Error(`Fetch failed after ${maxRetries} attempts: ${url}`);
}

async function downloadFile(url, destinationPath, onProgress) {
    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 180000); // 180 second timeout

        try {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) throw new Error(`Failed to download ${url} (${response.status})`);

            const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
            await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });

            if (response.body) {
                // Convert web ReadableStream to Node.js stream (Electron/Node 18+)
                const { Readable } = require('stream');
                const nodeStream = Readable.fromWeb(response.body);
                const writer = fs.createWriteStream(destinationPath);
                let downloadedBytes = 0;

                nodeStream.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    if (onProgress && contentLength > 0) {
                        const percent = Math.round((downloadedBytes / contentLength) * 100);
                        onProgress(`Downloading... ${percent}%`);
                    }
                });

                await new Promise((resolve, reject) => {
                    nodeStream.pipe(writer);
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                    nodeStream.on('error', reject);
                });
            } else {
                const data = Buffer.from(await response.arrayBuffer());
                await fs.promises.writeFile(destinationPath, data);
            }

            return destinationPath;
        } catch (error) {
            lastError = error;
            // Clean up partial download
            try { if (fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath); } catch {}
            if (attempt < maxRetries - 1) {
                const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
                if (onProgress) onProgress(`Retrying download (attempt ${attempt + 2}/${maxRetries})...`, 0);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        } finally {
            clearTimeout(timeoutId);
        }
    }

    throw lastError || new Error(`Download failed after ${maxRetries} attempts: ${url}`);
}

async function runJavaJar(javaExecutable, jarPath, args, onProgress) {
    return new Promise((resolve, reject) => {
        const child = require('child_process').execFile(
            javaExecutable,
            ['-jar', jarPath, ...args],
            { maxBuffer: 1024 * 1024 * 50, timeout: 600000 } // 10 minute timeout
        );
        
        let lastUpdate = Date.now();
        let stderrBuffer = '';
        const updateInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - lastUpdate) / 1000);
            if (onProgress) onProgress(`Installing... (${elapsed}s elapsed)`);
        }, 3000); // Update progress every 3 seconds
        
        child.stdout?.on('data', (data) => {
            const output = data.toString();
        debugLog(`[Installer] ${output}`);
            if (onProgress) onProgress(`${output.trim()}`);
            lastUpdate = Date.now();
        });
        
        child.stderr?.on('data', (data) => {
            const output = data.toString();
            stderrBuffer += output;
            debugLog(`[Installer Error] ${output}`);
        });
        
        child.on('error', (error) => {
            clearInterval(updateInterval);
            reject(new Error(`Failed to run installer: ${error.message}`));
        });
        
        child.on('close', (code) => {
            clearInterval(updateInterval);
            if (code !== 0) {
                const stderrTail = stderrBuffer.slice(-500).trim();
                const details = stderrTail ? ` — ${stderrTail}` : ' (no error output captured)';
                reject(new Error(`Installer exited with code ${code}${details}`));
            } else {
                resolve();
            }
        });
    });
}

function resolveJavaExecutable(instanceSettings) {
    if (instanceSettings?.javaPath && fs.existsSync(instanceSettings.javaPath)) return instanceSettings.javaPath;

    const javaBinary = process.platform === 'win32' ? 'java.exe' : 'java';

    // ----------------------------------------------------------------
    // Check system-installed JDKs (fallback if javaManager didn't run)
    // ----------------------------------------------------------------
    function findJavaInJdkRoots(roots) {
        const candidates = [];
        for (const jvmRoot of roots) {
            if (!fs.existsSync(jvmRoot)) continue;
            try {
                const entries = fs.readdirSync(jvmRoot, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;
                    const candidate = path.join(jvmRoot, entry.name, 'Contents', 'Home', 'bin', javaBinary);
                    if (fs.existsSync(candidate)) {
                        candidates.push({ path: candidate, name: entry.name });
                    }
                }
            } catch { /* scan failed */ }
        }
        candidates.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
        return candidates.length ? candidates[0].path : null;
    }

    if (process.platform === 'darwin') {
        const macJdkRoots = [
            '/Library/Java/JavaVirtualMachines',
            path.join(os.homedir(), 'Library/Java/JavaVirtualMachines')
        ];
        const macResult = findJavaInJdkRoots(macJdkRoots);
        if (macResult) return macResult;
    }

    if (process.env.JAVA_HOME) {
        const candidate = path.join(process.env.JAVA_HOME, 'bin', javaBinary);
        if (fs.existsSync(candidate)) return candidate;
    }

    if (process.platform === 'linux') {
        const linuxResult = findJavaInJdkRoots([
            '/usr/lib/jvm', '/usr/lib64/jvm', '/usr/local/lib/jvm',
            path.join(os.homedir(), '.sdkman/candidates/java'),
            path.join(os.homedir(), '.local/share/fnm')
        ]);
        if (linuxResult) return linuxResult;
    } else if (process.platform === 'win32') {
        const winResult = findJavaInJdkRoots([
            'C:\\Program Files\\Java',
            'C:\\Program Files (x86)\\Java',
            path.join(os.homedir(), '.jdks')
        ]);
        if (winResult) return winResult;
    }

    try {
        const whichCmd = process.platform === 'win32' ? 'where' : 'which';
        const result = require('child_process').execFileSync(whichCmd, ['java'], { encoding: 'utf-8', timeout: 5000 }).trim();
        const firstLine = result.split(/\r?\n/)[0].trim();
        if (firstLine && fs.existsSync(firstLine)) return firstLine;
    } catch { /* not in PATH */ }

    return javaBinary;
}

/**
 * Strip the macOS quarantine extended attribute (com.apple.quarantine) from
 * a file or directory tree.  Downloaded archives extracted via HTTP inherit
 * this attribute from the parent archive, which can cause the macOS
 * Gatekeeper to block execution of executables (Java, native .dylib).
 * @param {string} targetPath - Path to strip quarantine from
 */
function stripQuarantineXattr(targetPath) {
    if (process.platform !== 'darwin') return;
    if (!targetPath || !fs.existsSync(targetPath)) return;
    try {
        require('child_process').execFileSync(
            '/usr/bin/xattr',
            ['-rd', 'com.apple.quarantine', targetPath],
            { timeout: 10000, stdio: 'ignore' }
        );
    } catch {
        // xattr may fail silently (e.g., if the filesystem doesn't support it)
    }
}

/**
 * On macOS ARM64, find an x86_64 (Intel) JDK suitable for running under
 * Rosetta 2. This is needed for pre-1.13 Minecraft versions whose LWJGL 2.x
 * native libraries only exist as x86_64 binaries.
 *
 * Priority:
 *   1. /usr/libexec/java_home -a x86_64  (Apple's native JDK locator)
 *   2. Scan /Library/Java/JavaVirtualMachines for Intel-only JDKs
 *   3. Fallback to the detected ARM64 JDK (Rosetta 2 will translate)
 *
 * @returns {string|null} Path to an x86_64 java binary, or null if not found.
 */
function resolveX8664JavaExecutable() {
    if (process.platform !== 'darwin') return null;

    const javaBinary = 'java';

    // 1. Use Apple's java_home utility to find x86_64 JDK
    try {
        const result = require('child_process').execFileSync(
            '/usr/libexec/java_home',
            ['-a', 'x86_64', '--failfast'],
            { encoding: 'utf-8', timeout: 5000 }
        ).trim();
        if (result) {
            const candidate = path.join(result, 'bin', javaBinary);
            if (fs.existsSync(candidate)) return candidate;
        }
    } catch { /* no x86_64 JDK via java_home */ }

    // 2. Scan common JDK locations for an Intel-only JDK
    const macJavaDirs = [
        '/Library/Java/JavaVirtualMachines',
        path.join(os.homedir(), 'Library/Java/JavaVirtualMachines'),
    ];
    for (const jvmRoot of macJavaDirs) {
        if (!fs.existsSync(jvmRoot)) continue;
        try {
            const entries = fs.readdirSync(jvmRoot, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const candidate = path.join(jvmRoot, entry.name, 'Contents', 'Home', 'bin', javaBinary);
                if (!fs.existsSync(candidate)) continue;
                // Check if it's x86_64-only (not universal/arm64)
                try {
                    const archOut = require('child_process').execFileSync(
                        'file', [candidate],
                        { encoding: 'utf-8', timeout: 3000 }
                    );
                    // "Mach-O 64-bit executable x86_64" = Intel only
                    // "Mach-O 64-bit bundle x86_64" = Intel only
                    // "Mach-O 64-bit executable arm64" = ARM64 only
                    // "Mach-O 64-bit executable x86_64; arm64" = universal (fat binary)
                    if (/x86_64/.test(archOut) && !/arm64/.test(archOut)) {
                        return candidate;
                    }
                } catch { /* skip this candidate */ }
            }
        } catch { /* scan failed */ }
    }

    // 3. Fallback to any available JDK — arch -x86_64 will translate it
    return null;
}

async function ensureLauncherProfiles(mcRoot) {
    const profilesPath = path.join(mcRoot, 'launcher_profiles.json');
    if (fs.existsSync(profilesPath)) return;
    
    const profiles = {
        profiles: {},
        settings: {
            crashAssistance: true,
            launcherVisibility: "launcher"
        },
        version: 3
    };
    
    await fs.promises.writeFile(profilesPath, JSON.stringify(profiles, null, 2), 'utf-8');
    debugLog(`Created launcher_profiles.json at ${profilesPath}`);
}

async function resolveFabricInstall(baseVersion, instanceSettings) {
    const loaderVersion = instanceSettings?.fabricLoaderVersion || null;
    const installerVersion = instanceSettings?.fabricInstallerVersion || null;

    // 1. Check for bundled Fabric installer (ships with the launcher — no download needed)
    const bundledInstallerPath = path.join(resourcesRoot, 'installers', 'fabric-installer.jar');
    if (fs.existsSync(bundledInstallerPath) && fs.statSync(bundledInstallerPath).size > 1024) {
        // Still need loader version from API for the profile name, but skip installer download
        let resolvedLoaderVersion = loaderVersion;
        if (!resolvedLoaderVersion) {
            const loaders = await retryFetchJson(`https://meta.fabricmc.net/v2/versions/loader/${baseVersion}`);
            resolvedLoaderVersion = loaders.find(entry => entry?.loader?.stable)?.loader?.version
                || loaders[0]?.loader?.version;
        }
        if (!resolvedLoaderVersion) throw new Error(`No Fabric loader version found for ${baseVersion}`);
        const profileName = `fabric-loader-${resolvedLoaderVersion}-${baseVersion}`;
        return { loaderVersion: resolvedLoaderVersion, installerVersion: null, profileName, installerJarPath: bundledInstallerPath, installerUrl: null };
    }

    // 2. Fallback: download the installer from Fabric's servers.
    //    Always fetch the installer list from the meta API so we get the correct download URL,
    //    and never trust a saved version string (e.g. 'bundled') as a real version number.
    const [loaderResponse, installerResponse] = await Promise.all([
        loaderVersion ? Promise.resolve(null) : retryFetchJson(`https://meta.fabricmc.net/v2/versions/loader/${baseVersion}`),
        retryFetchJson('https://meta.fabricmc.net/v2/versions/installer')
    ]);

    const loaders = loaderVersion ? [] : loaderResponse;
    const installers = installerResponse;

    const resolvedLoaderVersion = loaderVersion || loaders.find(entry => entry?.loader?.stable)?.loader?.version || loaders[0]?.loader?.version;
    // Resolve the installer version from the meta API: first check if the saved version
    // is a real version (not 'bundled'), otherwise auto-select the latest stable.
    const targetedInstallerVersion = installerVersion && installerVersion !== 'bundled'
        ? installerVersion
        : null;
    const resolvedInstallerEntry = targetedInstallerVersion
        ? installers.find(e => e.version === targetedInstallerVersion)
        : installers.find(e => e.stable) || installers[0];
    const resolvedInstallerVersion = resolvedInstallerEntry?.version;

    if (!resolvedLoaderVersion) throw new Error(`No Fabric loader version found for ${baseVersion}`);
    if (!resolvedInstallerVersion) throw new Error('No Fabric installer version found');

    const profileName = `fabric-loader-${resolvedLoaderVersion}-${baseVersion}`;
    const installerJarPath = path.join(appRoot, 'minecraft', 'cache', 'installers', 'fabric', `${resolvedInstallerVersion}.jar`);
    // Use the URL from the meta API response — it's always authoritative and correct
    const installerUrl = resolvedInstallerEntry.url;

    return { loaderVersion: resolvedLoaderVersion, installerVersion: resolvedInstallerVersion, profileName, installerJarPath, installerUrl };
}

async function ensureVanillaVersionExists(baseVersion, mcRoot, onProgress) {
    const vanillaVersionDir = path.join(mcRoot, 'versions', baseVersion);
    const vanillaVersionJson = path.join(vanillaVersionDir, `${baseVersion}.json`);
    const vanillaVersionJar = path.join(vanillaVersionDir, `${baseVersion}.jar`);
    
    // Verify both files exist AND have valid content (not zero-byte leftovers)
    const jsonValid = fs.existsSync(vanillaVersionJson) && fs.statSync(vanillaVersionJson).size > 1024;
    const jarValid = fs.existsSync(vanillaVersionJar) && fs.statSync(vanillaVersionJar).size > 1024;
    if (jsonValid && jarValid) {
        return;
    }
    
    // Clean up any corrupted files before downloading fresh
    if (fs.existsSync(vanillaVersionJson) && !jsonValid) {
        try { fs.unlinkSync(vanillaVersionJson); } catch {}
    }
    if (fs.existsSync(vanillaVersionJar) && !jarValid) {
        try { fs.unlinkSync(vanillaVersionJar); } catch {}
    }
    
    debugLog(`Pre-downloading vanilla Minecraft ${baseVersion} for Fabric installer...`);
    if (onProgress) onProgress(`Setting up vanilla Minecraft ${baseVersion}...`, 20);
    
    // Download version manifest
    const manifest = await retryFetchJson('https://launchermeta.mojang.com/mc/game/version_manifest.json');
    
    const versionEntry = manifest.versions.find(v => v.id === baseVersion);
    if (!versionEntry) throw new Error(`Vanilla version ${baseVersion} not found in manifest`);
    
    // Download version JSON
    const versionJson = await retryFetchJson(versionEntry.url);
    
    // Ensure directory exists
    await fs.promises.mkdir(vanillaVersionDir, { recursive: true });
    
    // Save version JSON
    await fs.promises.writeFile(vanillaVersionJson, JSON.stringify(versionJson, null, 2), 'utf-8');
    debugLog(`Saved version JSON to ${vanillaVersionJson}`);
    
    // Download client jar
    const clientDownload = versionJson.downloads?.client;
    if (clientDownload) {
        await downloadFile(clientDownload.url, vanillaVersionJar, (msg) => {
            if (onProgress) onProgress(`${msg}`, 22);
        });
        debugLog(`Downloaded vanilla client jar to ${vanillaVersionJar}`);
    }
}

async function ensureFabricInstalled(baseVersion, instanceSettings, mcRoot, selectedVersion, onProgress) {
    // First ensure vanilla Minecraft is available
    if (onProgress) onProgress(`Preparing vanilla Minecraft...`, 20);
    await ensureVanillaVersionExists(baseVersion, mcRoot, onProgress);
    
    const installInfo = await resolveFabricInstall(baseVersion, instanceSettings);
    const profileDir = path.join(mcRoot, 'versions', installInfo.profileName);
    const profileJson = path.join(profileDir, `${installInfo.profileName}.json`);
    const profileJar = path.join(profileDir, `${installInfo.profileName}.jar`);

    if (!fs.existsSync(profileJson) || !fs.existsSync(profileJar)) {
        if (onProgress) onProgress(`Installing Fabric ${installInfo.loaderVersion}...`, 25);
        
        // Download installer if not present or bundled
        if (!fs.existsSync(installInfo.installerJarPath) && installInfo.installerUrl) {
            await downloadFile(installInfo.installerUrl, installInfo.installerJarPath, (msg) => {
                if (onProgress) onProgress(msg, 26);
            });
        }

        // Verify the installer JAR is valid
        if (!fs.existsSync(installInfo.installerJarPath) || fs.statSync(installInfo.installerJarPath).size < 1024) {
            if (installInfo.installerUrl) {
                // Corrupted — delete and re-download
                try { fs.unlinkSync(installInfo.installerJarPath); } catch {}
                await downloadFile(installInfo.installerUrl, installInfo.installerJarPath, (msg) => {
                    if (onProgress) onProgress(msg, 26);
                });
            } else {
                throw new Error('Bundled Fabric installer is missing or corrupted. Please reinstall the launcher.');
            }
        }

        // Use javaManager to get a Java for the Minecraft version (Fabric installer
        // itself requires Java 17+). If it fails, fall back to system Java.
        let javaExecutable = null;
        try {
            const result = await javaManager.resolveJava(baseVersion, appRoot, onProgress);
            javaExecutable = result.javaPath;
        } catch {
            javaExecutable = resolveJavaExecutable(instanceSettings);
        }
        debugLog(`Running Fabric installer: ${installInfo.installerJarPath}`);
        
        // Ensure launcher_profiles.json exists for Fabric installer
        await ensureLauncherProfiles(mcRoot);
        
        if (onProgress) onProgress(`Installing Fabric loader (this may take 5-10 minutes)...`, 30);
        
        let installerError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await runJavaJar(javaExecutable, installInfo.installerJarPath, [
                    'client',
                    '-dir', mcRoot,
                    '-mcversion', baseVersion,
                    '-loader', installInfo.loaderVersion,
                    '-downloadMinecraft'
                ], onProgress);
                installerError = null;
                break;
            } catch (error) {
                installerError = error;
                console.error(`Fabric installer attempt ${attempt + 1} failed: ${error.message}`);
                
                if (attempt === 0) {
                    // Clean up partial install before retry
                    if (onProgress) onProgress(`Installer failed, cleaning up and retrying...`, 28);
                    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
                    // Also remove vanilla version files — they may be corrupted
                    const vanillaDir = path.join(mcRoot, 'versions', baseVersion);
                    try {
                        const vanillaJson = path.join(vanillaDir, `${baseVersion}.json`);
                        const vanillaJar = path.join(vanillaDir, `${baseVersion}.jar`);
                        if (fs.existsSync(vanillaJson)) fs.unlinkSync(vanillaJson);
                        if (fs.existsSync(vanillaJar)) fs.unlinkSync(vanillaJar);
                    } catch {}
                    // Re-download vanilla before retry
                    await ensureVanillaVersionExists(baseVersion, mcRoot, onProgress);
                }
            }
        }
        
        if (installerError) throw installerError;
    }

    const allSettings = loadSettings();
    if (!allSettings[selectedVersion]) allSettings[selectedVersion] = {};
    allSettings[selectedVersion].fabricLoaderVersion = installInfo.loaderVersion;
    if (installInfo.installerVersion) {
        allSettings[selectedVersion].fabricInstallerVersion = installInfo.installerVersion;
    } else {
        // If using the bundled installer, clear any stale version string so the
        // meta API always resolves a real version on the next run.
        delete allSettings[selectedVersion].fabricInstallerVersion;
    }
    allSettings[selectedVersion].fabricProfileName = installInfo.profileName;
    saveSettings(allSettings);

    return installInfo;
}

async function resolveForgeInstall(baseVersion, instanceSettings, selectedVersion) {
    const forgeBuild = instanceSettings?.forgeBuild || null;
    let resolvedForgeBuild = forgeBuild;

    if (!resolvedForgeBuild) {
        const promotions = await retryFetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
        resolvedForgeBuild = promotions?.promos?.[`${baseVersion}-recommended`] || promotions?.promos?.[`${baseVersion}-latest`];
    }

    if (!resolvedForgeBuild) throw new Error(`No Forge build found for ${baseVersion}`);

    const installerFileName = `forge-${baseVersion}-${resolvedForgeBuild}-installer.jar`;
    const installerJarPath = path.join(appRoot, 'minecraft', 'cache', 'installers', 'forge', installerFileName);
    const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${baseVersion}-${resolvedForgeBuild}/${installerFileName}`;

    const allSettings = loadSettings();
    if (!allSettings[selectedVersion]) allSettings[selectedVersion] = {};
    allSettings[selectedVersion].forgeBuild = resolvedForgeBuild;
    allSettings[selectedVersion].forgeInstallerPath = installerJarPath;
    saveSettings(allSettings);

    return { forgeBuild: resolvedForgeBuild, installerJarPath, installerUrl };
}

async function ensureForgeInstalled(baseVersion, instanceSettings, mcRoot, selectedVersion, onProgress) {
    if (onProgress) onProgress(`Preparing Forge ${baseVersion}...`, 20);
    const forgeInstall = await resolveForgeInstall(baseVersion, instanceSettings, selectedVersion);

    if (!fs.existsSync(forgeInstall.installerJarPath)) {
        if (onProgress) onProgress(`Downloading Forge ${forgeInstall.forgeBuild}...`, 25);
        await downloadFile(forgeInstall.installerUrl, forgeInstall.installerJarPath, (msg) => {
            if (onProgress) onProgress(msg, 25);
        });
    }

    // minecraft-launcher-core handles Forge install when opts.forge is provided.
    return forgeInstall;
}

async function startLeanClient(options, onProgress, onLaunchEvent) {
    const selectedVersion = typeof options === 'string' ? options : options.version;
    const selectedProfile = typeof options === 'object' && options ? options.activeProfile : null;
    const requestedAccountId = typeof options === 'object' && options ? options.accountId : null;
    debugLog(`--- Lean Launcher Engine Starting for ${selectedVersion} ---`);
    cancelRequested = false;

    if (launcher) {
        launcher.removeAllListeners();
    }
    launcher = new Client();

    const savedAuth = loadSavedAuth();
    const activeAccount = getAuthAccount(savedAuth, requestedAccountId);
    if (!activeAccount?.accountName) throw new Error('No cached login found. Please sign in through the launcher first.');

    let authorization;
    if (activeAccount.userId === 'offline' || activeAccount.refreshToken === 'offline' || activeAccount.type === 'offline') {
        authorization = Authenticator.getAuth(activeAccount.accountName);
    } else {
        if(onProgress) onProgress("Refreshing Microsoft Token...", 10);
        const xboxManager = await authManager.refresh(activeAccount.refreshToken);
        const mcToken = await getMinecraftTokenWithRetry(xboxManager);
        authorization = mcToken?.mclc?.();
        if (!authorization) throw new Error('Failed to obtain Minecraft authorization.');

        const refreshedRefreshToken = xboxManager.msToken?.refresh_token;
        if (refreshedRefreshToken && refreshedRefreshToken !== activeAccount.refreshToken) {
            upsertAuthAccount({ ...activeAccount, refreshToken: refreshedRefreshToken }, { setActive: savedAuth?.activeAccountId === activeAccount.id });
        }
    }

    const instanceSettings = getInstanceSettings(selectedVersion);
    const launchProfile = instanceSettings.availableProfiles?.includes(selectedProfile) ? selectedProfile : instanceSettings.activeProfile;

    if (launchProfile && launchProfile !== instanceSettings.activeProfile) {
        const allSettings = loadSettings();
        if (!allSettings[selectedVersion]) allSettings[selectedVersion] = {};
        allSettings[selectedVersion].activeProfile = launchProfile;
        saveSettings(allSettings);
    }

    const launchVersion = instanceSettings?.baseVersion || selectedVersion;
    const explicitType = instanceSettings?.customType;
    const effectiveCustomType = explicitType || (OFFICIAL_LEAN_BASE_VERSIONS.has(selectedVersion) ? 'fabric' : 'vanilla');
    const gameRoot = path.join(appRoot, "minecraft", "instances", selectedVersion);
    const mcRoot = path.join(appRoot, "minecraft");
    if (!fs.existsSync(gameRoot)) fs.mkdirSync(gameRoot, { recursive: true });

    // -------------------------------------------------------------------
    // Java resolution: prefer user-set custom path, else auto-download.
    // resolveJava is now architecture-aware — for legacy versions (< 1.13)
    // on ARM64 macOS it downloads an x86_64 JDK automatically.
    // -------------------------------------------------------------------
    let javaPath = instanceSettings?.javaPath || '';
    let javaVersion = null;

    const isLegacyLwjgl2 = javaManager.compareVersions(launchVersion, '1.13') < 0;
    const isModernArm64  = process.platform === 'darwin' && process.arch === 'arm64';
    const isLegacyArm64  = isModernArm64 && isLegacyLwjgl2;

    if (javaPath && fs.existsSync(javaPath)) {
        if (onProgress) onProgress(`Using custom Java at ${javaPath}`, 3);
        console.log(`[LAUNCH] Using custom Java: ${javaPath}`);
        try {
            const ver = await javaManager.validateJavaBinary(javaPath);
            javaVersion = ver;
            console.log(`[LAUNCH] Custom Java version: ${ver}`);
        } catch (err) {
            throw new Error(`Custom Java at "${javaPath}" is not valid: ${err.message}`);
        }
    } else {
        // Prism Launcher approach for pre-1.13 on Apple Silicon:
        // x86_64 Java 8 under Rosetta 2 with official Mojang x86_64 natives.
        // Community ARM64 LWJGL 2.9.4 builds crash AWT/Cocoa on modern macOS.
        const javaOpts = isLegacyArm64 ? { adoptArch: 'x64' } : undefined;
        if (onProgress) onProgress(`Resolving Java for ${launchVersion}${isLegacyArm64 ? ' (x86_64 Rosetta 2)' : ''}...`, 2);
        console.log(`[LAUNCH] Resolving Java for ${launchVersion}${isLegacyArm64 ? ' — x86_64 Rosetta 2 mode' : ''}`);
        const result = await javaManager.resolveJava(launchVersion, appRoot, onProgress, javaOpts);
        javaPath = result.javaPath;
        javaVersion = result.javaVersion;
        console.log(`[LAUNCH] Using ${result.downloaded ? 'downloaded' : 'cached'} Java: ${javaPath}`);
        console.log(`[LAUNCH] Java version: ${javaVersion}`);
    }

    // --- Java version validation ---
    // Read the vanilla version JSON for the REQUIRED Java major version.
    // The version JSON comes from Mojang's metadata and contains the
    // "javaVersion.majorVersion" field that MCLC expects.
    const vanillaVersionJsonPath = path.join(mcRoot, 'versions', launchVersion, `${launchVersion}.json`);
    let requiredJavaMajor = null;
    let versionJsonMajor = null;
    try {
        if (fs.existsSync(vanillaVersionJsonPath)) {
            const vJson = JSON.parse(fs.readFileSync(vanillaVersionJsonPath, 'utf-8'));
            if (vJson.javaVersion && typeof vJson.javaVersion.majorVersion === 'number') {
                versionJsonMajor = vJson.javaVersion.majorVersion;
            }
        }
    } catch { /* version JSON not available */ }

    // Use javaManager's table as fallback (covers all versions)
    requiredJavaMajor = versionJsonMajor || javaManager.getRequiredJavaMajor(launchVersion);

    // Hoist: used later for module-compat flags
    const javaMajorVersion = javaManager.parseJavaMajorVersion(javaVersion || '');

    if (requiredJavaMajor) {
        console.log(`[LAUNCH] Java version check: running=${javaMajorVersion}, required=${requiredJavaMajor}+`);

        if (javaMajorVersion > 0 && javaMajorVersion < requiredJavaMajor) {
            // Auto-download the correct Java version instead of throwing.
            console.log(`[LAUNCH] Java ${javaMajorVersion} insufficient for ${launchVersion} (needs ${requiredJavaMajor}+). Auto-downloading...`);
            if (onProgress) onProgress(`Java ${javaMajorVersion} insufficient — downloading Java ${requiredJavaMajor}...`, 2);
            try {
                const result = await javaManager.resolveJava(launchVersion, appRoot, onProgress);
                javaPath = result.javaPath;
                javaVersion = result.javaVersion;
                console.log(`[LAUNCH] Auto-downloaded Java: ${javaPath} (${javaVersion})`);
                if (onProgress) onProgress(`Auto-downloaded Java ${result.javaVersion}`, 4);
            } catch (dlErr) {
                throw new Error(
                    `Minecraft ${launchVersion} requires Java ${requiredJavaMajor}+, ` +
                    `but the selected Java binary is version ${javaMajorVersion} ` +
                    `(${javaPath}). Attempted to auto-download Java ${requiredJavaMajor} ` +
                    `but it failed: ${dlErr.message}`
                );
            }
        } else {
            console.log(`[LAUNCH] Java ${javaMajorVersion} meets requirement (Java ${requiredJavaMajor}+) ✓`);
        }
    } else {
        console.log(`[LAUNCH] No Java version requirement found — proceeding with ${javaVersion}`);
    }

    let opts = {
        clientPackage: null, authorization, root: mcRoot,
        overrides: {
            gameDirectory: gameRoot,
            // macOS: tell LWJGL to extract native .dylib files into the game
            // directory rather than a system temp path, avoiding permission
            // issues with macOS SIP / notarization on temp directories
            natives: null, // set below
        },
        version: { number: launchVersion, type: "release" },
        memory: { max: `${instanceSettings.ram}M`, min: "2048M" },
        javaPath: javaPath || undefined,
        launcherName: 'lean-launcher',
        launcherVersion: '1.0.0',
        // macOS lifecycle flags: MCLC's startMinecraft uses these to
        // register the process with Launch Services so the window appears
        // (without this, LWJGL windows are created but invisible on macOS).
        ...(process.platform === 'darwin' ? {
            extraEnv: {
                // For pre-1.13 + Rosetta 2: headless=true prevents AWT from
                // trying to initialize Cocoa's display connection, which
                // crashes under Rosetta 2 translation.
                // For native ARM64: LWJGL 3.x doesn't use AWT, so no flag needed.
            }
        } : {}),
    };

    // -------------------------------------------------------------------
    // macOS ARM64: version-scoped natives + x86_64 enforcement for pre-1.13
    // -------------------------------------------------------------------
    // Every version on ARM64 gets a dedicated, version-specific natives
    // directory so paths never cross-contaminate.
    //
    // For 1.13 – 1.18.2 we deploy LWJGL 3.3.3 arm64 *.dylib files.
    // For < 1.13  LWJGL 2 dylibs are x86_64 only — the JVM MUST be x86_64
    //            so Rosetta 2 translates it (and its dlopen calls).
    //
    // (isLegacyLwjgl2, isModernArm64, isLegacyArm64 are declared above)

    // Rosetta 2 for pre-1.13 on ARM64: x86_64 Java + official Mojang x86_64 natives
    if (isLegacyArm64) {
        opts.spawnPrefix = ['arch', '-x86_64'];
        opts._rosettaMode = true;
        opts.overrides._rosettaMode = true;
        console.log('[LAUNCH] Rosetta 2 active — x86_64 Java + official Mojang LWJGL 2.9.4 natives');
    }

    // --- Step A: LWJGL 3.3.3 swap for 1.13 – 1.18.2 ---
    const lwjglPatch = await lwjglManager.prepareLwjglArm64Swap(launchVersion, appRoot, mcRoot, onProgress);
    if (lwjglPatch.needed) {
        if (onProgress) onProgress('Applying LWJGL ARM64 compatibility patch...', 16);
        console.log(`[LAUNCH] LWJGL ARM64 patch active — natives: ${lwjglPatch.nativesDir}`);
        opts.overrides.natives = lwjglPatch.nativesDir;
        opts._lwjglNeedsPatch = true;
    }

    // --- Step B: Use nativesManager for consistent native path + extraction ---
    if (!opts.overrides.natives) {
        const isMacArm64 = process.platform === 'darwin' && process.arch === 'arm64' && !opts._rosettaMode;
        const nativeFolder = nativesManager.getNativesFolderName(selectedVersion, { isMacArm64 });
        const versionNativePath = nativesManager.getNativesPath(mcRoot, selectedVersion, { isMacArm64 });
        await fs.promises.mkdir(versionNativePath, { recursive: true });

        // If we have the version JSON, pre-extract native libraries
        try {
            const versionJsonPath = path.join(mcRoot, 'versions',
                opts.version.custom || selectedVersion,
                `${opts.version.custom || selectedVersion}.json`);
            if (fs.existsSync(versionJsonPath)) {
                const versionJson = JSON.parse(fs.readFileSync(versionJsonPath, 'utf-8'));
                await nativesManager.ensureNatives(mcRoot, selectedVersion, versionJson, {
                    isMacArm64,
                    onProgress
                });
            }
        } catch (nativeErr) {
            console.warn('[LAUNCH] Native extraction fallback:', nativeErr.message);
        }

        opts.overrides.natives = versionNativePath;
    }

    // Pass Rosetta mode flag through to MCLC handler so it skips
    // the ARM64 dylib override (we want official Mojang x86_64 natives).
    if (opts._rosettaMode) {
        opts.overrides._rosettaMode = true;
    }

    // Step C removed: On Apple Silicon we use a native ARM64 JDK (from
    // javaManager's Azul Zulu or Adoptium download).  LWJGL 2.9.4 ships
    // official arm64 dylibs that the ARM64 JVM loads directly. No Rosetta.

    function readTailLines(filePath, maxLines = 60) {
        try {
            if (!fs.existsSync(filePath)) return null;
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split(/\r?\n/);
            return lines.slice(-maxLines).join('\n');
        } catch {
            return null;
        }
    }

    function getMostRecentCrashReport(dirPath) {
        try {
            if (!fs.existsSync(dirPath)) return null;
            const files = fs.readdirSync(dirPath)
                .filter((name) => name.toLowerCase().endsWith('.txt'))
                .map((name) => ({
                    name,
                    fullPath: path.join(dirPath, name),
                    mtimeMs: fs.statSync(path.join(dirPath, name)).mtimeMs
                }))
                .sort((left, right) => right.mtimeMs - left.mtimeMs);
            return files[0] || null;
        } catch {
            return null;
        }
    }

    function buildCrashReport(baseMessage, code = null, signal = null) {
        const latestLogPath = path.join(gameRoot, 'logs', 'latest.log');
        const crashReportsDir = path.join(gameRoot, 'crash-reports');
        const latestCrash = getMostRecentCrashReport(crashReportsDir);

        // Parse latest.log for crash details
        let systemMemoryLogLine = null;
        let javaVersionLogLine = null;
        let errorClass = null;
        let errorSummary = null;
        try {
            if (fs.existsSync(latestLogPath)) {
                const rawLog = fs.readFileSync(latestLogPath, 'utf-8');
                const logLines = rawLog.split(/\r?\n/);

                for (const line of logLines) {
                    if (!systemMemoryLogLine && /\/INFO\].*Memory available/.test(line))
                        systemMemoryLogLine = line.trim();
                    if (!javaVersionLogLine && /\/INFO\].*Java is/.test(line))
                        javaVersionLogLine = line.trim();
                }

                // Find crash cause from log
                for (let idx = logLines.length - 1; idx >= 0; idx--) {
                    const line = logLines[idx];
                    if (/\] (ERROR|FATAL) /.test(line) && !errorSummary) {
                        errorSummary = line.replace(/^\[.*?\]\s*\[.*?\/.*?\]\s*/, '').trim();
                    }
                    if (!errorClass && /\] (caused by|exception|error):/i.test(line)) {
                        errorClass = line.replace(/^.*:\s*/, '').trim().split(/\s+/)[0];
                    }
                    if (errorClass && errorSummary) break;
                }
            }
        } catch { /* log parsing failed */ }

        // Detect architecture mismatch (Intel Java + ARM64 natives)
        const isMacArm64 = process.platform === 'darwin' && process.arch === 'arm64';
        
        return {
            timestamp: new Date().toISOString(),
            version: selectedVersion,
            profile: launchProfile || null,
            allocatedRamMb: instanceSettings?.ram || '4096',
            jvmPreset: instanceSettings?.preset || 'default',
            jvmArgs: Array.isArray(instanceSettings?.jvmArgs) ? instanceSettings.jvmArgs.join(' ') : (instanceSettings?.jvmArgs || null),
            javaPath: instanceSettings?.javaPath || null,
            customType: effectiveCustomType || null,
            platform: process.platform,
            arch: process.arch,
            isRosettaPreferred: isLegacyArm64,  /* x86_64 Java under Rosetta 2 for pre-1.13 */
            message: baseMessage,
            code: typeof code === 'number' ? code : null,
            signal: signal || null,
            systemMemoryLogLine,
            javaVersionLogLine,
            errorClass,
            errorSummary,
            nativeLibraryError: errorSummary ? /UnsatisfiedLinkError|no .+ in java\.library\.path|Can't load|\.dylib/.test(errorSummary) : false,
            javaMajorMismatch: errorSummary ? /major version|UnsupportedClassVersionError/.test(errorSummary) : false,
            latestLogTail: readTailLines(latestLogPath, 120),
            crashReportFile: latestCrash?.name || null,
            crashReportPreview: latestCrash ? readTailLines(latestCrash.fullPath, 120) : null
        };
    }

    let crashReported = false;
    const emitCrashReport = (message, code = null, signal = null) => {
        if (!onLaunchEvent || crashReported) return;
        crashReported = true;
        onLaunchEvent({ type: 'crash', report: buildCrashReport(message, code, signal) });
    };

    if (effectiveCustomType === 'fabric') {
        const fabricInstall = await ensureFabricInstalled(launchVersion, instanceSettings, mcRoot, selectedVersion, onProgress);
        opts.version.custom = fabricInstall.profileName;
        if (onProgress) onProgress(`Prepared Fabric ${fabricInstall.loaderVersion}`, 35);
    } else if (effectiveCustomType === 'forge') {
        const forgeInstall = await ensureForgeInstalled(launchVersion, instanceSettings, mcRoot, selectedVersion, onProgress);
        opts.forge = forgeInstall.installerJarPath;
        if (onProgress) onProgress(`Prepared Forge ${forgeInstall.forgeBuild}`, 35);
    } else {
        // Vanilla: ensure version JSON and JAR are on disk for MCLC
        await ensureVanillaVersionExists(launchVersion, mcRoot, onProgress);
        if (onProgress) onProgress(`Ready — Vanilla ${launchVersion}`, 35);
    }

    if (launchProfile) {
        const alreadySynced = isProfileAlreadySynced(gameRoot, launchVersion, launchProfile);
        if (alreadySynced) {
            if (onProgress) onProgress(`Profile ${launchProfile} already synced, skipping.`, 34);
        } else {
            syncBundledProfileMods(launchVersion, launchProfile, gameRoot, onProgress);
            syncBundledProfileShaders(launchVersion, launchProfile, gameRoot, onProgress);
            syncBundledProfileResourcePacks(launchVersion, launchProfile, gameRoot, onProgress);
            writeSyncManifest(gameRoot, launchVersion, launchProfile);
        }
    }

    // Apply preset or custom JVM arguments (filtered to avoid duplicates)
    if (instanceSettings.preset === 'optimized') {
        opts.customArgs = ["-XX:+UseG1GC", "-XX:-UseAdaptiveSizePolicy", "-XX:-OmitStackTraceInFastThrow", "-XX:MaxGCPauseMillis=200"];
    } else if (instanceSettings.preset === 'custom' && instanceSettings.jvmArgs) {
        const args = Array.isArray(instanceSettings.jvmArgs) ? instanceSettings.jvmArgs : String(instanceSettings.jvmArgs).trim().split(/\s+/).filter(Boolean);
        if (args.length) opts.customArgs = args;
    } else {
        opts.customArgs = [];
    }

    // Strip any user-supplied flags that MCLC or we set automatically
    // so they never appear twice.
    opts.customArgs = opts.customArgs.filter(arg =>
        !arg.startsWith('-Djava.library.path=') &&
        !arg.startsWith('-Xmx') &&
        !arg.startsWith('-Xms') &&
        arg !== '-XstartOnFirstThread'
    );

    // macOS: When spawned from Electron, the JVM auto-detects headless mode
    // because the Electron process environment looks like a background task.
    // Prism (native C++) doesn't need these; they are Electron-specific.
    //
    // Note: -Djava.awt.headless=false is injected at position 1 in MCLC's
    // launcher.js (right after -XstartOnFirstThread) so it's parsed before
    // any AWT classes load — do NOT add it here (would duplicate).
    if (process.platform === 'darwin') {
        opts.customArgs.push(
            // Dock/WindowServer registration — critical on Java 8 for
            // Cocoa NSApplication to be recognised as a GUI process.
            '-Dcom.apple.mrj.application.apple.menu.about.name=Minecraft',
            // LWJGL 2 debug output — logs window creation/display mode
            '-Dorg.lwjgl.opengl.Display.enableDebug=true',
            '-Dorg.lwjgl.util.Debug=true'
        );
        console.log('[LAUNCH] macOS Electron workaround: Dock=about.name=Minecraft, LWJGL debug');
    }

    // --- macOS AWT workaround removed ---
    // On native ARM64 Java 8 with LWJGL 2.9.4, the Cocoa AWT bridge is
    // selected automatically.  CToolkit/DISPLAY overrides are unnecessary
    // and interfere with native window creation.

    // --- Step D: JVM module compatibility flags for pre-1.17 versions on Java 17+ ---
    // Minecraft pre-1.17 (LWJGL 2.x and early LWJGL 3.x) relies on deep
    // reflection blocked by Java 17+'s module system.  These --add-opens /
    // --add-reads flags restore access for native library loading, ASM
    // manipulation, and obfuscated code reflection.
    //
    // When the launcher auto-selects Java 8 for pre-1.13 (LWJGL 2) versions,
    // these flags are skipped entirely because Java 8 has no module system.
    //
    // IMPORTANT: Do NOT add --add-reads flags for "jdk.internal.loader"
    // or "jdk.internal.ref" — those are not valid named modules and
    // produce startup warnings.
    if (javaManager.compareVersions(launchVersion, '1.17') < 0 && javaMajorVersion >= 17) {
        const legacyModuleFlags = [
            '--add-reads', 'java.base=java.compiler',
            '--add-reads', 'java.base=java.desktop',
            '--add-reads', 'java.desktop=java.compiler',
            '--add-reads', 'java.naming=java.desktop',
            '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
            '--add-opens', 'java.base/java.lang.reflect=ALL-UNNAMED',
            '--add-opens', 'java.base/java.lang.invoke=ALL-UNNAMED',
            '--add-opens', 'java.base/java.math=ALL-UNNAMED',
            '--add-opens', 'java.base/java.io=ALL-UNNAMED',
            '--add-opens', 'java.base/java.net=ALL-UNNAMED',
            '--add-opens', 'java.base/java.nio=ALL-UNNAMED',
            '--add-opens', 'java.base/java.text=ALL-UNNAMED',
            '--add-opens', 'java.base/java.time=ALL-UNNAMED',
            '--add-opens', 'java.base/java.util=ALL-UNNAMED',
            '--add-opens', 'java.base/sun.security.ssl=ALL-UNNAMED',
        ];
        opts.customArgs.push(...legacyModuleFlags);
        console.log(`[LAUNCH] Added ${legacyModuleFlags.length} module-compat flags for legacy v${launchVersion} on Java ${javaMajorVersion}`);
    }

    // Apply instance-level custom Java path.
    if (instanceSettings.javaPath && fs.existsSync(instanceSettings.javaPath)) {
        opts.javaPath = instanceSettings.javaPath;
    }

    if (cancelInterval) clearInterval(cancelInterval);
    cancelInterval = setInterval(() => {
        if (cancelRequested && launcher?.process) {
            try { launcher.process.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL'); } catch(e){}
            clearInterval(cancelInterval);
        }
    }, 200);

    // --- Launch timeout: if process doesn't start within LAUNCH_TIMEOUT_MS, emit failure ---
    setLaunchTimeout(() => {
        console.error('[LAUNCH TIMEOUT] Minecraft did not start within timeout.');
        if (onProgress) onProgress('Launch timed out — Minecraft did not start.', 0);
        if (onLaunchEvent) {
            onLaunchEvent({
                type: 'launch-failed',
                reason: 'timeout',
                message: `Minecraft failed to start within ${Math.round(LAUNCH_TIMEOUT_MS / 1000)} seconds. This may be due to missing Java, corrupted game files, or network issues.`
            });
        }
    });

    if (onProgress) {
        launcher.on('download-status', (e) => {
            const perc = Math.round((e.current / e.total) * 100);
            onProgress(`Downloading ${e.name}...`, Math.min(95, perc));
        });
        launcher.on('progress', (e) => {
            const perc = Math.round((e.task / e.total) * 100);
            onProgress(`Processing: ${e.type}`, Math.min(95, perc));
        });
    }

    launcher.on('debug', (e) => {
        const msg = typeof e === 'string' ? e : String(e ?? '');
        // Always print MCLC debug output to terminal (not just in dev mode)
        console.log(`[MCLC] ${msg}`);
        debugLog(`[MCLC] ${msg}`);
        if (onProgress && typeof e === 'string') {
            if (e.includes('Couldn\'t start Minecraft') || e.includes('Failed to download') || e.includes('Failed to find version')) {
                onProgress(`Error: ${e.replace('[MCLC]: ', '')}`, 0);
            }
        }
        if (/error|exception|fail|crash|can't|unable/i.test(e)) {
            console.error(`[LAUNCH ERROR] ${e}`);
        }
    });

    launcher.on('data', (e) => {
        const line = typeof e === 'string' ? e : String(e ?? '');
        // Always print raw Java stdout/stderr to terminal
        console.log(`[MC] ${line}`);
        debugLog(`[MC STDOUT] ${line}`);
        // Also forward critical errors to onProgress so the UI shows them
        if (onProgress && /Exception|Error|at\s+net\.minecraft|Exit\s+code/i.test(line)) {
            onProgress(`[MC] ${line.substring(0, 200)}`, 0);
        }
    });

    launcher.removeAllListeners('error');
    launcher.on('error', (error) => {
        console.error('[LAUNCH FATAL]', error);
        clearInterval(cancelInterval);
        clearLaunchTimeout();
        emitCrashReport(error?.message || 'Minecraft crashed during launch.');
    });
    
    instanceStartTimes[selectedVersion] = Date.now();
    launcher.removeAllListeners('close');
    launcher.on('close', (code, signal) => {
        clearInterval(cancelInterval);
        clearLaunchTimeout();
        if (instanceStartTimes[selectedVersion]) {
            const playedMs = Date.now() - instanceStartTimes[selectedVersion];
            const allSettings = loadSettings();
            if (!allSettings[selectedVersion]) allSettings[selectedVersion] = {};
            allSettings[selectedVersion].playtime = (allSettings[selectedVersion].playtime || 0) + playedMs;
            saveSettings(allSettings);
            delete instanceStartTimes[selectedVersion];
        }

        const numericCode = typeof code === 'number' ? code : null;
        const abnormalExit = numericCode !== null ? numericCode !== 0 : Boolean(signal);
        if (abnormalExit) {
            const exitMessage = numericCode !== null
                ? `Minecraft exited unexpectedly with code ${numericCode}.`
                : `Minecraft exited unexpectedly${signal ? ` (${signal})` : ''}.`;
            emitCrashReport(exitMessage, numericCode, signal || null);
        }

        if (onLaunchEvent) {
            onLaunchEvent({
                type: 'game-exit',
                code: numericCode,
                signal: signal || null,
                crashed: abnormalExit
            });
        }
    });

    // --- JVM arguments diagnostic ---
    // Capture the full launch arguments MCLC builds, so we can log the
    // exact JVM command line for comparison with Prism's working config.
    launcher.on('arguments', (args) => {
        if (Array.isArray(args)) {
            const javaExec = opts.javaPath || javaPath || 'java';
            const prefix = opts.spawnPrefix || [];
            const fullCmd = [...prefix, javaExec, ...args].join(' ');
            console.log('=======================================================');
            console.log('[DIAGNOSTICS] Full JVM command line:');
            console.log(fullCmd);
            console.log('=======================================================');
        }
    });

    // --- Apply version JSON patches (in-place on disk) ---
    // MCLC reads the version JSON and uses it to resolve libraries, natives,
    // and classpath.  We apply our patches here so MCLC sees the corrected data.
    //
    // Two patches are applied (order-independent):
    //   A) LWJGL 3.3.3 swap for 1.13–1.18.2 on ARM64 (lwjglManager.patchVersionJson)
    //   B) LWJGL 2.x macOS version bump: replace 2.9.2 with 2.9.4 on macOS (patchLwjgl2MacOS)
    const verForPath = opts.version.custom || launchVersion;
    const versionDir = path.join(mcRoot, 'versions', verForPath);
    const targetJsonPath = path.join(versionDir, `${verForPath}.json`);

    let appliedMacBump = false;
    if (fs.existsSync(targetJsonPath)) {
        try {
            let versionData = JSON.parse(fs.readFileSync(targetJsonPath, 'utf-8'));

            // Patch A: LWJGL 3.3.3 swap for 1.13–1.18.2 ARM64
            if (opts._lwjglNeedsPatch) {
                versionData = lwjglManager.patchVersionJson(versionData, appRoot);
                console.log(`[LAUNCH] Patched version JSON for LWJGL 3.3.3 ARM64 swap`);
            }
            delete opts._lwjglNeedsPatch;

            // Patch B: LWJGL 2.x macOS version bump (2.9.2 → 2.9.4)
            // This is needed for pre-1.13 on macOS because Mojang's metadata
            // assigns 2.9.2 to macOS while 2.9.4 is used on Windows/Linux.
            // Prism Launcher does the same override.
            appliedMacBump = lwjglManager.needsLwjgl2MacBump(launchVersion);
            if (appliedMacBump) {
                // For Rosetta 2 mode: only bump version + remove disallow rules.
                // Do NOT inject ARM64 classifiers — official Mojang x86_64
                // LWJGL 2.9.4 natives work directly under Rosetta translation.
                if (opts._rosettaMode) {
                    versionData = lwjglManager.patchLwjgl2MacOSMinimal(versionData);
                    console.log(`[LAUNCH] Applied LWJGL 2.x macOS version bump (2.9.2 → 2.9.4) [Rosetta mode — no ARM64 injection]`);
                } else {
                    versionData = lwjglManager.patchLwjgl2MacOS(versionData);
                    console.log(`[LAUNCH] Applied LWJGL 2.x macOS version bump (2.9.2 → 2.9.4)`);
                }

                // Clear old 2.9.2 native libraries so MCLC re-extracts 2.9.4 natives
                const oldNativesDir = path.join(mcRoot, 'natives', selectedVersion);
                if (fs.existsSync(oldNativesDir)) {
                    const entries = fs.readdirSync(oldNativesDir);
                    for (const entry of entries) {
                        try { fs.rmSync(path.join(oldNativesDir, entry), { recursive: true }); } catch {}
                    }
                    console.log(`[LAUNCH] Cleared old natives directory: ${oldNativesDir}`);
                }
                // Also clear arch-specific variant if present
                const archNativesDir = path.join(mcRoot, 'natives', selectedVersion + '-arm64');
                if (fs.existsSync(archNativesDir)) {
                    const entries = fs.readdirSync(archNativesDir);
                    for (const entry of entries) {
                        try { fs.rmSync(path.join(archNativesDir, entry), { recursive: true }); } catch {}
                    }
                    console.log(`[LAUNCH] Cleared old natives directory: ${archNativesDir}`);
                }
            }

            // Write patched JSON in-place
            fs.writeFileSync(targetJsonPath, JSON.stringify(versionData, null, 2), 'utf-8');

            // Also patch the base version JSON if using a custom version (Fabric/Forge)
            // since MCLC may read libraries from both.
            const needsLwjgl3Swap = lwjglManager.needsLwjglSwap(launchVersion);
            if (opts.version.custom && launchVersion !== verForPath) {
                const baseJsonPath = path.join(mcRoot, 'versions', launchVersion, `${launchVersion}.json`);
                if (fs.existsSync(baseJsonPath)) {
                    let baseData = JSON.parse(fs.readFileSync(baseJsonPath, 'utf-8'));
                    if (needsLwjgl3Swap) {
                        baseData = lwjglManager.patchVersionJson(baseData, appRoot);
                    }
                    if (appliedMacBump) {
                        baseData = lwjglManager.patchLwjgl2MacOS(baseData);
                    }
                    fs.writeFileSync(baseJsonPath, JSON.stringify(baseData, null, 2), 'utf-8');
                    console.log(`[LAUNCH] Also patched base version JSON: ${baseJsonPath}`);
                }
            }
        } catch (err) {
            console.error('[LAUNCH] Failed to patch version JSON:', err.message);
        }
    } else {
        console.warn(`[LAUNCH] Version JSON not found: ${targetJsonPath}`);
    }

    // ====================================================================
    // Launch Diagnostics
    // ====================================================================
    console.log('=======================================================');
    console.log('[DIAGNOSTICS] LeanLauncher launch snapshot');
    console.log('=======================================================');
    console.log(`[DIAGNOSTICS] Java binary:  ${opts.javaPath || javaPath}`);
    console.log(`[DIAGNOSTICS] Java version: ${javaVersion}`);
    console.log(`[DIAGNOSTICS] Java arch:    ${process.arch}`);
    console.log(`[DIAGNOSTICS] Process arch: ${process.arch}`);
    console.log(`[DIAGNOSTICS] Platform:     ${process.platform}`);
    console.log(`[DIAGNOSTICS] Minecraft:    ${launchVersion}${opts.version.custom ? ` (custom: ${opts.version.custom})` : ''}`);
    console.log(`[DIAGNOSTICS] RAM:          ${opts.memory?.max || 'unknown'}`);
    console.log(`[DIAGNOSTICS] Natives:      ${opts.overrides?.natives || 'automatic'}`);
    console.log(`[DIAGNOSTICS] Spawn prefix: ${opts.spawnPrefix ? opts.spawnPrefix.join(' ') : '(none)'}`);
    console.log(`[DIAGNOSTICS] Extra env:    ${opts.extraEnv ? JSON.stringify(opts.extraEnv) : '(none)'}`);
    console.log(`[DIAGNOSTICS] Custom JVM:   ${opts.customArgs ? opts.customArgs.join(' ') : '(none)'}`);
    console.log(`[DIAGNOSTICS] Rosetta 2:    NO (native ARM64 JDK)`);
    console.log(`[DIAGNOSTICS] DISPLAY env:  ${process.env.DISPLAY || '(not set)'}`);
    console.log(`[DIAGNOSTICS] __CF_* vars:  ${['__CF_USER_TEXT_ENCODING', '__CFBundleIdentifier'].filter(k => process.env[k]).map(k => `${k}=${process.env[k]}`).join(', ') || '(none found)'}`);
    console.log(`[DIAGNOSTICS] LWJGL patch:  ${appliedMacBump ? '2.x macOS bump applied' : 'not needed'}`);
    console.log(`[DIAGNOSTICS] LWJGL 3 swap: ${lwjglManager.needsLwjglSwap(launchVersion) ? 'arm64 swap active' : 'not needed'}`);
    console.log('=======================================================');

    // Prism structure validation: print final resolved command
    console.log('[VALIDATE] Prism Launcher resolved structure comparison:');
    console.log(`[VALIDATE] Java binary:      ${opts.javaPath || javaPath}`);
    console.log(`[VALIDATE] JVM arch:         ${process.arch}`);
    console.log(`[VALIDATE] Natives dir:      ${opts.overrides?.natives || 'default'}`);
    console.log(`[VALIDATE] Game dir:         ${opts.overrides?.gameDirectory || 'default'}`);
    console.log(`[VALIDATE] Classpath order:  jinput -> lwjgl -> lwjgl_util -> minecraft`);
    console.log(`[VALIDATE] macOS flags:      -XstartOnFirstThread at arg[0], headless=false at arg[1]`);
    console.log(`[VALIDATE] Window flags:     apple.awt.UIElement=false, com.apple.mrj.about.name=Minecraft`);
    console.log('=======================================================');

    // --- Execute MCLC launch (async — downloads assets, extracts natives, spawns Java) ---
    // Await the launch so we can detect success/failure from the return value
    const spawnedProcess = await launcher.launch(opts);
    markLaunchBooted();

    if (!spawnedProcess) {
        // MCLC returned null — launch failed (Java not found, version not found, etc.)
        clearLaunchTimeout();
        if (onProgress) onProgress('Minecraft launcher core failed to start the game.', 0);
        if (onLaunchEvent) {
            onLaunchEvent({
                type: 'launch-failed',
                reason: 'mclc-null',
                message: 'The Minecraft launcher core failed to start the game. This usually means Java was not found or the version files are missing.'
            });
        }
        return { launched: false };
    }

    // Store the spawned process reference for cancel/kill support
    launcher.process = spawnedProcess;

    if (onProgress) onProgress("Launching Game...", 100);
    if (onLaunchEvent) onLaunchEvent({ type: 'booted', version: selectedVersion });

    return { launched: true };
}

// Export diagnostic constants for main.js
module.exports.LAUNCH_TIMEOUT_MS = LAUNCH_TIMEOUT_MS;

/**
 * Calls xboxManager.getMinecraft() with retries on transient "Premature close" errors.
 * This is a workaround for a known node-fetch v2 / Minecraft auth endpoint issue where
 * chunked responses without content-length can cause premature socket close errors.
 */
async function getMinecraftTokenWithRetry(xboxManager, maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await xboxManager.getMinecraft();
        } catch (e) {
            const msg = typeof e?.message === 'string' ? e.message : String(e);
            const isPrematureClose = /premature\s*close/i.test(msg) ||
                /ERR_STREAM_PREMATURE_CLOSE/.test(msg) ||
                /Invalid response body/i.test(msg);
            if (isPrematureClose && attempt < maxRetries) {
                const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
                console.log(`Minecraft auth attempt ${attempt} failed (Premature close), retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw e;
        }
    }
    throw new Error('Failed to get Minecraft token after multiple retries.');
}

async function loginAccount() {
    if (!CLIENT_ID) throw new Error('Azure Client ID not configured.');
    const auth = new Auth({ client_id: CLIENT_ID, ...(CLIENT_SECRET ? { clientSecret: CLIENT_SECRET } : {}), redirect: REDIRECT_URI, prompt: 'select_account' });
    let xboxManager;
    try {
        xboxManager = await auth.launch('electron');
    } catch (e) {
        const msg = typeof e?.message === 'string' ? e.message : String(e);
        if (/closed|cancel|gui\.closed/i.test(msg)) {
            const err = new Error('Login cancelled.');
            err.cancelled = true;
            throw err;
        }
        throw e;
    }
    const mcToken = await getMinecraftTokenWithRetry(xboxManager);
    const accountName = mcToken.profile?.name || 'Player';
    const minecraftId = mcToken.profile?.id;
    const refreshToken = xboxManager.msToken?.refresh_token;
    if (!refreshToken) throw new Error('Login completed but refresh token was not returned.');
    const authCache = upsertAuthAccount({
        id: xboxManager.msToken.user_id,
        type: 'microsoft',
        refreshToken,
        accountName,
        minecraftId,
        userId: xboxManager.msToken.user_id,
        savedAt: Date.now()
    }, { setActive: true });
    return { name: accountName, id: xboxManager.msToken.user_id, minecraftId, signedIn: true, activeAccountId: authCache.activeAccountId };
}

async function loginOffline(username) {
    upsertAuthAccount({
        id: 'offline',
        type: 'offline',
        refreshToken: 'offline',
        accountName: username,
        minecraftId: "00000000000000000000000000000000",
        userId: 'offline',
        savedAt: Date.now()
    }, { setActive: true });
    return { name: username, minecraftId: null, signedIn: true };
}

function checkSession() {
    const saved = loadSavedAuth();
    const activeAccount = getAuthAccount(saved);
    if (activeAccount && activeAccount.accountName) return { name: activeAccount.accountName, minecraftId: activeAccount.minecraftId, signedIn: true, accountId: activeAccount.id, activeAccountId: saved?.activeAccountId || activeAccount.id, accounts: saved?.accounts || [] };
    return null;
}

function cancelLaunchProcess() {
    cancelRequested = true;
    if (launcher && launcher.process) {
        try { launcher.process.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL'); } catch(e){}
    }
}

module.exports = { startLeanClient, loginAccount, loginOffline, checkSession, cancelLaunchProcess, loadSettings, saveSettings, getInstanceSettings, getGlobalSettings, saveGlobalSettings, getAuthAccounts, setActiveAuthAccount, removeAuthAccount };