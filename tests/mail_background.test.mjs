import { readStoredState } from "../thunderbird/state-storage.mjs";
import { SCAN_IDLE_MS } from "../thunderbird/scan-connection.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256, locator } from "../thunderbird/core.mjs";

function event() {
  const listeners = [];
  return { listeners, addListener(listener, ...args) { listeners.push(listener); this.args = args; } };
}

let caseId = 0;
async function harness({ failReads = [], failWrites = [], direct = false, backupFailure = false, saved = {}, mails = [], nativeFailure = false, oversized = false, deleteAllowed = false, deleteFailure = false, deleteFailureIds = [], scanResult = {}, scanGate = null,
  manageInfo = null, healthResult = null, folderRefs = [{ id: "inbox", accountId: "one", path: "/Inbox", name: "受信トレイ" }] } = {}) {
  let stored = structuredClone(saved);
  const storageCounts = { reads: 0, writes: 0 };
  const notifications = [], opened = [], rawReads = [], timers = [], deleted = [], nativePorts = [];
  const events = { newMail: event(), selected: event(), message: event(), moved: event() };
  const byId = new Map(mails.map(mail => [mail.id, mail]));
  const api = {
    permissions: { contains: async () => deleteAllowed },
    storage: { local: { get: async () => { if (failReads.includes(++storageCounts.reads)) throw new Error("synthetic storage read failure"); return structuredClone(stored); }, set: async value => {
      if (failWrites.includes(++storageCounts.writes)) throw new Error("synthetic storage failure");
      stored = { ...stored, ...structuredClone(value) };
    } } },
    runtime: {
      id: "unit", getManifest: () => ({ version: "0.9.4" }), getURL: path => "moz-extension://unit/" + path,
      onMessage: events.message, onInstalled: event(),
      connectNative() {
        const port = { disconnected: false, onMessage: event(), onDisconnect: event(), disconnect() { this.disconnected = true; },
          postMessage(request) {
            if (request.op === "begin") port.scanSettings = request.scanSettings;
            queueMicrotask(async () => {
              if (request.op === "end" && scanGate) await scanGate(rawReads.at(-1));
              if (nativeFailure) { port.onDisconnect.listeners[0](); return; }
              const result = request.op === "manageInfo" && manageInfo ? manageInfo : request.op === "health" && healthResult ? healthResult : request.op === "health" ? { status: "ready", protocol: 1, engine: "test" } :
                request.op === "end" ? { status: "clean", detail: "未検出", sha256: request.sha256, signatures: [],
                  ...(port.scanSettings ? { scanSettings: structuredClone(port.scanSettings) } : {}),
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
      onNewMailReceived: events.newMail, onMoved: events.moved,
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
    browserAction: { onClicked: event(), setIcon: async () => {}, setTitle: async () => {}, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    notifications: { onClicked: event(), create: async (...args) => notifications.push(args) },
    tabs: { query: async () => [], create: async () => {} }, windows: { update: async () => {} },
    messageDisplay: { open: async value => opened.push(value) }
  };
  const directRequests = [], migrationBackups = [];
  if (direct) {
    const createPort = api.runtime.connectNative;
    const sessions = new Map();
    api.runtime.getManifest = () => ({ version: "0.20.0a1", experiment_apis: { clamDirect: {} } });
    api.runtime.connectNative = () => { throw new Error("Direct mode must not connect to an installed native host"); };
    api.clamDirect = {
      open: async () => { const token = crypto.randomUUID(); sessions.set(token, createPort()); return token; },
      close: async token => { sessions.get(token)?.disconnect(); sessions.delete(token); },
      request: (token, value) => new Promise((resolve, reject) => {
        const port = sessions.get(token), request = JSON.parse(value);
        directRequests.push(request);
        port.onMessage.listeners[0] = response => resolve(JSON.stringify(response));
        port.onDisconnect.listeners[0] = () => reject(new Error("synthetic direct failure"));
        port.postMessage(request);
      }),
      backup: async snapshot => {
        if (backupFailure) throw new Error("synthetic backup failure");
        migrationBackups.push(JSON.parse(snapshot));
        return { path: "/synthetic/profile/migration-backup.json" };
      }
    };
  }
  globalThis.messenger = api;
  const idleTimers = [];
  const realTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (ms !== SCAN_IDLE_MS) return realTimeout(callback, ms, ...args);
    if (idleTimers.failNext) { idleTimers.failNext = false; throw new Error("synthetic idle timer failure"); }
    const timer = { callback, active: true, unref() {} }; idleTimers.push(timer); return timer;
  };
  globalThis.clearTimeout = timer => {
    if (idleTimers.includes(timer)) timer.active = false;
    else realClearTimeout(timer);
  };
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = callback => { timers.push(callback); return 0; };
  try { await import(`../thunderbird/background.js?case=${++caseId}`); }
  finally { globalThis.setInterval = realInterval; globalThis.setTimeout = realTimeout; globalThis.clearTimeout = realClearTimeout; }
  const send = (type, values = {}, sender = { id: "unit", url: api.runtime.getURL("dashboard.html") }) =>
    events.message.listeners[0]({ type, ...values }, sender);
  await send("state");
  nativePorts.length = 0; // Startup installation check is separate from scan connections.
  return { api, send, events, notifications, opened, rawReads, timers, deleted, nativePorts, directRequests, migrationBackups, storageCounts, idleTimers,
    expireIdle: () => { for (const timer of idleTimers) if (timer.active) { timer.active = false; timer.callback(); } },
    stored: () => {
    const data=readStoredState(structuredClone(stored));
    // Legacy fixtures contain logical arrays, never incremental page keys.
    for(const key of Object.keys(data)) if(/^(history|checkpoint)Page:/.test(key)) delete data[key];
    return data;
  }, rawStored: () => structuredClone(stored) };
}

function mail(id, accountId = "one") {
  return { id, author: "Sender <sender@example.invalid>", subject: "Example",
    date: new Date("2026-01-01"), headerMessageId: `mail-${id}@example.invalid`, folder: { accountId, path: "/Inbox" } };
}

async function settle(h, predicate) {
  // Crypto and storage finish on wall-clock time, not a fixed event-loop count.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const state = await h.send("state");
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 1));
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
  assert.equal(h.notifications.length, 0);
  assert.equal(JSON.stringify(h.notifications).includes("sender@example.invalid"), false);
  const now = Date.now;
  Date.now = () => now() + 120000;
  try { await h.timers[0](); await new Promise(resolve => setImmediate(resolve)); }
  finally { Date.now = now; }
  state = await settle(h, value => value.records[0]?.attempts === 2 && value.records[0].status === "error");
  assert.equal(state.records[0].nextRetry, null);
  assert.equal(h.notifications.length, 1);
  assert.equal(JSON.stringify(h.notifications).includes("sender@example.invalid"), false);
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
  for (const keys of [[], ["k1", "k1"], ["k1", "unknown"], Array.from({ length: 1001 }, (_, i) => "k" + i)]) {
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
  const h = await harness({ mails: [mail(1)], scanResult: { status: "error", detail: "synthetic engine failure" } });
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
  assert.equal(next.nativePorts.length, 2); // Preflight plus the shared scan connection.
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
    const h = await harness({ saved: { records: [{ ...records[0], status: "clean", source: "automatic" }] },
      mails, deleteAllowed: true });
    (await h.send("state")).records[0].status = status; // Test action guards independently of restart migration.
    assert.equal((await h.send("prepareDelete", { key: "k1" })).ok, false);
    assert.equal((await h.send("prepareDeleteBatch", { keys: ["k1"] })).ok, false);
    assert.equal(h.deleted.length, 0);
  }
  const h = await harness({ saved: { records: [{ ...records[0], status: "error", sha256: null }] },
    mails: [], deleteAllowed: true });
  assert.equal((await h.send("prepareDelete", { key: "k1" })).ok, false);
  assert.equal(h.deleted.length, 0);
});

test("folder picker enumerates real account folders and starts the explicit target", async () => {
  const root = { id: "root", accountId: "one", path: "/", isRoot: true };
  const inbox = { id: "inbox", accountId: "one", path: "/Inbox", name: "受信トレイ" };
  const spam = { id: "spam", accountId: "one", path: "/Inbox/Spam", name: "迷惑メール" };
  const virtual = { id: "virtual", accountId: "one", path: "/Search", isVirtual: true };
  const h = await harness({ folderRefs: [inbox, spam, virtual], mails: [{ ...mail(1), folder: spam }] });
  h.api.accounts.list = async () => [{ id: "one", type: "imap", name: "one",
    rootFolder: { ...root, subFolders: [{ ...inbox, subFolders: [spam] }, virtual] } },
    { id: "news", type: "nntp", rootFolder: { ...root, accountId: "news" } }];
  const choices = await h.send("folderChoices");
  assert.deepEqual(choices.folders.map(folder => folder.id), ["inbox", "spam"]);
  assert.deepEqual(choices.folders[1].displayNames, ["受信トレイ", "迷惑メール"]);
  assert.equal((await h.send("folderContext", { folderId: "missing" })).ok, false);
  assert.equal((await h.send("folderContext", { folderId: "virtual" })).ok, false);
  const context = await h.send("folderContext", { folderId: "spam" });
  assert.equal(context.folder.path, "/Inbox/Spam");
  assert.deepEqual(context.folder.displayNames, ["受信トレイ", "迷惑メール"]);
  await h.send("folderStart", { token: context.token, includeSubfolders: false });
  const state = await settledFolder(h, "completed");
  assert.equal(state.folderJob.folder.id, "spam");
  assert.deepEqual(state.folderJob.folder.displayNames, ["受信トレイ", "迷惑メール"]);
  assert.deepEqual(h.rawReads, [1]);
});

test("connection confirmation and actual scan engine survive reopening/restart independently", async () => {
  const h = await harness({ mails: [mail(1)], scanResult: { engine: "loaded engine (clamd)" } });
  assert.equal((await h.send("state")).lastHealth.status, "ready");
  await h.send("health");
  assert.equal(h.stored().lastHealth.status, "ready");
  assert.ok(h.stored().lastHealth.checkedAt);
  assert.equal(h.stored().lastScan, null);
  await h.send("scanSelection");
  await settle(h, value => value.records[0]?.status === "clean");
  const next = await harness({ saved: structuredClone(h.stored()) });
  const state = await next.send("state");
  assert.equal(state.lastHealth.status, "ready");
  assert.equal(state.lastScan.engine, "loaded engine (clamd)");
  const failed = await harness({ nativeFailure: true });
  const response = await failed.send("health");
  assert.equal(response.health.status, "error");
  assert.equal(failed.stored().lastHealth.status, "error");
});

test("settings save failure preserves the last effective settings", async () => {
  const h = await harness();
  const original = structuredClone((await h.send("state")).settings);
  h.api.storage.local.set = async () => { throw new Error("synthetic quota failure"); };
  const response = await h.send("settings", { settings: { enabled: true, accountIds: ["one"], notifications: false } });
  assert.equal(response.ok, false);
  assert.deepEqual((await h.send("state")).settings, original);
});

function installAdminMock(h, { failApply = false, gate = null } = {}) {
  const calls = [];
  let operation;
  h.api.runtime.connectNative = () => {
    const port = { onMessage: event(), onDisconnect: event(), disconnect() {},
      postMessage(request) {
        calls.push(request);
        queueMicrotask(async () => {
          if (request.op === "manageApply" && gate) await gate;
          let result;
          if (request.op === "manageInfo") result = { status: "managed", version: "0.9.0", healthy: true };
          else if (request.op === "managePlan") {
            operation = request.operation;
            result = { status: "prepared", operation, token: "admin-ticket", version: "0.9.0", paths: ["/synthetic"] };
          } else result = failApply ? { status: "error", detail: "synthetic removal failure" } :
            { status: operation === "uninstall" ? "removed" : "updated", version: "0.9.0", retained: [] };
          port.onMessage.listeners[0]({ id: request.id, ...result });
        });
      } };
    return port;
  };
  return calls;
}

test("management cancellation does not remove helper and old helpers offer CLI fallback", async () => {
  const legacy = await harness();
  assert.equal((await legacy.send("helperInfo")).installation.state, "legacy");
  assert.equal((await legacy.send("helperPlan", { operation: "uninstall" })).ok, false);
  assert.equal((await legacy.send("state")).maintenance, false);
  const h = await harness(); const calls = installAdminMock(h);
  const plan = await h.send("helperPlan", { operation: "uninstall" });
  assert.equal((await h.send("settings", { settings: { enabled: false, accountIds: [], notifications: false } })).ok, false);
  await h.send("helperCancel", { token: plan.plan.token });
  assert.equal(calls.some(call => call.op === "manageApply"), false);
  assert.equal((await h.send("state")).helperRemoved, false);
  assert.equal((await h.send("state")).maintenance, false);
});

test("uninstall marks helper removed, disables auto scans and requires fresh confirmation", async () => {
  const h = await harness({ saved: { settings: { enabled: true, accountIds: ["one"], notifications: true } } });
  const calls = installAdminMock(h);
  const prepared = await h.send("helperPlan", { operation: "uninstall" });
  assert.equal((await h.send("helperApply", { token: "wrong" })).ok, false);
  assert.equal((await h.send("helperApply", { token: prepared.plan.token })).ok, true);
  const state = await h.send("state");
  assert.equal(state.helperRemoved, true); assert.equal(state.settings.enabled, false);
  assert.equal(state.installation.state, "removed");
  assert.equal(calls.filter(call => call.op === "manageApply").length, 1);
  assert.equal((await h.send("helperApply", { token: prepared.plan.token })).ok, false);
  assert.equal((await h.send("scanSelection")).ok, false);
  const restored = await harness({ saved: structuredClone(h.stored()) });
  assert.equal((await restored.send("state")).helperRemoved, true);
  assert.equal(restored.nativePorts.length, 0);
  installAdminMock(restored);
  await restored.send("helperInfo"); // A fresh terminal installation can recover.
  assert.equal((await restored.send("state")).helperRemoved, false);
});

test("incomplete removal remains paused and concurrent apply cannot run twice", async () => {
  const h = await harness();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = installAdminMock(h, { failApply: true, gate });
  const prepared = await h.send("helperPlan", { operation: "uninstall" });
  const applying = h.send("helperApply", { token: prepared.plan.token });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.send("helperApply", { token: prepared.plan.token })).ok, false);
  await h.send("helperCancel", { token: prepared.plan.token });
  assert.equal((await h.send("state")).maintenance, true);
  release(); assert.equal((await applying).ok, false);
  const state = await h.send("state");
  assert.equal(state.helperRemoved, true);
  assert.equal(state.installation.state, "unavailable");
  assert.equal(state.settings.enabled, false);
  assert.equal(calls.filter(call => call.op === "manageApply").length, 1);
});


test("addon update preserves enabled settings and returns a managed installation", async () => {
  const h = await harness({ saved: { settings: { enabled: true, accountIds: ["one"], notifications: false } } });
  const calls = installAdminMock(h);
  const prepared = await h.send("helperPlan", { operation: "repair", package: "synthetic-package" });
  const response = await h.send("helperApply", { token: prepared.plan.token });
  assert.equal(response.installation.state, "managed");
  assert.equal((await h.send("state")).settings.enabled, true);
  assert.equal((await h.send("state")).helperRemoved, false);
  assert.equal(calls.find(call => call.op === "managePlan").package, "synthetic-package");
});

test("startup discovers bundled helper update and toolbar opens setup", async () => {
  const h = await harness({ manageInfo: { status: "managed", version: "0.9.3", healthy: true } });
  assert.equal((await h.send("state")).installation.version, "0.9.3");
  h.api.browserAction.onClicked.listeners[0]();
  await settle(h, state => Boolean(state.setupRequest));
});

test("multi-folder confirmation scans the verified set and rejects changes or invalid selections", async () => {
  const one = { id: "inbox", accountId: "one", path: "/Inbox", name: "受信トレイ" };
  const two = { id: "spam", accountId: "one", path: "/Spam", name: "迷惑メール" };
  const other = { id: "other", accountId: "two", path: "/Inbox", name: "受信トレイ" };
  const h = await harness({ folderRefs: [one, two, other], mails: [{ ...mail(1), folder: one }, { ...mail(2), folder: two }] });
  for (const folderIds of [[], ["inbox", "inbox"], ["inbox", "other"], ["missing"], [null]]) {
    assert.equal((await h.send("folderContext", { folderIds })).ok, false);
  }
  const context = await h.send("folderContext", { folderIds: ["inbox", "spam"] });
  assert.deepEqual(context.folders.map(folder => folder.id), ["inbox", "spam"]);
  const get = h.api.folders.get;
  h.api.folders.get = async id => id === "spam" ? { ...two, path: "/Moved" } : get(id);
  assert.equal((await h.send("folderStart", { token: context.token, includeSubfolders: false })).ok, false);
  assert.equal(h.rawReads.length, 0);
  h.api.folders.get = get;
  await h.send("folderStart", { token: context.token, includeSubfolders: false });
  const state = await settledFolder(h, "completed");
  assert.equal(state.folderJob.total, 2);
  assert.deepEqual(h.rawReads, [1, 2]);
});

test("legacy paused queue becomes reviewable incomplete history and is not silently evicted", async () => {
  const pending = Array.from({ length: 1000 }, (_, index) => ({ key: "q" + index, source: "automatic", status: "queued",
    attempts: 0, locator: { accountId: "one" }, updatedAt: new Date().toISOString() }));
  const h = await harness({ saved: { settings: { enabled: false, accountIds: ["one"], notifications: false }, records: pending }, mails: [mail(1)] });
  assert.equal((await h.send("cancelPausedQueue")).ok, false);
  assert.equal((await h.send("state")).records.length, 1000);
  assert.ok((await h.send("state")).records.every(record => record.status === "incomplete" && record.unscannedReason === "automaticExcluded"));
  assert.equal(h.deleted.length, 0);
  const blockedContext = await h.send("folderContext", { folderId: "inbox" });
  await h.send("folderStart", { token: blockedContext.token, includeSubfolders: false });
  await settledFolder(h, "blocked");
  assert.equal((await h.send("state")).records.length, 1000);
  await h.send("clear");
  assert.equal((await h.send("state")).records.length, 0);
  const context = await h.send("folderContext", { folderId: "inbox" });
  await h.send("folderStart", { token: context.token, includeSubfolders: false });
  const state = await settledFolder(h, "completed");
  assert.equal(state.folderJob.completed, 1);
  assert.deepEqual(h.rawReads, [1]);
});

test("excluded automatic retries keep previous failure details and other alert history", async () => {
  const records = [{ key: "retry", source: "automatic", status: "queued", attempts: 1, nextRetry: 1,
    locator: { accountId: "one" }, detail: "previous scan failed", updatedAt: new Date().toISOString() },
    ...["detected", "incomplete", "error"].map(status => ({ key: status, source: "automatic", status,
      locator: { accountId: "one" }, detail: status }))];
  const h = await harness({ saved: { settings: { enabled: false, accountIds: ["one"], notifications: false }, records } });
  const state = await h.send("state");
  assert.equal(state.records.length, 4);
  assert.equal(state.records[0].status, "incomplete");
  assert.equal(state.records[0].nextRetry, null);
  assert.match(state.records[0].detail, /previous scan failed/);
  await h.timers[0]();
  assert.equal((await h.send("state")).records[0].status, "incomplete");
  assert.equal(h.deleted.length, 0);
});

test("legacy OFF with saved accounts stays stopped after startup and notification-only changes", async () => {
  const h = await harness({ saved: { settings: { enabled: false, accountIds: ["one"], notifications: true } }, mails: [mail(1)] });
  const state = await h.send("state");
  assert.equal(state.settings.enabled, false);
  assert.deepEqual(state.settings.accountIds, []);
  await h.send("settings", { settings: { ...state.settings, notifications: false } });
  h.events.newMail.listeners[0](mail(1).folder, { messages: [mail(1)] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.rawReads.length, 0);
  assert.equal((await h.send("state")).records.length, 0);
});

test("legacy ON retains selected accounts and continues automatic scanning", async () => {
  const messages = [mail(1), mail(2, "two")];
  const h = await harness({ saved: { settings: { enabled: true, accountIds: ["one"], notifications: false } }, mails: messages });
  assert.deepEqual((await h.send("state")).settings.accountIds, ["one"]);
  h.events.newMail.listeners[0](messages[0].folder, { messages });
  await settle(h, state => state.records.some(record => record.status === "clean"));
  assert.deepEqual(h.rawReads, [1]);
});

test("unchecking one account excludes its queued mail, finishes active mail and keeps manual work", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const mails = [mail(1), mail(2, "two"), mail(3), mail(4)];
  const records = mails.map((message, index) => ({ key: "q" + message.id, source: index === 3 ? "manual" : "automatic",
    status: "queued", attempts: 0, locator: locator(message) }));
  const h = await harness({ saved: { settings: { enabled: true, accountIds: ["one", "two"], notifications: false }, records },
    mails, scanGate: id => id === 1 ? gate : undefined });
  await settle(h, state => state.records[0].status === "scanning" && h.rawReads.length === 1);
  await h.send("settings", { settings: { enabled: true, accountIds: ["two"], notifications: false } });
  const during = await h.send("state");
  assert.equal(during.records[0].status, "scanning");
  assert.equal(during.records[1].status, "queued");
  assert.equal(during.records[2].status, "incomplete");
  assert.equal(during.records[2].unscannedReason, "automaticExcluded");
  assert.equal(during.records[3].status, "queued");
  release();
  await settle(h, state => state.records.filter(record => record.status === "clean").length === 3);
  assert.deepEqual(h.rawReads, [1, 2, 4]);
  await h.send("settings", { settings: { enabled: true, accountIds: ["one", "two"], notifications: false } });
  assert.equal((await h.send("state")).records[2].status, "incomplete");
  await h.send("retry", { key: "q3" });
  const done = await settle(h, state => state.records[2].status === "clean");
  assert.equal(done.records[2].unscannedReason, undefined);
  assert.deepEqual(h.rawReads, [1, 2, 4, 3]);
});

test("excluded unscanned mail can be permanently deleted with normal confirmation", async () => {
  const message = mail(1);
  const h = await harness({ saved: { settings: { enabled: false, accountIds: [], notifications: false },
    records: [{ key: "unscanned", source: "automatic", status: "queued", attempts: 0, locator: locator(message), sha256: null }] },
    mails: [message], deleteAllowed: true });
  const prepared = await h.send("prepareDelete", { key: "unscanned" });
  assert.equal(prepared.ok, true);
  assert.equal((await h.send("deletePermanently", { key: "unscanned", token: prepared.token })).ok, true);
  const record = (await h.send("state")).records[0];
  assert.equal(record.status, "deleted");
  assert.equal(record.unscannedReason, undefined);
  assert.equal(h.deleted.length, 1);
});

test("failed account deselection restores queued results as well as settings", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const mails = [mail(1), mail(2)];
  const records = mails.map(message => ({ key: "q" + message.id, source: "automatic", status: "queued", attempts: 0, locator: locator(message) }));
  const h = await harness({ saved: { settings: { enabled: true, accountIds: ["one"], notifications: false }, records }, mails,
    scanGate: id => id === 1 ? gate : undefined });
  await settle(h, state => state.records[0].status === "scanning" && h.rawReads.length === 1);
  const write = h.api.storage.local.set;
  h.api.storage.local.set = async () => { throw new Error("disk full"); };
  assert.equal((await h.send("settings", { settings: { enabled: false, accountIds: [], notifications: false } })).ok, false);
  const failed = await h.send("state");
  assert.equal(failed.settings.enabled, true);
  assert.equal(failed.records[1].status, "queued");
  assert.equal(failed.records[1].unscannedReason, undefined);
  h.api.storage.local.set = write;
  release();
  await settle(h, state => state.records.every(record => record.status === "clean"));
  assert.deepEqual(h.rawReads, [1, 2]);
});

test("history-only confirmation clears 1000 terminal entries without reading or deleting mail", async () => {
  const records = Array.from({ length: 1000 }, (_, i) => ({ key: "h" + i, status: i % 2 ? "deleted" : "incomplete", locator: { subject: "history " + i } }));
  const h = await harness({ saved: { records } });
  assert.equal((await h.send("prepareForget", { keys: Array.from({ length: 1001 }, (_, i) => "h" + i) })).ok, false);
  const prepared = await h.send("prepareForget", { keys: records.map(record => record.key) });
  assert.equal(prepared.targets.length, 1000);
  const result = await h.send("forgetMany", { token: prepared.token });
  assert.equal(result.count, 1000);
  assert.equal((await h.send("state")).records.length, 0);
  assert.equal(h.rawReads.length, 0); assert.equal(h.deleted.length, 0);
  assert.equal((await h.send("forgetMany", { token: prepared.token })).ok, false);
});

test("history clear cancels, rejects active records, and preserves changed or newly added entries", async () => {
  const records = ["a", "b", "c"].map(key => ({ key, status: "clean", locator: { subject: key } }));
  const h = await harness({ saved: { records } });
  const canceled = await h.send("prepareForget", { keys: ["a"] });
  await h.send("cancelForget", { token: canceled.token });
  assert.equal((await h.send("forgetMany", { token: canceled.token })).ok, false);
  const prepared = await h.send("prepareForget", { keys: ["a", "b"] });
  const state = await h.send("state");
  state.records.find(record => record.key === "b").status = "detected";
  state.records.push({ key: "new", status: "error", locator: {} });
  state.records.find(record => record.key === "c").status = "scanning";
  assert.equal((await h.send("prepareForget", { keys: ["c"] })).ok, false);
  const result = await h.send("forgetMany", { token: prepared.token });
  assert.deepEqual(result.keys, ["a"]); assert.equal(result.skipped, 1);
  assert.deepEqual((await h.send("state")).records.map(record => record.key), ["b", "c", "new"]);
  assert.equal(h.deleted.length, 0);
});

test("1000-message bulk retry can stop after the current message and restore pending history", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const mails = Array.from({ length: 1000 }, (_, i) => mail(i + 1));
  const records = mails.map(message => ({ key: "r" + message.id, status: "clean", locator: locator(message), detail: "previous result" }));
  const h = await harness({ saved: { records }, mails, scanGate: id => id === 1 ? gate : undefined });
  assert.equal((await h.send("retryMany", { keys: records.map(record => record.key) })).count, 1000);
  const during = await settle(h, state => state.batch?.active && h.rawReads.length === 1);
  await h.send("cancelBatch", { id: "wrong" });
  assert.equal((await h.send("state")).batch.stopRequested, false);
  await h.send("cancelBatch", { id: during.batch.id });
  assert.equal((await h.send("state")).records[1].detail, "previous result");
  release();
  const done = await settle(h, state => !state.batch.active);
  assert.equal(done.batch.completed, 1); assert.equal(done.batch.cancelled, 999);
  assert.ok(done.records.every(record => record.status === "clean" && !record.bulkRetryBefore));
  assert.deepEqual(h.rawReads, [1]);
});

