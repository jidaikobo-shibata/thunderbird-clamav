import { t } from "./i18n.mjs";
import { toolbarNotice } from "./installation.mjs";
import {
  MAX_BYTES, DEFAULTS, LABELS, NativeClient, accountOf, locator, sameEnvelope,
  validateSettings, messagePages, sha256, needsAttention
} from "./core.mjs";
import { canDelete } from "./results.mjs";
import { FolderScan, FOLDER_STATES, realFolder, checkpointHint } from "./folder-scan.mjs";

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
let lastHealth = null, lastScan = null;
let resultsRequest = null, setupRequest = null;
let installation = null, helperRemoved = false, pendingMaintenance = null, maintenanceGeneration = 0;
const maintenanceActive = () => Boolean(pendingMaintenance);
function releaseMaintenance() {
  pendingMaintenance?.client.close();
  pendingMaintenance = null;
}
async function helperInfo() {
  if (maintenanceActive()) return installation;
  const generation = maintenanceGeneration;
  const client = new NativeClient(api.runtime);
  try {
    const info = await client.request("manageInfo");
    if (generation !== maintenanceGeneration) return installation;
    installation = { state: info.status === "managed" ? "managed" : "legacy",
      version: info.version || null, healthy: info.healthy, detail: info.detail || t("mail001", "連携用の更新が必要です。") };
    if (installation.state === "managed" && helperRemoved && !maintenanceActive()) {
      helperRemoved = false;
      await save();
    }
  } catch (error) {
    if (generation !== maintenanceGeneration) return installation;
    installation = { state: helperRemoved && installation?.state === "removed" ? "removed" : "unavailable", detail: error.message };
  } finally { client.close(); }
  await save();
  await updateBadge();
  return installation;
}

const folderScan = new FolderScan(api, {
  digestOf: async message => {
    if (message.headersOnly || message.external) return null;
    return sha256(await rawBytes(message.id));
  },
  changed: () => save(), wake: () => { void drain().catch(report); },
  finished: async job => {
    if (!settings.notifications) return;
    try {
      await api.notifications.create("folder-" + job.id, { type: "basic", iconUrl: api.runtime.getURL("icon.svg"),
        title: t("mail002", "ClamAV：フォルダー検査 ") + FOLDER_STATES[job.status],
        message: t("mail003", "処理済み$1件、検出$2件、未検査$3件、失敗$4件。結果画面を確認してください。", [job.completed, job.counts.detected, job.counts.incomplete, job.counts.error]) });
    } catch { issue = t("mail004", "フォルダー検査の通知を表示できません。結果画面を確認してください。"); }
  }
});

async function chooseFolder(folder) {
  if (maintenanceActive() || helperRemoved) throw new Error(t("mail005", "補助プログラムの管理が完了してから操作してください。"));
  if (folderScan.active) throw new Error(t("mail006", "フォルダー検査は既に実行中です。"));
  const current = folder?.id ? await api.folders.get(folder.id, false) : folder;
  if (!realFolder(current)) throw new Error(t("mail007", "通常のメールフォルダーを1つ選択してください。統合・検索・タグの仮想フォルダーは対象外です。"));
  folderRequest = { token: crypto.randomUUID(), folder: { id: current.id, accountId: current.accountId,
    path: current.path, name: current.name || current.path } };
  return folderRequest;
}

async function currentFolder() {
  const tabs = await api.mailTabs.query({});
  const tab = tabs.find(tab => tab.id === lastMailTab) || tabs.find(tab => tab.active) || tabs[0];
  if (!tab) throw new Error(t("mail008", "Thunderbirdのフォルダー一覧で対象を選択してください。"));
  const full = await api.mailTabs.get(tab.id);
  return chooseFolder(full.displayedFolder);
}

function deletable(key) {
  const record = records.find(item => item.key === key);
  if (!record || !canDelete(record)) {
    throw new Error(t("mail009", "処理が終了した未削除のメールを選択してください。"));
  }
  return record;
}

function position(message) {
  return JSON.stringify([message.id, message.folder?.accountId, message.folder?.path, message.folder?.id]);
}

