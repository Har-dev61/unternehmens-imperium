/**
 * Tiny publish/subscribe event bus.
 * Decouples the game logic from the UI: the logic emits semantic events
 * ("money:changed", "asset:bought", ...) and the UI subscribes to them.
 */
export type Listener = (payload?: any) => void;

export class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  /** Subscribe to an event. Returns an unsubscribe function. */
  on(event: string, callback: Listener): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(callback);
    return () => this.off(event, callback);
  }

  /** Unsubscribe a previously registered callback. */
  off(event: string, callback: Listener): void {
    this.listeners.get(event)?.delete(callback);
  }

  /** Emit an event to all subscribers. Listener errors are isolated. */
  emit(event: string, payload?: any): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`[EventBus] listener for "${event}" threw:`, err);
      }
    }
  }
}
