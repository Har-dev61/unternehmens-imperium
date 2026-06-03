/**
 * Persistence layer. Owns the localStorage slot, JSON (de)serialisation, the
 * save timestamp (for offline progress) and import/export as a base64 string.
 */
export class SaveSystem {
    storageKey;
    SAVE_VERSION = 1;
    constructor(storageKey = 'unternehmens-imperium-save') {
        this.storageKey = storageKey;
    }
    /** Persist a game-state object. Stamps the current time. */
    save(state) {
        try {
            state.version = this.SAVE_VERSION;
            state.savedAt = Date.now();
            localStorage.setItem(this.storageKey, JSON.stringify(state));
            return true;
        }
        catch (err) {
            console.error('[SaveSystem] save failed:', err);
            return false;
        }
    }
    /** Load the raw game-state object, or null if none / corrupt. */
    load() {
        try {
            const raw = localStorage.getItem(this.storageKey);
            if (!raw)
                return null;
            return JSON.parse(raw);
        }
        catch (err) {
            console.error('[SaveSystem] load failed:', err);
            return null;
        }
    }
    hasSave() {
        return localStorage.getItem(this.storageKey) != null;
    }
    clear() {
        localStorage.removeItem(this.storageKey);
    }
    /** Encode a state object to a portable base64 string (for sharing/backup). */
    exportSave(state) {
        state.version = this.SAVE_VERSION;
        state.savedAt = Date.now();
        const json = JSON.stringify(state);
        return btoa(unescape(encodeURIComponent(json)));
    }
    /** Decode a base64 string back into a state object (throws on garbage). */
    importSave(encoded) {
        const json = decodeURIComponent(escape(atob(encoded.trim())));
        return JSON.parse(json);
    }
}
//# sourceMappingURL=SaveSystem.js.map