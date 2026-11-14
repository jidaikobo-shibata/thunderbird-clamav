import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "../thunderbird/core.mjs";

function event() {
  const listeners = [];
  return { listeners, addListener(listener, ...args) { listeners.push(listener); this.args = args; } };
}

let caseId = 0;
async function harness({ saved = {}, mails = [], nativeFailure = false, oversized = false, deleteAllowed = false, deleteFailure = false, deleteFailureIds = [], scanResult = {}, scanGate = null,
  folderRefs = [{ id: "inbox", accountId: "one", path: "/Inbox", name: "受信トレイ" }] } = {}) {
  let stored = structuredClone(saved);
  const notifications = [], opened = [], rawReads = [], timers = [], deleted = [], nativePorts = [];
  const events = { newMail: event(), selected: event(), message: event() };
  const byId = new Map(mails.map(mail => [mail.id, mail]));
  const api = {
    permissions: { contains: async () => deleteAllowed },
    storage: { local: { get: async () => structuredClone(stored), set: async value => { stored = structuredClone(value); } } },
    runtime: {
      id: "unit", getURL: path => "moz-extension://unit/" + path,
      onMessage: events.message, onInstalled: event(),
      connectNative() {
        const port = { disconnected: false, onMessage: event(), onDisconnect: event(), disconnect() { this.disconnected = true; },
          postMessage(request) {
            queueMicrotask(async () => {
              if (request.op === "end" && scanGate) await scanGate(rawReads.at(-1));
              if (nativeFailure) { port.onDisconnect.listeners[0](); return; }
              const result = request.op === "health" ? { status: "ready", protocol: 1, engine: "test" } :
                request.op === "end" ? { status: "clean", detail: "未検出", sha256: request.sha256, signatures: [],
                  ...(typeof scanResult === "function" ? scanResult(rawReads.at(-1)) : scanResult) } :
                  { status: "accepted", seq: request.seq + 1 };
              port.onMessage.listeners[0]({ id: request.id, ...result });
            });
          } };
        nativePorts.push(port);
        return port;
      }
    },
    messages: {
      delete: async (ids, options) => {
        if (deleteFailure || ids.some(id => deleteFailureIds.includes(id))) throw new Error("server refused deletion");
        deleted.push({ ids, options });
        for (const id of ids) byId.delete(id);
      },
      onNewMailReceived: events.newMail,
      get: async id => { if (!byId.has(id)) throw new Error("missing"); return byId.get(id); },
      getRaw: async (id, options) => {
        assert.equal(options.decrypt, false);
        rawReads.push(id);
        if (oversized) return { size: 26 * 1024 * 1024, arrayBuffer() { throw new Error("must not allocate"); } };
        return new File([byId.get(id).raw || "Subject: example\r\n\r\nhello"], "mail.eml");
      },
      query: async query => ({ messages: mails.filter(mail => mail.headerMessageId === query.headerMessageId) }),
      list: async ref => {
        const folder = typeof ref === "string" ? folderRefs.find(folder => folder.id === ref) : ref;
        return { messages: mails.filter(mail => mail.folder?.accountId === folder.accountId && mail.folder?.path === folder.path) };
      },
      continueList: async () => ({ messages: [] })
    },
    accounts: { list: async () => [{ id: "one", name: "one", type: "imap" }, { id: "two", name: "two", type: "imap" }] },
    folders: { get: async id => folderRefs.find(folder => folder.id === id),
      getSubFolders: async ref => folderRefs.filter(folder => folder.parentId === (typeof ref === "string" ? ref : ref.id)) },
    menus: { onClicked: event(), create() {}, removeAll: async () => {} },
    mailTabs: { onSelectedMessagesChanged: events.selected, query: async () => [{ id: 7, active: true }],
      get: async () => ({ displayedFolder: folderRefs[0] }),
      getSelectedMessages: async () => ({ messages: mails }) },
    browserAction: { onClicked: event(), setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    notifications: { onClicked: event(), create: async (...args) => notifications.push(args) },
    tabs: { query: async () => [], create: async () => {} }, windows: { update: async () => {} },
    messageDisplay: { open: async value => opened.push(value) }
  };
  globalThis.messenger = api;
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = callback => { timers.push(callback); return 0; };
  try { await import(`../thunderbird/background.js?case=${++caseId}`); }
  finally { globalThis.setInterval = realInterval; }
  const send = (type, values = {}, sender = { id: "unit", url: api.runtime.getURL("dashboard.html") }) =>
    events.message.listeners[0]({ type, ...values }, sender);
  await send("state");
  return { api, send, events, notifications, opened, rawReads, timers, deleted, nativePorts, stored: () => stored };
}

function mail(id, accountId = "one") {
  return { id, author: "Sender <sender@example.invalid>", subject: "Example",
    date: new Date("2026-01-01"), headerMessageId: `mail-${id}@example.invalid`, folder: { accountId, path: "/Inbox" } };
}

async function settle(h, predicate) {
  for (let i = 0; i < 100; i++) {
    const state = await h.send("state");
    if (predicate(state)) return state;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error("background did not settle");
}

test("automatic scanning is off by default and only enabled accounts are scanned", async () => {
  const mails = [mail(1), mail(2, "two")];
  const h = await harness({ mails });
  assert.deepEqual(h.events.newMail.args, [true]);
  h.events.newMail.listeners[0](mails[0].folder, { messages: mails });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.send("state")).records.length, 0);
  await h.send("settings", { settings: { enabled: true, accountIds: ["one"], notifications: true } });
  h.events.newMail.listeners[0](mails[0].folder, { messages: mails });
  const state = await settle(h, value => value.records[0]?.status === "clean");
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].locator.accountId, "one");
  assert.deepEqual(h.rawReads, [1]);
  assert.equal(h.notifications.length, 0);
  assert.equal(JSON.stringify(h.stored()).includes("Subject: example"), false);
});

