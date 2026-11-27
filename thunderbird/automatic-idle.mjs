export const AUTOMATIC_IDLE_SECONDS = 30;

// Only activity state is observed. No keys or message content are collected.
export class AutomaticIdle {
  constructor(api, wake, windows) {
    this.api = api;
    this.windows = windows;
    this.focus = "unknown";
    this.focusRevision = 0;
    windows?.onFocusChanged?.addListener(id => {
      if (this.enabled) this.observeFocus(id);
    });
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
  observeFocus(id) {
    const revision = ++this.focusRevision;
    clearTimeout(this.focusTimer);
    this.focus = "checking";
    // A focus change may itself be input. Discard an older idle answer before
    // allowing the next body read, including while the window type is pending.
    this.state = "unknown";
    this.epoch++;
    const background = () => {
      this.focusTimer = setTimeout(() => {
        if (revision !== this.focusRevision) return;
        this.focus = "background";
        this.wake();
      }, 500);
    };
    if (id === this.windows.WINDOW_ID_NONE && id !== undefined) {
      background();
      return;
    }
    const query = id === undefined ? this.windows.getLastFocused() : this.windows.get(id);
    this.focusTimer = setTimeout(() => {
      if (revision !== this.focusRevision) return;
      this.focusRevision++;
      this.focus = "unknown";
      if (this.state === "idle") this.wake();
    }, 5000);
    query.then(win => {
      if (revision !== this.focusRevision) return;
      clearTimeout(this.focusTimer);
      if (win.focused === false && id === undefined) { background(); return; }
      if (!win.focused) { this.focus = "unknown"; return; }
      this.focus = win.type === "normal" || win.type === "messageDisplay" ? "reading" :
        win.type === "messageCompose" ? "compose" : "other";
      if (this.focus === "reading") this.wake();
      // refresh() also runs periodically; recheck promptly after entering compose.
      else void this.refresh(true).catch(() => {});
    }).catch(() => {
      if (revision !== this.focusRevision) return;
      clearTimeout(this.focusTimer);
      this.focus = "unknown";
      if (this.state === "idle") this.wake();
    });
  }
  canStart(settings) {
    return !settings.idleAutomatic || this.focus === "reading" || this.focus === "background" ||
      this.focus !== "checking" && this.state === "idle";
  }
  get waitingState() {
    return this.focus === "compose" && this.state === "active" ? "compose" : "unknown";
  }
  refresh(enabled) {
    if (!enabled) {
      this.enabled = false;
      clearTimeout(this.focusTimer);
      this.focusRevision++;
      this.focus = "unknown";
      this.epoch++;
      this.state = "unknown";
      return Promise.resolve();
    }
    if (!this.enabled) {
      this.state = "unknown";
      this.enabled = true;
      if (this.windows?.onFocusChanged && this.windows.getLastFocused) this.observeFocus();
    }
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