test("restart restores unstarted bulk retry history and marks only the in-flight result unknown", async () => {
  const previous = { key: "queued", status: "detected", locator: {}, detail: "previous detection" };
  const h = await harness({ saved: { records: [
    { ...previous, status: "queued", source: "manual", bulkRetryId: "old", bulkRetryBefore: previous },
    { key: "active", status: "scanning", source: "manual", locator: {}, bulkRetryId: "old", bulkRetryBefore: { status: "clean" } }
  ] } });
  const state = await h.send("state");
  assert.equal(state.records[0].status, "detected");
  assert.equal(state.records[1].status, "incomplete");
  assert.ok(state.records.every(record => !record.bulkRetryId && !record.bulkRetryBefore));
  assert.equal(h.rawReads.length, 0);
});

test("canceling bulk deletion preparation produces no actionable confirmation token", async () => {
  const { records, mails } = await batchFixture();
  const h = await harness({ saved: { records }, mails, deleteAllowed: true });
  const raw = h.api.messages.getRaw;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  h.api.messages.getRaw = async (...args) => { await gate; return raw(...args); };
  const preparing = h.send("prepareDeleteBatch", { keys: ["k1", "k2"] });
  const during = await settle(h, state => state.batch?.active && state.batch.phase === "prepare");
  await h.send("cancelBatch", { id: during.batch.id }); release();
  const result = await preparing;
  assert.equal(result.cancelled, true); assert.equal(result.token, undefined);
  assert.equal(h.deleted.length, 0);
});

test("1000-message permanent deletion stops between messages and cannot replay the confirmation", async () => {
  const mails = Array.from({ length: 1000 }, (_, i) => mail(i + 1));
  const records = mails.map(message => ({ key: "d" + message.id, status: "clean", locator: locator(message), sha256: null }));
  const h = await harness({ saved: { records }, mails, deleteAllowed: true });
  const prepared = await h.send("prepareDeleteBatch", { keys: records.map(record => record.key) });
  assert.equal(prepared.targets.length, 1000);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const remove = h.api.messages.delete;
  let entered = false;
  h.api.messages.delete = async (...args) => { entered = true; await gate; return remove(...args); };
  const deleting = h.send("deleteBatch", { token: prepared.token });
  const during = await settle(h, state => state.batch?.active && state.batch.phase === "execute" && entered);
  await h.send("cancelBatch", { id: during.batch.id }); release();
  const result = await deleting;
  assert.equal(result.results.length, 1); assert.equal(result.cancelled, 999);
  assert.equal(h.deleted.length, 1);
  assert.equal((await h.send("deleteBatch", { token: prepared.token })).ok, false);
});

test("startup distinguishes missing ClamAV from an unavailable helper and can recover", async () => {
  const missing = await harness({ manageInfo: { status: "managed", version: "0.15.0", healthy: true },
    healthResult: { status: "error", code: "clamav_missing", detail: "ClamAV is missing" } });
  let state = await missing.send("state");
  assert.equal(state.installation.state, "managed");
  assert.equal(state.installation.clamavCode, "clamav_missing");
  assert.equal(state.lastHealth.code, "clamav_missing");
  assert.equal(state.lastScan, null);
  const unavailable = await harness({ nativeFailure: true });
  state = await unavailable.send("state");
  assert.equal(state.installation.state, "unavailable");
  assert.equal(state.lastHealth.code, "helper_unavailable");
  assert.doesNotMatch(state.lastHealth.detail, /ClamAVが見つかりません/);
  const healthy = await harness({ saved: structuredClone(unavailable.stored()), manageInfo: { status: "managed", version: "0.15.0", healthy: true } });
  state = await healthy.send("state");
  assert.equal(state.lastHealth.status, "ready");
  assert.equal(state.installation.state, "managed");
  assert.equal(state.installation.clamavCode, "ready");
});


test("temporary automatic mail read failure recovers without a failure notification", async () => {
  const h = await harness({ mails: [mail(1)], saved: { settings: { enabled: true, accountIds: ["one"], notifications: true } } });
  const original = h.api.messages.getRaw;
  let first = true;
  h.api.messages.getRaw = async (...args) => {
    if (first) { first = false; throw new Error("Message moved during retrieval"); }
    return original(...args);
  };
  h.events.newMail.listeners[0]({ accountId: "one" }, { messages: [mail(1)] });
  await settle(h, value => value.records[0]?.status === "error");
  assert.equal(h.notifications.length, 0);
  const now = Date.now;
  Date.now = () => now() + 120000;
  try { await h.timers[0](); await new Promise(resolve => setImmediate(resolve)); }
  finally { Date.now = now; }
  const state = await settle(h, value => value.records[0]?.status === "clean");
  assert.equal(state.records[0].attempts, 2);
  assert.equal(state.records[0].nextRetry, null);
  assert.equal(h.notifications.length, 0);
});

test("automatic quarantine moves detected new mail but not manual scans, and ignores destination events", async () => {
  const original = mail(1); original.folder.id = "inbox";
  const destination = { id: "isolation", accountId: "one", path: "/Isolation", name: "Isolation" };
  const config = { folderId: destination.id, path: destination.path, auto: true };
  const h = await harness({ mails: [original], folderRefs: [original.folder, destination], scanResult: { status: "detected", signatures: ["Synthetic"] },
    saved: { settings: { enabled: true, accountIds: ["one"], notifications: true, quarantine: { one: config } } } });
  h.api.permissions.contains = async () => true;
  h.api.folders.getFolderCapabilities = async () => ({ canAddMessages: true, canDeleteMessages: true });
  const moves = [];
  h.api.messages.move = async (ids, target) => { moves.push({ ids, target }); original.folder = destination; };
  h.events.newMail.listeners[0](original.folder, { messages: [original] });
  let state = await settle(h, state => state.records[0]?.quarantine?.status === "moved");
  assert.equal(moves.length, 1);
  assert.equal(state.records[0].status, "detected");
  assert.equal(state.records[0].locator.folder.id, destination.id);
  assert.equal(state.records[0].nextRetry, null);
  h.events.newMail.listeners[0](destination, { messages: [original] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.send("state")).records.length, 1);
  await h.send("retry", { key: state.records[0].key });
  await settle(h, state => state.records[0]?.status === "detected");
  assert.equal(moves.length, 1);
  state = await h.send("state");
  assert.equal((await h.send("prepareDelete", { key: state.records[0].key })).ok, true);
});

