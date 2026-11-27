import { findAttention } from "./find-attention.mjs";
import { operationFeedback } from "./feedback.mjs";
import { scanHistoryDescription } from "./scan-history.mjs";
import { configureDirectView } from "./direct-view.mjs";
import { directRuntime, permission } from "./direct-transport.mjs";
import { syncScanPolicy, readScanPolicy, policyDescription, advisoryDescription } from "./scan-policy.mjs";
import { isReviewed, canReview, canUnreview, reviewStamp } from "./review.mjs";
import { canQuarantine, quarantineNeedsPermission } from "./quarantine.mjs";
import { syncQuarantineSettings, readQuarantineSettings, requireMovePermission, confirmQuarantine, quarantineSummary } from "./quarantine-ui.mjs";
import { createFolderIndex, folderLabel } from "./folder-labels.mjs";
import { t, uiLanguage, localizeDocument, localizeDetail } from "./i18n.mjs";
import { installationUI, helperNotice } from "./installation.mjs";
import { LABELS, encryptedZipOnly, needsAttention, normalizeAutomaticSettings } from "./core.mjs";
import { selectable, canDelete, canRetry, canForget, filterRecords, resultPage } from "./results.mjs";
import { FOLDER_STATES } from "./folder-scan.mjs";

localizeDocument();
await configureDirectView();
const DIRECT = directRuntime();

const $ = id => document.getElementById(id);
const feedback = operationFeedback({ document, t });
let latest, initialized = false, refreshing = false, busy = false, startupFailed = false, page = 0;
let visible = [], filteredRecords = [], candidateResultKeys = null;
const rows = new Map(), selected = new Set();
let deletePreparation = null;
let folderFilterId = null, seenFolderRequest = null;
let folderAnnouncement = null, seenResultsRequest = null;
const TABS = DIRECT ? ["scan", "results", "settings", "help"] : ["scan", "results", "settings", "setup", "uninstall", "help"];
let userNavigated = false, seenSetupRequest = null;
const selectedFolders = new Set();
let folderChoices = [], foldersLoading = false, settingsSaving = false, settingsDirty = false;
let savedSettingsStamp = "", savedSettingsVersion = "", settingsMessageTimer = null;
let folderNames = createFolderIndex(folderChoices);

async function request(type, values = {}) {
  let response;
  try { response = await messenger.runtime.sendMessage({ ...values, type }); }
  catch (error) {
    if (["deletePermanently", "deleteBatch", "quarantineMany"].includes(type)) error.guidance = t("messageEffects", "処理が途中まで進んでいる可能性があります。再実行の前に、検査結果とメールの状態を確認してください。");
    throw error;
  }
  if (!response?.ok) {
    if (response?.startupFailed) {
      const showRecovery = !startupFailed;
      startupFailed = true;
      const message = t("startupRecovery", "初期化に失敗しました。保存先の状態を確認し、「接続を再確認」で再試行してください。") + " " + response.error;
      setText($("health-result"), message);
      if (showRecovery) openSetup();
      updateControls();
      throw new Error(message);
    }
    if (response?.setupRequired) { await refresh(); openSetup(); }
    const error = new Error(response?.error || t("mail102", "拡張の処理に接続できませんでした。"));
    if (["deletePermanently", "deleteBatch", "quarantineMany"].includes(type)) error.guidance = t("messageEffects", "処理が途中まで進んでいる可能性があります。再実行の前に、検査結果とメールの状態を確認してください。");
    error.lookupFailed = response?.lookupFailed;
    throw error;
  }
  if (type === "state") startupFailed = false;
  return response;
}
function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}
function blocked() { return busy || Boolean(latest?.batch?.active) || Boolean(latest?.maintenance); }
const installer = installationUI({ request, action, feedback, latest: () => latest, busy: () => blocked() });
const bulkActions = new Map();
function selection() { return (latest?.records || []).filter(record => selected.has(record.key)); }
function updateControls() {
  const locked = blocked() || startupFailed || Boolean(latest?.helperRemoved), chosen = selection();
  const resultBusy = Boolean(latest?.resultActionsBusy || ["collecting", "running", "stopping"].includes(latest?.folderJob?.status) || latest?.records.some(record => record.status === "scanning"));
  $("result-action-wait").hidden = !resultBusy;
  setText($("result-action-wait"), resultBusy ? t("resultActionsWait", "検査・削除の処理が終わると、確認状態の変更と手動隔離を操作できます。") : "");
  const outside = chosen.filter(record => !visible.some(item => item.key === record.key)).length;
  setText($("selected-count"), t("selectionCount", "$1件を選択中（画面外$2件）", [chosen.length, outside]));
  $("retry-selected").disabled = locked || !chosen.some(canRetry);
  $("delete-selected").disabled = locked || !chosen.some(canDelete);
  $("forget-selected").disabled = locked || !chosen.some(canForget);
  $("review-selected").disabled = locked || resultBusy || !chosen.some(canReview);
  $("unreview-selected").disabled = locked || resultBusy || !chosen.some(canUnreview);
  $("quarantine-selected").disabled = locked || resultBusy || !chosen.some(canQuarantine) || foldersLoading || !folderChoices.length;
  const bulk = $("bulk-action");
  bulk.disabled = locked || !chosen.length;
  if (resultBusy) bulk.setAttribute("aria-describedby", "result-action-wait");
  else bulk.removeAttribute("aria-describedby");
  if (!locked && bulk.selectedOptions[0]?.disabled) bulk.value = "";
  $("bulk-execute").disabled = bulk.disabled || !bulk.value || bulk.selectedOptions[0]?.disabled;
  $("deselect").disabled = locked || !chosen.length;
  const candidates = visible.filter(selectable), selectedOnPage = candidates.filter(record => selected.has(record.key)).length;
  $("select-page").disabled = locked || !candidates.length;
  $("select-page").checked = candidates.length > 0 && selectedOnPage === candidates.length;
  $("select-page").indeterminate = selectedOnPage > 0 && selectedOnPage < candidates.length;
  const find = $("find-attention");
  find.hidden = Boolean(candidateResultKeys) || $("filter").value !== "attention";
  find.disabled = locked || !filteredRecords.length;
  if (!find.hidden) setText(find, t("findCount", "要確認メールをまとめて探し直す（$1件）", [filteredRecords.length]));
  const allCandidates = filteredRecords.filter(selectable);
  $("select-filtered").hidden = !candidates.length || selectedOnPage !== candidates.length || allCandidates.every(record => selected.has(record.key));
  $("select-filtered").disabled = locked;
  setText($("select-filtered"), t("selectFilteredCount", "絞り込み結果の選択可能な$1件をすべて選択", [allCandidates.length]));
  const navigationLocked = Boolean(latest?.maintenance) || busy && !latest?.batch?.active;
  for (const id of ["filter", "account-filter", "search", "reset-filters"]) $(id).disabled = navigationLocked;
  $("health").disabled = blocked() || Boolean(latest?.helperRemoved);
  $("overflow-clear").disabled = locked || !latest?.overflowReport?.total;
  for (const button of $("overflow-recent").querySelectorAll("button")) button.disabled = locked || button.dataset.noDigest === "true";
  const job = latest?.folderJob;
  const folderActive = job && ["collecting", "running", "stopping"].includes(job.status);
  $("scan-folder").disabled = locked || latest?.helperRemoved || Boolean(folderActive) || foldersLoading || !selectedFolders.size;
  for (const id of ["scan-account", "folder-search", "reload-folders", "folder-select-visible", "folder-clear-selection"]) $(id).disabled = locked || foldersLoading;
  $("reload-folders-retry").disabled = locked || foldersLoading;
  $("folder-picker").hidden = !$("scan-account").value;
  $("scan-folder").hidden = !$("scan-account").value;
  $("folder-picker").disabled = locked || foldersLoading || !$("scan-account").value;
  $("folder-stop").hidden = !folderActive;
  $("folder-delete").hidden = !job || Boolean(folderActive);
  $("folder-stop").disabled = locked || !folderActive || job.status === "stopping";
  $("folder-resume").hidden = !job || !["stopped", "interrupted", "blocked", "error"].includes(job.status);
  $("folder-resume").disabled = locked || Boolean(folderActive);
  $("folder-delete").disabled = locked || !job || Boolean(folderActive);
  $("folder-results").disabled = locked || !job;
  $("folder-only").disabled = locked || !job;
  for (const input of $("settings-form").querySelectorAll("input, button, select")) input.disabled = locked || latest?.helperRemoved;
  $("settings-save").disabled = locked || latest?.helperRemoved || foldersLoading || !settingsDirty;
  $("settings-discard").disabled = locked || latest?.helperRemoved || !settingsDirty;
  for (const row of $("quarantine-settings").children) row.querySelector("input").disabled = locked || latest?.helperRemoved || !row.querySelector("select").value;
  for (const record of visible) {
    const entry = rows.get(record.key);
    entry.checkbox.disabled = locked || !selectable(record);
    entry.checkbox.checked = selected.has(record.key);
    entry.row.dataset.selected = String(entry.checkbox.checked);
    entry.candidates.disabled = locked;
    entry.open.disabled = locked || ["queued", "scanning", "deleted"].includes(record.status);
    entry.retry.disabled = locked || !canRetry(record);
    entry.remove.disabled = locked || !canDelete(record);
    entry.forget.disabled = locked || !canForget(record);
    entry.review.disabled = locked || resultBusy || !["incomplete", "advisory"].includes(record.status);
    if (resultBusy) entry.review.setAttribute("aria-describedby", "result-action-wait");
    else entry.review.removeAttribute("aria-describedby");
  }
  $("previous-page").disabled = navigationLocked || page === 0;
  $("next-page").disabled = navigationLocked || page + 1 >= Number($("page-label").dataset.pages || 1);
  installer.render(); renderHelperNotice();
}
async function action(callback, success) {
  if (blocked()) return;
  const context = feedback.capture(), previousFocus = context.origin;
  busy = true;
  updateControls();
  feedback.begin(context);
  try {
    const result = await callback();
    const message = success || result?.message || (typeof result === "string" ? result : "") || t("mail105", "処理が完了しました。");
    if (!result?.warning) feedback.status(message, context);
    // A failed refresh must not misreport a completed operation as a failure.
    await refresh().catch(reportRefreshError);
    if (result?.warning) await feedback.error({ message, guidance: result.guidance }, context, { warning: true });
  } catch (error) { await feedback.error(error, context); }
  finally {
    busy = false; updateControls();
    if (document.activeElement === document.body || document.activeElement === context.panel) {
      if (previousFocus?.isConnected && !previousFocus.disabled && !previousFocus.closest("[hidden]")) previousFocus.focus();
      else if (context.panel && !context.panel.hidden) context.panel.focus();
    }
  }
}
function reportRefreshError(error) {
  setText($("background-error-detail"), t("messageRefreshError", "画面の情報を更新できませんでした。表示が古い可能性があります。") + " " + error.message);
  $("background-error").hidden = false;
}

