/**
 * Number / money / time formatting helpers.
 * Pure functions, no dependencies — safe to import anywhere.
 */
// Short suffixes (international, widely understood). Beyond Dc we fall back to
// scientific notation so the UI never overflows.
const TIERS = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
/** Format a raw number into a compact, human-readable string. */
export function formatNumber(n, decimals = 2) {
    if (n === Infinity)
        return '∞';
    if (!Number.isFinite(n))
        return '0';
    if (n < 0)
        return '-' + formatNumber(-n, decimals);
    if (n < 1000) {
        return Number.isInteger(n) ? String(n) : trimZeros(n.toFixed(decimals));
    }
    const tier = Math.floor(Math.log10(n) / 3);
    if (tier < TIERS.length) {
        const scaled = n / Math.pow(10, tier * 3);
        return trimZeros(scaled.toFixed(decimals)) + TIERS[tier];
    }
    // Very large numbers → scientific notation (e.g. 1.23e45)
    return n.toExponential(decimals).replace('e+', 'e');
}
/** Money string with the € prefix. */
export function formatMoney(n, decimals = 2) {
    return '€' + formatNumber(n, decimals);
}
/** Per-second money string. */
export function formatRate(n) {
    return formatMoney(n, 1) + '/s';
}
/** Format seconds into "1h 23m 45s" style. */
export function formatTime(totalSeconds) {
    totalSeconds = Math.max(0, Math.floor(totalSeconds));
    const d = Math.floor(totalSeconds / 86400);
    const h = Math.floor((totalSeconds % 86400) / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const parts = [];
    if (d)
        parts.push(d + 't');
    if (h)
        parts.push(h + 'h');
    if (m)
        parts.push(m + 'm');
    if (s || parts.length === 0)
        parts.push(s + 's');
    return parts.join(' ');
}
/** Format an ISO 'YYYY-MM-DD' date as German 'DD.MM.YYYY' (no Date parsing → timezone-safe). */
export function formatDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}
function trimZeros(str) {
    return str.replace(/\.?0+$/, '');
}
//# sourceMappingURL=format.js.map