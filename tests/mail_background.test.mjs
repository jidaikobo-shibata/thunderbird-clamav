import { readStoredState } from "../thunderbird/state-storage.mjs";
import { SCAN_IDLE_MS } from "../thunderbird/scan-connection.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256, locator, SCAN_INPUT_TIMEOUT_MS, REVIEW_FINGERPRINT_TIMEOUT_MS } from "../thunderbird/core.mjs";

function event() {
  const listeners = [];
  return { listeners, addListener(listener, ...args) { listeners.push(listener); this.args = args; } };
}

let caseId = 0;
async function harness({ failReads = [], failWrites = [], direct = false, backupFailure = false, saved = {}, mails = [], nativeFailure = false, oversized = false, deleteAllowed = false, deleteFailure = false, deleteFailureIds = [], scanResult = {}, scanGate = null,
  manageInfo = null, healthResult = null, configureMessages = null, configureToolbar = null, configureIdle = null, folderRefs = [{ id: "inbox", accountId: "one", path: "/Inbox", name: "受信トレイ" }] } = {}) {
  let stored = structuredClone(saved);
  const storageCounts = { reads: 0, writes: 0 };
  const notifications = [], opened = [], rawReads = [], timers = [], deleted = [], nativePorts = [];
  const events = { newMail: event(), selected: event(), message: event(), moved: event() };
  const byId = new Map(mails.map(mail => [mail.id, mail]));
  const api = {
    permissions: { contains: async () => deleteAllowed },
    storage: { local: { remove: async key => { delete stored[key]; }, get: async () => { if (failReads.includes(++storageCounts.reads)) throw new Error("synthetic storage read failure"); return structuredClone(stored); }, set: async value => {
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
  if (configureIdle) api.idle = configureIdle();
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
  configureMessages?.(api.messages);
  configureToolbar?.(api.browserAction);
  globalThis.messenger = api;
  const idleTimers = [], inputTimers = [], reviewTimers = [];
  const realTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (ms === REVIEW_FINGERPRINT_TIMEOUT_MS) {
      const timer = { callback, active: true }; reviewTimers.push(timer); return timer;
    }
    if (ms === SCAN_INPUT_TIMEOUT_MS) {
      const timer = { callback, active: true }; inputTimers.push(timer); return timer;
    }
    if (ms !== SCAN_IDLE_MS) return realTimeout(callback, ms, ...args);
    if (idleTimers.failNext) { idleTimers.failNext = false; throw new Error("synthetic idle timer failure"); }
    const timer = { callback, active: true, unref() {} }; idleTimers.push(timer); return timer;
  };
  globalThis.clearTimeout = timer => {
    if (idleTimers.includes(timer) || inputTimers.includes(timer) || reviewTimers.includes(timer)) timer.active = false;
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
  return { api, send, events, notifications, opened, rawReads, timers, deleted, nativePorts, directRequests, migrationBackups, storageCounts, idleTimers, inputTimers, reviewTimers,
    expireReview: () => { const timer = reviewTimers.find(timer => timer.active); assert.ok(timer, "active review deadline"); timer.active = false; timer.callback(); },
    expireInput: () => { const timer = inputTimers.find(timer => timer.active); assert.ok(timer, "active input deadline"); timer.active = false; timer.callback(); },
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
  await new Promise(resolve => setImmediate(resolve)); // Finish verdict persistence/queue cleanup.
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
  await new Promise(resolve => setImmediate(resolve)); // Finish verdict persistence/queue cleanup.
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
  const state = await settle(h, state => state.overflowReport?.total === 1 && state.overflowReport.recent[0]?.quarantine?.status === "moved");
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
  await h.events.newMail.listeners[0](moved.folder,{messages:[moved]});
  state=await h.send("state");
  assert.equal(state.records.length,1);
  assert.equal(state.records[0].key,"ordinary");
  assert.equal(h.directRequests.some(request=>request.op==="end"),false);
});

test("changed or ambiguous move targets cannot inherit a previous verdict", async () => {
  for(const options of [{changed:true},{ambiguous:true}]){
    const {h,original,destinations}=await moveFixture(options);
    await h.events.moved.listeners[0]({messages:[original]},{messages:destinations});
    const state=await h.send("state");
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
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.storageCounts.writes,writes, "disabled delivery allocates no receipt or storage write");
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
  await h.events.moved.listeners[0]({messages:[original]},{messages:[moved]});
  const state=await h.send("state");
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
  await settle(h,s=>s.incomingCount === 1);
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
    if (!failed && Object.entries(value).some(([key, entry]) => key.startsWith("incomingReceipt:") && entry.messageId === 3)) {
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
  await settle(h, state => state.overflowReport?.total === (mode === "disabled" ? 4 : expected.length) && !state.overflowPending);
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

test("persistent admission failures retry each retained receipt once per recovery cycle", async () => {
  const mails = [mail(201), mail(202), mail(203)];
  const h = await harness({ mails, saved: { settings: { enabled: true, accountIds: ["one"], notifications: false } } });
  const original = h.api.storage.local.set; let failures = 0;
  h.api.storage.local.set = async () => { failures++; throw new Error("persistent synthetic receipt failure " + failures); };
  h.events.newMail.listeners[0](mails[0].folder, { messages: [mails[0]] });
  h.events.newMail.listeners[0](mails[1].folder, { messages: [mails[1]] });
  await settle(h, state => state.issue.includes("failure 2"));
  for (const count of [4, 6]) {
    await h.timers[0]();
    // Each cycle tries a bounded snapshot once; failures never spin.
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

test("draft new-mail events are ignored by special-use metadata and release paged lists", async () => {
  const draft = { id: "drafts", accountId: "one", path: "/Entwuerfe", name: "下書き", specialUse: ["drafts"] };
  const message = { ...mail(601), folder: { ...draft, specialUse: undefined } };
  const h = await harness({ mails: [message], saved: { settings: { enabled: true, accountIds: ["one"], notifications: true } } });
  const aborted = []; let continued = 0;
  h.api.messages.abortList = async id => { aborted.push(id); };
  h.api.messages.continueList = async () => { continued++; throw new Error("must not enumerate ignored drafts"); };
  h.events.newMail.listeners[0](draft, { id: "draft-list", messages: [message] });
  await new Promise(resolve => setImmediate(resolve));
  await h.timers[0]();
  assert.deepEqual((await h.send("state")).records, []);
  assert.deepEqual(aborted, ["draft-list"]); assert.equal(continued, 0);
  assert.equal(h.rawReads.length, 0); assert.equal(h.nativePorts.length, 0); assert.equal(h.notifications.length, 0);
});

test("automatic admission skips draft headers but still scans ordinary folders named Drafts and other special folders", async () => {
  const uses = ["drafts", null, "sent", "outbox", "templates", "junk", "trash", "archives", ["drafts", "inbox"]];
  const mails = uses.map((use, i) => ({ ...mail(610 + i), folder: { id: "f" + i, accountId: "one", path: "/Drafts" + i, name: "Drafts", specialUse: Array.isArray(use) ? use : use ? [use] : [] } }));
  const h = await harness({ mails, saved: { settings: { enabled: true, accountIds: ["one"], notifications: false } } });
  h.events.newMail.listeners[0](mail(1).folder, { messages: mails });
  const state = await settle(h, state => state.records.length === mails.length - 1 && state.records.every(record => record.status === "clean"));
  assert.deepEqual(h.rawReads, mails.slice(1).map(message => message.id));
  assert.equal(state.records.some(record => record.messageId === mails[0].id), false);
});

test("draft messages remain available to explicit selection and folder scans", async () => {
  const draft = { id: "drafts", accountId: "one", path: "/Entwuerfe", name: "下書き", specialUse: ["drafts"] };
  const message = { ...mail(630), folder: draft };
  const h = await harness({ mails: [message], folderRefs: [draft] });
  assert.equal((await h.send("scanSelection")).ok, true);
  await settle(h, state => state.records[0]?.status === "clean");
  await startFolder(h);
  const state = await settledFolder(h, "completed");
  assert.equal(state.folderJob.completed, 1);
  assert.deepEqual(h.rawReads, [630, 630]);
});

for (const header of [true, false]) for (const notice of ["before", "after", "none"]) test(`late move recovers an initial body failure without duplicate verdicts (header=${header}, notice=${notice})`, async () => {
  const original = { ...mail(701), headerMessageId: header ? "late-move@example.invalid" : "", folder: { id: "inbox", accountId: "one", path: "/Inbox" } };
  const moved = { ...original, id: 702, folder: { id: "child", accountId: "one", path: "/Filtered" } };
  const h = await harness({ direct: true, mails: [original, moved], scanResult: { status: "detected", signatures: ["Synthetic.Threat"] }, saved: { settings: { enabled: true, accountIds: ["one"], notifications: true } } });
  const raw = h.api.messages.getRaw;
  h.api.messages.getRaw = async (id, options) => { if (id === 701) throw new Error("old body unavailable during move"); return raw(id, options); };
  h.events.newMail.listeners[0](original.folder, { messages: [original] });
  await settle(h, state => state.records[0]?.status === "error");
  h.api.messages.get = async id => { if (id === 701) throw new Error("old id no longer exists"); return moved; };
  h.api.messages.query = async () => ({ messages: [moved] });
  if (notice === "before") {
    h.events.newMail.listeners[0](moved.folder, { messages: [moved] });
    await settle(h, state => state.records[1]?.status === "detected");
  }
  await h.events.moved.listeners[0]({ messages: [original] }, { messages: [moved] });
  if (notice === "after") h.events.newMail.listeners[0](moved.folder, { messages: [moved] });
  const state = await settle(h, state => state.records.length === 1 && state.records[0].status === "detected");
  assert.equal(state.records[0].messageId, 702);
  assert.equal(state.records[0].locator.folder.path, "/Filtered");
  assert.deepEqual(h.rawReads, [702]);
  assert.equal(h.directRequests.filter(request => request.op === "end").length, 1);
  assert.equal(state.records[0].nextRetry, null);
  await h.timers[0](); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.send("state")).records.length, 1);
});

for (const moveCount of [1, 2]) test(`failed old-body read immediately follows ${moveCount} explicit moves within the same attempt`, async () => {
  const mails = Array.from({ length: moveCount + 1 }, (_, i) => ({ ...mail(711), id: 711 + i, headerMessageId: "", folder: { id: "f" + i, accountId: "one", path: "/Stage" + i } }));
  const h = await harness({ mails, saved: { settings: { enabled: true, accountIds: ["one"], notifications: true } } });
  let fail, enter;
  const gate = new Promise((resolve, reject) => { fail = reject; }), started = new Promise(resolve => { enter = resolve; });
  const raw = h.api.messages.getRaw;
  h.api.messages.getRaw = async (id, options) => { if (id === 711) { enter(); return gate; } return raw(id, options); };
  h.events.newMail.listeners[0](mails[0].folder, { messages: [mails[0]] });
  await started;
  for (let i = 1; i < mails.length; i++) await h.events.moved.listeners[0]({ messages: [mails[i - 1]] }, { messages: [mails[i]] });
  fail(new Error("old raw request aborted by move"));
  const state = await settle(h, state => state.records[0]?.status === "clean");
  assert.equal(state.records.length, 1); assert.equal(state.records[0].attempts, 1);
  assert.equal(state.records[0].messageId, mails.at(-1).id);
  assert.equal(state.records[0].nextRetry, null);
  assert.deepEqual(h.rawReads, [mails.at(-1).id]);
  assert.equal(h.notifications.length, 0);
});

test("continuous moves cannot trigger unbounded immediate body retries", async () => {
  const mails = Array.from({ length: 4 }, (_, i) => ({ ...mail(721), id: 721 + i, folder: { id: "f" + i, accountId: "one", path: "/Stage" + i } }));
  const h = await harness({ mails, saved: { settings: { enabled: true, accountIds: ["one"], notifications: false } } });
  const reads = [];
  h.api.messages.getRaw = async id => {
    reads.push(id); const index = id - 721;
    if (index >= 3) throw new Error("must not exceed retry bound");
    await h.events.moved.listeners[0]({ messages: [mails[index]] }, { messages: [mails[index + 1]] });
    throw new Error("body moved again");
  };
  h.events.newMail.listeners[0](mails[0].folder, { messages: [mails[0]] });
  const state = await settle(h, state => state.records[0]?.status === "error");
  assert.deepEqual(reads, [721, 722, 723]);
  assert.equal(state.records[0].attempts, 1);
  assert.ok(state.records[0].nextRetry > Date.now());
});

test("body failures without an explicit move retain the normal delayed retry", async () => {
  const h = await harness({ mails: [mail(731)], saved: { settings: { enabled: true, accountIds: ["one"], notifications: true } } });
  let reads = 0;
  h.api.messages.getRaw = async () => { reads++; throw new Error("temporary IMAP body download failure"); };
  h.events.newMail.listeners[0](mail(731).folder, { messages: [mail(731)] });
  const state = await settle(h, state => state.records[0]?.status === "error");
  assert.equal(reads, 1); assert.equal(state.records[0].attempts, 1);
  assert.ok(state.records[0].nextRetry > Date.now()); assert.equal(h.notifications.length, 0);
});

test("late unscanned move recovery does not discard an independently reviewed destination", async () => {
  const original = { ...mail(741), folder: { id: "inbox", accountId: "one", path: "/Inbox" } };
  const moved = { ...original, id: 742, folder: { id: "child", accountId: "one", path: "/Filtered" } };
  const h = await harness({ mails: [original, moved], scanResult: { status: "incomplete", detail: "encrypted" }, saved: { settings: { enabled: true, accountIds: ["one"], notifications: false } } });
  const raw = h.api.messages.getRaw;
  h.api.messages.getRaw = async (id, options) => { if (id === 741) throw new Error("old body unavailable"); return raw(id, options); };
  h.events.newMail.listeners[0](original.folder, { messages: [original] });
  await settle(h, state => state.records[0]?.status === "error");
  h.api.messages.get = async id => { if (id === 741) throw new Error("gone"); return moved; };
  h.api.messages.query = async () => ({ messages: [moved] });
  h.events.newMail.listeners[0](moved.folder, { messages: [moved] });
  const scanned = await settle(h, state => state.records[1]?.status === "incomplete");
  await new Promise(resolve => setImmediate(resolve));
  const target = scanned.records[1], { reviewStamp } = await import("../thunderbird/review.mjs");
  assert.equal((await h.send("reviewMany", { keys: [target.key], reviewed: true, note: "preserved prior judgment", stamps: { [target.key]: reviewStamp(target) } })).ok, true);
  await h.events.moved.listeners[0]({ messages: [original] }, { messages: [moved] });
  const state = await settle(h, state => state.records.every(record => record.status === "incomplete"));
  assert.equal(state.records.length, 2);
  assert.equal(state.records.find(record => record.key === target.key).review.note, "preserved prior judgment");
});

test("ambiguous late move destinations cannot redirect an unscanned failure", async () => {
  const original = mail(751), moved = { ...original, id: 752, folder: { id: "child", accountId: "one", path: "/Filtered" } };
  const h = await harness({ mails: [original, moved], saved: { settings: { enabled: true, accountIds: ["one"], notifications: false } } });
  h.api.messages.getRaw = async () => { throw new Error("old body unavailable"); };
  h.events.newMail.listeners[0](original.folder, { messages: [original] });
  const before = structuredClone((await settle(h, state => state.records[0]?.status === "error")).records[0]);
  await h.events.moved.listeners[0]({ messages: [original] }, { messages: [moved, { ...moved, id: 753 }] });
  assert.deepEqual((await h.send("state")).records[0], before);
});

async function pendingMoveCase({ rawFails = false, header = true, hops = 1, changed = false, noMove = false, verificationFails = false, saveFails = false } = {}) {
  const mails = Array.from({ length: hops + 1 }, (_, i) => ({ ...mail(801), id: 801 + i,
    headerMessageId: header ? "pending-move@example.invalid" : "", folder: { id: "stage" + i, accountId: "one", path: "/Stage" + i },
    ...(changed && i ? { raw: "Subject: changed\r\n\r\ndifferent content" } : {}) }));
  const h = await harness({ direct: true, mails, scanResult: { status: "detected", signatures: ["Synthetic.Threat"] }, saved: { settings: { enabled: true, accountIds: ["one"], notifications: true } } });
  let release, enter;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { enter = resolve; });
  const raw = h.api.messages.getRaw; let destinationReads = 0;
  h.api.messages.getRaw = async (id, options) => {
    if (id === 801) { const file = await raw(id, options); enter(); await gate; if (rawFails) throw new Error("old body moved before retrieval finished"); return file; }
    if (id === mails.at(-1).id && verificationFails && ++destinationReads === 2) throw new Error("destination unavailable during verification");
    return raw(id, options);
  };
  h.events.newMail.listeners[0](mails[0].folder, { messages: [mails[0]] });
  await started;
  for (let i = 1; i < mails.length; i++) {
    h.events.newMail.listeners[0](mails[i].folder, { messages: [mails[i]] });
    await settle(h, state => state.incomingCount === i + 1);
    if (!noMove) await h.events.moved.listeners[0]({ messages: [mails[i - 1]] }, { messages: [mails[i]] });
  }
  if (saveFails) {
    const original = h.api.storage.local.set; let failed = false;
    h.api.storage.local.set = async value => {
      if (!failed && value.records?.format === 2 && value.records.keys.length === 1) { failed = true; throw new Error("synthetic duplicate-removal save failure"); }
      return original(value);
    };
  }
  release();
  const state = await settle(h, state => !state.incomingCount && state.records.every(record => !["queued", "scanning"].includes(record.status)));
  await new Promise(resolve => setImmediate(resolve));
  h.expireIdle();
  return { h, state, mails };
}

for (const rawFails of [false, true]) for (const header of [false, true]) for (const hops of [1, 2]) test(`in-flight move merges pending destination work after body verification (rawFailure=${rawFails}, header=${header}, hops=${hops})`, async () => {
  const { h, state, mails } = await pendingMoveCase({ rawFails, header, hops });
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].messageId, mails.at(-1).id);
  assert.equal(state.records[0].status, "detected");
  assert.equal(h.directRequests.filter(request => request.op === "end").length, 1);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.stored().records.length, 1);
});

test("pending notifications without an explicit move remain separate copies", async () => {
  const { h, state } = await pendingMoveCase({ noMove: true });
  assert.equal(state.records.length, 2);
  assert.equal(h.directRequests.filter(request => request.op === "end").length, 2);
});

test("different destination bytes cannot cancel its independent pending scan", async () => {
  const { h, state, mails } = await pendingMoveCase({ changed: true });
  assert.equal(state.records.length, 2);
  assert.equal(state.records.find(record => record.messageId === mails.at(-1).id && record.status === "detected").sha256,
    await sha256(new TextEncoder().encode(mails.at(-1).raw)));
  assert.equal(h.directRequests.filter(request => request.op === "end").length, 1); // Only the actual changed destination is scanned.
});

test("unavailable final body verification retains the pending scan", async () => {
  const { h, state } = await pendingMoveCase({ rawFails: true, verificationFails: true });
  assert.equal(state.records.length, 2);
  assert.equal(h.directRequests.filter(request => request.op === "end").length, 2);
});

test("failed duplicate-removal persistence retains the pending scan", async () => {
  const { h, state } = await pendingMoveCase({ saveFails: true });
  assert.equal(state.records.length, 2);
  assert.equal(h.directRequests.filter(request => request.op === "end").length, 2);
  assert.match((await h.send("state")).issue, /synthetic duplicate-removal save failure/);
});

async function blockedMoveProof(header = false, quarantine = false, scanResult = { status: "detected", signatures: ["Synthetic.Threat"] }) {
  const original = { ...mail(901), headerMessageId: header ? "proof@example.invalid" : "",
    folder: { id: "inbox", accountId: "one", path: "/Inbox" } };
  const middle = { ...original, id: 902, folder: { id: "middle", accountId: "one", path: "/Middle" } };
  const final = { ...original, id: 903, folder: { id: "final", accountId: "one", path: "/Final" } }, fresh = mail(904);
  const isolation = { id: "isolation", accountId: "one", path: "/Isolation" };
  const h = await harness({ direct: true, mails: [original, middle, final, fresh],
    folderRefs: [original.folder, middle.folder, final.folder, isolation],
    scanResult,
    saved: { settings: { enabled: true, accountIds: ["one"], notifications: true,
      ...(quarantine ? { quarantine: { one: { folderId: isolation.id, path: isolation.path, auto: true } } } : {}) } } });
  const moves = [];
  h.api.permissions.contains = async () => true;
  h.api.folders.getFolderCapabilities = async () => ({ canAddMessages: true, canDeleteMessages: true });
  h.api.messages.move = async ids => {
    moves.push(...ids);
    for (const id of ids) [original, middle, final, fresh].find(mail => mail.id === id).folder = isolation;
  };
  let releaseRaw, enterRaw, releaseProof, enterProof, middleReads = 0;
  const rawGate = new Promise(resolve => { releaseRaw = resolve; });
  const rawStarted = new Promise(resolve => { enterRaw = resolve; });
  const proofGate = new Promise(resolve => { releaseProof = resolve; });
  const proofStarted = new Promise(resolve => { enterProof = resolve; });
  const raw = h.api.messages.getRaw;
  h.api.messages.getRaw = async (id, options) => {
    const file = await raw(id, options);
    if (id === 901) { enterRaw(); await rawGate; }
    if (id === 902 && ++middleReads === 2) { enterProof(); await proofGate; }
    return file;
  };
  h.events.newMail.listeners[0](original.folder, { messages: [original] });
  await rawStarted;
  h.events.newMail.listeners[0](middle.folder, { messages: [middle] });
  await settle(h, state => state.incomingCount === 2);
  await h.events.moved.listeners[0]({ messages: [original] }, { messages: [middle] });
  releaseRaw();
  await proofStarted;
  return { h, original, middle, final, fresh, releaseProof, moves };
}

for (const header of [false, true]) test(`a second move during final proof follows the latest location (header=${header})`, async () => {
  const { h, middle, final, releaseProof } = await blockedMoveProof(header);
  h.api.messages.get = async id => {
    if (id !== final.id) throw new Error("old location gone");
    return final;
  };
  h.api.messages.query = async () => ({ messages: [final] });
  await h.events.moved.listeners[0]({ messages: [middle] }, { messages: [final] });
  assert.ok((await h.send("state")).records.every(record => record.messageId === final.id));
  releaseProof();
  const state = await settle(h, state => state.records.length === 1 && state.records[0].status === "detected");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.records[0].locator.folder.path, final.folder.path);
  assert.equal((await h.send("open", { key: state.records[0].key })).ok, true);
  h.events.newMail.listeners[0](final.folder, { messages: [final] });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await h.send("state")).records.length, 1);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.directRequests.filter(request => request.op === "end").length, 1);
  assert.equal(h.stored().records.length, 1);
  h.expireIdle();
});

