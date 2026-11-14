import { LABELS, needsAttention } from "./core.mjs";

const $ = id => document.getElementById(id);
let latest;
let initialized = false;
let refreshing = false;
let busy = false;
const rows = new Map();

async function request(type, values = {}) {
  const response = await messenger.runtime.sendMessage({ ...values, type });
  if (!response?.ok) throw new Error(response?.error || "拡張の処理に接続できませんでした。");
  return response;
}

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

async function action(callback, success) {
  if (busy) return;
  busy = true;
  try {
    setText($("action-status"), "処理しています。");
    const message = await callback();
    setText($("action-status"), success || message || "処理が完了しました。");
    await refresh();
  } catch (error) { setText($("action-status"), error.message); }
  finally { busy = false; }
}

function makeRow(record) {
  const row = document.createElement("tr");
  const parts = {};
  const cells = Array.from({ length: 4 }, () => row.appendChild(document.createElement("td")));
  for (const [key, tag, cell] of [
    ["state", "span", 0], ["time", "time", 0], ["sender", "span", 1],
    ["subject", "strong", 1], ["detail", "span", 2], ["signatures", "span", 2],
    ["engine", "span", 2]
  ]) {
    parts[key] = cells[cell].appendChild(document.createElement(tag));
    parts[key].className = key;
  }
  const open = cells[3].appendChild(document.createElement("button"));
  open.textContent = "メールを開く";
  open.addEventListener("click", () => {
    const current = latest.records.find(item => item.key === record.key);
    if (current?.status === "detected" && !confirm(
      "脅威候補を検出したメールを開きます。本文が表示されます。添付ファイルやリンクは開かずに確認してください。"
    )) return;
    void action(() => request("open", { key: record.key }), "Thunderbirdで対象メールを開きました。");
  });
  const retry = cells[3].appendChild(document.createElement("button"));
  retry.textContent = "再検査";
  retry.addEventListener("click", () => {
    void action(() => request("retry", { key: record.key }), "再検査を受け付けました。");
  });
  const remove = cells[3].appendChild(document.createElement("button"));
  remove.textContent = "完全削除";
  remove.className = "danger";
  remove.addEventListener("click", () => {
    void action(async () => {
      const target = await request("prepareDelete", { key: record.key });
      if (!confirm(`この1通をごみ箱を経由せず完全に削除します。元には戻せません。\nIMAPではサーバーと他端末にも反映されます。\n\n差出人: ${target.author}\n件名: ${target.subject}\nアカウント: ${target.accountId}\nフォルダー: ${target.folder}\n検出名: ${target.signatures.join(" / ")}\n\n完全に削除しますか？`)) {
        await request("cancelDelete", { token: target.token });
        return "削除をキャンセルしました。";
      }
      await request("deletePermanently", { key: record.key, token: target.token });
      return "対象メールを完全削除しました。";
    });
  });
  return { row, parts, open, retry, remove };
}

function renderRecords() {
  if (!latest) return;
  const filter = $("filter").value;
  const filtered = latest.records.filter(record =>
    filter === "attention" ? needsAttention(record) : filter === "pending" ?
      ["queued", "scanning"].includes(record.status) : true
  ).slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const visible = filtered.slice(0, 100);
  const keep = new Set(visible.map(record => record.key));
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
    setText(entry.parts.detail, record.detail || "");
    setText(entry.parts.signatures, (record.signatures || []).join(" / "));
    setText(entry.parts.engine, record.engine || "");
    entry.open.disabled = !record.sha256 || ["queued", "scanning", "deleted"].includes(record.status);
    entry.retry.disabled = ["queued", "scanning", "deleted"].includes(record.status);
    entry.remove.hidden = record.status !== "detected";
    entry.remove.disabled = !record.sha256;
    entry.remove.setAttribute("aria-label", `${record.locator.subject || "件名なし"}：ごみ箱を経由せず完全削除`);
    entry.open.setAttribute("aria-label", `${record.locator.subject || "件名なし"}：メールを開く`);
    entry.retry.setAttribute("aria-label", `${record.locator.subject || "件名なし"}：再検査`);
    const at = $("results").children[index];
    if (at !== entry.row) $("results").insertBefore(entry.row, at || null);
  }
  const waiting = latest.records.filter(record => record.status === "queued").length;
  const attention = latest.records.filter(needsAttention).length;
  setText($("summary"), `履歴${latest.records.length}件、検査待ち${waiting}件、確認が必要${attention}件。表示${visible.length}件／該当${filtered.length}件。`);
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
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = account.id;
        checkbox.checked = latest.settings.accountIds.includes(account.id);
        label.append(checkbox, document.createTextNode(`${account.name}（${account.type}）`));
        $("accounts").append(label);
      }
      if (!latest.accounts.length) setText($("accounts"), "対象アカウントがありません。");
      initialized = true;
    }
    $("issue").hidden = !latest.issue;
    setText($("issue"), latest.issue || "");
    renderRecords();
  } finally { refreshing = false; }
}

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
$("scan-selection").addEventListener("click", () => {
  void action(() => request("scanSelection"), "選択メールの検査を受け付けました。");
});
$("clear").addEventListener("click", () => {
  if (!confirm("検出・失敗を含む、完了した検査履歴を消去します。メール自体は削除しません。続けますか？")) return;
  void action(() => request("clear"), "完了した検査履歴を消去しました。");
});
$("filter").addEventListener("change", renderRecords);
$("allow-delete").addEventListener("click", () => {
  // Invoke directly in the click handler to preserve the required user gesture.
  void action(async () => {
    const granted = await messenger.permissions.request({ permissions: ["messagesDelete"] });
    return granted ? "完全削除を許可しました。削除時には対象の確認が必要です。" : "完全削除は許可されませんでした。";
  });
});
void refresh().catch(error => setText($("action-status"), error.message));
setInterval(() => {
  if (!document.hidden) void refresh().catch(error => setText($("action-status"), error.message));
}, 2000);
