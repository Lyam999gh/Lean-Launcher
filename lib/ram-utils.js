// --- RAM helpers ---

// Clamp MB to a safe 512–65536 range, fallback to 4096 (4 GB)
export function normalizeRamMb(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 4096;
    return Math.max(512, Math.min(65536, Math.round(parsed)));
}

// Clamp GB to the slider's 2–10 range
export function clampRamForSlider(value) {
    return Math.max(2, Math.min(10, Number(value)));
}

// Snap to nearest 2 GB step when within 0.2 GB
export function applySoftRamSnap(valueGb) {
    const clamped = clampRamForSlider(valueGb);
    const snapped = Math.round(clamped / 2) * 2;
    const SNAP_DISTANCE_GB = 0.2;
    if (Math.abs(clamped - snapped) <= SNAP_DISTANCE_GB) return snapped;
    return Number(clamped.toFixed(1));
}

// Normalize GB to 0.5–64, 1 decimal
export function normalizeRamGb(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 4;
    return Math.max(0.5, Math.min(64, Number(parsed.toFixed(1))));
}

export function gbToMb(valueGb) {
    return Math.round(Number(valueGb) * 1024);
}

export function mbToGb(valueMb) {
    return Number(valueMb) / 1024;
}

// Display GB nicely: whole numbers as-is, floats to 1 decimal, strip ".0"
export function formatRamGb(valueGb) {
    return Number.isInteger(valueGb) ? String(valueGb) : valueGb.toFixed(1).replace(/\.0$/, '');
}
