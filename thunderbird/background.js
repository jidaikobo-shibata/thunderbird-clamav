import {
  MAX_BYTES, DEFAULTS, LABELS, NativeClient, accountOf, locator, sameEnvelope,
  validateSettings, messagePages, sha256, needsAttention
} from "./core.mjs";

const api = messenger;
const session = crypto.randomUUID();
const MAX_RECORDS = 1000;
let settings = { ...DEFAULTS };
let records = [];
let issue = "";
let running = false;
let lastMailTab;
let writes = Promise.resolve();
let mutations = Promise.resolve();

function report(error) {
  issue = error instanceof Error ? error.message : String(error);
  void updateBadge();
}

function save() {
  // Take a snapshot now, then serialize storage writes so an older snapshot
  // cannot overwrite a later scan result.
  const value = JSON.parse(JSON.stringify({ settings, records, issue }));
  writes = writes.catch(() => {}).then(() => api.storage.local.set(value));
  return writes;
}

async function updateBadge() {
  const count = records.filter(needsAttention).length;
  await api.browserAction.setBadgeText({ text: issue ? "!" : count ? String(count) : "" });
  await api.browserAction.setBadgeBackgroundColor({ color: "#9d281b" });
}

async function notify(record) {
  if (!settings.notifications || !needsAttention(record)) return;
  // Subjects/senders are deliberately omitted from lock-screen notifications.
  try {
    await api.notifications.create(record.key, {
      type: "basic", iconUrl: api.runtime.getURL("icon.svg"),
      title: "ClamAV：" + LABELS[record.status],
      message: "Thunderbirdの検査結果画面で対象メールを確認してください。"
    });
  } catch { issue = "デスクトップ通知を表示できません。結果画面を確認してください。"; }
}

async function openDashboard() {
  const url = api.runtime.getURL("dashboard.html");
  const tabs = await api.tabs.query({});
  const existing = tabs.find(tab => tab.url === url);
  if (existing) {
    await api.tabs.update(existing.id, { active: true });
    await api.windows.update(existing.windowId, { focused: true });
  } else {
    await api.tabs.create({ url });
  }
}

async function rawBytes(messageId) {
  // Never request decryption: this version must not prompt for keys or store
  // decrypted mail. Encrypted MIME is explicitly marked incomplete by the host.
  const raw = await api.messages.getRaw(messageId, { data_format: "File", decrypt: false });
  if (!raw || typeof raw.arrayBuffer !== "function") {
    throw new Error("メールデータをFile形式で取得できませんでした。");
  }
  if (!raw.size || raw.size > MAX_BYTES) {
    const error = new Error("メールが空か、検査上限の25MiBを超えています。");
    error.incomplete = true;
    throw error;
  }
  return new Uint8Array(await raw.arrayBuffer());
}

async function resolveRecord(record) {
  // A persisted Thunderbird numeric ID must never be reused after restart.
  if (record.session === session && Number.isInteger(record.messageId)) {
    try {
      const message = await api.messages.get(record.messageId);
      if (sameEnvelope(message, record.locator)) return message;
    } catch { /* Moved/deleted messages are resolved below. */ }
  }
  if (!record.locator.headerMessageId) {
    throw new Error("対象を再特定できません。Thunderbirdで選択して再検査してください。");
  }
  const candidates = [];
  const first = await api.messages.query({ headerMessageId: record.locator.headerMessageId });
  for await (const message of messagePages(api.messages, first)) {
    if (sameEnvelope(message, record.locator)) candidates.push(message);
    if (candidates.length > 20) throw new Error("同じ識別情報のメールが多いため、対象を特定できません。");
  }
  const matches = [];
  for (const candidate of candidates) {
    if (!record.sha256 || await sha256(await rawBytes(candidate.id)) === record.sha256) {
      matches.push(candidate);
    }
  }
  if (matches.length !== 1) {
    throw new Error("対象メールが存在しないか、複数候補があり特定できません。選択して再検査してください。");
  }
  record.messageId = matches[0].id;
  record.session = session;
  record.locator = locator(matches[0]);
  return matches[0];
}