test("host failure is recorded, retry bounded, lock-screen notification omits sender", async () => {
  const h = await harness({ mails: [mail(1)], nativeFailure: true });
  await h.send("scanSelection");
  let state = await settle(h, value => value.records[0]?.status === "error");
  assert.equal(state.records[0].attempts, 1);
  assert.ok(state.records[0].nextRetry);
  assert.equal(h.notifications.length, 1);
  assert.equal(JSON.stringify(h.notifications).includes("sender@example.invalid"), false);
  const now = Date.now;
  Date.now = () => now() + 120000;
  try { await h.timers[0](); await new Promise(resolve => setImmediate(resolve)); }
  finally { Date.now = now; }
  state = await settle(h, value => value.records[0]?.attempts === 2 && value.records[0].status === "error");
  assert.equal(state.records[0].nextRetry, null);
});

test("restart never opens a reused numeric ID and resolves by digest", async () => {
  const original = mail(2);
  original.headerMessageId = "original@example.invalid";
  const raw = new TextEncoder().encode("Subject: example\r\n\r\nhello");
  const digest = await sha256(raw);
  const record = { key: "saved", session: "old", messageId: 1, sha256: digest,
    status: "detected", signatures: ["Test"], updatedAt: new Date().toISOString(),
    locator: { accountId: "one", headerMessageId: original.headerMessageId,
      author: original.author, subject: original.subject, date: original.date.toISOString() } };
  const h = await harness({ mails: [mail(1), original], saved: { records: [record] } });
  assert.equal((await h.send("open", { key: "saved" })).ok, true);
  assert.deepEqual(h.opened, [{ messageId: 2, location: "tab" }]);
  assert.ok(h.rawReads.every(id => id === 2));
});

test("ambiguous identical messages cannot be opened from history", async () => {
  const first = mail(1), duplicate = { ...first, id: 2 };
  const record = { key: "saved", status: "clean", sha256: await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello")),
    locator: { accountId: "one", headerMessageId: first.headerMessageId,
      author: first.author, subject: first.subject, date: first.date.toISOString() } };
  const h = await harness({ mails: [first, duplicate], saved: { records: [record] } });
  assert.equal((await h.send("open", { key: "saved" })).ok, false);
  assert.equal(h.opened.length, 0);
});

test("messages from other pages are rejected and clearing results never deletes mail", async () => {
  const h = await harness({ saved: { records: [{ key: "a", status: "detected" }] } });
  assert.equal(await h.send("clear", {}, { id: "other", url: "https://example.invalid" }), undefined);
  assert.equal((await h.send("state")).records.length, 1);
  assert.equal((await h.send("clear")).ok, true);
  assert.equal((await h.send("state")).records.length, 0);
  assert.equal(h.deleted.length, 0);
});

test("oversized mail is incomplete and not retried as a clean scan", async () => {
  const h = await harness({ mails: [mail(1)], oversized: true });
  await h.send("scanSelection");
  const state = await settle(h, value => value.records[0]?.status === "incomplete");
  assert.equal(state.records[0].nextRetry, null);
  assert.equal(state.records[0].sha256, null);
  assert.equal(h.notifications.length, 1);
});

