export const AUTOMATIC_IDLE_SECONDS = 30;

// Only activity state is observed. No keys or message content are collected.
export class AutomaticIdle {
  constructor(api, wake) {
    this.api = api;
    this.wake = wake;
    this.state = "unknown";
    this.epoch = 0;
    this.enabled = false;
    this.configured = false;
    api?.onStateChanged.addListener(state => {
      this.epoch++;
      this.state = this.enabled ? state : "unknown";
      if (this.enabled && state === "idle") this.wake();
    });
  }
  canStart(settings) { return !settings.idleAutomatic || this.state === "idle"; }
  refresh(enabled) {
    if (!enabled) {
      this.enabled = false;
      this.epoch++;
      this.state = "unknown";
      return Promise.resolve();
    }
    if (!this.enabled) { this.state = "unknown"; this.enabled = true; }
    if (this.pending) return this.pending;
    // A timed-out native query may still be outstanding. Do not accumulate
    // replacements while its backend is stalled. State events remain usable.
    if (this.inFlight) return Promise.resolve();
    this.inFlight = true;
    const epoch = this.epoch;
    let timer;
    const query = Promise.resolve().then(async () => {
      if (!this.api) throw Error("Idle detection is unavailable");
      if (!this.configured) {
        await this.api.setDetectionInterval(AUTOMATIC_IDLE_SECONDS);
        this.configured = true;
      }
      return this.api.queryState(AUTOMATIC_IDLE_SECONDS);
    });
    void query.then(() => { this.inFlight = false; }, () => { this.inFlight = false; });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("Idle detection timed out")), 5000);
    });
    this.pending = Promise.race([query, timeout]).then(state => {
      if (epoch !== this.epoch) return;
      this.state = this.enabled ? state : "unknown";
      if (this.enabled && state === "idle") this.wake();
    }, error => {
      if (epoch === this.epoch) this.state = "unknown";
      throw error;
    }).finally(() => { clearTimeout(timer); this.pending = null; });
    return this.pending;
  }
}
