import { t, uiLanguage } from "./i18n.mjs";
import { bytesToBase64 } from "./core.mjs";

export function compareHelperVersions(left, right) {
  const valid = value => typeof value === "string" && /^[0-9]+(?:\.[0-9]+){1,3}$/.test(value);
  if (!valid(left) || !valid(right)) return null;
  const a = left.split(".").map(BigInt), b = right.split(".").map(BigInt);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0n) > (b[i] || 0n)) return 1;
    if ((a[i] || 0n) < (b[i] || 0n)) return -1;
  }
  return 0;
}

export function helperAction(info, bundledVersion) {
  if (info?.state !== "managed") return null;
  const compared = compareHelperVersions(info.version, bundledVersion);
  if (compared === -1) return "update";
  if (compared === 0 && info.healthy === false) return "repair";
  return null;
}

export function helperNotice(info, version) {
  const action = helperAction(info, version);
  if (action === "update") return { kind: "update", badge: t("mail199", "更新"), label: t("mail200", "更新あり"), message: t("mail201", "補助プログラムの更新があります。"), button: t("mail202", "更新を確認") };
  if (action === "repair" || info?.state === "managed" && info.healthy === false)
    return { kind: "repair", badge: "!", label: t("mail203", "要対応"), message: t("mail204", "補助プログラムの修復が必要です。"), button: t("mail205", "修復を確認") };
  if (info?.state === "legacy") return { kind: "update", badge: t("mail199", "更新"), label: t("mail200", "更新あり"), message: t("mail206", "補助プログラムの管理機能を利用するには更新が必要です。"), button: t("mail202", "更新を確認") };
  if (info?.state === "unavailable") return { kind: "connection", badge: "!", label: t("mail207", "接続確認"), message: t("mail208", "補助プログラムに接続できません。導入状態を確認してください。"), button: t("mail209", "セットアップを開く") };
  return null;
}

export function toolbarNotice(info, version, issue, count) {
  const notice = helperNotice(info, version);
  if (count) return { text: String(count), color: "#9d281b", title: t("mail210", "ClamAV メール検査：確認が必要なメール$1件", [count]), setup: false };
  if (issue) return { text: "!", color: "#9d281b", title: t("mail211", "ClamAV メール検査：") + issue, setup: false };
  return { text: "", dot: notice ? notice.kind === "update" ? "update" : "attention" : null, color: notice?.kind === "update" ? "#285b8f" : "#9d281b",
    title: notice ? t("mail211", "ClamAV メール検査：") + notice.message : t("mail212", "ClamAV メール検査"), setup: Boolean(notice) };
}