function renderHelperNotice() {
  const notice = helperNotice(latest?.installation, messenger.runtime.getManifest().version);
  const tab = $(DIRECT ? "tab-settings" : "tab-setup"), dot = $("setup-dot");
  const label = DIRECT ? t("mail255", "設定") : t("mail106", "セットアップ");
  dot.hidden = !notice;
  dot.dataset.kind = notice?.kind || "";
  tab.title = notice?.message || label;
  tab.setAttribute("aria-label", notice ? t("namedDetail", "$1：$2", [label, notice.message]) : label);
}
function openSetup() {
  userNavigated = true;
  activateTab(DIRECT ? "settings" : "setup");
  const target = DIRECT || latest?.installation?.state === "integrated" || ["clamav_missing", "clamav_unusable"].includes(latest?.lastHealth?.code) ? $("connection-title") : $("installation-title");
  target.focus();
  target.scrollIntoView({ block: "start" });
}

function activateTab(name, focus = false) {
  if (DIRECT && name === "setup") name = "settings";
  if (DIRECT && name === "uninstall") name = "help";
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
  return folders.length > 1 ? t("folderJobLabel", "$1ほか（$2フォルダー）", [folderLabel(folders[0], folderNames), folders.length]) : folderLabel(folders[0], folderNames);
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
  const active = ["collecting", "running", "stopping"].includes(job.status);
  const completed = job.status === "completed";
  setText($("folder-title"), active ? t("scanRunningTitle", "フォルダー検査の進捗") : completed ? t("scanPreviousTitle", "前回のフォルダー検査") : t("scanInterruptedTitle", "中断したフォルダー検査"));
  setText($("folder-location"), [account, jobFolderLabel(job) + (job.includeSubfolders ? t("mail109", "（サブフォルダーを含む）") : "")].join(t("listSeparator", " ／ ")));
  $("folder-bar").hidden = !active;
  const elapsed = Math.max(0, Math.floor(((job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now()) - new Date(job.startedAt).getTime()) / 1000));
  const targets = job.folders || [job.folder];
  const labels = targets.map(folder => folderLabel(folder, folderNames));
  const signature = JSON.stringify(labels);
  $("folder-job-targets").hidden = targets.length < 2;
  if ($("folder-job-target-list").dataset.signature !== signature) {
    $("folder-job-target-list").dataset.signature = signature;
    $("folder-job-target-list").replaceChildren();
    for (const label of labels) { const item = document.createElement("li"); item.textContent = label; $("folder-job-target-list").append(item); }
  }
  const time = t("mail110", "経過$1分$2秒", [Math.floor(elapsed / 60), elapsed % 60]);
  if (active && job.total === null) {
    if (["collecting", "stopping"].includes(job.status)) $("folder-bar").removeAttribute("value");
    else { $("folder-bar").max = 1; $("folder-bar").value = 0; }
    setText($("folder-status"), t("mail111", "$1 ／ 対象$2件を確認 ／ $3", [FOLDER_STATES[job.status], job.discovered, time]));
  } else if (active) {
    $("folder-bar").max = Math.max(1, job.total);
    $("folder-bar").value = job.total === 0 && job.status === "completed" ? 1 : job.completed;
    const percent = job.total ? (100 * job.completed / job.total).toFixed(1) : "100.0";
    const waiting = Math.max(0, job.total - job.completed - job.scanning);
    setText($("folder-status"), t("mail112", "$1 ／ 処理済み$2 / $3件（$4%） ／ 検査中$5件・未処理$6件 ／ $7", [FOLDER_STATES[job.status], job.completed, job.total, percent, job.scanning, waiting, time]));
  } else {
    const date = new Date(job.finishedAt || job.startedAt);
    const when = Number.isFinite(date.getTime()) ? date.toLocaleString(uiLanguage()) : "";
    const count = job.total == null ? String(job.completed) : completed ? String(job.total) : job.completed + " / " + job.total;
    setText($("folder-status"), t("scanRecordSummary", "$1 ／ $2 ／ $3通", [when, FOLDER_STATES[job.status], count]));
  }
  $("folder-detail").hidden = completed && !job.skippedFolders;
  setText($("folder-counts"), (job.counts.advisory ? t("scanAdvisoryCount", "注意情報$1件 ／ ", [job.counts.advisory]) : "") + t("mail113", "未検出$1件 ／ 検出$2件 ／ 未検査$3件 ／ 失敗$4件", [job.counts.clean, job.counts.detected, job.counts.incomplete, job.counts.error]));
  const milestone = `${job.id}:${job.status}:${Math.floor(job.completed / 10)}`;
  if (milestone !== folderAnnouncement) {
    folderAnnouncement = milestone;
    setText($("folder-announcement"), t("mail114", "フォルダー検査 $1。処理済み$2件$3。", [FOLDER_STATES[job.status], job.completed, job.total === null ? "" : t("mail115", "、対象$1件", [job.total])]));
  }
  setText($("folder-detail"), job.detail + (job.resumeCount ? t("mail116", " 再開時は現在のフォルダーと照合します。総件数はこれまでの処理済み件数と、今回の未処理件数の合計です。") : "") + (job.skippedFolders ? t("mail117", " 対象外のフォルダー：$1件。", [job.skippedFolders]) : ""));
}