async function verified(record, expectedFingerprint = null) {
  const message = await resolveRecord(record);
  if (message.external || !message.folder) throw new Error(t("mail010", "保存されているメールを特定できません。"));
  let fingerprint;
  if (record.sha256) {
    const digest = await sha256(await rawBytes(message.id));
    if (digest !== record.sha256) throw new Error(t("mail011", "対象メールが検査時と一致しません。再検査してください。"));
    fingerprint = "sha256:" + digest;
  } else {
    // Failed/oversized scans may have no scan digest. Establish a confirmation
    // snapshot without loading the entire message or invoking the scanner.
    const raw = await api.messages.getRaw(message.id, { data_format: "File", decrypt: false });
    if (!raw || !Number.isSafeInteger(raw.size) || raw.size < 0 || typeof raw.slice !== "function") {
      throw new Error(t("mail012", "削除対象のメール内容を取得できませんでした。"));
    }
    let digest = await sha256(new TextEncoder().encode("clam-mail-check-delete-v1:" + raw.size));
    for (let offset = 0; offset < raw.size; offset += 512 * 1024) {
      const chunk = new Uint8Array(await raw.slice(offset, offset + 512 * 1024).arrayBuffer());
      if (chunk.length !== Math.min(512 * 1024, raw.size - offset)) {
        throw new Error(t("mail013", "削除対象のメール内容を最後まで取得できませんでした。"));
      }
      const bytes = new Uint8Array(32 + chunk.length);
      bytes.set(digest.match(/../g).map(value => parseInt(value, 16)));
      bytes.set(chunk, 32);
      digest = await sha256(bytes);
    }
    fingerprint = "chunked-sha256-v1:" + digest;
  }
  if (expectedFingerprint && fingerprint !== expectedFingerprint) {
    throw new Error(t("mail014", "確認後にメール内容が変わりました。もう一度確認してください。"));
  }
  return { message, fingerprint };
}

function requestedKeys(keys) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 100 ||
      keys.some(key => typeof key !== "string") || new Set(keys).size !== keys.length) {
    throw new Error(t("mail015", "一括操作は重複のない1〜100件を選択してください。"));
  }
  return keys;
}

async function prepareBatch(keys) {
  requestedKeys(keys);
  if (batchProgress?.active) throw new Error(t("mail016", "一括削除の処理中です。"));
  if (!await api.permissions.contains({ permissions: ["messagesDelete"] })) {
    throw new Error(t("mail017", "完全削除の権限がありません。削除ボタンからもう一度操作してください。"));
  }
  const tickets = [], targets = [], positions = new Set();
  for (const key of keys) {
    const record = deletable(key);
    if (deleting.has(key)) throw new Error(t("mail018", "削除処理中のメールがあります。"));
    const hash = record.sha256;
    const { message, fingerprint } = await verified(record);
    if (deletable(key).sha256 !== hash) throw new Error(t("mail019", "検査結果が変わりました。選び直してください。"));
    const place = position(message);
    if (positions.has(place)) throw new Error(t("mail020", "同じメールを指す履歴が含まれています。重複を外してください。"));
    positions.add(place);
    tickets.push({ key, hash, fingerprint, position: place });
    targets.push({ key, author: message.author || t("mail021", "差出人なし"), subject: message.subject || t("mail022", "件名なし"),
      accountId: message.folder.accountId, folder: message.folder.path || message.folder.name || "",
      status: record.status, signatures: record.signatures || [] });
  }
  for (const [token, batch] of batchTickets) {
    if (batch.expires < Date.now()) batchTickets.delete(token);
  }
  if (batchTickets.size >= 10) throw new Error(t("mail023", "未完了の確認が多いため、ほかの確認画面を閉じてやり直してください。"));
  const token = crypto.randomUUID();
  batchTickets.set(token, { tickets, expires: Date.now() + 300000 });
  return { ok: true, token, targets };
}


