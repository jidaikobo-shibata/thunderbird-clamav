export function directRuntime(runtime = globalThis.messenger?.runtime) {
  return Boolean(runtime?.getManifest?.().experiment_apis?.clamDirect);
}

export function permission(api, permissions) {
  // Experiments use required permissions; optional permission requests are unsupported.
  return directRuntime(api.runtime) ? api.permissions.contains({ permissions }) : api.permissions.request({ permissions });
}

export function directPort(api) {
  const messageListeners = [], disconnectListeners = [];
  const port = {
    closed: false, error: null,
    onMessage: { addListener: listener => messageListeners.push(listener) },
    onDisconnect: { addListener: listener => disconnectListeners.push(listener) },
    disconnect() {
      if (port.closed) return;
      port.closed = true;
      void ready.then(token => api.close(token)).catch(() => {});
    },
    postMessage(value) {
      if (port.closed) throw new Error("Direct scanner connection is closed");
      void ready.then(token => api.request(token, JSON.stringify(value))).then(data => {
        if (!port.closed) { const value = JSON.parse(data); for (const listener of messageListeners) listener(value); }
      }).catch(fail);
    }
  };
  function fail(error) {
    if (port.closed) return;
    port.error = error;
    for (const listener of disconnectListeners) listener();
    port.disconnect();
  }
  const ready = Promise.resolve().then(() => api.open());
  void ready.catch(fail);
  return port;
}
