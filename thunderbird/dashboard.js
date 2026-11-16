import { syncScanPolicy, readScanPolicy, policyDescription, advisoryDescription } from "./scan-policy.mjs";
import { isReviewed, canReview, canUnreview, reviewStamp } from "./review.mjs";
import { canQuarantine, quarantineNeedsPermission } from "./quarantine.mjs";
import { syncQuarantineSettings, readQuarantineSettings, requireMovePermission, confirmQuarantine, quarantineSummary } from "./quarantine-ui.mjs";
import { folderLabel } from "./folder-labels.mjs";
import { t, uiLanguage, localizeDocument, localizeDetail } from "./i18n.mjs";
import { installationUI, helperNotice } from "./installation.mjs";
import { LABELS, needsAttention, normalizeAutomaticSettings } from "./core.mjs";
import { selectable, canDelete, canRetry, canForget, filterRecords, resultPage } from "./results.mjs";
import { FOLDER_STATES } from "./folder-scan.mjs";

localizeDocument();

const $ = id => document.getElementById(id);
let latest, initialized = false, refreshing = false, busy = false, page = 0;
let visible = [], filteredRecords = [];
const rows = new Map(), selected = new Set();
let folderFilterId = null, seenFolderRequest = null;
let folderAnnouncement = null, seenResultsRequest = null;
const TABS = ["scan", "results", "settings", "setup", "uninstall", "help"];
let userNavigated = false, seenSetupRequest = null;
const selectedFolders = new Set();
let folderChoices = [], foldersLoading = false, settingsSaving = false;

async function request(type, values = {}) {
  const response = await messenger.runtime.sendMessage({ ...values, type });
  if (!response?.ok) throw new Error(response?.error || t("mail102", "拡張の処理に接続できませんでした。"));
  return response;
}
function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}
function blocked() { return busy || Boolean(latest?.batch?.active) || Boolean(latest?.maintenance); }
const installer = installationUI({ request, action, latest: () => latest, busy: () => blocked() });
function selection() { return (latest?.records || []).filter(record => selected.has(record.key)); }
function updateControls() {
  const locked = blocked() || Boolean(latest?.helperRemoved), chosen = selection();
  const retryCount = chosen.filter(canRetry).length, deleteCount = chosen.filter(canDelete).length, historyCount = chosen.filter(canForget).length;
  const outside = chosen.filter(record => !visible.some(item => item.key === record.key)).length;
  setText($("selected-count"), t("selectionCount", "$1件を選択中（画面外$2件）", [chosen.length, outside]));
  setText($("retry-selected"), t("retrySelectedCount", "再検査（$1通）", [retryCount]));
  setText($("delete-selected"), t("deleteSelectedCount", "メールを完全削除（$1通）", [deleteCount]));
  setText($("forget-selected"), t("forgetSelectedCount", "履歴だけ消去（$1件）", [historyCount]));
  $("retry-selected").disabled = locked || !retryCount;
  $("delete-selected").disabled = locked || !deleteCount;
  $("forget-selected").disabled = locked || !historyCount;
  const reviewCount = chosen.filter(canReview).length, unreviewCount = chosen.filter(canUnreview).length;
  setText($("review-selected"), t("reviewCountAction", "確認済みにする（$1通）", [reviewCount]));
  setText($("unreview-selected"), t("unreviewCountAction", "未確認に戻す（$1通）", [unreviewCount]));
  $("review-selected").disabled = locked || !reviewCount;
  $("unreview-selected").disabled = locked || !unreviewCount;
  const quarantineCount = chosen.filter(canQuarantine).length;
  setText($("quarantine-selected"), t("qSelectedCount", "隔離（$1通）", [quarantineCount]));
  $("quarantine-selected").disabled = locked || !quarantineCount || foldersLoading || !folderChoices.length;
  $("deselect").disabled = locked || !chosen.length;
  const candidates = visible.filter(selectable), selectedOnPage = candidates.filter(record => selected.has(record.key)).length;
  $("select-page").disabled = locked || !candidates.length;
  $("select-page").checked = candidates.length > 0 && selectedOnPage === candidates.length;
  $("select-page").indeterminate = selectedOnPage > 0 && selectedOnPage < candidates.length;
  const allCandidates = filteredRecords.filter(selectable);
  $("select-filtered").hidden = !candidates.length || selectedOnPage !== candidates.length || allCandidates.every(record => selected.has(record.key));
  $("select-filtered").disabled = locked;
  setText($("select-filtered"), t("selectFilteredCount", "絞り込み結果の選択可能な$1件をすべて選択", [allCandidates.length]));
  const navigationLocked = Boolean(latest?.maintenance) || busy && !latest?.batch?.active;
  for (const id of ["filter", "account-filter", "search", "reset-filters"]) $(id).disabled = navigationLocked;
  $("health").disabled = locked;
  const job = latest?.folderJob;
  const folderActive = job && ["collecting", "running", "stopping"].includes(job.status);
  $("scan-folder").disabled = locked || latest?.helperRemoved || Boolean(folderActive) || foldersLoading || !selectedFolders.size;
  for (const id of ["scan-account", "folder-search", "reload-folders", "folder-select-visible", "folder-clear-selection"]) $(id).disabled = locked || foldersLoading;
  $("folder-picker").disabled = locked || foldersLoading || !$("scan-account").value;
  $("folder-stop").disabled = locked || !folderActive || job.status === "stopping";
  $("folder-resume").hidden = !job || !["stopped", "interrupted", "blocked", "error"].includes(job.status);
  $("folder-resume").disabled = locked || Boolean(folderActive);
  $("folder-delete").disabled = locked || !job || Boolean(folderActive);
  $("folder-results").disabled = locked || !job;
  $("folder-only").disabled = locked || !job;
  for (const input of $("settings-form").querySelectorAll("input, button, select")) input.disabled = locked || latest?.helperRemoved;
  for (const row of $("quarantine-settings").children) row.querySelector("input").disabled = locked || latest?.helperRemoved || !row.querySelector("select").value;
  for (const record of visible) {
    const entry = rows.get(record.key);
    entry.checkbox.disabled = locked || !selectable(record);
    entry.checkbox.checked = selected.has(record.key);
    entry.row.dataset.selected = String(entry.checkbox.checked);
    entry.open.disabled = locked || !record.sha256 || ["queued", "scanning", "deleted"].includes(record.status);
    entry.retry.disabled = locked || !canRetry(record);
    entry.remove.disabled = locked || !canDelete(record);
    entry.review.disabled = locked || !["incomplete", "advisory"].includes(record.status);
  }
  $("previous-page").disabled = navigationLocked || page === 0;
  $("next-page").disabled = navigationLocked || page + 1 >= Number($("page-label").dataset.pages || 1);
  installer.render(); renderHelperNotice();
}
async function action(callback, success) {
  if (blocked()) return;
  const previousFocus = document.activeElement;
  busy = true;
  updateControls();
  try {
    setText($("action-status"), t("mail104", "処理しています。"));
    const message = await callback();
    setText($("action-status"), success || message || t("mail105", "処理が完了しました。"));
    await refresh();
  } catch (error) { setText($("action-status"), error.message); }
  finally {
    busy = false; updateControls();
    if (document.activeElement === document.body) {
      if (previousFocus?.isConnected && !previousFocus.disabled && !previousFocus.closest("[hidden]")) {
        previousFocus.focus();
      } else if (!$("panel-results").hidden) {
        $("summary").tabIndex = -1;
        $("summary").focus();
      }
    }
  }
}