test("interrupted manual work resumes after restart using the message locator", async () => {
  const target = mail(5);
  const record = { key: "pending", status: "scanning", source: "manual", attempts: 1,
    messageId: 99, session: "old", sha256: null,
    locator: { accountId: "one", headerMessageId: target.headerMessageId,
      author: target.author, subject: target.subject, date: target.date.toISOString() } };
  const h = await harness({ mails: [target], saved: { records: [record] } });
  const state = await settle(h, value => value.records[0]?.status === "clean");
  assert.equal(state.records[0].messageId, 5);
  assert.ok(h.rawReads.every(id => id === 5));
});

test("disabled automatic scanning preserves failed status instead of clearing the warning", async () => {
  const h = await harness({ saved: { records: [{
    key: "failed", status: "error", source: "automatic", attempts: 1,
    nextRetry: Date.now() - 60000, locator: { accountId: "one" }
  }] } });
  h.timers[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.send("state")).records[0].status, "error");
});

async function deletionFixture(options = {}) {
  const target = mail(1);
  const hash = await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello"));
  const record = { key: "threat", status: "detected", sha256: hash, signatures: ["Test.Threat"],
    locator: { accountId: "one", headerMessageId: target.headerMessageId,
      author: target.author, subject: target.subject, date: target.date.toISOString() } };
  const h = await harness({ saved: { records: [record] }, mails: [target], deleteAllowed: true, ...options });
  return { h, target, record };
}

test("deletion needs an explicit optional permission and a current confirmation ticket", async () => {
  const { h } = await deletionFixture({ deleteAllowed: false });
  assert.equal((await h.send("prepareDelete", { key: "threat" })).ok, false);
  assert.equal((await h.send("deletePermanently", { key: "threat", token: "invented" })).ok, false);
  assert.equal(h.deleted.length, 0);
});

test("verified detected mail bypasses trash once and keeps a deleted audit record", async () => {
  const { h } = await deletionFixture();
  const prepared = await h.send("prepareDelete", { key: "threat" });
  assert.equal(prepared.ok, true);
  assert.equal(h.deleted.length, 0);
  const request = { key: "threat", token: prepared.token };
  assert.equal((await h.send("deletePermanently", request)).ok, true);
  assert.deepEqual(h.deleted, [{ ids: [1], options: { deletePermanently: true, isUserAction: true } }]);
  assert.equal((await h.send("state")).records[0].status, "deleted");
  assert.equal((await h.send("deletePermanently", request)).ok, false);
  assert.equal((await h.send("retry", { key: "threat" })).ok, false);
  assert.equal((await h.send("open", { key: "threat" })).ok, false);
  assert.equal(h.deleted.length, 1);
});

test("cancelled and expired confirmation never delete a message", async () => {
  const { h } = await deletionFixture();
  let prepared = await h.send("prepareDelete", { key: "threat" });
  await h.send("cancelDelete", { token: prepared.token });
  assert.equal((await h.send("deletePermanently", { key: "threat", token: prepared.token })).ok, false);
  prepared = await h.send("prepareDelete", { key: "threat" });
  const now = Date.now;
  Date.now = () => now() + 61000;
  try {
    assert.equal((await h.send("deletePermanently", { key: "threat", token: prepared.token })).ok, false);
  } finally { Date.now = now; }
  assert.equal(h.deleted.length, 0);
});

test("changed bytes or moved mail after confirmation cannot be deleted", async () => {
  for (const change of [target => { target.raw = "changed"; }, target => { target.folder.path = "/Moved"; }]) {
    const { h, target } = await deletionFixture();
    const prepared = await h.send("prepareDelete", { key: "threat" });
    change(target);
    assert.equal((await h.send("deletePermanently", { key: "threat", token: prepared.token })).ok, false);
    assert.equal(h.deleted.length, 0);
  }
});

test("uninfected mail can be prepared while ambiguous mail is rejected", async () => {
  const { h } = await deletionFixture();
  await h.send("retry", { key: "threat" });
  await settle(h, value => value.records[0]?.status === "clean");
  assert.equal((await h.send("prepareDelete", { key: "threat" })).ok, true);
  assert.equal(h.deleted.length, 0);
  const first = mail(1), second = { ...first, id: 2 };
  const fixture = await deletionFixture({ mails: [first, second] });
  assert.equal((await fixture.h.send("prepareDelete", { key: "threat" })).ok, false);
  assert.equal(fixture.h.deleted.length, 0);
});

test("server refusal preserves detection and a confirmation cannot be replayed", async () => {
  const { h } = await deletionFixture({ deleteFailure: true });
  const prepared = await h.send("prepareDelete", { key: "threat" });
  const request = { key: "threat", token: prepared.token };
  assert.equal((await h.send("deletePermanently", request)).ok, false);
  assert.equal((await h.send("state")).records[0].status, "detected");
  assert.equal((await h.send("deletePermanently", request)).ok, false);
});

