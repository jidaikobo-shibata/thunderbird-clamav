export const SCAN_IDLE_MS = 5000;

/** One serial scanner, retained briefly between bursts, never across failures. */
export class ScanConnection {
  constructor(create, { idleMs = SCAN_IDLE_MS, setTimer = globalThis.setTimeout.bind(globalThis), clearTimer = globalThis.clearTimeout.bind(globalThis) } = {}) {
    Object.assign(this, { create, idleMs, setTimer, clearTimer });
    this.current = null;
    this.timer = null;
    this.generation = 0;
  }
  cancelTimer() {
    this.generation++;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
  acquire() {
    this.cancelTimer();
    if (this.current?.client.closed) this.discard(this.current);
    this.current ||= { client: this.create(), health: null };
    return this.current;
  }
  discard(connection = this.current) {
    if (!connection) return;
    if (this.current === connection) {
      this.cancelTimer();
      this.current = null;
    }
    connection.client.close();
  }
  release(connection) {
    if (!connection) return;
    if (this.current !== connection || connection.client.closed || !this.idleMs) {
      this.discard(connection);
      return;
    }
    this.cancelTimer();
    const generation = this.generation;
    try {
      this.timer = this.setTimer(() => {
        // Even an already-dispatched expiry must not close a reacquired scanner.
        if (generation !== this.generation || this.current !== connection) return;
        this.timer = null;
        this.current = null;
        connection.client.close();
      }, this.idleMs);
    } catch {
      // Retention is optional; fall back to immediate cleanup if timers fail.
      this.discard(connection);
    }
    this.timer?.unref?.();
  }
}
