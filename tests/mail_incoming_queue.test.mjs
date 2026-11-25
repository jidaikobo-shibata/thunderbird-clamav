import assert from "node:assert/strict";
import { test } from "node:test";
import { IncomingQueue } from "../thunderbird/incoming-queue.mjs";

test("receipts with identical Message-IDs survive independent writes and restart", async () => {
  const stored = { records: { format: 2 } };
  const storage = {
    async set(patch) { assert.equal(Object.keys(patch).length, 1); Object.assign(stored, structuredClone(patch)); },
    async remove(key) { delete stored[key]; }
  };
  const queue = new IncomingQueue(storage);
  for (const key of ["a", "b"]) {
    await queue.accept({ key, createdAt: "2026-11-25T01:00:00Z", locator: { accountId: "one", headerMessageId: "same" } });
  }
  const restored = new IncomingQueue(storage);
  restored.restore(stored);
  assert.deepEqual([...restored.entries.keys()], ["a", "b"]);
  storage.remove = async () => { throw Error("storage unavailable"); };
  await assert.rejects(restored.finish("a"), /storage unavailable/);
  assert(restored.entries.has("a"));
  assert(stored["incomingReceipt:a"]);
  storage.set = async () => { throw Error("storage unavailable"); };
  await assert.rejects(restored.accept({key:"c"}), /storage unavailable/);
  assert(!restored.entries.has("c"));
});
