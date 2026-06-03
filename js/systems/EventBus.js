export class EventBus {
    listeners = new Map();
    /** Subscribe to an event. Returns an unsubscribe function. */
    on(event, callback) {
        if (!this.listeners.has(event))
            this.listeners.set(event, new Set());
        this.listeners.get(event).add(callback);
        return () => this.off(event, callback);
    }
    /** Unsubscribe a previously registered callback. */
    off(event, callback) {
        this.listeners.get(event)?.delete(callback);
    }
    /** Emit an event to all subscribers. Listener errors are isolated. */
    emit(event, payload) {
        const set = this.listeners.get(event);
        if (!set)
            return;
        for (const cb of set) {
            try {
                cb(payload);
            }
            catch (err) {
                console.error(`[EventBus] listener for "${event}" threw:`, err);
            }
        }
    }
}
//# sourceMappingURL=EventBus.js.map