function showFolderDialog(context) {
  seenFolderRequest = context.token;
  activateTab("scan");
  const account = latest.accounts.find(account => account.id === context.folder.accountId)?.name || context.folder.accountId;
  setText($("folder-target"), [account, folderLabel(context.folder, folderNames)].join(t("listSeparator", " ／ ")));
  const folders = context.folders || [context.folder];
  $("folder-target-list").replaceChildren();
  for (const folder of folders) {
    const item = document.createElement("li"); item.textContent = folderLabel(folder, folderNames); $("folder-target-list").append(item);
  }
  setText($("folder-target"), t("folderConfirmCount", "$1：$2フォルダーを検査します。", [account, folders.length]));
  $("folder-subfolders").checked = false;
  const dialog = $("folder-dialog");
  dialog.returnValue = "cancel";
  dialog.addEventListener("close", () => {
    if (dialog.returnValue !== "start") {
      void request("folderCancel", { token: context.token }).catch(error => feedback.error(error, feedback.capture()));
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
  candidateResultKeys = null;
  folderFilterId = latest.folderJob.id; $("folder-only").checked = true;
  $("filter").value = "all"; $("account-filter").value = "all"; $("search").value = ""; resetSelection();
});
$("folder-only").addEventListener("change", () => {
  folderFilterId = $("folder-only").checked ? latest?.folderJob?.id : null; resetSelection();
});
for (const [index, name] of TABS.entries()) {
  $("tab-" + name).addEventListener("click", () => {
    if (DIRECT && name === "settings" && helperNotice(latest?.installation, messenger.runtime.getManifest().version)) { openSetup(); return; }
    userNavigated = true; activateTab(name);
  });
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

function confirmDeletion(targets, history = false, preparedInDialog = false) {
  $("delete-preparation").hidden = !preparedInDialog;
  $("delete-preparation-bar").hidden = preparedInDialog;
  if (preparedInDialog) setText($("delete-preparation-status"), t("deleteReady", "照合が完了しました。対象一覧を確認してください。まだ削除していません。"));
  $("delete-ack-label").hidden = false;
  $("delete-ack").disabled = false;
  $("delete-confirm").hidden = false;
  const dialog = $("delete-dialog");
  setText($("delete-title"), history ? t("forgetTitle", "履歴だけ消去") : t("mail357", "メールの完全削除"));
  setText($("delete-warning"), history ? t("forgetWarning", "選択した検査履歴だけを消去します。メール本体は残ります。状態が変わった履歴は消去しません。") : t("mail358", "ごみ箱を経由せず完全に削除します。元には戻せません。IMAPではサーバーと他端末にも反映されます。"));
  setText($("delete-ack-text"), history ? t("forgetAck", "対象の履歴を確認しました。メール本体は残ることを理解しました。") : t("mail359", "上の対象を確認し、元に戻せないことを理解しました"));
  setText($("delete-confirm"), history ? t("forgetTitle", "履歴だけ消去") : t("deleteSelectedCount", "メールを完全削除（$1通）", [targets.length]));
  $("delete-targets").parentElement.hidden = false;
  $("delete-targets").replaceChildren();
  setText($("delete-count"), history ? t("forgetConfirmCount", "消去する履歴：$1件（画面外を含む全対象を下に表示しています）", [targets.length]) : t("deleteConfirmCount", "完全削除するメール：$1通（画面外を含む全対象を下に表示しています）", [targets.length]));
  for (const target of targets) {
    const item = document.createElement("li");
    const subject = item.appendChild(document.createElement("strong"));
    subject.textContent = target.subject;
    const detail = item.appendChild(document.createElement("div"));
    const account = latest.accounts.find(account => account.id === target.accountId)?.name || target.accountId;
    detail.textContent = [target.author, account, target.folderInfo ? folderLabel(target.folderInfo, folderNames, target.accountId) : target.folder, target.isCandidate ? t("autoCandidateState", "候補：$1", [LABELS[target.status]]) : LABELS[target.status], target.signatures.join(" / ")].filter(Boolean).join(t("listSeparator", " ／ "));
    $("delete-targets").append(item);
  }
  $("delete-ack").checked = false;
  $("delete-confirm").disabled = true;
  dialog.returnValue = "cancel";
  return new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "delete" && $("delete-ack").checked), { once: true });
    if (!dialog.open) dialog.showModal();
    $("delete-cancel").focus();
  });
}
$("delete-ack").addEventListener("change", () => { $("delete-confirm").disabled = Boolean(deletePreparation?.preparing) || !$("delete-ack").checked; });

function renderDeletePreparation(progress) {
  const context = deletePreparation;
  if (!context?.preparing || context.cancelled) return;
  const completed = progress?.preparationId === context.id ? progress.completed : 0;
  setText($("delete-preparation-status"), t("deletePreparing", "削除対象を照合しています：$1 / $2通。まだ削除していません。", [completed, context.total]));
  $("delete-preparation-bar").max = context.total;
  $("delete-preparation-bar").value = completed;
  $("delete-preparation-bar").setAttribute("aria-label", t("deletePreparingProgress", "削除対象の照合済み件数"));
}
// Preserve the dashboard selection. Only the keys explicitly retained here
// go through the original operation's preparation and confirmation again.
function recoverTargets(keys, failures, verb, searchImmediately = false) {
  const dialog = $("locate-dialog"), rows = $("locate-rows"), proceed = $("locate-continue");
  const unresolved = new Set(failures.map(item => item.key)), retained = new Set(keys);
  rows.replaceChildren();
  setText($("locate-summary"), t("locateSummary", "$1通のうち$2通を特定できませんでした。", [keys.length, failures.length]));
  function update() {
    proceed.disabled = unresolved.size > 0;
    setText(proceed, retained.size ? t("locateContinue", "$1に進む（$2通）", [verb, retained.size]) : t("locateFinish", "閉じる"));
  }
  for (const {key, detail} of failures) {
    const record = latest.records.find(item => item.key === key);
    const row = rows.appendChild(document.createElement("li"));
    row.appendChild(document.createElement("strong")).textContent = record?.locator.subject || t("mail022", "件名なし");
    const status = row.appendChild(document.createElement("p"));
    status.setAttribute("role", "status"); status.textContent = detail;
    const controls = row.appendChild(document.createElement("div"));
    function button(label, handler) {
      const element = controls.appendChild(document.createElement("button"));
      element.type = "button"; element.textContent = label;
      element.onclick = async () => {
        for (const b of controls.children) b.disabled = true;
        try { await handler(); }
        catch (error) { status.textContent = error.message; }
        finally {
          for (const b of controls.children) b.disabled = false;
          if (dialog.open && row.isConnected && document.activeElement === document.body)
            (controls.querySelector("button") || (!proceed.disabled && proceed) || dialog.querySelector('[value="cancel"]')).focus();
        }
      };
      return element;
    }
    function done(text, keep) {
      if (!dialog.open || !row.isConnected) return;
      status.textContent = text; controls.replaceChildren();
      unresolved.delete(key); if (!keep) retained.delete(key);
      update();
    }
    const exclude = () => button(t("locateExclude", "この操作から外す"), () => done(t("locateExcluded", "今回の対象から外しました。"), false));
    const search = button(t("locateSearch", "対象メールを探し直す"), async () => {
      status.textContent = t("locateSearching", "候補を探しています。");
      const result = await request("locateHistory", {key});
      if (!dialog.open || !row.isConnected) return;
      if (result.verified) {
        done(t("locateVerified", "内容が一致しました。現在のフォルダー：$1", [folderLabel(result.folder, folderNames, result.folder.accountId)]), true);
        return;
      }
      controls.replaceChildren();
      status.textContent = result.candidates.length ? t("locateUnverified", "元のメールと同じか確認できません。候補を新しい検査として受け付けます。") : t("locateMissing", "現在のメールを特定できません。");
      if (result.candidates.length && record?.unscannedReason === "ambiguousMessage") {
        button(t("scanAllCandidates", "候補をすべて検査"), async () => {
          await request("scanCopies", {key, session:result.session, positions:result.candidates.map(candidate => candidate.position)});
          done(t("locateQueued", "候補の検査を受け付けました。結果は別の行に表示します。"), false);
        });
      }
      for (const candidate of result.candidates) {
        const folder = folderLabel(candidate.folder, folderNames, candidate.folder.accountId);
        const description = [folder, candidate.date && new Date(candidate.date).toLocaleString(uiLanguage()),
          Number.isFinite(candidate.size) && (candidate.size.toLocaleString(uiLanguage()) + " B")].filter(Boolean).join(" / ");
        button(t("locateScan", "$1 の候補を検査", [description]), async () => {
          await request("scanHistoryCandidate", {key, messageId:candidate.id, position:candidate.position, session:result.session});
          done(t("locateQueued", "候補の検査を受け付けました。結果は別の行に表示します。"), false);
        });
      }
      exclude();
    });
    exclude();
    if (searchImmediately) queueMicrotask(() => search.click());
  }
  update(); dialog.returnValue = "cancel";
  return new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "continue" ? [...retained] : []), {once:true});
    dialog.showModal();
  });
}

