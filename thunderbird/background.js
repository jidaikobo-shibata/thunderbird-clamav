import {
  MAX_BYTES, DEFAULTS, LABELS, NativeClient, accountOf, locator, sameEnvelope,
  validateSettings, messagePages, sha256, needsAttention
} from "./core.mjs";
import { FolderScan, FOLDER_STATES, realFolder } from "./folder-scan.mjs";

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
const deletionTickets = new Map();
const deleting = new Set();
const batchTickets = new Map();
let batchProgress = null;
let folderRequest = null;
const folderScan = new FolderScan(api, {
  changed: () => save(), wake: () => { void drain().catch(report); },
  finished: async job => {
    if (!settings.notifications) return;
    try {
      await api.notifications.create("folder-" + job.id, { type: "basic", iconUrl: api.runtime.getURL("icon.svg"),
        title: "ClamAV：フォルダー検査 " + FOLDER_STATES[job.status],
        message: `処理済み${job.completed}件、検出${job.counts.detected}件、未検査${job.counts.incomplete}件、失敗${job.counts.error}件。結果画面を確認してください。` });
    } catch { issue = "フォルダー検査の通知を表示できません。結果画面を確認してください。"; }
  }
});

async function chooseFolder(folder) {
  if (folderScan.active) throw new Error("フォルダー検査は既に実行中です。");
  const current = folder?.id ? await api.folders.get(folder.id, false) : folder;
  if (!realFolder(current)) throw new Error("通常のメールフォルダーを1つ選択してください。統合・検索・タグの仮想フォルダーは対象外です。");
  folderRequest = { token: crypto.randomUUID(), folder: { id: current.id, accountId: current.accountId,
    path: current.path, name: current.name || current.path } };
  return folderRequest;
}

async function currentFolder() {
  const tabs = await api.mailTabs.query({});
  const tab = tabs.find(tab => tab.id === lastMailTab) || tabs.find(tab => tab.active) || tabs[0];
  if (!tab) throw new Error("Thunderbirdのフォルダー一覧で対象を選択してください。");
  const full = await api.mailTabs.get(tab.id);
  return chooseFolder(full.displayedFolder);
}

function deletable(key) {
  const record = records.find(item => item.key === key);
  if (!record || record.status !== "detected" || !record.sha256) {
    throw new Error("脅威候補を検出した、未削除のメールだけが対象です。");
  }
  return record;
}

function position(message) {
  return JSON.stringify([message.id, message.folder?.accountId, message.folder?.path, message.folder?.id]);
}

async function verified(record) {
  const message = await resolveRecord(record);
  if (message.external || !message.folder || await sha256(await rawBytes(message.id)) !== record.sha256) {
    throw new Error("対象メールが検査時と一致しません。再検査してください。");
  }
  return message;
}

function requestedKeys(keys) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 100 ||
      keys.some(key => typeof key !== "string") || new Set(keys).size !== keys.length) {
    throw new Error("一括操作は重複のない1〜100件を選択してください。");
  }
  return keys;
}

async function prepareBatch(keys) {
  requestedKeys(keys);
  if (batchProgress?.active) throw new Error("一括削除の処理中です。");
  if (!await api.permissions.contains({ permissions: ["messagesDelete"] })) {
    throw new Error("設定タブの「完全削除を許可」から権限を許可してください。");
  }
  const tickets = [], targets = [], positions = new Set();
  for (const key of keys) {
    const record = deletable(key);
    if (deleting.has(key)) throw new Error("削除処理中のメールがあります。");
    const hash = record.sha256;
    const message = await verified(record);
    if (deletable(key).sha256 !== hash) throw new Error("検査結果が変わりました。選び直してください。");
    const place = position(message);
    if (positions.has(place)) throw new Error("同じメールを指す履歴が含まれています。重複を外してください。");
    positions.add(place);
    tickets.push({ key, hash, position: place });
    targets.push({ key, author: message.author || "差出人なし", subject: message.subject || "件名なし",
      accountId: message.folder.accountId, folder: message.folder.path || message.folder.name || "",
      signatures: record.signatures || [] });
  }
  for (const [token, batch] of batchTickets) {
    if (batch.expires < Date.now()) batchTickets.delete(token);
  }
  if (batchTickets.size >= 10) throw new Error("未完了の確認が多いため、ほかの確認画面を閉じてやり直してください。");
  const token = crypto.randomUUID();
  batchTickets.set(token, { tickets, expires: Date.now() + 300000 });
  return { ok: true, token, targets };
}