function renderHelperNotice() {
  const notice = helperNotice(latest?.installation, messenger.runtime.getManifest().version);
  const tab = $("tab-setup"), dot = $("setup-dot");
  dot.hidden = !notice;
  dot.dataset.kind = notice?.kind || "";
  tab.title = notice?.message || t("mail106", "セットアップ");
  tab.setAttribute("aria-label", notice ? t("mail107", "セットアップ：$1", [notice.message]) : t("mail106", "セットアップ"));
}
function openSetup() {
  userNavigated = true;
  activateTab("setup");
  const target = ["clamav_missing", "clamav_unusable"].includes(latest?.lastHealth?.code) ? $("connection-title") : $("installation-title");
  target.focus();
  target.scrollIntoView({ block: "start" });
}

function activateTab(name, focus = false) {
  for (const id of TABS) {
    const active = id === name;
    const button = $("tab-" + id);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    $("panel-" + id).hidden = !active;
    if (active && focus) button.focus();
  }
  renderHelperNotice();
}

function jobFolderLabel(job) {
  const folders = job.folders || [job.folder];
  return folders.length > 1 ? t("folderJobLabel", "$1ほか（$2フォルダー）", [folderLabel(folders[0], folderChoices), folders.length]) : folderLabel(folders[0], folderChoices);
}

function renderFolder() {
  const job = latest.folderJob;
  $("folder-progress").hidden = !job;
  $("folder-only-label").hidden = !job;
  if (!job) {
    if (folderFilterId) { selected.clear(); page = 0; }
    folderFilterId = null; $("folder-only").checked = false;
    return;
  }
  if (folderFilterId && folderFilterId !== job.id) {
    folderFilterId = null; $("folder-only").checked = false; selected.clear(); page = 0;
  }
  const account = latest.accounts.find(account => account.id === job.folder.accountId)?.name || job.folder.accountId;
  setText($("folder-title"), t("mail108", "フォルダー検査：$1 ／ $2$3", [account, jobFolderLabel(job), job.includeSubfolders ? t("mail109", "（サブフォルダーを含む）") : ""]));
  const elapsed = Math.max(0, Math.floor(((job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now()) - new Date(job.startedAt).getTime()) / 1000));
  const targets = job.folders || [job.folder];
  const labels = targets.map(folder => folderLabel(folder, folderChoices));
  const signature = JSON.stringify(labels);
  $("folder-job-targets").hidden = targets.length < 2;
  if ($("folder-job-target-list").dataset.signature !== signature) {
    $("folder-job-target-list").dataset.signature = signature;
    $("folder-job-target-list").replaceChildren();
    for (const label of labels) { const item = document.createElement("li"); item.textContent = label; $("folder-job-target-list").append(item); }
  }
  const time = t("mail110", "経過$1分$2秒", [Math.floor(elapsed / 60), elapsed % 60]);
  if (job.total === null) {
    if (["collecting", "stopping"].includes(job.status)) $("folder-bar").removeAttribute("value");
    else { $("folder-bar").max = 1; $("folder-bar").value = 0; }
    setText($("folder-status"), t("mail111", "$1 ／ 対象$2件を確認 ／ $3", [FOLDER_STATES[job.status], job.discovered, time]));
  } else {
    $("folder-bar").max = Math.max(1, job.total);
    $("folder-bar").value = job.total === 0 && job.status === "completed" ? 1 : job.completed;
    const percent = job.total ? (100 * job.completed / job.total).toFixed(1) : "100.0";
    const waiting = Math.max(0, job.total - job.completed - job.scanning);
    setText($("folder-status"), t("mail112", "$1 ／ 処理済み$2 / $3件（$4%） ／ 検査中$5件・未処理$6件 ／ $7", [FOLDER_STATES[job.status], job.completed, job.total, percent, job.scanning, waiting, time]));
  }
  setText($("folder-counts"), (job.counts.advisory ? t("scanAdvisoryCount", "注意情報$1件 ／ ", [job.counts.advisory]) : "") + t("mail113", "未検出$1件 ／ 検出$2件 ／ 未検査$3件 ／ 失敗$4件", [job.counts.clean, job.counts.detected, job.counts.incomplete, job.counts.error]));
  const milestone = `${job.id}:${job.status}:${Math.floor(job.completed / 10)}`;
  if (milestone !== folderAnnouncement) {
    folderAnnouncement = milestone;
    setText($("folder-announcement"), t("mail114", "フォルダー検査 $1。処理済み$2件$3。", [FOLDER_STATES[job.status], job.completed, job.total === null ? "" : t("mail115", "、対象$1件", [job.total])]));
  }
  setText($("folder-detail"), job.detail + (job.resumeCount ? t("mail116", " 再開時は現在のフォルダーと照合します。総件数はこれまでの処理済み件数と、今回の未処理件数の合計です。") : "") + (job.skippedFolders ? t("mail117", " 対象外のフォルダー：$1件。", [job.skippedFolders]) : ""));
  const retained = latest.records.filter(record => record.folderJobId === job.id).length;
  setText($("folder-retained"), t("mail118", "この検査の履歴を$1件保持しています。履歴上限は1000件で、未検出・完全削除済みの古い履歴から入れ替えます。進捗の処理件数は別に保持します。検出・未検査・失敗の履歴で上限に達した場合は停止します。", [retained]));
}