function enqueue(first, source) {
  const work = async () => {
    let overflow = false;
    for await (const message of messagePages(api.messages, first)) {
      if (message.external || !message.folder) continue;
      if (source === "automatic" && (!settings.enabled ||
          !settings.accountIds.includes(accountOf(message)))) continue;
      const existing = records.find(record => record.session === session && record.messageId === message.id);
      if (existing && ["queued", "scanning"].includes(existing.status)) continue;
      if (existing && source === "automatic") continue;
      // Only discard old non-alert results when the bounded history is full.
      if (!existing && records.length >= MAX_RECORDS) {
        const index = records.findIndex(record => record.status === "clean");
        if (index === -1) { overflow = true; continue; }
        records.splice(index, 1);
      }
      const record = existing || { key: crypto.randomUUID(), createdAt: new Date().toISOString() };
      Object.assign(record, {
        messageId: message.id, session, locator: locator(message), source,
        status: "queued", detail: "検査を待っています。", signatures: [],
        sha256: null, engine: null, attempts: 0, nextRetry: null, updatedAt: new Date().toISOString()
      });
      if (!existing) records.push(record);
    }
    if (overflow) issue = "結果が1000件に達しました。新着の一部を検査できません。履歴を整理してください。";
    await save();
    await updateBadge();
    void drain().catch(report);
  };
  mutations = mutations.catch(() => {}).then(work);
  return mutations;
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (true) {
      const record = records.find(item => item.status === "queued" &&
        (item.source === "manual" || (settings.enabled && settings.accountIds.includes(item.locator.accountId))));
      if (!record) break;
      record.status = "scanning";
      record.detail = "メールを取得して検査しています。";
      record.attempts++;
      record.updatedAt = new Date().toISOString();
      await save();
      let client;
      try {
        const message = await resolveRecord(record);
        if (message.headersOnly) {
          throw new Error("ヘッダーのみ取得されたメールです。本文をダウンロードして再検査してください。");
        }
        const bytes = await rawBytes(message.id);
        record.sha256 = await sha256(bytes);
        client = new NativeClient(api.runtime);
        const health = await client.request("health");
        if (health.status !== "ready" || health.protocol !== 1) {
          throw new Error(health.detail || "補助プログラムのバージョンが対応していません。");
        }
        record.engine = health.engine;
        const result = await client.scan(bytes, record.sha256);
        record.status = result.status;
        record.detail = result.detail;
        record.signatures = result.signatures || [];
        record.nextRetry = null;
      } catch (error) {
        record.status = error.incomplete ? "incomplete" : "error";
        record.detail = error.message || "検査に失敗しました。";
      } finally {
        client?.close();
      }
      record.updatedAt = new Date().toISOString();
      // Two automatic attempts total; no endless retry loop on bad mail/host.
      if (record.status === "error" && record.attempts < 2) {
        record.nextRetry = Date.now() + 60000;
      }
      await save();
      await notify(record);
      await updateBadge();
    }
  } catch (error) {
    const active = records.find(record => record.status === "scanning");
    if (active) {
      active.status = "error";
      active.detail = "検査状態の保存に失敗しました。保存領域を確認して再検査してください。";
    }
    throw error;
  } finally { running = false; }
}

async function scanSelection() {
  if (lastMailTab === undefined) {
    const tabs = await api.mailTabs.query({});
    lastMailTab = (tabs.find(tab => tab.active) || tabs[0])?.id;
  }
  if (lastMailTab === undefined) throw new Error("メール一覧で対象を選択してください。");
  const selected = await api.mailTabs.getSelectedMessages(lastMailTab);
  if (!selected.messages.length) throw new Error("メール一覧で対象を選択してください。");
  await enqueue(selected, "manual");
}

