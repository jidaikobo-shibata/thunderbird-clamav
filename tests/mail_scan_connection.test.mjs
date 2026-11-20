import assert from "node:assert/strict";
import { test } from "node:test";
import { ScanConnection, SCAN_IDLE_MS } from "../thunderbird/scan-connection.mjs";

function fixture(options = {}) {
  const clients = [], timers = [];
  const cache = new ScanConnection(() => {
    const client = { closed: false, close() { this.closed = true; } };
    clients.push(client); return client;
  }, { setTimer(callback, ms) { const timer = { callback, ms, active: true }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.active = false; }, ...options });
  return { cache, clients, timers };
}

test("healthy scanner and negotiated health are reused briefly between bursts", () => {
  const { cache, clients, timers } = fixture();
  const first = cache.acquire(); first.health = { protocol: 1 };
  cache.release(first);
  assert.equal(timers[0].ms, SCAN_IDLE_MS);
  const next = cache.acquire();
  assert.equal(next, first);
  assert.equal(next.health.protocol, 1);
  assert.equal(clients.length, 1);
  assert.equal(timers[0].active, false);
});

test("idle expiry closes the scanner and the next acquire opens a fresh one", () => {
  const { cache, clients, timers } = fixture();
  const first = cache.acquire(); cache.release(first); timers[0].callback();
  assert.equal(first.client.closed, true);
  const next = cache.acquire();
  assert.notEqual(next, first);
  assert.equal(next.health, null);
  assert.equal(clients.length, 2);
});

test("a cancelled but dispatched expiry cannot close a reacquired scanner", () => {
  const { cache, timers } = fixture();
  const first = cache.acquire(); cache.release(first);
  cache.acquire();
  timers[0].callback();
  assert.equal(first.client.closed, false);
  cache.release(first); timers[1].callback();
  assert.equal(first.client.closed, true);
});

test("explicit discard cancels retention without letting stale release close a replacement", () => {
  const { cache, timers } = fixture();
  const first = cache.acquire(); cache.release(first); cache.discard();
  assert.equal(first.client.closed, true);
  const next = cache.acquire(); cache.release(first); timers[0].callback();
  assert.equal(next.client.closed, false);
});

test("disconnected clients are not reused", () => {
  const { cache, clients } = fixture();
  const first = cache.acquire(); cache.release(first); first.client.close();
  assert.notEqual(cache.acquire(), first);
  assert.equal(clients.length, 2);
});

test("zero idle retention keeps legacy close-on-completion behavior", () => {
  const { cache, timers } = fixture({ idleMs: 0 });
  const first = cache.acquire(); cache.release(first);
  assert.equal(first.client.closed, true);
  assert.equal(timers.length, 0);
});

test("browser timer methods retain their global receiver", () => {
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  let cancelled = false;
  try {
    globalThis.setTimeout = function () { assert.equal(this, globalThis); return 1; };
    globalThis.clearTimeout = function () { assert.equal(this, globalThis); cancelled = true; };
    const cache = new ScanConnection(() => ({ closed: false, close() { this.closed = true; } }));
    const first = cache.acquire(); cache.release(first); cache.acquire();
    assert.equal(cancelled, true);
    cache.discard();
  } finally { globalThis.setTimeout = set; globalThis.clearTimeout = clear; }
});

test("timer setup failure closes the scanner instead of retaining it indefinitely", () => {
  const { cache } = fixture({ setTimer() { throw new Error("synthetic timer failure"); } });
  const first = cache.acquire();
  assert.doesNotThrow(() => cache.release(first));
  assert.equal(first.client.closed, true);
  assert.notEqual(cache.acquire(), first);
});
