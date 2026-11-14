import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "../thunderbird/core.mjs";

function event() {
  const listeners = [];
  return { listeners, addListener(listener, ...args) { listeners.push(listener); this.args = args; } };
}

let caseId = 0;
async function harness({ saved = {}, mails = [], nativeFailure = false, oversized = false, deleteAllowed = false, deleteFailure = false, scanResult = {} } = {}) {
  let stored = structuredClone(saved);
  const notifications = [], opened = [], rawReads = [], timers = [], deleted = [];
  const events = { newMail: event(), selected: event(), message: event() };
  const byId = new Map(mails.map(mail => [mail.id, mail]));
  const api = {
    permissions: { contains: async () => deleteAllowed },
    storage: { local: { get: async () => structuredClone(stored), set: async value => { stored = structuredClone(value); } } },
    runtime: {
      id: "unit", getURL: path => "moz-extension://unit/" + path,
      onMessage: events.message, onInstalled: event(),
      connectNative() {
        const port = { onMessage: event(), onDisconnect: event(), disconnect() {},
          postMessage(request) {
            queueMicrotask(() => {
              if (nativeFailure) { port.onDisconnect.listeners[0](); return; }
              const result = request.op === "health" ? { status: "ready", protocol: 1, engine: "test" } :
                request.op === "end" ? { status: "clean", detail: "未検出", sha256: request.sha256, signatures: [], ...scanResult } :
                  { status: "accepted", seq: request.seq + 1 };
              port.onMessage.listeners[0]({ id: request.id, ...result });
            });
          } };
        return port;
      }
    },
    messages: {
      delete: async (ids, options) => {
        if (deleteFailure) throw new Error("server refused deletion");
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
      continueList: async () => ({ messages: [] })
    },
    accounts: { list: async () => [{ id: "one", name: "one", type: "imap" }, { id: "two", name: "two", type: "imap" }] },
    menus: { onClicked: event(), create() {}, removeAll: async () => {} },
    mailTabs: { onSelectedMessagesChanged: events.selected, query: async () => [{ id: 7, active: true }],
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
  return { api, send, events, notifications, opened, rawReads, timers, deleted, stored: () => stored };
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

test("uninfected and ambiguous mail cannot be prepared for deletion", async () => {
  const { h } = await deletionFixture();
  await h.send("retry", { key: "threat" });
  await settle(h, value => value.records[0]?.status === "clean");
  assert.equal((await h.send("prepareDelete", { key: "threat" })).ok, false);
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
