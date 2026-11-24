import { ReceiptBudget } from "./receipt-budget.mjs";
import { toolbarUpdates } from "./toolbar-updates.mjs";
import { StateStorage, readStoredState } from "./state-storage.mjs";
import { ScanConnection } from "./scan-connection.mjs";
import { readScannerHealth, applyScannerHealth, scannerReady } from "./scanner-health.mjs";
import { rememberResult, finishScanAttempt, retainKnownDetection, scanFailed } from "./scan-history.mjs";
import { directRuntime } from "./direct-transport.mjs";
import { scanPolicy, defaultScanPolicy, advisoryNotifies } from "./scan-policy.mjs";
import { canReview, canUnreview, reviewReason, reviewStamp, reconcileReview } from "./review.mjs";
import { validateQuarantine, moveToQuarantine, inQuarantine, quarantineCandidates, canQuarantine, refreshQuarantineLocation } from "./quarantine.mjs";
import { t } from "./i18n.mjs";
import { toolbarNotice } from "./installation.mjs";
import {
  MAX_BYTES, MAX_TRANSFER_BYTES, SCAN_INPUT_TIMEOUT_MS, REVIEW_FINGERPRINT_TIMEOUT_MS, DEFAULTS, LABELS, NativeClient, accountOf, locator, sameEnvelope,
  validateSettings, messagePages, sha256, needsAttention, pausedAutomatic, normalizeAutomaticSettings
} from "./core.mjs";
import { canDelete, canForget, canRetry } from "./results.mjs";
import { FolderScan, FOLDER_STATES, realFolder, checkpointHint, refreshScanFolders } from "./folder-scan.mjs";

const api = messenger;
const toolbar = toolbarUpdates(api.browserAction);
const stateStorage = new StateStorage(api.storage.local);
const DIRECT = directRuntime(api.runtime);
const scanConnection = new ScanConnection(() => new NativeClient(api.runtime), DIRECT ? {} : { idleMs: 0 });
let directMigrationBackup = null, incrementalMigrationBackup = null;
const session = crypto.randomUUID();
const MAX_RECORDS = 1000;
const inputTimers = { set: globalThis.setTimeout.bind(globalThis), clear: globalThis.clearTimeout.bind(globalThis) };
let settings = { ...DEFAULTS };
let records = [];
let overflowPending = null, overflowReport = null;
const overflowWaiters = new Set();
function wakeOverflow() { for (const resolve of overflowWaiters) resolve(); overflowWaiters.clear(); }
function reserveHistory() {
  if (records.length < MAX_RECORDS) return true;
  const index = records.findIndex(record => ["clean", "deleted"].includes(record.status) && !deleting.has(record.key));
  if (index < 0) return false;
  records.splice(index, 1); return true;
}
async function finishOverflow(record) {
  if (overflowPending !== record) return;
  if (reserveHistory()) records.push(record);
  else {
    overflowReport ||= { total: 0, counts: {}, recent: [] };
    overflowReport.total++;
    overflowReport.counts[record.status] = (overflowReport.counts[record.status] || 0) + 1;
    overflowReport.updatedAt = new Date().toISOString();
    if (needsAttention(record)) overflowReport.recent = [record, ...overflowReport.recent].slice(0, 20);
  }
  overflowPending = null;
  try { await save(); } finally { wakeOverflow(); }
}
let issue = "";
let running = false;
let lastMailTab;
let writes = Promise.resolve();
let settingsChanges = Promise.resolve();
let recordChanges = Promise.resolve(), recordStaging = null;
let manualMutations = Promise.resolve();
let automaticReceipts = 0;
const pendingReceipts = new Set();
const receiptBudget = new ReceiptBudget();
let receiptRecovery = null, recoveringReceipts = false;
let savingReceiptRecovery = false, receiptRecoveryDirty = false;
let receiptIssue = null;
let checkingQuarantineReceipts = false;
let automaticQuarantines = Promise.resolve();
const automaticQuarantineTasks = new Set();
const QUARANTINE_TIMEOUT_MS = 60000;
const QUARANTINE_RECEIPT_TIMEOUT_MS = 10000;
const quarantineCheckFailures = new WeakMap();
let moves = Promise.resolve(); // Scheduling only; never waits for list/body I/O.
const moveIntakes = new Set();
const moveJobs = new Map();
let activeMoveProofs = 0;
const moveProofWaiters = [];
const deletionTickets = new Map();
const deleting = new Set();
const batchTickets = new Map();
let deletionPreparation = null;
const cancelledPreparations = new Map();
let batchProgress = null, retryContext = null;
const historyTickets = new Map();
const movedScans = new WeakMap();
const moveRevisions = new WeakMap();
const unverifiedMoves = new WeakMap(), notifiedMoveResults = new WeakMap();
const notificationWork = new WeakMap();
const pendingMoveDuplicates = new WeakMap(), pendingMoveOrigin = new WeakMap();
let folderRequest = null;
let lastHealth = null, lastScan = null;
let resultsRequest = null, resultsFilter = null, setupRequest = null;
let installation = null, helperRemoved = false, pendingMaintenance = null, maintenanceGeneration = 0;
const maintenanceActive = () => Boolean(pendingMaintenance);
function releaseMaintenance() {
  pendingMaintenance?.client.close();
  pendingMaintenance = null;
}
async function helperInfo() {
  if (maintenanceActive()) return installation;
  if (!running) scanConnection.discard();
  const generation = maintenanceGeneration;
  let client;
  try {
    client = new NativeClient(api.runtime);
    if (DIRECT) {
      lastHealth = await readScannerHealth(client, DIRECT);
      installation = { state: "integrated", version: api.runtime.getManifest().version,
        healthy: lastHealth.status === "ready", detail: lastHealth.detail,
        clamavCode: lastHealth.status === "ready" ? "ready" : lastHealth.code || "direct_unavailable" };
      return installation;
    }
    const info = await client.request("manageInfo");
    if (generation !== maintenanceGeneration) return installation;
    const candidate = { state: info.status === "managed" ? "managed" : "legacy",
      version: info.version || null, healthy: info.healthy, detail: info.detail || t("mail001", "連携用の更新が必要です。") };
    const health = await readScannerHealth(client, DIRECT);
    if (generation !== maintenanceGeneration) return installation;
    installation = candidate;
    lastHealth = health;
    applyScannerHealth(installation, lastHealth, DIRECT);
    if (installation.state === "managed" && helperRemoved && !maintenanceActive()) helperRemoved = false;
  } catch (error) {
    if (generation !== maintenanceGeneration) return installation;
    installation = { state: helperRemoved && installation?.state === "removed" ? "removed" : "unavailable", detail: error.message };
    lastHealth = { status: "error", code: "helper_unavailable", checkedAt: new Date().toISOString(),
      detail: t("helperClamavUnknown", "補助プログラムに接続できないため、ClamAVの有無はまだ確認できません。補助プログラムの導入・接続を確認してください。") };
  } finally { client?.close(); if (DIRECT) { await save(); await updateBadge(); } }
  await save();
  await updateBadge();
  return installation;
}

/** Check prerequisites before enumerating mail or reserving history slots. */
async function requireFolderScanner() {
  const client = new NativeClient(api.runtime);
  try { lastHealth = await readScannerHealth(client, DIRECT); }
  finally { client.close(); }
  if (lastHealth.status === "ready" && !scannerReady(lastHealth)) {
    lastHealth = { ...lastHealth, status: "error", code: "protocol_incompatible",
      detail: t("mail044", "補助プログラムのバージョンが対応していません。") };
  }
  applyScannerHealth(installation, lastHealth, DIRECT);
  const unavailable = lastHealth.status !== "ready";
  if (unavailable) setupRequest = crypto.randomUUID();
  await save();
  await updateBadge();
  if (unavailable) {
    const error = new Error(lastHealth.detail);
    error.setupRequired = true;
    throw error;
  }
}

const folderScan = new FolderScan(api, {
  digestOf: async (message, check) => {
    if (message.headersOnly || message.external) return null;
    return sha256(await rawBytes(message.id, MAX_TRANSFER_BYTES, check));
  },
  changed: () => save(), wake: () => { void drain().catch(report); },
  finished: job => {
    if (!settings.notifications) return;
    // Completion notices must not hold folder progress or the serial scanner.
    void (async () => {
      try {
        await api.notifications.create("folder-" + job.id, { type: "basic", iconUrl: api.runtime.getURL("icon.svg"),
          title: t("mail002", "ClamAV：フォルダー検査 ") + FOLDER_STATES[job.status],
          message: t("mail003", "処理済み$1件、検出$2件、未検査$3件、失敗$4件。結果画面を確認してください。", [job.completed, job.counts.detected, job.counts.incomplete, job.counts.error]) + (job.counts.advisory ? t("scanFolderAdvisory", " 注意情報$1件。", [job.counts.advisory]) : "") });
      } catch { report(t("mail004", "フォルダー検査の通知を表示できません。結果画面を確認してください。")); }
    })();
  }
});

async function listFolderChoices() {
  const choices = [], seen = new Set();
  const walk = (folder, accountId, parents = []) => {
    if (!folder || choices.length >= 5000) return;
    const current = { ...folder, accountId: folder.accountId || accountId };
    const identity = current.accountId + ":" + current.path;
    if (seen.has(identity)) return;
    seen.add(identity);
    const displayNames = current.isRoot || current.path === "/" ? parents : [...parents, current.name || current.path];
    if (realFolder(current) && typeof current.id === "string") {
      choices.push({ id: current.id, accountId: current.accountId, path: current.path,
        name: current.name || current.path, specialUse: current.specialUse || [], displayNames });
    }
    for (const child of folder.subFolders || []) walk(child, accountId, displayNames);
  };
  for (const account of await api.accounts.list(true)) {
    if (!["imap", "pop3", "none"].includes(account.type)) continue;
    if (account.rootFolder) walk(account.rootFolder, account.id);
    else for (const folder of account.folders || []) walk(folder, account.id);
  }
  return { ok: true, folders: choices, limited: choices.length >= 5000 };
}

async function chooseFolder(folder) { return chooseFolders([folder]); }