test("slow optional proof times out so detection alerts and later scans proceed", async () => {
  const { h, fresh, releaseProof } = await blockedMoveProof();
  h.events.newMail.listeners[0](fresh.folder, { messages: [fresh] });
  await settle(h, state => state.records.length === 3);
  // Leave the additional body read unresolved: the deadline must release work.
  await settle(h, state => state.records.length === 3 && state.records.every(record => record.status === "detected"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.notifications.length, 3);
  assert.equal(h.directRequests.filter(request => request.op === "end").length, 3);
  const before = structuredClone(h.stored().records);
  releaseProof();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(h.stored().records, before); // A late read cannot remove history.
  assert.equal(h.notifications.length, 3);
  h.expireIdle();
});

test("optional proof deadline also releases automatic quarantine", async () => {
  const { h, middle, releaseProof, moves } = await blockedMoveProof(true, true);
  await settle(h, state => state.records.some(record => record.quarantine?.status === "moved"));
  assert.ok(moves.includes(middle.id)); // The proof read is still unresolved.
  releaseProof();
  await settle(h, state => state.records.every(record => !["queued", "scanning"].includes(record.status)));
  h.expireIdle();
});

for (const header of [false, true]) for (const mode of ["normal", "notificationFailure", "changedVerdict"]) test(`timed-out proof still follows moves while fallback scans (header=${header}, mode=${mode})`, async () => {
  const { h, middle, final, releaseProof } = await blockedMoveProof(header);
  if (mode === "notificationFailure") {
    const create = h.api.notifications.create; let failed = false;
    h.api.notifications.create = async (...args) => {
      if (!failed) { failed = true; throw new Error("synthetic notification failure"); }
      return create(...args);
    };
  }
  if (mode === "changedVerdict") {
    const request = h.api.clamDirect.request;
    h.api.clamDirect.request = async (token, value) => {
      const response = JSON.parse(await request(token, value));
      if (JSON.parse(value).op === "end") response.signatures = ["Synthetic.DifferentThreat"];
      return JSON.stringify(response);
    };
  }
  let enter, release;
  const started = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const raw = h.api.messages.getRaw;
  h.api.messages.getRaw = async (id, options) => {
    const file = await raw(id, options);
    if (id === middle.id) { enter(); await gate; }
    return file;
  };
  await started; // The independent scan starts after the optional deadline.
  h.api.messages.get = async id => { if (id !== final.id) throw new Error("old location gone"); return final; };
  h.api.messages.query = async () => ({ messages: [final] });
  await h.events.moved.listeners[0]({ messages: [middle] }, { messages: [final] });
  assert.ok((await h.send("state")).records.every(record => record.messageId === final.id));
  release(); releaseProof();
  const state = await settle(h, state => state.records.length === 1 && state.records[0].status === "detected");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.notifications.length, mode === "changedVerdict" ? 2 : 1);
  assert.equal(h.directRequests.filter(request => request.op === "end").length, 2);
  assert.equal((await h.send("open", { key: state.records[0].key })).ok, true);
  assert.equal(h.stored().records.length, 1);
  h.expireIdle();
});

async function interruptedMoveChain({ header = false, hops = 1, changed = false, ambiguous = false, wrongSource = false, reviewAfterFailure = false } = {}) {
  const mails = Array.from({ length: hops + 2 }, (_, i) => ({ ...mail(951), id: 951 + i,
    headerMessageId: header ? "chain@example.invalid" : "",
    folder: { id: "chain" + i, accountId: "one", path: "/Chain" + i },
    ...(changed && i === hops + 1 ? { raw: "Subject: changed\r\n\r\nchanged destination body" } : {}) }));
  const h = await harness({ direct: true, mails, scanResult: { status: reviewAfterFailure ? "incomplete" : "detected", signatures: ["Synthetic.Threat"] },
    saved: { settings: { enabled: true, accountIds: ["one"], notifications: true } } });
  h.events.newMail.listeners[0](mails[0].folder, { messages: [mails[0]] });
  await settle(h, state => state.records[0]?.status === (reviewAfterFailure ? "incomplete" : "detected"));
  await new Promise(resolve => setImmediate(resolve));
  let enter, release;
  const started = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const raw = h.api.messages.getRaw;
  h.api.messages.getRaw = async (id, options) => {
    if (id === mails[1].id) { enter(); await gate; throw new Error("intermediate body moved before retrieval finished"); }
    if (mails.slice(2, -1).some(mail => mail.id === id)) throw new Error("later intermediate also unavailable");
    return raw(id, options);
  };
  const first = h.events.moved.listeners[0]({ messages: [mails[0]] },
    { messages: ambiguous ? [mails[1], { ...mails[1], id: 999 }] : [mails[1]] });
  await started;
  const remaining = [];
  const enqueueRemaining = () => {
    for (let i = 1; i < mails.length - 1; i++) remaining.push(h.events.moved.listeners[0](
      { messages: [{ ...mails[i], ...(wrongSource ? { id: 998 } : {}) }] }, { messages: [mails[i + 1]] }));
  };
  if (!reviewAfterFailure) enqueueRemaining();
  h.api.messages.get = async id => { if (id !== mails.at(-1).id) throw new Error("old location gone"); return mails.at(-1); };
  h.api.messages.query = async () => ({ messages: [mails.at(-1)] });
  release(); await first;
  if (reviewAfterFailure) {
    const record = (await h.send("state")).records[0];
    const { reviewStamp } = await import("../thunderbird/review.mjs");
    assert.equal((await h.send("reviewMany", { keys: [record.key], reviewed: true, note: "preserved judgment",
      stamps: { [record.key]: reviewStamp(record) } })).ok, true);
    enqueueRemaining();
  }
  await Promise.all(remaining);
  return { h, mails, state: await h.send("state") };
}

for (const header of [false, true]) for (const hops of [1, 2]) test(`unreadable intermediate moves are verified at the final location (header=${header}, hops=${hops})`, async () => {
  const { h, mails, state } = await interruptedMoveChain({ header, hops });
  assert.equal(state.records[0].messageId, mails.at(-1).id);
  assert.equal(state.records[0].locator.folder.path, mails.at(-1).folder.path);
  assert.equal((await h.send("open", { key: state.records[0].key })).ok, true);
  h.events.newMail.listeners[0](mails.at(-1).folder, { messages: [mails.at(-1)] });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await h.send("state")).records.length, 1);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.stored().records[0].messageId, mails.at(-1).id);
  h.expireIdle();
});

for (const option of ["changed", "ambiguous", "wrongSource"]) test(`unverified move hints cannot bypass ${option} protection`, async () => {
  const { h, mails, state } = await interruptedMoveChain({ [option]: true });
  assert.equal(state.records[0].messageId, mails[0].id);
  assert.equal(state.records[0].locator.folder.path, mails[0].folder.path);
  assert.equal((await h.send("open", { key: state.records[0].key })).ok, false);
  h.events.newMail.listeners[0](mails.at(-1).folder, { messages: [mails.at(-1)] });
  await settle(h, state => state.records.length === 2 && state.records.every(record => record.status === "detected"));
  assert.equal((await h.send("state")).records[0].messageId, mails[0].id);
  h.expireIdle();
});

for (const expired of [false, true]) test(`intermediate move hints expire without changing action targets (expired=${expired})`, async () => {
  const { h, mails } = await interruptedMoveChain({ changed: true });
  const next = { ...mails.at(-1), id: 997, folder: { id: "last", accountId: "one", path: "/Last" } };
  const bytes = await h.api.messages.getRaw(mails[0].id, { decrypt: false });
  h.api.messages.getRaw = async () => bytes; // The latest destination matches the original contents.
  const now = Date.now;
  try {
    if (expired) Date.now = () => now() + 60001;
    await h.events.moved.listeners[0]({ messages: [mails.at(-1)] }, { messages: [next] });
  } finally { Date.now = now; }
  assert.equal((await h.send("state")).records[0].messageId, expired ? mails[0].id : next.id);
  h.expireIdle();
});

test("human review invalidates an unverified intermediate location", async () => {
  const { h, mails, state } = await interruptedMoveChain({ reviewAfterFailure: true });
  assert.equal(state.records[0].messageId, mails[0].id);
  assert.equal(state.records[0].review.note, "preserved judgment");
  assert.equal(h.stored().records[0].review.note, "preserved judgment");
  h.expireIdle();
});

for (const header of [false, true]) for (const batch of [false, true]) test(`unrelated slow move proofs cannot consume incoming retries (header=${header}, batch=${batch})`, async () => {
  const origins = Array.from({ length: 5 }, (_, i) => mail(1101 + i));
  const targets = origins.map((mail, i) => ({ ...mail, id: 1201 + i, folder: { id: "archive", accountId: "one", path: "/Archive" } }));
  const incoming = { ...mail(1301), headerMessageId: header ? "incoming-move@example.invalid" : "" };
  const filtered = { ...incoming, id: 1302, folder: { id: "filtered", accountId: "one", path: "/Filtered" } };
  const h = await harness({ direct: true, mails: [...origins, ...targets, incoming, filtered],
    saved: { settings: { enabled: true, accountIds: ["one"], notifications: true } } });
  h.events.newMail.listeners[0](origins[0].folder, { messages: origins });
  await settle(h, state => state.records.length === 5 && state.records.every(record => record.status === "clean"));
  let release, active = 0, maximum = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const raw = h.api.messages.getRaw;
  h.api.messages.getRaw = async (id, options) => {
    if (targets.some(mail => mail.id === id)) {
      active++; maximum = Math.max(maximum, active);
      try { await gate; } finally { active--; }
    }
    if (id === incoming.id) throw new Error("incoming body moved before retrieval completed");
    return raw(id, options);
  };
  const moves = [];
  if (!batch) for (let i = 0; i < origins.length; i++) moves.push(h.events.moved.listeners[0]({ messages: [origins[i]] }, { messages: [targets[i]] }));
  try {
    if (!batch) await settle(h, () => active === 4);
    h.events.newMail.listeners[0](incoming.folder, { messages: [incoming] });
    await settle(h, state => state.records.find(record => record.messageId === incoming.id)?.status === "error");
    const get = h.api.messages.get;
    h.api.messages.get = async id => { if (id === incoming.id) throw new Error("old incoming id gone"); return get(id); };
    h.api.messages.query = async () => ({ messages: [filtered] });
    let moved;
    if (batch) {
      // A single bulk notification must not serialize these unrelated messages.
      moves.push(h.events.moved.listeners[0]({ messages: [...origins, incoming] }, { messages: [...targets, filtered] }));
    } else moved = h.events.moved.listeners[0]({ messages: [incoming] }, { messages: [filtered] });
    const state = await settle(h, state => state.records.find(record => record.messageId === filtered.id)?.status === "clean");
    if (moved) await moved;
    assert.equal(state.records.find(record => record.messageId === filtered.id).attempts, 2);
    assert.ok(state.records.slice(0, 5).every((record, i) => record.messageId === origins[i].id));
    assert.equal(h.notifications.length, 0);
    assert.equal(active, batch ? 1 : 4);
    assert.equal(maximum, batch ? 1 : 4);
    const now = Date.now;
    try { Date.now = () => now() + 61000; h.timers[0](); await new Promise(resolve => setImmediate(resolve)); }
    finally { Date.now = now; }
    assert.equal((await h.send("state")).records.find(record => record.messageId === filtered.id).attempts, 2);
  } finally { release(); await Promise.all(moves); h.expireIdle(); }
  assert.equal(maximum, batch ? 1 : 4);
  assert.ok((await h.send("state")).records.slice(0, 5).every((record, i) => record.messageId === targets[i].id));
});