test("detected mail notifies only when enabled and notifications omit sender and subject", async () => {
  for (const enabled of [true, false]) {
    const h = await harness({ mails: [mail(1)],
      saved: { settings: { enabled: false, accountIds: [], notifications: enabled } },
      scanResult: { status: "detected", signatures: ["Test.Threat"], detail: "脅威候補" } });
    await h.send("scanSelection");
    await settle(h, value => value.records[0]?.status === "detected");
    assert.equal(h.notifications.length, enabled ? 1 : 0);
    if (enabled) {
      assert.match(h.notifications[0][1].title, /脅威候補/);
      assert.equal(JSON.stringify(h.notifications).includes("sender@example.invalid"), false);
      assert.equal(JSON.stringify(h.notifications).includes("Example"), false);
    }
  }
});

async function batchFixture(options = {}) {
  const mails = [mail(1), mail(2), mail(3)];
  const hash = await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello"));
  const records = mails.map(target => ({ key: "k" + target.id, status: "detected", sha256: hash,
    signatures: ["Test.Threat"], updatedAt: new Date().toISOString(),
    locator: { accountId: "one", headerMessageId: target.headerMessageId,
      author: target.author, subject: target.subject, date: target.date.toISOString() } }));
  const h = await harness({ mails, saved: { records }, deleteAllowed: true, ...options });
  return { h, mails, records };
}

test("batch deletes only the confirmed set, keeps unselected mail, and cannot replay", async () => {
  const { h } = await batchFixture();
  const prepared = await h.send("prepareDeleteBatch", { keys: ["k1", "k3"] });
  assert.equal(prepared.targets.length, 2);
  assert.equal(h.deleted.length, 0);
  const response = await h.send("deleteBatch", { token: prepared.token });
  assert.deepEqual(response.results.map(result => result.deleted), [true, true]);
  assert.deepEqual(h.deleted.map(item => item.ids[0]), [1, 3]);
  assert.equal((await h.send("state")).records[1].status, "detected");
  assert.equal((await h.send("state")).batch.completed, 2);
  assert.equal((await h.send("state")).batch.active, false);
  assert.equal((await h.send("deleteBatch", { token: prepared.token })).ok, false);
});

test("batch cancel and expiration cause no deletion", async () => {
  const { h } = await batchFixture();
  let prepared = await h.send("prepareDeleteBatch", { keys: ["k1", "k2"] });
  await h.send("cancelDeleteBatch", { token: prepared.token });
  assert.equal((await h.send("deleteBatch", { token: prepared.token })).ok, false);
  prepared = await h.send("prepareDeleteBatch", { keys: ["k1", "k2"] });
  const now = Date.now;
  Date.now = () => now() + 300001;
  try { assert.equal((await h.send("deleteBatch", { token: prepared.token })).ok, false); }
  finally { Date.now = now; }
  assert.equal(h.deleted.length, 0);
});

test("batch rechecks every mail and reports changed and server-refused items separately", async () => {
  const { h, mails } = await batchFixture({ deleteFailureIds: [2] });
  const prepared = await h.send("prepareDeleteBatch", { keys: ["k1", "k2", "k3"] });
  mails[0].raw = "changed after confirmation";
  const response = await h.send("deleteBatch", { token: prepared.token });
  assert.deepEqual(response.results.map(result => result.deleted), [false, false, true]);
  assert.deepEqual(h.deleted.map(item => item.ids[0]), [3]);
  assert.match(response.results[0].error, /一致/);
  assert.match(response.results[1].error, /server refused/);
  assert.deepEqual((await h.send("state")).records.map(record => record.status), ["detected", "detected", "deleted"]);
});

test("batch rejects invalid keys and missing permission while accepting mixed terminal results", async () => {
  const { h } = await batchFixture();
  for (const keys of [[], ["k1", "k1"], ["k1", "unknown"], Array.from({ length: 101 }, (_, i) => "k" + i)]) {
    assert.equal((await h.send("prepareDeleteBatch", { keys })).ok, false);
  }
  const denied = await batchFixture({ deleteAllowed: false });
  assert.equal((await denied.h.send("prepareDeleteBatch", { keys: ["k1"] })).ok, false);
  const clean = await batchFixture();
  await clean.h.send("retry", { key: "k2" });
  await settle(clean.h, state => state.records[1].status === "clean");
  assert.equal((await clean.h.send("prepareDeleteBatch", { keys: ["k1", "k2"] })).ok, true);
  assert.equal(clean.h.deleted.length, 0);
  assert.equal(h.deleted.length, 0);
});

