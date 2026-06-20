# Lean Launcher

<p align="center">
  <img src="Leangif.gif" alt="Lean Launcher Preview" width="600">
</p>

A modern Minecraft launcher built with Electron for Windows, macOS, and Linux. Lean Launcher provides a streamlined experience for managing accounts, organizing instances, launching modpacks, and keeping installations up to date through a polished and intuitive interface.

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue" alt="Platforms">
  <img src="https://img.shields.io/badge/electron-42.2.0-8b5cf6" alt="Electron">
  <img src="https://img.shields.io/badge/license-ISC-green" alt="License">
</p>

## Overview

Lean Launcher is designed to simplify the Minecraft experience while providing powerful management tools for both casual players and advanced users. It combines a modern user interface with reliable account management, custom instance support, automatic updates, and integrated tooling for maintaining Minecraft installations.

## Features

### Launcher

* One-click game launch
* Microsoft and offline authentication
* Multiple account support
* Close-on-boot mode that automatically hides the launcher while Minecraft is running

### Instance Management

* Official Lean Client versions from 1.19.4 through 1.21.11
* Balanced, Full, and Lightweight mod profiles
* Custom instances with support for any Minecraft release
* Fabric and Forge loader support
* Per-instance RAM allocation
* JVM presets and custom Java paths
* Playtime tracking
* Integrated file manager with browse, edit, upload, and drag-and-drop support

### User Experience

* Ten built-in themes
* Smooth animations and transitions
* Glassmorphism-inspired interface design
* Interactive animated backgrounds
* Language support for English, Español, and Português

### Reliability

* Automatic update checks through GitHub Releases
* Delta update downloads when available
* Crash reporting with diagnostic information
* Intelligent profile synchronization
* Preconfigured shaders and resource packs for Full profiles

## Installation

> **Note**
>
> Lean Launcher is currently not code signed. Your operating system may display a security warning during the first launch. This is expected and simply indicates that the application has not yet been signed with a developer certificate.

### Windows

1. Download `Lean Launcher Setup x.x.x.exe` from the latest release.
2. Run the installer.
3. If Windows SmartScreen appears, select **More info**.
4. Click **Run anyway**.
5. Complete the installation process.

### macOS

1. Download the `.dmg` from the latest release.
2. Open the downloaded file.
3. Drag `Lean Launcher.app` into the **Applications** folder.
4. Open **Terminal** and run the following command to clear the quarantine attribute:

```bash
xattr -c /Applications/Lean\ Launcher.app
```

5. Launch Lean Launcher from your Applications folder or Spotlight.

### Linux

1. Download the `.AppImage` from the latest release.
2. Make the file executable:

```bash
chmod +x Lean-Launcher-*.AppImage
```

3. Run the application:

```bash
./Lean-Launcher-*.AppImage
```

## Getting Started

### Requirements

* Node.js 18 or later
* npm

### Development

```bash
git clone https://github.com/YOUR_USERNAME/LeanLauncher.git
cd LeanLauncher

npm install
npm run dev
```

### Building

```bash
# Build for the current platform
npm run build

# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux

# All supported platforms
npm run build:all
```

Build artifacts are generated in the `dist/` directory.

### Releasing

Create and push a semantic version tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The release workflow will automatically build supported platform packages and publish them to GitHub Releases.

## Project Structure

```text
LeanLauncher/
├── main.js
├── preload.js
├── index.js
├── index.html
├── ui.js
├── style.css
├── package.json
├── lib/
│   └── ram-utils.js
├── mod-profiles/
├── minecraft/
└── .github/workflows/
    └── release.yml
```

## Technology

| Component      | Technology              |
| -------------- | ----------------------- |
| Runtime        | Electron                |
| Authentication | msmc                    |
| Game Launch    | minecraft-launcher-core |
| Auto Updates   | electron-updater        |
| Packaging      | electron-builder        |
| CI/CD          | GitHub Actions          |

## License

ISC License

Copyright © Lyam