test("quarantine failure preserves the threat verdict and leaves a visible error", async () => {
  const original = mail(1);
  const h = await harness({ mails: [original], scanResult: { status: "detected" },
    saved: { settings: { enabled: true, accountIds: ["one"], notifications: true,
      quarantine: { one: { folderId: "missing", path: "/Isolation", auto: true } } } } });
  h.api.permissions.contains = async () => true;
  h.events.newMail.listeners[0](original.folder, { messages: [original] });
  const state = await settle(h, state => state.records[0]?.quarantine?.status === "error");
  assert.equal(state.records[0].status, "detected");
  assert.match(state.records[0].quarantine.detail, /隔離先/);
  assert.equal(state.records[0].nextRetry, null);
});

test("manual quarantine pins the verdict and destination, then preserves opening and permanent deletion", async () => {
  const original = mail(1); original.folder.id = "inbox";
  const destination = { id: "isolation", accountId: "one", path: "/Isolation", name: "Isolation" };
  const config = { folderId: destination.id, path: destination.path, auto: false };
  const h = await harness({ mails: [original], folderRefs: [original.folder, destination], scanResult: { status: "detected" },
    saved: { settings: { enabled: false, accountIds: [], notifications: true, quarantine: { one: config } } } });
  h.api.permissions.contains = async () => true;
  h.api.folders.getFolderCapabilities = async () => ({ canAddMessages: true, canDeleteMessages: true });
  const moves = [];
  h.api.messages.move = async (ids, target, options) => { moves.push({ ids, target, options }); original.folder = destination; };
  await h.send("scanSelection");
  let state = await settle(h, state => state.records[0]?.status === "detected");
  assert.equal(moves.length, 0);
  const record = state.records[0], request = { keys: [record.key], hashes: { [record.key]: record.sha256 }, destinations: { one: config } };
  assert.equal((await h.send("quarantineMany", { ...request, hashes: { [record.key]: "changed" } })).ok, false);
  assert.equal(moves.length, 0);
  const response = await h.send("quarantineMany", request);
  assert.equal(response.moved, 1);
  assert.equal(response.failed, 0);
  assert.equal(moves[0].options.isUserAction, true);
  assert.equal((await h.send("open", { key: record.key })).ok, true);
  const prepared = await h.send("prepareDelete", { key: record.key });
  assert.equal(prepared.ok, true);
  assert.equal((await h.send("deletePermanently", { key: record.key, token: prepared.token })).ok, true);
  assert.equal(h.deleted.length, 1);
});

test("restarting during quarantine does not move again or erase the detected verdict", async () => {
  const original = mail(1);
  const record = { key: "interrupted", source: "automatic", status: "detected", attempts: 1,
    locator: locator(original), sha256: await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello")),
    quarantine: { status: "moving", destination: { id: "isolation", accountId: "one", path: "/Isolation" } } };
  const h = await harness({ mails: [original], saved: { records: [record] } });
  const state = await h.send("state");
  assert.equal(state.records[0].status, "detected");
  assert.equal(state.records[0].quarantine.status, "error");
  assert.match(state.records[0].quarantine.detail, /隔離中に終了/);
  assert.equal(h.rawReads.length, 0);
});

test("manual quarantine can stop between messages without touching remaining mail", async () => {
  const mails = [mail(1), mail(2), mail(3)];
  for (const message of mails) message.folder.id = "inbox";
  const destination = { id: "isolation", accountId: "one", path: "/Isolation", name: "Isolation" };
  const config = { folderId: destination.id, path: destination.path, auto: false };
  const h = await harness({ mails, folderRefs: [mails[0].folder, destination], scanResult: { status: "detected" },
    saved: { settings: { enabled: false, accountIds: [], notifications: true, quarantine: { one: config } } } });
  h.api.permissions.contains = async () => true;
  h.api.folders.getFolderCapabilities = async () => ({ canAddMessages: true, canDeleteMessages: true });
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), moving = new Promise(resolve => { started = resolve; });
  const moved = [];
  h.api.messages.move = async ([id]) => { moved.push(id); started(); await gate; mails.find(mail => mail.id === id).folder = destination; };
  await h.send("scanSelection");
  let state = await settle(h, state => state.records.length === 3 && state.records.every(record => record.status === "detected"));
  const request = { keys: state.records.map(record => record.key), hashes: Object.fromEntries(state.records.map(record => [record.key, record.sha256])), destinations: { one: config } };
  const pending = h.send("quarantineMany", request);
  await moving;
  state = await h.send("state");
  assert.equal(state.batch.active, true);
  assert.equal((await h.send("retry", { key: request.keys[1] })).ok, false);
  assert.equal((await h.send("cancelBatch", { id: state.batch.id })).ok, true);
  release();
  const result = await pending;
  assert.equal(result.moved, 1);
  assert.equal(moved.length, 1);
  state = await h.send("state");
  assert.equal(state.batch.cancelled, 2);
  assert.equal(state.batch.active, false);
  assert.equal(state.records.filter(record => record.quarantine).length, 1);
});

test("enabling quarantine does not move mail already waiting for a scan", async () => {
  const mails = [mail(1), mail(2)];
  for (const message of mails) message.folder.id = "inbox";
  const destination = { id: "isolation", accountId: "one", path: "/Isolation", name: "Isolation" };
  const config = { folderId: destination.id, path: destination.path, auto: false };
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), scanning = new Promise(resolve => { entered = resolve; });
  let gated = false;
  const h = await harness({ mails, folderRefs: [mails[0].folder, destination], scanResult: { status: "detected" },
    scanGate: async () => { if (!gated) { gated = true; entered(); await gate; } },
    saved: { settings: { enabled: true, accountIds: ["one"], notifications: true, quarantine: { one: config } } } });
  h.api.permissions.contains = async () => true;
  h.api.folders.getFolderCapabilities = async () => ({ canAddMessages: true, canDeleteMessages: true });
  const moved = [];
  h.api.messages.move = async ([id]) => { moved.push(id); mails.find(mail => mail.id === id).folder = destination; };
  h.events.newMail.listeners[0](mails[0].folder, { messages: [mails[0]] });
  await scanning;
  assert.equal((await h.send("settings", { settings: { enabled: true, accountIds: ["one"], notifications: true,
    quarantine: { one: { ...config, auto: true } } } })).ok, true);
  release();
  await settle(h, state => state.records[0]?.status === "detected");
  assert.equal(moved.length, 0);
  h.events.newMail.listeners[0](mails[1].folder, { messages: [mails[1]] });
  await settle(h, state => state.records.some(record => record.quarantine?.status === "moved"));
  assert.deepEqual(moved, [2]);
});


test("former quarantine folders scan unrelated new mail after removing the destination", async () => {
  const original = mail(1); original.folder = { id: "old-isolation", accountId: "one", path: "/OldIsolation" };
  const record = { key: "old", status: "detected", source: "manual", attempts: 1,
    locator: { ...locator(original), headerMessageId: "older@invalid" }, sha256: "old-digest",
    quarantine: { status: "moved", destination: original.folder } };
  const h = await harness({ mails: [original], saved: { records: [record], settings: { enabled: true, accountIds: ["one"], notifications: true, quarantine: {} } } });
  h.events.newMail.listeners[0](original.folder, { messages: [original] });
  const state = await settle(h, state => state.records.some(record => record.key !== "old" && record.status === "clean"));
  assert.equal(state.records.length, 2);
  assert.deepEqual(h.rawReads, [1]);
});

test("missing automatic quarantine destinations cannot block stopping scans or disabling each account", async () => {
  const quarantine = { one: { folderId: "missing", path: "/Missing", auto: true, activation: "old" },
    two: { folderId: "missing-two", path: "/MissingTwo", auto: true, activation: "old-two" } };
  const h = await harness({ saved: { settings: { enabled: true, accountIds: ["one", "two"], notifications: true, quarantine } } });
  let settings = structuredClone((await h.send("state")).settings);
  assert.equal((await h.send("settings", { settings: { ...settings, enabled: false, accountIds: [] } })).ok, true);
  settings = structuredClone((await h.send("state")).settings);
  assert.equal(settings.enabled, false);
  assert.equal((await h.send("settings", { settings: { ...settings, notifications: false } })).ok, true);
  settings = structuredClone((await h.send("state")).settings);
  settings.quarantine.one.auto = false;
  assert.equal((await h.send("settings", { settings })).ok, true);
  settings = structuredClone((await h.send("state")).settings);
  settings.quarantine.two.auto = false;
  assert.equal((await h.send("settings", { settings })).ok, true);
  settings = structuredClone((await h.send("state")).settings);
  assert.equal(settings.quarantine.one.auto || settings.quarantine.two.auto, false);
});

test("rescan after restoring quarantined mail updates its location and quarantine state", async () => {
  const original = mail(1); original.folder.id = "inbox";
  const destination = { id: "isolation", accountId: "one", path: "/Isolation" };
  const record = { key: "restored", status: "detected", source: "manual", attempts: 1,
    locator: locator({ ...original, folder: destination }), sha256: await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello")),
    quarantine: { status: "moved", destination } };
  const h = await harness({ mails: [original], saved: { records: [record] } });
  assert.equal((await h.send("retry", { key: record.key })).ok, true);
  const state = await settle(h, state => state.records[0]?.status === "clean");
  assert.equal(state.records[0].locator.folder.id, "inbox");
  assert.equal(state.records[0].quarantine.status, "outside");
});


test("external move and Undo reconcile quarantined history, including after restart", async () => {
  const original = mail(1); original.folder.id = "inbox";
  const destination = { id: "isolation", accountId: "one", path: "/Isolation" };
  const record = { key: "undo", status: "detected", source: "manual", attempts: 1,
    locator: locator({ ...original, folder: destination }), sha256: await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello")),
    quarantine: { status: "moved", destination } };
  const h = await harness({ mails: [original], saved: { records: [record] } });
  assert.equal(h.events.moved.listeners.length, 1);
  h.events.moved.listeners[0]({ messages: [{ ...original, id: 99, folder: destination }] }, { messages: [original] });
  let state = await settle(h, state => state.records[0]?.quarantine.status === "outside");
  assert.equal(state.records[0].messageId, 1);
  assert.equal(state.records[0].locator.folder.id, "inbox");
  const old = { ...original };
  original.folder = destination;
  h.events.moved.listeners[0]({ messages: [old] }, { messages: [original] });
  state = await settle(h, state => state.records[0]?.quarantine.status === "moved");
  assert.equal(state.records[0].locator.folder.id, "isolation");
  original.raw = "Subject: changed\r\n\r\nreplacement";
  original.folder = { id: "inbox", accountId: "one", path: "/Inbox" };
  h.events.moved.listeners[0]({ messages: [{ ...original, folder: destination }] }, { messages: [original] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.send("state")).records[0].quarantine.status, "moved");
});

test("incomplete results can be reviewed with a note, survive same-result rescans and be unreviewed", async () => {
  const { reviewStamp } = await import("../thunderbird/review.mjs");
  const target = mail(1), result = { status: "incomplete", detail: "encrypted", signatures: ["Heuristics.Encrypted.Zip"] };
  const h = await harness({ mails: [target], scanResult: result });
  await h.send("scanSelection");
  let state = await settle(h, value => value.records[0]?.status === "incomplete"), r = state.records[0];
  assert.equal(h.notifications.length, 1);
  const request = { keys: [r.key], reviewed: true, note: "Known sender", stamps: { [r.key]: reviewStamp(r) } };
  assert.equal((await h.send("reviewMany", request)).count, 1);
  state = await h.send("state");
  assert.equal(state.records[0].status, "incomplete");
  assert.equal(state.records[0].review.note, "Known sender");
  assert.equal((await h.send("reviewMany", request)).ok, false); // stale confirmation
  await h.send("retry", { key: r.key });
  state = await settle(h, value => value.records[0]?.status === "incomplete");
  assert.equal(state.records[0].review.note, "Known sender");
  assert.equal(h.notifications.length, 1);
  r = state.records[0];
  assert.equal((await h.send("reviewMany", { keys: [r.key], reviewed: false, note: "", stamps: { [r.key]: reviewStamp(r) } })).count, 1);
  assert.equal((await h.send("state")).records[0].review, undefined);
});

test("changed contents, changed incomplete reasons, threats and failures clear previous review", async () => {
  const { reviewStamp } = await import("../thunderbird/review.mjs");
  for (const change of ["body", "reason", "detected", "error"]) {
    const target = mail(1); let next = { status: "incomplete", detail: "encrypted" };
    const h = await harness({ mails: [target], scanResult: () => next });
    await h.send("scanSelection");
    let state = await settle(h, value => value.records[0]?.status === "incomplete"), r = state.records[0];
    await h.send("reviewMany", { keys: [r.key], reviewed: true, note: "", stamps: { [r.key]: reviewStamp(r) } });
    if (change === "body") target.raw = "Subject: changed\r\n\r\nnew body";
    if (change === "reason") next = { status: "incomplete", detail: "limit exceeded" };
    if (["detected", "error"].includes(change)) next = { status: change, detail: "changed" };
    await h.send("retry", { key: r.key });
    state = await settle(h, value => !["queued", "scanning"].includes(value.records[0]?.status));
    assert.equal(state.records[0].review, undefined, change);
  }
});

test("unverifiable incomplete mail can be acknowledged, but a rescan clears the acknowledgement", async () => {
  const { reviewStamp } = await import("../thunderbird/review.mjs");
  const h = await harness({ mails: [mail(1)], oversized: true });
  await h.send("scanSelection");
  let state = await settle(h, value => value.records[0]?.status === "incomplete"), r = state.records[0];
  assert.equal((await h.send("reviewMany", { keys: [r.key], reviewed: true, note: "", stamps: { [r.key]: reviewStamp(r) } })).ok, true);
  state = await h.send("state"); assert.equal(state.records[0].review.fingerprint, null);
  await h.send("retry", { key: r.key });
  state = await settle(h, value => value.records[0]?.status === "incomplete");
  assert.equal(state.records[0].review, undefined);
});

test("review cannot hide detections, exceed note limits or survive a failed save", async () => {
  const { reviewStamp } = await import("../thunderbird/review.mjs");
  const h = await harness({ mails: [mail(1)], scanResult: { status: "incomplete", detail: "encrypted" } });
  await h.send("scanSelection");
  let state = await settle(h, value => value.records[0]?.status === "incomplete"), r = state.records[0];
  const request = { keys: [r.key], reviewed: true, note: "", stamps: { [r.key]: reviewStamp(r) } };
  assert.equal((await h.send("reviewMany", { ...request, note: "x".repeat(1001) })).ok, false);
  const save = h.api.storage.local.set;
  h.api.storage.local.set = async () => { throw Error("storage full"); };
  assert.equal((await h.send("reviewMany", request)).ok, false);
  assert.equal((await h.send("state")).records[0].review, undefined);
  h.api.storage.local.set = save;
  // A terminal threat is never eligible for manual acknowledgement.
  const threat = await harness({ mails: [mail(2)], scanResult: { status: "detected" } });
  await threat.send("scanSelection");
  state = await settle(threat, value => value.records[0]?.status === "detected"); r = state.records[0];
  assert.equal((await threat.send("reviewMany", { keys: [r.key], reviewed: true, note: "", stamps: { [r.key]: reviewStamp(r) } })).ok, false);
});

test("review changes can stop between records without hiding unprocessed results", async () => {
  const { reviewStamp } = await import("../thunderbird/review.mjs");
  const records = [1, 2, 3].map(id => ({ key: "review-" + id, status: "incomplete", detail: "encrypted", sha256: "body-" + id,
    locator: locator(mail(id)), updatedAt: new Date().toISOString() }));
  const h = await harness({ saved: { records } });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), saving = new Promise(resolve => { entered = resolve; });
  const save = h.api.storage.local.set; let first = true;
  h.api.storage.local.set = async value => { if (first) { first = false; entered(); await gate; } return save(value); };
  const pending = h.send("reviewMany", { keys: records.map(record => record.key), reviewed: true, note: "known",
    stamps: Object.fromEntries(records.map(record => [record.key, reviewStamp(record)])) });
  await saving;
  const state = await h.send("state");
  await h.send("cancelBatch", { id: state.batch.id }); release();
  assert.equal((await pending).count, 1);
  const result = await h.send("state");
  assert.equal(result.records.filter(record => record.review).length, 1);
  assert.equal(result.batch.cancelled, 2);
});