async function retryTargets(keys, single = false) {
  const {failures} = await request("checkRetryTargets", {keys});
  if (failures?.length) keys = await recoverTargets(keys, failures, t("mail134", "再検査"));
  if (!keys.length) return t("locateFinished", "対象の確認を終了しました。");
  if (single) {
    await request("retry", {key:keys[0], checkedLocation:true});
    return t("mail135", "再検査を受け付けました。");
  }
  const response = await request("retryMany", {keys, checkedLocation:true});
  for (const key of keys) selected.delete(key);
  return t("mail147", "$1件の再検査を受け付けました。", [response.count]);
}

async function prepareDeleteConfirmation(keys) {
  const dialog = $("delete-dialog");
  const context = { id: crypto.randomUUID(), total: keys.length, preparing: true, cancelled: false, started: false };
  deletePreparation = context;
  setText($("delete-title"), t("mail357", "メールの完全削除"));
  setText($("delete-warning"), t("deletePreparingHint", "メールの取り違えを防ぐため、内容を確認しています。削除は、照合後の対象一覧を確認して実行するまで行いません。"));
  $("delete-preparation").hidden = false; $("delete-preparation-bar").hidden = false;
  $("delete-targets").parentElement.hidden = true;
  $("delete-targets").replaceChildren(); setText($("delete-count"), "");
  $("delete-ack-label").hidden = true; $("delete-ack").checked = false; $("delete-ack").disabled = true;
  $("delete-confirm").hidden = true; $("delete-confirm").disabled = true;
  const closed = () => {
    if (!context.preparing) return;
    context.cancelled = true;
    if (context.started) void request("cancelDeletePreparation", { preparationId: context.id }).catch(error => feedback.error(error, feedback.capture()));
  };
  dialog.addEventListener("close", closed);
  dialog.returnValue = "cancel";
  renderDeletePreparation();
  dialog.showModal(); $("delete-cancel").focus();
  try {
    await requireDeletePermission();
    if (context.cancelled || !dialog.open) return null;
    context.started = true;
    let prepared;
    try {
      for (;;) {
        prepared = await request("prepareDeleteBatch", { keys, preparationId: context.id, recover:true });
        if (context.cancelled || !dialog.open || !prepared.failures?.length) break;
        keys = await recoverTargets(keys, prepared.failures, t("mail357", "メールの完全削除"));
        if (!keys.length) return null;
        context.id = crypto.randomUUID(); context.total = keys.length;
        renderDeletePreparation();
      }
    }
    catch (error) { error.guidance = t("messageDeleteNotStarted", "メールは削除していません。対象を再検査し、結果を確認してからもう一度お試しください。"); throw error; }
    if (context.cancelled || !dialog.open || prepared.cancelled) {
      if (prepared.token) await request("cancelDeleteBatch", { token: prepared.token });
      return null;
    }
    context.preparing = false;
    return prepared;
  } finally {
    dialog.removeEventListener("close", closed);
    if (context.preparing && dialog.open) dialog.close("cancel");
    if (deletePreparation === context) deletePreparation = null;
  }
}

async function requireDeletePermission() {
  // Called synchronously from the delete click, before any other awaited work.
  // Already-granted permissions resolve without another permission prompt.
  const granted = await permission(messenger, ["messagesDelete"]);
  if (!granted) throw new Error(t("mail126", "完全削除が許可されなかったため、メールは削除していません。"));
}

async function deleteOne(key) {
  await requireDeletePermission();
  feedback.status(t("mail127", "削除対象を照合しています。"));
  let target;
  try { target = await request("prepareDelete", { key }); }
  catch (error) {
    if (!error.lookupFailed) throw error;
    const keys = await recoverTargets([key], [{key, detail:error.message}], t("mail357", "メールの完全削除"));
    if (!keys.length) return t("locateFinished", "対象の確認を終了しました。");
    target = await request("prepareDelete", {key});
  }
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
  const cells = Array.from({ length: 4 }, () => row.appendChild(document.createElement("td")));
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
  for (const key of ["originProof", "signatures", "engine", "scanPolicy"]) {
    parts[key] = details.appendChild(document.createElement("span"));
    parts[key].className = key;
  }
  const actions = cells[2].appendChild(document.createElement("div"));
  actions.className = "row-actions";
  const open = actions.appendChild(document.createElement("button"));
  open.textContent = t("mail131", "開く");
  open.addEventListener("click", () => {
    if (blocked()) return;
    const current = latest.records.find(item => item.key === record.key);
    if (current?.status === "detected" && !confirm(t("mail132", "脅威候補を検出したメールを開きます。本文が表示されます。添付ファイルやリンクは開かずに確認してください。"))) return;
    void action(async () => {
      const key = record.key;
      try { await request("open", {key}); }
      catch (error) {
        if (!error.lookupFailed) throw error;
        const keys = await recoverTargets([key], [{key, detail:error.message}], t("mail131", "開く"));
        if (!keys.length) return t("locateFinished", "対象の確認を終了しました。");
        await request("open", {key});
      }
      return t("mail133", "Thunderbirdで対象メールを開きました。");
    });
  });
  const retry = actions.appendChild(document.createElement("button"));
  retry.textContent = t("mail134", "再検査");
  retry.addEventListener("click", () => { void action(async () => {
    const current = latest.records.find(item => item.key === record.key);
    if (current?.unscannedReason === "ambiguousMessage") {
      await recoverTargets([record.key], [{key:record.key, detail:current.detail}], t("mail134", "再検査"), true);
      return t("locateFinished", "対象の確認を終了しました。");
    }
    return retryTargets([record.key], true);
  }); });
  const candidates = actions.appendChild(document.createElement("button"));
  candidates.textContent = t("findResultsView", "別途検査した候補の結果");
  candidates.addEventListener("click", () => {
    const checks = latest.records.find(item => item.key === record.key)?.candidateChecks || [];
    showCandidateResults(checks.map(item => item.key));
    $("find-back").focus();
  });
  const review = actions.appendChild(document.createElement("button"));
  review.className = "review-action";
  review.addEventListener("click", () => {
    const current = latest.records.find(item => item.key === record.key);
    if (["incomplete", "advisory"].includes(current?.status)) changeReview([current], !isReviewed(current));
  });
  const forget = actions.appendChild(document.createElement("button"));
  forget.textContent = t("forgetTitle", "履歴だけ消去");
  forget.className = "forget-action";
  forget.addEventListener("click", () => { void action(() => forgetHistory([record.key])); });
  const remove = actions.appendChild(document.createElement("button"));
  remove.textContent = t("mail136", "完全削除");
  remove.className = "danger";
  remove.addEventListener("click", () => { void action(() => deleteOne(record.key)); });
  return { row, parts, checkbox, open, retry, candidates, review, forget, remove };
}