async function executeDeletion(ticket) {
  if (deleting.has(ticket.key)) throw new Error("このメールは削除処理中です。");
  deleting.add(ticket.key);
  try {
    if (!await api.permissions.contains({ permissions: ["messagesDelete"] })) {
      throw new Error("完全削除の権限がありません。");
    }
    const record = deletable(ticket.key);
    if (record.sha256 !== ticket.hash) throw new Error("検査結果が変わりました。再確認してください。");
    const message = await verified(record);
    // Never follow a move/replacement after the user saw the confirmation.
    const current = await api.messages.get(message.id);
    if (position(current) !== ticket.position || !sameEnvelope(current, record.locator) ||
        deletable(ticket.key).sha256 !== ticket.hash) {
      throw new Error("確認後にメールの場所や検査結果が変わりました。再確認してください。");
    }
    await api.messages.delete([current.id], { deletePermanently: true, isUserAction: true });
    record.status = "deleted";
    record.deletedAt = new Date().toISOString();
    record.updatedAt = record.deletedAt;
    record.nextRetry = null;
    record.detail = "ごみ箱を経由せず完全削除しました。元には戻せません。";
    try { await save(); }
    catch { issue = "メールの削除は完了しましたが、履歴を保存できませんでした。"; }
    await updateBadge().catch(report);
    return { ok: true };
  } finally { deleting.delete(ticket.key); }
}

function report(error) {
  issue = error instanceof Error ? error.message : String(error);
  void updateBadge();
}

function save() {
  // Take a snapshot now, then serialize storage writes so an older snapshot
  // cannot overwrite a later scan result.
  const value = JSON.parse(JSON.stringify({ settings, records, issue, folderJob: folderScan.snapshot() }));
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
      if (existing && (deleting.has(existing.key) || existing.status === "deleted")) continue;
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
        sha256: null, engine: null, attempts: 0, nextRetry: null, folderJobId: null, updatedAt: new Date().toISOString()
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
      // Folder work is fed one at a time, after fresh mail and manual work.
      let record = records.find(item => item.status === "queued" && item.source === "automatic" &&
        settings.enabled && settings.accountIds.includes(item.locator.accountId)) ||
        records.find(item => item.status === "queued" && item.source === "manual");
      if (!record && folderScan.available()) {
        if (records.length >= MAX_RECORDS) {
          const index = records.findIndex(item => item.status === "clean");
          if (index === -1) {
            await folderScan.finish("blocked", "検出・未検査・失敗などの履歴で上限1000件に達したため停止しました。履歴を確認・整理し、改めて開始してください。");
            continue;
          }
          records.splice(index, 1);
        }
        const message = folderScan.take();
        if (message) {
          record = { key: crypto.randomUUID(), createdAt: new Date().toISOString(),
            messageId: message.id, session, locator: locator(message), source: "folder",
            status: "queued", detail: "フォルダー検査を待っています。", signatures: [],
            sha256: null, engine: null, attempts: 0, nextRetry: null, folderJobId: folderScan.job.id,
            updatedAt: new Date().toISOString() };
          records.push(record);
        }
      }
      if (!record) break;
      const fromFolder = record.source === "folder";
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
      if (!fromFolder && record.status === "error" && record.attempts < 2) {
        record.nextRetry = Date.now() + 60000;
      }
      if (fromFolder) {
        const flag = record.status === "detected" ? "notifiedDetection" :
          ["incomplete", "error"].includes(record.status) ? "notifiedProblem" : null;
        if (flag && !folderScan.job[flag]) {
          folderScan.job[flag] = true;
          void notify(record);
        }
        await folderScan.complete(record.status);
      }
      await save();
      if (!fromFolder) await notify(record);
      await updateBadge();
    }
  } catch (error) {
    const active = records.find(record => record.status === "scanning");
    if (active) {
      active.status = "error";
      active.detail = "検査状態の保存に失敗しました。保存領域を確認して再検査してください。";
    }
    if (folderScan.active) {
      await folderScan.finish("error", "検査状態の保存などに失敗したため停止しました。結果を確認して改めて開始してください。").catch(() => {});
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
  const data = await api.storage.local.get(["settings", "records", "issue", "folderJob"]);
  settings = { ...DEFAULTS, ...data.settings };
  records = Array.isArray(data.records) ? data.records : [];
  issue = typeof data.issue === "string" ? data.issue : "";
  folderScan.restore(data.folderJob);
  for (const record of records) {
    record.messageId = null;
    record.session = null;
    if (record.status === "scanning" || (record.source === "folder" && record.status === "queued")) {
      record.status = record.source === "folder" ? "error" : "queued";
      record.detail = record.source === "folder" ? "フォルダー検査中に終了したため、このメールの結果は未確認です。" : "前回中断された検査を再開します。";
      if (record.source === "folder") record.nextRetry = null;
    }
  }
  await api.menus.removeAll();
  api.menus.create({ id: "scan", title: "ClamAVで選択メールを検査", contexts: ["message_list"] });
  api.menus.create({ id: "scan-folder", title: "ClamAVでフォルダーを検査", contexts: ["folder_pane"] });
  await save();
  await updateBadge();
})().catch(error => { report(error); throw error; });