test("review survives restart and an interrupted rescan only after identical contents are checked", async () => {
  const { reviewReason } = await import("../thunderbird/review.mjs");
  const target = mail(1), digest = await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello"));
  const record = { key: "restart-review", status: "incomplete", detail: "encrypted", sha256: digest, locator: locator(target),
    source: "manual", attempts: 1, updatedAt: new Date().toISOString() };
  const review = { at: new Date().toISOString(), note: "known source", reason: reviewReason(record), resultHash: digest, fingerprint: "sha256:" + digest };
  const first = await harness({ mails: [target], saved: { records: [{ ...record, review }] } });
  assert.equal((await first.send("state")).records[0].review.note, "known source");
  const resuming = await harness({ mails: [target], scanResult: { status: "incomplete", detail: "encrypted" },
    saved: { records: [{ ...record, status: "scanning", reviewBeforeScan: review }] } });
  const state = await settle(resuming, state => state.records[0]?.status === "incomplete");
  assert.equal(state.records[0].review.note, "known source");
  assert.equal(state.records[0].reviewBeforeScan, undefined);
  assert.equal(resuming.notifications.length, 0);
});

test("oversized mail retains review only when its streamed content fingerprint is unchanged", async () => {
  const { reviewStamp } = await import("../thunderbird/review.mjs");
  const h = await harness({ mails: [mail(1)] });
  const size = 25 * 1024 * 1024 + 1, zeros = new Uint8Array(512 * 1024); let changed = false;
  h.api.messages.getRaw = async () => ({ size, arrayBuffer() { throw Error("must not allocate oversized mail"); }, slice(start, end) {
    const bytes = zeros.slice(0, Math.min(size, end) - start);
    if (changed && start === 0) bytes[0] = 1;
    return new Blob([bytes]);
  } });
  await h.send("scanSelection");
  let state = await settle(h, state => state.records[0]?.status === "incomplete"), r = state.records[0];
  assert.equal((await h.send("reviewMany", { keys: [r.key], reviewed: true, note: "expected large mail", stamps: { [r.key]: reviewStamp(r) } })).ok, true);
  assert.match((await h.send("state")).records[0].review.fingerprint, /^chunked-sha256-v1:/);
  async function rescan() {
    await h.send("retry", { key: r.key });
    for (let i = 0; i < 5000; i++) {
      const state = await h.send("state");
      if (state.records[0]?.status === "incomplete" && !state.records[0].reviewBeforeScan) return state;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw Error("oversized review reconciliation did not settle");
  }
  state = await rescan(); assert.equal(state.records[0].review.note, "expected large mail");
  changed = true;
  state = await rescan(); assert.equal(state.records[0].review, undefined);
});


test("scan settings are recorded and advisory notifications follow the per-category mode", async () => {
  const { scanPolicy } = await import("../thunderbird/scan-policy.mjs");
  for (const mode of ["display", "notify"]) {
    const settings = { enabled: true, accountIds: ["one"], notifications: true, quarantine: { one: { auto: true, folderId: "isolation", path: "/Isolation" } }, scanSettings: scanPolicy({ phishing: mode }) };
    const h = await harness({ mails: [mail(1)], saved: { settings }, healthResult: { status: "ready", protocol: 1, scanSettingsVersion: 1, engine: "test" },
      scanResult: { status: "advisory", detail: "phishing", signatures: ["Heuristics.Phishing.Email.SpoofedDomain"], advisories: [{ kind: "phishing" }] } });
    h.events.newMail.listeners[0](mail(1).folder, { messages: [mail(1)] });
    const state = await settle(h, state => state.records[0]?.status === "advisory");
    assert.deepEqual(state.records[0].scanSettings, settings.scanSettings);
    assert.equal(state.records[0].advisories[0].kind, "phishing");
    assert.equal(h.notifications.length, mode === "notify" ? 1 : 0);
    assert.equal(state.records[0].quarantine, undefined);
    assert.equal((await h.send("prepareDelete", { key: state.records[0].key })).ok, false); // permission is still optional
  }
});

test("older helpers cannot silently ignore customized scan settings", async () => {
  const h = await harness({ mails: [mail(1)], saved: { settings: { enabled: false, accountIds: [], notifications: true, scanSettings: { macros: "display" } } } });
  await h.send("scanSelection");
  const state = await settle(h, state => state.records[0]?.status === "error");
  assert.match(state.records[0].detail, /補助プログラムの更新/);
  assert.equal(h.nativePorts.length, 1);
});

test("mail size policy is enforced before transferring or allocating oversized mail", async () => {
  const h = await harness({ mails: [mail(1)], saved: { settings: { enabled: false, accountIds: [], notifications: true, scanSettings: { mailMiB: 5 } } } });
  h.api.messages.getRaw = async () => ({ size: 6 * 1024 * 1024, arrayBuffer() { throw Error("must not allocate"); } });
  await h.send("scanSelection");
  const state = await settle(h, state => state.records[0]?.status === "incomplete");
  assert.match(state.records[0].detail, /5MiB/);
  assert.equal(state.records[0].scanSettings.mailMiB, 5);
  assert.equal(h.nativePorts.length, 0);
  assert.equal((await h.send("settings", { settings: { enabled: false, accountIds: [], notifications: true, scanSettings: { mailMiB: 101 } } })).ok, false);
});

test("running scans retain their original policy and settings changes affect the next scan", async () => {
  const { scanPolicy } = await import("../thunderbird/scan-policy.mjs");
  const first = scanPolicy({ macros: "display" }), second = scanPolicy({ macros: "notify" });
  let entered, release; const scanning = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; }); let once = true;
  const mails = [mail(1), mail(2)];
  const h = await harness({ mails, saved: { settings: { enabled: true, accountIds: ["one"], notifications: true, scanSettings: first } },
    healthResult: { status: "ready", protocol: 1, scanSettingsVersion: 1, engine: "test" },
    scanGate: async () => { if (once) { once = false; entered(); await gate; } },
    scanResult: { status: "advisory", detail: "macro", advisories: [{ kind: "macros" }] } });
  h.events.newMail.listeners[0](mails[0].folder, { messages: [mails[0]] });
  await scanning;
  assert.equal((await h.send("settings", { settings: { enabled: true, accountIds: ["one"], notifications: true, scanSettings: second } })).ok, true);
  release();
  let state = await settle(h, state => state.records[0]?.status === "advisory");
  assert.equal(state.records[0].scanSettings.macros, "display");
  assert.equal(h.notifications.length, 0);
  h.events.newMail.listeners[0](mails[1].folder, { messages: [mails[1]] });
  state = await settle(h, state => state.records.length === 2 && state.records.every(record => record.status === "advisory"));
  assert.equal(state.records[1].scanSettings.macros, "notify");
  assert.equal(h.notifications.length, 1);
});

test("display-only advisories do not suppress later folder failure notifications", async () => {
  const { scanPolicy } = await import("../thunderbird/scan-policy.mjs");
  const h = await harness({ mails: [mail(1), mail(2)],
    saved: { settings: { enabled: false, accountIds: [], notifications: true, scanSettings: scanPolicy({ phishing: "display" }) } },
    healthResult: { status: "ready", protocol: 1, scanSettingsVersion: 1, engine: "test" },
    scanResult: id => id === 1 ? { status: "advisory", advisories: [{ kind: "phishing" }], detail: "warning" } : { status: "error", detail: "failure" } });
  await startFolder(h);
  const state = await settledFolder(h, "completed");
  assert.equal(state.folderJob.counts.advisory, 1);
  assert.equal(state.folderJob.counts.error, 1);
  assert.equal(h.notifications.length, 2); // one failure and the ordinary completion summary
  assert.equal(h.notifications.some(([key, value]) => !key.startsWith("folder-") && value.title.includes("検査失敗")), true);
});

test("full protected history still scans consecutive incoming mail and retains human decisions", async () => {
  const records = Array.from({ length: 1000 }, (_, i) => ({ key: `protected-${i}`, status: "incomplete", locator: { accountId: "one" }, review: { note: `human memo ${i}` } }));
  const mails = Array.from({ length: 23 }, (_, i) => mail(i + 1));
  const h = await harness({ saved: { records, settings: { enabled: true, accountIds: ["one"], notifications: true } }, mails,
    scanResult: id => ({ status: id === 23 ? "clean" : "detected", detail: "synthetic", signatures: ["Synthetic"] }) });
  h.events.newMail.listeners[0](mails[0].folder, { messages: mails });
  let state;
  for (let i = 0; i < 500; i++) {
    state = await h.send("state");
    if (state.overflowReport?.total === 23 && !state.overflowPending) break;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(state.overflowReport.total, 23);
  assert.deepEqual(state.records.map(({ key, status, review }) => ({ key, status, review })), records.map(({ key, status, review }) => ({ key, status, review })));
  assert.deepEqual(state.overflowReport.counts, { detected: 22, clean: 1 });
  assert.equal(state.overflowReport.recent.length, 20);
  assert.equal(h.notifications.length, 22);
  assert.equal(h.rawReads.length, 23);
  assert.equal(h.stored().overflowReport.total, 23);
  const record = state.overflowReport.recent[0];
  assert.equal((await h.send("openOverflow", { key: record.key })).ok, true);
  assert.equal(h.opened[0].messageId, 22);
  mails[21].raw = "changed content";
  assert.equal((await h.send("openOverflow", { key: record.key })).ok, false);
  assert.equal(h.opened.length, 1);
  assert.equal((await h.send("clearOverflow")).ok, true);
  assert.equal((await h.send("state")).overflowReport, null);
  assert.equal((await h.send("state")).records.length, 1000);
  assert.equal(h.deleted.length, 0);
});

test("unknown mail delivered directly to the current quarantine folder is scanned", async () => {
  const message = mail(1);
  message.folder = { id: "isolation", accountId: "one", path: "/Isolation" };
  const h = await harness({ mails: [message], saved: { settings: { enabled: true, accountIds: ["one"], notifications: true,
    quarantine: { one: { folderId: "isolation", path: "/Isolation", auto: false } } } } });
  h.events.newMail.listeners[0](message.folder, { messages: [message] });
  await settle(h, state => state.records[0]?.status === "clean");
  assert.deepEqual(h.rawReads, [1]);
});

test("persisted overflow inspection resumes after restart without numeric ID reuse", async () => {
  const message = mail(7);
  const records = Array.from({ length: 1000 }, (_, i) => ({ key: `old-${i}`, status: "detected", locator: { accountId: "one" } }));
  const h = await harness({ mails: [message], saved: { records, settings: { enabled: true, accountIds: ["one"], notifications: true },
    overflowPending: { key: "interrupted", status: "scanning", source: "automatic", messageId: 999, session: "old", attempts: 1, locator: locator(message) } } });
  await h.timers[0]();
  const state = await settle(h, state => state.overflowReport?.total === 1);
  assert.equal(state.overflowReport.counts.clean, 1);
  assert.deepEqual(h.rawReads, [7]);
  assert.equal(state.records.length, 1000);
});

test("overflow failures are reported immediately and do not block the following incoming mail", async () => {
  const records = Array.from({ length: 1000 }, (_, i) => ({ key: `old-${i}`, status: "detected", locator: { accountId: "one" } }));
  const h = await harness({ mails: [mail(1), mail(2)], saved: { records, settings: { enabled: true, accountIds: ["one"], notifications: true } },
    scanResult: id => ({ status: id === 1 ? "error" : "clean", detail: "synthetic" }) });
  h.events.newMail.listeners[0]({}, { messages: [mail(1), mail(2)] });
  const state = await settle(h, state => state.overflowReport?.total === 2);
  assert.deepEqual(state.overflowReport.counts, { error: 1, clean: 1 });
  assert.equal(h.notifications.length, 1);
  assert.equal(state.overflowReport.recent[0].nextRetry, null);
});

test("full protected history does not disable automatic quarantine", async () => {
  const original = mail(1); original.folder.id = "inbox";
  const destination = { id: "isolation", accountId: "one", path: "/Isolation", name: "Isolation" };
  const records = Array.from({ length: 1000 }, (_, i) => ({ key: `old-${i}`, status: "detected", locator: { accountId: "one" } }));
  const h = await harness({ mails: [original], folderRefs: [original.folder, destination], scanResult: { status: "detected", signatures: ["Synthetic"] },
    saved: { records, settings: { enabled: true, accountIds: ["one"], notifications: true,
      quarantine: { one: { folderId: destination.id, path: destination.path, auto: true } } } } });
  h.api.permissions.contains = async () => true;
  h.api.folders.getFolderCapabilities = async () => ({ canAddMessages: true, canDeleteMessages: true });
  let moves = 0;
  h.api.messages.move = async () => { moves++; original.folder = destination; };
  h.events.newMail.listeners[0](original.folder, { messages: [original] });
  const state = await settle(h, state => state.overflowReport?.total === 1);
  assert.equal(state.overflowReport.recent[0].quarantine.status, "moved");
  assert.equal(moves, 1);
  h.events.newMail.listeners[0](destination, { messages: [original] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.send("state")).overflowReport.total, 1);
  assert.equal(moves, 1);
  assert.equal(h.notifications.length, 1);
});


test("integrated scanner preserves settings and history, backs up before writes, and never calls nativeMessaging", async () => {
  const retained = { key: "human", status: "incomplete", locator: { accountId: "one" }, review: { note: "preserve this" } };
  const saved = { settings: { enabled: true, accountIds: ["one"], notifications: false }, records: [retained], helperRemoved: true };
  const h = await harness({ direct: true, saved, mails: [mail(1)] });
  let state = await h.send("state");
  assert.equal(state.installation.state, "integrated");
  assert.equal(state.helperRemoved, false);
  assert.equal(state.records[0].review.note, "preserve this");
  assert.deepEqual(h.migrationBackups[0], saved);
  assert.equal((await h.send("helperPlan", { operation: "uninstall" })).ok, false);
  h.events.newMail.listeners[0]({}, { messages: [mail(1)] });
  state = await settle(h, state => state.records.some(record => record.messageId === 1 && record.status === "clean"));
  assert.equal(state.records[0].review.note, "preserve this");
  assert.ok(h.directRequests.some(request => request.op === "end"));
  assert.ok(h.directRequests.every(request => !request.op.startsWith("manage")));
  const next = await harness({ direct: true, saved: h.stored(), mails: [mail(1)] });
  assert.equal(next.migrationBackups.length, 0);
});

test("migration backup failure leaves existing stored history untouched and stops startup", async () => {
  const saved = { settings: { enabled: false, accountIds: [], notifications: false }, records: [{ key: "human", review: { note: "keep" } }] };
  const h = await harness({ direct: true, backupFailure: true, saved });
  assert.equal((await h.send("state")).ok, false);
  assert.deepEqual(h.stored(), saved);
  assert.equal(h.directRequests.length, 0);
});

async function knownThreat(options = {}) {
  const target = mail(1);
  const record = { key: "retained-threat", status: "detected", signatures: ["Synthetic.Threat"],
    detail: "previous detection", engine: "previous engine", updatedAt: "2026-01-01T00:00:00Z",
    sha256: await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello")), locator: locator(target) };
  return harness({ direct: true, saved: { records: [record] }, mails: [target], ...options });
}

test("failed rescan retains a detected verdict, quarantine eligibility and delayed retry", async () => {
  const { canQuarantine } = await import("../thunderbird/quarantine.mjs");
  const h = await knownThreat({ nativeFailure: true });
  await h.send("retry", { key: "retained-threat" });
  let state = await settle(h, value => value.records[0].nextRetry);
  const record = state.records[0];
  assert.equal(record.status, "detected");
  assert.deepEqual(record.signatures, ["Synthetic.Threat"]);
  assert.equal(record.lastAttempt.status, "error");
  assert.equal(record.detail, "previous detection");
  assert.equal(canQuarantine(record), true);
  assert.equal(h.notifications.length, 0);
  record.nextRetry = 1;
  h.timers[0]();
  state = await settle(h, value => value.records[0].attempts === 2 && value.records[0].nextRetry === null && value.records[0].status === "detected");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.records[0].lastAttempt.status, "error");
  assert.equal(h.notifications.length, 1);
});

test("a changed message keeps the previous detection separately and cannot be quarantined as detected", async () => {
  const { canQuarantine } = await import("../thunderbird/quarantine.mjs");
  const h = await knownThreat({ scanResult: { status: "error", detail: "synthetic engine error" } });
  // Bind the current runtime ID first; then simulate changed bytes before retry.
  await h.send("open", { key: "retained-threat" });
  h.api.messages.getRaw = async () => new File(["changed contents"], "changed.eml");
  await h.send("retry", { key: "retained-threat" });
  const state = await settle(h, value => value.records[0].status === "error");
  assert.equal(state.records[0].lastResult.status, "detected");
  assert.deepEqual(state.records[0].lastResult.signatures, ["Synthetic.Threat"]);
  assert.notEqual(state.records[0].sha256, state.records[0].lastResult.sha256);
  assert.equal(canQuarantine(state.records[0]), false);
});

test("a conclusive clean rescan replaces the previous detection and failure", async () => {
  const h = await knownThreat();
  await h.send("retry", { key: "retained-threat" });
  const state = await settle(h, value => value.records[0].status === "clean");
  assert.deepEqual(state.records[0].signatures, []);
  assert.equal(state.records[0].lastResult, undefined);
  assert.equal(state.records[0].lastAttempt, undefined);
});

test("bulk incomplete rescans retain detections and the new reason", async () => {
  const h = await knownThreat({ scanResult: { status: "incomplete", detail: "encrypted part" } });
  await h.send("retryMany", { keys: ["retained-threat"] });
  const state = await settle(h, value => value.batch?.active === false);
  assert.equal(state.records[0].status, "detected");
  assert.equal(state.records[0].lastAttempt.detail, "encrypted part");
  assert.deepEqual(state.records[0].signatures, ["Synthetic.Threat"]);
});

test("retained detection survives restart and an interrupted bulk rescan", async () => {
  const h = await knownThreat({ nativeFailure: true });
  await h.send("retry", { key: "retained-threat" });
  await settle(h, value => value.records[0].nextRetry);
  const saved = structuredClone(h.stored());
  saved.records[0].status = "scanning";
  saved.records[0].bulkRetryId = "interrupted";
  const restarted = await harness({ direct: true, saved, mails: [mail(1)], nativeFailure: true });
  const state = await restarted.send("state");
  assert.equal(state.records[0].status, "detected");
  assert.deepEqual(state.records[0].signatures, ["Synthetic.Threat"]);
  assert.equal(state.records[0].lastAttempt.status, "incomplete");
  assert.equal(state.records[0].nextRetry, null);
});

test("retaining a detection never permits permanent deletion of changed bytes", async () => {
  const h = await knownThreat({ nativeFailure: true, deleteAllowed: true });
  await h.send("retry", { key: "retained-threat" });
  await settle(h, value => value.records[0].nextRetry);
  assert.equal((await h.send("prepareDelete", { key: "retained-threat" })).ok, true);
  h.api.messages.getRaw = async () => new File(["changed after failure"], "changed.eml");
  assert.equal((await h.send("prepareDelete", { key: "retained-threat" })).ok, false);
  assert.equal(h.deleted.length, 0);
});


test("missing ClamAV blocks folder start without reading mail or replacing full history, and can recover", async () => {
  const health = { status: "error", code: "clamav_missing", detail: "ClamAV missing" };
  const records = Array.from({ length: 1000 }, (_, index) => ({ key: "old-" + index, status: "clean", locator: { accountId: "one" } }));
  const h = await harness({ direct: true, saved: { records }, mails: [mail(1)], healthResult: health });
  const before = structuredClone((await h.send("state")).records);
  let listings = 0;
  const list = h.api.messages.list;
  h.api.messages.list = async (...args) => { listings++; return list(...args); };
  const context = await h.send("folderContext");
  const result = await h.send("folderStart", { token: context.token, includeSubfolders: false });
  assert.equal(result.ok, false);
  assert.equal(result.setupRequired, true);
  const state = await h.send("state");
  assert.equal(state.folderJob, null);
  assert.deepEqual(state.records, before);
  assert.equal(state.lastHealth.code, "clamav_missing");
  assert.ok(state.setupRequest);
  assert.equal(listings, 0);
  assert.equal(h.rawReads.length, 0);
  Object.assign(health, { status: "ready", protocol: 1, engine: "synthetic restored engine" });
  assert.equal((await h.send("folderStart", { token: context.token, includeSubfolders: false })).ok, true);
  await settledFolder(h, "completed");
});

test("missing ClamAV blocks folder resume without changing its progress or retained results", async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const h = await harness({ mails: [mail(1), mail(2)], scanGate: async () => { entered(); await gate; } });
  const jobId = await startFolder(h);
  await started;
  await h.send("folderStop", { jobId }); release();
  await settledFolder(h, "stopped");
  const next = await harness({ direct: true, saved: structuredClone(h.stored()), mails: [mail(1), mail(2)],
    healthResult: { status: "error", code: "clamav_missing", detail: "ClamAV missing" } });
  const before = structuredClone(await next.send("state"));
  const result = await next.send("folderResume", { jobId });
  const after = await next.send("state");
  assert.equal(result.ok, false);
  assert.equal(result.setupRequired, true);
  assert.deepEqual(after.folderJob, before.folderJob);
  assert.deepEqual(after.records, before.records);
  assert.equal(next.rawReads.length, 0);
});