async function chooseFolders(folders) {
  if (maintenanceActive() || helperRemoved) throw new Error(t("mail005", "補助プログラムの管理が完了してから操作してください。"));
  if (folderScan.active) throw new Error(t("mail006", "フォルダー検査は既に実行中です。"));
  const current = await Promise.all(folders.map(folder => folder?.id ? api.folders.get(folder.id, false) : folder));
  if (!current.length || current.some(folder => !realFolder(folder) || folder.accountId !== current[0].accountId)) throw new Error(t("foldersInvalid", "同じアカウントの通常のメールフォルダーを選択してください。"));
  const choices = await listFolderChoices();
  const selectedFolders = current.map(folder => ({ id: folder.id, accountId: folder.accountId, path: folder.path,
    name: folder.name || folder.path, displayNames: choices.folders.find(candidate => candidate.accountId === folder.accountId && candidate.path === folder.path)?.displayNames }));
  folderRequest = { token: crypto.randomUUID(), folder: selectedFolders[0], folders: selectedFolders };
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

async function verified(record, expectedFingerprint = null, check = () => {}) {
  check();
  const message = await resolveRecord(record, check);
  check();
  if (message.external || !message.folder) throw new Error(t("mail010", "保存されているメールを特定できません。"));
  let fingerprint;
  if (record.sha256) {
    const digest = await sha256(await rawBytes(message.id, MAX_TRANSFER_BYTES, check));
    check();
    if (digest !== record.sha256) throw new Error(t("mail011", "対象メールが検査時と一致しません。再検査してください。"));
    fingerprint = "sha256:" + digest;
  } else {
    // Failed/oversized scans may have no scan digest. Establish a confirmation
    // snapshot without loading the entire message or invoking the scanner.
    const raw = await api.messages.getRaw(message.id, { data_format: "File", decrypt: false });
    check();
    if (!raw || !Number.isSafeInteger(raw.size) || raw.size < 0 || typeof raw.slice !== "function") {
      throw new Error(t("mail012", "削除対象のメール内容を取得できませんでした。"));
    }
    let digest = await sha256(new TextEncoder().encode("clam-mail-check-delete-v1:" + raw.size));
    check();
    for (let offset = 0; offset < raw.size; offset += 512 * 1024) {
      check();
      const buffer = await raw.slice(offset, offset + 512 * 1024).arrayBuffer();
      check();
      const chunk = new Uint8Array(buffer);
      if (chunk.length !== Math.min(512 * 1024, raw.size - offset)) {
        throw new Error(t("mail013", "削除対象のメール内容を最後まで取得できませんでした。"));
      }
      const bytes = new Uint8Array(32 + chunk.length);
      bytes.set(digest.match(/../g).map(value => parseInt(value, 16)));
      bytes.set(chunk, 32);
      digest = await sha256(bytes);
      check();
    }
    fingerprint = "chunked-sha256-v1:" + digest;
  }
  check();
  if (expectedFingerprint && fingerprint !== expectedFingerprint) {
    throw new Error(t("mail014", "確認後にメール内容が変わりました。もう一度確認してください。"));
  }
  refreshQuarantineLocation(record, message);
  return { message, fingerprint };
}

// Carrying a human acknowledgement is optional. Never let its body proof
// hold the serial scanner, or allow an expired lookup to modify live history.
async function carryReviewFingerprint(record, expectedFingerprint) {
  let active = true, timer;
  const expired = () => new Error("Review carry-forward verification expired");
  const check = () => { if (!active) throw expired(); };
  try {
    const identity = moveIdentity(record), status = record.status;
    const copy = structuredClone(record);
    const deadline = new Promise((resolve, reject) => {
      timer = inputTimers.set(() => { active = false; reject(expired()); }, REVIEW_FINGERPRINT_TIMEOUT_MS);
    });
    const result = await Promise.race([verified(copy, expectedFingerprint, check), deadline]);
    check();
    if (moveIdentity(record) !== identity || record.status !== status ||
        (!records.includes(record) && record !== overflowPending) || deleting.has(record.key)) return null;
    refreshQuarantineLocation(record, result.message);
    record.session = copy.session;
    return result.fingerprint;
  } catch { return null; } // Keep the result unreviewed when identity is uncertain.
  finally { active = false; inputTimers.clear(timer); }
}

function excludePausedAutomatic() {
  for (const record of [...records, ...(overflowPending ? [overflowPending] : [])]) {
    if (!pausedAutomatic(record, settings)) continue;
    const previousDetail = record.detail;
    record.status = "incomplete";
    record.unscannedReason = "automaticExcluded";
    record.detail = t("automaticExcludedDetail", "検査待ちの間に自動検査の対象から外れたため、検査していません。必要に応じて再検査してください。") +
      ((record.attempts || 0) > 0 && previousDetail ? " " + t("automaticExcludedPrevious", "前回の説明：$1", [previousDetail]) : "");
    delete record.detailMessages;
    record.nextRetry = null;
    record.updatedAt = new Date().toISOString();
  }
}

async function quarantineRecord(record, config, automatic = false) {
  if (deleting.has(record.key)) throw new Error(t("qBusy", "このメールは処理中です。"));
  deleting.add(record.key);
  try {
    await moveToQuarantine(api, record, config, { verified, rawBytes, save, session, automatic });
    return true;
  } catch (error) {
    record.quarantine = { ...record.quarantine, status: "error", detail: error.message,
      updatedAt: new Date().toISOString() };
    await save();
    return false;
  } finally { deleting.delete(record.key); }
}

// Bound optional background I/O, and invalidate every continuation after expiry.
async function quarantineDeadline(operation, ms) {
  let active = true, timer;
  const expired = () => new Error(t("qDeadline", "隔離の確認が時間切れになりました。Thunderbirdで元のフォルダーと隔離先を確認してください。自動で再移動はしません。"));
  const check = () => { if (!active) throw expired(); };
  try {
    const deadline = new Promise((resolve, reject) => {
      timer = inputTimers.set(() => { active = false; reject(expired()); }, ms);
    });
    return await Promise.race([operation(check), deadline]);
  } finally { active = false; inputTimers.clear(timer); }
}

function startAutomaticQuarantine(record, config) {
  let identity;
  const digest = record.sha256;
  const target = structuredClone(config);
  automaticQuarantineTasks.add(record);
  deleting.add(record.key); // Protect queued work as well as the active move.
  record.quarantine = { status: "moving", destination: target, updatedAt: new Date().toISOString() };
  identity = moveIdentity(record);
  const admitted = save();
  void admitted.catch(() => {});
  const requested = () => {
    const selected = settings.quarantine?.[record.locator.accountId];
    return settings.enabled && settings.accountIds.includes(record.locator.accountId) && selected?.auto &&
      selected.folderId === target.folderId && selected.path === target.path && selected.activation === target.activation;
  };
  const work = async () => {
    const current = () => {
      if (!automaticQuarantineTasks.has(record) || record.status !== "detected" || record.sha256 !== digest ||
          moveIdentity(record) !== identity || maintenanceActive() || helperRemoved || !requested()) {
        throw new Error(t("qChanged", "対象または隔離先が変わりました。もう一度確認してください。"));
      }
    };
    try {
      await admitted;
      current();
      const copy = structuredClone(record);
      await quarantineDeadline(async deadlineCheck => {
        const check = () => { deadlineCheck(); current(); };
        const commit = async () => {
          check();
          // No body I/O modifies the live record; only a current operation may commit.
          record.quarantine = structuredClone(copy.quarantine);
          if (copy.quarantine?.status === "moved") {
            record.locator = copy.locator; record.messageId = copy.messageId; record.session = copy.session;
          }
          identity = moveIdentity(record);
          await save();
          deadlineCheck();
        };
        await moveToQuarantine(api, copy, target, { verified, rawBytes, save: commit, session, automatic: true, check });
      }, QUARANTINE_TIMEOUT_MS);
    } catch (error) {
      if (automaticQuarantineTasks.has(record)) {
        record.quarantine = { ...record.quarantine, status: "error", detail: error.message, updatedAt: new Date().toISOString() };
        if (requested() && !records.includes(record) && !overflowReport?.recent.includes(record) && overflowPending !== record) {
          report(t("qUnretainedFailure", "履歴上限で詳細が残っていないメールの自動隔離を完了できませんでした。Thunderbirdで元のフォルダーと隔離先を確認してください。自動で再移動はしません。 $1", [String(error.message || error)]));
        }
        await save();
      }
    } finally {
      automaticQuarantineTasks.delete(record);
      deleting.delete(record.key);
      void drain().catch(report);
    }
  };
  automaticQuarantines = automaticQuarantines.catch(report).then(work);
  void automaticQuarantines.catch(report);
}

function requestedKeys(keys) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 1000 ||
      keys.some(key => typeof key !== "string") || new Set(keys).size !== keys.length) {
    throw new Error(t("mail015", "一括操作は重複のない1〜1000件を選択してください。"));
  }
  return keys;
}

function startBatch(operation, total, phase = "execute") {
  if (batchProgress?.active) throw new Error(t("bulkBusy", "一括操作の処理中です。"));
  batchProgress = { id: crypto.randomUUID(), operation, phase, active: true, stopRequested: false,
    total, completed: 0, deleted: 0, failed: 0, cancelled: 0 };
  return batchProgress;
}
const yieldBatch = () => new Promise(resolve => setTimeout(resolve, 0));
function restoreRetryRecord(record) {
  const previous = record.bulkRetryBefore;
  if (!previous) return;
  for (const key of Object.keys(record)) delete record[key];
  Object.assign(record, previous, { nextRetry: null });
}
function finishRetry(record) {
  if (!retryContext || retryContext.staging || record.bulkRetryId !== retryContext.id) return;
  retryContext.entries.delete(record.key);
  delete record.bulkRetryId; delete record.bulkRetryBefore;
  batchProgress.completed++;
  if (scanFailed(record)) batchProgress.failed++;
  if (!retryContext.entries.size) { batchProgress.active = false; retryContext = null; }
}

async function prepareBatch(keys, preparationId = crypto.randomUUID()) {
  if (typeof preparationId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(preparationId)) throw new Error(t("mail015", "一括操作は重複のない1〜1000件を選択してください。"));
  requestedKeys(keys);
  if (batchProgress?.active) throw new Error(t("mail016", "一括削除の処理中です。"));
  const progress = startBatch("delete", keys.length, "prepare");
  progress.preparationId = preparationId;
  let cancel;
  const context = { id: preparationId, cancelled: false, signal: new Promise(resolve => { cancel = resolve; }) };
  context.cancel = () => { context.cancelled = true; progress.stopRequested = true; cancel(); };
  deletionPreparation = context;
  const check = () => { if (context.cancelled || deletionPreparation !== context) throw new Error("Deletion preparation cancelled"); };
  try {
    if (cancelledPreparations.delete(preparationId)) context.cancel();
    if (context.cancelled) return { ok: true, cancelled: true, targets: [] };
    const allowed = await Promise.race([api.permissions.contains({ permissions: ["messagesDelete"] }), context.signal]);
    check();
    if (!allowed) throw new Error(t("mail017", "完全削除の権限がありません。"));
    const tickets = [], targets = [], positions = new Set();
    for (const key of keys) {
      if (progress.stopRequested) return { ok: true, cancelled: true, targets: [] };
      const record = deletable(key);
      if (deleting.has(key)) throw new Error(t("mail018", "削除処理中のメールがあります。"));
      const hash = record.sha256, identity = moveIdentity(record);
      const copy = structuredClone(record);
      const proof = await Promise.race([verified(copy, null, check), context.signal]);
      check();
      const { message, fingerprint } = proof;
      if (deletable(key).sha256 !== hash || moveIdentity(record) !== identity) throw new Error(t("mail019", "検査結果が変わりました。選び直してください。"));
      refreshQuarantineLocation(record, message); record.session = copy.session;
      const place = position(message);
      if (positions.has(place)) throw new Error(t("mail020", "同じメールを指す履歴が含まれています。重複を外してください。"));
      positions.add(place);
      tickets.push({ key, hash, fingerprint, position: place });
      targets.push({ key, author: message.author || t("mail021", "差出人なし"), subject: message.subject || t("mail022", "件名なし"),
        accountId: message.folder.accountId, folder: message.folder.name || message.folder.path || "", folderInfo: message.folder,
        status: record.status, signatures: record.signatures || [] });
      progress.completed++;
      if (progress.completed % 25 === 0) await yieldBatch();
    }
    for (const [token, batch] of batchTickets) {
      if (batch.expires < Date.now()) batchTickets.delete(token);
    }
    if (batchTickets.size >= 10) throw new Error(t("mail023", "未完了の確認が多いため、ほかの確認画面を閉じてやり直してください。"));
    if (progress.stopRequested) return { ok: true, cancelled: true, targets: [] };
    const token = crypto.randomUUID();
    batchTickets.set(token, { tickets, expires: Date.now() + 300000 });
    return { ok: true, token, targets };
  } catch (error) {
    if (context.cancelled) return { ok: true, cancelled: true, targets: [] };
    progress.error = true; progress.failed++;
    progress.completed = Math.min(progress.total, progress.completed + 1);
    throw error;
  } finally {
    if (deletionPreparation === context) deletionPreparation = null;
    cancelledPreparations.delete(preparationId);
    progress.active = false; progress.cancelled = progress.total - progress.completed;
  }
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
    delete record.unscannedReason;
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
  // Capture other saves after a record reservation or removal has settled.
  if (recordStaging) return recordStaging.then(() => save());
  return persistState();
}

function persistState(history = records, overflow = overflowPending, recovery = receiptRecovery, problem = issue) {
  // Take a snapshot now, then serialize storage writes so an older snapshot
  // cannot overwrite a later scan result.
  const snapshot = stateStorage.snapshot({ directMigrationBackup, incrementalMigrationBackup, overflowPending: overflow, overflowReport, issue: problem, receiptRecovery: recovery, lastHealth, lastScan, helperRemoved, installation,
    folderJob: folderScan.snapshot() }, history, folderScan.checkpoints.snapshot(folderScan.job?.id));
  writes = writes.catch(() => {}).then(() => stateStorage.write(snapshot, settings));
  void updateBadge().catch(() => {});
  return writes;
}

function changeSettings(input) {
  const requested = structuredClone(input);
  const work = async () => {
    const ids = (await api.accounts.list()).map(account => account.id);
    const previous = settings;
    const candidate = validateSettings(requested, ids);
    const quarantine = await validateQuarantine(api, requested.quarantine, ids, previous.quarantine);
    for (const [accountId, config] of Object.entries(quarantine || {})) {
      const old = previous.quarantine?.[accountId];
      if (config.auto) config.activation = old?.auto && old.folderId === config.folderId && old.path === config.path && old.activation ? old.activation : crypto.randomUUID();
    }
    const next = { ...candidate, ...(quarantine ? { quarantine } : {}) };
    writes = writes.catch(() => {}).then(async () => {
      if (maintenanceActive() || helperRemoved) throw new Error(t("mail005", "補助プログラムの管理が完了してから操作してください。"));
      if (batchProgress?.active && ["quarantine", "review"].includes(batchProgress.operation)) throw new Error(t("qBusy", "このメールは処理中です。"));
      // Publish only after persistence succeeds; failed saves have no runtime
      // effects. On startup, queued exclusions are derived from these settings.
      await api.storage.local.set({ settings: next });
      settings = next;
      excludePausedAutomatic();
      if (!settings.enabled && !running) scanConnection.discard();
    });
    await writes;
    void updateBadge().catch(report);
    void drain().catch(report);
    return { ok: true };
  };
  settingsChanges = settingsChanges.catch(() => {}).then(work);
  return settingsChanges;
}

function restoreRetryState(record, before) {
  for (const name of Object.keys(record)) if (!Object.hasOwn(before, name)) delete record[name];
  Object.assign(record, before);
}

async function reserveRecords(targets, operation) {
  let release;
  recordStaging = new Promise(resolve => { release = resolve; });
  for (const record of targets) deleting.add(record.key);
  try { return await operation(); }
  finally {
    for (const record of targets) deleting.delete(record.key);
    recordStaging = null;
    release();
    void drain().catch(report);
  }
}

