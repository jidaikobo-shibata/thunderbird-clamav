import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "../thunderbird/core.mjs";

function event() {
  const listeners = [];
  return { listeners, addListener(listener, ...args) { listeners.push(listener); this.args = args; } };
}

let caseId = 0;
async function harness({ saved = {}, mails = [], nativeFailure = false, oversized = false } = {}) {
  let stored = structuredClone(saved);
  const notifications = [], opened = [], rawReads = [], timers = [];
  const events = { newMail: event(), selected: event(), message: event() };
  const byId = new Map(mails.map(mail => [mail.id, mail]));
  const api = {
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
                request.op === "end" ? { status: "clean", detail: "未検出", sha256: request.sha256, signatures: [] } :
                  { status: "accepted", seq: request.seq + 1 };
              port.onMessage.listeners[0]({ id: request.id, ...result });
            });
          } };
        return port;
      }
    },
    messages: {
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
  return { api, send, events, notifications, opened, rawReads, timers, stored: () => stored };
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
  assert.equal(h.api.messages.delete, undefined);
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