test("connected moves retain ordering while unrelated recovery overtakes them", async () => {
  const a = mail(1401), b = { ...a, id: 1402, folder: { id: "b", accountId: "one", path: "/B" } };
  const c = { ...a, id: 1403, folder: { id: "c", accountId: "one", path: "/C" } };
  const x = { ...mail(1404), headerMessageId: "" }, y = { ...x, id: 1405, folder: { id: "y", accountId: "one", path: "/Y" } };
  const h = await harness({ direct: true, mails: [a, b, c, x, y], saved: { settings: { enabled: true, accountIds: ["one"], notifications: false } } });
  h.events.newMail.listeners[0](a.folder, { messages: [a] });
  await settle(h, state => state.records[0]?.status === "clean");
  let release, enter; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { enter = resolve; });
  const raw = h.api.messages.getRaw; let finalReads = 0;
  h.api.messages.getRaw = async (id, options) => {
    if (id === b.id) { enter(); await gate; }
    if (id === c.id) finalReads++;
    if (id === x.id) throw new Error("old input unavailable");
    return raw(id, options);
  };
  const first = h.events.moved.listeners[0]({ messages: [a] }, { messages: [b] });
  await started;
  const second = h.events.moved.listeners[0]({ messages: [b] }, { messages: [c] });
  try {
    h.events.newMail.listeners[0](x.folder, { messages: [x] });
    await settle(h, state => state.records[1]?.status === "error");
    await h.events.moved.listeners[0]({ messages: [x] }, { messages: [y] });
    await settle(h, state => state.records[1]?.messageId === y.id && state.records[1]?.status === "clean");
    assert.equal(finalReads, 0);
    assert.equal((await h.send("state")).records[0].messageId, a.id);
  } finally { release(); await first; await second; h.expireIdle(); }
  assert.equal(finalReads, 1);
  assert.equal((await h.send("state")).records[0].messageId, c.id);
});

test("known bulk moves retain one durable refresh instead of per-mail saves", async () => {
  const origins = Array.from({ length: 20 }, (_, i) => mail(1501 + i));
  const targets = origins.map((mail, i) => ({ ...mail, id: 1601 + i, folder: { id: "archive", accountId: "one", path: "/Archive" } }));
  const digest = await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello"));
  const records = origins.map(mail => ({ key: "bulk-" + mail.id, status: "clean", sha256: digest, locator: locator(mail) }));
  const h = await harness({ direct: true, mails: [...origins, ...targets], saved: { records } });
  const writes = h.storageCounts.writes;
  await h.events.moved.listeners[0]({ messages: origins }, { messages: targets });
  assert.equal(h.storageCounts.writes - writes, 1);
  assert.ok((await h.send("state")).records.every((record, i) => record.messageId === targets[i].id));
  assert.equal(h.rawReads.length, origins.length);
  h.expireIdle();
});

async function scanFinishesDuringMove({ header = false, mode = "normal" } = {}) {
  const result = mode === "review" ? { status: "incomplete", detail: "encrypted", signatures: [] } :
    { status: "detected", signatures: ["Synthetic.Threat"] };
  const { h, middle, final, releaseProof } = await blockedMoveProof(header, false, result);
  let releaseFallback, enterFallback, releaseMove, enterMove;
  const fallbackGate = new Promise(resolve => { releaseFallback = resolve; });
  const fallbackStarted = new Promise(resolve => { enterFallback = resolve; });
  const moveGate = new Promise(resolve => { releaseMove = resolve; });
  const moveStarted = new Promise(resolve => { enterMove = resolve; });
  const raw = h.api.messages.getRaw;
  if (mode === "differentBody") final.raw = "Subject: changed\r\n\r\ndifferent final destination bytes";
  h.api.messages.getRaw = async (id, options) => {
    const file = await raw(id, options);
    if (id === middle.id) { enterFallback(); await fallbackGate; }
    if (id === final.id) { enterMove(); await moveGate; }
    return file;
  };
  if (mode === "differentVerdict") {
    const request = h.api.clamDirect.request;
    h.api.clamDirect.request = async (token, value) => {
      const response = JSON.parse(await request(token, value));
      if (JSON.parse(value).op === "end") response.signatures = ["Synthetic.NewThreat"];
      return JSON.stringify(response);
    };
  }
  await fallbackStarted;
  h.api.messages.get = async id => { if (id !== final.id) throw new Error("old position gone"); return final; };
  h.api.messages.query = async () => ({ messages: [final] });
  const moving = h.events.moved.listeners[0]({ messages: [middle] }, { messages: [final] });
  try {
    await moveStarted;
    releaseFallback(); releaseProof();
    let state = await settle(h, state => state.records.length === 1 && state.records[0].status === result.status);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.records[0].messageId, middle.id); // No unverified location is exposed.
    if (mode === "review") {
      const record = state.records[0], { reviewStamp } = await import("../thunderbird/review.mjs");
      assert.equal((await h.send("reviewMany", { keys: [record.key], reviewed: true, note: "preserved while move proof waits",
        stamps: { [record.key]: reviewStamp(record) } })).ok, true);
    }
    if (mode === "forget") {
      const prepared = await h.send("prepareForget", { keys: [state.records[0].key] });
      assert.equal(prepared.ok, true);
      assert.equal((await h.send("forgetMany", { token: prepared.token })).ok, true);
    }
  } finally { releaseFallback(); releaseProof(); releaseMove(); await moving; }
  return { h, middle, final, state: await h.send("state") };
}

for (const header of [false, true]) test(`scan completion during a move proof retains one current history and alert (header=${header})`, async () => {
  const { h, final, state } = await scanFinishesDuringMove({ header });
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].messageId, final.id);
  assert.equal(state.records[0].locator.folder.path, final.folder.path);
  assert.equal((await h.send("open", { key: state.records[0].key })).ok, true);
  h.events.newMail.listeners[0](final.folder, { messages: [final] });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await h.send("state")).records.length, 1);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.stored().records[0].messageId, final.id);
  h.expireIdle();
});

for (const mode of ["review", "forget", "differentBody", "differentVerdict"]) test(`scan completion during a move proof preserves ${mode}`, async () => {
  const { h, middle, final, state } = await scanFinishesDuringMove({ header: true, mode });
  if (mode === "forget") {
    assert.equal(state.records.length, 0);
    assert.equal(h.stored().records.length, 0);
  } else if (mode === "differentBody") {
    assert.equal(state.records[0].messageId, middle.id);
    h.events.newMail.listeners[0](final.folder, { messages: [final] });
    await settle(h, state => state.records.length === 2 && state.records.every(record => record.status === "detected"));
    assert.equal((await h.send("state")).records[0].messageId, middle.id);
  } else {
    assert.equal(state.records[0].messageId, final.id);
    if (mode === "review") assert.equal(state.records[0].review.note, "preserved while move proof waits");
    if (mode === "differentVerdict") {
      assert.deepEqual(state.records[0].signatures, ["Synthetic.NewThreat"]);
      assert.equal(h.notifications.length, 2);
    }
  }
  h.expireIdle();
});

async function waitingQuarantineReceipt({ changed = false, failRead = false, page = false, phase = "raw" } = {}) {
  const isolation = { id: "isolation", accountId: "one", path: "/Isolation" };
  const old = { ...mail(1701), folder: isolation }, incoming = { ...old, id: 1702,
    ...(changed ? { raw: "Subject: changed\r\n\r\ndifferent body" } : {}) };
  const fresh = { ...mail(1703), ...(page ? { folder: isolation } : {}) }, manual = mail(1704);
  const digest = await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello"));
  const record = { key: "known-quarantined", status: "detected", sha256: digest, locator: locator(old),
    quarantine: { status: "moved", destination: isolation } };
  const h = await harness({ direct: true, mails: [incoming, fresh, manual], folderRefs: [fresh.folder, isolation],
    saved: { records: [record], settings: { enabled: true, accountIds: ["one"], notifications: false } } });
  let enter, release;
  const started = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const raw = h.api.messages.getRaw, get = h.api.messages.get; let first = true;
  h.api.messages.get = async id => {
    if (id === incoming.id && first && phase === "lookup") { first = false; enter(); await gate; }
    return get(id);
  };
  h.api.messages.getRaw = async (id, options) => {
    const file = await raw(id, options);
    if (id === incoming.id && first) {
      first = false;
      if (phase === "buffer") return { size: file.size, arrayBuffer: async () => { enter(); await gate; return file.arrayBuffer(); } };
      enter(); await gate;
      if (failRead) throw new Error("quarantine identity proof unavailable");
    }
    return file;
  };
  if (page) h.api.messages.continueList = async id => { assert.equal(id, "pending-page"); return { messages: [fresh] }; };
  h.events.newMail.listeners[0](isolation, { messages: [incoming], ...(page ? { id: "pending-page" } : {}) });
  await started;
  return { h, incoming, fresh, manual, release };
}

for (const page of [false, true]) test(`quarantine proof holds only its durable pending record, not unrelated automatic or manual work (page=${page})`, async () => {
  const { h, incoming, fresh, manual, release } = await waitingQuarantineReceipt({ page });
  try {
    assert.equal(h.stored().records.find(record => record.messageId === incoming.id).quarantineCheckPending, true);
    if (!page) h.events.newMail.listeners[0](fresh.folder, { messages: [fresh] });
    h.api.mailTabs.getSelectedMessages = async () => ({ messages: [manual] });
    assert.equal((await h.send("scanSelection")).ok, true);
    const state = await settle(h, state => [fresh.id, manual.id].every(id => state.records.some(record => record.messageId === id && record.status === "clean")));
    const pending = state.records.find(record => record.messageId === incoming.id);
    assert.equal(pending.status, "queued");
    assert.equal(pending.quarantineCheckPending, true);
    assert.equal(h.directRequests.filter(request => request.op === "end").length, 2);
  } finally { release(); }
  await settle(h, state => !state.records.some(record => record.messageId === incoming.id));
  assert.ok(h.stored().records.some(record => record.key === "known-quarantined"));
  h.expireIdle();
});

for (const option of ["changed", "failRead"]) test(`unconfirmed quarantine receipt remains eligible for ordinary inspection (${option})`, async () => {
  const { h, incoming, release } = await waitingQuarantineReceipt({ [option]: true });
  release();
  const state = await settle(h, state => state.records.some(record => record.messageId === incoming.id && record.status === "clean"));
  assert.equal(state.records.find(record => record.messageId === incoming.id).quarantineCheckPending, undefined);
  assert.ok(state.records.some(record => record.key === "known-quarantined"));
  assert.equal(h.directRequests.filter(request => request.op === "end").length, 1);
  h.expireIdle();
});

test("quarantine proof rechecks a forgotten supporting history before removing pending mail", async () => {
  const { h, incoming, release } = await waitingQuarantineReceipt();
  const prepared = await h.send("prepareForget", { keys: ["known-quarantined"] });
  assert.equal(prepared.ok, true);
  assert.equal((await h.send("forgetMany", { token: prepared.token })).ok, true);
  release();
  const state = await settle(h, state => state.records.some(record => record.messageId === incoming.id && record.status === "clean"));
  assert.equal(state.records.length, 1);
  h.expireIdle();
});

test("disabling automatic inspection while quarantine proof waits preserves the excluded receipt", async () => {
  const { h, incoming, release } = await waitingQuarantineReceipt();
  assert.equal((await h.send("settings", { settings: { enabled: false, accountIds: [], notifications: false } })).ok, true);
  release();
  const state = await settle(h, state => state.records.find(record => record.messageId === incoming.id)?.unscannedReason === "automaticExcluded");
  assert.equal(state.records.find(record => record.messageId === incoming.id).status, "incomplete");
  assert.equal(h.directRequests.filter(request => request.op === "end").length, 0);
  h.expireIdle();
});

test("pending quarantine identities survive restart and resume without raw mail persistence", async () => {
  const { h, incoming, release } = await waitingQuarantineReceipt();
  const saved = structuredClone(h.rawStored());
  assert.equal(JSON.stringify(saved).includes("Subject: example"), false);
  assert.equal(h.stored().records.find(record => record.messageId === incoming.id).quarantineCheckPending, true);
  const resumed = await harness({ direct: true, mails: [incoming], saved });
  await settle(resumed, state => state.records.length === 1 && state.records[0].key === "known-quarantined");
  assert.equal(resumed.directRequests.filter(request => request.op === "end").length, 0);
  release();
  await settle(h, state => state.records.length === 1);
  h.expireIdle(); resumed.expireIdle();
});

test("failed quarantine deduplication save keeps a durable pending receipt for retry", async () => {
  const { h, incoming, release } = await waitingQuarantineReceipt();
  const pending = h.stored().records.find(record => record.messageId === incoming.id), write = h.api.storage.local.set;
  let failed = false;
  h.api.storage.local.set = async value => {
    if (!failed && value.records?.format === 2 && !value.records.keys.includes(pending.key)) {
      failed = true; throw new Error("synthetic quarantine proof save failure");
    }
    return write(value);
  };
  release();
  await settle(h, state => state.issue.includes("synthetic quarantine proof save failure"));
  assert.equal(h.stored().records.find(record => record.key === pending.key).quarantineCheckPending, true);
  await new Promise(resolve => setImmediate(resolve));
  h.timers[0]();
  await settle(h, state => !state.records.some(record => record.key === pending.key) && state.issue === "" && h.stored().issue === "");
  assert.equal(h.directRequests.filter(request => request.op === "end").length, 0);
  h.expireIdle();
});

test("mail moved out of quarantine while identity proof waits is inspected at its current position", async () => {
  const { h, incoming, fresh, release } = await waitingQuarantineReceipt();
  const moved = { ...incoming, id: 1705, folder: fresh.folder };
  h.api.messages.get = async id => { if (id !== moved.id) throw new Error("old quarantine id gone"); return moved; };
  h.api.messages.query = async () => ({ messages: [moved] });
  const raw = h.api.messages.getRaw;
  h.api.messages.getRaw = async (id, options) => id === moved.id ? new File(["Subject: example\r\n\r\nhello"], "current.eml") : raw(id, options);
  await h.events.moved.listeners[0]({ messages: [incoming] }, { messages: [moved] });
  release();
  const state = await settle(h, state => state.records.some(record => record.messageId === moved.id && record.status === "clean"));
  assert.equal(state.records.length, 2);
  assert.ok(state.records.some(record => record.key === "known-quarantined"));
  assert.equal(h.directRequests.filter(request => request.op === "end").length, 1);
  h.expireIdle();
});

for (const changed of [false, true]) test(`account exclusion during the proof-result save is not overwritten (changed=${changed})`, async () => {
  const { h, incoming, release } = await waitingQuarantineReceipt({ changed });
  const write = h.api.storage.local.set;
  let enterSettings, releaseSettings;
  const settingsStarted = new Promise(resolve => { enterSettings = resolve; }), settingsGate = new Promise(resolve => { releaseSettings = resolve; });
  h.api.storage.local.set = async value => {
    if (value.settings && Object.keys(value).length === 1) { enterSettings(); await settingsGate; }
    return write(value);
  };
  const changing = h.send("settings", { settings: { enabled: false, accountIds: [], notifications: false } });
  await settingsStarted;
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  releaseSettings();
  assert.equal((await changing).ok, true);
  await settle(h, state => state.records.find(record => record.messageId === incoming.id)?.unscannedReason === "automaticExcluded" &&
    h.stored().records.find(record => record.messageId === incoming.id)?.unscannedReason === "automaticExcluded");
  assert.equal(h.directRequests.filter(request => request.op === "end").length, 0);
  h.expireIdle();
});

for (const phase of ["headers", "raw", "buffer"]) test(`input deadline releases later work and ignores late ${phase} after a successful retry`, async () => {
  const blocked = mail(1801), fresh = mail(1802), manual = mail(1803);
  const h = await harness({ direct: true, mails: [blocked, fresh, manual], saved: { settings: { enabled: true, accountIds: ["one"], notifications: true } } });
  let release, enter, first = true, oldBuffers = 0;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { enter = resolve; });
  const get = h.api.messages.get, raw = h.api.messages.getRaw;
  h.api.messages.get = async id => {
    const message = await get(id);
    if (phase === "headers" && id === blocked.id && first) { first = false; enter(); await gate; }
    return message;
  };
  h.api.messages.getRaw = async (id, options) => {
    const file = await raw(id, options);
    if (id === blocked.id && first && phase !== "headers") {
      first = false;
      if (phase === "raw") { enter(); await gate; return { size: file.size, arrayBuffer: async () => { oldBuffers++; return file.arrayBuffer(); } }; }
      return { size: file.size, arrayBuffer: async () => { oldBuffers++; enter(); await gate; return file.arrayBuffer(); } };
    }
    return file;
  };
  h.events.newMail.listeners[0](blocked.folder, { messages: [blocked] });
  await started;
  h.events.newMail.listeners[0](fresh.folder, { messages: [fresh] });
  h.api.mailTabs.getSelectedMessages = async () => ({ messages: [manual] });
  await h.send("scanSelection");
  h.expireInput();
  const done = await settle(h, state => state.records.length === 3 && state.records.find(record => record.messageId === blocked.id)?.status === "error" &&
    [fresh.id, manual.id].every(id => state.records.some(record => record.messageId === id && record.status === "clean")));
  await new Promise(resolve => setImmediate(resolve));
  const failed = done.records.find(record => record.messageId === blocked.id);
  assert.equal(failed.sha256, null);
  assert.ok(failed.nextRetry);
  assert.equal(h.notifications.length, 0);
  assert.equal(h.directRequests.filter(request => request.op === "end").length, 2);
  blocked.raw = "Subject: replacement\r\n\r\nnew contents";
  assert.equal((await h.send("retry", { key: failed.key })).ok, true);
  const retried = await settle(h, state => state.records.find(record => record.key === failed.key)?.status === "clean");
  await new Promise(resolve => setImmediate(resolve));
  const before = structuredClone(retried.records.find(record => record.key === failed.key));
  assert.equal(before.sha256, await sha256(new TextEncoder().encode(blocked.raw)));
  release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await h.send("state")).records.find(record => record.key === failed.key), before);
  assert.equal(oldBuffers, phase === "buffer" ? 1 : 0);
  assert.equal(h.directRequests.filter(request => request.op === "end").length, 3);
  assert.ok(h.inputTimers.every(timer => !timer.active));
  h.expireIdle();
});