test("batch refuses two history records for the same underlying message", async () => {
  const { records, mails } = await batchFixture();
  const duplicate = { ...records[0], key: "duplicate" };
  const h = await harness({ mails, deleteAllowed: true, saved: { records: [records[0], duplicate] } });
  assert.equal((await h.send("prepareDeleteBatch", { keys: ["k1", "duplicate"] })).ok, false);
  assert.equal(h.deleted.length, 0);
});

test("bulk retry queues the selected terminal results without deleting mail", async () => {
  const { h } = await batchFixture();
  const response = await h.send("retryMany", { keys: ["k1", "k3"] });
  assert.equal(response.count, 2);
  const state = await settle(h, state => state.records[0].status === "clean" && state.records[2].status === "clean");
  assert.equal(state.records[1].status, "detected");
  assert.equal(h.deleted.length, 0);
});

test("concurrent batch submissions cannot delete the same confirmation twice", async () => {
  const { h } = await batchFixture();
  const prepared = await h.send("prepareDeleteBatch", { keys: ["k1", "k2"] });
  const responses = await Promise.all([
    h.send("deleteBatch", { token: prepared.token }),
    h.send("deleteBatch", { token: prepared.token })
  ]);
  assert.equal(responses.filter(response => response.ok).length, 1);
  assert.deepEqual(h.deleted.map(item => item.ids[0]), [1, 2]);
});

async function startFolder(h, includeSubfolders = false) {
  const context = await h.send("folderContext");
  assert.equal(context.ok, true, context.error);
  const response = await h.send("folderStart", { token: context.token, includeSubfolders });
  assert.equal(response.ok, true, response.error);
  return response.job.id;
}
async function settledFolder(h, status) {
  for (let i = 0; i < 3000; i++) {
    const state = await h.send("state");
    if (state.folderJob?.status === status) return state;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error("Folder scan did not reach " + status);
}

test("folder scan creates incremental results and persists a separate summary without runtime targets", async () => {
  const h = await harness({ mails: [mail(1), mail(2), mail(3)], scanResult: id => ({ status: id === 2 ? "detected" : id === 3 ? "incomplete" : "clean" }) });
  const jobId = await startFolder(h);
  const state = await settledFolder(h, "completed");
  assert.equal(state.folderJob.total, 3);
  assert.equal(state.folderJob.completed, 3);
  assert.deepEqual(state.folderJob.counts, { clean: 1, detected: 1, incomplete: 1, error: 0 });
  assert.equal(state.records.filter(record => record.folderJobId === jobId).length, 3);
  assert.equal(state.records.every(record => record.source === "folder"), true);
  assert.equal(Object.hasOwn(h.stored().folderJob, "targets"), false);
  assert.equal(h.notifications.length, 3);
  assert.match(h.notifications.find(item => item[0].startsWith("folder-"))[1].message, /検出1件/);
});

test("folder stop finishes the current message, keeps remaining count, and cannot restart itself", async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const h = await harness({ mails: [mail(1), mail(2), mail(3)], scanGate: async id => { if (id === 1) { entered(); await gate; } } });
  const jobId = await startFolder(h);
  await started;
  assert.equal((await h.send("state")).folderJob.scanning, 1);
  await h.send("folderStop", { jobId });
  await h.send("folderStop", { jobId });
  assert.equal((await h.send("state")).folderJob.status, "stopping");
  release();
  const state = await settledFolder(h, "stopped");
  assert.equal(state.folderJob.total, 3); assert.equal(state.folderJob.completed, 1);
  assert.deepEqual(h.rawReads, [1]);
  h.timers[0](); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.rawReads, [1]);
});

test("fresh automatic mail is scanned before the next folder target", async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const fresh = mail(99); fresh.folder = { accountId: "one", path: "/Other" };
  const h = await harness({ mails: [mail(1), mail(2), fresh],
    saved: { settings: { enabled: true, accountIds: ["one"], notifications: false } },
    scanGate: async id => { if (id === 1) { entered(); await gate; } } });
  await startFolder(h); await started;
  h.events.newMail.listeners[0](fresh.folder, { messages: [fresh] });
  await new Promise(resolve => setImmediate(resolve));
  release();
  const state = await settledFolder(h, "completed");
  assert.deepEqual(h.rawReads, [1, 99, 2]);
  assert.equal(state.folderJob.completed, 2);
});