$("overflow-clear").addEventListener("click", () => {
  if (blocked() || !confirm(t("overflowClearConfirm", "保存枠不足の集計と直近の結果を消去します。メールと通常の検査履歴は変更しません。続けますか？"))) return;
  void action(() => request("clearOverflow"));
});
let overflowRendered = "";
function renderOverflow() {
  const report = latest.overflowReport;
  $("overflow-report").hidden = !report?.total && !latest.overflowPending;
  setText($("overflow-summary"), t("overflowSummary", "保存枠不足の結果$1件 ／ 要確認$2件 ／ 検査中$3件", [report?.total || 0, Object.entries(report?.counts || {}).filter(([status]) => ["detected", "incomplete", "error", "advisory"].includes(status)).reduce((sum, [, count]) => sum + count, 0) - (latest.settings.quietEncryptedZip ? report?.encryptedZipCount || 0 : 0), latest.overflowPending ? 1 : 0]));
  const signature = JSON.stringify(report?.recent || []);
  if (signature === overflowRendered) return;
  overflowRendered = signature;
  $("overflow-recent").replaceChildren();
  for (const record of report?.recent || []) {
    const item = document.createElement("li");
    const description = document.createElement("p");
    description.textContent = [resultStateLabel(record), record.locator.author, record.locator.subject, folderLabel(record.locator.folder, folderNames, record.locator.accountId), localizeDetail(record)].filter(Boolean).join(" / ");
    item.append(description);
    const open = document.createElement("button");
    open.textContent = t("mail131", "開く");
    open.setAttribute("aria-label", t("namedDetail", "$1：$2", [record.locator.subject || t("mail022", "件名なし"), open.textContent]));
    open.disabled = blocked() || !record.sha256;
    open.dataset.noDigest = String(!record.sha256);
    open.addEventListener("click", () => {
      if (blocked()) return;
      if (record.status === "detected" && !confirm(t("mail132", "脅威候補を検出したメールを開きます。本文が表示されます。添付ファイルやリンクは開かずに確認してください。"))) return;
      void action(() => request("openOverflow", { key: record.key }), t("mail133", "Thunderbirdで対象メールを開きました。"));
    });
    item.append(open); $("overflow-recent").append(item);
  }
}

const candidateDifferences = {
  folder: t("candidateFolderDiff", "フォルダー"),
  size: t("candidateSizeDiff", "サイズ"),
  id: t("candidateIdDiff", "Thunderbirdの数値ID"),
  previous: t("candidateOldDiff", "旧版での位置不一致")
};

function resultStateLabel(record) {
  let label = LABELS[record.status] || t("mail137", "不明");
  if (isReviewed(record)) label = record.status === "advisory" ? t("scanAdvisoryReviewed", "注意情報（確認済み）") :
    t("reviewedState", "一部または全部が未検査（確認済み）");
  else if (record.status === "incomplete") {
    if (record.unscannedReason === "automaticExcluded") label = t("automaticExcludedFilter", "未検査：自動検査の対象から除外");
    if (record.unscannedReason === "messageMissing") return t("findMissing", "候補なし");
    if (record.candidateChecks?.length) return t("candidateChecks", "現存する候補の検査");
    if (record.unscannedReason === "ambiguousMessage") return t("candidateAmbiguous", "元のメールを区別できません");
  }
  return record.candidateOrigin || record.candidateAttempt ? t("autoCandidateState", "候補：$1", [label]) : label;
}