api.messages.onNewMailReceived.addListener((folder, list) => {
  void ready.then(() => enqueue(list, "automatic")).catch(report);
}, true);
api.mailTabs.onSelectedMessagesChanged.addListener(tab => { lastMailTab = tab.id; });
api.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "scan-folder") {
    void ready.then(async () => {
      if (!folderScan.active) {
        const folders = info.selectedFolders || (info.selectedFolder ? [info.selectedFolder] : []);
        if (folders.length !== 1) throw new Error("フォルダーを1つ選択してください。");
        await chooseFolder(folders[0]);
      }
      await openDashboard();
    }).catch(report);
    return;
  }
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
        return { ok: true, settings, records, issue, batch: batchProgress, folderRequest,
          folderJob: folderScan.snapshot(), accounts: (await api.accounts.list())
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
      case "folderContext":
        return { ok: true, ...await currentFolder() };
      case "folderCancel":
        if (folderRequest?.token === request.token) folderRequest = null;
        return { ok: true };
      case "folderStart": {
        if (!folderRequest || folderRequest.token !== request.token) throw new Error("フォルダーの選択が変わりました。選び直してください。");
        if (typeof request.includeSubfolders !== "boolean") throw new Error("サブフォルダーの選択が不正です。");
        const folder = folderRequest.folder;
        const current = folder.id ? await api.folders.get(folder.id, false) : folder;
        if (!realFolder(current) || current.accountId !== folder.accountId || current.path !== folder.path) throw new Error("フォルダーが見つからないか、場所が変わりました。選び直してください。");
        const job = await folderScan.start(current, request.includeSubfolders);
        folderRequest = null;
        void folderScan.collecting.catch(report);
        return { ok: true, job };
      }
      case "folderStop":
        if (request.jobId !== folderScan.job?.id) throw new Error("検査の対象が変わりました。画面を更新してください。");
        await folderScan.stop();
        return { ok: true };
      case "retry": {
        const record = records.find(item => item.key === request.key);
        if (!record || deleting.has(record.key) || ["scanning", "queued", "deleted"].includes(record.status)) {
          throw new Error("この結果は再検査できません。");
        }
        record.status = "queued";
        record.source = "manual";
        record.attempts = 0;
        record.nextRetry = null;
        record.folderJobId = null;
        await save();
        void drain().catch(report);
        return { ok: true };
      }
      case "retryMany": {
        const keys = requestedKeys(request.keys);
        const targets = keys.map(key => records.find(record => record.key === key));
        if (targets.some(record => !record || deleting.has(record.key) ||
            !["clean", "detected", "incomplete", "error"].includes(record.status))) {
          throw new Error("再検査できない結果が含まれています。選び直してください。");
        }
        for (const record of targets) {
          Object.assign(record, { status: "queued", source: "manual", attempts: 0, nextRetry: null, folderJobId: null });
        }
        await save();
        void drain().catch(report);
        return { ok: true, count: targets.length };
      }
      case "prepareDeleteBatch":
        return await prepareBatch(request.keys);
      case "cancelDeleteBatch":
        batchTickets.delete(request.token);
        return { ok: true };
      case "deleteBatch": {
        if (batchProgress?.active) throw new Error("一括削除の処理中です。");
        const batch = batchTickets.get(request.token);
        batchTickets.delete(request.token);
        if (!batch || batch.expires < Date.now()) throw new Error("削除確認が期限切れです。選び直してください。");
        batchProgress = { active: true, total: batch.tickets.length, completed: 0, deleted: 0, failed: 0 };
        const results = [];
        try {
          for (const ticket of batch.tickets) {
            try {
              await executeDeletion(ticket);
              batchProgress.deleted++;
              results.push({ key: ticket.key, deleted: true });
            } catch (error) {
              batchProgress.failed++;
              results.push({ key: ticket.key, deleted: false, error: error.message || "削除に失敗しました。" });
            }
            batchProgress.completed++;
          }
          return { ok: true, results };
        } finally { batchProgress.active = false; }
      }
      case "open": {
        const record = records.find(item => item.key === request.key);
        if (!record || record.status === "deleted" || deleting.has(record.key) || !record.sha256) throw new Error("検査対象を照合できません。メール一覧から確認してください。");
        const message = await resolveRecord(record);
        if (await sha256(await rawBytes(message.id)) !== record.sha256) {
          throw new Error("メール内容が検査時から変わっています。再検査してください。");
        }
        await api.messageDisplay.open({ messageId: message.id, location: "tab" });
        return { ok: true };
      }
      case "prepareDelete": {
        if (!await api.permissions.contains({ permissions: ["messagesDelete"] })) {
          throw new Error("先に「完全削除を許可」から権限を許可してください。");
        }
        const record = deletable(request.key);
        const hash = record.sha256;
        const message = await verified(record);
        if (deletable(record.key).sha256 !== hash) throw new Error("検査結果が変わりました。操作をやり直してください。");
        const token = crypto.randomUUID();
        for (const [key, ticket] of deletionTickets) {
          if (ticket.expires < Date.now() || ticket.key === record.key) deletionTickets.delete(key);
        }
        deletionTickets.set(token, { key: record.key, hash, position: position(message),
          expires: Date.now() + 60000 });
        return { ok: true, token, author: message.author || "差出人なし",
          subject: message.subject || "件名なし", folder: message.folder.path || message.folder.name || "",
          accountId: message.folder.accountId, signatures: record.signatures || [] };
      }
      case "cancelDelete":
        deletionTickets.delete(request.token);
        return { ok: true };
      case "deletePermanently": {
        const ticket = deletionTickets.get(request.token);
        deletionTickets.delete(request.token);
        if (!ticket || ticket.key !== request.key || ticket.expires < Date.now()) {
          throw new Error("削除確認が無効か期限切れです。もう一度操作してください。");
        }
        return await executeDeletion(ticket);
      }
      case "clear":
        // This removes only generated results, never messages. The page asks
        // for confirmation before sending this request.
        records = records.filter(record => deleting.has(record.key) || ["scanning", "queued"].includes(record.status));
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