for (const paged of [false, true]) test(`late restart lookup cannot overwrite a recovered locator or keep fetching pages (paged=${paged})`, async () => {
  const old = mail(1811), current = { ...old, id: 1812, folder: { id: "current", accountId: "one", path: "/Current" } };
  let release, enter, queries = 0, continued = 0, aborted = 0;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { enter = resolve; });
  const h = await harness({ direct: true, mails: [current], saved: { settings: { enabled: true, accountIds: ["one"], notifications: true },
    records: [{ key: "restore-input", status: "queued", source: "automatic", attempts: 0, sha256: null, locator: locator(old) }] },
    configureMessages: api => {
      api.query = async () => {
        if (++queries === 1) {
          if (paged) return { messages: [], id: "first-page" };
          enter(); await gate; return { messages: [old] };
        }
        return { messages: [current] };
      };
      api.continueList = async () => { continued++; enter(); await gate; return { messages: [], id: "late-page" }; };
      api.abortList = async () => { aborted++; };
    } });
  await started;
  h.expireInput();
  await settle(h, state => state.records[0].status === "error");
  assert.equal((await h.send("retry", { key: "restore-input" })).ok, true);
  const state = await settle(h, state => state.records[0].status === "clean");
  await new Promise(resolve => setImmediate(resolve));
  const before = structuredClone(state.records[0]);
  assert.equal(before.messageId, current.id);
  release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await h.send("state")).records[0], before);
  assert.ok(!h.rawReads.includes(old.id));
  assert.equal(continued, paged ? 1 : 0);
  assert.equal(aborted, paged ? 1 : 0);
  h.expireIdle();
});

test("move-destination verification shares the input deadline and cannot overwrite a later retry", async () => {
  const old = mail(1821), moved = { ...old, id: 1822, folder: { id: "moved", accountId: "one", path: "/Moved" } };
  const h = await harness({ direct: true, mails: [old, moved], saved: { settings: { enabled: true, accountIds: ["one"], notifications: true } } });
  let releaseOld, enterOld, releaseVerify, enterVerify, firstVerify = true;
  const oldGate = new Promise(resolve => { releaseOld = resolve; }), oldStarted = new Promise(resolve => { enterOld = resolve; });
  const verifyGate = new Promise(resolve => { releaseVerify = resolve; }), verifyStarted = new Promise(resolve => { enterVerify = resolve; });
  const raw = h.api.messages.getRaw;
  h.api.messages.getRaw = async (id, options) => {
    const file = await raw(id, options);
    if (id === old.id) { enterOld(); await oldGate; }
    if (id === moved.id && firstVerify) { firstVerify = false; enterVerify(); await verifyGate; }
    return file;
  };
  h.events.newMail.listeners[0](old.folder, { messages: [old] });
  await oldStarted;
  await h.events.moved.listeners[0]({ messages: [old] }, { messages: [moved] });
  releaseOld(); await verifyStarted;
  assert.equal(h.inputTimers.length, 1);
  h.expireInput();
  const failed = (await settle(h, state => state.records[0].status === "error")).records[0];
  assert.equal(failed.messageId, moved.id);
  assert.equal(failed.sha256, await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello")));
  assert.equal(h.directRequests.filter(request => request.op === "end").length, 0);
  moved.raw = "Subject: newest\r\n\r\nnew location data";
  await h.send("retry", { key: failed.key });
  const state = await settle(h, state => state.records[0].status === "clean");
  await new Promise(resolve => setImmediate(resolve));
  const before = structuredClone(state.records[0]);
  releaseVerify(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await h.send("state")).records[0], before);
  assert.equal(before.sha256, await sha256(new TextEncoder().encode(moved.raw)));
  h.expireIdle();
});

test("two input timeouts preserve the single delayed retry and notify only after the final failure", async () => {
  const target = mail(1831);
  const h = await harness({ direct: true, mails: [target], saved: { settings: { enabled: true, accountIds: ["one"], notifications: true } } });
  let release, entered = 0; const gate = new Promise(resolve => { release = resolve; });
  h.api.messages.getRaw = async () => { entered++; await gate; throw new Error("late underlying retrieval rejection"); };
  h.events.newMail.listeners[0](target.folder, { messages: [target] });
  await settle(h, () => entered === 1);
  h.expireInput();
  await settle(h, state => state.records[0].status === "error" && state.records[0].nextRetry);
  assert.equal(h.notifications.length, 0);
  const now = Date.now;
  try { Date.now = () => now() + 61000; h.timers[0](); await new Promise(resolve => setImmediate(resolve)); }
  finally { Date.now = now; }
  await settle(h, () => entered === 2);
  h.expireInput();
  const state = await settle(h, state => state.records[0].status === "error" && state.records[0].attempts === 2);
  await new Promise(resolve => setImmediate(resolve));
  const before = structuredClone(state.records[0]);
  assert.equal(before.nextRetry, null);
  assert.equal(h.notifications.length, 1);
  release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await h.send("state")).records[0], before);
  assert.equal((await h.send("state")).issue, "");
  h.timers[0](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, 2);
  h.expireIdle();
});

test("a folder stop finishes its timed-out input and releases incoming inspection", async () => {
  const blocked = mail(1841), spare = mail(1842), fresh = { ...mail(1843), folder: { id: "other", accountId: "one", path: "/Other" } };
  blocked.folder.id = spare.folder.id = "inbox";
  const h = await harness({ direct: true, mails: [blocked, spare, fresh], folderRefs: [blocked.folder, fresh.folder],
    saved: { settings: { enabled: true, accountIds: ["one"], notifications: false } } });
  let release, enter; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { enter = resolve; });
  const raw = h.api.messages.getRaw;
  h.api.messages.getRaw = async (id, options) => { const file = await raw(id, options); if (id === blocked.id) { enter(); await gate; } return file; };
  const context = await h.send("folderContext", { folderId: "inbox" });
  await h.send("folderStart", { token: context.token, includeSubfolders: false });
  await started;
  h.events.newMail.listeners[0](fresh.folder, { messages: [fresh] });
  const jobId = (await h.send("state")).folderJob.id;
  assert.equal((await h.send("folderStop", { jobId })).ok, true);
  h.expireInput();
  const state = await settle(h, state => state.folderJob?.status === "stopped" && state.records.some(record => record.messageId === fresh.id && record.status === "clean"));
  assert.equal(state.folderJob.completed, 1);
  assert.equal(state.folderJob.counts.error, 1);
  const before = structuredClone(state.folderJob);
  release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await h.send("state")).folderJob, before);
  assert.ok(!h.rawReads.includes(spare.id));
  h.expireIdle();
});

test("input timeout preserves a previous threat and a late lookup cannot replace it", async () => {
  const target = mail(1851), digest = await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello"));
  const h = await harness({ direct: true, mails: [target], saved: { records: [{ key: "previous-threat", status: "detected", sha256: digest,
    signatures: ["Synthetic.PreviousThreat"], locator: locator(target) }] } });
  let release, enter; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { enter = resolve; });
  const raw = h.api.messages.getRaw;
  h.api.messages.getRaw = async (...args) => { const file = await raw(...args); enter(); await gate; return file; };
  await h.send("retry", { key: "previous-threat" });
  await started;
  h.expireInput();
  const state = await settle(h, state => state.records[0].lastAttempt?.status === "error");
  assert.equal(state.records[0].status, "detected");
  assert.deepEqual(state.records[0].signatures, ["Synthetic.PreviousThreat"]);
  assert.equal(state.records[0].sha256, digest);
  const before = structuredClone(state.records[0]);
  release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await h.send("state")).records[0], before);
  h.expireIdle();
});

async function waitingReviewCarry(phase = "raw") {
  const large = mail(1901), fresh = mail(1902), manual = mail(1903);
  const h = await harness({ direct: true, mails: [large, fresh, manual], saved: { settings: { enabled: true, accountIds: ["one"], notifications: true } } });
  const { reviewStamp } = await import("../thunderbird/review.mjs");
  const size = 25 * 1024 * 1024 + 1, zeros = new Uint8Array(512 * 1024);
  const raw = h.api.messages.getRaw, get = h.api.messages.get;
  let holding = false, reads = 0, lookups = 0, slices = 0, enter, release;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { enter = resolve; });
  h.api.messages.get = async id => {
    const message = structuredClone(await get(id));
    if (holding && id === large.id && ++lookups === 2 && phase === "lookup") { enter(); await gate; }
    return message;
  };
  h.api.messages.getRaw = async (id, options) => {
    if (id !== large.id) return raw(id, options);
    const carry = holding && ++reads === 2;
    if (carry && phase === "raw") { enter(); await gate; }
    return { size, arrayBuffer() { throw new Error("must not allocate oversized mail"); }, slice(start, end) {
      if (carry) slices++;
      const blob = new Blob([zeros.slice(0, Math.min(size, end) - start)]);
      return { arrayBuffer: async () => {
        if (carry && phase === "chunk" && start === 0) { enter(); await gate; }
        return blob.arrayBuffer();
      } };
    } };
  };
  h.api.mailTabs.getSelectedMessages = async () => ({ messages: [large] });
  await h.send("scanSelection");
  const record = (await settle(h, state => state.records[0]?.status === "incomplete")).records[0];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.send("reviewMany", { keys: [record.key], reviewed: true, note: "known oversized synthetic mail",
    stamps: { [record.key]: reviewStamp(record) } })).ok, true);
  h.notifications.length = 0;
  holding = true;
  await h.send("retry", { key: record.key });
  await started;
  return { h, large, fresh, manual, key: record.key, release, slices: () => slices, reads: () => reads };
}

for (const phase of ["lookup", "raw", "chunk"]) test(`review carry deadline releases later inspections and ignores late ${phase} after a new human decision`, async () => {
  const { h, large, fresh, manual, key, release, slices } = await waitingReviewCarry(phase);
  assert.ok(h.inputTimers.every(timer => !timer.active));
  h.events.newMail.listeners[0](fresh.folder, { messages: [fresh] });
  h.api.mailTabs.getSelectedMessages = async () => ({ messages: [manual] });
  await h.send("scanSelection");
  h.expireReview();
  let state = await settle(h, state => state.records.length === 3 && [fresh.id, manual.id].every(id => state.records.some(record => record.messageId === id && record.status === "clean")));
  await new Promise(resolve => setImmediate(resolve));
  const record = state.records.find(record => record.key === key);
  assert.equal(record.status, "incomplete");
  assert.equal(record.review, undefined);
  assert.equal(record.reviewBeforeScan, undefined);
  assert.equal(h.notifications.length, 1);
  const { reviewStamp } = await import("../thunderbird/review.mjs");
  assert.equal((await h.send("reviewMany", { keys: [key], reviewed: true, note: "new decision after timeout",
    stamps: { [key]: reviewStamp(record) } })).ok, true);
  state = await h.send("state");
  const before = structuredClone(state.records.find(record => record.key === key)), previousSlices = slices();
  release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await h.send("state")).records.find(record => record.key === key), before);
  assert.equal(slices(), previousSlices);
  assert.ok(h.reviewTimers.every(timer => !timer.active));
  h.expireIdle();
});

test("a late carry lookup cannot restore the old location after a human confirms the new one", async () => {
  const { h, large, fresh, key, release, reads } = await waitingReviewCarry("lookup");
  h.expireReview();
  await settle(h, state => !state.records[0].reviewBeforeScan);
  await new Promise(resolve => setImmediate(resolve));
  const moved = { ...large, id: 1904, folder: { id: "moved", accountId: "one", path: "/Moved" } };
  h.api.messages.get = async id => { if (id !== moved.id) throw new Error("old ID gone"); return moved; };
  h.api.messages.query = async () => ({ messages: [moved] });
  const raw = h.api.messages.getRaw;
  h.api.messages.getRaw = (id, options) => raw(id === moved.id ? large.id : id, options);
  const record = (await h.send("state")).records[0], { reviewStamp } = await import("../thunderbird/review.mjs");
  assert.equal((await h.send("reviewMany", { keys: [key], reviewed: true, note: "confirmed at new location",
    stamps: { [key]: reviewStamp(record) } })).ok, true);
  const before = structuredClone((await h.send("state")).records[0]), beforeReads = reads();
  assert.equal(before.messageId, moved.id);
  release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await h.send("state")).records[0], before);
  assert.equal(reads(), beforeReads);
  h.expireIdle();
});

test("forgotten history stays removed when a timed-out carry proof returns", async () => {
  const { h, key, release } = await waitingReviewCarry();
  h.expireReview();
  await settle(h, state => !state.records[0].reviewBeforeScan);
  await new Promise(resolve => setImmediate(resolve));
  const prepared = await h.send("prepareForget", { keys: [key] });
  assert.equal(prepared.ok, true);
  assert.equal((await h.send("forgetMany", { token: prepared.token })).ok, true);
  release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.send("state")).records.length, 0);
  assert.equal(h.stored().records.length, 0);
  h.expireIdle();
});

test("a matching carry proof completed within its deadline keeps the original human review", async () => {
  const { h, key, release } = await waitingReviewCarry();
  release();
  const state = await settle(h, state => state.records[0].review?.note === "known oversized synthetic mail" && !state.records[0].reviewBeforeScan);
  assert.equal(state.records[0].status, "incomplete");
  assert.ok(h.reviewTimers.every(timer => !timer.active));
  assert.equal(h.notifications.length, 0);
  h.expireIdle();
});

test("a retry reserved during carry verification keeps its own acknowledgement snapshot", async () => {
  const { h, key, release } = await waitingReviewCarry();
  assert.equal((await h.send("retry", { key })).ok, true);
  h.expireReview();
  const state = await settle(h, state => state.records[0].status === "incomplete" && state.records[0].review?.note === "known oversized synthetic mail" && !state.records[0].reviewBeforeScan);
  await new Promise(resolve => setImmediate(resolve));
  const before = structuredClone(state.records[0]);
  assert.equal(h.notifications.length, 0);
  release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await h.send("state")).records[0], before);
  h.expireIdle();
});

test("history forgotten before the carry deadline is not notified or restored", async () => {
  const { h, key, release } = await waitingReviewCarry();
  const prepared = await h.send("prepareForget", { keys: [key] });
  assert.equal(prepared.ok, true);
  assert.equal((await h.send("forgetMany", { token: prepared.token })).ok, true);
  h.expireReview();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.send("state")).records.length, 0);
  assert.equal(h.notifications.length, 0);
  release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.stored().records.length, 0);
  assert.equal(h.notifications.length, 0);
  h.expireIdle();
});

async function waitingAutomaticQuarantine(phase) {
  const original = mail(1801); original.folder.id = "inbox";
  const fresh = mail(1802), manual = mail(1803);
  const destination = { id: "isolation", accountId: "one", path: "/Isolation" };
  const h = await harness({ direct: true, mails: [original, fresh, manual], folderRefs: [original.folder, destination],
    scanResult: id => ({ status: id === original.id ? "detected" : "clean", signatures: id === original.id ? ["Synthetic"] : [] }),
    saved: { settings: { enabled: true, accountIds: ["one"], notifications: true,
      quarantine: { one: { folderId: destination.id, path: destination.path, auto: true } } } } });
  h.api.permissions.contains = async () => true;
  h.api.folders.getFolderCapabilities = async () => ({ canAddMessages: true, canDeleteMessages: true });
  let enter, release, reads = 0, moves = 0, queries = 0;
  const started = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const raw = h.api.messages.getRaw, getFolder = h.api.folders.get, query = h.api.messages.query;
  h.api.messages.getRaw = async (id, options) => {
    if (id === original.id && ++reads === 2 && phase === "raw") { enter(); await gate; }
    return raw(id, options);
  };
  h.api.folders.get = async (...args) => {
    if (args[0] === destination.id && phase === "folder") { enter(); await gate; }
    return getFolder(...args);
  };
  h.api.messages.move = async () => { moves++; original.folder = destination; if (phase === "move") { enter(); await gate; } };
  h.api.messages.query = async (...args) => { queries++; if (phase === "query" && queries === 1) { enter(); await gate; } return query(...args); };
  h.events.newMail.listeners[0](original.folder, { messages: [original] });
  await started;
  return { h, original, fresh, manual, release, moves: () => moves, queries: () => queries };
}