function retryRecord(key) {
  const work = async () => {
    if (maintenanceActive() || helperRemoved) throw new Error(t("mail005", "補助プログラムの管理が完了してから操作してください。"));
    if (batchProgress?.active) throw new Error(t("bulkBusy", "一括操作の処理中です。"));
    const record = records.find(item => item.key === key);
    if (!record || deleting.has(record.key) || ["scanning", "queued", "deleted"].includes(record.status)) throw new Error(t("mail074", "この結果は再検査できません。"));
    const before = { ...record };
    await reserveRecords([record], async () => {
      try {
        rememberResult(record);
        Object.assign(record, { status: "queued", source: "manual", attempts: 0, nextRetry: null, folderJobId: null });
        delete record.unscannedReason;
        await persistState();
      } catch (error) {
        restoreRetryState(record, before);
        await updateBadge().catch(report);
        throw error;
      }
    });
    return { ok: true };
  };
  recordChanges = recordChanges.catch(() => {}).then(work);
  return recordChanges;
}

function retryMany(keys) {
  const work = async () => {
    if (maintenanceActive() || helperRemoved) throw new Error(t("mail005", "補助プログラムの管理が完了してから操作してください。"));
    if (batchProgress?.active) throw new Error(t("bulkBusy", "一括操作の処理中です。"));
    requestedKeys(keys);
    const targets = keys.map(key => records.find(record => record.key === key));
    if (targets.some(record => !record || deleting.has(record.key) || !canRetry(record))) throw new Error(t("mail075", "再検査できない結果が含まれています。選び直してください。"));
    const progress = startBatch("retry", targets.length, "prepare");
    const before = new Map(targets.map(record => [record, { ...record }]));
    retryContext = { id: progress.id, staging: true, entries: new Map(targets.map(record => [record.key, record])) };
    await reserveRecords(targets, async () => {
      let committed = false;
      try {
        for (const record of targets) {
          rememberResult(record);
          Object.assign(record, { bulkRetryId: progress.id, bulkRetryBefore: before.get(record), unscannedReason: null,
            status: "queued", source: "manual", attempts: 0, nextRetry: null, folderJobId: null });
        }
        await persistState();
        committed = true;
        if (progress.stopRequested) {
          for (const record of targets) restoreRetryRecord(record);
          progress.cancelled = targets.length;
          await persistState();
          retryContext = null;
          progress.active = false;
        } else {
          retryContext.staging = false;
          progress.phase = "execute";
        }
      } catch (error) {
        if (!committed) for (const record of targets) restoreRetryState(record, before.get(record));
        retryContext = null;
        progress.active = false;
        progress.error = true;
        progress.cancelled = targets.length;
        await updateBadge().catch(report);
        throw error;
      }
    });
    return { ok: true, count: progress.stopRequested ? 0 : targets.length, ...(progress.stopRequested ? { cancelled: true } : {}) };
  };
  recordChanges = recordChanges.catch(() => {}).then(work);
  return recordChanges;
}

function forgetRecords(token) {
  const work = async () => {
    if (maintenanceActive() || helperRemoved) throw new Error(t("mail005", "補助プログラムの管理が完了してから操作してください。"));
    if (batchProgress?.active) throw new Error(t("bulkBusy", "一括操作の処理中です。"));
    const ticket = historyTickets.get(token); historyTickets.delete(token);
    if (!ticket || ticket.expires < Date.now()) throw new Error(t("mail076", "削除確認が期限切れです。選び直してください。"));
    const targets = ticket.entries.flatMap(entry => {
      const record = records.find(record => record.key === entry.key);
      return record && canForget(record) && !deleting.has(record.key) && JSON.stringify(record) === entry.fingerprint ? [record] : [];
    });
    const keys = new Set(targets.map(record => record.key)), previousBatch = batchProgress;
    await reserveRecords(targets, async () => {
      // Keep the visible history until the candidate snapshot is committed.
      // Deferred saves then capture either the unchanged history on failure,
      // or the removal plus any concurrently added results on success.
      await persistState(records.filter(record => !keys.has(record.key)));
      records = records.filter(record => !keys.has(record.key));
      if (batchProgress === previousBatch) batchProgress = null;
    });
    await updateBadge().catch(report);
    return { ok: true, keys: [...keys], count: keys.size, skipped: ticket.entries.length - keys.size };
  };
  recordChanges = recordChanges.catch(() => {}).then(work);
  return recordChanges;
}

function toolbarState() {
  return toolbarNotice(installation, api.runtime.getManifest().version, issue || (receiptRecovery ? receiptRecoveryMessage() : ""), records.filter(needsAttention).length + (overflowReport?.recent || []).filter(needsAttention).length);
}
async function updateBadge() {
  toolbar.update(toolbarState());
}

function moveResultStamp(record) {
  return JSON.stringify([record.sha256, record.status, record.lastAttempt, record.detail, record.signatures, record.advisories, record.unscannedReason]);
}