const ready = (async () => {
  const data = await api.storage.local.get(["settings", "records", "issue"]);
  settings = { ...DEFAULTS, ...data.settings };
  records = Array.isArray(data.records) ? data.records : [];
  issue = typeof data.issue === "string" ? data.issue : "";
  for (const record of records) {
    record.messageId = null;
    record.session = null;
    if (record.status === "scanning") {
      record.status = "queued";
      record.detail = "前回中断された検査を再開します。";
    }
  }
  await api.menus.removeAll();
  api.menus.create({ id: "scan", title: "ClamAVで選択メールを検査", contexts: ["message_list"] });
  await save();
  await updateBadge();
})().catch(error => { report(error); throw error; });

api.messages.onNewMailReceived.addListener((folder, list) => {
  void ready.then(() => enqueue(list, "automatic")).catch(report);
}, true);
api.mailTabs.onSelectedMessagesChanged.addListener(tab => { lastMailTab = tab.id; });
api.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "scan") return;
  if (tab?.id !== undefined) lastMailTab = tab.id;
  void ready.then(() => info.selectedMessages ? enqueue(info.selectedMessages, "manual") : scanSelection())
    .then(openDashboard).catch(report);
});
api.browserAction.onClicked.addListener(() => { void openDashboard().catch(report); });
api.notifications.onClicked.addListener(() => { void openDashboard().catch(report); });
api.runtime.onInstalled.addListener(() => { void openDashboard().catch(report); });

api.runtime.onMessage.addListener(async (request, sender) => {
  if (sender.id !== api.runtime.id || sender.url !== api.runtime.getURL("dashboard.html")) return undefined;
  await ready;
  try {
    switch (request.type) {
      case "state":
        return { ok: true, settings, records, issue, accounts: (await api.accounts.list())
          .filter(account => ["imap", "pop3", "none"].includes(account.type))
          .map(account => ({ id: account.id, name: account.name, type: account.type })) };
      case "settings": {
        const ids = (await api.accounts.list()).map(account => account.id);
        settings = validateSettings(request.settings, ids);
        await save();
        void drain().catch(report);
        return { ok: true };
      }
      case "health": {
        const client = new NativeClient(api.runtime);
        try { return { ok: true, health: await client.request("health") }; }
        finally { client.close(); }
      }
      case "scanSelection":
        await scanSelection();
        return { ok: true };
      case "retry": {
        const record = records.find(item => item.key === request.key);
        if (!record || ["scanning", "queued"].includes(record.status)) {
          throw new Error("この結果は再検査できません。");
        }
        record.status = "queued";
        record.source = "manual";
        record.attempts = 0;
        record.nextRetry = null;
        await save();
        void drain().catch(report);
        return { ok: true };
      }
      case "open": {
        const record = records.find(item => item.key === request.key);
        if (!record || !record.sha256) throw new Error("検査対象を照合できません。メール一覧から確認してください。");
        const message = await resolveRecord(record);
        if (await sha256(await rawBytes(message.id)) !== record.sha256) {
          throw new Error("メール内容が検査時から変わっています。再検査してください。");
        }
        await api.messageDisplay.open({ messageId: message.id, location: "tab" });
        return { ok: true };
      }
      case "clear":
        // This removes only generated results, never messages. The page asks
        // for confirmation before sending this request.
        records = records.filter(record => ["scanning", "queued"].includes(record.status));
        issue = "";
        await save();
        await updateBadge();
        return { ok: true };
      default: throw new Error("未対応の操作です。");
    }
  } catch (error) { return { ok: false, error: error.message || "操作に失敗しました。" }; }
});

// Timers are sufficient for a persistent MV2 background page. Restart recovery
// uses persisted records, not timers or Thunderbird's ephemeral numeric IDs.
setInterval(() => {
  void ready.then(async () => {
    for (const record of records) {
      if (record.status === "error" && record.nextRetry && record.nextRetry <= Date.now() &&
          (record.source === "manual" || (settings.enabled && settings.accountIds.includes(record.locator.accountId)))) {
        record.status = "queued";
        record.nextRetry = null;
      }
    }
    await drain();
  }).catch(report);
}, 10000);
void ready.then(drain).catch(report);
