import { LABELS, needsAttention } from "./core.mjs";
import { selectable, canDelete, filterRecords, resultPage } from "./results.mjs";
import { FOLDER_STATES } from "./folder-scan.mjs";

const $ = id => document.getElementById(id);
let latest, initialized = false, refreshing = false, busy = false, page = 0;
let visible = [];
const rows = new Map(), selected = new Set();
let folderFilterId = null, seenFolderRequest = null;
let folderAnnouncement = null;

async function request(type, values = {}) {
  const response = await messenger.runtime.sendMessage({ ...values, type });
  if (!response?.ok) throw new Error(response?.error || "拡張の処理に接続できませんでした。");
  return response;
}
function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}
function blocked() { return busy || Boolean(latest?.batch?.active); }
function selection() { return visible.filter(record => selected.has(record.key)); }
function updateControls() {
  const locked = blocked(), chosen = selection();
  setText($("selected-count"), `選択${chosen.length}件`);
  $("retry-selected").disabled = locked || !chosen.length;
  $("delete-selected").disabled = locked || !chosen.length || !chosen.every(canDelete);
  $("deselect").disabled = locked || !chosen.length;
  const candidates = visible.filter(selectable);
  $("select-page").disabled = locked || !candidates.length;
  $("select-page").checked = candidates.length > 0 && chosen.length === candidates.length;
  $("select-page").indeterminate = chosen.length > 0 && chosen.length < candidates.length;
  for (const id of ["filter", "account-filter", "search", "reset-filters", "scan-selection", "clear", "allow-delete", "health"]) {
    $(id).disabled = locked;
  }
  const job = latest?.folderJob;
  const folderActive = job && ["collecting", "running", "stopping"].includes(job.status);
  $("scan-folder").disabled = locked || Boolean(folderActive);
  $("folder-stop").disabled = locked || !folderActive || job.status === "stopping";
  $("folder-resume").hidden = !job || !["stopped", "interrupted", "blocked", "error"].includes(job.status);
  $("folder-resume").disabled = locked || Boolean(folderActive);
  $("folder-delete").disabled = locked || !job || Boolean(folderActive);
  $("folder-results").disabled = locked || !job;
  $("folder-only").disabled = locked || !job;
  for (const input of $("settings-form").querySelectorAll("input, button")) input.disabled = locked;
  for (const record of visible) {
    const entry = rows.get(record.key);
    entry.checkbox.disabled = locked || !selectable(record);
    entry.checkbox.checked = selected.has(record.key);
    entry.row.dataset.selected = String(entry.checkbox.checked);
    entry.open.disabled = locked || !record.sha256 || ["queued", "scanning", "deleted"].includes(record.status);
    entry.retry.disabled = locked || !selectable(record);
    entry.remove.disabled = locked || !canDelete(record);
  }
  $("previous-page").disabled = locked || page === 0;
  $("next-page").disabled = locked || page + 1 >= Number($("page-label").dataset.pages || 1);
}
async function action(callback, success) {
  if (blocked()) return;
  const previousFocus = document.activeElement;
  busy = true;
  updateControls();
  try {
    setText($("action-status"), "処理しています。");
    const message = await callback();
    setText($("action-status"), success || message || "処理が完了しました。");
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

function activateTab(name, focus = false) {
  for (const id of ["results", "settings"]) {
    const active = id === name;
    const button = $("tab-" + id);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    $("panel-" + id).hidden = !active;
    if (active && focus) button.focus();
  }
}

function renderFolder() {
  const job = latest.folderJob;
  $("folder-progress").hidden = !job;
  $("folder-only-label").hidden = !job;
  if (!job) {
    folderFilterId = null; $("folder-only").checked = false;
    return;
  }
  if (folderFilterId && folderFilterId !== job.id) {
    folderFilterId = null; $("folder-only").checked = false; selected.clear(); page = 0;
  }
  const account = latest.accounts.find(account => account.id === job.folder.accountId)?.name || job.folder.accountId;
  setText($("folder-title"), `フォルダー検査：${account} ／ ${job.folder.path}${job.includeSubfolders ? "（サブフォルダーを含む）" : ""}`);
  const elapsed = Math.max(0, Math.floor(((job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now()) - new Date(job.startedAt).getTime()) / 1000));
  const time = `経過${Math.floor(elapsed / 60)}分${elapsed % 60}秒`;
  if (job.total === null) {
    if (["collecting", "stopping"].includes(job.status)) $("folder-bar").removeAttribute("value");
    else { $("folder-bar").max = 1; $("folder-bar").value = 0; }
    setText($("folder-status"), `${FOLDER_STATES[job.status]} ／ 対象${job.discovered}件を確認 ／ ${time}`);
  } else {
    $("folder-bar").max = Math.max(1, job.total);
    $("folder-bar").value = job.total === 0 && job.status === "completed" ? 1 : job.completed;
    const percent = job.total ? (100 * job.completed / job.total).toFixed(1) : "100.0";
    const waiting = Math.max(0, job.total - job.completed - job.scanning);
    setText($("folder-status"), `${FOLDER_STATES[job.status]} ／ 処理済み${job.completed} / ${job.total}件（${percent}%） ／ 検査中${job.scanning}件・未処理${waiting}件 ／ ${time}`);
  }
  setText($("folder-counts"), `未検出${job.counts.clean}件 ／ 検出${job.counts.detected}件 ／ 未検査${job.counts.incomplete}件 ／ 失敗${job.counts.error}件`);
  const milestone = `${job.id}:${job.status}:${Math.floor(job.completed / 10)}`;
  if (milestone !== folderAnnouncement) {
    folderAnnouncement = milestone;
    setText($("folder-announcement"), `フォルダー検査 ${FOLDER_STATES[job.status]}。処理済み${job.completed}件${job.total === null ? "" : `、対象${job.total}件`}。`);
  }
  setText($("folder-detail"), job.detail + (job.resumeCount ? " 再開時は現在のフォルダーと照合します。総件数はこれまでの処理済み件数と、今回の未処理件数の合計です。" : "") + (job.skippedFolders ? ` 対象外のフォルダー：${job.skippedFolders}件。` : ""));
  const retained = latest.records.filter(record => record.folderJobId === job.id).length;
  setText($("folder-retained"), `この検査の履歴を${retained}件保持しています。履歴上限は1000件で、未検出・完全削除済みの古い履歴から入れ替えます。進捗の処理件数は別に保持します。検出・未検査・失敗の履歴で上限に達した場合は停止します。`);
}

function showFolderDialog(context) {
  seenFolderRequest = context.token;
  activateTab("results");
  const account = latest.accounts.find(account => account.id === context.folder.accountId)?.name || context.folder.accountId;
  setText($("folder-target"), `${account} ／ ${context.folder.path}`);
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
      return "フォルダー検査を開始しました。進捗パネルで確認できます。";
    });
  }, { once: true });
  dialog.showModal();
  $("folder-cancel").focus();
}