function notify(record, coalescedMove = false) {
  if (!settings.notifications || !needsAttention(record)) return;
  // A transient failure is actionable only after its scheduled retry fails.
  if (scanFailed(record) && record.nextRetry) return;
  if (record.status === "advisory" && !advisoryNotifies(record)) return;
  const stamp = moveResultStamp(record);
  if (coalescedMove && notifiedMoveResults.get(record) === stamp) return;
  let work = notificationWork.get(record);
  if (!work) { work = { pending: new Map(), latest: null }; notificationWork.set(record, work); }
  // The submission is not yet known to have succeeded. Suppress overlapping
  // identical submissions without treating a failure as a delivered notice.
  if (work.pending.has(stamp)) { work.latest = work.pending.get(stamp); return; }
  const ticket = {};
  work.pending.set(stamp, ticket); work.latest = ticket;
  const current = () => work.latest === ticket && moveResultStamp(record) === stamp;
  const options = {
    type: "basic", iconUrl: api.runtime.getURL("icon.svg"),
    title: t("mail211", "ClamAV メール検査：") + LABELS[record.lastAttempt?.status || record.status],
    message: t("mail030", "Thunderbirdの検査結果画面で対象メールを確認してください。")
  };
  // Subjects/senders are deliberately omitted. No caller waits for the OS.
  void (async () => {
    try {
      await api.notifications.create(record.key, options);
      if (current()) notifiedMoveResults.set(record, stamp);
    } catch {
      if (current() && settings.notifications && needsAttention(record)) {
        report(t("mail031", "デスクトップ通知を表示できません。結果画面を確認してください。"));
      }
    } finally { work.pending.delete(stamp); }
  })();
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

async function rawBytes(messageId, maxBytes = MAX_TRANSFER_BYTES, check = () => {}) {
  check();
  // Never request decryption: this version must not prompt for keys or store
  // decrypted mail. Encrypted MIME is explicitly marked incomplete by the host.
  const raw = await api.messages.getRaw(messageId, { data_format: "File", decrypt: false });
  check();
  if (!raw || typeof raw.arrayBuffer !== "function") {
    throw new Error(t("mail032", "メールデータをFile形式で取得できませんでした。"));
  }
  if (!raw.size || raw.size > maxBytes) {
    const error = new Error(maxBytes === MAX_BYTES ? t("mail033", "メールが空か、検査上限の25MiBを超えています。") : t("scanSizeExceeded", "メールが空か、検査上限の$1MiBを超えています。", [maxBytes / 1024 / 1024]));
    error.incomplete = true;
    throw error;
  }
  const buffer = await raw.arrayBuffer();
  check();
  return new Uint8Array(buffer);
}

async function resolveRecord(record, check = () => {}) {
  // A persisted Thunderbird numeric ID must never be reused after restart.
  if (record.session === session && Number.isInteger(record.messageId)) {
    try {
      const message = await api.messages.get(record.messageId);
      check();
      if (sameEnvelope(message, record.locator)) return message;
    } catch { check(); /* Moved/deleted messages are resolved below. */ }
  }
  if (!record.locator.headerMessageId) {
    throw new Error(t("mail034", "対象を再特定できません。Thunderbirdで選択して再検査してください。"));
  }
  const candidates = [];
  check();
  const first = await api.messages.query({ headerMessageId: record.locator.headerMessageId });
  check();
  for await (const message of messagePages(api.messages, first, check)) {
    if (sameEnvelope(message, record.locator)) candidates.push(message);
    if (candidates.length > 20) throw new Error(t("mail035", "同じ識別情報のメールが多いため、対象を特定できません。"));
  }
  const matches = [];
  for (const candidate of candidates) {
    if (!record.sha256 || await sha256(await rawBytes(candidate.id, MAX_TRANSFER_BYTES, check)) === record.sha256) {
      matches.push(candidate);
    }
  }
  check();
  if (matches.length !== 1) {
    throw new Error(t("mail036", "対象メールが存在しないか、複数候補があり特定できません。選択して再検査してください。"));
  }
  record.messageId = matches[0].id;
  record.session = session;
  record.locator = locator(matches[0]);
  return matches[0];
}

// Mixed special-use folders may also receive real mail; keep scanning those.
const isDraftFolder = folder => Array.isArray(folder?.specialUse) && folder.specialUse.includes("drafts") &&
  folder.specialUse.every(use => use === "drafts");

// Only an initial automatic failure with no verdict or human action may be
// redirected without a digest. Existing verdicts still require body matching.
function canRecoverMovedInput(record) {
  return record.source === "automatic" && record.status === "error" && record.attempts === 1 && Boolean(record.nextRetry) &&
    !record.sha256 && !record.lastResult && !record.lastAttempt && !record.review && !record.reviewBeforeScan &&
    !record.quarantine && !record.bulkRetryId && !record.folderJobId;
}

function recoverMovedInput(record, expectedPosition) {
  const work = async () => {
    if (!records.includes(record) || deleting.has(record.key) || !canRecoverMovedInput(record) ||
        position({ id: record.messageId, folder: record.locator.folder }) !== expectedPosition ||
        maintenanceActive() || helperRemoved || !settings.enabled || !settings.accountIds.includes(record.locator.accountId)) return;
    const duplicates = records.filter(other => other !== record && other.session === session && other.messageId === record.messageId &&
      JSON.stringify(other.locator) === JSON.stringify(record.locator));
    const duplicate = duplicates.length === 1 ? duplicates[0] : null;
    const keepDestination = duplicate && duplicate.source === "automatic" && !deleting.has(duplicate.key) &&
      !duplicate.review && !duplicate.reviewBeforeScan && !duplicate.quarantine && !duplicate.bulkRetryId &&
      !duplicate.lastResult && !duplicate.lastAttempt && duplicate.status !== "deleted" &&
      (["queued", "scanning"].includes(duplicate.status) || Boolean(duplicate.sha256));
    await reserveRecords([record, ...(keepDestination ? [duplicate] : [])], async () => {
      if (keepDestination) {
        // There was no origin verdict to transfer. Keep the independently
        // scanned/pending destination, never discard a human decision.
        await persistState(records.filter(item => item !== record));
        records = records.filter(item => item !== record);
      } else {
        const candidate = { ...record, status: "queued", nextRetry: null };
        await persistState(records.map(item => item === record ? candidate : item));
        Object.assign(record, candidate);
      }
    });
    await updateBadge().catch(report);
  };
  recordChanges = recordChanges.catch(() => {}).then(work);
  return recordChanges;
}

async function readScanInput(record, maxBytes, check) {
  for (let retry = 0; ; retry++) {
    check();
    const revision = moveRevisions.get(record) || 0;
    const before = moveLocationStamp(record);
    const lookup = { ...record };
    try {
      // resolveRecord may reconstruct IDs after restart. Its late completion
      // must never modify the live history belonging to another attempt.
      const message = await resolveRecord(lookup, check);
      check();
      if (before === moveLocationStamp(record) && revision === (moveRevisions.get(record) || 0)) {
        record.messageId = lookup.messageId; record.session = lookup.session; record.locator = lookup.locator;
      }
      if (message.headersOnly) throw new Error(t("mail043", "ヘッダーのみ取得されたメールです。本文をダウンロードして再検査してください。"));
      const bytes = await rawBytes(message.id, maxBytes, check);
      check();
      return { message, bytes };
    } catch (error) {
      check();
      // Explicit moves may redirect retrieval, within the same overall deadline.
      if (error.incomplete || retry >= 2 || revision === (moveRevisions.get(record) || 0)) throw error;
    }
  }
}

async function prepareScanInput(record, maxBytes) {
  let active = true, timer, inputDigest = null;
  const expired = () => new Error(t("scanInputTimeout", "メールの特定・本文の取得または照合が60秒以内に完了しませんでした。時間をおいて再検査してください。"));
  const check = () => { if (!active) throw expired(); };
  const work = async () => {
    const { message, bytes } = await readScanInput(record, maxBytes, check);
    const digest = await sha256(bytes);
    check();
    inputDigest = digest;
    record.sha256 = digest;
    // Input redirected by a move must still match the bytes to be inspected.
    let current = message;
    for (let attempt = 0; position(current) !== position({ id: record.messageId, folder: record.locator.folder }); attempt++) {
      if (attempt >= 3) throw new Error(t("mail036", "対象メールが存在しないか、複数候補があり特定できません。選択して再検査してください。"));
      current = await api.messages.get(record.messageId);
      check();
      if (!sameEnvelope(current, record.locator) || await sha256(await rawBytes(current.id, maxBytes, check)) !== digest) {
        check();
        throw new Error(t("mail036", "対象メールが存在しないか、複数候補があり特定できません。選択して再検査してください。"));
      }
      check();
    }
    check();
    refreshQuarantineLocation(record, current);
    return { bytes, digest };
  };
  try {
    const deadline = new Promise((resolve, reject) => {
      timer = inputTimers.set(() => { active = false; reject(expired()); }, SCAN_INPUT_TIMEOUT_MS);
    });
    return await Promise.race([work(), deadline]);
  } catch (error) {
    const failure = new Error(error?.message || String(error), { cause: error });
    if (error?.incomplete) failure.incomplete = true;
    if (inputDigest) failure.scanInputDigest = inputDigest;
    throw failure;
  } finally { active = false; inputTimers.clear(timer); }
}

function quarantineHistory() {
  return [...new Set([...records, ...(overflowReport?.recent || []), ...(overflowPending ? [overflowPending] : []), ...automaticQuarantineTasks])];
}
function pendingQuarantineCheck(record) {
  return record?.quarantineCheckPending === true && record.source === "automatic" && record.status === "queued" &&
    !deleting.has(record.key) && settings.enabled && settings.accountIds.includes(record.locator.accountId);
}

// The queued locator is durable before body I/O. Only this independent worker
// waits for quarantine identity proofs; admission, manual work and drain do not.
async function checkQuarantineReceipts() {
  if (checkingQuarantineReceipts || maintenanceActive() || helperRemoved) return;
  checkingQuarantineReceipts = true;
  const attempted = new Set();
  try {
    while (!maintenanceActive() && !helperRemoved) {
      const record = [...records, ...(overflowPending ? [overflowPending] : [])].find(item =>
        pendingQuarantineCheck(item) && !attempted.has(item));
      if (!record) break;
      attempted.add(record);
      const identity = moveIdentity(record);
      let message, digest = null, known = false;
      try {
        const proof = await quarantineDeadline(async check => {
          const copy = structuredClone(record);
          const message = await resolveRecord(copy, check);
          check();
          let digest = null;
          const known = await inQuarantine(message, settings, quarantineHistory(), { session, digestOf: async message => {
            const hash = await sha256(await rawBytes(message.id, MAX_TRANSFER_BYTES, check));
            check(); digest = hash; return hash;
          } });
          check();
          const current = await resolveRecord(structuredClone(record), check);
          check();
          return { message: current, digest, known: known && position(current) === position(message) };
        }, QUARANTINE_RECEIPT_TIMEOUT_MS);
        ({ message, digest, known } = proof);
      } catch { /* Timeout/uncertain identity falls back to ordinary inspection. */ }
      const commit = async () => {
        if ((!records.includes(record) && overflowPending !== record) || !pendingQuarantineCheck(record) ||
            moveIdentity(record) !== identity || maintenanceActive() || helperRemoved) return;
        // The supporting history may have been removed/moved while I/O waited.
        // Re-evaluate using only the already-read digest: no body I/O in this gate.
        const suppress = known && message && quarantineCandidates(message, quarantineHistory()).some(item =>
          item.session === session && item.messageId === message.id || digest && item.sha256 === digest);
        await reserveRecords([record], async () => {
          if (suppress) {
            await persistState(records.filter(item => item !== record), overflowPending === record ? null : overflowPending);
            // Settings writes have their own queue and may finish during ours.
            // Keep the excluded receipt if its account was disabled meanwhile.
            if (!settings.enabled || !settings.accountIds.includes(record.locator.accountId)) {
              excludePausedAutomatic();
              await persistState();
            } else {
              records = records.filter(item => item !== record);
              if (overflowPending === record) overflowPending = null;
            }
          } else {
            const candidate = { ...record, detail: t("mail038", "検査を待っています。") };
            delete candidate.quarantineCheckPending;
            if (message && sameEnvelope(message, record.locator)) {
              candidate.locator = locator(message); candidate.messageId = message.id; candidate.session = session;
            }
            await persistState(records.map(item => item === record ? candidate : item), overflowPending === record ? candidate : overflowPending);
            Object.assign(record, candidate);
            delete record.quarantineCheckPending;
            excludePausedAutomatic();
            if (record.status !== "queued") await persistState();
          }
        });
        wakeOverflow();
        return true;
      };
      recordChanges = recordChanges.catch(() => {}).then(commit);
      const committed = await recordChanges.catch(error => {
        const detail = error instanceof Error ? error.message : String(error);
        quarantineCheckFailures.set(record, detail);
        report(error);
        return false; // A failed save retains the queued proof.
      });
      if (committed && quarantineCheckFailures.has(record)) {
        const previous = quarantineCheckFailures.get(record);
        quarantineCheckFailures.delete(record);
        if (issue === previous) { issue = ""; await save().catch(report); }
      }
    }
  } finally { checkingQuarantineReceipts = false; }
}

// Admission shares the same commit gate as retries and history changes.
// Overflow waits happen outside the gate so the scanner can free its slot.
function stageMessage(message, source) {
  const work = async () => {
    let quarantineCheckPending = false;
    if (source === "automatic") {
      if (isDraftFolder(message.folder)) return {};
      if (!settings.enabled || !settings.accountIds.includes(accountOf(message))) return {};
      const candidates = quarantineCandidates(message, quarantineHistory());
      if (candidates.some(record => record.session === session && record.messageId === message.id)) return {};
      quarantineCheckPending = candidates.length > 0;
      if ((overflowReport?.recent || []).some(record => record.session === session && record.messageId === message.id)) return {};
    } else {
      if (maintenanceActive() || helperRemoved) throw new Error(t("mail005", "補助プログラムの管理が完了してから操作してください。"));
      if (batchProgress?.active) throw new Error(t("bulkBusy", "一括操作の処理中です。"));
    }
    const existing = [...records, ...(overflowPending ? [overflowPending] : []), ...automaticQuarantineTasks].find(record => record.session === session && record.messageId === message.id);
    if (existing && source === "automatic") return {};
    if (existing && (existing === overflowPending || deleting.has(existing.key) || ["deleted", "queued", "scanning"].includes(existing.status))) return {};
    const evicted = !existing && records.length >= MAX_RECORDS ? records.find(record =>
      ["clean", "deleted"].includes(record.status) && !deleting.has(record.key)) : null;
    const overflow = !existing && records.length >= MAX_RECORDS && !evicted;
    if (overflow && (overflowPending || source === "manual" && automaticReceipts)) return { retry: true, wait: new Promise(resolve => overflowWaiters.add(resolve)) };
    const candidate = existing ? { ...existing } : { key: crypto.randomUUID(), createdAt: new Date().toISOString() };
    rememberResult(candidate);
    Object.assign(candidate, { messageId: message.id, session, locator: locator(message), source,
      quarantineIntent: source === "automatic" && settings.quarantine?.[accountOf(message)]?.auto ? {
        folderId: settings.quarantine[accountOf(message)].folderId, path: settings.quarantine[accountOf(message)].path,
        activation: settings.quarantine[accountOf(message)].activation
      } : null,
      unscannedReason: null, status: "queued", detail: t("mail038", "検査を待っています。"), signatures: [],
      sha256: null, engine: null, attempts: 0, nextRetry: null, folderJobId: null, updatedAt: new Date().toISOString() });
    delete candidate.quarantineCheckPending;
    if (quarantineCheckPending) {
      candidate.quarantineCheckPending = true;
      candidate.detail = t("qReceiptChecking", "隔離済みのメールか確認するため、検査を保留しています。");
    }
    let wait;
    await reserveRecords([existing, evicted].filter(Boolean), async () => {
      const history = existing ? records.map(record => record === existing ? candidate : record) :
        overflow ? records : [...records.filter(record => record !== evicted), candidate];
      await persistState(history, overflow ? candidate : overflowPending);
      if (existing) Object.assign(existing, candidate);
      else if (overflow) {
        overflowPending = candidate;
        wait = new Promise(resolve => overflowWaiters.add(resolve));
      } else {
        if (evicted) records = records.filter(record => record !== evicted);
        records.push(candidate);
      }
      // An account can be disabled while the candidate's write is pending.
      if (source === "automatic") {
        excludePausedAutomatic();
        if (candidate.status !== "queued") await persistState();
      }
    });
    await updateBadge().catch(report);
    for (const receipt of pendingReceipts) {
      if (receipt.current?.id === message.id) receipt.current = null;
    }
    return { wait };
  };
  recordChanges = recordChanges.catch(() => {}).then(work);
  return recordChanges;
}

function receiptRecoveryMessage() {
  return t("receiptRecoveryHint", "新着メールの受付が上限に達し、未検査のメールが残っている可能性があります。自動検査を有効にしていたアカウントの受信先・振り分け先フォルダーを「検査」タブから検査してください。この案内は、再検査を終えてから閉じてください。");
}
async function saveReceiptRecovery() {
  if (savingReceiptRecovery || !receiptRecoveryDirty) return;
  savingReceiptRecovery = true;
  const token = receiptRecovery?.token;
  try {
    await save();
    receiptRecoveryDirty = receiptRecovery?.token !== token;
  } catch (error) { report(error); }
  finally { savingReceiptRecovery = false; }
}
function deferReceipt(page) {
  receiptRecovery = { token: crypto.randomUUID() };
  if (page?.id && api.messages.abortList) void api.messages.abortList(page.id).catch(report);
  // One bounded marker replaces excess headers, never a successful verdict.
  report(receiptRecoveryMessage());
  receiptRecoveryDirty = true;
  void saveReceiptRecovery();
}

// Retain the current page after an IO failure, but bound active and failed
// notifications together. Excess lists require an explicit folder reinspection.
function receiptPages(first, receipt) {
  let page = first, offset = 0;
  return { async next() {
    while (page) {
      if (offset < page.messages.length) return { value: page.messages[offset++], done: false };
      const id = page.id;
      page = null;
      receiptBudget.releasePage(receipt);
      if (!id) break;
      // Keep the cursor on rejection so the next attempt can retry it.
      page = { id, messages: [] };
      const next = await api.messages.continueList(id);
      if (!receiptBudget.page(receipt, next)) { deferReceipt(next); page = null; break; }
      page = next; offset = 0;
    }
    return { done: true };
  } };
}

async function recoverReceipts() {
  if (recoveringReceipts) return;
  recoveringReceipts = true;
  try {
    // Snapshot once: failures wait for the next tick instead of spinning.
    const waiting = [...pendingReceipts].filter(item => !item.retryQueued);
    for (let offset = 0; offset < waiting.length; offset += 4) {
      if (maintenanceActive() || helperRemoved) break;
      for (const receipt of waiting.slice(offset, offset + 4)) void enqueueReceipt(receipt).catch(report);
      if (offset + 4 < waiting.length) await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally { recoveringReceipts = false; }
}

function enqueueReceipt(receipt) {
  if (receipt.retryQueued) return receipt.work;
  receipt.retryQueued = true;
  const work = async () => {
    try {
      while (true) {
        if (!receipt.current) {
          const next = await receipt.iterator.next();
          if (next.done) break;
          receipt.current = next.value;
        }
        const message = receipt.current;
        if (!message.external && message.folder) {
          automaticReceipts++;
          try {
            let outcome;
            do {
              outcome = await stageMessage(message, "automatic");
              void drain().catch(report);
              if (outcome.wait) await outcome.wait;
            } while (outcome.retry);
          } finally { automaticReceipts--; wakeOverflow(); }
        }
        receipt.current = null;
      }
      pendingReceipts.delete(receipt);
      receiptBudget.delete(receipt);
      if (!pendingReceipts.size && receiptIssue) {
        if (issue === receiptIssue) issue = "";
        receiptIssue = null;
      }
      await save().catch(report);
    } catch (error) {
      pendingReceipts.delete(receipt);
      pendingReceipts.add(receipt);
      receiptIssue = t("incomingReceiptPending", "新着メールの受付を保留しています。一覧取得または保存の復旧後に再開します。未保存の受付を保持するため、復旧するまでThunderbirdを終了しないでください。 $1", [String(error.message || error)]);
      report(receiptIssue);
    } finally { receipt.retryQueued = false; wakeOverflow(); }
  };
  // Each notification owns its page wait. Only durable admission is serialized.
  receipt.work = work();
  return receipt.work;
}

function enqueue(first, source) {
  if (source === "automatic") {
    const receipt = { current: null };
    if (!receiptBudget.page(receipt, first)) { deferReceipt(first); return Promise.resolve(); }
    receipt.iterator = receiptPages(first, receipt);
    return enqueueReceipt(receipt);
  }
  const work = async () => {
    for await (const message of messagePages(api.messages, first)) {
      if (message.external || !message.folder) continue;
      let outcome;
      do { outcome = await stageMessage(message, source); if (outcome.wait) await outcome.wait; } while (outcome.retry);
    }
    // Reservations are already durable; a trailing refresh failure is not a
    // rejection of the accepted selection.
    await save().catch(report);
  };
  // A retained failed receipt does not hold priority until its next attempt.
  manualMutations = manualMutations.catch(() => {}).then(work);
  return manualMutations;
}

async function drain() {
  void checkQuarantineReceipts().catch(report);
  if (running || recordStaging || maintenanceActive() || helperRemoved || batchProgress?.active && ["quarantine", "review"].includes(batchProgress.operation)) return;
  running = true;
  let client, connection, engine, configurable = false, completed = false;
  try {
    while (true) {
      if (recordStaging) break;
      if (overflowPending && !["queued", "scanning"].includes(overflowPending.status)) {
        notify(overflowPending);
        await finishOverflow(overflowPending);
      }
      // Folder work is fed one at a time, after fresh mail and manual work.
      let record = records.find(item => !deleting.has(item.key) && item.status === "queued" && item.source === "automatic" && !item.quarantineCheckPending &&
        settings.enabled && settings.accountIds.includes(item.locator.accountId)) ||
        (overflowPending?.status === "queued" && overflowPending.source === "automatic" && !overflowPending.quarantineCheckPending &&
          settings.enabled && settings.accountIds.includes(overflowPending.locator.accountId) ? overflowPending : null) ||
        records.find(item => !deleting.has(item.key) && item.status === "queued" && item.source === "manual") ||
        (overflowPending?.status === "queued" && overflowPending.source === "manual" ? overflowPending : null);
      if (!record && folderScan.available()) {
        if (records.length >= MAX_RECORDS) {
          if (!reserveHistory()) {
            await folderScan.finish("blocked", t("mail040", "検出・未検査・失敗などの履歴で上限1000件に達したため停止しました。履歴を確認・整理し、改めて開始してください。"));
            continue;
          }
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
      const policy = scanPolicy(settings.scanSettings);
      delete record.quarantineCheckPending;
      record.scanSettings = policy;
      record.advisories = [];
      delete record.lastAttempt;
      const previousReview = record.review || record.reviewBeforeScan;
      if (previousReview) record.reviewBeforeScan = previousReview;
      delete record.review;
      record.signatures = [];
      delete record.unscannedReason;
      record.status = "scanning";
      delete record.detailMessages;
      record.detail = t("mail042", "メールを取得して検査しています。");
      record.attempts++;
      record.updatedAt = new Date().toISOString();
      await save();
      let currentDigest = null, scannerTouched = false;
      try {
        const { bytes, digest } = await prepareScanInput(record, policy.mailMiB * 1024 * 1024);
        record.sha256 = digest;
        currentDigest = digest;
        scannerTouched = true;
        if (!client || client.closed) {
          connection = scanConnection.acquire();
          client = connection.client;
          const health = connection.health || await client.request("health");
          if (!scannerReady(health)) {
            client.close();
            throw new Error(health.detail || t("mail044", "補助プログラムのバージョンが対応していません。"));
          }
          connection.health = health;
          engine = health.engine;
          configurable = health.scanSettingsVersion === 1;
        }
        record.engine = engine;
        if (!configurable && !defaultScanPolicy(policy)) throw new Error(t("scanHelperUpdate", "この検査設定には補助プログラムの更新が必要です。セットアップから更新してください。"));
        const result = await client.scan(bytes, record.sha256, configurable ? policy : undefined);
        record.status = result.status;
        record.engine = result.engine || engine;
        delete record.detailMessages;
        record.detail = result.detail;
        if (result.detailMessages) record.detailMessages = result.detailMessages;
        record.signatures = result.signatures || [];
        record.advisories = result.advisories || [];
        if (result.status !== "error") lastScan = { checkedAt: new Date().toISOString(),
          engine: record.engine, status: result.status };
        record.nextRetry = null;
        if (result.status === "error") {
          scanConnection.discard(connection);
          connection = client = null;
        }
      } catch (error) {
        currentDigest = error.scanInputDigest || currentDigest;
        if (scannerTouched || client?.closed) {
          if (connection) scanConnection.discard(connection);
          connection = client = null;
        }
        record.sha256 = currentDigest;
        record.status = error.incomplete ? "incomplete" : "error";
        delete record.detailMessages;
        record.detail = error.message || t("mail045", "検査に失敗しました。");
      }
      finishScanAttempt(record, currentDigest);
      let reviewFingerprint = record.sha256 ? "sha256:" + record.sha256 : null;
      if (previousReview?.fingerprint && !record.sha256 && record.status === "incomplete") {
        const attempt = JSON.stringify([record.status, record.attempts, record.source, record.folderJobId, record.bulkRetryId]);
        const reviewJobId = record.folderJobId;
        reviewFingerprint = await carryReviewFingerprint(record, previousReview.fingerprint);
        if ((!records.includes(record) && record !== overflowPending) || deleting.has(record.key) ||
            attempt !== JSON.stringify([record.status, record.attempts, record.source, record.folderJobId, record.bulkRetryId])) {
          // A retry or history operation superseded this attempt. Do not clear
          // its review snapshot, notify it, or complete the newer reservation.
          if (fromFolder && folderScan.job?.id === reviewJobId && folderScan.job.scanning) {
            await folderScan.complete("incomplete");
            await save();
          }
          continue;
        }
      }
      reconcileReview(record, previousReview, reviewFingerprint);
      let coalescedMove = false;
      const movedScan = movedScans.get(record);
      if (movedScan) {
        movedScans.delete(record);
        record = coalesceMovedScan(movedScan.original, record, movedScan.hash);
        coalescedMove = record === movedScan.original;
      }
      if (pendingMoveDuplicates.has(record) || pendingMoveOrigin.has(record)) await settlePendingMove(record);
      const quarantineConfig = settings.quarantine?.[record.locator.accountId];
      const autoQuarantine = record.status === "detected" && !record.lastAttempt && record.source === "automatic" && quarantineConfig?.auto && record.quarantineIntent &&
          record.quarantineIntent.folderId === quarantineConfig.folderId && record.quarantineIntent.path === quarantineConfig.path &&
          record.quarantineIntent.activation === quarantineConfig.activation;
      record.updatedAt = new Date().toISOString();
      // Two automatic attempts total; no endless retry loop on bad mail/host.
      if (!fromFolder && record !== overflowPending && !record.bulkRetryId && scanFailed(record) && record.attempts < 2) {
        record.nextRetry = Date.now() + 60000;
      }
      finishRetry(record);
      if (fromFolder) {
        const flag = record.status === "detected" ? "notifiedDetection" :
          record.status === "advisory" ? (advisoryNotifies(record) ? "notifiedAdvisory" : null) : needsAttention(record) ? "notifiedProblem" : null;
        if (flag && !folderScan.job[flag]) {
          folderScan.job[flag] = true;
          notify(record);
        }
        await folderScan.complete(record.status, record.sha256 ? {
          hint: await checkpointHint(record.locator), digest: record.sha256
        } : null);
      }
      // Reserve the detected result before yielding to storage/notification UI.
      if (autoQuarantine) startAutomaticQuarantine(record, quarantineConfig);
      await save();
      if (!fromFolder) notify(record, coalescedMove);
      if (record === overflowPending) await finishOverflow(record);
      await updateBadge();
    }
    completed = true;
  } catch (error) {
    if (retryContext && !retryContext.staging) {
      for (const record of records) {
        if (record.bulkRetryId !== retryContext.id) continue;
        if (record.status === "queued") restoreRetryRecord(record);
        else { delete record.bulkRetryId; delete record.bulkRetryBefore; }
      }
      batchProgress.active = false; batchProgress.error = true; retryContext = null;
    }
    if (overflowPending && overflowPending.status === "scanning") {
      const interrupted = overflowPending;
      interrupted.status = "error"; interrupted.nextRetry = null;
      interrupted.detail = t("overflowFailure", "保存枠不足時の検査処理に失敗しました。Thunderbirdで対象を確認して再検査してください。");
      notify(interrupted);
      try { await finishOverflow(interrupted); } catch { overflowPending = null; wakeOverflow(); }
    }
    const active = records.find(record => record.status === "scanning");
    if (active) {
      active.status = "error";
      active.detail = t("mail046", "検査状態の保存に失敗しました。保存領域を確認して再検査してください。");
      finishScanAttempt(active, active.sha256);
    }
    if (folderScan.active) {
      await folderScan.finish("error", t("mail047", "検査状態の保存などに失敗したため停止しました。結果を確認して改めて開始してください。")).catch(() => {});
    }
    throw error;
  } finally {
    try {
      if (completed) scanConnection.release(connection);
      else scanConnection.discard();
    } finally { running = false; }
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

let initializationError = null;
async function initialize() {
  const stored = await api.storage.local.get(null);
  const data = readStoredState(stored);
  stateStorage.restore(stored);
  directMigrationBackup = data.directMigrationBackup || null;
  incrementalMigrationBackup = stored.incrementalMigrationBackup || null;
  if (DIRECT && !directMigrationBackup) {
    directMigrationBackup = data.settings || data.records?.length ? await api.clamDirect.backup(JSON.stringify(stored)) : { notNeeded: true };
    incrementalMigrationBackup ||= directMigrationBackup;
    await api.storage.local.set({ directMigrationBackup, incrementalMigrationBackup });
  }
  if (DIRECT && !incrementalMigrationBackup) {
    const legacy = (Array.isArray(stored.records) && stored.records.length > 0) || stored.folderCheckpoint?.version === 1;
    incrementalMigrationBackup = legacy ? (!stored.directMigrationBackup && directMigrationBackup?.path ? directMigrationBackup :
      await api.clamDirect.backup(JSON.stringify(stored))) : { notNeeded: true };
    await api.storage.local.set({ incrementalMigrationBackup });
  }
  settings = normalizeAutomaticSettings(data.settings);
  records = Array.isArray(data.records) ? data.records : [];
  overflowPending = data.overflowPending || null;
  overflowReport = data.overflowReport || null;
  if (overflowReport) overflowReport.recent = (overflowReport.recent || []).slice(0, 20);
  issue = typeof data.issue === "string" ? data.issue : "";
  receiptRecovery = typeof data.receiptRecovery?.token === "string" ? { token: data.receiptRecovery.token.slice(0, 80) } : null;
  lastHealth = data.lastHealth || null;
  helperRemoved = !DIRECT && data.helperRemoved === true;
  installation = data.installation || null;
  lastScan = data.lastScan || records.filter(record => record.engine &&
    ["clean", "detected", "incomplete", "deleted", "advisory"].includes(record.status))
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
  let retryInterrupted = false;
  for (const record of [...records, ...(overflowPending ? [overflowPending] : []), ...(overflowReport?.recent || [])]) {
    if (record.quarantine?.status === "moving") {
      record.quarantine.status = "error";
      record.quarantine.detail = t("qInterrupted", "隔離中に終了しました。元のフォルダーと隔離先を確認してください。自動で再移動はしません。");
    }
    if (record.bulkRetryId) {
      retryInterrupted = true;
      if (record.status === "queued" && record.bulkRetryBefore) restoreRetryRecord(record);
      else if (record.status === "scanning") {
        record.status = "incomplete";
        record.unscannedReason = "bulkInterrupted";
        record.updatedAt = new Date().toISOString();
        record.detail = t("bulkRetryInterrupted", "一括再検査が中断され、このメールの結果は未確認です。必要に応じて再検査してください。");
        delete record.detailMessages;
        record.nextRetry = null;
        finishScanAttempt(record, record.sha256);
      }
      delete record.bulkRetryId; delete record.bulkRetryBefore;
    }
    record.messageId = null;
    record.session = null;
    if (record.status === "scanning" || (record.source === "folder" && record.status === "queued")) {
      record.status = record.source === "folder" ? "error" : "queued";
      delete record.detailMessages;
      record.detail = record.source === "folder" ? t("mail049", "フォルダー検査中に終了したため、このメールの結果は未確認です。") : t("mail050", "前回中断された検査を再開します。");
      if (record.source === "folder") record.nextRetry = null;
    }
  }
  if (retryInterrupted) issue = [issue, t("bulkRetryRestart", "一括再検査が中断されました。検査結果を確認してください。未着手の履歴は保持しています。")].filter(Boolean).join(" ");
  excludePausedAutomatic();
  await api.menus.removeAll();
  api.menus.create({ id: "scan", title: t("mail051", "ClamAVで選択メールを検査"), contexts: ["message_list"] });
  api.menus.create({ id: "scan-folder", title: t("mail052", "ClamAVでフォルダーを検査"), contexts: ["folder_pane"] });
  await save();
  await helperInfo();
  await updateBadge();
}
function beginInitialization() {
  initializationError = null;
  return initialize().catch(error => { initializationError = error; report(error); throw error; });
}
let ready = beginInitialization();

api.messages.onNewMailReceived.addListener((folder, list) => {
  if (isDraftFolder(folder)) {
    // No enumeration/body retrieval for draft autosaves. Release a paged list
    // even when header folders omit the special-use metadata.
    if (list.id && api.messages.abortList) void api.messages.abortList(list.id).catch(() => {});
    return;
  }
  void ready.then(() => {
    if (!settings.enabled || folder.accountId && !settings.accountIds.includes(folder.accountId)) {
      if (list.id && api.messages.abortList) void api.messages.abortList(list.id).catch(report);
      return;
    }
    return enqueue(list, "automatic");
  }).catch(report);
}, true);
// Only an explicit, content-verified move can establish this relationship.
// Ordinary copies and histories with independent human actions stay separate.
function coalesceMovedScan(original, duplicate, hash) {
  if (!records.includes(original) || !records.includes(duplicate) || original === duplicate ||
      deleting.has(original.key) || deleting.has(duplicate.key) ||
      ["queued", "scanning", "deleted"].includes(original.status) ||
      ["queued", "scanning", "deleted"].includes(duplicate.status) ||
      duplicate.source !== "automatic" || duplicate.review || duplicate.reviewBeforeScan ||
      duplicate.quarantine || duplicate.lastResult || duplicate.lastAttempt || duplicate.bulkRetryId ||
      (duplicate.quarantineIntent && JSON.stringify(original.quarantineIntent) !== JSON.stringify(duplicate.quarantineIntent)) ||
      original.sha256 !== hash || duplicate.sha256 !== hash ||
      original.session !== session || duplicate.session !== session ||
      original.messageId !== duplicate.messageId ||
      JSON.stringify(original.locator) !== JSON.stringify(duplicate.locator)) return duplicate;
  const review = original.review || original.reviewBeforeScan;
  // Conflicting human judgments require an explicit decision, not deduplication.
  if (review && (original.status !== duplicate.status || reviewReason(original) !== reviewReason(duplicate))) return duplicate;
  // A rescan can finish while move verification awaits I/O. An older
  // destination result must not retract that newer verdict.
  const originalTime = Date.parse(original.updatedAt), duplicateTime = Date.parse(duplicate.updatedAt);
  if (originalTime >= duplicateTime && retainKnownDetection(original, duplicate, hash)) {
    reconcileReview(original, review, "sha256:" + hash);
    records.splice(records.indexOf(duplicate), 1);
    return original;
  }
  if (originalTime > duplicateTime || originalTime === duplicateTime && original.status === "detected" && duplicate.status !== "detected") {
    records.splice(records.indexOf(duplicate), 1);
    return original;
  }
  rememberResult(original);
  const fields = ["status", "detail", "detailMessages", "signatures", "advisories", "sha256", "engine", "scanSettings", "updatedAt", "unscannedReason", "attempts", "nextRetry"];
  for (const key of fields) {
    delete original[key];
    if (duplicate[key] !== undefined) original[key] = structuredClone(duplicate[key]);
  }
  finishScanAttempt(original, hash);
  reconcileReview(original, review, "sha256:" + hash);
  records.splice(records.indexOf(duplicate), 1);
  return original;
}

function pristineAutomaticPending(record) {
  return record.source === "automatic" && ["queued", "scanning"].includes(record.status) &&
    !record.review && !record.reviewBeforeScan && !record.quarantine && !record.lastResult && !record.lastAttempt &&
    !record.bulkRetryId && !record.folderJobId;
}
function queuedMoveDuplicate(record) {
  return pristineAutomaticPending(record) && record.status === "queued" && !record.sha256;
}
function sameMoveWork(original, duplicate) {
  return original !== duplicate && records.includes(original) && records.includes(duplicate) &&
    !deleting.has(original.key) && !deleting.has(duplicate.key) && queuedMoveDuplicate(duplicate) &&
    original.session === session && duplicate.session === session && original.messageId === duplicate.messageId &&
    JSON.stringify(original.locator) === JSON.stringify(duplicate.locator) &&
    JSON.stringify(original.quarantineIntent || null) === JSON.stringify(duplicate.quarantineIntent || null);
}
function linkPendingMove(original, duplicate) {
  if (!pristineAutomaticPending(original) || !sameMoveWork(original, duplicate) || pendingMoveOrigin.has(original) ||
      pendingMoveDuplicates.has(duplicate) || pendingMoveOrigin.has(duplicate) && pendingMoveOrigin.get(duplicate) !== original) return;
  if (!pendingMoveDuplicates.has(original)) pendingMoveDuplicates.set(original, new Set());
  pendingMoveDuplicates.get(original).add(duplicate);
  pendingMoveOrigin.set(duplicate, original);
}

function canSettlePendingMove(record) {
  return record.source === "automatic" && !!record.sha256 && !record.lastAttempt &&
    ["clean", "detected", "incomplete", "advisory"].includes(record.status) &&
    !record.review && !record.reviewBeforeScan && !record.quarantine && !record.bulkRetryId &&
    !record.folderJobId && !record.lastResult;
}

async function settlePendingMove(original) {
  const parent = pendingMoveOrigin.get(original);
  if (parent) {
    const siblings = pendingMoveDuplicates.get(parent);
    siblings?.delete(original);
    if (!siblings?.size) pendingMoveDuplicates.delete(parent);
    pendingMoveOrigin.delete(original);
  }
  const linked = pendingMoveDuplicates.get(original);
  if (!linked?.size || !canSettlePendingMove(original)) return;
  // This optional optimization must not hold notifications, quarantine or the
  // scan queue indefinitely. Timed-out reads may finish, but cannot mutate work.
  let timer, stopped = false;
  const proof = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (stopped || !canSettlePendingMove(original)) return null;
      const expectedPosition = position({ id: original.messageId, folder: original.locator.folder });
      const digest = original.sha256, revision = moveRevisions.get(original);
      const candidates = [...linked].filter(duplicate => sameMoveWork(original, duplicate));
      if (!candidates.length) return null;
      const current = await api.messages.get(original.messageId);
      if (stopped) return null;
      const matches = position(current) === expectedPosition && sameEnvelope(current, original.locator) &&
        await sha256(await rawBytes(current.id, scanPolicy(original.scanSettings).mailMiB * 1024 * 1024)) === digest;
      // Explicit moves can arrive during the read. Verify the latest location
      // within the same deadline, rather than using stale bytes or identities.
      if (stopped) return null;
      if (moveRevisions.get(original) !== revision) continue;
      return matches ? { expectedPosition, digest, revision, candidates } : null;
    }
    return null;
  };
  let verified;
  try {
    verified = await Promise.race([
      proof().catch(() => null),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 1000); })
    ]);
  } finally { stopped = true; clearTimeout(timer); }
  if (!verified) return; // Keep the independent scan when proof is unavailable.
  const { expectedPosition, digest, revision, candidates } = verified;
  const work = async () => {
    if (original.sha256 !== digest || moveRevisions.get(original) !== revision || original.lastAttempt || original.lastResult ||
        original.review || original.reviewBeforeScan || original.quarantine || original.bulkRetryId ||
        position({ id: original.messageId, folder: original.locator.folder }) !== expectedPosition) return;
    const redundant = candidates.filter(duplicate => sameMoveWork(original, duplicate));
    if (!redundant.length) return;
    await reserveRecords([original, ...redundant], async () => {
      const removed = new Set(redundant);
      await persistState(records.filter(record => !removed.has(record)));
      records = records.filter(record => !removed.has(record));
      for (const duplicate of redundant) { linked.delete(duplicate); pendingMoveOrigin.delete(duplicate); }
      if (!linked.size) pendingMoveDuplicates.delete(original);
    });
  };
  recordChanges = recordChanges.catch(() => {}).then(work);
  await recordChanges.catch(report); // A failed save must retain the queued scan.
}

// Unverified intermediate locations are hints for later explicit moves only.
// They must never become a display/action target or transfer a prior verdict.
function moveIdentity(record) {
  return JSON.stringify([record.locator, record.messageId, record.session, record.sha256,
    record.lastResult, record.lastAttempt, record.review, record.reviewBeforeScan,
    record.quarantine, record.bulkRetryId, record.folderJobId]);
}
function moveHint(record) {
  const hint = unverifiedMoves.get(record);
  if (!hint) return null;
  if (hint.expires <= Date.now() || hint.identity !== moveIdentity(record)) {
    unverifiedMoves.delete(record);
    return null;
  }
  return hint.message;
}
function moveLocationStamp(record) {
  return JSON.stringify([record.messageId, record.session, record.locator, record.quarantine]);
}

function pendingMoveFollower(record, primary) {
  return pendingMoveOrigin.get(record) === primary && !deleting.has(record.key) &&
    pristineAutomaticPending(record) && (!record.sha256 || record.sha256 === primary.sha256);
}

function moveEnvelope(message) {
  return JSON.stringify([message.headerMessageId || "", message.author || "", message.subject || "",
    message.date ? new Date(message.date).toISOString() : ""]);
}

// Bound body I/O without making digest-free input recovery wait for a slot.
async function moveDigest(messageId) {
  if (activeMoveProofs >= 4) await new Promise(resolve => moveProofWaiters.push(resolve));
  else activeMoveProofs++;
  let active = true, timer;
  const expired = () => new Error("Move verification expired");
  const check = () => { if (!active) throw expired(); };
  try {
    const work = async () => {
      const digest = await sha256(await rawBytes(messageId, MAX_TRANSFER_BYTES, check));
      check(); return digest;
    };
    return await Promise.race([work(), new Promise((resolve, reject) => {
      timer = inputTimers.set(() => { active = false; reject(expired()); }, 10000);
    })]);
  } finally {
    active = false; inputTimers.clear(timer);
    const next = moveProofWaiters.shift();
    if (next) next();
    else activeMoveProofs--;
  }
}

// External moves (including Undo) update the display only after content
// verification. Our own quarantine/deletion operations retain their own locks.
async function applyMove(oldMessages, newMessages, digests, allowed = null) {
  const envelope = moveEnvelope;
  const tracked = new Map(), destinations = new Map();
  for (const record of new Set([...records, ...(overflowReport?.recent || []), ...(overflowPending ? [overflowPending] : [])])) {
    if (allowed && !allowed.has(record)) continue;
    const locations = [ { id: record.messageId, folder: record.locator.folder, ...record.locator }, moveHint(record) ].filter(Boolean);
    for (const location of locations) {
      const key = JSON.stringify([accountOf(location), location.folder?.path, envelope(location)]);
      if (!tracked.has(key)) tracked.set(key, []);
      if (!tracked.get(key).includes(record)) tracked.get(key).push(record);
    }
  }
  for (const message of newMessages) {
    if (!realFolder(message.folder) || message.external) continue;
    const key = envelope(message);
    if (!destinations.has(key)) destinations.set(key, []);
    destinations.get(key).push(message);
  }
  let changed = false, examined = 0;
  const recoveries = [];
  for (const old of oldMessages) {
    const key = JSON.stringify([accountOf(old), old.folder?.path, envelope(old)]);
    const possible = tracked.get(key) || [];
    // Yield for tracked work, but do not add a timer for every untracked mail.
    if (possible.length || ++examined % 100 === 0) await yieldBatch();
    const eligible = possible.filter(record => {
      const hinted = moveHint(record);
      const source = hinted && position(hinted) === position(old) ? hinted :
        { id: record.messageId, folder: record.locator.folder };
      return sameEnvelope(old, record.locator) && old.folder?.path === source.folder?.path &&
        (record.session !== session || !Number.isInteger(source.id) || source.id === old.id);
    });
    const canonical = eligible.map(item => pendingMoveOrigin.get(item) || item);
    const primary = canonical[0];
    const linkedGroup = eligible.length > 1 && primary && eligible.includes(primary) && canonical.every(item => item === primary) &&
      (pristineAutomaticPending(primary) || canRecoverMovedInput(primary) || canSettlePendingMove(primary)) &&
      eligible.every(item => item === primary || pendingMoveFollower(item, primary));
    if (eligible.length !== 1 && !linkedGroup) continue;
    const record = linkedGroup ? primary : eligible[0];
    if (deleting.has(record.key) || record.status === "deleted") continue;
    const hash = record.sha256 || record.lastResult?.sha256;
    if (!hash && !["queued", "scanning"].includes(record.status) && !canRecoverMovedInput(record)) continue;
    const before = JSON.stringify([record.locator, record.messageId, record.session, record.quarantine?.status]);
    const groupLocations = linkedGroup ? new Map(eligible.map(item => [item, moveLocationStamp(item)])) : null;
    // The original move already linked these records. A finishing scan can
    // verify the shared current location independently of the next move proof.
    // Register that reconciliation before I/O lets it finish and drop the link.
    if (linkedGroup && hash) for (const duplicate of eligible) {
      if (duplicate !== record && !movedScans.has(duplicate)) movedScans.set(duplicate, { original: record, hash });
    }
    const candidates = destinations.get(envelope(record.locator)) || [];
    if (candidates.length > 20) continue;
    // Pending work with no prior digest has no verdict to transfer. A unique
    // move-event target can redirect it; drain still reads/verifies its bytes.
    const matches = !hash && candidates.length === 1 ? [...candidates] : [];
    if (hash) for (const candidate of candidates) {
      try {
        if (!digests.has(candidate.id)) digests.set(candidate.id, moveDigest(candidate.id));
        if (await digests.get(candidate.id) === hash) matches.push(candidate);
      }
      catch { /* An unreadable move cannot transfer a prior verdict. */ }
    }
    if ((record.sha256 || record.lastResult?.sha256) !== hash || deleting.has(record.key) || record.status === "deleted" ||
        JSON.stringify([record.locator, record.messageId, record.session, record.quarantine?.status]) !== before) continue;
    if (matches.length !== 1) {
      if (hash && candidates.length === 1 && sameEnvelope(candidates[0], record.locator)) {
        for (const item of linkedGroup ? eligible : [record]) {
          unverifiedMoves.set(item, { message: structuredClone(candidates[0]), identity: moveIdentity(item), expires: Date.now() + 60000 });
        }
      }
      continue;
    }
    unverifiedMoves.delete(record);
    refreshQuarantineLocation(record, matches[0]);
    record.session = session;
    moveRevisions.set(record, (moveRevisions.get(record) || 0) + 1);
    if (linkedGroup) for (const duplicate of eligible) {
      if (duplicate !== record && records.includes(duplicate) && !deleting.has(duplicate.key) && duplicate.status !== "deleted" &&
          moveLocationStamp(duplicate) === groupLocations.get(duplicate) &&
          (hash && duplicate.sha256 === hash || pristineAutomaticPending(duplicate) && !duplicate.sha256)) {
        // Completion may have removed the pending relationship. The captured
        // location plus matching bytes still prove this explicit move; retain
        // any human judgment and let coalesceMovedScan enforce merge guards.
        refreshQuarantineLocation(duplicate, matches[0]);
        duplicate.session = session;
        moveRevisions.set(duplicate, (moveRevisions.get(duplicate) || 0) + 1);
        unverifiedMoves.delete(duplicate);
      }
    }
    if ((!hash && pristineAutomaticPending(record)) || pendingMoveDuplicates.has(record)) {
      const pending = records.filter(item => item !== record && item.session === session && item.messageId === record.messageId &&
        JSON.stringify(item.locator) === JSON.stringify(record.locator));
      if (pending.length === 1) linkPendingMove(record, pending[0]);
      else if (linkedGroup) for (const duplicate of pending) linkPendingMove(record, duplicate);
    }
    if (canRecoverMovedInput(record)) recoveries.push([record, position(matches[0])]);
    if (hash) {
      const duplicates = records.filter(item => item !== record && item.session === session &&
        item.messageId === record.messageId && JSON.stringify(item.locator) === JSON.stringify(record.locator));
      if (duplicates.length === 1) {
        const duplicate = duplicates[0];
        if (["queued", "scanning"].includes(duplicate.status)) movedScans.set(duplicate, { original: record, hash });
        else coalesceMovedScan(record, duplicate, hash);
      }
    }
    changed = true;
  }
  if (changed) await save();
  for (const [record, expectedPosition] of recoveries) await recoverMovedInput(record, expectedPosition);
}

function unscannedMoveSource(old, currentById) {
  const matching = (currentById.get(old.id) || []).filter(record => sameEnvelope(old, record.locator) &&
    record.session === session && record.messageId === old.id && record.locator.folder?.path === old.folder?.path);
  return matching.length > 0 && matching.every(record => !record.sha256 && !record.lastResult?.sha256 &&
    (["queued", "scanning"].includes(record.status) || canRecoverMovedInput(record)));
}

// Only completed metadata enters the scheduling gate. Retain later metadata
// while an earlier notification is incomplete so A→B→C can be replayed in order.
function moveIntakeError() {
  return new Error(t("moveIntakeExpired", "移動通知の一覧を確認できませんでした。履歴の場所は自動更新せずに残しています。必要ならThunderbirdのメール一覧から再検査してください。"));
}
function pruneMoveIntakes() {
  // Header scheduling contains only brief cooperative yields. Do not remove
  // replay edges halfway through registering their ordered dependencies.
  if ([...moveIntakes].some(intake => intake.scheduling)) return;
  const now = Date.now();
  const expire = intake => {
    intake.expired = true;
    moveIntakes.delete(intake);
    if (!intake.scheduled) report(moveIntakeError());
  };
  for (const intake of moveIntakes) if (now - intake.startedAt >= 60000) expire(intake);
  const trim = () => {
    let pending = false, headers = 0;
    for (const intake of moveIntakes) {
      if (!intake.scheduled) pending = true;
      else if (!pending) { moveIntakes.delete(intake); continue; }
      headers += (intake.oldMessages?.length || 0) + (intake.newMessages?.length || 0);
    }
    return headers;
  };
  let headers = trim();
  while (moveIntakes.size > 1000 || headers > 100000) {
    expire(moveIntakes.values().next().value);
    headers = trim();
  }
}

async function scheduleMove(oldMessages, newMessages, allowed = null) {
  const destinations = new Map();
  for (const message of newMessages) {
    const key = moveEnvelope(message);
    if (!destinations.has(key)) destinations.set(key, []);
    destinations.get(key).push(message);
  }
  const currentById = new Map();
  for (const record of [...records, ...(overflowPending ? [overflowPending] : [])]) {
    if (!currentById.has(record.messageId)) currentById.set(record.messageId, []);
    currentById.get(record.messageId).push(record);
  }
  const jobs = [], digests = new Map(), known = [], groups = [];
  for (const old of oldMessages) {
    if (unscannedMoveSource(old, currentById)) groups.push([old]);
    else known.push(old);
  }
  // Keep bulk, already-scanned work together so its history index and durable
  // refresh are built once. Digest-free recoveries in the same event bypass it.
  if (known.length) groups.push(known);
  for (const group of groups) {
    const targets = [...new Set(group.flatMap(old => destinations.get(moveEnvelope(old)) || []))];
    // Reserve both ends before the next notification is accepted. A→B→C
    // stays ordered even when A→B has not established a verified location.
    const keys = new Set([...group.map(position), ...targets.map(position)]);
    const prior = [...new Set([...keys].map(key => moveJobs.get(key)).filter(Boolean))];
    const job = Promise.all(prior).then(() => applyMove(group, targets, digests, allowed)).catch(report);
    for (const key of keys) moveJobs.set(key, job);
    void job.then(() => {
      for (const key of keys) if (moveJobs.get(key) === job) moveJobs.delete(key);
    });
    jobs.push(job);
    if (jobs.length % 100 === 0) await yieldBatch();
  }
  return jobs;
}

api.messages.onMoved?.addListener((originals, moved) => {
  const receipt = { startedAt: Date.now(), scheduled: false, expired: false };
  moveIntakes.add(receipt);
  pruneMoveIntakes();
  const check = () => {
    if (receipt.expired || Date.now() - receipt.startedAt >= 60000) throw moveIntakeError();
  };
  const read = async () => {
    await ready;
    const oldMessages = [], newMessages = [];
    for await (const message of messagePages(api.messages, originals, check)) oldMessages.push(message);
    for await (const message of messagePages(api.messages, moved, check)) newMessages.push(message);
    check();
    const intake = moves.catch(() => {}).then(async () => {
      check();
      receipt.scheduling = true;
      try {
        receipt.oldMessages = oldMessages; receipt.newMessages = newMessages;
        receipt.candidates = new Set(quarantineHistory());
        const jobs = await scheduleMove(oldMessages, newMessages);
        // A later notification may already have been attempted before this
        // event exposed its source. Replay only later metadata, never old verdicts.
        let later = false;
        for (const other of moveIntakes) {
          if (other === receipt) { later = true; continue; }
          if (later && other.scheduled && !other.expired) jobs.push(...await scheduleMove(other.oldMessages, other.newMessages, other.candidates));
        }
        receipt.scheduled = true;
        return jobs;
      } finally { receipt.scheduling = false; pruneMoveIntakes(); }
    });
    moves = intake.then(() => {}, report);
    return intake.then(jobs => Promise.all(jobs));
  };
  return read().catch(error => {
    receipt.scheduled = true;
    moveIntakes.delete(receipt);
    pruneMoveIntakes();
    report(error);
  });
});
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
    .then(() => { resultsFilter = null; resultsRequest = crypto.randomUUID(); return openDashboard(); }).catch(report);
});
api.browserAction.onClicked.addListener(() => {
  void ready.then(async () => {
    if (toolbarState().setup) setupRequest = crypto.randomUUID();
    else if (records.some(needsAttention) || overflowReport?.total || issue) { resultsFilter = "attention"; resultsRequest = crypto.randomUUID(); }
    await openDashboard();
  }).catch(report);
});
api.notifications.onClicked.addListener(() => { resultsFilter = null; resultsRequest = crypto.randomUUID(); void openDashboard().catch(report); });
api.runtime.onInstalled.addListener(() => { void openDashboard().catch(report); });