test("folder progress continues past history replacement without losing attention records", async () => {
  const warnings = Array.from({ length: 999 }, (_, i) => ({ key: "old" + i, status: "detected", locator: { accountId: "one" } }));
  const h = await harness({ saved: { records: warnings }, mails: [mail(1), mail(2), mail(3), mail(4), mail(5)] });
  const jobId = await startFolder(h);
  const state = await settledFolder(h, "completed");
  assert.equal(state.folderJob.completed, 5);
  assert.equal(state.records.length, 1000);
  assert.equal(state.records.filter(record => record.folderJobId === jobId).length, 1);
  assert.equal(state.records.filter(record => record.status === "detected").length, 999);
});

test("attention-only history capacity stops folder work with unprocessed counts", async () => {
  const warnings = Array.from({ length: 999 }, (_, i) => ({ key: "old" + i, status: "detected", locator: { accountId: "one" } }));
  const h = await harness({ saved: { records: warnings }, mails: [mail(1), mail(2)], scanResult: { status: "detected" } });
  await startFolder(h);
  const state = await settledFolder(h, "blocked");
  assert.equal(state.folderJob.completed, 1); assert.equal(state.folderJob.total, 2);
  assert.equal(state.records.length, 1000);
  assert.match(state.folderJob.detail, /1000/);
  assert.deepEqual(h.rawReads, [1]);
});

test("folder errors are counted once and interrupted work is not auto-resumed", async () => {
  const h = await harness({ mails: [mail(1)], nativeFailure: true });
  await startFolder(h);
  const state = await settledFolder(h, "completed");
  assert.equal(state.folderJob.counts.error, 1);
  assert.equal(state.records[0].attempts, 1); assert.equal(state.records[0].nextRetry, null);
  const interrupted = await harness({ saved: { folderJob: { ...state.folderJob, status: "running", scanning: 1 },
    records: [{ ...state.records[0], status: "scanning" }] }, mails: [mail(1)] });
  const restored = await interrupted.send("state");
  assert.equal(restored.folderJob.status, "interrupted");
  assert.equal(restored.folderJob.scanning, 0);
  assert.equal(restored.records[0].status, "error");
  assert.equal(interrupted.rawReads.length, 0);
});

test("folder context validates tokens, virtual folders and right-click folder selection", async () => {
  const h = await harness({ mails: [mail(1)] });
  assert.equal((await h.send("folderStart", { token: "forged", includeSubfolders: false })).ok, false);
  await h.api.menus.onClicked.listeners[0]({ menuItemId: "scan-folder", selectedFolders: [{ id: "inbox" }] }, {});
  await new Promise(resolve => setImmediate(resolve));
  const state = await h.send("state");
  assert.equal(state.folderRequest.folder.path, "/Inbox");
  await h.send("folderCancel", { token: state.folderRequest.token });
  assert.equal((await h.send("state")).folderRequest, null);
  h.api.mailTabs.get = async () => ({ displayedFolder: { accountId: "one", path: "/Search", isVirtual: true } });
  assert.equal((await h.send("folderContext")).ok, false);
  assert.equal(h.rawReads.length, 0);
});

test("folder scan includes descendants only when explicitly requested", async () => {
  const folderRefs = [
    { id: "inbox", accountId: "one", path: "/Inbox", name: "受信トレイ" },
    { id: "child", accountId: "one", path: "/Inbox/Child", name: "子", parentId: "inbox" }
  ];
  const childMail = mail(2); childMail.folder = folderRefs[1];
  const h = await harness({ mails: [mail(1), childMail], folderRefs });
  await startFolder(h, false);
  assert.equal((await settledFolder(h, "completed")).folderJob.total, 1);
  await startFolder(h, true);
  const state = await settledFolder(h, "completed");
  assert.equal(state.folderJob.total, 2);
  assert.deepEqual(h.rawReads, [1, 1, 2]);
});

test("folder notifications are bounded and respect the existing notification setting", async () => {
  for (const notifications of [true, false]) {
    const h = await harness({ mails: [mail(1), mail(2), mail(3)], scanResult: { status: "detected" },
      saved: { settings: { enabled: false, accountIds: [], notifications } } });
    await startFolder(h); await settledFolder(h, "completed");
    assert.equal(h.notifications.length, notifications ? 2 : 0);
    assert.equal(JSON.stringify(h.notifications).includes("sender@example.invalid"), false);
  }
});


