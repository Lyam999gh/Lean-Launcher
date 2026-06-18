#!/bin/bash
# extract-prism-lwjgl-arm64-dylibs.sh
# ====================================
# Extracts the ARM64-compiled LWJGL 2.9.4 dylibs from a working Prism Launcher
# Minecraft 1.8.9 instance and copies them to LeanLauncher's lwjgl-cache.
#
# Usage:
#   chmod +x extract-prism-lwjgl-arm64-dylibs.sh
#   ./extract-prism-lwjgl-arm64-dylibs.sh
#
# Output: ARM64 dylibs placed in lwjgl-cache/natives/2.9.4/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST_DIR="$SCRIPT_DIR/lwjgl-cache/natives/2.9.4"

echo "=== Extracting LWJGL 2.9.4 ARM64 dylibs from Prism Launcher ==="
echo ""

# Prism Launcher stores per-instance Minecraft data at:
#   ~/Library/Application Support/PrismLauncher/instances/<instance_name>/.minecraft/
# or inside the instance directory directly.

PRISM_INSTANCES="$HOME/Library/Application Support/PrismLauncher/instances"

if [ ! -d "$PRISM_INSTANCES" ]; then
    echo "ERROR: Prism Launcher instances directory not found at:"
    echo "  $PRISM_INSTANCES"
    echo ""
    echo "If you installed Prism Launcher elsewhere, set the path manually:"
    echo "  PRISM_INSTANCES=/path/to/instances $0"
    exit 1
fi

# Find every 1.8.9 instance (or any pre-1.13 instance using LWJGL 2.x)
echo "Scanning Prism Launcher instances..."
FOUND_COUNT=0
COPIED_COUNT=0

find "$PRISM_INSTANCES" -maxdepth 3 -path "*/natives/*" -type d 2>/dev/null | while read -r dir; do
    # Check if this directory contains LWJGL 2.x dylibs
    if [ -f "$dir/liblwjgl.dylib" ]; then
        ARCH=""
        ARM64_FOUND=""
        for dylib in "$dir"/liblwjgl.dylib "$dir"/libopenal.dylib; do
            if [ -f "$dylib" ]; then
                file_out=$(file "$dylib" 2>/dev/null || true)
                if echo "$file_out" | grep -q "arm64"; then
                    ARM64_FOUND="yes"
                    ARCH="arm64"
                fi
            fi
        done
        
        if [ "$ARM64_FOUND" = "yes" ]; then
            FOUND_COUNT=$((FOUND_COUNT + 1))
            echo ""
            echo "Found ARM64 LWJGL 2.x dylibs in: $dir"
            
            mkdir -p "$DEST_DIR"
            for dylib in liblwjgl.dylib liblwjgl_util.dylib libopenal.dylib; do
                if [ -f "$dir/$dylib" ]; then
                    cp -f "$dir/$dylib" "$DEST_DIR/$dylib"
                    chmod 755 "$DEST_DIR/$dylib"
                    file_out=$(file "$DEST_DIR/$dylib" 2>/dev/null)
                    echo "  ✓ $dylib — $file_out"
                    COPIED_COUNT=$((COPIED_COUNT + 1))
                fi
            done
            
            # Also copy any other .dylib files in this directory
            for dylib in "$dir"/*.dylib; do
                if [ -f "$dylib" ]; then
                    name=$(basename "$dylib")
                    if [ ! -f "$DEST_DIR/$name" ]; then
                        cp -f "$dylib" "$DEST_DIR/$name"
                        chmod 755 "$DEST_DIR/$name"
                        echo "  ✓ $name (additional)"
                    fi
                fi
            done
        fi
    fi
done

echo ""
echo "=== Summary ==="
if [ -d "$DEST_DIR" ]; then
    echo "ARM64 dylibs deployed to: $DEST_DIR"
    ls -la "$DEST_DIR/"
    echo ""
    echo "LeanLauncher will now use these ARM64 dylibs to override"
    echo "the x86_64 Mojang-originals after MCLC extraction."
else
    echo "No ARM64 LWJGL 2.x dylibs found in Prism Launcher instances."
    echo ""
    echo "Make sure you have launched Minecraft 1.8.9 at least once"
    echo "through Prism Launcher on this Apple Silicon Mac."
fi