api.runtime.onMessage.addListener(async (request, sender) => {
  if (sender.id !== api.runtime.id || sender.url !== api.runtime.getURL("dashboard.html")) return undefined;
  try {
    // Retry only on an explicit connection check. Polling and mail operations
    // must not repeatedly initialize or run against partially recovered state.
    if (request.type === "health" && initializationError) {
      ready = beginInitialization();
      void ready.then(drain).catch(report);
    }
    await ready;
    if ((maintenanceActive() || helperRemoved) && !["state", "helperInfo", "helperApply", "helperCancel", "helperMarkRemoved", "health"].includes(request.type)) {
      throw new Error(t("mail054", "補助プログラムの管理中か削除後です。導入を確認してから操作してください。"));
    }
    if (batchProgress?.active && ["quarantine", "review"].includes(batchProgress.operation) && !["state", "cancelBatch", "helperInfo", "health"].includes(request.type)) throw new Error(t("qBusy", "このメールは処理中です。"));
    switch (request.type) {
      case "state":
        return { ok: true, directMigrationBackup, settings, records, overflowPending, overflowReport, issue, receiptRecovery, lastHealth, lastScan, resultsRequest, resultsFilter, setupRequest, installation, helperRemoved, maintenance: maintenanceActive(), batch: batchProgress, folderRequest,
          resultActionsBusy: Boolean(running || folderScan.active || deleting.size),
          folderJob: folderScan.snapshot(), accounts: (await api.accounts.list())
          .filter(account => ["imap", "pop3", "none"].includes(account.type))
          .map(account => ({ id: account.id, name: account.name, type: account.type })) };
      case "acknowledgeReceiptRecovery": {
        if (!receiptRecovery || request.token !== receiptRecovery.token) throw new Error(t("receiptRecoveryChanged", "新しい未受付があります。案内を確認してください。"));
        const work = async () => {
          if (!receiptRecovery || request.token !== receiptRecovery.token) throw new Error(t("receiptRecoveryChanged", "新しい未受付があります。案内を確認してください。"));
          const token = receiptRecovery.token;
          await persistState(records, overflowPending, null, issue === receiptRecoveryMessage() ? "" : issue);
          if (receiptRecovery?.token === token) {
            receiptRecovery = null;
            receiptRecoveryDirty = false;
            if (issue === receiptRecoveryMessage()) issue = "";
          } else {
            receiptRecoveryDirty = true;
            void saveReceiptRecovery();
          }
          await updateBadge();
          return { ok: true };
        };
        recordChanges = recordChanges.catch(() => {}).then(work);
        return await recordChanges;
      }
      case "helperInfo":
        return { ok: true, installation: await helperInfo(), health: lastHealth };
      case "helperPlan": {
        await settingsChanges.catch(() => {});
        if (DIRECT) throw new Error(t("directNoSetup", "この拡張では補助プログラムの別途導入・更新は不要です。"));
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
            settings = { ...settings, enabled: false, accountIds: [] };
            excludePausedAutomatic();
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
        await settingsChanges.catch(() => {});
        if (DIRECT) throw new Error(t("directNoSetup", "この拡張では補助プログラムの別途導入・更新は不要です。"));
        if (request.acknowledged !== true || running || folderScan.active || batchProgress?.active || deleting.size) throw new Error(t("mail065", "処理を停止し、Terminalで補助プログラムの削除が完了したことを確認してください。"));
        helperRemoved = true;
        settings = { ...settings, enabled: false, accountIds: [] };
        excludePausedAutomatic();
        installation = { state: "removed", detail: t("mail066", "Terminalでの削除完了を利用者が確認しました。") };
        await save();
        return { ok: true };
      case "settings":
        return await changeSettings(request.settings);
      case "health": {
        if (maintenanceActive()) throw new Error(t("mail005", "補助プログラムの管理が完了してから操作してください。"));
        await helperInfo();
        return { ok: true, health: lastHealth };
      }
      case "scanSelection":
        await scanSelection();
        return { ok: true };
      case "folderChoices":
        return listFolderChoices();
      case "folderContext":
        if (request.folderIds !== undefined) {
          const ids = request.folderIds;
          if (!Array.isArray(ids) || !ids.length || ids.length > 5000 || ids.some(id => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) throw new Error(t("foldersInvalid", "同じアカウントの通常のメールフォルダーを選択してください。"));
          return { ok: true, ...await chooseFolders(ids.map(id => ({ id }))) };
        }
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
        const context = folderRequest, folders = context.folders || [context.folder];
        await requireFolderScanner();
        const current = await refreshScanFolders(api, folders);
        if (folderRequest !== context || !current) throw new Error(t("mail070", "フォルダーが見つからないか、場所が変わりました。選び直してください。"));
        const job = await folderScan.start(current.map((folder, index) => ({ ...folder, displayNames: folders[index].displayNames })), request.includeSubfolders);
        folderRequest = null;
        void folderScan.collecting.catch(report);
        return { ok: true, job };
      }
      case "folderResume": {
        if (request.jobId !== folderScan.job?.id || !folderScan.resumable) throw new Error(t("mail071", "この検査は再開できません。画面を更新してください。"));
        const job = folderScan.job, folders = job.folders || [job.folder];
        await requireFolderScanner();
        const current = await refreshScanFolders(api, folders);
        if (folderScan.job !== job || !current) throw new Error(t("mail072", "元のフォルダーが見つからないか、場所が変わりました。"));
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
      case "retry":
        return await retryRecord(request.key);
      case "retryMany":
        return await retryMany(request.keys);
      case "reviewMany": {
        requestedKeys(request.keys);
        if (typeof request.reviewed !== "boolean" || typeof request.note !== "string" || request.note.length > 1000) throw new Error(t("reviewInvalid", "確認状態の指定が不正です。"));
        if (batchProgress?.active || running || folderScan.active || deleting.size) throw new Error(t("reviewWait", "検査・削除の処理が終わってから確認状態を変更してください。"));
        const targets = request.keys.map(key => records.find(record => record.key === key));
        if (targets.some(record => !record || !(request.reviewed ? canReview(record) : canUnreview(record)) ||
            request.stamps?.[record.key] !== reviewStamp(record))) throw new Error(t("reviewChanged", "検査結果が変わりました。選び直してください。"));
        const progress = startBatch("review", targets.length);
        try {
          for (const record of targets) {
            if (progress.stopRequested) break;
            if (request.stamps[record.key] !== reviewStamp(record)) throw new Error(t("reviewChanged", "検査結果が変わりました。選び直してください。"));
            const change = async () => reserveRecords([record], async () => {
              if (request.stamps[record.key] !== reviewStamp(record)) throw new Error(t("reviewChanged", "検査結果が変わりました。選び直してください。"));
              let fingerprint = record.sha256 ? "sha256:" + record.sha256 : null;
              if (request.reviewed && !fingerprint) {
                try { fingerprint = (await verified(record)).fingerprint; } catch { /* Acknowledge the result, but do not carry it through a rescan. */ }
              }
              if (request.stamps[record.key] !== reviewStamp(record)) throw new Error(t("reviewChanged", "検査結果が変わりました。選び直してください。"));
              const candidate = { ...record };
              if (request.reviewed) candidate.review = { at: new Date().toISOString(), note: request.note.trim(),
                resultHash: record.sha256 || null, reason: reviewReason(record), fingerprint };
              else delete candidate.review;
              await persistState(records.map(item => item === record ? candidate : item));
              if (candidate.review) record.review = candidate.review;
              else delete record.review;
              await updateBadge().catch(report);
            });
            recordChanges = recordChanges.catch(() => {}).then(change);
            await recordChanges;
            progress.completed++;
            await yieldBatch();
          }
        } catch (error) { progress.error = true; throw error; }
        finally { progress.active = false; progress.cancelled = progress.total - progress.completed; void drain().catch(report); }
        return { ok: true, count: progress.completed };
      }
      case "quarantineMany": {
        requestedKeys(request.keys);
        if (batchProgress?.active || running || folderScan.active || deleting.size) throw new Error(t("qWait", "検査・削除の処理が終わってから隔離してください。"));
        if (!await api.permissions.contains({ permissions: ["messagesMove"] })) throw new Error(t("qPermission", "隔離にはメール移動の権限が必要です。"));
        const targets = request.keys.map(key => records.find(record => record.key === key));
        if (targets.some(record => !canQuarantine(record))) throw new Error(t("qDetectedOnly", "隔離できるのは脅威を検出したメールだけです。"));
        const configs = structuredClone(settings.quarantine || {});
        if (!request.hashes || targets.some(record => request.hashes[record.key] !== record.sha256 ||
            JSON.stringify(request.destinations?.[record.locator.accountId]) !== JSON.stringify(configs[record.locator.accountId]))) throw new Error(t("qChanged", "対象または隔離先が変わりました。もう一度確認してください。"));
        if (running || folderScan.active || deleting.size) throw new Error(t("qWait", "検査・削除の処理が終わってから隔離してください。"));
        const progress = startBatch("quarantine", targets.length);
        try {
          for (const record of targets) {
            if (progress.stopRequested) break;
            if (await quarantineRecord(record, configs[record.locator.accountId])) progress.moved = (progress.moved || 0) + 1;
            else progress.failed++;
            progress.completed++;
            await save();
            await yieldBatch();
          }
        } finally { progress.active = false; progress.cancelled = progress.total - progress.completed; void drain().catch(report); }
        return { ok: true, moved: progress.moved || 0, failed: progress.failed };
      }
      case "cancelBatch": {
        const progress = batchProgress;
        if (!progress?.active || request.id !== progress.id) return { ok: true };
        progress.stopRequested = true;
        if (progress.phase === "prepare" && deletionPreparation) deletionPreparation.cancel();
        if (progress.operation === "retry" && retryContext) {
          if (retryContext.staging) return { ok: true };
          for (const [key, record] of retryContext.entries) {
            if (record.status !== "queued") continue;
            restoreRetryRecord(record); retryContext.entries.delete(key); progress.cancelled++;
          }
          if (!retryContext.entries.size) { retryContext = null; progress.active = false; }
          await save();
        }
        return { ok: true };
      }
      case "prepareForget": {
        const keys = requestedKeys(request.keys);
        if (batchProgress?.active) throw new Error(t("bulkBusy", "一括操作の処理中です。"));
        const targets = keys.map(key => records.find(record => record.key === key));
        if (targets.some(record => !record || !canForget(record) || deleting.has(record.key))) throw new Error(t("forgetChanged", "履歴の状態が変わりました。選び直してください。"));
        for (const [token, entry] of historyTickets) if (entry.expires < Date.now()) historyTickets.delete(token);
        if (historyTickets.size >= 10) throw new Error(t("mail023", "未完了の確認が多いため、ほかの確認画面を閉じてやり直してください。"));
        const token = crypto.randomUUID();
        historyTickets.set(token, { expires: Date.now() + 300000, entries: targets.map(record => ({ key: record.key, fingerprint: JSON.stringify(record) })) });
        return { ok: true, token, targets: targets.map(record => ({ key: record.key, author: record.locator.author || "", subject: record.locator.subject || t("mail022", "件名なし"),
          accountId: record.locator.accountId, folderInfo: record.locator.folder, status: record.status, signatures: record.signatures || [] })) };
      }
      case "cancelForget": historyTickets.delete(request.token); return { ok: true };
      case "forgetMany": {
        return await forgetRecords(request.token);
      }
      case "prepareDeleteBatch":
        return await prepareBatch(request.keys, request.preparationId);
      case "cancelDeletePreparation": {
        if (typeof request.preparationId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(request.preparationId)) return { ok: true };
        if (deletionPreparation?.id === request.preparationId) deletionPreparation.cancel();
        else {
          for (const [id, when] of cancelledPreparations) if (Date.now() - when > 300000) cancelledPreparations.delete(id);
          cancelledPreparations.set(request.preparationId, Date.now());
          while (cancelledPreparations.size > 100) cancelledPreparations.delete(cancelledPreparations.keys().next().value);
        }
        return { ok: true };
      }
      case "cancelDeleteBatch":
        batchTickets.delete(request.token);
        return { ok: true };
      case "deleteBatch": {
        if (batchProgress?.active) throw new Error(t("mail016", "一括削除の処理中です。"));
        const batch = batchTickets.get(request.token);
        batchTickets.delete(request.token);
        if (!batch || batch.expires < Date.now()) throw new Error(t("mail076", "削除確認が期限切れです。選び直してください。"));
        const progress = startBatch("delete", batch.tickets.length);
        const results = [];
        try {
          for (const ticket of batch.tickets) {
            if (progress.stopRequested) break;
            try {
              await executeDeletion(ticket);
              batchProgress.deleted++;
              results.push({ key: ticket.key, deleted: true });
            } catch (error) {
              batchProgress.failed++;
              results.push({ key: ticket.key, deleted: false, error: error.message || t("mail077", "削除に失敗しました。") });
            }
            batchProgress.completed++;
            if (batchProgress.completed % 25 === 0) await yieldBatch();
          }
          progress.cancelled = progress.total - progress.completed;
          return { ok: true, results, cancelled: progress.cancelled };
        } finally { batchProgress.active = false; }
      }
      case "clearOverflow": {
        const before = overflowReport;
        overflowReport = null;
        try { await save(); } catch (error) {
          // Incoming inspection can finish while the clear operation is saving.
          // Restore the cleared totals without discarding those newer results.
          if (!overflowReport) overflowReport = before;
          else if (before) {
            overflowReport.total += before.total;
            for (const [status, count] of Object.entries(before.counts)) overflowReport.counts[status] = (overflowReport.counts[status] || 0) + count;
            overflowReport.recent = [...overflowReport.recent, ...before.recent].slice(0, 20);
          }
          throw error;
        }
        return { ok: true };
      }
      case "openOverflow": {
        const record = overflowReport?.recent.find(record => record.key === request.key);
        if (!record?.sha256) throw new Error(t("mail078", "検査対象を照合できません。メール一覧から確認してください。"));
        const { message } = await verified(record);
        if (!overflowReport?.recent.includes(record)) throw new Error(t("mail080", "検査結果が変わりました。操作をやり直してください。"));
        await api.messageDisplay.open({ messageId: message.id, location: "tab" });
        return { ok: true };
      }
      case "open": {
        const record = records.find(item => item.key === request.key);
        if (!record || record.status === "deleted" || deleting.has(record.key) || !record.sha256) throw new Error(t("mail078", "検査対象を照合できません。メール一覧から確認してください。"));
        const message = await resolveRecord(record);
        if (await sha256(await rawBytes(message.id)) !== record.sha256) {
          throw new Error(t("mail079", "メール内容が検査時から変わっています。再検査してください。"));
        }
        refreshQuarantineLocation(record, message);
        await save();
        await api.messageDisplay.open({ messageId: message.id, location: "tab" });
        return { ok: true };
      }
      case "prepareDelete": {
        if (batchProgress?.active) throw new Error(t("bulkBusy", "一括操作の処理中です。"));
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
          subject: message.subject || t("mail022", "件名なし"), folder: message.folder.name || message.folder.path || "", folderInfo: message.folder,
          accountId: message.folder.accountId, status: record.status, signatures: record.signatures || [] };
      }
      case "cancelDelete":
        deletionTickets.delete(request.token);
        return { ok: true };
      case "deletePermanently": {
        if (batchProgress?.active) throw new Error(t("bulkBusy", "一括操作の処理中です。"));
        const ticket = deletionTickets.get(request.token);
        deletionTickets.delete(request.token);
        if (!ticket || ticket.key !== request.key || ticket.expires < Date.now()) {
          throw new Error(t("mail081", "削除確認が無効か期限切れです。もう一度操作してください。"));
        }
        return await executeDeletion(ticket);
      }
      case "clear":
        if (batchProgress?.active) throw new Error(t("bulkBusy", "一括操作の処理中です。"));
        // This removes only generated results, never messages. The page asks
        // for confirmation before sending this request.
        records = records.filter(record => deleting.has(record.key) || ["scanning", "queued"].includes(record.status));
        issue = "";
        await save();
        await updateBadge();
        return { ok: true };
      default: throw new Error(t("mail082", "未対応の操作です。"));
    }
  } catch (error) { return { ok: false, error: error.message || t("mail083", "操作に失敗しました。"), ...(error.setupRequired ? { setupRequired: true } : {}), ...(initializationError ? { startupFailed: true } : {}) }; }
});

// Timers are sufficient for a persistent MV2 background page. Restart recovery
// uses persisted records, not timers or Thunderbird's ephemeral numeric IDs.
setInterval(() => {
  void ready.then(async () => {
    if (pendingMaintenance && !pendingMaintenance.applying && Date.now() > pendingMaintenance.expires) releaseMaintenance();
    if (maintenanceActive() || helperRemoved) return;
    pruneMoveIntakes();
    void saveReceiptRecovery();
    void recoverReceipts().catch(report);
    for (const record of records) {
      if (!deleting.has(record.key) && scanFailed(record) && record.nextRetry && record.nextRetry <= Date.now() &&
          (record.source === "manual" || (settings.enabled && settings.accountIds.includes(record.locator.accountId)))) {
        record.status = "queued";
        record.nextRetry = null;
      }
    }
    await drain();
  }).catch(report);
}, 10000);
void ready.then(drain).catch(report);
