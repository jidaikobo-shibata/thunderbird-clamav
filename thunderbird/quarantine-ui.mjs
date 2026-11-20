import { permission } from "./direct-transport.mjs";
import { t } from "./i18n.mjs";
import { quarantineFolder, canQuarantine } from "./quarantine.mjs";
import { folderLabel } from "./folder-labels.mjs";

const folderOptions = new WeakMap();
function accountOptions(folders, accountId) {
  let accounts = folderOptions.get(folders);
  if (!accounts) {
    accounts = new Map();
    for (const folder of folders) {
      if (!quarantineFolder(folder)) continue;
      let group = accounts.get(folder.accountId);
      if (!group) { group = { choices: new Map(), options: [["", t("qNoTarget", "隔離先を指定しない")]] }; accounts.set(folder.accountId, group); }
      group.choices.set(folder.id, folder.path);
      // This is already the canonical choice; no search through all folders.
      group.options.push([folder.id, folderLabel(folder)]);
    }
    for (const group of accounts.values()) group.signature = JSON.stringify(group.options);
    folderOptions.set(folders, accounts);
  }
  return accounts.get(accountId) || { choices: new Map(), options: [["", t("qNoTarget", "隔離先を指定しない")]], signature: "none" };
}

export function syncQuarantineSettings(settings, accounts, folders) {
  const host = document.getElementById("quarantine-settings");
  const ids = new Set(accounts.map(account => account.id));
  for (const row of host.children) if (!ids.has(row.dataset.account)) row.remove();
  for (const account of accounts) {
    let row = [...host.children].find(row => row.dataset.account === account.id);
    if (!row) {
      row = document.createElement("div"); row.dataset.account = account.id;
      const label = document.createElement("label"), name = document.createElement("span"), select = document.createElement("select");
      label.append(name, select);
      const autoLabel = document.createElement("label"), auto = document.createElement("input"); auto.type = "checkbox";
      autoLabel.append(auto, document.createTextNode(t("qAuto", "新着メールで脅威を検出したら自動で隔離する")));
      row.append(label, autoLabel); host.append(row);
    }
    row.setAttribute("role", "group"); row.setAttribute("aria-label", account.name);
    row.querySelector("span").textContent = t("qAccountTarget", "$1の隔離先", [account.name]);
    const config = settings.quarantine?.[account.id], select = row.querySelector("select"), auto = row.querySelector("input");
    const cached = accountOptions(folders, account.id);
    const unavailable = config && cached.choices.get(config.folderId) !== config.path;
    const signature = cached.signature + (unavailable ? JSON.stringify([config.folderId, config.path]) : "");
    if (select.dataset.options !== signature) {
      const options = unavailable ? [...cached.options, [config.folderId, t("qUnavailableTarget", "確認できない隔離先：$1（選び直してください）", [config.path])]] : cached.options;
      select.replaceChildren(...options.map(([value, name]) => new Option(name, value)));
      select.dataset.options = signature;
    }
    select.value = config?.folderId || ""; auto.checked = Boolean(config?.auto);
  }
}
export function readQuarantineSettings(previous, folders) {
  const result = {};
  for (const row of document.getElementById("quarantine-settings").children) {
    const folderId = row.querySelector("select").value;
    if (!folderId) { row.querySelector("input").checked = false; continue; }
    const accountId = row.dataset.account;
    const folder = folders.find(folder => folder.id === folderId && folder.accountId === accountId);
    result[accountId] = { folderId, path: folder?.path || previous?.[accountId]?.path || "", auto: row.querySelector("input").checked };
  }
  return result;
}
export async function requireMovePermission() {
  if (!await permission(messenger, ["messagesMove"])) throw new Error(t("qPermission", "隔離にはメール移動の権限が必要です。"));
}
export function confirmQuarantine(records, settings, accounts, folders) {
  const dialog = document.getElementById("quarantine-dialog"), list = document.getElementById("quarantine-targets");
  list.replaceChildren();
  for (const record of records) {
    const config = settings.quarantine?.[record.locator.accountId];
    const target = folders.find(folder => folder.id === config?.folderId && folder.path === config?.path && folder.accountId === record.locator.accountId);
    if (!target) throw new Error(t("qTargetMissing", "隔離先を確認できません。設定で同じアカウント内の専用フォルダーを選び直してください。"));
    const account = accounts.find(account => account.id === record.locator.accountId);
    const item = document.createElement("li");
    item.textContent = [record.locator.author, record.locator.subject, account?.name, t("qDestination", "隔離先：$1", [folderLabel(target, folders, record.locator.accountId)])].filter(Boolean).join(" ／ "); list.append(item);
  }
  document.getElementById("quarantine-count").textContent = t("qCount", "移動するメール：$1通（画面外の選択を含む）", [records.length]);
  dialog.returnValue = "cancel";
  return new Promise(resolve => { dialog.onclose = () => resolve(dialog.returnValue === "move"); dialog.showModal(); document.getElementById("quarantine-cancel").focus(); });
}
export function quarantineSummary(record, folders) {
  const info = record.quarantine;
  if (!info) return "";
  if (info.status === "error") return t("qFailed", "隔離できませんでした：$1", [info.detail || ""]);
  if (info.status === "moving") return t("qMoving", "隔離処理中（中断された場合は移動先を確認してください）");
  if (info.status === "outside" || info.status === "moved" &&
      (info.destination?.accountId !== record.locator.accountId || info.destination?.path !== record.locator.folder?.path)) return t("qOutside", "隔離先の外へ移動済みです。");
  return t("qMoved", "隔離先へ移動済み：$1", [folderLabel(info.destination, folders, record.locator.accountId)]);
}
