require('dotenv').config();

const { Auth } = require("msmc");
const { Client, Authenticator } = require("minecraft-launcher-core");
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
let launcher = null;
const isDev = process.env.NODE_ENV === 'development';
const debugLog = (...args) => { if (isDev) console.log(...args); };

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

async function downloadFile(url, destinationPath, onProgress) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 120 second timeout
    
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Failed to download ${url} (${response.status})`);
        
        const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
        await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
        
        const writer = fs.createWriteStream(destinationPath);
        let downloadedBytes = 0;
        
        if (response.body) {
            response.body.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                if (onProgress && contentLength > 0) {
                    const percent = Math.round((downloadedBytes / contentLength) * 100);
                    onProgress(`Downloading... ${percent}%`);
                }
            });
            await new Promise((resolve, reject) => {
                response.body.pipe(writer);
                writer.on('finish', resolve);
                writer.on('error', reject);
                response.body.on('error', reject);
            });
        } else {
            const data = Buffer.from(await response.arrayBuffer());
            await fs.promises.writeFile(destinationPath, data);
        }
        
        return destinationPath;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function runJavaJar(javaExecutable, jarPath, args, onProgress) {
    return new Promise((resolve, reject) => {
        const child = require('child_process').execFile(
            javaExecutable,
            ['-jar', jarPath, ...args],
            { maxBuffer: 1024 * 1024 * 50, timeout: 600000 } // 10 minute timeout
        );
        
        let lastUpdate = Date.now();
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
            debugLog(`[Installer Error] ${output}`);
        });
        
        child.on('error', (error) => {
            clearInterval(updateInterval);
            reject(new Error(`Failed to run installer: ${error.message}`));
        });
        
        child.on('close', (code) => {
            clearInterval(updateInterval);
            if (code !== 0) {
                reject(new Error(`Installer exited with code ${code}`));
            } else {
                resolve();
            }
        });
    });
}

function resolveJavaExecutable(instanceSettings) {
    if (instanceSettings?.javaPath && fs.existsSync(instanceSettings.javaPath)) return instanceSettings.javaPath;
    return process.platform === 'win32' ? 'java.exe' : 'java';
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

    const [loaderResponse, installerResponse] = await Promise.all([
        loaderVersion ? Promise.resolve(null) : fetch(`https://meta.fabricmc.net/v2/versions/loader/${baseVersion}`),
        installerVersion ? Promise.resolve(null) : fetch('https://meta.fabricmc.net/v2/versions/installer')
    ]);

    const loaders = loaderVersion ? [] : await loaderResponse.json();
    const installers = installerVersion ? [] : await installerResponse.json();

    const resolvedLoaderVersion = loaderVersion || loaders.find(entry => entry?.loader?.stable) ?.loader?.version || loaders[0]?.loader?.version;
    const resolvedInstallerVersion = installerVersion || installers.find(entry => entry?.stable)?.version || installers[0]?.version;

    if (!resolvedLoaderVersion) throw new Error(`No Fabric loader version found for ${baseVersion}`);
    if (!resolvedInstallerVersion) throw new Error('No Fabric installer version found');

    const profileName = `fabric-loader-${resolvedLoaderVersion}-${baseVersion}`;
    const installerJarPath = path.join(appRoot, 'minecraft', 'cache', 'installers', 'fabric', `${resolvedInstallerVersion}.jar`);
    const installerUrl = `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${resolvedInstallerVersion}/fabric-installer-${resolvedInstallerVersion}.jar`;

    return { loaderVersion: resolvedLoaderVersion, installerVersion: resolvedInstallerVersion, profileName, installerJarPath, installerUrl };
}

async function ensureVanillaVersionExists(baseVersion, mcRoot, onProgress) {
    const vanillaVersionDir = path.join(mcRoot, 'versions', baseVersion);
    const vanillaVersionJson = path.join(vanillaVersionDir, `${baseVersion}.json`);
    const vanillaVersionJar = path.join(vanillaVersionDir, `${baseVersion}.jar`);
    
    // Check if already downloaded
    if (fs.existsSync(vanillaVersionJson) && fs.existsSync(vanillaVersionJar)) {
        return;
    }
    
    debugLog(`Pre-downloading vanilla Minecraft ${baseVersion} for Fabric installer...`);
    if (onProgress) onProgress(`Setting up vanilla Minecraft ${baseVersion}...`, 20);
    
    // Download version manifest
    const manifestResponse = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json');
    if (!manifestResponse.ok) throw new Error('Failed to fetch version manifest');
    const manifest = await manifestResponse.json();
    
    const versionEntry = manifest.versions.find(v => v.id === baseVersion);
    if (!versionEntry) throw new Error(`Vanilla version ${baseVersion} not found in manifest`);
    
    // Download version JSON
    const versionJsonResponse = await fetch(versionEntry.url);
    if (!versionJsonResponse.ok) throw new Error(`Failed to fetch version JSON for ${baseVersion}`);
    const versionJson = await versionJsonResponse.json();
    
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
        if (!fs.existsSync(installInfo.installerJarPath)) {
            await downloadFile(installInfo.installerUrl, installInfo.installerJarPath, (msg) => {
                if (onProgress) onProgress(msg, 26);
            });
        }

        const javaExecutable = resolveJavaExecutable(instanceSettings);
        debugLog(`Running Fabric installer: ${installInfo.installerJarPath}`);
        
        // Ensure launcher_profiles.json exists for Fabric installer
        await ensureLauncherProfiles(mcRoot);
        
        if (onProgress) onProgress(`Installing Fabric loader (this may take 5-10 minutes)...`, 30);
        
        try {
            await runJavaJar(javaExecutable, installInfo.installerJarPath, [
                'client',
                '-dir', mcRoot,
                '-mcversion', baseVersion,
                '-loader', installInfo.loaderVersion,
                '-downloadMinecraft'
            ], onProgress);
        } catch (error) {
            console.error(`Fabric installer failed: ${error.message}`);
            throw error;
        }
    }

    const allSettings = loadSettings();
    if (!allSettings[selectedVersion]) allSettings[selectedVersion] = {};
    allSettings[selectedVersion].fabricLoaderVersion = installInfo.loaderVersion;
    allSettings[selectedVersion].fabricInstallerVersion = installInfo.installerVersion;
    allSettings[selectedVersion].fabricProfileName = installInfo.profileName;
    saveSettings(allSettings);

    return installInfo;
}