test("unavailable scanner blocks folder start before creating a job", async () => {
  const h = await harness({ direct: true, nativeFailure: true, mails: [mail(1)] });
  const context = await h.send("folderContext");
  const result = await h.send("folderStart", { token: context.token, includeSubfolders: false });
  assert.equal(result.setupRequired, true);
  const state = await h.send("state");
  assert.equal(state.folderJob, null);
  assert.equal(state.records.length, 0);
  assert.equal(state.lastHealth.code, "direct_unavailable");
});


test("a ready response with an incompatible protocol cannot start a folder scan", async () => {
  const h = await harness({ direct: true, mails: [mail(1)],
    healthResult: { status: "ready", protocol: 2, engine: "synthetic incompatible engine" } });
  const context = await h.send("folderContext");
  const result = await h.send("folderStart", { token: context.token, includeSubfolders: false });
  assert.equal(result.ok, false);
  assert.equal(result.setupRequired, true);
  const state = await h.send("state");
  assert.equal(state.lastHealth.code, "protocol_incompatible");
  assert.equal(state.installation.healthy, false);
  assert.equal(state.folderJob, null);
  assert.equal(state.records.length, 0);
  assert.equal(h.rawReads.length, 0);
});


test("explicit connection checks recover transient startup writes without losing history", async () => {
  for (const failedWrite of [2, 3]) {
    const saved = { settings: { enabled: false, accountIds: [], notifications: false }, records: [{key:"human",status:"clean",locator:{accountId:"one"},review:{note:"keep"}}] };
    const h = await harness({ direct: true, saved, failWrites: [failedWrite] });
    const failure = await h.send("state");
    assert.equal(failure.ok, false);
    assert.equal(failure.startupFailed, true);
    const reads = h.storageCounts.reads;
    assert.equal((await h.send("scanSelection")).ok, false);
    assert.equal((await h.send("state")).ok, false);
    assert.equal(h.storageCounts.reads, reads); // Polling does not retry initialization.
    assert.equal(h.rawReads.length, 0);
    const recovered = await Promise.all([h.send("health"), h.send("health")]);
    assert.ok(recovered.every(result => result.ok), JSON.stringify(recovered));
    assert.equal(h.storageCounts.reads, reads + 1); // Concurrent clicks share one initialization.
    const state = await h.send("state");
    assert.equal(state.ok, true);
    assert.equal(state.records[0].review.note, "keep");
    assert.equal(state.settings.enabled, false);
    assert.equal(h.migrationBackups.length, 1);
  }
});

test("repeated startup failures remain recoverable without allowing mail operations", async () => {
  const h = await harness({ direct: true, failWrites: [2, 3] });
  assert.equal((await h.send("health")).startupFailed, true);
  assert.equal((await h.send("scanSelection")).ok, false);
  assert.equal(h.rawReads.length, 0);
  assert.equal((await h.send("health")).ok, true);
  assert.equal((await h.send("state")).ok, true);
});

test("migration backup must succeed before explicit startup recovery can write or inspect mail", async () => {
  const saved = {records:[{key:"human",status:"clean",locator:{accountId:"one"},review:{note:"original"}}]};
  const h = await harness({direct:true,backupFailure:true,saved});
  assert.equal((await h.send("health")).startupFailed, true);
  assert.deepEqual(h.stored(), saved);
  assert.equal(h.rawReads.length, 0);
  let backups = 0;
  h.api.clamDirect.backup = async snapshot => {
    assert.deepEqual(JSON.parse(snapshot).records, saved.records); backups++;
    return {path:"/synthetic/recovered-backup.json"};
  };
  assert.equal((await h.send("health")).ok, true);
  assert.equal(backups, 1);
  assert.equal((await h.send("state")).records[0].review.note, "original");
});


test("an initial storage read failure can be retried without overwriting unread data", async () => {
  const saved={records:[{key:"unread",status:"clean",locator:{accountId:"one"}}]};
  const h=await harness({direct:true,saved,failReads:[1]});
  assert.equal((await h.send("state")).startupFailed,true);
  assert.deepEqual(h.stored(),saved);
  assert.equal(h.storageCounts.writes,0);
  assert.equal((await h.send("health")).ok,true);
  assert.equal((await h.send("state")).records[0].key,"unread");
});


async function moveFixture({changed = false, ambiguous = false, reviewed = false, scanGate = null, scanResult = {}, quarantine = {}} = {}) {
  const original=mail(1); original.folder.id="inbox";
  const moved={...original,id:2,folder:{id:"child",accountId:"one",path:"/Inbox/Child"},...(changed?{raw:"different contents"}:{})};
  const digest=await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello"));
  const record={key:"ordinary",status:"incomplete",detail:"synthetic encrypted part",sha256:digest,locator:locator(original),source:"automatic",signatures:[]};
  if(reviewed){const {reviewReason}=await import("../thunderbird/review.mjs");record.review={note:"keep human judgment",reason:reviewReason(record),resultHash:digest,fingerprint:"sha256:"+digest};}
  const h=await harness({direct:true,scanGate,scanResult,mails:[original,moved],saved:{records:[record],settings:{enabled:true,accountIds:["one"],notifications:false,quarantine}}});
  const destinations=ambiguous?[moved,{...moved,id:3}]:[moved];
  if(ambiguous){const raw=h.api.messages.getRaw;h.api.messages.getRaw=(id,options)=>raw(id===3?2:id,options);}
  return {h,original,moved,destinations};
}

test("ordinary moves refresh one history and preserve its review before repeated incoming notification", async () => {
  const {h,original,moved}=await moveFixture({reviewed:true});
  h.events.moved.listeners[0]({messages:[original]},{messages:[moved]});
  let state=await settle(h,s=>s.records[0].messageId===2);
  assert.equal(state.records[0].locator.folder.path,moved.folder.path);
  assert.equal(state.records[0].review.note,"keep human judgment");
  const {isReviewed}=await import("../thunderbird/review.mjs");
  assert.equal(isReviewed(state.records[0]),true);
  const before=h.storageCounts.writes;
  h.events.newMail.listeners[0](moved.folder,{messages:[moved]});
  state=await settle(h,()=>h.storageCounts.writes>before);
  assert.equal(state.records.length,1);
  assert.equal(state.records[0].key,"ordinary");
  assert.equal(h.directRequests.some(request=>request.op==="end"),false);
});

test("changed or ambiguous move targets cannot inherit a previous verdict", async () => {
  for(const options of [{changed:true},{ambiguous:true}]){
    const {h,original,destinations}=await moveFixture(options);
    const before=h.storageCounts.writes;
    await h.events.moved.listeners[0]({messages:[original]},{messages:destinations});
    // An empty incoming list queues a save after move reconciliation, without
    // inspecting or changing a mail record.
    h.events.newMail.listeners[0](original.folder,{messages:[]});
    const state=await settle(h,()=>h.storageCounts.writes>before);
    assert.equal(state.records.find(record=>record.key==="ordinary").locator.folder.path,"/Inbox");
  }
});

test("copies remain separate messages when no move event links them", async () => {
  const {h,moved}=await moveFixture();
  h.events.newMail.listeners[0](moved.folder,{messages:[moved]});
  const state=await settle(h,s=>s.records.length===2&&s.records[1].status==="clean");
  assert.equal(state.records[0].key,"ordinary");
  assert.equal(state.records[0].locator.folder.path,"/Inbox");
  assert.equal(state.records[1].locator.folder.path,moved.folder.path);
});

async function moveDuringScan(rawPhase, {sameId = false, changed = false} = {}) {
  const original=mail(1);original.folder.id="inbox";
  const moved={...original,id:sameId?1:2,folder:{id:"child",accountId:"one",path:"/Inbox/Child"},...(changed?{raw:"changed destination contents"}:{})};
  let release,enter;
  const gate=new Promise(resolve=>{release=resolve;});
  const entered=new Promise(resolve=>{enter=resolve;});
  const h=await harness({direct:true,mails:sameId?[original]:[original,moved],saved:{settings:{enabled:true,accountIds:["one"],notifications:false}},
    scanGate:rawPhase?null:async()=>{enter();await gate;}});
  if(rawPhase){const raw=h.api.messages.getRaw;h.api.messages.getRaw=async(id,options)=>{const file=await raw(id,options);if(id===1){enter();await gate;}return file;};}
  h.events.newMail.listeners[0](original.folder,{messages:[original]});
  await entered;
  try{
    if(sameId){const get=h.api.messages.get;h.api.messages.get=async id=>id===1?moved:get(id);}
    h.events.moved.listeners[0]({messages:[original]},{messages:[moved]});
    await settle(h,s=>s.records[0].locator.folder.path===moved.folder.path);
    h.events.newMail.listeners[0](moved.folder,{messages:[moved]});
  }finally{release();}
  const state=await settle(h,s=>s.records[0].status===(changed?"error":"clean"));
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await h.send("state")).records.length,1);
  assert.equal(state.records[0].locator.folder.path,moved.folder.path);
  assert.equal(state.records[0].messageId,moved.id);
  if(changed)assert.equal(h.directRequests.some(request=>request.op==="end"),false);
}

test("a move during raw retrieval redirects pending work without stale-location overwrite",async()=>{await moveDuringScan(true);});
test("a move during engine scanning keeps the in-flight record and avoids a duplicate",async()=>{await moveDuringScan(false);});


test("a move that preserves the numeric ID cannot overwrite the new folder with stale headers",async()=>{await moveDuringScan(true,{sameId:true});});
test("a changed destination during raw retrieval cannot receive the old bytes' verdict",async()=>{await moveDuringScan(true,{changed:true});});

test("verified cross-account moves retain one history in the destination account",async()=>{
  const {h,original,moved}=await moveFixture();
  moved.folder.accountId="two";
  h.events.moved.listeners[0]({messages:[original]},{messages:[moved]});
  const state=await settle(h,s=>s.records[0].locator.accountId==="two");
  assert.equal(state.records.length,1);
  assert.equal(state.records[0].messageId,2);
});

test("an unreadable message in a bulk move does not prevent other verified location updates",async()=>{
  const first=mail(1),second=mail(3);first.folder.id="inbox";second.folder.id="inbox";
  const folder={id:"child",accountId:"one",path:"/Inbox/Child"};
  const movedFirst={...first,id:2,folder},movedSecond={...second,id:4,folder};
  const digest=await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello"));
  const records=[first,second].map(message=>({key:"old-"+message.id,status:"incomplete",sha256:digest,locator:locator(message),signatures:[]}));
  const h=await harness({direct:true,mails:[first,second,movedFirst,movedSecond],saved:{records}});
  const raw=h.api.messages.getRaw;
  h.api.messages.getRaw=(id,options)=>{if(id===2)throw new Error("synthetic offline body");return raw(id,options);};
  h.events.moved.listeners[0]({messages:[first,second]},{messages:[movedFirst,movedSecond]});
  const state=await settle(h,s=>s.records.find(record=>record.key==="old-3").messageId===4);
  assert.equal(state.records.find(record=>record.key==="old-1").locator.folder.path,"/Inbox");
  assert.equal(state.records.find(record=>record.key==="old-3").locator.folder.path,folder.path);
});


