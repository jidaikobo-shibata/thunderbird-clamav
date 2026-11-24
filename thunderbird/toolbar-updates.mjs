// Each property owns one request and one latest value. Rendering may pause for
// a hidden window, but must never hold mail admission, storage or scanning.
export function toolbarUpdates(action, onError = error => console.warn("Toolbar update failed", error)) {
  const unset = Symbol("unset");
  const lanes = [
    ["setIcon", "path", notice => notice.dot ? `icon-${notice.dot}.svg` : "icon.svg"],
    ["setBadgeText", "text", notice => notice.text],
    ["setBadgeBackgroundColor", "color", notice => notice.color],
    ["setTitle", "title", notice => notice.title]
  ].map(([method, key, value]) => ({ method, key, value, wanted: unset, applied: unset, pending: false }));
  function flush(lane) {
    if (lane.pending || lane.wanted === lane.applied) return;
    lane.pending = true;
    let attempted;
    void Promise.resolve().then(() => {
      attempted = lane.wanted;
      return action[lane.method]({ [lane.key]: attempted });
    }).then(() => { lane.applied = attempted; }, error => {
      // A display failure is not a scan failure. Do not recursively update the
      // toolbar by reporting it through the mail-operation error handler.
      lane.applied = unset;
      try { onError(error); } catch { /* Logging must not reject this task. */ }
    }).finally(() => {
      lane.pending = false;
      if (lane.wanted !== attempted) flush(lane);
    });
  }
  return { update(notice) {
    for (const lane of lanes) { lane.wanted = lane.value(notice); flush(lane); }
  } };
}