function showFolderDialog(context) {
  seenFolderRequest = context.token;
  activateTab("scan");
  const account = latest.accounts.find(account => account.id === context.folder.accountId)?.name || context.folder.accountId;
  setText($("folder-target"), [account, folderLabel(context.folder, folderChoices)].join(t("listSeparator", " ／ ")));
  const folders = context.folders || [context.folder];
  $("folder-target-list").replaceChildren();
  for (const folder of folders) {
    const item = document.createElement("li"); item.textContent = folderLabel(folder, folderChoices); $("folder-target-list").append(item);
  }
  setText($("folder-target"), t("folderConfirmCount", "$1：$2フォルダーを検査します。", [account, folders.length]));
  $("folder-subfolders").checked = false;
  const dialog = $("folder-dialog");
  dialog.returnValue = "cancel";
  dialog.addEventListener("close", () => {
    if (dialog.returnValue !== "start") {
      void request("folderCancel", { token: context.token }).catch(error => setText($("action-status"), error.message));
      return;
    }
    const includeSubfolders = $("folder-subfolders").checked;
    void action(async () => {
      await request("folderStart", { token: context.token, includeSubfolders });
      folderFilterId = null; $("folder-only").checked = false; selected.clear(); page = 0;
      return t("mail119", "フォルダー検査を開始しました。進捗パネルで確認できます。");
    });
  }, { once: true });
  dialog.showModal();
  $("folder-cancel").focus();
}

$("scan-folder").addEventListener("click", () => {
  let context;
  void action(async () => {
    context = await request("folderContext", { folderIds: [...selectedFolders] });
    return t("mail120", "対象とサブフォルダーの範囲を確認してください。");
  }).then(() => { if (context && !$("folder-dialog").open) showFolderDialog(context); });
});
$("folder-stop").addEventListener("click", () => {
  const jobId = latest?.folderJob?.id;
  void action(() => request("folderStop", { jobId }), t("mail121", "中止を受け付けました。実行中の処理を終えて停止します。"));
});
$("folder-resume").addEventListener("click", () => {
  const jobId = latest?.folderJob?.id;
  void action(() => request("folderResume", { jobId }), t("mail122", "再開を受け付けました。処理済みメールと照合しています。"));
});
$("folder-delete").addEventListener("click", () => {
  if (blocked() || !latest?.folderJob) return;
  const job = latest.folderJob, dialog = $("folder-delete-dialog");
  setText($("folder-delete-target"), t("mail123", "$1 ／ 処理済み$2件", [jobFolderLabel(job), job.completed]));
  dialog.returnValue = "cancel";
  dialog.onclose = () => {
    if (dialog.returnValue !== "delete") return;
    void action(() => request("folderDelete", { jobId: job.id }), t("mail124", "フォルダー検査の記録を削除しました。メールと検査結果は残っています。"));
  };
  dialog.showModal();
  $("folder-delete-cancel").focus();
});
$("folder-results").addEventListener("click", () => {
  activateTab("results", true);
  folderFilterId = latest.folderJob.id; $("folder-only").checked = true;
  $("filter").value = "all"; $("account-filter").value = "all"; $("search").value = ""; resetSelection();
});
$("folder-only").addEventListener("change", () => {
  folderFilterId = $("folder-only").checked ? latest?.folderJob?.id : null; resetSelection();
});
for (const [index, name] of TABS.entries()) {
  $("tab-" + name).addEventListener("click", () => { userNavigated = true; activateTab(name); });
  $("tab-" + name).addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    userNavigated = true;
    const next = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 :
      (index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
    activateTab(TABS[next], true);
  });
}

for (const button of document.querySelectorAll("[data-open-tab]")) {
  button.addEventListener("click", () => { userNavigated = true; activateTab(button.dataset.openTab, true); });
}