test("concurrent settings changes survive an earlier failed save without publishing pending values", async () => {
  const h = await harness({mails:[mail(1)],saved:{settings:{enabled:true,accountIds:["one"],notifications:false}}});
  const initial = structuredClone((await h.send("state")).settings);
  const write = h.api.storage.local.set;
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let first = true;
  h.api.storage.local.set = async value => {
    if (first) { first = false; entered(); await gate; throw new Error("synthetic first settings failure"); }
    return write(value);
  };
  const a = h.send("settings",{settings:{enabled:true,accountIds:["one"],notifications:true}});
  await started;
  const b = h.send("settings",{settings:{enabled:false,accountIds:[],notifications:true}});
  assert.deepEqual((await h.send("state")).settings,initial);
  const health = h.send("health"); // Also queues an ordinary persistence snapshot.
  release();
  assert.equal((await a).ok,false);
  assert.equal((await b).ok,true);
  await health;
  const state = await h.send("state");
  assert.equal(state.settings.enabled,false);
  assert.deepEqual(h.stored().settings,state.settings);
  const writes = h.storageCounts.writes;
  h.events.newMail.listeners[0](mail(1).folder,{messages:[mail(1)]});
  await settle(h,()=>h.storageCounts.writes>writes);
  assert.equal((await h.send("state")).records.length,0);
  assert.deepEqual(h.stored().settings,state.settings);
});

test("history snapshots queued during a settings commit cannot restore old configuration",async()=>{
  const h=await harness();
  const write=h.api.storage.local.set;
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  let first=true;
  h.api.storage.local.set=async value=>{if(first){first=false;entered();await gate;}return write(value);};
  const saving=h.send("settings",{settings:{enabled:true,accountIds:["one"],notifications:true}});
  await started;
  const health=h.send("health");
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await h.send("state")).settings.enabled,false);
  release();
  assert.equal((await saving).ok,true);
  await health;
  assert.deepEqual(h.stored().settings,(await h.send("state")).settings);
  assert.equal(h.stored().settings.enabled,true);
});

for (const inFlight of [false,true]) test(`incoming notification before move merges ${inFlight?"in-flight":"completed"} scan and preserves matching human review`,async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const {h,original,moved}=await moveFixture({reviewed:true,scanGate:inFlight?()=>gate:null,
    scanResult:{status:"incomplete",detail:"synthetic encrypted part"}});
  h.events.newMail.listeners[0](moved.folder,{messages:[moved]});
  await settle(h,s=>s.records.length===2&&s.records[1].status===(inFlight?"scanning":"incomplete"));
  h.events.moved.listeners[0]({messages:[original]},{messages:[moved]});
  await settle(h,s=>s.records[0].messageId===2);
  release();
  const state=await settle(h,s=>s.records.length===1&&s.records[0].status==="incomplete");
  assert.equal(state.records[0].key,"ordinary");
  assert.equal(state.records[0].review.note,"keep human judgment");
  assert.equal(h.stored().records.length,1);
});

test("reverse move notifications retain the newer threat verdict",async()=>{
  const {h,original,moved}=await moveFixture({scanResult:{status:"detected",detail:"new threat",signatures:["Synthetic.Threat"]}});
  h.events.newMail.listeners[0](moved.folder,{messages:[moved]});
  await settle(h,s=>s.records[1]?.status==="detected");
  h.events.moved.listeners[0]({messages:[original]},{messages:[moved]});
  const state=await settle(h,s=>s.records.length===1);
  assert.equal(state.records[0].key,"ordinary");
  assert.equal(state.records[0].status,"detected");
  assert.deepEqual(state.records[0].signatures,["Synthetic.Threat"]);
});

test("move reconciliation keeps conflicting human judgments instead of deleting them",async()=>{
  const {h,original,moved}=await moveFixture({reviewed:true,scanResult:{status:"detected",signatures:["Synthetic.Threat"]}});
  h.events.newMail.listeners[0](moved.folder,{messages:[moved]});
  await settle(h,s=>s.records[1]?.status==="detected");
  h.events.moved.listeners[0]({messages:[original]},{messages:[moved]});
  const state=await settle(h,s=>s.records[0].messageId===2);
  assert.equal(state.records.length,2);
  assert.equal(state.records[0].review.note,"keep human judgment");
  assert.equal(state.records[1].status,"detected");
});


test("reverse move notifications never merge changed contents",async()=>{
  const {h,original,moved}=await moveFixture({changed:true});
  h.events.newMail.listeners[0](moved.folder,{messages:[moved]});
  await settle(h,s=>s.records[1]?.status==="clean");
  const writes=h.storageCounts.writes;
  h.events.moved.listeners[0]({messages:[original]},{messages:[moved]});
  h.events.newMail.listeners[0](moved.folder,{messages:[]});
  const state=await settle(h,()=>h.storageCounts.writes>writes);
  assert.equal(state.records.length,2);
  assert.equal(state.records[0].locator.folder.path,original.folder.path);
});

test("a separately acknowledged destination history is never discarded by a later move event",async()=>{
  const {h,original,moved}=await moveFixture({reviewed:true,scanResult:{status:"incomplete",detail:"synthetic encrypted part"}});
  h.events.newMail.listeners[0](moved.folder,{messages:[moved]});
  let state=await settle(h,s=>s.records[1]?.status==="incomplete");
  const duplicate=state.records[1];
  const {reviewStamp}=await import("../thunderbird/review.mjs");
  assert.equal((await h.send("reviewMany",{keys:[duplicate.key],reviewed:true,note:"independent human decision",stamps:{[duplicate.key]:reviewStamp(duplicate)}})).ok,true);
  h.events.moved.listeners[0]({messages:[original]},{messages:[moved]});
  state=await settle(h,s=>s.records[0].messageId===2);
  assert.equal(state.records.length,2);
  assert.equal(state.records[0].review.note,"keep human judgment");
  assert.equal(state.records[1].review.note,"independent human decision");
});

test("committed account exclusions survive restart before another history save",async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const mails=[mail(1),mail(2)];
  const records=mails.map(message=>({key:"queued-"+message.id,source:"automatic",status:"queued",attempts:0,locator:locator(message)}));
  const h=await harness({mails,saved:{records,settings:{enabled:true,accountIds:["one"],notifications:false}},scanGate:()=>gate});
  await settle(h,s=>s.records[0].status==="scanning"&&h.rawReads.length===1);
  assert.equal((await h.send("settings",{settings:{enabled:false,accountIds:[],notifications:false}})).ok,true);
  assert.equal((await h.send("state")).records[1].unscannedReason,"automaticExcluded");
  const restarted=await harness({mails,saved:h.stored()});
  const restored=await restarted.send("state");
  assert.equal(restored.settings.enabled,false);
  assert.equal(restored.records.find(record=>record.key==="queued-2").unscannedReason,"automaticExcluded");
  assert.equal(restarted.rawReads.length,0);
  release();
  await settle(h,s=>s.records[0].status==="clean");
});


for(const method of ["managed","manual"]) test(`${method} helper removal waits for an in-flight settings commit`,async()=>{
  const h=await harness();
  installAdminMock(h);
  const write=h.api.storage.local.set;
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  let first=true;
  h.api.storage.local.set=async value=>{if(first){first=false;entered();await gate;}return write(value);};
  const saving=h.send("settings",{settings:{enabled:true,accountIds:["one"],notifications:false}});
  await started;
  const removal=method==="manual"?h.send("helperMarkRemoved",{acknowledged:true}):
    (async()=>{const plan=await h.send("helperPlan",{operation:"uninstall"});assert.equal(plan.ok,true);return h.send("helperApply",{token:plan.plan.token});})();
  await new Promise(resolve=>setImmediate(resolve));
  release();
  assert.equal((await saving).ok,true);
  assert.equal((await removal).ok,true);
  const state=await h.send("state");
  assert.equal(state.helperRemoved,true);
  assert.equal(state.settings.enabled,false);
  assert.deepEqual(h.stored().settings,state.settings);
});


test("move reconciliation cannot suppress a newly activated automatic quarantine",async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const {h,original,moved}=await moveFixture({scanGate:()=>gate,scanResult:{status:"detected",signatures:["Synthetic.Threat"]},
    quarantine:{one:{folderId:"missing",path:"/Isolation",auto:true}}});
  h.api.permissions.contains=async()=>true;
  h.events.newMail.listeners[0](moved.folder,{messages:[moved]});
  await settle(h,s=>s.records[1]?.status==="scanning");
  h.events.moved.listeners[0]({messages:[original]},{messages:[moved]});
  await settle(h,s=>s.records[0].messageId===2);
  release();
  const state=await settle(h,s=>s.records[1]?.quarantine?.status==="error");
  assert.equal(state.records.length,2);
  assert.equal(state.records[1].status,"detected");
  assert.match(state.records[1].quarantine.detail,/隔離先/);
});


test("slow move verification does not block unrelated incoming mail",async()=>{
  const original=mail(1), moved={...original,id:2,folder:{id:"child",accountId:"one",path:"/Inbox/Child"}}, fresh=mail(3);
  const digest=await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello"));
  const h=await harness({direct:true,mails:[original,moved,fresh],saved:{records:[{key:"moving",status:"incomplete",sha256:digest,locator:locator(original)}],settings:{enabled:true,accountIds:["one"],notifications:false}}});
  const raw=h.api.messages.getRaw;
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  h.api.messages.getRaw=async(id,options)=>{if(id===2){entered();await gate;}return raw(id,options);};
  const moving=h.events.moved.listeners[0]({messages:[original]},{messages:[moved]});
  await started;
  h.events.newMail.listeners[0](fresh.folder,{messages:[fresh]});
  const state=await settle(h,s=>s.records.some(record=>record.messageId===3&&record.status==="clean"));
  assert.equal(state.records.find(record=>record.key==="moving").locator.folder.path,"/Inbox");
  release();await moving;
  assert.equal((await h.send("state")).records.find(record=>record.key==="moving").messageId,2);
});

test("incremental storage survives an actual raw-format restart with human notes",async()=>{
  const message=mail(1);
  const digest=await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello"));
  const saved={directMigrationBackup:{notNeeded:true},records:[{key:"kept",status:"incomplete",locator:locator(message),sha256:digest,review:{note:"human decision"}}]};
  const h=await harness({direct:true,saved,mails:[message]});
  assert.equal(h.rawStored().records.format,2);
  assert.equal(h.migrationBackups.length,1);
  assert.equal(h.migrationBackups[0].records[0].review.note,"human decision");
  const next=await harness({direct:true,saved:h.rawStored(),mails:[message]});
  assert.equal((await next.send("state")).records[0].review.note,"human decision");
  assert.equal(next.migrationBackups.length,0);
});


test("format migration backup failure preserves the original storage until explicit recovery",async()=>{
  const saved={directMigrationBackup:{notNeeded:true},records:[{key:"human",status:"clean",locator:{accountId:"one"},review:{note:"preserve latest decision"}}]};
  const h=await harness({direct:true,saved,backupFailure:true});
  assert.equal((await h.send("state")).startupFailed,true);
  assert.deepEqual(h.rawStored(),saved);
  assert.equal(h.storageCounts.writes,0);
  h.api.clamDirect.backup=async()=>({path:"/synthetic/recovery-backup.json"});
  assert.equal((await h.send("health")).ok,true);
  assert.equal(h.rawStored().records.format,2);
  assert.equal((await h.send("state")).records[0].review.note,"preserve latest decision");
});