test("continuous scans share one native host and release it when drained", async () => {
  const h = await harness({ mails: [mail(1), mail(2), mail(3)], scanResult: { engine: "loaded engine (clamd)" } });
  await h.send("scanSelection");
  const state = await settle(h, value => value.records.length === 3 && value.records.every(record => record.status === "clean"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.nativePorts.length, 1);
  assert.ok(h.nativePorts[0].disconnected);
  assert.ok(state.records.every(record => record.engine === "loaded engine (clamd)"));
  await h.send("scanSelection");
  await settle(h, value => value.records.every(record => record.status === "clean"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.nativePorts.length, 2);
  assert.ok(h.nativePorts[1].disconnected);
});


test("stopped folder resumes after reload using legacy history and never deletes messages when discarded", async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const mails = [mail(1), mail(2), mail(3)];
  const h = await harness({ mails, scanGate: async id => { if (id === 1) { entered(); await gate; } } });
  const jobId = await startFolder(h);
  await started;
  assert.equal((await h.send("folderDelete", { jobId })).ok, false);
  await h.send("folderStop", { jobId }); release();
  await settledFolder(h, "stopped");
  const saved = structuredClone(h.stored());
  assert.equal(saved.folderCheckpoint.entries.length, 1);
  delete saved.folderCheckpoint; // Upgrading 0.4/0.5: rebuild from retained results.
  const next = await harness({ saved, mails: mails.map(message => ({ ...message, id: message.id + 100 })) });
  assert.equal((await next.send("folderResume", { jobId: "wrong" })).ok, false);
  assert.equal((await next.send("folderResume", { jobId })).ok, true);
  const state = await settledFolder(next, "completed");
  assert.equal(state.folderJob.resumedMatched, 1);
  assert.equal(state.folderJob.completed, 3);
  assert.equal(state.folderJob.total, 3);
  assert.equal(state.records.filter(record => record.folderJobId === jobId).length, 3);
  assert.deepEqual(next.rawReads, [101, 102, 103]); // First read only verifies already-scanned bytes.
  assert.equal(next.nativePorts.length, 1);
  const retained = JSON.parse(JSON.stringify(state.records));
  assert.equal((await next.send("folderDelete", { jobId: "wrong" })).ok, false);
  assert.equal((await next.send("folderDelete", { jobId })).ok, true);
  assert.equal((await next.send("state")).folderJob, null);
  assert.equal(next.stored().folderCheckpoint, null);
  assert.deepEqual(next.stored().records, retained);
  assert.deepEqual(next.deleted, []);
});

test("persisted checkpoints survive cleared history and a restart during active work", async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const mails = [mail(1), mail(2), mail(3)];
  const h = await harness({ mails, scanGate: async id => { if (id === 2) { entered(); await gate; } } });
  const jobId = await startFolder(h);
  await started;
  const saved = structuredClone(h.stored());
  assert.equal(saved.folderJob.completed, 1);
  assert.equal(saved.folderCheckpoint.entries.length, 1);
  saved.records = []; // Progress must not depend on the bounded result history.
  await h.send("folderStop", { jobId }); release(); await settledFolder(h, "stopped");
  const next = await harness({ saved, mails: mails.map(message => ({ ...message, id: message.id + 10 })) });
  assert.equal((await next.send("state")).folderJob.status, "interrupted");
  assert.equal(next.nativePorts.length, 0); // No automatic resume.
  await next.send("folderResume", { jobId });
  const state = await settledFolder(next, "completed");
  assert.equal(state.folderJob.resumedMatched, 1);
  assert.equal(state.folderJob.completed, 3);
  assert.equal(state.records.length, 2);
  assert.deepEqual(next.rawReads, [11, 12, 13]);
});


test("capacity replaces oldest clean/deleted history while preserving attention and resume checkpoints", async () => {
  const protectedRecords = Array.from({ length: 998 }, (_, i) => ({ key: "protected" + i,
    status: ["detected", "incomplete", "error"][i % 3], locator: { accountId: "one" } }));
  const h = await harness({ saved: { records: [
    ...protectedRecords, { key: "deleted-old", status: "deleted", locator: { accountId: "one" } },
    { key: "clean-new", status: "clean", locator: { accountId: "one" } }
  ] }, mails: [mail(1)], scanResult: { status: "detected" } });
  await startFolder(h);
  const state = await settledFolder(h, "completed");
  assert.equal(state.records.length, 1000);
  assert.equal(state.folderJob.completed, 1);
  assert.equal(state.records.some(record => record.key === "deleted-old"), false);
  assert.equal(state.records.some(record => record.key === "clean-new"), true);
  assert.ok(protectedRecords.every(original => state.records.some(record => record.key === original.key && record.status === original.status)));
  assert.equal(h.stored().folderCheckpoint.entries.length, 1);
  assert.deepEqual(h.deleted, []);
});