function confirmDeletion(targets, history = false) {
  const dialog = $("delete-dialog");
  setText($("delete-title"), history ? t("forgetTitle", "履歴だけ消去") : t("mail357", "メールの完全削除"));
  setText($("delete-warning"), history ? t("forgetWarning", "選択した検査履歴だけを消去します。メール本体は残ります。状態が変わった履歴は消去しません。") : t("mail358", "ごみ箱を経由せず完全に削除します。元には戻せません。IMAPではサーバーと他端末にも反映されます。"));
  setText($("delete-ack-text"), history ? t("forgetAck", "対象の履歴を確認しました。メール本体は残ることを理解しました。") : t("mail359", "上の対象を確認し、元に戻せないことを理解しました"));
  setText($("delete-confirm"), history ? t("forgetTitle", "履歴だけ消去") : t("mail360", "完全に削除する"));
  $("delete-targets").replaceChildren();
  setText($("delete-count"), history ? t("forgetConfirmCount", "消去する履歴：$1件（画面外を含む全対象を下に表示しています）", [targets.length]) : t("deleteConfirmCount", "完全削除するメール：$1通（画面外を含む全対象を下に表示しています）", [targets.length]));
  for (const target of targets) {
    const item = document.createElement("li");
    const subject = item.appendChild(document.createElement("strong"));
    subject.textContent = target.subject;
    const detail = item.appendChild(document.createElement("div"));
    const account = latest.accounts.find(account => account.id === target.accountId)?.name || target.accountId;
    detail.textContent = [target.author, account, target.folderInfo ? folderLabel(target.folderInfo, folderChoices, target.accountId) : target.folder, LABELS[target.status], target.signatures.join(" / ")].filter(Boolean).join(t("listSeparator", " ／ "));
    $("delete-targets").append(item);
  }
  $("delete-ack").checked = false;
  $("delete-confirm").disabled = true;
  dialog.returnValue = "cancel";
  return new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "delete" && $("delete-ack").checked), { once: true });
    dialog.showModal();
    $("delete-cancel").focus();
  });
}
$("delete-ack").addEventListener("change", () => { $("delete-confirm").disabled = !$("delete-ack").checked; });

async function requireDeletePermission() {
  // Called synchronously from the delete click, before any other awaited work.
  // Already-granted permissions resolve without another permission prompt.
  const granted = await messenger.permissions.request({ permissions: ["messagesDelete"] });
  if (!granted) throw new Error(t("mail126", "完全削除が許可されなかったため、メールは削除していません。"));
}

async function deleteOne(key) {
  await requireDeletePermission();
  setText($("action-status"), t("mail127", "削除対象を照合しています。"));
  const target = await request("prepareDelete", { key });
  if (!await confirmDeletion([target])) {
    await request("cancelDelete", { token: target.token });
    return t("mail128", "削除をキャンセルしました。");
  }
  await request("deletePermanently", { key, token: target.token });
  selected.delete(key);
  return t("mail129", "対象メールを完全削除しました。");
}

function makeRow(record) {
  const row = document.createElement("tr"), parts = {};
  const cells = Array.from({ length: 5 }, () => row.appendChild(document.createElement("td")));
  cells[0].className = "select-cell";
  const checkbox = cells[0].appendChild(document.createElement("input"));
  checkbox.type = "checkbox";
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selected.add(record.key); else selected.delete(record.key);
    updateControls();
  });
  for (const [key, tag, cell] of [
    ["state", "span", 1], ["time", "time", 1], ["sender", "span", 2],
    ["subject", "strong", 2], ["location", "span", 2], ["detail", "span", 3]
  ]) {
    parts[key] = cells[cell].appendChild(document.createElement(tag));
    parts[key].className = key === "location" ? "mail-location" : key;
  }
  const details = cells[3].appendChild(document.createElement("details"));
  details.appendChild(document.createElement("summary")).textContent = t("mail130", "検出名・検査情報");
  for (const key of ["signatures", "engine", "scanPolicy"]) {
    parts[key] = details.appendChild(document.createElement("span"));
    parts[key].className = key;
  }
  const open = cells[4].appendChild(document.createElement("button"));
  open.textContent = t("mail131", "開く");
  open.addEventListener("click", () => {
    if (blocked()) return;
    const current = latest.records.find(item => item.key === record.key);
    if (current?.status === "detected" && !confirm(t("mail132", "脅威候補を検出したメールを開きます。本文が表示されます。添付ファイルやリンクは開かずに確認してください。"))) return;
    void action(() => request("open", { key: record.key }), t("mail133", "Thunderbirdで対象メールを開きました。"));
  });
  const retry = cells[4].appendChild(document.createElement("button"));
  retry.textContent = t("mail134", "再検査");
  retry.addEventListener("click", () => { void action(() => request("retry", { key: record.key }), t("mail135", "再検査を受け付けました。")); });
  const review = cells[4].appendChild(document.createElement("button"));
  review.className = "review-action";
  review.addEventListener("click", () => {
    const current = latest.records.find(item => item.key === record.key);
    if (["incomplete", "advisory"].includes(current?.status)) changeReview([current], !isReviewed(current));
  });
  const remove = cells[4].appendChild(document.createElement("button"));
  remove.textContent = t("mail136", "完全削除");
  remove.className = "danger";
  remove.addEventListener("click", () => { void action(() => deleteOne(record.key)); });
  return { row, parts, checkbox, open, retry, review, remove };
}