async function resolveForgeInstall(baseVersion, instanceSettings, selectedVersion) {
    const forgeBuild = instanceSettings?.forgeBuild || null;
    let resolvedForgeBuild = forgeBuild;

    if (!resolvedForgeBuild) {
        const promotionsResponse = await fetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
        if (!promotionsResponse.ok) throw new Error('Failed to fetch Forge promotions');
        const promotions = await promotionsResponse.json();
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
        const mcToken = await xboxManager.getMinecraft();
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

    // Auto-detect Java if no custom path is set
    let javaPath = instanceSettings?.javaPath || '';
    if (!javaPath || !fs.existsSync(javaPath)) {
        const { execSync, execFileSync } = require('child_process');
        try {
            javaPath = execFileSync('which', ['java'], { encoding: 'utf-8' }).trim();
        } catch {
            try { javaPath = execSync('which java 2>/dev/null || echo /usr/bin/java', { encoding: 'utf-8' }).trim(); } catch { javaPath = '/usr/bin/java'; }
        }
        if (!fs.existsSync(javaPath) && process.platform !== 'win32') {
            try {
                const result = execFileSync('find', ['/usr/lib/jvm', '-name', 'java', '-type', 'f'], { encoding: 'utf-8', timeout: 5000 });
                javaPath = result.split('\n')[0]?.trim() || javaPath;
            } catch {}
        }
    }

    let opts = {
        clientPackage: null, authorization, root: mcRoot,
        overrides: { gameDirectory: gameRoot },
        version: { number: launchVersion, type: "release" },
        memory: { max: `${instanceSettings.ram}M`, min: "2048M" },
        javaPath: javaPath || undefined
    };

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

        return {
            timestamp: new Date().toISOString(),
            version: selectedVersion,
            profile: launchProfile || null,
            allocatedRamMb: instanceSettings?.ram || '4096',
            jvmPreset: instanceSettings?.preset || 'default',
            jvmArgs: Array.isArray(instanceSettings?.jvmArgs) ? instanceSettings.jvmArgs.join(' ') : (instanceSettings?.jvmArgs || null),
            javaPath: instanceSettings?.javaPath || null,
            customType: effectiveCustomType || null,
            message: baseMessage,
            code: typeof code === 'number' ? code : null,
            signal: signal || null,
            systemMemoryLogLine,
            javaVersionLogLine,
            errorClass,
            errorSummary,
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

    if (instanceSettings.preset === 'optimized') opts.customArgs = ["-XX:+UseG1GC", "-XX:-UseAdaptiveSizePolicy", "-XX:-OmitStackTraceInFastThrow", "-XX:MaxGCPauseMillis=200"];
    else if (instanceSettings.preset === 'custom' && instanceSettings.jvmArgs) {
        const args = Array.isArray(instanceSettings.jvmArgs) ? instanceSettings.jvmArgs : String(instanceSettings.jvmArgs).trim().split(/\s+/).filter(Boolean);
        if (args.length) opts.customArgs = args;
    }
    if (instanceSettings.javaPath && fs.existsSync(instanceSettings.javaPath)) opts.javaPath = instanceSettings.javaPath;

    if (cancelInterval) clearInterval(cancelInterval);
    cancelInterval = setInterval(() => {
        if (cancelRequested && launcher?.process) {
            try { launcher.process.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL'); } catch(e){}
            clearInterval(cancelInterval);
        }
    }, 200);

    if (onProgress) {
        launcher.on('download-status', (e) => {
            const perc = Math.round((e.current / e.total) * 100);
            onProgress(`Downloading ${e.name}...`, perc);
        });
        launcher.on('progress', (e) => {
            const perc = Math.round((e.task / e.total) * 100);
            onProgress(`Processing: ${e.type}`, perc);
        });
    }

    launcher.on('debug', (e) => {
        debugLog(`[DEBUG] ${e}`);
        if(e.includes('Starting native process')) {
            if (onProgress) onProgress("Launching Game...", 100);
            if (onLaunchEvent) onLaunchEvent({ type: 'booted', version: selectedVersion });
        }
        if (/error|exception|fail|crash|can't|unable/i.test(e)) {
            console.error(`[LAUNCH ERROR] ${e}`);
        }
    });

    launcher.on('data', (e) => {
        debugLog(`[MC STDOUT] ${e}`);
    });

    launcher.removeAllListeners('error');
    launcher.on('error', (error) => {
        console.error('[LAUNCH FATAL]', error);
        clearInterval(cancelInterval);
        emitCrashReport(error?.message || 'Minecraft crashed during launch.');
    });
    
    instanceStartTimes[selectedVersion] = Date.now();
    launcher.removeAllListeners('close');
    launcher.on('close', (code, signal) => {
        clearInterval(cancelInterval);
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

    launcher.launch(opts);
    return { launched: true };
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
    const mcToken = await xboxManager.getMinecraft();
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