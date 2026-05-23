# Lean Launcher

A sleek, modern Minecraft launcher built with Electron. Launch optimized modpacks, manage instances, and keep everything up to date — all from a beautiful glassmorphism interface.

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue" alt="Platforms">
  <img src="https://img.shields.io/badge/electron-26.0.0-8b5cf6" alt="Electron">
  <img src="https://img.shields.io/badge/license-ISC-green" alt="License">
</p>

---

## Features

### Core Launcher
- **One-click launch** — pick a version, choose a profile, hit Launch
- **Microsoft & offline auth** — sign in with your Microsoft account or play cracked with a username
- **Multi-account support** — save, switch, and manage multiple accounts from the login panel
- **Close-on-boot mode** — automatically hides the launcher when the game starts, reopens when you quit

### Instance Management
- **Official Lean Client versions** — 1.19.4 through 1.21.11, each with Balanced, Full, and Lightweight mod profiles
- **Custom instances** — create your own version with any Minecraft release, plus Fabric or Forge loader
- **Per-instance settings** — RAM allocation, JVM presets, custom Java path, and playtime tracking per version
- **Instance file editor** — browse, edit, upload, and drag-and-drop files directly into any instance folder

### Visual Experience
- **10 built-in themes** — Light, Dark, Midnight, Pastel, Grass, Nether, End, Cherry, Deep Dark, Space, and Bees
- **Glassmorphism UI** — frosted glass panels, animated bubbles, and smooth page transitions
- **3 languages** — English, Español, and Português
- **Animated background** — floating bubble layer that reacts to your mouse

### Under the Hood
- **Auto-updating** — checks GitHub Releases on startup, downloads deltas, and shows a glassmorphism changelog modal
- **Crash reporting** — detailed crash reports with log tails, JVM config, and suggested fixes
- **Profile sync** — smart manifest system avoids redundant mod/resource pack copies on every launch
- **Shaders & resource packs** — Full profile bundles come with shaders and resource packs pre-configured

---

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org) 18 or later
- npm (comes with Node.js)

### Development
```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/LeanLauncher.git
cd LeanLauncher

# Install dependencies
npm install

# Run in development mode
npm run dev
```

### Building
```bash
# Build for your current OS
npm run build

# Build for a specific platform
npm run build:win      # Windows (.exe)
npm run build:mac      # macOS (.dmg + .zip)
npm run build:linux    # Linux (.AppImage)

# Build for all platforms
npm run build:all
```

Builds are output to the `dist/` folder.

### Releasing
Push a semantic version tag to trigger the CI/CD pipeline:
```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions will build Windows, macOS (x64 + ARM), and Linux installers and publish them to GitHub Releases.

---

## Project Structure

```
LeanLauncher/
├── main.js              # Electron main process — window, IPC, auto-updater
├── preload.js           # Context bridge for update API
├── index.js             # Game launch logic — auth, mod sync, crash reports
├── index.html           # Renderer entry point
├── ui.js                # Frontend — navigation, settings, modals, translations
├── style.css            # Glassmorphism theme engine + all component styles
├── package.json         # Dependencies + electron-builder config
├── lib/
│   └── ram-utils.js     # RAM conversion & clamping utilities
├── mod-profiles/        # Bundled mod sets per version & profile
├── minecraft/           # Game assets, libraries, instances, natives
└── .github/workflows/
    └── release.yml      # CI/CD — cross-platform build matrix
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Electron](https://electronjs.org) 26 |
| Auth | [msmc](https://github.com/Hanro50/msmc) (Microsoft OAuth) |
| Game Launch | [minecraft-launcher-core](https://github.com/Pierce01/MinecraftLauncher-core) |
| Auto-Updates | [electron-updater](https://www.electron.build/auto-update) |
| Packaging | [electron-builder](https://www.electron.build) |
| CI/CD | GitHub Actions with build matrix |

---

## License

ISC © Lyam