test("manual enqueue can also replace a deleted result at capacity", async () => {
  const records = Array.from({ length: 999 }, (_, i) => ({ key: "warning" + i,
    status: "detected", locator: { accountId: "one" } }));
  records.push({ key: "deleted", status: "deleted", locator: { accountId: "one" } });
  const h = await harness({ saved: { records }, mails: [mail(1)] });
  await h.send("scanSelection");
  const state = await settle(h, value => value.records.some(record => record.messageId === 1 && record.status === "clean"));
  assert.equal(state.records.length, 1000);
  assert.equal(state.records.some(record => record.key === "deleted"), false);
  assert.equal(state.records.filter(record => record.status === "detected").length, 999);
  assert.deepEqual(h.deleted, []);
});


test("mixed clean, detected, incomplete and failed selections can be permanently deleted", async () => {
  const { records, mails } = await batchFixture();
  const fourth = mail(4);
  const mixed = [...records, { ...records[0], key: "k4", locator: { ...records[0].locator,
    headerMessageId: fourth.headerMessageId } }].map((record, i) => ({ ...record,
    status: ["clean", "detected", "incomplete", "error"][i], sha256: i === 3 ? null : record.sha256 }));
  const h = await harness({ saved: { records: mixed }, mails: [...mails, fourth], deleteAllowed: true });
  const prepared = await h.send("prepareDeleteBatch", { keys: mixed.map(record => record.key) });
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.targets.map(target => target.status), ["clean", "detected", "incomplete", "error"]);
  assert.equal(h.deleted.length, 0);
  const response = await h.send("deleteBatch", { token: prepared.token });
  assert.ok(response.results.every(result => result.deleted));
  assert.deepEqual(h.deleted.map(call => call.ids[0]), [1, 2, 3, 4]);
  assert.ok(h.deleted.every(call => call.options.deletePermanently && call.options.isUserAction));
  assert.ok((await h.send("state")).records.every(record => record.status === "deleted"));
});

test("missing scan hash uses a fresh deletion fingerprint and refuses changed bytes", async () => {
  const { records, mails } = await batchFixture();
  for (const changed of [false, true]) {
    const target = { ...mails[0] };
    const h = await harness({ saved: { records: [{ ...records[0], status: "incomplete", sha256: null }] },
      mails: [target], deleteAllowed: true });
    const prepared = await h.send("prepareDelete", { key: "k1" });
    assert.equal(prepared.ok, true);
    if (changed) target.raw = "changed after confirmation";
    const response = await h.send("deletePermanently", { key: "k1", token: prepared.token });
    assert.equal(response.ok, !changed);
    assert.equal(h.deleted.length, changed ? 0 : 1);
  }
});

test("oversized unscanned mail is fingerprinted in bounded chunks for deletion", async () => {
  const { records, mails } = await batchFixture();
  const h = await harness({ saved: { records: [{ ...records[0], status: "incomplete", sha256: null }] },
    mails: [mails[0]], deleteAllowed: true });
  let slices = 0;
  const size = 26 * 1024 * 1024;
  h.api.messages.getRaw = async () => ({ size,
    arrayBuffer() { throw new Error("must not allocate the entire mail"); },
    slice(start, end) { slices++; assert.ok(end - start <= 512 * 1024);
      return new Blob([new Uint8Array(Math.min(end, size) - start)]); }
  });
  const prepared = await h.send("prepareDelete", { key: "k1" });
  assert.equal(prepared.ok, true);
  assert.equal(h.deleted.length, 0);
  const response = await h.send("deletePermanently", { key: "k1", token: prepared.token });
  assert.equal(response.ok, true);
  assert.equal(slices, 104);
  assert.equal(h.deleted.length, 1);
});

test("queued, scanning, deleted and unresolvable results cannot be deleted", async () => {
  const { records, mails } = await batchFixture();
  for (const status of ["queued", "scanning", "deleted", "unknown"]) {
    const h = await harness({ saved: { records: [{ ...records[0], status, source: "automatic" }] },
      mails, deleteAllowed: true });
    assert.equal((await h.send("prepareDelete", { key: "k1" })).ok, false);
    assert.equal((await h.send("prepareDeleteBatch", { keys: ["k1"] })).ok, false);
    assert.equal(h.deleted.length, 0);
  }
  const h = await harness({ saved: { records: [{ ...records[0], status: "error", sha256: null }] },
    mails: [], deleteAllowed: true });
  assert.equal((await h.send("prepareDelete", { key: "k1" })).ok, false);
  assert.equal(h.deleted.length, 0);
});
