import assert from "node:assert/strict";
import { test } from "node:test";
import { moveToQuarantine, validateQuarantine, quarantineFolder, inQuarantine } from "../thunderbird/quarantine.mjs";
import { locator, sha256 } from "../thunderbird/core.mjs";

const source = { id: "inbox", accountId: "one", path: "/Inbox", name: "Inbox" };
const destination = { id: "isolation", accountId: "one", path: "/Isolation", name: "Isolation" };
const config = { folderId: destination.id, path: destination.path, auto: true };
async function fixture({ allowed = true, copy = false, moveFailure = false, duplicate = false, mismatch = false, sourceReadOnly = false } = {}) {
  const bytes = new TextEncoder().encode("Subject: sample\r\n\r\nsynthetic");
  const message = { id: 1, folder: source, headerMessageId: "unique@invalid", author: "sender@invalid", subject: "sample", date: new Date(0) };
  const record = { key: "test", status: "detected", sha256: await sha256(bytes), locator: locator(message), messageId: 1 };
  const messages = new Map([[1, message]]), calls = [];
  const api = {
    permissions: { contains: async () => allowed },
    folders: { get: async id => id === source.id ? source : id === destination.id ? destination : undefined,
      getFolderCapabilities: async id => ({ canAddMessages: true, canDeleteMessages: !(sourceReadOnly && id === source.id) }) },
    messages: {
      get: async id => { if (!messages.has(id)) throw Error("missing"); return messages.get(id); },
      move: async (ids, target, options) => { calls.push({ ids, target, options }); if (moveFailure) throw Error("server unavailable");
        if (!copy) messages.delete(1);
        messages.set(2, { ...message, id: 2, folder: destination });
        if (duplicate) messages.set(3, { ...message, id: 3, folder: destination });
      },
      query: async query => ({ messages: [...messages.values()].filter(message => message.folder.id === query.folderId) })
    }
  };
  const hooks = { session: "new", automatic: true, save: async () => {}, rawBytes: async () => mismatch ? new Uint8Array([1]) : bytes,
    verified: async () => ({ message }) };
  return { api, record, hooks, calls };
}

test("quarantine verifies moved contents and updates the message ID and locator", async () => {
  const { api, record, hooks, calls } = await fixture();
  await moveToQuarantine(api, record, config, hooks);
  assert.equal(record.status, "detected");
  assert.equal(record.messageId, 2);
  assert.equal(record.locator.folder.id, destination.id);
  assert.equal(record.quarantine.status, "moved");
  assert.equal(calls[0].options.isUserAction, false);
  assert.equal(inQuarantine({ folder: destination }, { quarantine: { one: config } }), true);
  assert.equal(inQuarantine({ folder: destination }, {}, [record]), true);
});

test("quarantine fails safely for copying, ambiguous results, changed content and server errors", async () => {
  for (const options of [{ copy: true }, { duplicate: true }, { mismatch: true }, { moveFailure: true }]) {
    const { api, record, hooks } = await fixture(options);
    await assert.rejects(moveToQuarantine(api, record, config, hooks));
    assert.equal(record.status, "detected");
    assert.notEqual(record.quarantine?.status, "moved");
    assert.equal(record.messageId, 1);
  }
});

test("permission, digest verification, same-account destination and write capabilities precede movement", async () => {
  for (const options of [{ allowed: false }, { sourceReadOnly: true }]) {
    const { api, record, hooks, calls } = await fixture(options);
    await assert.rejects(moveToQuarantine(api, record, config, hooks));
    assert.equal(calls.length, 0);
  }
  const { api, record, hooks, calls } = await fixture();
  await assert.rejects(moveToQuarantine(api, record, { ...config, path: "/renamed" }, hooks));
  record.locator.accountId = "two";
  await assert.rejects(moveToQuarantine(api, record, config, hooks));
  record.locator.accountId = "one";
  hooks.verified = async () => { throw Error("digest mismatch"); };
  await assert.rejects(moveToQuarantine(api, record, config, hooks));
  assert.equal(calls.length, 0);
});

test("invalid settings, virtual and special-use folders cannot enable automatic quarantine", async () => {
  const { api } = await fixture();
  assert.deepEqual(await validateQuarantine(api, { one: config }, ["one"]), { one: config });
  await assert.rejects(validateQuarantine(api, { two: config }, ["one", "two"]));
  await assert.rejects(validateQuarantine(api, { one: { ...config, auto: "yes" } }, ["one"]));
  for (const folder of [{ ...destination, isVirtual: true }, { ...destination, specialUse: ["trash"] }, { ...destination, path: "/", isRoot: true }]) assert.equal(quarantineFolder(folder), false);
  api.folders.getFolderCapabilities = async () => ({ canAddMessages: false });
  await assert.rejects(validateQuarantine(api, { one: config }, ["one"]));
});

test("failed persistence prevents the move and preserves prior quarantine information", async () => {
  const { api, record, hooks, calls } = await fixture();
  hooks.save = async () => { throw Error("storage full"); };
  await assert.rejects(moveToQuarantine(api, record, config, hooks));
  assert.equal(calls.length, 0);
  assert.equal(record.quarantine, undefined);
});