async function executeDeletion(ticket) {
  if (deleting.has(ticket.key)) throw new Error(t("mail024", "このメールは削除処理中です。"));
  deleting.add(ticket.key);
  try {
    if (!await api.permissions.contains({ permissions: ["messagesDelete"] })) {
      throw new Error(t("mail025", "完全削除の権限がありません。"));
    }
    const record = deletable(ticket.key);
    if (record.sha256 !== ticket.hash) throw new Error(t("mail026", "検査結果が変わりました。再確認してください。"));
    const { message } = await verified(record, ticket.fingerprint);
    // Never follow a move/replacement after the user saw the confirmation.
    const current = await api.messages.get(message.id);
    if (position(current) !== ticket.position || !sameEnvelope(current, record.locator) ||
        deletable(ticket.key).sha256 !== ticket.hash) {
      throw new Error(t("mail027", "確認後にメールの場所や検査結果が変わりました。再確認してください。"));
    }
    await api.messages.delete([current.id], { deletePermanently: true, isUserAction: true });
    record.status = "deleted";
    record.deletedAt = new Date().toISOString();
    record.updatedAt = record.deletedAt;
    record.nextRetry = null;
    delete record.detailMessages;
    record.detail = t("mail028", "ごみ箱を経由せず完全削除しました。元には戻せません。");
    try { await save(); }
    catch { issue = t("mail029", "メールの削除は完了しましたが、履歴を保存できませんでした。"); }
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
  const value = JSON.parse(JSON.stringify({ settings, records, issue, lastHealth, lastScan, helperRemoved, installation, folderJob: folderScan.snapshot(), folderCheckpoint: folderScan.checkpointState() }));
  writes = writes.catch(() => {}).then(() => api.storage.local.set(value));
  void updateBadge().catch(() => {});
  return writes;
}

function toolbarState() {
  return toolbarNotice(installation, api.runtime.getManifest().version, issue, records.filter(needsAttention).length);
}
async function updateBadge() {
  const notice = toolbarState();
  await api.browserAction.setIcon({ path: notice.dot ? `icon-${notice.dot}.svg` : "icon.svg" });
  await api.browserAction.setBadgeText({ text: notice.text });
  await api.browserAction.setBadgeBackgroundColor({ color: notice.color });
  await api.browserAction.setTitle({ title: notice.title });
}

async function notify(record) {
  if (!settings.notifications || !needsAttention(record)) return;
  // Subjects/senders are deliberately omitted from lock-screen notifications.
  try {
    await api.notifications.create(record.key, {
      type: "basic", iconUrl: api.runtime.getURL("icon.svg"),
      title: t("mail211", "ClamAV メール検査：") + LABELS[record.status],
      message: t("mail030", "Thunderbirdの検査結果画面で対象メールを確認してください。")
    });
  } catch { issue = t("mail031", "デスクトップ通知を表示できません。結果画面を確認してください。"); }
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
    throw new Error(t("mail032", "メールデータをFile形式で取得できませんでした。"));
  }
  if (!raw.size || raw.size > MAX_BYTES) {
    const error = new Error(t("mail033", "メールが空か、検査上限の25MiBを超えています。"));
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
    throw new Error(t("mail034", "対象を再特定できません。Thunderbirdで選択して再検査してください。"));
  }
  const candidates = [];
  const first = await api.messages.query({ headerMessageId: record.locator.headerMessageId });
  for await (const message of messagePages(api.messages, first)) {
    if (sameEnvelope(message, record.locator)) candidates.push(message);
    if (candidates.length > 20) throw new Error(t("mail035", "同じ識別情報のメールが多いため、対象を特定できません。"));
  }
  const matches = [];
  for (const candidate of candidates) {
    if (!record.sha256 || await sha256(await rawBytes(candidate.id)) === record.sha256) {
      matches.push(candidate);
    }
  }
  if (matches.length !== 1) {
    throw new Error(t("mail036", "対象メールが存在しないか、複数候補があり特定できません。選択して再検査してください。"));
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
      if (source === "manual" && helperRemoved) throw new Error(t("mail037", "補助プログラムの導入を確認してから検査してください。"));
      if (message.external || !message.folder) continue;
      if (source === "automatic" && (!settings.enabled ||
          !settings.accountIds.includes(accountOf(message)))) continue;
      const existing = records.find(record => record.session === session && record.messageId === message.id);
      if (existing && (deleting.has(existing.key) || existing.status === "deleted")) continue;
      if (existing && ["queued", "scanning"].includes(existing.status)) continue;
      if (existing && source === "automatic") continue;
      // Only discard old non-alert results when the bounded history is full.
      if (!existing && records.length >= MAX_RECORDS) {
        const index = records.findIndex(record => ["clean", "deleted"].includes(record.status));
        if (index === -1) { overflow = true; continue; }
        records.splice(index, 1);
      }
      const record = existing || { key: crypto.randomUUID(), createdAt: new Date().toISOString() };
      Object.assign(record, {
        messageId: message.id, session, locator: locator(message), source,
        status: "queued", detail: t("mail038", "検査を待っています。"), signatures: [],
        sha256: null, engine: null, attempts: 0, nextRetry: null, folderJobId: null, updatedAt: new Date().toISOString()
      });
      if (!existing) records.push(record);
    }
    if (overflow) issue = t("mail039", "結果が1000件に達しました。新着の一部を検査できません。履歴を整理してください。");
    await save();
    await updateBadge();
    void drain().catch(report);
  };
  mutations = mutations.catch(() => {}).then(work);
  return mutations;
}

