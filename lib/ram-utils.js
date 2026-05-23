// --- RAM Utilities ---

/**
 * Clamp a raw megabyte value to a safe range (512 MB – 65536 MB).
 * Returns 4096 (4 GB) on invalid input.
 */
export function normalizeRamMb(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 4096;
    return Math.max(512, Math.min(65536, Math.round(parsed)));
}

/**
 * Clamp a GB value to the slider range (2–10).
 */
export function clampRamForSlider(value) {
    return Math.max(2, Math.min(10, Number(value)));
}

/**
 * Snap a GB value to the nearest 2 GB mark when within ±0.2 GB.
 */
export function applySoftRamSnap(valueGb) {
    const clamped = clampRamForSlider(valueGb);
    const snapped = Math.round(clamped / 2) * 2;
    const SNAP_DISTANCE_GB = 0.2;
    if (Math.abs(clamped - snapped) <= SNAP_DISTANCE_GB) return snapped;
    return Number(clamped.toFixed(1));
}

/**
 * Normalize a GB value to the range 0.5–64, fixed to 1 decimal.
 */
export function normalizeRamGb(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 4;
    return Math.max(0.5, Math.min(64, Number(parsed.toFixed(1))));
}

/**
 * Convert GB to MB (rounded).
 */
export function gbToMb(valueGb) {
    return Math.round(Number(valueGb) * 1024);
}

/**
 * Convert MB to GB.
 */
export function mbToGb(valueMb) {
    return Number(valueMb) / 1024;
}

/**
 * Format a GB value for display: integers stay as-is, floats keep 1 decimal with no trailing ".0".
 */
export function formatRamGb(valueGb) {
    return Number.isInteger(valueGb) ? String(valueGb) : valueGb.toFixed(1).replace(/\.0$/, '');
}