test("a rescan completed during delayed move verification cannot be replaced by an older clean result",async()=>{
  const original=mail(1),moved={...original,id:2,folder:{id:"child",accountId:"one",path:"/Inbox/Child"}};
  let scans=0,releaseScan;
  const scanGate=new Promise(resolve=>{releaseScan=resolve;});
  const h=await harness({direct:true,mails:[original,moved],saved:{settings:{enabled:true,accountIds:["one"],notifications:false}},
    scanGate:()=>{scans++;return scans===3?scanGate:undefined;},
    scanResult:()=>scans===1?{status:"incomplete"}:scans===3?{status:"detected",signatures:["Synthetic.NewVerdict"]}:{}});
  h.events.newMail.listeners[0](original.folder,{messages:[original]});
  let state=await settle(h,s=>s.records[0]?.status==="incomplete");
  const key=state.records[0].key;
  h.events.newMail.listeners[0](moved.folder,{messages:[moved]});
  await settle(h,s=>s.records[1]?.status==="clean");
  await h.send("retry",{key});
  await settle(h,s=>s.records[0].status==="scanning"&&scans===3);
  const raw=h.api.messages.getRaw;
  let releaseMove,entered;
  const moveGate=new Promise(resolve=>{releaseMove=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  h.api.messages.getRaw=async(id,options)=>{if(id===2){entered();await moveGate;}return raw(id,options);};
  const moving=h.events.moved.listeners[0]({messages:[original]},{messages:[moved]});
  await started;
  releaseScan();
  await settle(h,s=>s.records[0].status==="detected");
  releaseMove();await moving;
  state=await h.send("state");
  assert.equal(state.records.length,1);
  assert.equal(state.records[0].key,key);
  assert.equal(state.records[0].status,"detected");
  assert.deepEqual(state.records[0].signatures,["Synthetic.NewVerdict"]);
});

test("paged folder checkpoints resume from raw storage without rescanning completed mail",async()=>{
  const original=mail(1),fresh=mail(2);original.folder.id="inbox";fresh.folder.id="inbox";
  const digest=await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello"));
  const {checkpointHint}=await import("../thunderbird/folder-scan.mjs");
  const saved={records:[{key:"kept",status:"incomplete",locator:locator(original),sha256:digest,review:{note:"keep judgment"}}],
    folderJob:{id:"resumable",folder:original.folder,folders:[original.folder],status:"stopped",includeSubfolders:false,completed:1,total:2,scanning:0,counts:{clean:0,detected:0,incomplete:1,error:0}},
    folderCheckpoint:{version:1,id:"resumable",entries:[[await checkpointHint(locator(original))+":"+digest,1]]}};
  const h=await harness({direct:true,saved,mails:[original,fresh]});
  assert.equal(h.rawStored().folderCheckpoint.version,2);
  const next=await harness({direct:true,saved:h.rawStored(),mails:[original,fresh]});
  assert.equal((await next.send("folderResume",{jobId:"resumable"})).ok,true);
  const state=await settle(next,s=>s.folderJob?.status==="completed");
  assert.equal(state.folderJob.resumedMatched,1);
  assert.equal(state.folderJob.completed,2);
  assert.equal(next.directRequests.filter(request=>request.op==="end").length,1);
  assert.equal(state.records.find(record=>record.key==="kept").review.note,"keep judgment");
});

test("ambiguous bulk move candidates are read once per event and remain unmerged",async()=>{
  const first=mail(1),second={...mail(1),id:3,folder:{accountId:"one",path:"/Other"}};
  const folder={id:"child",accountId:"one",path:"/Inbox/Child"};
  const destinations=[{...first,id:2,folder},{...second,id:4,folder}];
  const digest=await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello"));
  const records=[first,second].map(message=>({key:"old-"+message.id,status:"clean",sha256:digest,locator:locator(message)}));
  const h=await harness({direct:true,mails:[first,second,...destinations],saved:{records}});
  await h.events.moved.listeners[0]({messages:[first,second]},{messages:destinations});
  assert.deepEqual(h.rawReads,[2,4]);
  const state=await h.send("state");
  assert.equal(state.records.length,2);
  assert.deepEqual(state.records.map(record=>record.locator.folder.path),["/Inbox","/Other"]);
});


async function rescanResultDuringMove(status) {
  const original=mail(1),moved={...original,id:2,folder:{id:"child",accountId:"one",path:"/Inbox/Child"}};
  let scans=0,releaseScan;
  const scanGate=new Promise(resolve=>{releaseScan=resolve;});
  const h=await harness({direct:true,mails:[original,moved],saved:{settings:{enabled:true,accountIds:["one"],notifications:false}},
    scanGate:()=>{scans++;return scans===3?scanGate:undefined;},
    scanResult:()=>scans===1?{status:"incomplete"}:scans===3?{status,detail:"synthetic retry result"}:{status:"detected",signatures:["Synthetic.PreviousVerdict"]}});
  h.events.newMail.listeners[0](original.folder,{messages:[original]});
  let state=await settle(h,s=>s.records[0]?.status==="incomplete");
  const key=state.records[0].key;
  h.events.newMail.listeners[0](moved.folder,{messages:[moved]});
  await settle(h,s=>s.records[1]?.status==="detected");
  await h.send("retry",{key});
  await settle(h,s=>s.records[0].status==="scanning"&&scans===3);
  const raw=h.api.messages.getRaw;
  let releaseMove,entered;
  const moveGate=new Promise(resolve=>{releaseMove=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  h.api.messages.getRaw=async(id,options)=>{if(id===2){entered();await moveGate;}return raw(id,options);};
  const moving=h.events.moved.listeners[0]({messages:[original]},{messages:[moved]});
  await started;
  releaseScan();
  await settle(h,s=>s.records[0].status===status);
  releaseMove();await moving;
  state=await h.send("state");
  assert.equal(state.records.length,1);
  assert.equal(state.records[0].key,key);
  const expected=status==="clean"?"clean":"detected";
  assert.equal(state.records[0].status,expected);
  assert.deepEqual(state.records[0].signatures,status==="clean"?[]:["Synthetic.PreviousVerdict"]);
  const {canReview}=await import("../thunderbird/review.mjs");
  assert.equal(canReview(state.records[0]),false);
  if(status!=="clean"){
    assert.equal(state.records[0].lastResult.status,"detected");
    assert.equal(state.records[0].lastAttempt.status,status);
    assert.equal(state.records[0].lastAttempt.detail,"synthetic retry result");
  }
  const restarted=await harness({direct:true,saved:h.rawStored(),mails:[original,moved]});
  const restored=(await restarted.send("state")).records[0];
  assert.equal(restored.status,expected);
  if(status!=="clean")assert.equal(restored.lastAttempt.status,status);
}

test("move reconciliation preserves known detections unless the newer error rescan is conclusive",async()=>{await rescanResultDuringMove("error");});

test("move reconciliation preserves known detections unless the newer incomplete rescan is conclusive",async()=>{await rescanResultDuringMove("incomplete");});

test("move reconciliation preserves known detections unless the newer clean rescan is conclusive",async()=>{await rescanResultDuringMove("clean");});


test("invalid or unsupported storage stops before any write and recovers only from valid restored data",async()=>{
  const seed=await harness({direct:true,saved:{records:[{key:"human",status:"clean",locator:{accountId:"one"},review:{note:"preserve latest decision"}}]}});
  const valid=seed.rawStored();
  const changes=[
    raw=>{raw.records.format=99;},raw=>{raw.records.format="2";},raw=>{raw.records=false;},
    raw=>{raw.records=null;},raw=>{raw.records=[];},raw=>{delete raw.records;},
    raw=>{raw.folderCheckpoint={version:99,id:"job",entries:[]};},
    raw=>{raw.folderCheckpoint={version:1,id:"job",entries:null};},
    raw=>{raw["checkpointPage:0"]=[["synthetic",1]];}
  ];
  for(const change of changes){
    const invalid=structuredClone(valid);change(invalid);
    const h=await harness({direct:true,saved:invalid});
    assert.equal((await h.send("state")).startupFailed,true);
    assert.equal((await h.send("health")).startupFailed,true);
    assert.deepEqual(h.rawStored(),invalid);
    assert.equal(h.storageCounts.writes,0);
    assert.equal(h.migrationBackups.length,0);
    assert.equal(h.rawReads.length,0);
    h.api.storage.local.get=async()=>structuredClone(valid);
    assert.equal((await h.send("health")).ok,true);
    assert.equal((await h.send("state")).records[0].review.note,"preserve latest decision");
  }
});


test("new mail outside the history slots is scanned before the next queued manual mail",async()=>{
  const first=mail(1),second=mail(2),fresh=mail(1001);
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const records=Array.from({length:1000},(_,index)=>({key:"history-"+index,source:"manual",status:index<2?"queued":"incomplete",attempts:0,locator:locator(index===0?first:index===1?second:mail(index+10))}));
  const h=await harness({direct:true,mails:[first,second,fresh],saved:{records,settings:{enabled:true,accountIds:["one"],notifications:false}},scanGate:id=>{if(id===1){entered();return gate;}}});
  await started;
  h.events.newMail.listeners[0](fresh.folder,{messages:[fresh]});
  await settle(h,s=>s.overflowPending?.status==="queued");
  release();
  await settle(h,s=>s.records.some(record=>record.messageId===2&&record.status==="clean"));
  assert.deepEqual(h.rawReads,[1,1001,2]);
  assert.equal((await h.send("state")).overflowPending,null);
});

test("failed individual retry cannot run or leak through a concurrent save and restores its badge",async()=>{
  const message=mail(1),digest=await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello"));
  const h=await harness({direct:true,mails:[message],saved:{records:[{key:"keep",status:"detected",source:"folder",attempts:3,folderJobId:"prior",sha256:digest,signatures:["Synthetic.Threat"],locator:locator(message)}]}});
  const before=structuredClone((await h.send("state")).records[0]),write=h.api.storage.local.set,badges=[];
  h.api.browserAction.setBadgeText=async value=>{badges.push(value.text);};
  let release,entered,first=true;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  h.api.storage.local.set=async value=>{if(first){first=false;entered();await gate;throw new Error("synthetic retry save failure");}return write(value);};
  const retry=h.send("retry",{key:"keep"});await started;
  const health=h.send("health");
  h.timers[0]();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.rawReads.length,0);
  release();
  assert.equal((await retry).ok,false);
  assert.equal((await health).ok,true);
  assert.deepEqual((await h.send("state")).records[0],before);
  assert.deepEqual(h.stored().records[0],before);
  assert.equal(badges.at(-1),"1");
  h.timers[0]();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.rawReads.length,0);
  assert.equal((await h.send("retry",{key:"keep"})).ok,true);
  await settle(h,state=>state.records[0].status==="clean");
  assert.equal(h.directRequests.filter(request=>request.op==="end").length,1);
});

test("separate incoming bursts reuse one scanner until its bounded idle expiry",async()=>{
  const mails=[mail(1),mail(2),mail(3)],h=await harness({direct:true,mails,saved:{settings:{enabled:true,accountIds:["one"],notifications:false}}});
  for(const message of mails.slice(0,2)){
    h.events.newMail.listeners[0](message.folder,{messages:[message]});
    await settle(h,s=>s.records.some(record=>record.messageId===message.id&&record.status==="clean")&&h.idleTimers.some(timer=>timer.active));
  }
  assert.equal(h.nativePorts.length,1);
  assert.equal(h.nativePorts[0].disconnected,false);
  h.expireIdle();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.nativePorts[0].disconnected,true);
  h.events.newMail.listeners[0](mails[2].folder,{messages:[mails[2]]});
  await settle(h,s=>s.records.some(record=>record.messageId===3&&record.status==="clean")&&h.idleTimers.some(timer=>timer.active));
  assert.equal(h.nativePorts.length,2);
  h.expireIdle();
});

test("a scanner error discards its connection before inspecting the next message",async()=>{
  let scans=0;
  const mails=[mail(1),mail(2)],h=await harness({direct:true,mails,scanResult:()=>++scans===1?{status:"error",detail:"synthetic engine error"}:{},saved:{settings:{enabled:true,accountIds:["one"],notifications:false}}});
  h.events.newMail.listeners[0](mails[0].folder,{messages:[mails[0]]});
  await settle(h,s=>s.records[0]?.status==="error");
  assert.equal(h.nativePorts[0].disconnected,true);
  h.events.newMail.listeners[0](mails[1].folder,{messages:[mails[1]]});
  await settle(h,s=>s.records[1]?.status==="clean");
  assert.equal(h.nativePorts.length,2);
  h.expireIdle();
});

test("an explicit connection check closes the retained idle scanner",async()=>{
  const message=mail(1),h=await harness({direct:true,mails:[message]});
  await h.send("scanSelection");
  await settle(h,s=>s.records[0]?.status==="clean"&&h.idleTimers.some(timer=>timer.active));
  assert.equal(h.nativePorts[0].disconnected,false);
  assert.equal((await h.send("health")).ok,true);
  assert.equal(h.nativePorts[0].disconnected,true);
  assert.equal(h.idleTimers.some(timer=>timer.active),false);
});


test("idle timer failure closes its connection without blocking a later incoming scan",async()=>{
  const mails=[mail(1),mail(2)],h=await harness({direct:true,mails,saved:{settings:{enabled:true,accountIds:["one"],notifications:false}}});
  h.idleTimers.failNext=true;
  h.events.newMail.listeners[0](mails[0].folder,{messages:[mails[0]]});
  await settle(h,s=>s.records[0]?.status==="clean"&&h.nativePorts[0]?.disconnected===true);
  assert.equal((await h.send("state")).issue,"");
  assert.equal(h.nativePorts[0].disconnected,true);
  h.events.newMail.listeners[0](mails[1].folder,{messages:[mails[1]]});
  await settle(h,s=>s.records[1]?.status==="clean"&&h.idleTimers.some(timer=>timer.active));
  assert.equal(h.nativePorts.length,2);
  h.expireIdle();
});

async function reviewedBulkFixture() {
  const mails=[mail(1),mail(2)],digest=await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello"));
  const {reviewReason}=await import("../thunderbird/review.mjs");
  const records=mails.map((message,index)=>{
    const record={key:"reviewed-"+index,status:"incomplete",source:"folder",attempts:2,nextRetry:null,folderJobId:"previous",detail:"synthetic retained result",sha256:digest,signatures:[],locator:locator(message)};
    record.review={note:"synthetic human decision "+index,reason:reviewReason(record),resultHash:digest,fingerprint:"sha256:"+digest};return record;
  });
  const h=await harness({direct:true,mails,saved:{records,settings:{enabled:false,accountIds:[],notifications:false}}});
  return {h,mails,before:structuredClone((await h.send("state")).records),keys:records.map(record=>record.key)};
}

test("uncommitted bulk retry cannot run or leak through a timer and concurrent save",async()=>{
  const {h,before,keys}=await reviewedBulkFixture(),write=h.api.storage.local.set;
  let release,entered,first=true;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  h.api.storage.local.set=async value=>{if(first){first=false;entered();await gate;throw new Error("synthetic reservation failure");}return write(value);};
  const retry=h.send("retryMany",{keys});await started;
  const health=h.send("health");h.timers[0]();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.rawReads.length,0);
  assert.ok((await h.send("state")).records.every(record=>record.status==="queued"));
  release();assert.equal((await retry).ok,false);assert.equal((await health).ok,true);
  assert.deepEqual((await h.send("state")).records,before);
  assert.deepEqual(h.stored().records,before);
  h.timers[0]();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.rawReads.length,0);
  assert.equal((await h.send("retryMany",{keys})).count,2);
  await settle(h,s=>s.records.every(record=>record.status==="clean")&&!s.batch.active);
  assert.equal(h.directRequests.filter(request=>request.op==="end").length,2);
  h.expireIdle();
});

test("bulk retry reservation can be cancelled without deadlock before its write settles",async()=>{
  const {h,before,keys}=await reviewedBulkFixture(),write=h.api.storage.local.set;
  let release,entered,first=true;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  h.api.storage.local.set=async value=>{if(first){first=false;entered();await gate;}return write(value);};
  const retry=h.send("retryMany",{keys});await started;
  const id=(await h.send("state")).batch.id;let cancelReturned=false;
  const cancelling=h.send("cancelBatch",{id}).then(value=>{cancelReturned=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));const immediate=cancelReturned;
  release();await cancelling;const result=await retry;
  assert.equal(immediate,true);assert.equal(result.cancelled,true);assert.equal(result.count,0);
  const state=await h.send("state");assert.equal(state.batch.active,false);assert.equal(state.batch.cancelled,2);
  assert.deepEqual(state.records,before);assert.deepEqual(h.stored().records,before);
  assert.equal(h.rawReads.length,0);
});

test("failed cancellation persistence still restores unstarted bulk work after restart",async()=>{
  const {h,before,keys,mails}=await reviewedBulkFixture(),write=h.api.storage.local.set;
  let release,entered,calls=0;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  h.api.storage.local.set=async value=>{calls++;if(calls===1){entered();await gate;}if(calls===2)throw new Error("synthetic cancellation save failure");return write(value);};
  const retry=h.send("retryMany",{keys});await started;
  await h.send("cancelBatch",{id:(await h.send("state")).batch.id});release();
  assert.equal((await retry).ok,false);
  assert.deepEqual((await h.send("state")).records,before);assert.equal(h.rawReads.length,0);
  const next=await harness({direct:true,mails,saved:h.rawStored()});
  assert.deepEqual((await next.send("state")).records,before);
  assert.equal(next.rawReads.length,0);
});

for(const reason of ["size","headers","read"]) test(`mail preflight ${reason} failure does not restart a healthy scanner`,async()=>{
  const mails=[mail(1),mail(2),mail(3)];if(reason==="headers")mails[1].headersOnly=true;
  const h=await harness({direct:true,mails}),getRaw=h.api.messages.getRaw;
  h.api.messages.getRaw=(id,options)=>{
    if(id===2&&reason==="size")return {size:26*1024*1024,arrayBuffer(){throw new Error("must not allocate oversized mail");}};
    if(id===2&&reason==="read")throw new Error("synthetic body unavailable");
    return getRaw(id,options);
  };
  await h.send("scanSelection");
  const state=await settle(h,s=>s.records.length===3&&s.records.every(record=>!["queued","scanning"].includes(record.status))&&h.idleTimers.some(timer=>timer.active));
  assert.deepEqual(state.records.map(record=>record.status),["clean",reason==="size"?"incomplete":"error","clean"]);
  assert.equal(h.nativePorts.length,1);
  assert.equal(h.directRequests.filter(request=>request.op==="end").length,2);
  h.expireIdle();
});

for (const fail of [false, true]) test(`history removal publishes only after saving, preserves concurrent additions (failure=${fail})`, async () => {
  const target = { key: "forget", status: "incomplete", detail: "original", locator: locator(mail(1)), review: { note: "human judgment" } };
  const h = await harness({ saved: { records: [target] } });
  const before = structuredClone((await h.send("state")).records);
  const ticket = await h.send("prepareForget", { keys: [target.key] });
  const original = h.api.storage.local.set;
  let release, entered, held = false;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  h.api.storage.local.set = async value => {
    if (!held) { held = true; entered(); await gate; if (fail) throw new Error("synthetic history save failure"); }
    return original(value);
  };
  const removal = h.send("forgetMany", { token: ticket.token });
  await started;
  assert.deepEqual((await h.send("state")).records, before);
  assert.deepEqual(h.stored().records, before);
  // Simulate another operation appending a result while its save is deferred.
  const added = { key: "new-result", status: "error", locator: locator(mail(2)) };
  (await h.send("state")).records.push(added);
  const concurrentSave = h.send("health");
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.equal((await removal).ok, !fail);
  assert.equal((await concurrentSave).ok, true);
  const expected = fail ? [...before, added] : [added];
  assert.deepEqual((await h.send("state")).records, expected);
  assert.deepEqual(h.stored().records, expected);
  const next = await harness({ saved: h.rawStored() });
  assert.deepEqual((await next.send("state")).records, expected.map(record => ({ ...record, session: null, messageId: null })));
  assert.equal(h.deleted.length, 0);
});

for (const onlyLockedSlot of [false, true]) test(`folder rotation protects deletion locks (only locked slot=${onlyLockedSlot})`, async () => {
  const message = mail(1), hash = await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello"));
  const records = Array.from({ length: 1000 }, (_, i) => ({ key: i ? "other" + i : "target", status: i && onlyLockedSlot ? "detected" : "clean", source: "manual", attempts: 1,
    locator: i ? { ...locator(message), headerMessageId: "other" + i } : locator(message), sha256: hash }));
  const h = await harness({ saved: { records }, mails: [message], deleteAllowed: true });
  const ticket = await h.send("prepareDelete", { key: "target" });
  assert.equal(ticket.ok, true);
  let release, entered, held = false;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const original = h.api.messages.getRaw;
  h.api.messages.getRaw = async (...args) => { if (!held) { held = true; entered(); await gate; } return original(...args); };
  const removal = h.send("deletePermanently", { key: "target", token: ticket.token });
  await started;
  await startFolder(h);
  const state = await settledFolder(h, onlyLockedSlot ? "blocked" : "completed");
  assert.equal(state.records.length, 1000);
  assert.equal(state.folderJob.completed, onlyLockedSlot ? 0 : 1);
  assert.equal(state.records.some(record => record.key === "target"), true);
  assert.equal(state.records.some(record => record.key === "other1"), onlyLockedSlot);
  release();
  assert.equal((await removal).ok, true);
  assert.deepEqual(h.deleted.map(entry => entry.ids), [[1]]);
  assert.equal(h.stored().records.find(record => record.key === "target").status, "deleted");
});

