import { directRuntime } from "./direct-transport.mjs";
import { t } from "./i18n.mjs";

/** Keep the daily-use view small; legacy management remains in the legacy build. */
export function configureDirectView() {
  if (!directRuntime()) return;
  const $ = id => document.getElementById(id);
  document.title = t("directAppTitle", "ClamAV メール検査（実験版）");
  document.querySelector("header h1").textContent = document.title;
  const connection = $("connection-title").closest("section");
  $("settings-form").after(connection);
  $("tab-settings").append($("setup-dot"));
  for (const name of ["setup", "uninstall"]) {
    $("tab-" + name).remove();
    $("panel-" + name).remove();
  }
  const tabs = document.querySelector(".tabs");
  tabs.style.setProperty("--tab-columns", "4");
  tabs.style.setProperty("--tab-compact-columns", "4");

  const help = $("panel-help");
  let node = help.querySelector('[data-i18n="mail106"]').closest("h3");
  const nextSection = help.querySelector('[data-i18n="scanSettingsHeading"]');
  while (node !== nextSection) {
    const next = node.nextElementSibling;
    node.remove(); node = next;
  }
  for (const [tag, key, fallback] of [
    ["h3", "directHelpEnvironmentTitle", "利用環境"],
    ["p", "directHelpEnvironment", "ClamAVとPython3を使用します。連携状態は「設定」の末尾で確認できます。"],
    ["h3", "directHelpMaintenanceTitle", "更新と削除"],
    ["p", "directUpdateHelp", "通常の更新は、旧版を削除せずXPIを上書きします。内蔵の検査処理も一緒に更新されます。"],
    ["p", "directHelpUninstall", "削除する場合は、Thunderbirdのアドオンマネージャーからこの拡張を削除します。設定・検査履歴は失われる可能性があります。メール・アカウント・ClamAV・Python3は残ります。"],
    ["p", "directHelpRetained", "移行時に作成済みのバックアップや、旧版の補助プログラムは、この操作では削除しません。"]
  ]) {
    const element = document.createElement(tag);
    element.textContent = t(key, fallback); nextSection.before(element);
  }
  const replace = (oldKey, key, fallback) => {
    for (const element of document.querySelectorAll('[data-i18n="' + oldKey + '"]')) element.textContent = t(key, fallback);
  };
  replace("scanHelp", "directScanHelp", "検査条件は設定で指定します。検査処理は拡張と一緒に更新されます。");
  replace("clamavDefinitions", "directDefinitions", "FreshClamで定義を更新してから接続を再確認してください。");
  replace("mail341", "directLimitsHelp", "検査上限は設定で指定します。暗号化や上限超過は未検査として案内します。");
}