async function drain() {
  if (running || maintenanceActive() || helperRemoved) return;
  running = true;
  let client, engine;
  try {
    while (true) {
      // Folder work is fed one at a time, after fresh mail and manual work.
      let record = records.find(item => item.status === "queued" && item.source === "automatic" &&
        settings.enabled && settings.accountIds.includes(item.locator.accountId)) ||
        records.find(item => item.status === "queued" && item.source === "manual");
      if (!record && folderScan.available()) {
        if (records.length >= MAX_RECORDS) {
          const index = records.findIndex(item => ["clean", "deleted"].includes(item.status));
          if (index === -1) {
            await folderScan.finish("blocked", t("mail040", "検出・未検査・失敗などの履歴で上限1000件に達したため停止しました。履歴を確認・整理し、改めて開始してください。"));
            continue;
          }
          records.splice(index, 1);
        }
        const message = folderScan.take();
        if (message) {
          record = { key: crypto.randomUUID(), createdAt: new Date().toISOString(),
            messageId: message.id, session, locator: locator(message), source: "folder",
            status: "queued", detail: t("mail041", "フォルダー検査を待っています。"), signatures: [],
            sha256: null, engine: null, attempts: 0, nextRetry: null, folderJobId: folderScan.job.id,
            updatedAt: new Date().toISOString() };
          records.push(record);
        }
      }
      if (!record) break;
      const fromFolder = record.source === "folder";
      record.status = "scanning";
      delete record.detailMessages;
      record.detail = t("mail042", "メールを取得して検査しています。");
      record.attempts++;
      record.updatedAt = new Date().toISOString();
      await save();
      try {
        const message = await resolveRecord(record);
        if (message.headersOnly) {
          throw new Error(t("mail043", "ヘッダーのみ取得されたメールです。本文をダウンロードして再検査してください。"));
        }
        const bytes = await rawBytes(message.id);
        record.sha256 = await sha256(bytes);
        if (!client || client.closed) {
          client = new NativeClient(api.runtime);
          const health = await client.request("health");
          if (health.status !== "ready" || health.protocol !== 1) {
            client.close();
            throw new Error(health.detail || t("mail044", "補助プログラムのバージョンが対応していません。"));
          }
          engine = health.engine;
        }
        record.engine = engine;
        const result = await client.scan(bytes, record.sha256);
        record.status = result.status;
        record.engine = result.engine || engine;
        delete record.detailMessages;
        record.detail = result.detail;
        if (result.detailMessages) record.detailMessages = result.detailMessages;
        record.signatures = result.signatures || [];
        if (result.status !== "error") lastScan = { checkedAt: new Date().toISOString(),
          engine: record.engine, status: result.status };
        record.nextRetry = null;
      } catch (error) {
        record.status = error.incomplete ? "incomplete" : "error";
        delete record.detailMessages;
        record.detail = error.message || t("mail045", "検査に失敗しました。");
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
        await folderScan.complete(record.status, record.sha256 ? {
          hint: await checkpointHint(record.locator), digest: record.sha256
        } : null);
      }
      await save();
      if (!fromFolder) await notify(record);
      await updateBadge();
    }
  } catch (error) {
    const active = records.find(record => record.status === "scanning");
    if (active) {
      active.status = "error";
      active.detail = t("mail046", "検査状態の保存に失敗しました。保存領域を確認して再検査してください。");
    }
    if (folderScan.active) {
      await folderScan.finish("error", t("mail047", "検査状態の保存などに失敗したため停止しました。結果を確認して改めて開始してください。")).catch(() => {});
    }
    throw error;
  } finally {
    client?.close();
    running = false;
  }
}

