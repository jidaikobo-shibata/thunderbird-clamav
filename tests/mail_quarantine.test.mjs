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
  assert.equal(await inQuarantine({ folder: destination }, { quarantine: { one: config } }), true);
  assert.equal(await inQuarantine(await api.messages.get(2), {}, [record], { session: "new" }), true);
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


test("a former destination excludes only the verified moved message, never unrelated new mail", async () => {
  const { api, record, hooks } = await fixture();
  await moveToQuarantine(api, record, config, hooks);
  const moved = await api.messages.get(2);
  assert.equal(await inQuarantine({ ...moved, id: 9, headerMessageId: "new@invalid" }, {}, [record], { session: "new", digestOf: async () => { throw Error("must not read unrelated mail"); } }), false);
  // Session IDs cannot be reused after restart; matching headers require a digest.
  assert.equal(await inQuarantine({ ...moved, id: 9 }, {}, [record], { session: "later", digestOf: async () => "different" }), false);
  assert.equal(await inQuarantine({ ...moved, id: 9 }, {}, [record], { session: "later", digestOf: async () => record.sha256 }), true);
  assert.equal(await inQuarantine(moved, {}, [record], { session: "later", digestOf: async () => { throw Error("offline"); } }), false);
  record.status = "deleted";
  assert.equal(await inQuarantine(moved, {}, [record], { session: "new", digestOf: async () => record.sha256 }), false);
});

test("unchanged invalid destinations do not block disabling or unrelated settings, but opt-ins still validate", async () => {
  const { api } = await fixture({ allowed: false });
  const { quarantineNeedsPermission } = await import("../thunderbird/quarantine.mjs");
  const stale = { one: { folderId: "gone", path: "/Gone", auto: true }, two: { folderId: "gone-two", path: "/GoneTwo", auto: true } };
  const unchanged = await validateQuarantine(api, stale, ["one", "two"], stale);
  assert.deepEqual(unchanged, stale);
  const disabled = { ...stale, one: { ...stale.one, auto: false } };
  assert.deepEqual(await validateQuarantine(api, disabled, ["one", "two"], stale), disabled);
  assert.equal(quarantineNeedsPermission(stale, unchanged), false);
  assert.equal(quarantineNeedsPermission(stale, disabled), false);
  assert.equal(quarantineNeedsPermission(disabled, stale), true);
  await assert.rejects(validateQuarantine(api, stale, ["one", "two"], disabled));
  assert.equal(quarantineNeedsPermission(stale, { one: config }), true);
  await assert.rejects(validateQuarantine(api, { one: config }, ["one"], stale));
});

test("verified location changes and legacy display stop claiming mail is still quarantined", async () => {
  const { refreshQuarantineLocation } = await import("../thunderbird/quarantine.mjs");
  const { quarantineSummary } = await import("../thunderbird/quarantine-ui.mjs");
  const { api, record, hooks } = await fixture();
  await moveToQuarantine(api, record, config, hooks);
  const restored = { ...await api.messages.get(2), id: 7, folder: source };
  // Historical state from 0.16.0 is rendered safely before a re-scan.
  record.locator = locator(restored);
  assert.match(quarantineSummary(record, []), /隔離先の外/);
  refreshQuarantineLocation(record, restored);
  assert.equal(record.quarantine.status, "outside");
  assert.equal(record.messageId, 7);
  assert.match(quarantineSummary(record, []), /隔離先の外/);
  refreshQuarantineLocation(record, { ...restored, id: 8, folder: destination });
  assert.equal(record.quarantine.status, "moved");
});
