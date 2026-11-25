import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeClient, sha256 } from "../thunderbird/core.mjs";
import { directPort, permission } from "../thunderbird/direct-transport.mjs";

test("integrated client uses packaged transport and validates the scan policy and digest", async () => {
  const before = globalThis.messenger, operations = [], closed = [];
  let policy;
  const runtime = { getManifest: () => ({ experiment_apis: { clamDirect: {} } }),
    connectNative() { throw Error("must not use installed native host"); } };
  globalThis.messenger = { runtime, clamDirect: {
    open: async () => "session",
    close: async token => closed.push(token),
    request: async (token, json) => {
      assert.equal(token, "session");
      const value = JSON.parse(json); operations.push(value.op);
      if (value.op === "begin") policy = value.scanSettings;
      return JSON.stringify({ id: value.id, ...(value.op === "end" ? { status: "clean", sha256: value.sha256, scanSettings: policy } : { status: "accepted", seq: value.seq + 1 }) });
    }
  } };
  const client = new NativeClient(runtime);
  try {
    const bytes = new Uint8Array(200000).fill(42), hash = await sha256(bytes);
    const settings = { mailMiB: 25 };
    assert.equal((await client.scan(bytes, hash, settings)).status, "clean");
    assert.deepEqual(operations, ["begin", "chunk", "chunk", "chunk", "chunk", "end"]);
  } finally { client.close(); globalThis.messenger = before; }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(closed, ["session"]);
});

test("the selected Windows GUI database must be acknowledged before transferring mail", async () => {
  const previous = globalThis.messenger, requests = [];
  const runtime = { getManifest: () => ({ experiment_apis: { clamDirect: {} } }), getPlatformInfo: async () => ({os: "win"}) };
  globalThis.messenger = { runtime, clamDirect: { open: async () => "test", close: async () => {},
    request: async (_, data) => {
      const frame = JSON.parse(data);
      requests.push([frame.op, frame.definitionSource]);
      return JSON.stringify({id: frame.id, status: frame.op === "health" ? "ready" : "accepted"});
    }
  } };
  const client = new NativeClient(runtime, "gui");
  try {
    await assert.rejects(client.request("health"));
    await assert.rejects(client.scan(new Uint8Array([1]), "unused"));
    assert.deepEqual(requests, [["health", "gui"], ["begin", "gui"]]);
  } finally { client.close(); globalThis.messenger = previous; }
});

test("closing an opening port still cleans up its eventual session", async () => {
  let opened, closed;
  const port = directPort({ open: () => new Promise(resolve => { opened = resolve; }), close: async token => { closed = token; } });
  port.disconnect();
  await Promise.resolve();
  opened("late-session");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, "late-session");
});

test("malformed direct responses disconnect the port rather than hanging pending requests", async () => {
  let disconnected = false;
  const port = directPort({ open: async () => "test", close: async () => {}, request: async () => "not JSON" });
  port.onDisconnect.addListener(() => { disconnected = true; });
  port.postMessage({ op: "health", id: "1" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disconnected, true);
  assert.equal(port.closed, true);
});

test("integrated permissions check the manifest grants without optional permission prompts", async () => {
  const calls = [];
  const api = { runtime: { getManifest: () => ({ experiment_apis: { clamDirect: {} } }) }, permissions: {
    contains: async value => { calls.push(value); return true; }, request() { throw Error("optional request unsupported"); }
  } };
  assert.equal(await permission(api, ["messagesDelete"]), true);
  assert.deepEqual(calls, [{ permissions: ["messagesDelete"] }]);
});