async function scanSelection() {
  if (lastMailTab === undefined) {
    const tabs = await api.mailTabs.query({});
    lastMailTab = (tabs.find(tab => tab.active) || tabs[0])?.id;
  }
  if (lastMailTab === undefined) throw new Error(t("mail048", "メール一覧で対象を選択してください。"));
  const selected = await api.mailTabs.getSelectedMessages(lastMailTab);
  if (!selected.messages.length) throw new Error(t("mail048", "メール一覧で対象を選択してください。"));
  await enqueue(selected, "manual");
}

const ready = (async () => {
  const data = await api.storage.local.get(["settings", "records", "issue", "folderJob", "folderCheckpoint", "lastHealth", "lastScan", "helperRemoved", "installation"]);
  settings = { ...DEFAULTS, ...data.settings };
  records = Array.isArray(data.records) ? data.records : [];
  issue = typeof data.issue === "string" ? data.issue : "";
  lastHealth = data.lastHealth || null;
  helperRemoved = data.helperRemoved === true;
  installation = data.installation || null;
  lastScan = data.lastScan || records.filter(record => record.engine &&
    ["clean", "detected", "incomplete", "deleted"].includes(record.status))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0] || null;
  if (lastScan && !lastScan.checkedAt) lastScan = { engine: lastScan.engine,
    checkedAt: lastScan.updatedAt, status: lastScan.status };
  folderScan.restore(data.folderJob, data.folderCheckpoint);
  // Old versions kept only summary/history. Recover verifiable progress from retained results.
  if (data.folderJob && !data.folderCheckpoint) {
    for (const record of records) {
      if (record.folderJobId === data.folderJob.id && record.sha256 &&
          !["queued", "scanning"].includes(record.status)) {
        folderScan.remember(await checkpointHint(record.locator), record.sha256);
      }
    }
  }
  for (const record of records) {
    record.messageId = null;
    record.session = null;
    if (record.status === "scanning" || (record.source === "folder" && record.status === "queued")) {
      record.status = record.source === "folder" ? "error" : "queued";
      delete record.detailMessages;
      record.detail = record.source === "folder" ? t("mail049", "フォルダー検査中に終了したため、このメールの結果は未確認です。") : t("mail050", "前回中断された検査を再開します。");
      if (record.source === "folder") record.nextRetry = null;
    }
  }
  await api.menus.removeAll();
  api.menus.create({ id: "scan", title: t("mail051", "ClamAVで選択メールを検査"), contexts: ["message_list"] });
  api.menus.create({ id: "scan-folder", title: t("mail052", "ClamAVでフォルダーを検査"), contexts: ["folder_pane"] });
  await save();
  await helperInfo();
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
        if (folders.length !== 1) throw new Error(t("mail053", "フォルダーを1つ選択してください。"));
        await chooseFolder(folders[0]);
      }
      await openDashboard();
    }).catch(report);
    return;
  }
  if (info.menuItemId !== "scan") return;
  if (tab?.id !== undefined) lastMailTab = tab.id;
  void ready.then(() => info.selectedMessages ? enqueue(info.selectedMessages, "manual") : scanSelection())
    .then(() => { resultsRequest = crypto.randomUUID(); return openDashboard(); }).catch(report);
});
api.browserAction.onClicked.addListener(() => {
  void ready.then(async () => {
    if (toolbarState().setup) setupRequest = crypto.randomUUID();
    else if (records.some(needsAttention) || issue) resultsRequest = crypto.randomUUID();
    await openDashboard();
  }).catch(report);
});
api.notifications.onClicked.addListener(() => { void openDashboard().catch(report); });
api.runtime.onInstalled.addListener(() => { void openDashboard().catch(report); });