for (const phase of ["folder", "raw", "move", "query"]) test(`automatic quarantine does not hold inspections or alerts and invalidates expired ${phase}`, async () => {
  const f = await waitingAutomaticQuarantine(phase), { h, original, fresh, manual, release } = f;
  try {
    h.events.newMail.listeners[0](fresh.folder, { messages: [fresh] });
    h.api.mailTabs.getSelectedMessages = async () => ({ messages: [manual] });
    assert.equal((await h.send("scanSelection")).ok, true);
    await settle(h, state => [fresh.id, manual.id].every(id => state.records.some(r => r.messageId === id && r.status === "clean")));
    assert.equal(h.notifications.length, 1);
    assert.equal((await h.send("retry", { key: (await h.send("state")).records[0].key })).ok, false);
    h.expireInput();
    let state = await settle(h, state => state.records[0].quarantine?.status === "error");
    const before = structuredClone(state.records[0]);
    assert.equal(before.status, "detected");
    assert.match(before.quarantine.detail, /時間切れ/);
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    state = await h.send("state");
    assert.deepEqual(state.records[0], before);
    assert.equal(f.moves(), ["move", "query"].includes(phase) ? 1 : 0);
    assert.equal(f.queries(), phase === "query" ? 1 : 0);
    for (let i = 0; i < 2; i++) await h.timers[0]();
    assert.equal(f.moves(), ["move", "query"].includes(phase) ? 1 : 0);
  } finally { release(); h.expireIdle(); }
});

for (const phase of ["lookup", "raw", "buffer"]) for (const changed of [false, true]) test(`quarantine receipt timeout releases following candidates and ignores late proof (phase=${phase}, changed=${changed})`, async () => {
  const { h, incoming, fresh, release } = await waitingQuarantineReceipt({ changed, phase });
  const second = { ...incoming, id: 1805, raw: "Subject: changed\r\n\r\nanother body" };
  const get = h.api.messages.get, raw = h.api.messages.getRaw;
  h.api.messages.get = async id => id === second.id ? second : get(id);
  h.api.messages.getRaw = async (id, options) => id === second.id ? new File([second.raw], "mail.eml") : raw(id, options);
  h.events.newMail.listeners[0](second.folder, { messages: [second] });
  await settle(h, state => state.records.some(r => r.messageId === second.id && r.quarantineCheckPending));
  h.expireReview();
  let state = await settle(h, state => [incoming.id, second.id].every(id => state.records.some(r => r.messageId === id && r.status === "clean")));
  const before = structuredClone(state.records);
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  state = await h.send("state");
  assert.deepEqual(state.records, before);
  assert.ok(state.records.some(r => r.key === "known-quarantined"));
  assert.equal(state.records.filter(r => r.quarantineCheckPending).length, 0);
  h.expireIdle();
});

test("automatic quarantine queue advances after timeout and rechecks a disabled target", async () => {
  const { h, fresh, release, moves } = await waitingAutomaticQuarantine("raw");
  // A second detection must wait for the bounded move worker, not hold scanning.
  const post = h.api.clamDirect.request;
  h.api.clamDirect.request = async (token, value) => {
    const result = JSON.parse(await post(token, value));
    if (JSON.parse(value).op === "end") Object.assign(result, { status: "detected", signatures: ["Synthetic"] });
    return JSON.stringify(result);
  };
  h.events.newMail.listeners[0](fresh.folder, { messages: [fresh] });
  await settle(h, state => state.records.some(r => r.messageId === fresh.id && r.status === "detected" && r.quarantine?.status === "moving"));
  assert.equal(moves(), 0);
  const settings = (await h.send("state")).settings;
  settings.quarantine.one.auto = false;
  assert.equal((await h.send("settings", { settings })).ok, true);
  h.expireInput();
  await settle(h, state => state.records.filter(r => r.status === "detected").every(r => r.quarantine?.status === "error"));
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(moves(), 0);
  h.expireIdle();
});

test("automatic quarantine queue performs the next move after the first proof expires", async () => {
  const { h, fresh, release } = await waitingAutomaticQuarantine("raw");
  fresh.folder.id = "inbox";
  const destination = { id: "isolation", accountId: "one", path: "/Isolation" };
  const post = h.api.clamDirect.request;
  h.api.clamDirect.request = async (token, value) => {
    const result = JSON.parse(await post(token, value));
    if (JSON.parse(value).op === "end") Object.assign(result, { status: "detected", signatures: ["Synthetic"] });
    return JSON.stringify(result);
  };
  let moves = 0;
  h.api.messages.move = async ids => { assert.deepEqual(ids, [fresh.id]); moves++; fresh.folder = destination; };
  h.events.newMail.listeners[0](fresh.folder, { messages: [fresh] });
  await settle(h, state => state.records.some(r => r.messageId === fresh.id && r.status === "detected" && r.quarantine?.status === "moving"));
  h.expireInput();
  await settle(h, state => state.records.some(r => r.messageId === fresh.id && r.quarantine?.status === "moved"));
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(moves, 1);
  h.expireIdle();
});

test('expired move proofs release all four slots and never change history late',async()=>{
 const originals=Array.from({length:5},(_,i)=>({...mail(1900+i),folder:{id:'inbox',accountId:'one',path:'/Inbox'}}));
 const moved=originals.map((m,i)=>({...m,id:2000+i,folder:{id:'dest',accountId:'one',path:'/Dest'}}));
 const fresh=mail(3000), h=await harness({direct:true,mails:[...originals,...moved,fresh]});
 h.api.mailTabs.getSelectedMessages=async()=>({messages:originals});await h.send('scanSelection');
 await settle(h,s=>s.records.length===5&&s.records.every(r=>r.status==='clean'));
 let release;const gate=new Promise(r=>release=r), raw=h.api.messages.getRaw,reads=[];
 h.api.messages.getRaw=async(id,opt)=>{if(id>=2000&&id<2005){reads.push(id);if(id<2004)await gate;}return raw(id,opt);};
 const jobs=[];
 for(let i=0;i<4;i++)jobs.push(h.events.moved.listeners[0]({messages:[originals[i]]},{messages:[moved[i]]}));
 await settle(h,()=>reads.length===4);
 jobs.push(h.events.moved.listeners[0]({messages:[originals[4]]},{messages:[moved[4]]}));
 await h.send('settings',{settings:{enabled:true,accountIds:['one'],notifications:false}});
 h.events.newMail.listeners[0](fresh.folder,{messages:[fresh]});
 await settle(h,s=>s.records.some(r=>r.messageId===fresh.id&&r.status==='clean'));
 for(let i=0;i<3;i++)await h.timers[0]();
 const state=await h.send('state');
 assert.deepEqual(reads,[2000,2001,2002,2003]);
 for(let i=0;i<4;i++)h.expireReview();
 await Promise.all(jobs);
 const after = await h.send('state');
 assert.equal(after.records.find(r=>r.locator.headerMessageId===originals[4].headerMessageId).messageId,2004);
 const before = structuredClone(after.records);
 release();await new Promise(resolve=>setTimeout(resolve,20));
 assert.deepEqual((await h.send('state')).records,before);
 assert.equal(h.reviewTimers.filter(t=>t.active).length,0);
 h.expireIdle();
});

test('paged receipt does not hold unrelated new-mail admission or manual inspection',async()=>{
 const a=mail(4101),b=mail(4102),manual=mail(4103);
 const h=await harness({direct:true,mails:[a,b,manual],saved:{settings:{enabled:true,accountIds:['one'],notifications:true}}});
 let enter,release;const started=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 h.api.messages.continueList=async id=>{assert.equal(id,'held-receipt');enter();await gate;return{messages:[a]};};
 h.events.newMail.listeners[0](a.folder,{messages:[],id:'held-receipt'});await started;
 h.events.newMail.listeners[0](b.folder,{messages:[b]});
 h.api.mailTabs.getSelectedMessages=async()=>({messages:[manual]});await h.send('scanSelection');
 for(let i=0;i<3;i++){await h.timers[0]();await new Promise(r=>setTimeout(r,5));}
 let state=await h.send('state');
 assert.equal(state.records.find(r=>r.messageId===b.id).status,'clean');
 assert.equal(state.records.find(r=>r.messageId===manual.id).status,'clean');
 assert.equal(h.inputTimers.filter(t=>t.active).length+h.reviewTimers.filter(t=>t.active).length,0);

 release();await settle(h,s=>[a.id,b.id].every(id=>s.records.some(r=>r.messageId===id)));
 await h.timers[0]();await settle(h,s=>s.records.every(r=>r.status==='clean'));h.expireIdle();
});
test('paged move intake does not hold unrelated later move tracking',async()=>{
 const originals=[mail(4201),mail(4202)], moved=originals.map((m,i)=>({...m,id:4301+i,folder:{id:'dest',accountId:'one',path:'/Dest'}}));
 const h=await harness({direct:true,mails:[...originals,...moved]});
 h.api.mailTabs.getSelectedMessages=async()=>({messages:originals});await h.send('scanSelection');await h.timers[0]();
 await settle(h,s=>s.records.length===2&&s.records.every(r=>r.status==='clean'));
 let enter,release;const started=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 h.api.messages.continueList=async id=>{assert.equal(id,'held-move');enter();await gate;return{messages:[originals[0]]};};
 const first=h.events.moved.listeners[0]({messages:[],id:'held-move'},{messages:[moved[0]]});await started;
 const second=h.events.moved.listeners[0]({messages:[originals[1]]},{messages:[moved[1]]});
 for(let i=0;i<3;i++){await h.timers[0]();await new Promise(r=>setTimeout(r,5));}
 await second;
 const state=await h.send('state');assert.equal(state.records.find(r=>r.messageId===moved[1].id).locator.folder.path,'/Dest');
 assert.equal(h.rawReads.includes(moved[1].id),true);
 assert.equal(h.reviewTimers.filter(t=>t.active).length,0);

 release();await Promise.all([first,second]);
 assert.equal((await h.send('state')).records.find(r=>r.messageId===moved[1].id).locator.folder.path,'/Dest');h.expireIdle();
});

for (const overflow of [false, true]) test(`pending receipt page holds no manual overflow priority (overflow=${overflow})`, async () => {
  const fresh = mail(4401), manual = mail(4402);
  const records = overflow ? Array.from({length:1000}, (_,i) => ({key:'held-'+i,status:'detected',locator:{accountId:'one'}})) : [];
  const h = await harness({ direct:true, mails:[fresh,manual], saved:{records,settings:{enabled:true,accountIds:['one'],notifications:false}} });
  let enter, release;
  const started = new Promise(resolve => { enter=resolve; }), gate = new Promise(resolve => { release=resolve; });
  h.api.messages.continueList = async () => { enter(); await gate; return {messages:[fresh]}; };
  h.events.newMail.listeners[0](fresh.folder,{messages:[],id:'held'}); await started;
  h.api.mailTabs.getSelectedMessages = async () => ({messages:[manual]});
  const accepted = h.send('scanSelection');
  for(let i=0;i<4;i++) { await h.timers[0](); await new Promise(resolve => setTimeout(resolve,5)); }
  assert.ok(h.rawReads.includes(manual.id));
  release();
  assert.equal((await accepted).ok,true);
  await settle(h,s=>overflow?s.overflowReport?.total===2:s.records.length===2);
  h.expireIdle();
});

test('a rejected continuation retains its page and retries once per tick without duplicate delivery',async()=>{
  const a=mail(4501),b=mail(4502),fresh=mail(4503);
  const h=await harness({direct:true,mails:[a,b,fresh],saved:{settings:{enabled:true,accountIds:['one'],notifications:false}}});
  let attempts=0;
  h.api.messages.continueList=async id=>{assert.equal(id,'retry-page');if(++attempts===1)throw Error('synthetic page unavailable');return{messages:[b]};};
  h.events.newMail.listeners[0](a.folder,{messages:[a],id:'retry-page'});
  await settle(h,s=>s.issue.includes('synthetic page unavailable'));
  h.events.newMail.listeners[0](fresh.folder,{messages:[fresh]});
  await h.timers[0]();
  await settle(h,s=>s.records.length===3&&!s.issue&&s.records.every(r=>r.status==='clean'));
  assert.equal(attempts,2);
  assert.deepEqual([...h.rawReads].sort((a,b)=>a-b),[4501,4502,4503]);
  h.expireIdle();
});

for(const phase of ['original','destination']) for(const unavailable of [false,true]) test(`late move metadata replays a continuous chain (phase=${phase}, unavailable=${unavailable})`,async()=>{
  const a=mail(4601),b={...a,id:4602,folder:{id:'b',accountId:'one',path:'/B'}},c={...a,id:4603,folder:{id:'c',accountId:'one',path:'/C'}},d={...a,id:4604,folder:{id:'d',accountId:'one',path:'/D'}};
  const h=await harness({direct:true,mails:[a,b,c,d]});
  h.api.mailTabs.getSelectedMessages=async()=>({messages:[a]});await h.send('scanSelection');await h.timers[0]();
  await settle(h,s=>s.records[0]?.status==='clean');
  let enter,release;const started=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
  h.api.messages.continueList=async id=>{assert.equal(id,'chain-page');enter();await gate;return{messages:[phase==='original'?a:b]};};
  if(unavailable){const raw=h.api.messages.getRaw;h.api.messages.getRaw=async(id,opt)=>{if(id===b.id||id===c.id)throw Error('intermediate gone');return raw(id,opt);};}
  const first=h.events.moved.listeners[0](phase==='original'?{messages:[],id:'chain-page'}:{messages:[a]},phase==='destination'?{messages:[],id:'chain-page'}:{messages:[b]});
  await started;
  await h.events.moved.listeners[0]({messages:[b]},{messages:[c]});
  await h.events.moved.listeners[0]({messages:[c]},{messages:[d]});
  assert.equal((await h.send('state')).records[0].messageId,a.id);
  release();await first;
  assert.equal((await h.send('state')).records[0].messageId,d.id);
  assert.equal((await h.send('state')).records.length,1);
  h.expireIdle();
});

test('expired incomplete move metadata cannot rewind a more recent verified location',async()=>{
  const a=mail(4701),b={...a,id:4702,folder:{id:'b',accountId:'one',path:'/B'}},c={...a,id:4703,folder:{id:'c',accountId:'one',path:'/C'}};
  const h=await harness({direct:true,mails:[a,b,c]});
  h.api.mailTabs.getSelectedMessages=async()=>({messages:[a]});await h.send('scanSelection');await h.timers[0]();await settle(h,s=>s.records[0]?.status==='clean');
  let enter,release;const started=new Promise(r=>enter=r),gate=new Promise(r=>release=r);const aborted=[];
  h.api.messages.continueList=async()=>{enter();await gate;return{messages:[a],id:'late-list'};};
  h.api.messages.abortList=async id=>aborted.push(id);
  const first=h.events.moved.listeners[0]({messages:[],id:'held'},{messages:[b]});await started;
  const now=Date.now;Date.now=()=>now()+61000;
  try{await h.events.moved.listeners[0]({messages:[a]},{messages:[c]});}finally{Date.now=now;}
  const before=structuredClone((await h.send('state')).records[0]);assert.equal(before.messageId,c.id);
  release();await first;
  assert.deepEqual((await h.send('state')).records[0],before);assert.ok(aborted.includes('late-list'));
  h.expireIdle();
});

for(const reverse of [false,true]) test(`multiple incomplete move notices preserve chronological replay (reverse=${reverse})`,async()=>{
 const mails=Array.from({length:4},(_,i)=>({...mail(4801),id:4801+i,folder:{id:'stage'+i,accountId:'one',path:'/Stage'+i}}));
 const h=await harness({direct:true,mails});h.api.mailTabs.getSelectedMessages=async()=>({messages:[mails[0]]});await h.send('scanSelection');await h.timers[0]();await settle(h,s=>s.records[0]?.status==='clean');
 const releases=[],started=[];
 for(let i=0;i<2;i++){let enter;const ready=new Promise(r=>enter=r),gate=new Promise(r=>releases.push(r));started.push({ready,enter,gate});}
 h.api.messages.continueList=async id=>{const i=Number(id);started[i].enter();await started[i].gate;return{messages:[mails[i]]};};
 const first=h.events.moved.listeners[0]({messages:[],id:'0'},{messages:[mails[1]]});await started[0].ready;
 const second=h.events.moved.listeners[0]({messages:[],id:'1'},{messages:[mails[2]]});await started[1].ready;
 await h.events.moved.listeners[0]({messages:[mails[2]]},{messages:[mails[3]]});
 releases[reverse?1:0]();await (reverse?second:first);
 releases[reverse?0:1]();await Promise.all([first,second]);
 assert.equal((await h.send('state')).records[0].messageId,mails[3].id);h.expireIdle();
});