export function installationUI({ request, action, latest, busy }) {
  const $ = id => document.getElementById(id);
  const version = messenger.runtime.getManifest().version;
  const filename = `clam-mail-check-installer-${version}.pyz`;
  let savedName = filename, saving = false, uninstallStarted = false;
  const quote = value => /^[a-zA-Z0-9._/-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const command = operation => `python3 -I ${quote("./" + savedName)} ${operation} --language ${uiLanguage()}`;
  function updateCommands() {
    $("installer-command").textContent = command("install");
    $("uninstaller-command").textContent = command("uninstall");
  }
  updateCommands();
  function completedDownload(id) {
    return new Promise((resolve, reject) => {
      let finished = false;
      const cleanup = () => { finished = true; clearTimeout(timer); messenger.downloads.onChanged.removeListener(changed); };
      const check = async () => {
        try {
          const item = (await messenger.downloads.search({ id }))[0];
          if (finished) return;
          if (!item || item.state === "interrupted") {
            cleanup(); reject(new Error(t("mail213", "保存が中止されたか、完了できませんでした。")));
          } else if (item.state === "complete") { cleanup(); resolve(item); }
        } catch (error) { if (!finished) { cleanup(); reject(error); } }
      };
      const changed = delta => { if (delta.id === id) void check(); };
      const timer = setTimeout(() => {
        cleanup();
        void messenger.downloads.cancel(id).catch(() => {});
        reject(new Error(t("mail214", "保存の完了を確認できませんでした。もう一度お試しください。")));
      }, 120000);
      messenger.downloads.onChanged.addListener(changed);
      void check();
    });
  }
  async function saveInstaller(reportId) {
    if (saving || busy()) return;
    const report = $(reportId);
    saving = true; render();
    let url;
    try {
      // Request immediately from the user's click; never during page load.
      const granted = await messenger.permissions.request({ permissions: ["downloads"] });
      if (!granted) {
        report.textContent = t("mail215", "ファイル保存が許可されなかったため、保存していません。保存ボタンから再度許可できます。");
        return;
      }
      report.textContent = t("mail216", "保存先を選択してください。ファイルの保存だけで設置や削除は行いません。");
      const response = await fetch(messenger.runtime.getURL("installer.pyz"));
      if (!response.ok) throw new Error(t("mail217", "同梱の導入用ファイルを読み取れません。"));
      url = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: "application/octet-stream" }));
      const id = await messenger.downloads.download({ url, filename, saveAs: true, conflictAction: "uniquify" });
      report.textContent = t("mail218", "ファイルを保存しています。");
      const item = await completedDownload(id);
      savedName = item.filename.split("/").at(-1);
      updateCommands();
      report.textContent = t("mail219", "保存しました：$1。この保存先のフォルダーをTerminalで開いて、表示されたコマンドを実行してください。", [item.filename]);
    } catch (error) {
      report.textContent = t("mail220", "保存できませんでした。保存画面を中止した場合は変更ありません。再試行できます。 ") + error.message;
    } finally {
      if (url) URL.revokeObjectURL(url);
      saving = false; render();
    }
  }
  $("installer-download").addEventListener("click", () => { void saveInstaller("installation-report"); });
  $("uninstall-download").addEventListener("click", () => { void saveInstaller("uninstall-report"); });
  for (const [id, operation] of [["copy-install", "install"], ["copy-uninstall", "uninstall"]]) {
    $(id).addEventListener("click", () => {
      const report = $(operation === "uninstall" ? "uninstall-report" : "installation-report");
      void navigator.clipboard.writeText(command(operation)).then(() => {
        report.textContent = t("mail221", "コマンドをコピーしました。保存先のフォルダーのTerminalで実行してください。");
      }).catch(() => { report.textContent = t("mail222", "コピーできませんでした。表示されたコマンドを選択してコピーしてください。"); });
    });
  }
  function render() {
    const state = latest(), info = state?.installation, locked = busy() || state?.maintenance || saving;
    for (const id of ["installer-download", "uninstall-download"]) $(id).disabled = Boolean(locked);
    const working = state?.batch?.active || state?.folderJob && ["collecting", "running", "stopping"].includes(state.folderJob.status) || state?.records.some(record => record.status === "scanning");
    $("installation-status").textContent = !info ? t("mail223", "まだ確認していません。「導入を確認」を押してください。") :
      info.state === "managed" ? t("mail224", "導入済み：$1 ／ $2", [info.version, info.healthy ? t("mail225", "設置ファイルは一致しています") : t("mail226", "修復が必要です")]) :
      info.state === "legacy" ? t("mail227", "既存の補助プログラムは管理機能に未対応です。Terminalで更新・修復または削除できます。") :
      info.state === "removed" ? t("mail228", "補助プログラムを削除済みです。拡張の削除を続けられます。") :
      t("mail229", "補助プログラムに接続できません。同梱ファイルで導入・修復し、「導入を確認」を押してください。");
    $("helper-check").disabled = Boolean(locked);
    const needed = helperAction(info, version);
    $("helper-update").hidden = !needed;
    $("helper-update").textContent = needed === "repair" ? t("mail230", "補助プログラムを修復") : t("mail231", "補助プログラムを更新");
    $("helper-update").disabled = Boolean(locked || working || !needed);
    $("helper-action-hint").textContent = needed === "update" ? t("mail232", "同梱の補助プログラム$1へ更新できます。", [version]) :
      needed === "repair" ? t("mail233", "設置ファイルに不整合があるため、修復が必要です。") :
      info?.state === "managed" && compareHelperVersions(info.version, version) === 1 ?
        t("mail234", "導入済みの版が同梱版より新しいため、この同梱版で更新・修復は行いません。修復には同じ版か新しい版の導入用ファイルを使ってください。") :
      info?.state === "managed" && info.healthy === true ? t("mail235", "更新・修復は不要です。") : "";
    $("uninstall-start").disabled = Boolean(locked || working);
    $("uninstall-steps").hidden = !uninstallStarted;
    $("helper-uninstall").hidden = !uninstallStarted || info?.state !== "managed";
    $("helper-uninstall").disabled = Boolean(locked || working || info?.state !== "managed");
    $("cli-uninstall-guide").hidden = !uninstallStarted || ["managed", "removed"].includes(info?.state);
    $("uninstall-status").textContent = info?.state === "managed" ? t("mail236", "画面内で補助プログラムを削除できます。次のボタンから対象を確認してください。") :
      info?.state === "removed" ? t("mail237", "補助プログラムの削除を確認済みです。拡張の削除を続けられます。") : t("mail238", "補助プログラムの削除には、次のTerminalの手順が必要です。");
    $("remove-extension").hidden = !uninstallStarted || info?.state !== "removed";
    $("remove-extension").disabled = Boolean(locked || working);
    $("manual-uninstall-ack").disabled = Boolean(locked || working);
    $("finish-manual-uninstall").disabled = Boolean(locked || working || !$("manual-uninstall-ack").checked);
  }
  async function removeExtension() {
    try {
      await messenger.management.uninstallSelf({ showConfirmDialog: true,
        dialogMessage: t("mail239", "ClamAV Mail Checkを削除します。設定・検査履歴・再開情報は失われる可能性があります。メールとClamAVは残ります。") });
    } catch {
      $("uninstall-report").textContent = t("mail240", "拡張の削除は完了していません。削除を取り消した場合はこのまま残り、「拡張の削除を続ける」で再試行できます。再利用には同梱ファイルで補助プログラムを導入してください。");
    }
  }
  function confirmPlan(plan, needed) {
    const removing = plan.operation === "uninstall", dialog = $("helper-dialog");
    $("helper-dialog-title").textContent = removing ? t("mail241", "アンインストール") : needed === "repair" ? t("mail230", "補助プログラムを修復") : t("mail231", "補助プログラムを更新");
    $("helper-dialog-detail").textContent = removing ?
      t("mail242", "次の場所の管理対象ファイルと接続登録を削除し、続いてThunderbirdの確認画面で拡張を削除します。設定・検査履歴・再開情報は失われる可能性があります。メール・アカウント・ClamAVは残ります。補助プログラムはこのOSユーザーで共通のため、他のThunderbirdプロファイルも接続できなくなります。変更されたファイルは残して表示します。再導入する場合は、先に導入用ファイルを保存してください。") :
      t("mail243", "$1メール・設定・検査履歴は残します。次の場所の管理対象ファイルと接続登録を変更します。", [needed === "repair" ? t("mail244", "補助プログラム$1の設置ファイルを修復します。", [plan.version]) : t("mail245", "補助プログラムを同梱の$1へ更新します。", [plan.version])]);
    $("helper-paths").replaceChildren();
    for (const path of plan.paths) { const li = document.createElement("li"); li.textContent = path; $("helper-paths").append(li); }
    $("helper-ack").checked = false; $("helper-confirm").disabled = true;
    dialog.returnValue = "cancel";
    return new Promise(resolve => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "apply" && $("helper-ack").checked), { once: true });
      dialog.showModal(); $("helper-cancel").focus();
    });
  }
  $("helper-ack").addEventListener("change", () => { $("helper-confirm").disabled = !$("helper-ack").checked; });
  for (const [id, operation] of [["helper-update", "repair"], ["helper-uninstall", "uninstall"]]) {
    $(id).addEventListener("click", () => {
      const needed = helperAction(latest()?.installation, version);
      if (operation === "repair" && !needed) return;
      void action(async () => {
        let packageData;
        if (operation === "repair") {
          const response = await fetch(messenger.runtime.getURL("installer.pyz"));
          if (!response.ok) throw new Error(t("mail217", "同梱の導入用ファイルを読み取れません。"));
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.length > 80 * 1024) throw new Error(t("mail246", "導入用ファイルのサイズが上限を超えています。"));
          packageData = bytesToBase64(bytes);
        }
        const { plan } = await request("helperPlan", { operation, package: packageData });
        let applied = false;
        try {
          if (!await confirmPlan(plan, needed)) return t("mail247", "管理操作をキャンセルしました。");
          const response = await request("helperApply", { token: plan.token });
          applied = true;
          const retained = response.installation.retained || [];
          $(operation === "uninstall" ? "uninstall-report" : "installation-report").textContent = response.installation.detail + (retained.length ? t("mail248", " 残したファイル：") + retained.join(t("listSeparator", " ／ ")) : "");
          if (operation === "uninstall") await removeExtension();
          return response.installation.detail;
        } finally { if (!applied) await request("helperCancel", { token: plan.token }); }
      });
    });
  }
  $("uninstall-start").addEventListener("click", () => {
    void action(async () => {
      const response = await request("helperInfo");
      latest().installation = response.installation;
      uninstallStarted = true;
      render();
      return t("mail249", "導入状態に応じた削除手順を表示しました。まだ削除は行っていません。");
    });
  });
  $("helper-check").addEventListener("click", () => { void action(() => request("helperInfo"), t("mail250", "導入状態を確認しました。")); });
  $("manual-uninstall-ack").addEventListener("change", render);
  $("finish-manual-uninstall").addEventListener("click", () => {
    void action(async () => {
      await request("helperMarkRemoved", { acknowledged: $("manual-uninstall-ack").checked });
      await removeExtension();
      return t("mail251", "補助プログラムの削除完了を確認しました。");
    });
  });
  $("remove-extension").addEventListener("click", () => { void action(removeExtension); });
  return { render };
}