function renderRecords() {
  if (!latest) return;
  renderFolder();
  const filtered = filterRecords(latest.records, { status: $("filter").value, account: $("account-filter").value, search: $("search").value, folderJobId: folderFilterId, folders: folderChoices });
  filteredRecords = filtered;
  const result = resultPage(filtered, page);
  page = result.page;
  visible = result.records;
  const keep = new Set(visible.map(record => record.key));
  for (const key of selected) {
    if (!latest.records.some(record => record.key === key && selectable(record))) selected.delete(key);
  }
  for (const [key, entry] of rows) {
    if (!keep.has(key)) { entry.row.remove(); rows.delete(key); }
  }
  for (const [index, record] of visible.entries()) {
    const entry = rows.get(record.key) || makeRow(record);
    rows.set(record.key, entry);
    entry.row.dataset.status = record.status;
    entry.row.dataset.attention = String(needsAttention(record));
    setText(entry.parts.state, isReviewed(record) ? record.status === "advisory" ? t("scanAdvisoryReviewed", "注意情報（確認済み）") : t("reviewedState", "一部または全部が未検査（確認済み）") : record.status === "incomplete" && record.unscannedReason === "automaticExcluded" ? t("automaticExcludedFilter", "未検査：自動検査の対象から除外") : LABELS[record.status] || t("mail137", "不明"));
    entry.parts.time.dateTime = record.updatedAt;
    setText(entry.parts.time, new Date(record.updatedAt).toLocaleString(uiLanguage()));
    setText(entry.parts.sender, record.locator.author || t("mail021", "差出人なし"));
    setText(entry.parts.subject, record.locator.subject || t("mail022", "件名なし"));
    const account = latest.accounts.find(account => account.id === record.locator.accountId)?.name || record.locator.accountId || "";
    setText(entry.parts.location, [account, folderLabel(record.locator.folder, folderChoices, record.locator.accountId)].filter(Boolean).join(t("listSeparator", " ／ ")));
    setText(entry.parts.detail, [localizeDetail(record), advisoryDescription(record), quarantineSummary(record, folderChoices), isReviewed(record) && record.review.note ? t("reviewMemo", "判断メモ：$1", [record.review.note]) : ""].filter(Boolean).join(" "));
    setText(entry.parts.signatures, (record.signatures || []).join(" / "));
    setText(entry.parts.engine, record.engine || "");
    setText(entry.parts.scanPolicy, record.scanSettings ? policyDescription(record.scanSettings) : "");
    entry.remove.hidden = !canDelete(record);
    entry.review.hidden = !["incomplete", "advisory"].includes(record.status);
    const reviewLabel = isReviewed(record) ? t("unreviewRowAction", "未確認に") : t("reviewRowAction", "確認済み");
    setText(entry.review, reviewLabel);
    entry.review.setAttribute("aria-label", t("namedDetail", "$1：$2", [record.locator.subject || t("mail022", "件名なし"), reviewLabel]));
    for (const [button, label] of [[entry.checkbox, t("mail138", "一括操作の対象に選択")], [entry.remove, t("mail139", "ごみ箱を経由せず完全削除")], [entry.open, t("mail131", "開く")], [entry.retry, t("mail134", "再検査")]]) {
      button.setAttribute("aria-label", t("namedDetail", "$1：$2", [record.locator.subject || t("mail022", "件名なし"), label]));
    }
    const at = $("results").children[index];
    if (at !== entry.row) $("results").insertBefore(entry.row, at || null);
  }
  const waiting = latest.records.filter(record => record.status === "queued").length;
  const attention = latest.records.filter(needsAttention).length;
  setText($("tab-results"), attention ? t("mail140", "検査結果（$1）", [attention]) : t("mail141", "検査結果"));
  $("tab-results").setAttribute("aria-label", t("mail142", "検査結果、確認が必要$1件", [attention]));
  $("tab-results").title = t("mail143", "確認が必要$1件", [attention]);
  setText($("summary"), t("mail144", "履歴$1件 ／ 確認が必要$2件 ／ 検査待ち$3件 ／ 絞り込み結果$4件", [latest.records.length, attention, waiting, filtered.length]));
  setText($("page-label"), t("mail145", "$1 / $2ページ（1ページ50件）", [page + 1, result.pages]));
  $("page-label").dataset.pages = String(result.pages);
  $("empty-results").hidden = visible.length > 0;
  const progress = latest.batch;
  $("batch-progress").hidden = !progress;
  $("batch-stop").hidden = !progress?.active;
  $("batch-stop").disabled = !progress?.active || progress.stopRequested;
  if (progress) {
    const operation = progress.operation === "review" ? t("reviewBatch", "確認状態の変更") : progress.operation === "quarantine" ? t("qBatch", "メールの隔離") : progress.operation === "retry" ? t("bulkRetryName", "一括再検査") : progress.phase === "prepare" ? t("bulkPrepareName", "削除対象の照合") : t("bulkDeleteName", "メールの一括完全削除");
    const state = progress.error ? t("mail180", "失敗") : progress.active ? progress.stopRequested ? t("bulkStopping", "中止しています") : t("bulkRunning", "処理中") : progress.stopRequested ? t("bulkStopped", "中止") : t("bulkDone", "終了");
    setText($("batch-progress"), t("bulkProgress", "$1：$2 ／ $3 / $4件 ／ 失敗$5件・未着手$6件", [operation, state, progress.completed, progress.total, progress.failed || 0, progress.active ? progress.total - progress.completed : progress.cancelled || 0]));
  }
  updateControls();
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    latest = await request("state");
    if (!settingsSaving) syncSettings(latest.settings);
    renderConnection();
    if (!initialized) {
      initialized = true;
      void loadFolders();
      void request("helperInfo").then(response => {
        latest.installation = response.installation;
        latest.lastHealth = response.health || latest.lastHealth;
        renderConnection(); installer.render(); renderHelperNotice();
        if (!userNavigated && !latest.folderRequest && !latest.resultsRequest && response.installation?.state !== "managed") {
          activateTab(response.installation?.state === "removed" ? "uninstall" : "setup");
        }
      }).catch(error => setText($("installation-status"), error.message));
    }
    // Add history-only accounts as well; don't reset the current filter.
    const accounts = new Map(latest.accounts.map(account => [account.id, account.name]));
    for (const record of latest.records) if (record.locator.accountId && !accounts.has(record.locator.accountId)) accounts.set(record.locator.accountId, record.locator.accountId);
    for (const [id, name] of accounts) {
      let option = [...$("account-filter").options].find(option => option.value === id);
      if (!option) { option = document.createElement("option"); option.value = id; $("account-filter").append(option); }
      option.textContent = name;
    }
    $("issue").hidden = !latest.issue;
    setText($("issue"), latest.issue || "");
    renderRecords();
    renderHelperNotice();
    if (latest.setupRequest && latest.setupRequest !== seenSetupRequest) {
      seenSetupRequest = latest.setupRequest;
      seenResultsRequest = latest.resultsRequest;
      openSetup();
    }
    if (latest.resultsRequest && latest.resultsRequest !== seenResultsRequest && !blocked()) {
      seenResultsRequest = latest.resultsRequest;
      activateTab("results");
    }
    if (latest.folderRequest && latest.folderRequest.token !== seenFolderRequest && !blocked() &&
        !$("delete-dialog").open && !$("folder-dialog").open && !$("folder-delete-dialog").open) showFolderDialog(latest.folderRequest);
  } finally { refreshing = false; }
}