test('replayed move metadata does not adopt a new history created after the original event',async()=>{
 const a=mail(4901),b={...a,id:4902,folder:{id:'b',accountId:'one',path:'/B'}};
 const x=mail(4911),y={...x,id:4912,folder:{id:'y',accountId:'one',path:'/Y'}};
 const h=await harness({direct:true,mails:[a,b,x,y]});h.api.mailTabs.getSelectedMessages=async()=>({messages:[a,x]});await h.send('scanSelection');await h.timers[0]();await settle(h,s=>s.records.length===2&&s.records.every(r=>r.status==='clean'));
 let enter,release;const started=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 h.api.messages.continueList=async()=>{enter();await gate;return{messages:[a]};};
 const first=h.events.moved.listeners[0]({messages:[],id:'held'},{messages:[b]});await started;
 await h.events.moved.listeners[0]({messages:[x]},{messages:[y]});
 const old=(await h.send('state')).records.find(r=>r.messageId===y.id);
 const ticket=await h.send('prepareForget',{keys:[old.key]});assert.equal(ticket.ok,true);assert.equal((await h.send('forgetMany',{token:ticket.token})).ok,true);
 h.api.mailTabs.getSelectedMessages=async()=>({messages:[x]});await h.send('scanSelection');await h.timers[0]();
 const before=structuredClone((await settle(h,s=>s.records.some(r=>r.messageId===x.id&&r.status==='clean'))).records.find(r=>r.messageId===x.id));
 release();await first;
 assert.deepEqual((await h.send('state')).records.find(r=>r.key===before.key),before);h.expireIdle();
});

test('move replay retention limit retires the oldest incomplete notice safely',async()=>{
 const a=mail(4951),b={...a,id:4952,folder:{id:'b',accountId:'one',path:'/B'}};
 const h=await harness({direct:true,mails:[a,b]});h.api.mailTabs.getSelectedMessages=async()=>({messages:[a]});await h.send('scanSelection');await h.timers[0]();await settle(h,s=>s.records[0]?.status==='clean');
 let enter,release;const started=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 h.api.messages.continueList=async()=>{enter();await gate;return{messages:[a]};};
 const first=h.events.moved.listeners[0]({messages:[],id:'held'},{messages:[b]});await started;
 for(let i=0;i<1000;i++)await h.events.moved.listeners[0]({messages:[]},{messages:[]});
 assert.match((await h.send('state')).issue,/移動通知/);
 release();await first;
 assert.equal((await h.send('state')).records[0].messageId,a.id);h.expireIdle();
});

async function waitingOverflowQuarantine() {
 const mails=Array.from({length:22},(_,i)=>({...mail(5101+i),folder:{id:'inbox',accountId:'one',path:'/Inbox'}}));
 const isolation={id:'isolation',accountId:'one',path:'/Isolation'};
 const records=Array.from({length:1000},(_,i)=>({key:'protected-'+i,status:'detected',locator:{accountId:'one'}}));
 const h=await harness({direct:true,mails,folderRefs:[mails[0].folder,isolation],scanResult:{status:'detected',signatures:['Synthetic']},saved:{records,settings:{enabled:true,accountIds:['one'],notifications:false,quarantine:{one:{folderId:isolation.id,path:isolation.path,auto:true}}}}});
 h.api.permissions.contains=async()=>true;h.api.folders.getFolderCapabilities=async()=>({canAddMessages:true,canDeleteMessages:true});
 let enter,release,reads=0;const started=new Promise(r=>enter=r),gate=new Promise(r=>release=r),raw=h.api.messages.getRaw,moves=[];
 h.api.messages.getRaw=async(id,opt)=>{if(id===mails[0].id&&++reads===2){enter();await gate;}return raw(id,opt);};
 h.api.messages.move=async ids=>{moves.push(...ids);for(const id of ids)mails.find(m=>m.id===id).folder=isolation;};
 h.events.newMail.listeners[0](mails[0].folder,{messages:mails});await started;
 await settle(h,s=>s.overflowReport?.total===22);
 assert.equal((await h.send('state')).overflowReport.recent.length,20);
 return {h,mails,isolation,release,moves};
}

for(const clear of [false,true]) test(`overflow rotation preserves every automatic quarantine without restoring forgotten history (clear=${clear})`,async()=>{
 const {h,mails,release,moves}=await waitingOverflowQuarantine();
 h.events.newMail.listeners[0](mails[0].folder,{messages:[mails[0],mails[1]]});
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal((await h.send('state')).overflowReport.total,22);
 if(clear)assert.equal((await h.send('clearOverflow')).ok,true);
 release();await settle(h,()=>moves.length===22);
 const state=await h.send('state');
 assert.equal(mails.filter(m=>m.folder.id==='inbox').length,0);
 assert.equal(state.records.length,1000);
 assert.equal(new Set(moves).size,22);
 assert.equal(h.directRequests.filter(r=>r.op==='end').length,22);
 if(clear)assert.equal(state.overflowReport,null);
 else{assert.equal(state.overflowReport.recent.length,20);assert.equal(state.overflowReport.total,22);}
 h.expireIdle();
});

for(const change of ['disabled','target','contents','timeout']) test(`unretained quarantine tasks still protect ${change} changes`,async()=>{
 const {h,mails,isolation,release,moves}=await waitingOverflowQuarantine();
 if(change==='disabled'||change==='target'){
   const settings=(await h.send('state')).settings;
   if(change==='disabled'){settings.enabled=false;settings.accountIds=[];}
   else{
     const next={id:'other',accountId:'one',path:'/Other'};
     const get=h.api.folders.get;h.api.folders.get=async id=>id===next.id?next:get(id);
     settings.quarantine.one={folderId:next.id,path:next.path,auto:true};
   }
   assert.equal((await h.send('settings',{settings})).ok,true);
 }else if(change==='contents')mails[0].raw='Subject: different\r\n\r\nchanged body';
 if(change==='timeout'){
   h.expireInput();
   await settle(h,s=>moves.length===21&&s.overflowReport.recent.every(r=>r.quarantine?.status==='moved'));
   const before=structuredClone((await h.send('state')).overflowReport);
   release();await new Promise(resolve=>setTimeout(resolve,20));
   assert.deepEqual((await h.send('state')).overflowReport,before);
 }else{
   release();
   if(change==='contents')await settle(h,()=>moves.length===21);
   else await settle(h,s=>s.overflowReport.recent.every(r=>r.quarantine?.status==='error'));
 }
 const state=await h.send('state');
 if(change==='disabled'||change==='target'){assert.equal(moves.length,0);assert.equal(state.issue,'');}
 else{
   assert.equal(moves.length,21);
   assert.match(state.issue,/履歴上限/);
   assert.equal(state.issue.includes(mails[0].headerMessageId),false);
   assert.equal(mails[0].folder.id,'inbox');
 }
 assert.equal(state.overflowReport.recent.length,20);
 assert.equal(state.records.length,1000);
 h.expireIdle();
});

test('slow notification submission does not hold later automatic or manual inspections',async()=>{
 const mails=[mail(5201),mail(5202),mail(5203)];
 const h=await harness({direct:true,mails,scanResult:id=>({status:id===5201?'detected':'clean',signatures:id===5201?['Synthetic']:[]}),saved:{settings:{enabled:true,accountIds:['one'],notifications:true}}});
 let enter,release;const started=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 h.api.notifications.create=async()=>{enter();await gate;};
 h.events.newMail.listeners[0](mails[0].folder,{messages:[mails[0]]});await started;
 h.events.newMail.listeners[0](mails[1].folder,{messages:[mails[1]]});
 h.api.mailTabs.getSelectedMessages=async()=>({messages:[mails[2]]});assert.equal((await h.send('scanSelection')).ok,true);
 await settle(h,s=>s.records.length===3);
 for(let i=0;i<3;i++){await h.timers[0]();await new Promise(r=>setTimeout(r,5));}
 let state=await h.send('state');
 await settle(h,s=>s.records.filter(r=>r.status==='clean').length===2);
 state=await h.send('state');
 assert.deepEqual(state.records.map(r=>r.status),['detected','clean','clean']);
 assert.equal(h.directRequests.filter(r=>r.op==='end').length,3);
 assert.equal(h.inputTimers.filter(t=>t.active).length,0);
 assert.equal(h.reviewTimers.filter(t=>t.active).length,0);

 release();await settle(h,s=>s.records.filter(r=>r.status==='clean').length===2);
 assert.equal(h.directRequests.filter(r=>r.op==='end').length,3);h.expireIdle();
});

test('a pending detection notice does not hold overflow capacity or following deliveries',async()=>{
 const mails=[mail(5301),mail(5302)];
 const records=Array.from({length:1000},(_,i)=>({key:'held-'+i,status:'detected',locator:{accountId:'one'}}));
 const h=await harness({direct:true,mails,scanResult:id=>({status:id===5301?'detected':'clean'}),saved:{records,settings:{enabled:true,accountIds:['one'],notifications:true}}});
 let release,enter,calls=0;const gate=new Promise(r=>release=r),started=new Promise(r=>enter=r);
 h.api.notifications.create=async()=>{calls++;enter();await gate;};
 h.events.newMail.listeners[0](mails[0].folder,{messages:mails});await started;
 await settle(h,s=>s.overflowReport?.total===2&&!s.overflowPending);
 assert.equal(calls,1);release();h.expireIdle();
});

test('folder completion notification cannot hold subsequent automatic inspection',async()=>{
 const first=mail(5401),fresh=mail(5402);first.folder.id='inbox';
 const h=await harness({direct:true,mails:[first,fresh],saved:{settings:{enabled:true,accountIds:['one'],notifications:true}}});
 let release,enter;const gate=new Promise(r=>release=r),started=new Promise(r=>enter=r);
 h.api.notifications.create=async id=>{assert.ok(id.startsWith('folder-'));enter();await gate;};
 h.api.messages.list=async()=>({messages:[first]});
 const token=await h.send('folderContext',{folderId:'inbox'});
 await h.send('folderStart',{token:token.token,includeSubfolders:false});await started;
 h.events.newMail.listeners[0](fresh.folder,{messages:[fresh]});
 const state=await settle(h,s=>s.folderJob?.status==='completed'&&s.records.some(r=>r.source==='automatic'&&r.messageId===fresh.id&&r.status==='clean'));
 assert.equal(state.folderJob.completed,1);release();h.expireIdle();
});

test('pending identical notifications are coalesced but later explicit rescans may notify again',async()=>{
 const target=mail(5501),h=await harness({direct:true,mails:[target],scanResult:{status:'detected'},saved:{settings:{enabled:true,accountIds:['one'],notifications:true}}});
 let release,enter,calls=0;const gate=new Promise(r=>release=r),started=new Promise(r=>enter=r);
 h.api.notifications.create=async()=>{if(++calls===1){enter();await gate;}};
 h.events.newMail.listeners[0](target.folder,{messages:[target]});await started;
 const key=(await h.send('state')).records[0].key;
 assert.equal((await h.send('retry',{key})).ok,true);
 await settle(h,()=>h.directRequests.filter(r=>r.op==='end').length===2);
 await new Promise(r=>setTimeout(r,10));assert.equal(calls,1);
 release();await new Promise(r=>setTimeout(r,10));
 assert.equal((await h.send('retry',{key})).ok,true);
 await settle(h,()=>calls===2);h.expireIdle();
});

test('failed asynchronous notification is reported without stopping later scans and may be retried',async()=>{
 const a=mail(5601),b=mail(5602),h=await harness({direct:true,mails:[a,b],scanResult:{status:'detected'},saved:{settings:{enabled:true,accountIds:['one'],notifications:true}}});
 let reject,enter,calls=0;const gate=new Promise((r,j)=>reject=j),started=new Promise(r=>enter=r);
 h.api.notifications.create=async()=>{if(++calls===1){enter();await gate;}};
 h.events.newMail.listeners[0](a.folder,{messages:[a]});await started;
 h.events.newMail.listeners[0](b.folder,{messages:[b]});await settle(h,()=>calls===2);
 reject(Error('synthetic notification failed'));
 await settle(h,s=>s.issue.includes('デスクトップ通知'));
 const key=(await h.send('state')).records.find(r=>r.messageId===a.id).key;
 assert.equal((await h.send('retry',{key})).ok,true);
 await settle(h,()=>calls===3);h.expireIdle();
});

for(const returnToOld of [false,true]) for(const failure of [false,true]) test(`late notification completion preserves current delivery state (failure=${failure}, returnToOld=${returnToOld})`,async()=>{
 const original={...mail(5701),folder:{id:'inbox',accountId:'one',path:'/Inbox'}};
 const moved={...original,id:5702,folder:{id:'moved',accountId:'one',path:'/Moved'}};
 let signature='Synthetic.Old';
 const h=await harness({direct:true,mails:[original,moved],scanResult:()=>({status:'detected',signatures:[signature]}),saved:{settings:{enabled:true,accountIds:['one'],notifications:true}}});
 let enter,release,fail,releaseEnd,enterEnd,calls=0,ends=0;
 const started=new Promise(r=>enter=r),gate=new Promise((r,j)=>{release=r;fail=j;}),endStarted=new Promise(r=>enterEnd=r),endGate=new Promise(r=>releaseEnd=r);
 h.api.notifications.create=async()=>{if(++calls===1){enter();await gate;}};
 h.events.newMail.listeners[0](original.folder,{messages:[original]});await started;
 const key=(await h.send('state')).records[0].key;
 const request=h.api.clamDirect.request;
 h.api.clamDirect.request=async(token,value)=>{
   const response=await request(token,value);
   if(JSON.parse(value).op==='end'&&++ends===(returnToOld?3:2)){enterEnd();await endGate;}
   return response;
 };
 signature='Synthetic.New';
 assert.equal((await h.send('retry',{key})).ok,true);
 await settle(h,s=>s.records[0].signatures?.[0]==='Synthetic.New'&&calls===2);
 if(returnToOld){
   signature='Synthetic.Old';assert.equal((await h.send('retry',{key})).ok,true);
   await settle(h,s=>s.records[0].status==='detected'&&s.records[0].signatures?.[0]==='Synthetic.Old');
   await new Promise(r=>setTimeout(r,10));assert.equal(calls,2);
 }
 if(failure)fail(Error('old failure'));else release();
 await new Promise(r=>setTimeout(r,10));
 if(returnToOld&&failure)assert.match((await h.send('state')).issue,/デスクトップ通知/);
 else assert.equal((await h.send('state')).issue,'');
 h.events.newMail.listeners[0](moved.folder,{messages:[moved]});await endStarted;
 await h.events.moved.listeners[0]({messages:[original]},{messages:[moved]});releaseEnd();
 await settle(h,s=>s.records.length===1&&s.records[0].messageId===moved.id&&s.records[0].status==='detected');
 await new Promise(r=>setTimeout(r,10));assert.equal(calls,returnToOld&&failure?3:2);h.expireIdle();
});

test('state exposes review and manual quarantine availability during actual scanning',async()=>{
 const target=mail(5801);let enter,release;
 const started=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 const h=await harness({direct:true,mails:[target],scanGate:async()=>{enter();await gate;},saved:{settings:{enabled:true,accountIds:['one'],notifications:false}}});
 h.events.newMail.listeners[0](target.folder,{messages:[target]});await started;
 assert.equal((await h.send('state')).resultActionsBusy,true);
 release();
 await settle(h,s=>s.records[0]?.status==='clean'&&s.resultActionsBusy===false);
 h.expireIdle();
});

for(const phase of ['permission','raw']) test(`deletion preparation cancels without waiting for ${phase} and isolates late replies`,async()=>{
 const {h}=await batchFixture();
 const before=structuredClone((await h.send('state')).records);
 let enter,release,buffers=0,first=true;
 const started=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 if(phase==='permission'){
   h.api.permissions.contains=async()=>{if(first){first=false;enter();await gate;}return true;};
 }else{
   const raw=h.api.messages.getRaw;
   h.api.messages.getRaw=async(...args)=>{const file=await raw(...args);if(first){first=false;enter();await gate;return{size:file.size,arrayBuffer:()=>{buffers++;return file.arrayBuffer();}};}return file;};
 }
 const pending=h.send('prepareDeleteBatch',{keys:['k1','k2'],preparationId:'old-preparation'});await started;
 assert.equal((await h.send('state')).batch.preparationId,'old-preparation');
 assert.equal((await h.send('cancelDeletePreparation',{preparationId:'old-preparation'})).ok,true);
 await settle(h,s=>!s.batch.active);
 const cancelled=await pending;assert.equal(cancelled.cancelled,true);assert.equal(cancelled.token,undefined);
 assert.deepEqual((await h.send('state')).records,before);
 const next=await h.send('prepareDeleteBatch',{keys:['k1'],preparationId:'next-preparation'});assert.equal(next.ok,true);assert.equal(next.targets.length,1);
 const after=structuredClone((await h.send('state')).records);
 release();await new Promise(r=>setTimeout(r,20));
 assert.deepEqual((await h.send('state')).records,after);assert.equal(buffers,0);assert.equal(h.deleted.length,0);
 assert.equal((await h.send('state')).batch.preparationId,'next-preparation');
 await h.send('cancelDeleteBatch',{token:next.token});
});