function renderRecords() {
  const focused = document.activeElement;
  const focusedRow = focused?.closest?.("#results tr");
  if (!latest) return;
  renderFolder();
  renderOverflow();
  $("candidate-results-view").hidden = !candidateResultKeys;
  const scope = candidateResultKeys ? latest.records.filter(record => candidateResultKeys.has(record.key)) : latest.records;
  const filtered = filterRecords(scope, { settings: latest.settings, status: $("filter").value, account: $("account-filter").value, search: $("search").value, folderJobId: folderFilterId, folders: folderNames });
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
  const byKey = new Map(latest.records.map(record => [record.key, record]));
  for (const [index, record] of visible.entries()) {
    const entry = rows.get(record.key) || makeRow(record);
    rows.set(record.key, entry);
    entry.row.dataset.status = record.status;
    entry.row.dataset.attention = String(needsAttention(record, latest.settings));
    const origin = record.candidateOrigin || record.candidateAttempt;
    setText(entry.parts.state, resultStateLabel(record));
    entry.parts.time.dateTime = record.updatedAt;
    setText(entry.parts.time, new Date(record.updatedAt).toLocaleString(uiLanguage()));
    setText(entry.parts.sender, record.locator.author || t("mail021", "差出人なし"));
    setText(entry.parts.subject, record.locator.subject || t("mail022", "件名なし"));
    const account = latest.accounts.find(account => account.id === record.locator.accountId)?.name || record.locator.accountId || "";
    setText(entry.parts.location, [account, folderLabel(record.locator.folder, folderNames, record.locator.accountId)].filter(Boolean).join(t("listSeparator", " ／ ")));
    const candidate = byKey.get(record.candidateScanKey);
    const checks = record.candidateChecks || [];
    entry.candidates.hidden = !checks.some(check => byKey.has(check.key));
    const candidateDetail = checks.length ? checks.map(check => {
      const status = byKey.get(check.key)?.status || check.status;
      return folderLabel(check.folder, folderNames, record.locator.accountId) + " — " + LABELS[status];
    }).join(" / ") : candidate ? t("findVerdict", "別途検査した候補：$1", [LABELS[candidate.status]]) :
      record.candidateScanKey ? t("findPrevious", "候補の検査を受け付けた履歴があります。") : "";
    const originDetail = origin ? t("candidateOriginDetail", "受付時の原本との一致は未確認です。受付フォルダー：$1。照合時の相違：$2。",
      [folderLabel(origin.locator.folder, folderNames), origin.differences.map(reason => candidateDifferences[reason]).join(" / ")]) : "";
    setText(entry.parts.originProof, originDetail);
    entry.parts.originProof.hidden = !originDetail;
    setText(entry.parts.detail, [candidateDetail, checks.length ? t("ambiguousOrigin", "受付時の原本との一致は未確認です。") : encryptedZipOnly(record) ? t("zipUnscanned", "暗号化ZIPの中身は未検査です。") : scanHistoryDescription(record) || localizeDetail(record), advisoryDescription(record), quarantineSummary(record, folderNames), isReviewed(record) && record.review.note ? t("reviewMemo", "判断メモ：$1", [record.review.note]) : ""].filter(Boolean).join(" "));
    setText(entry.parts.signatures, (record.signatures || []).join(" / "));
    setText(entry.parts.engine, record.engine || "");
    setText(entry.parts.scanPolicy, record.scanSettings ? policyDescription(record.scanSettings) : "");
    entry.remove.hidden = !canDelete(record);
    entry.forget.hidden = !canForget(record);
    entry.review.hidden = !["incomplete", "advisory"].includes(record.status);
    const reviewLabel = isReviewed(record) ? t("unreviewRowAction", "未確認に") : t("reviewRowAction", "確認済み");
    setText(entry.review, reviewLabel);
    entry.review.setAttribute("aria-label", t("namedDetail", "$1：$2", [record.locator.subject || t("mail022", "件名なし"), reviewLabel]));
    const retryLabel = record.unscannedReason === "ambiguousMessage" ? t("findRowCandidates", "候補を探して検査") : t("mail134", "再検査");
    setText(entry.retry, retryLabel);
    for (const [button, label] of [[entry.checkbox, t("mail138", "一括操作の対象に選択")], [entry.remove, t("mail139", "ごみ箱を経由せず完全削除")], [entry.forget, t("forgetTitle", "履歴だけ消去")], [entry.open, t("mail131", "開く")], [entry.retry, retryLabel]]) {
      button.setAttribute("aria-label", t("namedDetail", "$1：$2", [record.locator.subject || t("mail022", "件名なし"), label]));
    }
    const at = $("results").children[index];
    if (at !== entry.row) $("results").insertBefore(entry.row, at || null);
  }
  const waiting = latest.waitingCount ?? latest.records.filter(record => record.status === "queued").length;
  const attention = latest.records.filter(record => needsAttention(record, latest.settings)).length + (latest.overflowReport?.recent || []).filter(record => needsAttention(record, latest.settings)).length;
  setText($("tab-results"), attention ? t("mail140", "検査結果（$1）", [attention]) : t("mail141", "検査結果"));
  $("tab-results").setAttribute("aria-label", t("mail142", "検査結果、確認が必要$1件", [attention]));
  $("tab-results").title = t("mail143", "確認が必要$1件", [attention]);
  const summaryValues = [latest.records.length, attention, waiting, filtered.length];
  setText($("summary"), waiting > 0 && latest.idleWaiting
    ? latest.idleState === "unknown"
      ? t("summaryIdleUnknown", "履歴$1件 ／ 確認が必要$2件 ／ 検査待ち$3件（無操作状態の確認待ち） ／ 絞り込み結果$4件", summaryValues)
      : t("summaryIdleWaiting", "履歴$1件 ／ 確認が必要$2件 ／ 検査待ち$3件（無操作時間待機中） ／ 絞り込み結果$4件", summaryValues)
    : t("mail144", "履歴$1件 ／ 確認が必要$2件 ／ 検査待ち$3件 ／ 絞り込み結果$4件", summaryValues));
  setText($("page-label"), t("mail145", "$1 / $2ページ（1ページ50件）", [page + 1, result.pages]));
  $("page-label").dataset.pages = String(result.pages);
  $("empty-results").hidden = visible.length > 0;
  const progress = latest.batch;
  renderDeletePreparation(progress);
  $("batch-progress").hidden = !progress;
  $("batch-stop").hidden = !progress?.active;
  $("batch-stop").disabled = !progress?.active || progress.stopRequested;
  if (progress) {
    const operation = progress.operation === "review" ? t("reviewBatch", "確認状態の変更") : progress.operation === "quarantine" ? t("qBatch", "メールの隔離") : progress.operation === "retry" ? t("bulkRetryName", "一括再検査") : progress.phase === "prepare" ? t("bulkPrepareName", "削除対象の照合") : t("bulkDeleteName", "メールの一括完全削除");
    const state = progress.error ? t("mail180", "失敗") : progress.active ? progress.stopRequested ? t("bulkStopping", "中止しています") : t("bulkRunning", "処理中") : progress.stopRequested ? t("bulkStopped", "中止") : t("bulkDone", "終了");
    setText($("batch-progress"), t("bulkProgress", "$1：$2 ／ $3 / $4件 ／ 失敗$5件・未着手$6件", [operation, state, progress.completed, progress.total, progress.failed || 0, progress.active ? progress.total - progress.completed : progress.cancelled || 0]));
  }
  updateControls();
  if (focusedRow && document.activeElement === document.body) {
    if (focused.isConnected && !focused.disabled && !focused.closest("[hidden]")) focused.focus();
    else { $("summary").tabIndex = -1; $("summary").focus(); }
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    latest = await request("state");
    if (!settingsSaving && !settingsDirty) syncSettings(latest.settings);
    renderConnection();
    if (!initialized) {
      initialized = true;
      void loadFolders();
      void request("helperInfo").then(response => {
        latest.installation = response.installation;
        latest.lastHealth = response.health || latest.lastHealth;
        renderConnection(); installer.render(); renderHelperNotice();
        if (!userNavigated && !latest.folderRequest && !latest.resultsRequest && response.installation?.state !== "managed" && (!DIRECT || response.installation?.healthy === false)) {
          activateTab(response.installation?.state === "removed" ? "uninstall" : "setup");
        }
      }).catch(error => setText($(DIRECT ? "health-result" : "installation-status"), error.message));
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
    $("background-error").hidden = true;
    renderRecords();
    $("receipt-recovery").hidden = !latest.receiptRecovery;
    const affectedFolders = latest.receiptRecovery?.folders || [];
    $("receipt-folders").hidden = !affectedFolders.length;
    if (affectedFolders.length) {
      const names = affectedFolders.map(folder => [accounts.get(folder.accountId) || folder.accountId,
        folderLabel(folder, folderNames)].join(" / "));
      setText($("receipt-folders"), t("incomingRecoveryFolders", "受付できなかった通知のフォルダー：$1", [names.join(t("listSeparator", " ／ "))]));
    }
    renderHelperNotice();
    if (sessionStorage.getItem("clam-open-settings") === "1") {
      sessionStorage.removeItem("clam-open-settings");
      userNavigated = true;
      seenSetupRequest = latest.setupRequest;
      seenResultsRequest = latest.resultsRequest;
      activateTab("settings");
    }
    if (latest.setupRequest && latest.setupRequest !== seenSetupRequest) {
      seenSetupRequest = latest.setupRequest;
      seenResultsRequest = latest.resultsRequest;
      openSetup();
    }
    if (latest.resultsRequest && latest.resultsRequest !== seenResultsRequest && !blocked()) {
      seenResultsRequest = latest.resultsRequest;
      candidateResultKeys = null;
      if (latest.resultsFilter === "attention") {
        $("filter").value = "attention";
        $("account-filter").value = "all";
        $("search").value = "";
        folderFilterId = null;
        $("folder-only").checked = false;
        resetSelection();
      }
      activateTab("results");
    }
    if (latest.folderRequest && latest.folderRequest.token !== seenFolderRequest && !blocked() &&
        !$("message-dialog").open && !$("delete-dialog").open && !$("folder-dialog").open && !$("folder-delete-dialog").open) showFolderDialog(latest.folderRequest);
  } finally { refreshing = false; }
}

function showCandidateResults(keys) {
  candidateResultKeys = new Set(keys);
  $("filter").value = "all"; $("account-filter").value = "all"; $("search").value = "";
  folderFilterId = null; $("folder-only").checked = false;
  resetSelection();
}

function resetSelection() { selected.clear(); page = 0; renderRecords(); }
for (const id of ["filter", "account-filter"]) $(id).addEventListener("change", resetSelection);
$("search").addEventListener("input", resetSelection);
$("reset-filters").addEventListener("click", () => {
  candidateResultKeys = null;
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
  void request("cancelBatch", { id: latest?.batch?.id }).then(refresh).catch(error => feedback.error(error, feedback.capture()));
});
$("deselect").addEventListener("click", () => { selected.clear(); updateControls(); });
$("find-back").addEventListener("click", () => {
  candidateResultKeys = null;
  $("filter").value = "attention";
  resetSelection();
});
$("find-attention").addEventListener("click", () => {
  const targets = filteredRecords.filter(record => needsAttention(record, latest.settings));
  void action(async () => {
    const result = await findAttention(targets, request, folder => folderLabel(folder, folderNames));
    if (result.candidates) {
      showCandidateResults(result.candidates);
      return t("findResultsView", "別途検査した候補の結果");
    }
    const keys = result.originals || [];
    if (keys.length) {
      selected.clear();
      for (const key of keys) selected.add(key);
      page = 0;
      renderRecords();
    }
    return keys.length ? t("findSelected", "一覧で$1件を選択しました。", [keys.length]) : t("locateFinished", "対象の確認を終了しました。");
  });
});
bulkActions.set("retry-selected", () => {
  const keys = selection().filter(canRetry).map(record => record.key);
  void action(async () => {
    $("batch-report").replaceChildren(); $("batch-report").hidden = true;
    return await retryTargets(keys);
  });
});
bulkActions.set("delete-selected", () => {
  const keys = selection().filter(canDelete).map(record => record.key);
  void action(async () => {
    $("batch-report").replaceChildren(); $("batch-report").hidden = true;
    const prepared = await prepareDeleteConfirmation(keys);
    if (!prepared) return t("bulkPrepareCancelled", "照合を中止しました。メールは削除していません。");
    if (!await confirmDeletion(prepared.targets, false, true)) {
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
    return { message: t("bulkDeleteResult", "完全削除$1通 ／ 失敗$2通 ／ 未着手$3通", [response.results.length - failed.length, failed.length, response.cancelled || 0]), warning: failed.length > 0, guidance: t("messageBatchGuidance", "成功した処理は実行済みです。検査結果と対象ごとのエラーを確認してください。") };
  });
});
async function forgetHistory(keys) {
  $("batch-report").replaceChildren(); $("batch-report").hidden = true;
  const prepared = await request("prepareForget", { keys });
  if (!await confirmDeletion(prepared.targets, true)) {
    await request("cancelForget", { token: prepared.token });
    return t("forgetCancelled", "履歴の消去をキャンセルしました。");
  }
  const response = await request("forgetMany", { token: prepared.token });
  for (const key of response.keys) selected.delete(key);
  return response.skipped ? t("forgetResult", "履歴$1件を消去しました。状態が変わった$2件は残しました。メール本体は削除していません。", [response.count, response.skipped]) : t("forgetSuccess", "履歴$1件を消去しました。メール本体は残っています。", [response.count]);
}
bulkActions.set("forget-selected", () => {
  const keys = selection().filter(canForget).map(record => record.key);
  void action(() => forgetHistory(keys));
});

function syncSettings(settings) {
  savedSettingsVersion = JSON.stringify(settings);
  settings = normalizeAutomaticSettings(settings);
  $("notifications").checked = settings.notifications;
  $("quiet-encrypted-zip").checked = Boolean(settings.quietEncryptedZip);
  $("definition-source").value = settings.definitionSource || "addon";
  $("idle-automatic").checked = settings.idleAutomatic === true;
  syncScanPolicy(settings.scanSettings, true);
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
  savedSettingsStamp = settingsStamp();
}

function renderConnection() {
  const health = latest.lastHealth;
  setText($("health-result"), health ?
    t("mail153", "最終接続確認：$1 ／ $2。$3 $4", [health.status === "ready" ? t("mail154", "応答あり") : t("mail155", "確認失敗"), new Date(health.checkedAt).toLocaleString(uiLanguage()), health.engine || "", localizeDetail(health)]) :
    t("mail156", "接続はまだ確認していません。「接続を再確認」で確認できます。"));
  const guide = $("clamav-install-guide");
  if (!$("windows-definitions").hidden) {
    const shared = latest.settings.definitionSource === "gui";
    guide.querySelector("pre").hidden = shared;
    const instructions = guide.querySelector('[data-i18n="clamavInstallInstructions"]');
    instructions.textContent = shared ? t("definitionSourceHelp", "clamav-gui で定義を更新してください。") : t("directWindowsInstall", "公式の ClamAV と Python を導入してください。");
  }
  $("connection-title").closest("section").classList.toggle("needs-action", DIRECT ? health?.status === "error" : ["clamav_missing", "clamav_unusable"].includes(health?.code));
  guide.hidden = health?.status === "ready";
  if (guide.dataset.code !== (health?.code || "unknown")) {
    guide.dataset.code = health?.code || "unknown";
    guide.open = health?.code === "clamav_missing" || (DIRECT && ["direct_unavailable", "definitions_unavailable", "clamav_unusable"].includes(health?.code));
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
  $("folder-picker-empty").hidden = folders.length > 0 || !$("scan-account").value;
  setText($("folder-picker-empty"), t("folderNoMatches", "一致するフォルダーはありません。"));
  renderTarget();
}
function renderTarget() {
  const shown = matchingFolders(), shownIds = new Set(shown.map(folder => folder.id));
  const hiddenCount = [...selectedFolders].filter(id => !shownIds.has(id)).length;
  setText($("folder-selection-count"), hiddenCount ? t("folderSelectionCount", "選択$1フォルダー ／ 表示$2フォルダー（表示外の選択$3）", [selectedFolders.size, shown.length, hiddenCount]) : t("folderSelectionCompact", "選択$1 ／ 表示$2フォルダー", [selectedFolders.size, shown.length]));
  const account = latest?.accounts.find(account => account.id === $("scan-account").value);
  $("scan-target-label").hidden = !selectedFolders.size;
  setText($("scan-target-label"), selectedFolders.size ? t("folderConfirmCount", "$1：$2フォルダーを検査します。", [account?.name || "", selectedFolders.size]) : "");
  updateControls();
}
$("folder-search").addEventListener("input", renderFolderChoices);
$("folder-select-visible").addEventListener("click", () => { for (const folder of matchingFolders()) selectedFolders.add(folder.id); renderFolderChoices(); });
$("folder-clear-selection").addEventListener("click", () => { selectedFolders.clear(); renderFolderChoices(); });
async function loadFolders(interactive = false) {
  if (foldersLoading) return;
  foldersLoading = true; updateControls();
  setText($("folder-load-status"), t("mail162", "フォルダー一覧を取得しています。"));
  try {
    const response = await request("folderChoices");
    folderChoices = response.folders;
    folderNames = createFolderIndex(folderChoices);
    if (!settingsSaving && !settingsDirty) syncSettings(latest.settings);
    const availableIds = new Set(folderChoices.filter(folder => folder.accountId === $("scan-account").value).map(folder => folder.id));
    for (const id of selectedFolders) if (!availableIds.has(id)) selectedFolders.delete(id);
    const previous = $("scan-account").value;
    $("scan-account").replaceChildren(new Option(t("mail159", "選択してください"), ""));
    for (const account of latest.accounts) $("scan-account").append(new Option(account.name, account.id));
    if (latest.accounts.some(account => account.id === previous)) $("scan-account").value = previous;
    else if (latest.accounts.length === 1) $("scan-account").value = latest.accounts[0].id;
    renderFolderChoices();
    renderRecords();
    $("reload-folders-retry").hidden = true;
    setText($("folder-load-status"), response.limited ? t("mail163", "フォルダー数の上限に達しました。一覧にない対象はThunderbirdの右クリックから指定してください。") :
      folderChoices.length ? "" : t("mail164", "検査できるフォルダーがありません。"));
  } catch (error) { $("reload-folders-retry").hidden = false; setText($("folder-load-status"), t("mail165", "一覧を取得できませんでした。「一覧を更新」で再試行してください。") + error.message); if (interactive) throw error; }
  finally { foldersLoading = false; updateControls(); }
}
$("scan-account").addEventListener("change", () => { selectedFolders.clear(); $("folder-search").value = ""; renderFolderChoices(); });
for (const id of ["reload-folders", "reload-folders-retry"]) $(id).addEventListener("click", () => { void action(() => loadFolders(true)); });
function changeReview(targets, reviewed) {
  if (!targets.length || blocked()) return;
  const stamps = Object.fromEntries(targets.map(record => [record.key, reviewStamp(record)]));
  void action(async () => {
    const title = reviewed ? t("reviewAction", "確認済みにする") : t("unreviewAction", "未確認に戻す");
    setText($("review-title"), title); setText($("review-confirm"), title);
    setText($("review-description"), reviewed ? t("reviewDescription", "未検査や注意情報の結果と理由を残し、「確認が必要」の件数から除外します。安全性を検査で確認したという意味ではありません。再検査で本文や検出理由が変わった場合、本文を照合できない場合は未確認に戻ります。") : t("unreviewDescription", "確認済みの印を取り消し、再び「確認が必要」に含めます。検査結果は変えません。以前の判断メモがある場合は、そのメモも取り消します。"));
    setText($("review-count"), t("reviewTargetsCount", "対象：$1通（画面外の選択を含む）", [targets.length]));
    $("review-targets").replaceChildren(...targets.map(record => {
      const item = document.createElement("li");
      item.textContent = [record.locator.author, record.locator.subject, localizeDetail(record)].filter(Boolean).join(" ／ "); return item;
    }));
    $("review-dialog").returnValue = "cancel";
    const confirmed = await new Promise(resolve => {
      $("review-dialog").onclose = () => resolve($("review-dialog").returnValue === "apply");
      $("review-dialog").showModal(); $("review-cancel").focus();
    });
    if (!confirmed) return t("reviewCancelled", "確認状態の変更を中止しました。");
    const result = await request("reviewMany", { keys: targets.map(record => record.key), reviewed, note: "", stamps });
    return t("reviewCompleted", "$1通の確認状態を変更しました。", [result.count]);
  });
}
for (const [id, reviewed] of [["review-selected", true], ["unreview-selected", false]]) {
  bulkActions.set(id, () => changeReview(selection().filter(reviewed ? canReview : canUnreview), reviewed));
}
bulkActions.set("quarantine-selected", () => {
  const targets = selection().filter(canQuarantine);
  if (!targets.length || blocked()) return;
  if (targets.some(record => !latest.settings.quarantine?.[record.locator.accountId])) {
    userNavigated = true; activateTab("settings");
    void feedback.error(new Error(t("qTargetMissing", "隔離先を確認できません。設定で同じアカウント内の専用フォルダーを選び直してください。")), feedback.capture());
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
    return { message: t("qCompleted", "隔離：$1通移動、$2通失敗。結果を確認してください。", [result.moved, result.failed]), warning: result.failed > 0, guidance: t("messageBatchGuidance", "成功した処理は実行済みです。検査結果と対象ごとのエラーを確認してください。") };
  });
});
$("bulk-action").addEventListener("change", updateControls);
$("bulk-execute").addEventListener("click", () => {
  if (blocked() || $("bulk-execute").disabled) return;
  bulkActions.get($("bulk-action").value)?.();
});
function clearScanErrors() {
  setText($("settings-status"), "");
  for (const input of $("settings-form").querySelectorAll("[id^=scan-]")) {
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
    $(input.id + "-error")?.remove();
  }
}
function showScanErrors(error) {
  clearScanErrors();
  for (const field of error.fields || []) {
    const input = $("scan-" + field.key), detail = document.createElement("span");
    detail.id = input.id + "-error"; detail.className = "field-error"; detail.textContent = field.message;
    input.insertAdjacentElement("afterend", detail);
    input.setAttribute("aria-invalid", "true"); input.setAttribute("aria-describedby", detail.id);
  }
  setText($("settings-status"), error.fields?.length ? "" : error.message);
  const first = error.fields?.[0];
  if (first) {
    const input = $("scan-" + first.key), details = input.closest("details");
    if (details) details.open = true;
    input.focus();
  }
}
function settingsStamp() {
  return JSON.stringify([...$("settings-form").querySelectorAll("input, select")].map(input =>
    input.type === "checkbox" ? [input.value, input.checked] : input.value));
}

function settingsMessage(message, error = false, temporary = false) {
  clearTimeout(settingsMessageTimer);
  $("settings-status").dataset.error = String(error);
  setText($("settings-status"), message);
  if (temporary) settingsMessageTimer = setTimeout(() => {
    if (!settingsDirty && !settingsSaving) setText($("settings-status"), "");
  }, 5000);
}

function settingsChanged() {
  for (const row of $("quarantine-settings").children) {
    if (!row.querySelector("select").value) row.querySelector("input").checked = false;
  }
  settingsDirty = settingsStamp() !== savedSettingsStamp;
  syncUnsavedWarning();
  clearScanErrors();
  settingsMessage(settingsDirty ? t("settingsUnsaved", "未保存の変更があります。") : "");
  updateControls();
}
for (const event of ["input", "change"]) $("settings-form").addEventListener(event, settingsChanged);
function warnUnsavedSettings(event) {
  event.preventDefault();
  event.returnValue = "";
}
function syncUnsavedWarning() {
  if (settingsDirty || settingsSaving) window.addEventListener("beforeunload", warnUnsavedSettings);
  else window.removeEventListener("beforeunload", warnUnsavedSettings);
}

$("settings-discard").addEventListener("click", () => {
  if (blocked() || !settingsDirty) return;
  settingsDirty = false;
  syncUnsavedWarning();
  clearScanErrors();
  syncSettings(latest.settings);
  settingsMessage("");
  updateControls();
});

$("settings-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (blocked() || !settingsDirty || foldersLoading || latest?.helperRemoved) return;
  if (JSON.stringify(latest.settings) !== savedSettingsVersion) {
    settingsMessage(t("settingsConflict", "別の画面で設定が変更されました。取り消して最新の設定を読み直してください。"), true);
    return;
  }
  const accountIds = [...$("accounts").querySelectorAll("input:checked")].map(input => input.value);
  const quarantine = readQuarantineSettings(latest.settings.quarantine, folderChoices);
  let scanSettings;
  try { scanSettings = readScanPolicy(); }
  catch (error) {
    showScanErrors(error);
    settingsMessage(t("settingsInvalidFields", "入力内容を確認してください。"), true);
    return;
  }
  clearScanErrors();
  const settings = { enabled: accountIds.length > 0, notifications: $("notifications").checked,
    ...($("quiet-encrypted-zip").checked ? { quietEncryptedZip:true } : {}),
    idleAutomatic: $("idle-automatic").checked, accountIds, quarantine, scanSettings };
  if (!$("windows-definitions").hidden && $("definition-source").value === "gui") settings.definitionSource = "gui";
  const changedSource = latest.settings.definitionSource !== settings.definitionSource;
  settingsSaving = true;
  busy = true;
  settingsMessage(t("settingsSaving", "保存しています。"));
  updateControls();
  try {
    if (quarantineNeedsPermission(latest.settings.quarantine, quarantine)) await requireMovePermission();
    const response = await request("settings", { settings, expectedSettings: savedSettingsVersion });
    latest.settings = response.settings;
    settingsDirty = false;
    syncSettings(latest.settings);
    settingsMessage(t("mail170", "設定を保存しました。"), false, true);
    if (changedSource) {
      latest.lastHealth = null;
      renderConnection();
      try {
        latest.lastHealth = (await request("health")).health;
        renderConnection();
        if (latest.lastHealth?.status === "error") throw new Error(latest.lastHealth.detail);
      } catch (error) {
        settingsMessage(t("settingsSavedHealthFailed", "設定は保存しました。接続確認に失敗しました：$1", [error.message]), true);
      }
    }
  } catch (error) {
    settingsMessage(t("settingsSaveFailed", "保存できませんでした：$1", [error.message]), true);
  } finally {
    settingsSaving = false;
    syncUnsavedWarning();
    busy = false;
    updateControls();
    await refresh().catch(reportRefreshError);
  }
});
$("health").addEventListener("click", () => {
  void action(async () => {
    const { health } = await request("health");
    if (startupFailed || !latest) await refresh();
    latest.lastHealth = health;
    renderConnection();
    if (health.status !== "ready") throw new Error(health.detail);
  }, t("mail171", "接続の確認結果を更新しました。"));
});
$("background-retry").addEventListener("click", () => { void action(() => refresh()); });
void refresh().catch(reportRefreshError);
setInterval(() => {
  if (!document.hidden) void refresh().catch(reportRefreshError);
}, 2000);

$("receipt-open-scan").addEventListener("click", () => { userNavigated = true; activateTab("scan"); });
$("receipt-recovery-clear").addEventListener("click", () => {
  const token = latest?.receiptRecovery?.token;
  void action(() => request("acknowledgeReceiptRecovery", { token }));
});