function resetSelection() { selected.clear(); page = 0; renderRecords(); }
for (const id of ["filter", "account-filter"]) $(id).addEventListener("change", resetSelection);
$("search").addEventListener("input", resetSelection);
$("reset-filters").addEventListener("click", () => {
  $("filter").value = "all"; $("account-filter").value = "all"; $("search").value = "";
  folderFilterId = null; $("folder-only").checked = false; resetSelection();
});
for (const [id, delta] of [["previous-page", -1], ["next-page", 1]]) {
  $(id).addEventListener("click", () => { page += delta; renderRecords(); });
}
$("select-page").addEventListener("change", () => {
  for (const record of visible.filter(selectable)) {
    if ($("select-page").checked) selected.add(record.key); else selected.delete(record.key);
  }
  updateControls();
});
$("select-filtered").addEventListener("click", () => {
  selected.clear();
  for (const record of filteredRecords.filter(selectable)) selected.add(record.key);
  updateControls();
});
$("batch-stop").addEventListener("click", () => {
  void request("cancelBatch", { id: latest?.batch?.id }).then(refresh).catch(error => setText($("action-status"), error.message));
});
$("deselect").addEventListener("click", () => { selected.clear(); updateControls(); });
$("retry-selected").addEventListener("click", () => {
  const keys = selection().filter(canRetry).map(record => record.key);
  void action(async () => {
    $("batch-report").replaceChildren(); $("batch-report").hidden = true;
    const response = await request("retryMany", { keys });
    for (const key of keys) selected.delete(key);
    return t("mail147", "$1件の再検査を受け付けました。", [response.count]);
  });
});
$("delete-selected").addEventListener("click", () => {
  const keys = selection().filter(canDelete).map(record => record.key);
  void action(async () => {
    await requireDeletePermission();
    $("batch-report").replaceChildren(); $("batch-report").hidden = true;
    setText($("action-status"), t("mail148", "選択した削除対象を照合しています。"));
    const prepared = await request("prepareDeleteBatch", { keys });
    if (prepared.cancelled) return t("bulkPrepareCancelled", "照合を中止しました。メールは削除していません。");
    if (!await confirmDeletion(prepared.targets)) {
      await request("cancelDeleteBatch", { token: prepared.token });
      return t("mail149", "一括削除をキャンセルしました。");
    }
    const response = await request("deleteBatch", { token: prepared.token });
    const failed = response.results.filter(result => !result.deleted);
    for (const result of response.results) if (result.deleted) selected.delete(result.key);
    for (const result of failed) {
      const item = document.createElement("li");
      const target = prepared.targets.find(target => target.key === result.key);
      item.textContent = t("namedDetail", "$1：$2", [target?.subject || t("mail150", "対象メール"), result.error]);
      $("batch-report").append(item);
    }
    $("batch-report").hidden = failed.length === 0;
    return t("bulkDeleteResult", "完全削除$1通 ／ 失敗$2通 ／ 未着手$3通", [response.results.length - failed.length, failed.length, response.cancelled || 0]);
  });
});
$("forget-selected").addEventListener("click", () => {
  const keys = selection().filter(canForget).map(record => record.key);
  void action(async () => {
    $("batch-report").replaceChildren(); $("batch-report").hidden = true;
    const prepared = await request("prepareForget", { keys });
    if (!await confirmDeletion(prepared.targets, true)) {
      await request("cancelForget", { token: prepared.token });
      return t("forgetCancelled", "履歴の消去をキャンセルしました。");
    }
    const response = await request("forgetMany", { token: prepared.token });
    for (const key of response.keys) selected.delete(key);
    return response.skipped ? t("forgetResult", "履歴$1件を消去しました。状態が変わった$2件は残しました。メール本体は削除していません。", [response.count, response.skipped]) : t("forgetSuccess", "履歴$1件を消去しました。メール本体は残っています。", [response.count]);
  });
});
function syncSettings(settings, forceScan = false) {
  settings = normalizeAutomaticSettings(settings);
  $("notifications").checked = settings.notifications;
  syncScanPolicy(settings.scanSettings, forceScan);
  syncQuarantineSettings(settings, latest.accounts, folderChoices);
  const current = new Map([...$("accounts").querySelectorAll("input")].map(input => [input.value, input]));
  const ids = new Set(latest.accounts.map(account => account.id));
  for (const [id, input] of current) if (!ids.has(id)) input.parentElement.remove();
  if (latest.accounts.length && !$("accounts").querySelector("input")) $("accounts").replaceChildren();
  for (const account of latest.accounts) {
    let checkbox = current.get(account.id);
    if (!checkbox) {
      const label = document.createElement("label"); checkbox = document.createElement("input");
      checkbox.type = "checkbox"; checkbox.value = account.id;
      label.append(checkbox, document.createTextNode(t("accountType", "$1（$2）", [account.name, account.type])));
      $("accounts").append(label);
    }
    checkbox.checked = settings.accountIds.includes(account.id);
  }
  if (!latest.accounts.length) setText($("accounts"), t("mail152", "対象アカウントがありません。"));
}