test('an early cancellation is scoped to its preparation and cannot cancel another request',async()=>{
 const {h}=await batchFixture();
 await h.send('cancelDeletePreparation',{preparationId:'early-preparation'});
 const early=await h.send('prepareDeleteBatch',{keys:['k1'],preparationId:'early-preparation'});
 assert.equal(early.cancelled,true);assert.equal(h.rawReads.length,0);
 const normal=await h.send('prepareDeleteBatch',{keys:['k1','k2'],preparationId:'other-preparation'});
 assert.equal(normal.targets.length,2);assert.equal(h.deleted.length,0);
 await h.send('cancelDeleteBatch',{token:normal.token});
});


test('hidden toolbar rendering cannot hold initialization or automatic mail admission',async()=>{
 const messages=[mail(1),mail(2),mail(3)];let release;const gate=new Promise(r=>{release=r;});const calls=[];
 const h=await harness({direct:true,mails:messages,saved:{settings:{enabled:true,accountIds:['one'],notifications:false}},configureToolbar:action=>{
  for(const name of ['setIcon','setBadgeText','setBadgeBackgroundColor','setTitle'])action[name]=async value=>{calls.push([name,value]);await gate;};
 }});
 assert.equal((await h.send('state')).ok,true);
 for(const m of messages)h.events.newMail.listeners[0](m.folder,{messages:[m]});
 await settle(h,s=>s.records.filter(r=>r.status==='clean').length===3);
 assert.equal(calls.length,4,'only one pending call per property despite repeated scan saves');
 assert.equal(h.stored().records.filter(r=>r.status==='clean').length,3);
 release();await new Promise(r=>setImmediate(r));
 assert.equal((await h.send('state')).records.length,3);
});

test("intake overflow stays bounded and leaves a durable explicit reinspection notice", async () => {
  const mails = Array.from({ length: 140 }, (_, i) => mail(9000 + i));
  const h = await harness({ mails, saved: { settings: { enabled: true, accountIds: ["one"], notifications: false } } });
  const original = h.api.storage.local.set;
  let failedWrites = 0;
  h.api.storage.local.set = async () => { failedWrites++; throw Error("intake outage"); };
  for (const message of mails) h.events.newMail.listeners[0](message.folder, { messages: [message] });
  await settle(h, state => Boolean(state.receiptRecovery));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert(failedWrites <= 130, "excess notifications do not allocate writes or retained receipts");
  assert.equal(h.rawReads.length, 0);
  h.api.storage.local.set = original;
  await h.timers[0]();
  const state = await settle(h, state => state.records.length === 128 && state.records.every(record => record.status === "clean"));
  assert.equal(h.rawReads.length, 128, "all retained notifications recover in one cycle");
  await settle(h, () => Boolean(h.stored().receiptRecovery));
  assert(state.receiptRecovery, "overflow never masquerades as successful inspection");
  assert.equal((await h.send("acknowledgeReceiptRecovery", { token: "stale" })).ok, false);
  const restarted = await harness({ saved: h.stored() });
  const recoveredScope = (await restarted.send("state")).receiptRecovery;
  assert.deepEqual(recoveredScope.folders.map(folder => [folder.accountId, folder.path]), [["one", "/Inbox"]]);
  assert.equal((await h.send("acknowledgeReceiptRecovery", { token: state.receiptRecovery.token })).ok, true);
  assert.equal((await h.send("state")).receiptRecovery, null);
  assert.equal(h.stored().receiptRecovery, null);
});
test("oversized incoming pages abort enumeration and require explicit folder inspection", async () => {
  const message = mail(10001);
  const h = await harness({ mails: [message], saved: { settings: { enabled: true, accountIds: ["one"], notifications: false } } });
  const aborted = [];
  h.api.messages.abortList = async id => { aborted.push(id); };
  h.events.newMail.listeners[0](message.folder, { id: "oversized", messages: Array(257).fill(message) });
  await settle(h, state => Boolean(state.receiptRecovery));
  assert.deepEqual(aborted, ["oversized"]);
  assert.equal(h.rawReads.length, 0);
});

test("a retained page waiting on IO cannot hold later recovery batches", async () => {
  const mails = Array.from({ length: 6 }, (_, i) => mail(11000 + i));
  const h = await harness({ mails, saved: { settings: { enabled: true, accountIds: ["one"], notifications: false } } });
  let failed = true, attempts = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  h.api.messages.continueList = async id => {
    const i = Number(id);
    if (failed) { attempts++; throw Error("page unavailable"); }
    if (i < 4) await gate;
    return { messages: [mails[i]] };
  };
  for (let i = 0; i < 6; i++) h.events.newMail.listeners[0](mails[i].folder, { id: String(i), messages: [] });
  await settle(h, () => attempts === 6);
  failed = false;
  await h.timers[0]();
  await settle(h, state => state.records.filter(record => record.status === "clean").length === 2);
  assert.deepEqual(h.rawReads, [11004, 11005]);
  release();
  await settle(h, state => state.records.length === 6 && state.records.every(record => record.status === "clean"));
});

for (const failure of [false, true]) test(`reinspection notice acknowledgement preserves newer intake (storage failure=${failure})`, async () => {
  const message = mail(12001);
  const h = await harness({ mails: [message], saved: { receiptRecovery: { token: "old" }, settings: { enabled: true, accountIds: ["one"], notifications: false } } });
  const original = h.api.storage.local.set;
  let enter, release, first = true;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { enter = resolve; });
  h.api.storage.local.set = async value => {
    if (first) {
      first = false; enter(); await gate;
      if (failure) throw Error("acknowledgement write failed");
    }
    return original(value);
  };
  const acknowledgement = h.send("acknowledgeReceiptRecovery", { token: "old" });
  await started;
  assert.equal((await h.send("state")).receiptRecovery.token, "old", "no publication before save");
  h.events.newMail.listeners[0](message.folder, { messages: Array(257).fill(message) });
  const newer = await settle(h, state => state.receiptRecovery?.token !== "old");
  release();
  assert.equal((await acknowledgement).ok, !failure);
  await settle(h, () => h.stored().receiptRecovery?.token === newer.receiptRecovery.token);
  assert.equal((await h.send("state")).receiptRecovery.token, newer.receiptRecovery.token);
});

test("options entry does not broaden trusted runtime message origins", async () => {
  const h = await harness();
  for (const page of ["options.html", "dashboard.html?settings=1", "dashboard.html#settings"]) {
    assert.equal(await h.send("state", {}, { id: "unit", url: h.api.runtime.getURL(page) }), undefined);
  }
  assert.equal((await h.send("state")).ok, true);
});

function idleFixture(initial = "active") {
  let listener, state = initial;
  return { api: () => ({ onStateChanged: { addListener(callback) { listener = callback; } },
    setDetectionInterval(seconds) { assert.equal(seconds, 30); }, queryState: async () => state }),
    change(next) { state = next; listener(next); } };
}
test("idle automatic intake is durable, manual inspection runs, and activity pauses the next mail", async () => {
  const idle = idleFixture(), mails = [mail(13001), mail(13002), mail(13003)];
  let release, enter;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { enter = resolve; });
  const h = await harness({ mails, configureIdle: idle.api,
    saved: { settings: { enabled: true, accountIds: ["one"], notifications: false, idleAutomatic: true } },
    scanGate: async id => { if (id === 13001) { enter(); await gate; } } });
  h.events.newMail.listeners[0](mails[0].folder, { messages: mails.slice(0, 2) });
  await settle(h, state => state.incomingCount === 2 && state.idleWaiting);
  assert.equal(h.rawReads.length, 0);
  assert.equal(h.stored().records.length, 0);
  assert.equal(Object.keys(h.rawStored()).filter(key => key.startsWith("incomingReceipt:")).length, 2);
  h.api.mailTabs.getSelectedMessages = async () => ({ messages: [mails[2]] });
  assert.equal((await h.send("scanSelection")).ok, true);
  await settle(h, state => state.records.some(record => record.messageId === 13003 && record.status === "clean"));
  idle.change("idle"); await started;
  idle.change("active"); release();
  await settle(h, state => state.records.find(record => record.messageId === 13001)?.status === "clean" && state.idleWaiting);
  assert.deepEqual(h.rawReads, [13003, 13001]);
  idle.change("idle");
  await settle(h, state => state.records.length === 3 && state.records.every(record => record.status === "clean"));
  assert.deepEqual(h.rawReads, [13003, 13001, 13002]);
});
test("turning idle scheduling off resumes pending automatic mail", async () => {
  const idle = idleFixture(), message = mail(14001);
  const h = await harness({ mails: [message], configureIdle: idle.api,
    saved: { settings: { enabled: true, accountIds: ["one"], notifications: false, idleAutomatic: true } } });
  h.events.newMail.listeners[0](message.folder, { messages: [message] });
  await settle(h, state => state.idleWaiting);
  const state = await h.send("state");
  assert.equal((await h.send("settings", {settings:{...state.settings,idleAutomatic:false}})).ok, true);
  await settle(h, state => state.records[0]?.status === "clean");
});
test("idle wait survives restart and backend failure never marks mail clean", async () => {
  const idle = idleFixture(), message = mail(15001);
  const h = await harness({ mails: [message], configureIdle: idle.api,
    saved: { settings: { enabled: true, accountIds: ["one"], notifications: false, idleAutomatic: true } } });
  h.events.newMail.listeners[0](message.folder, { messages: [message] });
  await settle(h, state => state.idleWaiting);
  const saved = h.stored();
  const next = await harness({ mails: [message], saved, configureIdle: () => ({onStateChanged:{addListener(){}},setDetectionInterval(){},queryState:async()=>{throw Error("idle backend failed");}}) });
  const state = await settle(next, state => state.issue.includes("idle backend failed"));
  assert.equal(state.incomingCount, 1); assert.equal(next.rawReads.length, 0);
});

test("automatic quarantine identity reads also wait for idle", async () => {
  const idle = idleFixture(), isolation = {id:"isolation",accountId:"one",path:"/Isolation"};
  const old = {...mail(16001),folder:isolation}, incoming = {...old,id:16002};
  const digest = await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello"));
  const record = {key:"idle-quarantine",status:"detected",sha256:digest,locator:locator(old),
    quarantine:{status:"moved",destination:isolation}};
  const h = await harness({mails:[incoming],folderRefs:[isolation],configureIdle:idle.api,
    saved:{records:[record],settings:{enabled:true,accountIds:["one"],notifications:false,idleAutomatic:true}}});
  h.events.newMail.listeners[0](isolation,{messages:[incoming]});
  await settle(h,state=>state.idleWaiting);
  assert.equal(h.rawReads.length,0);
  assert(Object.entries(h.rawStored()).some(([key, item]) => key.startsWith("incomingReceipt:") &&
    item.messageId === incoming.id && item.quarantineCheckPending));
  idle.change("idle");
  await settle(h,state=>!state.incomingCount && !state.records.some(item=>item.messageId===incoming.id));
  assert(h.rawReads.includes(incoming.id));
  assert((await h.send("state")).records.some(item=>item.key===record.key));
});

test("active input and full protected history retain every receipt over restart in arrival order", async () => {
  const mails = Array.from({ length: 32 }, (_, i) => mail(17000 + i));
  const records = Array.from({ length: 1000 }, (_, i) => ({
    key: "protected-" + i, status: "detected", locator: { accountId: "one" }
  }));
  const settings = { enabled: true, idleAutomatic: true, accountIds: ["one"], notifications: false };
  const first = await harness({ mails, configureIdle: idleFixture().api, saved: { records, settings } });
  for (const message of mails) first.events.newMail.listeners[0](message.folder, { messages: [message] });
  const accepted = await settle(first, state => state.incomingCount === mails.length);
  assert.equal(accepted.records.length, records.length);
  assert.equal(accepted.waitingCount, mails.length);
  assert(Number.isFinite(Date.parse(accepted.oldestIncoming)));
  assert.deepEqual(first.rawReads, []);
  const idle = idleFixture();
  const second = await harness({ mails, configureIdle: idle.api, saved: first.rawStored() });
  assert.equal((await second.send("state")).incomingCount, mails.length);
  idle.change("idle");
  const result = await settle(second, state => state.overflowReport?.counts.clean === mails.length);
  assert.equal(result.incomingCount, 0);
  assert.deepEqual(second.rawReads, mails.map(message => message.id));
  assert.deepEqual(result.records.map(record => record.key), records.map(record => record.key));
});

test("activity during automatic header lookup postpones the first body read", async () => {
  const idle = idleFixture(), incoming = mail(17100);
  let interrupt = true;
  const h = await harness({ mails: [incoming], configureIdle: idle.api,
    saved: { settings: { enabled: true, idleAutomatic: true, accountIds: ["one"], notifications: false } },
    configureMessages(messages) {
      const get = messages.get;
      messages.get = async id => {
        if (interrupt) { interrupt = false; idle.change("active"); }
        return get(id);
      };
    }
  });
  h.events.newMail.listeners[0](incoming.folder, { messages: [incoming] });
  await settle(h, state => state.incomingCount === 1);
  idle.change("idle");
  const staged = await settle(h, state => state.idleWaiting && state.records[0]?.status === "queued");
  assert.equal(staged.waitingCount, 1);
  assert.deepEqual(h.rawReads, []);
  idle.change("idle");
  const result = await settle(h, state => state.records[0]?.status === "clean");
  assert.equal(result.records[0].attempts, 1);
  assert.deepEqual(h.rawReads, [incoming.id]);
});

test("a filter move updates a waiting receipt before idle without reading either body", async () => {
  const idle = idleFixture(), original = mail(17200);
  original.folder.id = "inbox";
  const moved = { ...original, id: 17201, folder: { id: "dest", path: "/Dest", accountId: "one" } };
  const h = await harness({ mails: [original, moved], configureIdle: idle.api,
    saved: { settings: { enabled: true, idleAutomatic: true, accountIds: ["one"], notifications: false } } });
  h.events.newMail.listeners[0](original.folder, { messages: [original] });
  await settle(h, state => state.incomingCount === 1);
  h.events.moved.listeners[0]({ messages: [original] }, { messages: [moved] });
  await settle(h, () => Object.entries(h.rawStored()).some(([key, entry]) =>
    key.startsWith("incomingReceipt:") && entry.messageId === moved.id));
  assert.deepEqual(h.rawReads, []);
  idle.change("idle");
  const result = await settle(h, state => state.records[0]?.status === "clean");
  assert.equal(result.records[0].locator.folder.path, "/Dest");
  assert.deepEqual(h.rawReads, [moved.id]);
});

test("restart around result storage recovers the receipt and preserves a detection exactly once", async () => {
  const incoming = mail(17300), idle = idleFixture();
  const settings = { enabled: true, idleAutomatic: true, accountIds: ["one"], notifications: false };
  const scanResult = { status: "detected", signatures: ["Synthetic.Marker"], detail: "synthetic" };
  let beforeResult, afterResult;
  const h = await harness({ mails: [incoming], saved: { settings }, configureIdle: idle.api, scanResult,
    scanGate: () => { beforeResult = h.rawStored(); } });
  const remove = h.api.storage.local.remove;
  h.api.storage.local.remove = async key => {
    afterResult = h.rawStored();
    await remove(key);
  };
  await h.events.newMail.listeners[0](incoming.folder, { messages: [incoming] });
  idle.change("idle");
  await settle(h, state => state.records[0]?.status === "detected" && !state.incomingCount);
  for (const [snapshot, reads] of [[beforeResult, 1], [afterResult, 0]]) {
    assert.equal(Object.keys(snapshot).filter(key => key.startsWith("incomingReceipt:")).length, 1);
    const restarted = await harness({ saved: snapshot, mails: [incoming], configureIdle: idleFixture("idle").api, scanResult });
    const state = await settle(restarted, state => state.records[0]?.status === "detected" && !state.incomingCount);
    assert.deepEqual(state.records[0].signatures, ["Synthetic.Marker"]);
    assert.equal(state.records.length, 1);
    assert.equal(restarted.rawReads.length, reads);
  }
});

for (const reason of ["messageMissing", "ambiguousMessage", "candidateDisappeared"]) {
  test("unresolved incoming receipt ends uninspected: " + reason, async () => {
    const receiving = mail(17400), idle = idleFixture();
    const copies = [1, 2].map(i => ({
      ...receiving, id: receiving.id + i, folder: { accountId: "one", path: "/Copy" + i }
    }));
    const h = await harness({ mails: [receiving], configureIdle: idle.api,
      saved: { settings: { enabled: true, idleAutomatic: true, accountIds: ["one"], notifications: false } } });
    await h.events.newMail.listeners[0](receiving.folder, { messages: [receiving] });
    await h.api.messages.delete([receiving.id], {});
    h.api.messages.query = async () => ({ messages: reason === "messageMissing" ? [] :
      reason === "ambiguousMessage" ? copies : copies.slice(0, 1) });
    idle.change("idle");
    await settle(h, state => Boolean(state.records[0]?.nextRetry));
    const now = Date.now;
    Date.now = () => now() + 61000;
    try {
      await h.timers[0]();
      const result = await settle(h, state => state.records[0]?.status === "incomplete");
      assert.equal(result.records[0].unscannedReason, reason === "candidateDisappeared" ? "messageMissing" : reason);
      assert.equal(result.records[0].nextRetry, null);
      assert.deepEqual(h.rawReads, []);
    } finally { Date.now = now; }
  });
}