test("automatic retry timer cannot change a history entry while removal is saving", async () => {
  const record = { key: "retry-due", source: "manual", status: "error", attempts: 1, nextRetry: Date.now() + 60000, locator: locator(mail(1)) };
  const h = await harness({ saved: { records: [record] }, mails: [mail(1)] });
  const ticket = await h.send("prepareForget", { keys: [record.key] });
  const before = structuredClone((await h.send("state")).records);
  const original = h.api.storage.local.set;
  let release, entered, held = false;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  h.api.storage.local.set = async value => {
    if (!held) { held = true; entered(); await gate; throw new Error("synthetic history save failure"); }
    return original(value);
  };
  const removal = h.send("forgetMany", { token: ticket.token });
  await started;
  const now = Date.now;
  Date.now = () => now() + 120000;
  try { await h.timers[0](); await new Promise(resolve => setImmediate(resolve)); }
  finally { Date.now = now; }
  assert.deepEqual((await h.send("state")).records, before);
  assert.equal(h.rawReads.length, 0);
  release();
  assert.equal((await removal).ok, false);
  await h.send("health");
  assert.deepEqual(h.stored().records, before);
});

for (const reviewed of [true, false]) for (const fail of [true, false]) test(`review commit cannot leak through concurrent health save (reviewed=${reviewed}, failure=${fail})`, async () => {
  const { reviewStamp, reviewReason } = await import("../thunderbird/review.mjs");
  const record = { key: "review-gate", status: "incomplete", detail: "encrypted", sha256: "digest", locator: locator(mail(1)) };
  if (!reviewed) record.review = { note: "existing human note", reason: reviewReason(record), resultHash: record.sha256, fingerprint: "sha256:digest" };
  const h = await harness({ saved: { records: [record] } });
  const before = structuredClone((await h.send("state")).records);
  const original = h.api.storage.local.set;
  let release, entered, held = false;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  h.api.storage.local.set = async value => {
    if (!held) { held = true; entered(); await gate; if (fail) throw new Error("synthetic review save failure"); }
    return original(value);
  };
  const change = h.send("reviewMany", { keys: [record.key], reviewed, note: "new human note", stamps: { [record.key]: reviewStamp(before[0]) } });
  await started;
  const health = h.send("health");
  await h.timers[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.stored().records, before);
  release();
  assert.equal((await change).ok, !fail);
  assert.equal((await health).ok, true);
  const after = (await h.send("state")).records;
  if (fail) assert.deepEqual(after, before);
  else assert.equal(Boolean(after[0].review), reviewed);
  assert.deepEqual(h.stored().records, after);
  const next = await harness({ saved: h.rawStored() });
  assert.deepEqual((await next.send("state")).records, after);
  assert.equal(h.rawReads.length, 0);
});

for (const kind of ["new", "existing", "eviction", "overflow"]) for (const fail of [true, false]) test(`manual scan starts only after reservation commit (${kind}, failure=${fail})`, async () => {
  const saved = ["eviction", "overflow"].includes(kind) ? { records: Array.from({ length: 1000 }, (_, i) => ({ key: "old-" + i,
    status: kind === "eviction" ? "clean" : "detected", locator: { subject: "old " + i } })) } : {};
  const h = await harness({ saved, mails: [mail(1)], scanResult: { status: "incomplete", detail: "encrypted" } });
  if (kind === "existing") {
    await h.send("scanSelection");
    const state = await settle(h, state => state.records[0]?.status === "incomplete");
    const { reviewStamp } = await import("../thunderbird/review.mjs");
    assert.equal((await h.send("reviewMany", { keys: [state.records[0].key], reviewed: true, note: "prior decision", stamps: { [state.records[0].key]: reviewStamp(state.records[0]) } })).ok, true);
  }
  const before = structuredClone((await h.send("state")).records), readsBefore = h.rawReads.length;
  const original = h.api.storage.local.set;
  let release, entered, held = false;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  h.api.storage.local.set = async value => {
    if (!held) { held = true; entered(); await gate; if (fail) throw new Error("synthetic manual reservation failure"); }
    return original(value);
  };
  const scan = h.send("scanSelection");
  await started;
  const health = h.send("health");
  await h.timers[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await h.send("state")).records, before);
  assert.deepEqual(h.stored().records, before);
  assert.equal(h.rawReads.length, readsBefore);
  release();
  assert.equal((await scan).ok, !fail);
  assert.equal((await health).ok, true);
  if (fail) {
    assert.deepEqual((await h.send("state")).records, before);
    assert.deepEqual(h.stored().records, before);
    assert.equal(h.stored().overflowPending, null);
    assert.equal(h.rawReads.length, readsBefore);
    const next = await harness({ saved: h.rawStored(), mails: [mail(1)] });
    assert.equal(next.rawReads.length, 0);
    assert.deepEqual((await next.send("state")).records, before.map(record => ({ ...record, session: null, messageId: null })));
  } else {
    await settle(h, state => kind === "overflow" ? state.overflowReport?.total === 1 : state.records.some(record => record.locator.headerMessageId === mail(1).headerMessageId && record.status === "incomplete"));
    assert.equal(h.rawReads.length, readsBefore + 1);
  }
});

for (const mode of ["normal", "failed-receipt", "disabled"]) test(`incoming overflow receipts preempt remaining manual selection (${mode})`, async () => {
  const mails = [mail(1), mail(2), mail(3), mail(4)];
  const records = Array.from({ length: 1000 }, (_, i) => ({ key: "protected-" + i, status: "detected", sha256: "saved-digest", locator: { subject: "protected " + i } }));
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const h = await harness({ mails, saved: { records, settings: { enabled: true, accountIds: ["one"], notifications: false } },
    scanGate: async id => { if (id === 1) { entered(); await gate; } } });
  h.api.mailTabs.getSelectedMessages = async () => ({ messages: mails.slice(0, 2) });
  const before = structuredClone((await h.send("state")).records);
  const original = h.api.storage.local.set;
  let failed = false;
  if (mode === "failed-receipt") h.api.storage.local.set = async value => {
    if (!failed && value.overflowPending?.messageId === 3 && value.overflowPending.status === "queued") {
      failed = true; throw new Error("synthetic incoming reservation failure");
    }
    return original(value);
  };
  const manual = h.send("scanSelection");
  await started;
  h.events.newMail.listeners[0](mails[2].folder, { messages: [mails[2]] });
  h.events.newMail.listeners[0](mails[3].folder, { messages: [mails[3]] });
  await new Promise(resolve => setImmediate(resolve));
  if (mode === "disabled") assert.equal((await h.send("settings", { settings: { enabled: false, accountIds: [], notifications: false } })).ok, true);
  release();
  assert.equal((await manual).ok, true);
  const expected = mode === "normal" ? [1, 3, 4, 2] : mode === "failed-receipt" ? [1, 4, 2] : [1, 2];
  await settle(h, state => state.overflowReport?.total === expected.length && !state.overflowPending);
  assert.deepEqual(h.rawReads, expected);
  assert.deepEqual((await h.send("state")).records, before);
  assert.deepEqual(h.stored().records, before);
  if (mode === "failed-receipt") assert.equal(failed, true);
});

for (const overflow of [false, true]) test(`incoming admission preserves shared commit protection (overflow=${overflow})`, async () => {
  const records = overflow ? Array.from({ length: 1000 }, (_, i) => ({ key: "protected-" + i, status: "detected", locator: { subject: "protected " + i } })) : [];
  const h = await harness({ mails: [mail(1)], saved: { records, settings: { enabled: true, accountIds: ["one"], notifications: false } } });
  const before = structuredClone((await h.send("state")).records), original = h.api.storage.local.set;
  let release, entered, held = false;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  h.api.storage.local.set = async value => {
    if (!held) { held = true; entered(); await gate; throw new Error("synthetic incoming commit failure"); }
    return original(value);
  };
  h.events.newMail.listeners[0](mail(1).folder, { messages: [mail(1)] });
  await started;
  const health = h.send("health");
  await h.timers[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await h.send("state")).records, before);
  assert.equal(h.rawReads.length, 0);
  release();
  assert.equal((await health).ok, true);
  await settle(h, state => state.issue.includes("synthetic incoming commit failure"));
  assert.deepEqual(h.stored().records, before);
  assert.equal(h.stored().overflowPending, null);
  assert.equal(h.rawReads.length, 0);
  // A failed receipt must release its priority claim and allow manual work.
  assert.equal((await h.send("scanSelection")).ok, true);
  await settle(h, state => overflow ? state.overflowReport?.total === 1 : state.records[0]?.status === "clean");
  assert.deepEqual(h.rawReads, [1]);
  await h.timers[0]();
  await settle(h, state => !state.issue);
  assert.deepEqual(h.rawReads, [1]); // Manual acceptance also retires the failed delivery.
});

for (const overflow of [false, true]) for (const duplicate of [false, true]) test(`failed incoming page resumes without loss or duplicates (overflow=${overflow}, duplicate=${duplicate})`, async () => {
  const mails = [mail(101), mail(102), mail(103), mail(104)];
  const records = overflow ? Array.from({ length: 1000 }, (_, i) => ({ key: "held-" + i, status: "detected", locator: { subject: "held " + i } })) : [];
  const h = await harness({ mails, saved: { records, settings: { enabled: true, accountIds: ["one"], notifications: false } } });
  const before = structuredClone((await h.send("state")).records), original = h.api.storage.local.set;
  let failed = false, continued = 0, aborted = 0;
  h.api.messages.continueList = async id => { assert.equal(id, "pending-page"); continued++; return { messages: mails.slice(1, 3) }; };
  h.api.messages.abortList = async () => { aborted++; };
  h.api.storage.local.set = async value => { if (!failed) { failed = true; throw new Error("synthetic incoming page save failure"); } return original(value); };
  h.events.newMail.listeners[0](mails[0].folder, { id: "pending-page", messages: [mails[0]] });
  await settle(h, state => state.issue.includes("synthetic incoming page save failure"));
  assert.equal(continued, 0); assert.equal(aborted, 0); assert.equal(h.rawReads.length, 0);
  h.events.newMail.listeners[0](mails[3].folder, { messages: duplicate ? [mails[3], mails[0]] : [mails[3]] });
  await settle(h, state => overflow ? state.overflowReport?.total === (duplicate ? 2 : 1) : state.records.filter(record => record.status === "clean").length === (duplicate ? 2 : 1));
  await h.timers[0]();
  const state = await settle(h, state => !state.issue && (overflow ? state.overflowReport?.total === 4 : state.records.length === 4 && state.records.every(record => record.status === "clean")));
  assert.deepEqual(h.rawReads, [104, 101, 102, 103]);
  assert.equal(continued, 1); assert.equal(aborted, 0);
  if (overflow) assert.deepEqual(state.records, before);
  await h.timers[0](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.rawReads.length, 4);
});

test("persistent admission failures retry once per tick and rotate fairly without blocking new mail", async () => {
  const mails = [mail(201), mail(202), mail(203)];
  const h = await harness({ mails, saved: { settings: { enabled: true, accountIds: ["one"], notifications: false } } });
  const original = h.api.storage.local.set; let failures = 0;
  h.api.storage.local.set = async () => { failures++; throw new Error("persistent synthetic receipt failure " + failures); };
  h.events.newMail.listeners[0](mails[0].folder, { messages: [mails[0]] });
  h.events.newMail.listeners[0](mails[1].folder, { messages: [mails[1]] });
  await settle(h, state => state.issue.includes("failure 2"));
  for (const count of [3, 4]) {
    await h.timers[0]();
    // Each tick schedules one retained receipt, rotating after a failure.
    await settle(h, state => state.issue.includes("failure " + count));
    assert.equal(failures, count);
  }
  assert.equal(h.rawReads.length, 0);
  h.api.storage.local.set = original;
  h.events.newMail.listeners[0](mails[2].folder, { messages: [mails[2]] });
  await settle(h, state => state.records.some(record => record.messageId === 203 && record.status === "clean"));
  await h.timers[0]();
  await settle(h, state => state.records.some(record => record.messageId === 201 && record.status === "clean"));
  await h.timers[0]();
  await settle(h, state => !state.issue && state.records.length === 3 && state.records.every(record => record.status === "clean"));
  assert.deepEqual(h.rawReads, [203, 201, 202]);
});

test("disabled accounts retire retained incoming pages without inspecting their mail", async () => {
  const mails = [mail(301), mail(302)];
  const h = await harness({ mails, saved: { settings: { enabled: true, accountIds: ["one"], notifications: false } } });
  const original = h.api.storage.local.set; let failed = false;
  h.api.storage.local.set = async value => { if (!failed) { failed = true; throw new Error("synthetic paused receipt failure"); } return original(value); };
  h.events.newMail.listeners[0](mails[0].folder, { messages: mails });
  await settle(h, state => state.issue.includes("synthetic paused receipt failure"));
  assert.equal((await h.send("settings", { settings: { enabled: false, accountIds: [], notifications: false } })).ok, true);
  await h.timers[0]();
  await settle(h, state => !state.issue);
  assert.deepEqual(h.rawReads, []); assert.deepEqual(h.stored().records, []);
});

test("repeated ticks cannot duplicate a retained receipt while its retry is saving", async () => {
  const message = mail(401), h = await harness({ mails: [message], saved: { settings: { enabled: true, accountIds: ["one"], notifications: false } } });
  const original = h.api.storage.local.set; let failed = false;
  h.api.storage.local.set = async value => { if (!failed) { failed = true; throw new Error("synthetic initial receipt failure"); } return original(value); };
  h.events.newMail.listeners[0](message.folder, { messages: [message] });
  await settle(h, state => state.issue.includes("synthetic initial receipt failure"));
  let release, entered, writes = 0;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  h.api.storage.local.set = async value => { if (++writes === 1) { entered(); await gate; } return original(value); };
  await h.timers[0](); await started;
  await h.timers[0](); await h.timers[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 1); assert.equal(h.rawReads.length, 0);
  release();
  await settle(h, state => !state.issue && state.records[0]?.status === "clean");
  assert.deepEqual(h.rawReads, [401]);
});

test("receipt recovery clears only its own warning and preserves unrelated failures", async () => {
  const mails = [mail(501), mail(502)];
  const h = await harness({ mails, scanResult: { status: "incomplete", detail: "encrypted" }, saved: { settings: { enabled: true, accountIds: ["one"], notifications: true } } });
  const original = h.api.storage.local.set; let failed = false;
  h.api.storage.local.set = async value => { if (!failed) { failed = true; throw new Error("synthetic warning preservation failure"); } return original(value); };
  h.events.newMail.listeners[0](mails[0].folder, { messages: [mails[0]] });
  await settle(h, state => state.issue.includes("synthetic warning preservation failure"));
  h.api.notifications.create = async () => { throw new Error("notification unavailable"); };
  h.events.newMail.listeners[0](mails[1].folder, { messages: [mails[1]] });
  const before = await settle(h, state => state.issue.includes("デスクトップ通知を表示できません"));
  await h.timers[0]();
  const after = await settle(h, state => state.records.length === 2 && state.records.every(record => record.status === "incomplete"));
  assert.equal(after.issue, before.issue);
});

test("toolbar result requests select attention without leaking the default into notification requests", async () => {
  const h = await harness({ direct: true, saved: { records: [{ key: "threat", status: "detected", sha256: "digest", locator: locator(mail(1)) }] } });
  h.api.browserAction.onClicked.listeners[0]();
  const first = await settle(h, state => Boolean(state.resultsRequest));
  assert.equal(first.resultsFilter, "attention");
  h.api.notifications.onClicked.listeners[0]();
  const notification = await h.send("state");
  assert.notEqual(notification.resultsRequest, first.resultsRequest);
  assert.equal(notification.resultsFilter, null);
  h.api.browserAction.onClicked.listeners[0]();
  const again = await settle(h, state => state.resultsRequest !== notification.resultsRequest);
  assert.equal(again.resultsFilter, "attention");
});