function renderConnection() {
  const health = latest.lastHealth;
  setText($("health-result"), health ?
    t("mail153", "最終接続確認：$1 ／ $2。$3 $4", [health.status === "ready" ? t("mail154", "応答あり") : t("mail155", "確認失敗"), new Date(health.checkedAt).toLocaleString(uiLanguage()), health.engine || "", localizeDetail(health)]) :
    t("mail156", "接続はまだ確認していません。「接続を再確認」で確認できます。"));
  const guide = $("clamav-install-guide");
  $("connection-title").closest("section").classList.toggle("needs-action", ["clamav_missing", "clamav_unusable"].includes(health?.code));
  guide.hidden = health?.status === "ready";
  if (guide.dataset.code !== (health?.code || "unknown")) {
    guide.dataset.code = health?.code || "unknown";
    guide.open = health?.code === "clamav_missing";
  }
  const scan = latest.lastScan;
  setText($("last-scan-result"), scan ? t("mail157", "最終実検査：$1 ／ $2 ／ $3", [new Date(scan.checkedAt).toLocaleString(uiLanguage()), scan.engine?.includes("(clamd)") ? "clamd" : "clamscan", scan.engine || ""]) : t("mail158", "実検査の記録はありません。"));
}

function matchingFolders() {
  const query = $("folder-search").value.trim().toLocaleLowerCase(uiLanguage());
  return folderChoices.filter(folder => folder.accountId === $("scan-account").value && (!query || folderLabel(folder).toLocaleLowerCase(uiLanguage()).includes(query)));
}
function renderFolderChoices() {
  const folders = matchingFolders();
  $("folder-options").replaceChildren();
  for (const folder of folders) {
    const label = document.createElement("label"), input = document.createElement("input");
    input.type = "checkbox"; input.value = folder.id; input.checked = selectedFolders.has(folder.id);
    input.addEventListener("change", () => {
      if (input.checked) selectedFolders.add(folder.id); else selectedFolders.delete(folder.id);
      renderTarget();
    });
    label.append(input, document.createTextNode(folderLabel(folder))); $("folder-options").append(label);
  }
  $("folder-picker-empty").hidden = folders.length > 0;
  setText($("folder-picker-empty"), $("scan-account").value ? t("folderNoMatches", "一致するフォルダーはありません。") : t("folderAccountFirst", "アカウントを選択してください。"));
  renderTarget();
}
function renderTarget() {
  const shown = matchingFolders(), shownIds = new Set(shown.map(folder => folder.id));
  setText($("folder-selection-count"), t("folderSelectionCount", "選択$1フォルダー ／ 表示$2フォルダー（表示外の選択$3）", [selectedFolders.size, shown.length, [...selectedFolders].filter(id => !shownIds.has(id)).length]));
  const account = latest?.accounts.find(account => account.id === $("scan-account").value);
  setText($("scan-target-label"), selectedFolders.size ? t("folderConfirmCount", "$1：$2フォルダーを検査します。", [account?.name || "", selectedFolders.size]) : t("mail161", "検査するアカウントとフォルダーを選択してください。"));
  updateControls();
}
$("folder-search").addEventListener("input", renderFolderChoices);
$("folder-select-visible").addEventListener("click", () => { for (const folder of matchingFolders()) selectedFolders.add(folder.id); renderFolderChoices(); });
$("folder-clear-selection").addEventListener("click", () => { selectedFolders.clear(); renderFolderChoices(); });
async function loadFolders() {
  if (foldersLoading) return;
  foldersLoading = true; updateControls();
  setText($("folder-load-status"), t("mail162", "フォルダー一覧を取得しています。"));
  try {
    const response = await request("folderChoices");
    folderChoices = response.folders;
    if (!settingsSaving) syncSettings(latest.settings);
    const availableIds = new Set(folderChoices.filter(folder => folder.accountId === $("scan-account").value).map(folder => folder.id));
    for (const id of selectedFolders) if (!availableIds.has(id)) selectedFolders.delete(id);
    const previous = $("scan-account").value;
    $("scan-account").replaceChildren(new Option(t("mail159", "選択してください"), ""));
    for (const account of latest.accounts) $("scan-account").append(new Option(account.name, account.id));
    if (latest.accounts.some(account => account.id === previous)) $("scan-account").value = previous;
    else if (latest.accounts.length === 1) $("scan-account").value = latest.accounts[0].id;
    renderFolderChoices();
    setText($("folder-load-status"), response.limited ? t("mail163", "フォルダー数の上限に達しました。一覧にない対象はThunderbirdの右クリックから指定してください。") :
      folderChoices.length ? "" : t("mail164", "検査できるフォルダーがありません。"));
  } catch (error) { setText($("folder-load-status"), t("mail165", "一覧を取得できませんでした。「一覧を更新」で再試行してください。") + error.message); }
  finally { foldersLoading = false; updateControls(); }
}
$("scan-account").addEventListener("change", () => { selectedFolders.clear(); $("folder-search").value = ""; renderFolderChoices(); });
$("reload-folders").addEventListener("click", () => { void loadFolders(); });
function changeReview(targets, reviewed) {
  if (!targets.length || blocked()) return;
  const stamps = Object.fromEntries(targets.map(record => [record.key, reviewStamp(record)]));
  void action(async () => {
    const title = reviewed ? t("reviewAction", "確認済みにする") : t("unreviewAction", "未確認に戻す");
    setText($("review-title"), title); setText($("review-confirm"), title);
    setText($("review-description"), reviewed ? t("reviewDescription", "未検査や注意情報の結果と理由を残し、「確認が必要」の件数から除外します。安全性を検査で確認したという意味ではありません。再検査で本文や検出理由が変わった場合、本文を照合できない場合は未確認に戻ります。") : t("unreviewDescription", "確認済みの印と判断メモを取り消し、再び「確認が必要」に含めます。検査結果は変えません。"));
    setText($("review-count"), t("reviewTargetsCount", "対象：$1通（画面外の選択を含む）", [targets.length]));
    $("review-targets").replaceChildren(...targets.map(record => {
      const item = document.createElement("li");
      item.textContent = [record.locator.author, record.locator.subject, localizeDetail(record)].filter(Boolean).join(" ／ "); return item;
    }));
    $("review-note").value = ""; $("review-note").disabled = !reviewed;
    $("review-dialog").returnValue = "cancel";
    const confirmed = await new Promise(resolve => {
      $("review-dialog").onclose = () => resolve($("review-dialog").returnValue === "apply");
      $("review-dialog").showModal(); $("review-cancel").focus();
    });
    if (!confirmed) return t("reviewCancelled", "確認状態の変更を中止しました。");
    const result = await request("reviewMany", { keys: targets.map(record => record.key), reviewed, note: $("review-note").value, stamps });
    return t("reviewCompleted", "$1通の確認状態を変更しました。", [result.count]);
  });
}
for (const [id, reviewed] of [["review-selected", true], ["unreview-selected", false]]) {
  $(id).addEventListener("click", () => changeReview(selection().filter(reviewed ? canReview : canUnreview), reviewed));
}
$("quarantine-selected").addEventListener("click", () => {
  const targets = selection().filter(canQuarantine);
  if (!targets.length || blocked()) return;
  if (targets.some(record => !latest.settings.quarantine?.[record.locator.accountId])) {
    userNavigated = true; activateTab("settings");
    setText($("action-status"), t("qTargetMissing", "隔離先を確認できません。設定で同じアカウント内の専用フォルダーを選び直してください。"));
    $("quarantine-settings").querySelector("select")?.focus();
    return;
  }
  const permission = requireMovePermission();
  const destinations = structuredClone(latest.settings.quarantine || {});
  const hashes = Object.fromEntries(targets.map(record => [record.key, record.sha256]));
  void action(async () => {
    await permission;
    if (!await confirmQuarantine(targets, { quarantine: destinations }, latest.accounts, folderChoices)) return t("qCancelled", "隔離を中止しました。");
    const result = await request("quarantineMany", { keys: targets.map(record => record.key), destinations, hashes });
    return t("qCompleted", "隔離：$1通移動、$2通失敗。結果を確認してください。", [result.moved, result.failed]);
  });
});
$("settings-form").addEventListener("submit", event => event.preventDefault());
$("settings-form").addEventListener("change", () => {
  const accountIds = [...$("accounts").querySelectorAll("input:checked")].map(input => input.value);
  const wasEnabled = latest.settings.enabled;
  const quarantine = readQuarantineSettings(latest.settings.quarantine, folderChoices);
  let scanSettings;
  try { scanSettings = readScanPolicy(); }
  catch (error) { syncSettings(latest.settings, true); setText($("settings-status"), error.message); return; }
  const settings = { enabled: accountIds.length > 0, notifications: $("notifications").checked, accountIds, quarantine, scanSettings };
  const permission = quarantineNeedsPermission(latest.settings.quarantine, quarantine) ? requireMovePermission() : Promise.resolve();
  settingsSaving = true;
  void action(async () => {
    setText($("settings-status"), t("mail166", "保存しています。"));
    try {
      await permission;
      await request("settings", { settings });
      latest.settings = settings;
      syncSettings(settings, true);
      setText($("settings-status"), !accountIds.length && wasEnabled ? t("mail167", "対象アカウントがなくなったため、自動検査を停止して保存しました。") : t("mail168", "保存しました。"));
    } catch (error) {
      syncSettings(latest.settings, true);
      setText($("settings-status"), t("mail169", "保存できませんでした。変更前の設定に戻しました。"));
      throw error;
    } finally { settingsSaving = false; }
  }, t("mail170", "設定を保存しました。"));
});
$("health").addEventListener("click", () => {
  void action(async () => {
    const { health } = await request("health");
    latest.lastHealth = health;
    renderConnection();
    if (health.status !== "ready") throw new Error(health.detail);
  }, t("mail171", "接続の確認結果を更新しました。"));
});
void refresh().catch(error => setText($("action-status"), error.message));
setInterval(() => {
  if (!document.hidden) void refresh().catch(error => setText($("action-status"), error.message));
}, 2000);