test("manual selection inspects a waiting receipt once while input stays active", async () => {
  const idle = idleFixture(), incoming = mail(17500);
  const h = await harness({ mails: [incoming], configureIdle: idle.api,
    saved: { settings: { enabled: true, idleAutomatic: true, accountIds: ["one"], notifications: false } } });
  await h.events.newMail.listeners[0](incoming.folder, { messages: [incoming] });
  const receipt = Object.entries(h.rawStored()).find(([key]) => key.startsWith("incomingReceipt:"))[1];
  assert.equal((await h.send("scanSelection")).ok, true);
  const state = await settle(h, state => !state.incomingCount && state.records[0]?.status === "clean");
  assert.equal(state.records[0].key, receipt.key);
  idle.change("idle");
  await h.timers[0]();
  assert.deepEqual(h.rawReads, [incoming.id]);
});

test("old automatic scanner slots gain durable receipts without replacing previous detections", async () => {
  const incoming = mail(17600), idle = idleFixture();
  const previous = { status: "detected", detail: "Synthetic earlier verdict",
    sha256: await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello")), signatures: ["Synthetic.Marker"] };
  const legacy = { key: "old-queued", status: "scanning", source: "automatic", attempts: 0,
    locator: locator(incoming), lastResult: previous, createdAt: "2026-01-01T00:00:00Z" };
  const h = await harness({ mails: [incoming], configureIdle: idle.api, nativeFailure: true,
    saved: { records: [legacy], settings: { enabled: true, idleAutomatic: true, accountIds: ["one"], notifications: false } } });
  const pending = await h.send("state");
  assert.equal(pending.incomingCount, 1);
  assert.equal(pending.waitingCount, 1);
  assert.equal(pending.oldestIncoming, legacy.createdAt);
  assert.deepEqual(pending.records[0].lastResult, previous);
  idle.change("idle");
  const result = await settle(h, state => state.records[0]?.lastAttempt?.status === "error");
  assert.equal(result.records[0].status, "detected");
  assert.deepEqual(result.records[0].signatures, ["Synthetic.Marker"]);
});

test("deselecting one account retires its waiting receipts behind other active accounts", async () => {
  const idle = idleFixture(), mails = [mail(17610), mail(17611, "two")];
  const settings = { enabled: true, idleAutomatic: true, accountIds: ["one","two"], notifications: false };
  const h = await harness({ mails, configureIdle: idle.api, saved:{settings} });
  for (const message of mails) await h.events.newMail.listeners[0](message.folder,{messages:[message]});
  await h.send("settings",{settings:{...settings,accountIds:["one"]}});
  await h.send("settings",{settings});
  const state = await settle(h, value => value.incomingCount === 1 && value.records.some(item => item.unscannedReason === "automaticExcluded"));
  assert.equal(state.incomingCount, 1);
  idle.change("idle");
  await settle(h, value => value.records.some(item => item.status === "clean"));
  assert.deepEqual(h.rawReads,[mails[0].id]);
});

test("a failed scanner-slot write retains the receipt and clears its warning on recovery", async () => {
  const idle = idleFixture(), incoming = mail(17620);
  const settings = {enabled:true,idleAutomatic:true,accountIds:["one"],notifications:false};
  const h = await harness({mails:[incoming],configureIdle:idle.api,saved:{settings}});
  await h.events.newMail.listeners[0](incoming.folder,{messages:[incoming]});
  const write = h.api.storage.local.set;
  h.api.storage.local.set = async patch => {
    if (Object.keys(patch).some(key => key.startsWith("historyPage:"))) throw Error("slot unavailable");
    return write(patch);
  };
  idle.change("idle");
  const stalled = await settle(h,value => value.issue.includes("slot unavailable"));
  assert.equal(stalled.incomingCount,1);
  assert.deepEqual(h.rawReads,[]);
  h.api.storage.local.set = write;
  await h.timers[0]();
  await settle(h,value => !value.issue && !value.incomingCount && value.records[0]?.status === "clean");
});

test("an older independent receipt is inspected before a destination staged for move verification", async () => {
  const original = mail(17700), older = mail(17702);
  original.folder.id = "inbox";
  const destination = { ...original, id:17701, folder:{accountId:"one",id:"dest",path:"/Dest"}, raw:"Subject: changed\r\n\r\nchanged" };
  const h = await harness({mails:[original,older,destination],
    saved:{settings:{enabled:true,accountIds:["one"],notifications:false}}});
  const raw = h.api.messages.getRaw;
  let start, resume;
  const started = new Promise(resolve => { start = resolve; });
  const paused = new Promise(resolve => { resume = resolve; });
  h.api.messages.getRaw = async (id, options) => {
    const file = await raw(id, options);
    if (id === original.id) { start(); await paused; }
    return file;
  };
  await h.events.newMail.listeners[0](original.folder,{messages:[original]});
  await started;
  await h.events.newMail.listeners[0](older.folder,{messages:[older]});
  await h.events.newMail.listeners[0](destination.folder,{messages:[destination]});
  await h.events.moved.listeners[0]({messages:[original]},{messages:[destination]});
  resume();
  await settle(h,state => !state.incomingCount && state.records.filter(item => item.status === "clean").length === 2);
  assert(h.rawReads.indexOf(older.id) < h.rawReads.lastIndexOf(destination.id));
});

test("one surviving same-folder copy cannot stand in for two receipts after restart", async () => {
  const original = mail(17800), copy = {...original,id:17801};
  const settings = {enabled:true,idleAutomatic:true,accountIds:["one"],notifications:false};
  const records = Array.from({length:1000},(_,i)=>({key:"held-"+i,status:"detected",locator:{accountId:"one"}}));
  const h = await harness({mails:[original,copy],configureIdle:idleFixture().api,saved:{settings,records}});
  await h.events.newMail.listeners[0](original.folder,{messages:[original,copy]});
  const restarted = await harness({mails:[copy],configureIdle:idleFixture("idle").api,saved:h.rawStored()});
  const result = await settle(restarted,state=>state.overflowReport?.total === 2);
  assert.equal(result.overflowReport.counts.incomplete,2);
  assert(result.overflowReport.recent.every(record=>record.unscannedReason === "ambiguousMessage"));
  assert.deepEqual(restarted.rawReads,[]);
});

test("unverified moved candidates scan separately and cannot authorize deletion of the original", async () => {
  const origin = mail(19300), moved = {...origin,id:19301,folder:{accountId:"one",path:"/Archive"}};
  const record = {key:"receipt", status:"incomplete", source:"automatic", session:"old", messageId:origin.id,
    locator:locator(origin), unscannedReason:"unverifiedLocation", sha256:null};
  const h = await harness({mails:[moved], deleteAllowed:true, saved:{records:[record]}});
  const keys = [record.key];
  const prep = await h.send("prepareDeleteBatch", {keys, recover:true});
  assert.deepEqual(prep.failures.map(item => item.key), keys);
  assert.equal(prep.token, undefined);
  assert.equal((await h.send("checkRetryTargets",{keys})).failures.length,1);
  const result = await h.send("locateHistory",{key:record.key});
  assert.deepEqual(result.candidates.map(item=>item.folder.path), ["/Archive"]);
  const candidate = result.candidates[0];
  const request = {key:record.key, messageId:candidate.id, position:candidate.position, session:result.session};
  assert.equal((await h.send("scanHistoryCandidate",{...request,position:"stale"})).ok,false);
  assert.equal((await h.send("scanHistoryCandidate",request)).ok,true);
  const state = await settle(h, state=>state.records.some(item=>item.status==="clean"));
  const original = state.records.find(item=>item.key===record.key);
  assert.equal(original.locator.folder.path,"/Inbox");
  assert.equal(original.status,"incomplete");
  assert.equal(original.candidateScanKey,state.records.find(item=>item.status==="clean").key);
  assert.equal((await h.send("prepareDelete",{key:record.key})).ok,false);
  assert.deepEqual(h.deleted,[]);
});

test("finding a unique digest updates the location; identical copies remain choices", async () => {
  const original = mail(19310), moved = {...original,id:19311,folder:{accountId:"one",path:"/Archive"}};
  const hash = await sha256(new TextEncoder().encode("Subject: example\r\n\r\nhello"));
  const record = {key:"result",status:"detected",source:"automatic",locator:locator(original),sha256:hash};
  const h = await harness({mails:[moved], saved:{records:[record]}});
  assert.equal((await h.send("locateHistory",{key:"result"})).verified,true);
  assert.equal(h.stored().records[0].locator.folder.path,"/Archive");
  const second = await harness({mails:[original,moved],saved:{records:[record]}});
  assert.equal((await second.send("locateHistory",{key:"result"})).candidates.length,2);
  assert.deepEqual(second.deleted,[]);
});

test("bulk candidate scan rechecks uniqueness and reuses a previously scanned candidate on the next search", async () => {
  const origin = mail(19400), moved = {...origin, id:19401, folder:{accountId:"one",path:"/Filed"}};
  const mails = [moved];
  const record = {key:"receipt",status:"incomplete",source:"automatic",session:"old",messageId:origin.id,
    locator:locator(origin),unscannedReason:"unverifiedLocation",sha256:null};
  const h = await harness({mails,saved:{records:[record]}});
  const lookup = () => h.send("locateHistory",{key:record.key,bulk:true});
  const result = await lookup();
  const options = {key:record.key,bulk:true,previousKey:null,messageId:moved.id,session:result.session,position:result.candidates[0].position};
  mails.push({...moved,id:19402});
  assert.equal((await h.send("scanHistoryCandidate",options)).ok,false);
  assert.equal((await lookup()).candidates.length,2);
  mails.pop();
  const accepted = await h.send("scanHistoryCandidate",options);
  assert.ok(accepted.candidateKey);
  assert.equal((await h.send("scanHistoryCandidate",options)).ok,false);
  await settle(h,state => state.records.some(item => item.key === accepted.candidateKey && item.status === "clean"));
  assert.equal((await lookup()).candidateKey,accepted.candidateKey);
  assert.equal(h.stored().records.length,2);
  assert.equal(h.stored().records.find(item=>item.key===record.key).status,"incomplete");
  assert.deepEqual(h.deleted,[]);
});

for (const verdict of ["clean","detected","incomplete"]) test("idle scans a unique moved candidate in its original row: "+verdict, async () => {
  const origin = {...mail(19500),size:120}, moved = {...origin,id:19501,size:150,folder:{id:"filed",path:"/Filed",accountId:"one"}};
  const idle = idleFixture();
  const destination = {id:"q",path:"/Q",accountId:"one"};
  const h = await harness({mails:[moved],configureIdle:idle.api,deleteAllowed:true,scanResult:{status:verdict},folderRefs:[moved.folder,destination],
    saved:{settings:{enabled:true,idleAutomatic:true,accountIds:["one"],notifications:false,
      quarantine:{one:{folderId:"q",path:"/Q",auto:true,activation:"on"}}}}});
  await h.events.newMail.listeners[0](origin.folder,{messages:[origin]});
  const receipt = Object.entries(h.rawStored()).find(([key]) => key.startsWith("incomingReceipt:"))[1];
  assert.deepEqual(h.rawReads,[]);
  idle.change("idle");
  const state = await settle(h,s=>!s.incomingCount && s.records[0]?.status===verdict);
  const [row] = state.records;
  assert.equal(state.records.length,1);
  assert.equal(row.key,receipt.key);
  assert.equal(row.locator.folder.path,"/Filed");
  assert.equal(row.candidateOrigin.locator.folder.path,"/Inbox");
  assert.deepEqual(row.candidateOrigin.differences,["folder","size","id"]);
  assert.ok(row.sha256);
  assert.equal(row.quarantineIntent,null);
  assert.equal(row.quarantine,undefined);
  if (verdict==="detected") {
    const confirmation = await h.send("prepareDelete",{key:row.key});
    assert.equal(confirmation.isCandidate,true);
    moved.raw = "changed contents";
    assert.equal((await h.send("deletePermanently",{key:row.key,token:confirmation.token})).ok,false);
    assert.deepEqual(h.deleted,[]);
    delete moved.raw;
    h.api.permissions.contains = async () => true;
    h.api.folders.getFolderCapabilities = async () => ({canAddMessages:true,canDeleteMessages:true});
    h.api.messages.move = async ids => { assert.deepEqual(ids,[moved.id]); moved.folder=destination; };
    const isolated = await h.send("quarantineMany",{keys:[row.key],hashes:{[row.key]:row.sha256},
      destinations:state.settings.quarantine});
    assert.equal(isolated.moved,1);
    const again = await h.send("prepareDelete",{key:row.key});
    assert.equal((await h.send("deletePermanently",{key:row.key,token:again.token})).ok,true);
    assert.deepEqual(h.deleted[0].ids,[moved.id]);
  }
});

test("old unresolved receipts recover when idle without changing human-reviewed history",async()=>{
  const mailNow = mail(19600), idle = idleFixture();
  const prior = {key:"old",source:"automatic",status:"incomplete",unscannedReason:"unverifiedLocation",
    locator:locator(mailNow),sha256:null,attempts:2};
  const h=await harness({mails:[mailNow],configureIdle:idle.api,saved:{records:[prior,{...prior,key:"reviewed",review:{note:"human"}}],
    settings:{enabled:true,idleAutomatic:true,accountIds:["one"],notifications:false}}});
  assert.deepEqual(h.rawReads,[]);
  idle.change("idle");
  const state=await settle(h,s=>s.records[0].status==="clean");
  assert.deepEqual(state.records[0].candidateOrigin.differences,["previous"]);
  assert.equal(state.records[1].status,"incomplete");
  assert.equal(state.records[1].review.note,"human");
});

test("a candidate that moves during body retrieval cannot acquire a verdict or a deletion ticket",async()=>{
  const origin = mail(19700), moved = {...origin,id:19701,folder:{accountId:"one",path:"/Filed"}};
  const h = await harness({mails:[moved],deleteAllowed:true,saved:{settings:{enabled:true,accountIds:["one"],notifications:false}},
    configureMessages:api=>{
      const read = api.getRaw;
      api.getRaw=async (...args)=>{
        const data=await read(...args);
        moved.folder={accountId:"one",path:"/Elsewhere"};
        return data;
      };
    }});
  await h.events.newMail.listeners[0](origin.folder,{messages:[origin]});
  const state=await settle(h,s=>s.records[0]?.status==="error");
  const [row]=state.records;
  assert.ok(row.candidateAttempt);
  assert.equal(row.candidateOrigin,undefined);
  assert.equal(row.sha256,null);
  assert.equal(row.locator.folder.path,"/Inbox");
  assert.equal((await h.send("prepareDelete",{key:row.key})).ok,false);
  assert.deepEqual(h.deleted,[]);
});


test("settings save rejects a stale draft inside the serialized write queue", async () => {
  const h = await harness();
  const original = (await h.send("state")).settings;
  const expectedSettings = JSON.stringify(original);
  const first = h.send("settings", {settings:{...original,notifications:false},expectedSettings});
  const second = h.send("settings", {settings:{...original,enabled:true,accountIds:["one"]},expectedSettings});
  assert.equal((await first).ok,true);
  assert.equal((await second).ok,false);
  const state = await h.send("state");
  assert.equal(state.settings.notifications,false);
  assert.equal(state.settings.enabled,false);
});

for (const outcome of ["moved", "empty", "ambiguous"]) test("zero-byte automatic read retries once: " + outcome, async () => {
  const origin = mail(19700), mails = [origin];
  const idle = idleFixture();
  const h = await harness({ mails, configureIdle: idle.api,
    saved: { settings: { enabled: true, idleAutomatic: true, accountIds: ["one"] } } });
  h.api.messages.getRaw = async () => new File([], "empty.eml");
  await h.events.newMail.listeners[0](origin.folder, { messages: [origin] });
  idle.change("idle");
  const first = await settle(h, state => state.records[0]?.nextRetry && state.records[0].status === "queued");
  const row = first.records[0];
  assert.equal(row.attempts, 1);
  idle.change("active");
  row.nextRetry = 1;
  if (outcome !== "empty") {
    const moved = { ...origin, id: 19701, folder: { accountId: "one", path: "/Filed" } };
    mails.splice(0, outcome === "moved" ? 1 : 0, moved);
    const get = h.api.messages.get;
    h.api.messages.get = async id => id === moved.id ? moved : get(id);
    h.api.messages.getRaw = async () => new File(["Subject: example\r\n\r\nbody"], "mail.eml");
  }
  h.timers[0]();
  assert.equal(row.attempts, 1);
  idle.change("idle");
  const final = await settle(h, state => ["clean", "incomplete"].includes(state.records[0]?.status));
  assert.equal(final.records.length, 1);
  assert.equal(row.key, final.records[0].key);
  assert.equal(row.attempts, 2);
  assert.equal(row.nextRetry, null);
  if (outcome === "moved") {
    assert.equal(row.status, "clean");
    assert.equal(row.locator.folder.path, "/Filed");
  } else {
    assert.equal(row.unscannedReason, outcome === "empty" ? "emptyRead" : "ambiguousMessage");
  }
});
