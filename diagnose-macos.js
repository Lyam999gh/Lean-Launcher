#!/usr/bin/env node
/**
 * macOS Launch Diagnostics
 * ========================
 * Run this script on your MacBook when a Minecraft launch fails.
 * It captures the environment and launch configuration to identify
 * the divergence from Prism Launcher's working configuration.
 *
 * Usage:
 *   node diagnose-macos.js
 *
 * Output is written to: macos-diagnostic-report.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const report = {
    timestamp: new Date().toISOString(),
    os: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        type: os.type(),
        hostname: os.hostname(),
    },
    java: {},
    lwjgl: {},
    natives: {},
    environment: {},
};

// --- Java ---
function getJavaInfo(binary) {
    try {
        const output = execFileSync(binary, ['-version'], { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
        const stderr = output; // java -version outputs to stderr
        const versionMatch = stderr.match(/version\s+"([^"]+)"/);
        const archMatch = stderr.match(/(64-Bit|32-Bit)/);
        const isArm = /aarch64|arm64/i.test(stderr);
        return {
            binary,
            version: versionMatch ? versionMatch[1] : 'unknown',
            arch: isArm ? 'arm64' : (archMatch ? 'x86_64' : 'unknown'),
            raw: stderr.split('\n')[0],
        };
    } catch (e) {
        return { binary, error: e.message };
    }
}

function scanJavaBinaries() {
    const results = [];
    const candidates = [];

    // Add PATH java
    try {
        const which = execFileSync('which', ['java'], { encoding: 'utf-8', timeout: 5000 }).trim();
        if (which) candidates.push(which);
    } catch {}

    // Add JAVA_HOME
    if (process.env.JAVA_HOME) {
        candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'java'));
    }

    // Scan common JDK roots
    const jdkRoots = [
        '/Library/Java/JavaVirtualMachines',
        path.join(os.homedir(), 'Library/Java/JavaVirtualMachines'),
        '/usr/lib/jvm',
    ];

    for (const root of jdkRoots) {
        if (!fs.existsSync(root)) continue;
        try {
            const entries = fs.readdirSync(root, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const candidate = path.join(root, entry.name, 'Contents', 'Home', 'bin', 'java');
                if (fs.existsSync(candidate)) candidates.push(candidate);
            }
        } catch {}
    }

    // Deduplicate
    const seen = new Set();
    for (const c of candidates) {
        const resolved = fs.realpathSync(c);
        if (!seen.has(resolved)) {
            seen.add(resolved);
            results.push(getJavaInfo(resolved));
        }
    }

    return results;
}

report.java = {
    arch: (() => {
        try {
            const out = execFileSync('arch', { encoding: 'utf-8', timeout: 3000 }).trim();
            return out;
        } catch { return 'unknown'; }
    })(),
    runtimes: scanJavaBinaries(),
};

// --- Rosetta 2 ---
try {
    const out = execFileSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf-8', timeout: 3000 }).trim();
    report.os.rosetta = out === '1' ? 'active (running under Rosetta 2)' : 'not active';
} catch { report.os.rosetta = 'unknown'; }

// --- LWJGL Natives ---
const lwjglCache = path.join(__dirname, 'lwjgl-cache');
if (fs.existsSync(lwjglCache)) {
    const nativesDir = path.join(lwjglCache, 'natives');
    if (fs.existsSync(nativesDir)) {
        report.lwjgl.natives_dir = nativesDir;
        try {
            report.lwjgl.natives_files = fs.readdirSync(nativesDir).filter(f => f.endsWith('.dylib'));
        } catch { report.lwjgl.natives_files = []; }
    }

    // Check deployed natives
    const deployedDir = path.join(lwjglCache, 'deployed-natives');
    if (fs.existsSync(deployedDir)) {
        report.lwjgl.deployed = fs.readdirSync(deployedDir);
        for (const ver of (report.lwjgl.deployed || [])) {
            const verDir = path.join(deployedDir, ver);
            if (fs.statSync(verDir).isDirectory()) {
                try {
                    const dylibs = fs.readdirSync(verDir).filter(f => f.endsWith('.dylib'));
                    report.lwjgl[`deployed_${ver}`] = dylibs;
                } catch {}
            }
        }
    }
}

// --- Native library path from previous launch attempts ---
const mcNativesDir = path.join(__dirname, 'minecraft', 'natives');
if (fs.existsSync(mcNativesDir)) {
    report.natives.minecraft_natives = fs.readdirSync(mcNativesDir);
}

// --- Version JSONs with Java version requirements ---
const versionsDir = path.join(__dirname, 'minecraft', 'versions');
if (fs.existsSync(versionsDir)) {
    report.java.version_requirements = {};
    for (const ver of fs.readdirSync(versionsDir)) {
        const jsonPath = path.join(versionsDir, ver, `${ver}.json`);
        if (fs.existsSync(jsonPath)) {
            try {
                const json = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
                if (json.javaVersion) {
                    report.java.version_requirements[ver] = json.javaVersion.majorVersion;
                }
            } catch {}
        }
    }
}

// --- Instance settings ---
const settingsPath = path.join(__dirname, 'settings.json');
if (fs.existsSync(settingsPath)) {
    report.settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
}

// --- Write report ---
const reportPath = path.join(__dirname, 'macos-diagnostic-report.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
console.log(`Diagnostic report written to: ${reportPath}`);
console.log(`\nKey findings:`);
console.log(`  OS:         ${report.os.platform} ${report.os.arch}`);
console.log(`  Rosetta:    ${report.os.rosetta}`);
console.log(`  Java(s):    ${report.java.runtimes.map(j => `${j.version || 'ERROR'} (${j.arch || '?'})`).join(', ') || 'none'}`);
console.log(`  LWJGL dep:  ${Object.keys(report.lwjgl).filter(k => k.startsWith('deployed_')).join(', ') || 'none'}`);
console.log(`  Java reqs:  ${Object.entries(report.java.version_requirements || {}).map(([v, j]) => `${v}→Java${j}`).join(', ')}`);