api.runtime.onMessage.addListener(async (request, sender) => {
  if (sender.id !== api.runtime.id || sender.url !== api.runtime.getURL("dashboard.html")) return undefined;
  await ready;
  try {
    if ((maintenanceActive() || helperRemoved) && !["state", "helperInfo", "helperApply", "helperCancel", "helperMarkRemoved", "health"].includes(request.type)) {
      throw new Error(t("mail054", "補助プログラムの管理中か削除後です。導入を確認してから操作してください。"));
    }
    switch (request.type) {
      case "state":
        return { ok: true, settings, records, issue, lastHealth, lastScan, resultsRequest, setupRequest, installation, helperRemoved, maintenance: maintenanceActive(), batch: batchProgress, folderRequest,
          folderJob: folderScan.snapshot(), accounts: (await api.accounts.list())
          .filter(account => ["imap", "pop3", "none"].includes(account.type))
          .map(account => ({ id: account.id, name: account.name, type: account.type })) };
      case "helperInfo":
        return { ok: true, installation: await helperInfo() };
      case "helperPlan": {
        if (running || folderScan.active || batchProgress?.active || deleting.size) throw new Error(t("mail055", "検査・削除の処理が終了してから操作してください。フォルダー検査中は先に中止してください。"));
        maintenanceGeneration++;
        const client = new NativeClient(api.runtime);
        pendingMaintenance = { client, token: null, expires: Date.now() + 300000, operation: request.operation };
        try {
          const plan = await client.request("managePlan", { operation: request.operation, package: request.package });
          if (plan.status !== "prepared" || !plan.token) throw new Error(plan.detail || t("mail056", "管理機能が未対応です。同梱のCLIファイルを利用してください。"));
          pendingMaintenance.token = plan.token;
          return { ok: true, plan };
        } catch (error) { releaseMaintenance(); void drain().catch(report); throw error; }
      }
      case "helperCancel":
        if (pendingMaintenance && request.token === pendingMaintenance.token && !pendingMaintenance.applying) {
          releaseMaintenance(); void drain().catch(report);
        }
        return { ok: true };
      case "helperApply": {
        const pending = pendingMaintenance;
        if (!pending || request.token !== pending.token) throw new Error(t("mail057", "管理操作の確認が無効です。"));
        if (pending.applying) throw new Error(t("mail058", "管理操作は既に実行中です。"));
        if (Date.now() > pending.expires) {
          releaseMaintenance(); throw new Error(t("mail059", "管理操作の確認が期限切れです。"));
        }
        pending.applying = true;
        const removing = pending.operation === "uninstall";
        try {
          if (removing) {
            helperRemoved = true;
            settings = { ...settings, enabled: false };
            await save();
          }
          const result = await pending.client.request("manageApply", { token: pending.token }, 60000);
          if (!["removed", "updated"].includes(result.status)) throw new Error(result.detail || t("mail060", "補助プログラムの処理を完了できませんでした。"));
          installation = { state: result.status === "removed" ? "removed" : "managed",
            version: result.version, healthy: true, retained: result.retained || [],
            detail: result.status === "removed" ? t("mail061", "補助プログラムを削除しました。拡張の削除を続けられます。") : t("mail062", "補助プログラムを更新・修復しました。") };
          try { await save(); } catch { installation.detail += t("mail063", " 状態の保存に失敗したため、この画面で結果を確認してください。"); }
          return { ok: true, installation };
        } catch (error) {
          if (removing) {
            installation = { state: "unavailable", detail: t("mail064", "削除の完了を確認できませんでした。導入を確認するか、CLIのstatus/uninstallで状態を確認してください。") };
            await save().catch(report);
          }
          throw error;
        } finally { releaseMaintenance(); void drain().catch(report); }
      }
      case "helperMarkRemoved":
        if (request.acknowledged !== true || running || folderScan.active || batchProgress?.active || deleting.size) throw new Error(t("mail065", "処理を停止し、Terminalで補助プログラムの削除が完了したことを確認してください。"));
        helperRemoved = true;
        settings = { ...settings, enabled: false };
        installation = { state: "removed", detail: t("mail066", "Terminalでの削除完了を利用者が確認しました。") };
        await save();
        return { ok: true };
      case "settings": {
        const ids = (await api.accounts.list()).map(account => account.id);
        const previous = settings;
        settings = validateSettings(request.settings, ids);
        try { await save(); }
        catch (error) { settings = previous; throw error; }
        void drain().catch(report);
        return { ok: true };
      }
      case "health": {
        const client = new NativeClient(api.runtime);
        try {
          try { lastHealth = { ...await client.request("health"), checkedAt: new Date().toISOString() }; }
          catch (error) { lastHealth = { status: "error", checkedAt: new Date().toISOString(), detail: error.message }; }
          await save();
          return { ok: true, health: lastHealth };
        } finally { client.close(); }
      }
      case "scanSelection":
        await scanSelection();
        return { ok: true };
      case "folderChoices": {
        const choices = [], seen = new Set();
        const walk = (folder, accountId) => {
          if (!folder || choices.length >= 5000) return;
          const current = { ...folder, accountId: folder.accountId || accountId };
          const identity = current.accountId + ":" + current.path;
          if (seen.has(identity)) return;
          seen.add(identity);
          if (realFolder(current) && typeof current.id === "string") {
            choices.push({ id: current.id, accountId: current.accountId, path: current.path,
              name: current.name || current.path });
          }
          for (const child of folder.subFolders || []) walk(child, accountId);
        };
        for (const account of await api.accounts.list(true)) {
          if (!["imap", "pop3", "none"].includes(account.type)) continue;
          if (account.rootFolder) walk(account.rootFolder, account.id);
          else for (const folder of account.folders || []) walk(folder, account.id);
        }
        return { ok: true, folders: choices, limited: choices.length >= 5000 };
      }
      case "folderContext":
        if (request.folderId !== undefined) {
          if (typeof request.folderId !== "string" || !request.folderId) throw new Error(t("mail067", "検査するフォルダーを選択してください。"));
          return { ok: true, ...await chooseFolder(await api.folders.get(request.folderId, false)) };
        }
        return { ok: true, ...await currentFolder() };
      case "folderCancel":
        if (folderRequest?.token === request.token) folderRequest = null;
        return { ok: true };
      case "folderStart": {
        if (!folderRequest || folderRequest.token !== request.token) throw new Error(t("mail068", "フォルダーの選択が変わりました。選び直してください。"));
        if (typeof request.includeSubfolders !== "boolean") throw new Error(t("mail069", "サブフォルダーの選択が不正です。"));
        const folder = folderRequest.folder;
        const current = folder.id ? await api.folders.get(folder.id, false) : folder;
        if (!realFolder(current) || current.accountId !== folder.accountId || current.path !== folder.path) throw new Error(t("mail070", "フォルダーが見つからないか、場所が変わりました。選び直してください。"));
        const job = await folderScan.start(current, request.includeSubfolders);
        folderRequest = null;
        void folderScan.collecting.catch(report);
        return { ok: true, job };
      }
      case "folderResume": {
        if (request.jobId !== folderScan.job?.id || !folderScan.resumable) throw new Error(t("mail071", "この検査は再開できません。画面を更新してください。"));
        const job = folderScan.job, folder = job.folder;
        const current = folder.id ? await api.folders.get(folder.id, false) : folder;
        if (folderScan.job !== job || !realFolder(current) || current.accountId !== folder.accountId || current.path !== folder.path) throw new Error(t("mail072", "元のフォルダーが見つからないか、場所が変わりました。"));
        await folderScan.resume(current);
        void folderScan.collecting.catch(report);
        return { ok: true };
      }
      case "folderDelete":
        if (!folderScan.job || request.jobId !== folderScan.job.id) throw new Error(t("mail073", "検査の対象が変わりました。画面を更新してください。"));
        await folderScan.remove();
        folderRequest = null;
        return { ok: true };
      case "folderStop":
        if (request.jobId !== folderScan.job?.id) throw new Error(t("mail073", "検査の対象が変わりました。画面を更新してください。"));
        await folderScan.stop();
        return { ok: true };
      case "retry": {
        const record = records.find(item => item.key === request.key);
        if (!record || deleting.has(record.key) || ["scanning", "queued", "deleted"].includes(record.status)) {
          throw new Error(t("mail074", "この結果は再検査できません。"));
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
          throw new Error(t("mail075", "再検査できない結果が含まれています。選び直してください。"));
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
        if (batchProgress?.active) throw new Error(t("mail016", "一括削除の処理中です。"));
        const batch = batchTickets.get(request.token);
        batchTickets.delete(request.token);
        if (!batch || batch.expires < Date.now()) throw new Error(t("mail076", "削除確認が期限切れです。選び直してください。"));
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
              results.push({ key: ticket.key, deleted: false, error: error.message || t("mail077", "削除に失敗しました。") });
            }
            batchProgress.completed++;
          }
          return { ok: true, results };
        } finally { batchProgress.active = false; }
      }
      case "open": {
        const record = records.find(item => item.key === request.key);
        if (!record || record.status === "deleted" || deleting.has(record.key) || !record.sha256) throw new Error(t("mail078", "検査対象を照合できません。メール一覧から確認してください。"));
        const message = await resolveRecord(record);
        if (await sha256(await rawBytes(message.id)) !== record.sha256) {
          throw new Error(t("mail079", "メール内容が検査時から変わっています。再検査してください。"));
        }
        await api.messageDisplay.open({ messageId: message.id, location: "tab" });
        return { ok: true };
      }
      case "prepareDelete": {
        if (!await api.permissions.contains({ permissions: ["messagesDelete"] })) {
          throw new Error(t("mail017", "完全削除の権限がありません。削除ボタンからもう一度操作してください。"));
        }
        const record = deletable(request.key);
        const hash = record.sha256;
        const { message, fingerprint } = await verified(record);
        if (deletable(record.key).sha256 !== hash) throw new Error(t("mail080", "検査結果が変わりました。操作をやり直してください。"));
        const token = crypto.randomUUID();
        for (const [key, ticket] of deletionTickets) {
          if (ticket.expires < Date.now() || ticket.key === record.key) deletionTickets.delete(key);
        }
        deletionTickets.set(token, { key: record.key, hash, fingerprint, position: position(message),
          expires: Date.now() + 60000 });
        return { ok: true, token, author: message.author || t("mail021", "差出人なし"),
          subject: message.subject || t("mail022", "件名なし"), folder: message.folder.path || message.folder.name || "",
          accountId: message.folder.accountId, status: record.status, signatures: record.signatures || [] };
      }
      case "cancelDelete":
        deletionTickets.delete(request.token);
        return { ok: true };
      case "deletePermanently": {
        const ticket = deletionTickets.get(request.token);
        deletionTickets.delete(request.token);
        if (!ticket || ticket.key !== request.key || ticket.expires < Date.now()) {
          throw new Error(t("mail081", "削除確認が無効か期限切れです。もう一度操作してください。"));
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
      default: throw new Error(t("mail082", "未対応の操作です。"));
    }
  } catch (error) { return { ok: false, error: error.message || t("mail083", "操作に失敗しました。") }; }
});

// Timers are sufficient for a persistent MV2 background page. Restart recovery
// uses persisted records, not timers or Thunderbird's ephemeral numeric IDs.
setInterval(() => {
  void ready.then(async () => {
    if (pendingMaintenance && !pendingMaintenance.applying && Date.now() > pendingMaintenance.expires) releaseMaintenance();
    if (maintenanceActive() || helperRemoved) return;
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