$("scan-folder").addEventListener("click", () => {
  let context;
  void action(async () => {
    context = await request("folderContext");
    return "対象とサブフォルダーの範囲を確認してください。";
  }).then(() => { if (context && !$("folder-dialog").open) showFolderDialog(context); });
});
$("folder-stop").addEventListener("click", () => {
  const jobId = latest?.folderJob?.id;
  void action(() => request("folderStop", { jobId }), "中止を受け付けました。実行中の処理を終えて停止します。");
});
$("folder-resume").addEventListener("click", () => {
  const jobId = latest?.folderJob?.id;
  void action(() => request("folderResume", { jobId }), "再開を受け付けました。処理済みメールと照合しています。");
});
$("folder-delete").addEventListener("click", () => {
  if (blocked() || !latest?.folderJob) return;
  const job = latest.folderJob, dialog = $("folder-delete-dialog");
  setText($("folder-delete-target"), `${job.folder.path} ／ 処理済み${job.completed}件`);
  dialog.returnValue = "cancel";
  dialog.onclose = () => {
    if (dialog.returnValue !== "delete") return;
    void action(() => request("folderDelete", { jobId: job.id }), "フォルダー検査の記録を削除しました。メールと検査結果は残っています。");
  };
  dialog.showModal();
  $("folder-delete-cancel").focus();
});
$("folder-results").addEventListener("click", () => {
  folderFilterId = latest.folderJob.id; $("folder-only").checked = true;
  $("filter").value = "all"; $("account-filter").value = "all"; $("search").value = ""; resetSelection();
});
$("folder-only").addEventListener("change", () => {
  folderFilterId = $("folder-only").checked ? latest?.folderJob?.id : null; resetSelection();
});
for (const [index, name] of ["results", "settings"].entries()) {
  $("tab-" + name).addEventListener("click", () => activateTab(name));
  $("tab-" + name).addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
    activateTab(["results", "settings"][next], true);
  });
}

