import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NativeClient, MAX_BYTES, bytesToBase64, sha256, sameEnvelope,
  locator, validateSettings, messagePages
} from "../thunderbird/core.mjs";

test("binary bytes survive base64 and sha256", async () => {
  const bytes = Uint8Array.from({ length: 200000 }, (_, i) => i % 256);
  assert.deepEqual(new Uint8Array(Buffer.from(bytesToBase64(bytes), "base64")), bytes);
  assert.equal(await sha256(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(MAX_BYTES, 25 * 1024 * 1024);
});

test("mail identity rejects cross-account and same-subject replacements", () => {
  const mail = { author: "a", subject: "test", date: new Date("2026-01-01"),
    headerMessageId: "a@b", folder: { accountId: "one" } };
  const saved = locator(mail);
  assert.equal(sameEnvelope(mail, saved), true);
  assert.equal(sameEnvelope({ ...mail, headerMessageId: "evil@b" }, saved), false);
  assert.equal(sameEnvelope({ ...mail, folder: { accountId: "two" } }, saved), false);
});

test("settings require a real account for automatic scanning", () => {
  assert.throws(() => validateSettings({ enabled: true, notifications: true, accountIds: [] }, ["a"]));
  assert.throws(() => validateSettings({ enabled: true, notifications: true, accountIds: ["bad"] }, ["a"]));
  assert.deepEqual(validateSettings({ enabled: true, notifications: false, accountIds: ["a", "a"] }, ["a"]),
    { enabled: true, notifications: false, accountIds: ["a"] });
});

test("all message pages are consumed", async () => {
  const found = [];
  for await (const message of messagePages({ continueList: async id => {
    assert.equal(id, "next"); return { messages: [{ id: 2 }] };
  } }, { messages: [{ id: 1 }], id: "next" })) found.push(message.id);
  assert.deepEqual(found, [1, 2]);
});

test("an abandoned message list is finalized", async () => {
  let aborted;
  for await (const message of messagePages({ abortList: async id => { aborted = id; } },
    { messages: [{ id: 1 }, { id: 2 }], id: "pending" })) {
    assert.equal(message.id, 1);
    break;
  }
  assert.equal(aborted, "pending");
});

function event() {
  const handlers = [];
  return { addListener: handler => handlers.push(handler), emit: value => handlers.forEach(h => h(value)) };
}

test("native transfer is acknowledged in chunks and verifies the scanned hash", async () => {
  const port = { onMessage: event(), onDisconnect: event(), disconnect() {},
    postMessage(message) {
      if (message.op === "chunk") chunks.push(message);
      queueMicrotask(() => this.onMessage.emit({ id: message.id,
        status: message.op === "end" ? "clean" : "accepted", seq: message.seq + 1,
        sha256: message.sha256 }));
    } };
  const chunks = [];
  const client = new NativeClient({ connectNative: () => port });
  const data = new Uint8Array(150000).fill(255);
  const digest = await sha256(data);
  assert.equal((await client.scan(data, digest)).status, "clean");
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every(chunk => Buffer.from(chunk.data, "base64").length <= 65536));
  client.close();
});

test("native disconnect rejects pending work instead of reporting clean", async () => {
  const port = { onMessage: event(), onDisconnect: event(), disconnect() {}, postMessage() {} };
  const client = new NativeClient({ connectNative: () => port });
  const pending = client.request("health");
  port.onDisconnect.emit();
  await assert.rejects(pending, /接続が切れ/);
});

test("native mismatched digest is rejected", async () => {
  const port = { onMessage: event(), onDisconnect: event(), disconnect() {},
    postMessage(message) {
      queueMicrotask(() => this.onMessage.emit({ id: message.id,
        status: message.op === "end" ? "clean" : "accepted", seq: message.seq + 1, sha256: "wrong" }));
    } };
  const client = new NativeClient({ connectNative: () => port });
  await assert.rejects(client.scan(new Uint8Array([1]), "expected"), /照合/);
  client.close();
});