function confirmDeletion(targets) {
  const dialog = $("delete-dialog");
  $("delete-targets").replaceChildren();
  setText($("delete-count"), `完全削除する対象：${targets.length}件（下の全件をご確認ください）`);
  for (const target of targets) {
    const item = document.createElement("li");
    const subject = item.appendChild(document.createElement("strong"));
    subject.textContent = target.subject;
    const detail = item.appendChild(document.createElement("div"));
    const account = latest.accounts.find(account => account.id === target.accountId)?.name || target.accountId;
    detail.textContent = `${target.author} ／ ${account} ／ ${target.folder} ／ ${target.signatures.join(" / ")}`;
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

async function deleteOne(key) {
  setText($("action-status"), "削除対象を照合しています。");
  const target = await request("prepareDelete", { key });
  if (!await confirmDeletion([target])) {
    await request("cancelDelete", { token: target.token });
    return "削除をキャンセルしました。";
  }
  await request("deletePermanently", { key, token: target.token });
  selected.delete(key);
  return "対象メールを完全削除しました。";
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
  details.appendChild(document.createElement("summary")).textContent = "検出名・検査情報";
  for (const key of ["signatures", "engine"]) {
    parts[key] = details.appendChild(document.createElement("span"));
    parts[key].className = key;
  }
  const open = cells[4].appendChild(document.createElement("button"));
  open.textContent = "メールを開く";
  open.addEventListener("click", () => {
    if (blocked()) return;
    const current = latest.records.find(item => item.key === record.key);
    if (current?.status === "detected" && !confirm("脅威候補を検出したメールを開きます。本文が表示されます。添付ファイルやリンクは開かずに確認してください。")) return;
    void action(() => request("open", { key: record.key }), "Thunderbirdで対象メールを開きました。");
  });
  const retry = cells[4].appendChild(document.createElement("button"));
  retry.textContent = "再検査";
  retry.addEventListener("click", () => { void action(() => request("retry", { key: record.key }), "再検査を受け付けました。"); });
  const remove = cells[4].appendChild(document.createElement("button"));
  remove.textContent = "完全削除";
  remove.className = "danger";
  remove.addEventListener("click", () => { void action(() => deleteOne(record.key)); });
  return { row, parts, checkbox, open, retry, remove };
}

function renderRecords() {
  if (!latest) return;
  renderFolder();
  const filtered = filterRecords(latest.records, { status: $("filter").value, account: $("account-filter").value, search: $("search").value, folderJobId: folderFilterId });
  const result = resultPage(filtered, page);
  page = result.page;
  visible = result.records;
  const keep = new Set(visible.map(record => record.key));
  for (const key of selected) {
    if (!visible.some(record => record.key === key && selectable(record))) selected.delete(key);
  }
  for (const [key, entry] of rows) {
    if (!keep.has(key)) { entry.row.remove(); rows.delete(key); }
  }
  for (const [index, record] of visible.entries()) {
    const entry = rows.get(record.key) || makeRow(record);
    rows.set(record.key, entry);
    entry.row.dataset.status = record.status;
    setText(entry.parts.state, LABELS[record.status] || "不明");
    entry.parts.time.dateTime = record.updatedAt;
    setText(entry.parts.time, new Date(record.updatedAt).toLocaleString());
    setText(entry.parts.sender, record.locator.author || "差出人なし");
    setText(entry.parts.subject, record.locator.subject || "件名なし");
    const account = latest.accounts.find(account => account.id === record.locator.accountId)?.name || record.locator.accountId || "";
    setText(entry.parts.location, [account, record.locator.folder?.path].filter(Boolean).join(" ／ "));
    setText(entry.parts.detail, record.detail || "");
    setText(entry.parts.signatures, (record.signatures || []).join(" / "));
    setText(entry.parts.engine, record.engine || "");
    entry.remove.hidden = record.status !== "detected";
    for (const [button, label] of [[entry.checkbox, "一括操作の対象に選択"], [entry.remove, "ごみ箱を経由せず完全削除"], [entry.open, "メールを開く"], [entry.retry, "再検査"]]) {
      button.setAttribute("aria-label", `${record.locator.subject || "件名なし"}：${label}`);
    }
    const at = $("results").children[index];
    if (at !== entry.row) $("results").insertBefore(entry.row, at || null);
  }
  const waiting = latest.records.filter(record => record.status === "queued").length;
  const attention = latest.records.filter(needsAttention).length;
  setText($("summary"), `履歴${latest.records.length}件 ／ 確認が必要${attention}件 ／ 検査待ち${waiting}件 ／ 絞り込み結果${filtered.length}件`);
  setText($("page-label"), `${page + 1} / ${result.pages}ページ（1ページ50件）`);
  $("page-label").dataset.pages = String(result.pages);
  $("empty-results").hidden = visible.length > 0;
  const progress = latest.batch;
  $("batch-progress").hidden = !progress?.active;
  if (progress?.active) setText($("batch-progress"), `一括削除：${progress.completed} / ${progress.total}件を処理（削除${progress.deleted}件、失敗${progress.failed}件）`);
  updateControls();
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    latest = await request("state");
    if (!initialized) {
      $("enabled").checked = latest.settings.enabled;
      $("notifications").checked = latest.settings.notifications;
      for (const account of latest.accounts) {
        const label = document.createElement("label"), checkbox = document.createElement("input");
        checkbox.type = "checkbox"; checkbox.value = account.id;
        checkbox.checked = latest.settings.accountIds.includes(account.id);
        label.append(checkbox, document.createTextNode(`${account.name}（${account.type}）`));
        $("accounts").append(label);
      }
      if (!latest.accounts.length) setText($("accounts"), "対象アカウントがありません。");
      initialized = true;
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
  $(id).addEventListener("click", () => { selected.clear(); page += delta; renderRecords(); });
}
$("select-page").addEventListener("change", () => {
  for (const record of visible.filter(selectable)) {
    if ($("select-page").checked) selected.add(record.key); else selected.delete(record.key);
  }
  updateControls();
});
$("deselect").addEventListener("click", () => { selected.clear(); updateControls(); });
$("retry-selected").addEventListener("click", () => {
  const keys = selection().map(record => record.key);
  void action(async () => {
    const response = await request("retryMany", { keys });
    selected.clear();
    return `${response.count}件の再検査を受け付けました。`;
  });
});
$("delete-selected").addEventListener("click", () => {
  const keys = selection().map(record => record.key);
  void action(async () => {
    $("batch-report").replaceChildren(); $("batch-report").hidden = true;
    setText($("action-status"), "選択した削除対象を照合しています。");
    const prepared = await request("prepareDeleteBatch", { keys });
    if (!await confirmDeletion(prepared.targets)) {
      await request("cancelDeleteBatch", { token: prepared.token });
      return "一括削除をキャンセルしました。";
    }
    const response = await request("deleteBatch", { token: prepared.token });
    const failed = response.results.filter(result => !result.deleted);
    for (const result of response.results) if (result.deleted) selected.delete(result.key);
    for (const result of failed) {
      const item = document.createElement("li");
      const target = prepared.targets.find(target => target.key === result.key);
      item.textContent = `${target?.subject || "対象メール"}：${result.error}`;
      $("batch-report").append(item);
    }
    $("batch-report").hidden = failed.length === 0;
    return `一括削除：完全削除${response.results.length - failed.length}件、未削除${failed.length}件。`;
  });
});
$("settings-form").addEventListener("submit", event => {
  event.preventDefault();
  void action(() => request("settings", { settings: {
    enabled: $("enabled").checked, notifications: $("notifications").checked,
    accountIds: [...$("accounts").querySelectorAll("input:checked")].map(input => input.value)
  } }), "設定を保存しました。");
});
$("health").addEventListener("click", () => {
  void action(async () => {
    const { health } = await request("health");
    if (health.status !== "ready") throw new Error(health.detail);
    setText($("health-result"), `${health.engine}。${health.detail} バージョン確認のみで、実際の検査はまだ実行していません。`);
  }, "ClamAVと補助プログラムに接続できました。");
});
$("scan-selection").addEventListener("click", () => { void action(() => request("scanSelection"), "選択メールの検査を受け付けました。"); });
$("clear").addEventListener("click", () => {
  if (blocked() || !confirm("検出・失敗を含む、完了した検査履歴を消去します。メール自体は削除しません。続けますか？")) return;
  void action(() => request("clear"), "完了した検査履歴を消去しました。");
});
$("allow-delete").addEventListener("click", () => {
  // Keep the permission request in the original user gesture.
  void action(async () => {
    const granted = await messenger.permissions.request({ permissions: ["messagesDelete"] });
    return granted ? "完全削除を許可しました。検査結果タブで対象を選択できます。" : "完全削除は許可されませんでした。";
  });
});
void refresh().catch(error => setText($("action-status"), error.message));
setInterval(() => {
  if (!document.hidden) void refresh().catch(error => setText($("action-status"), error.message));
}, 2000);
