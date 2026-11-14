import { bytesToBase64 } from "./core.mjs";

export function installationUI({ request, action, latest, busy }) {
  const $ = id => document.getElementById(id);
  const version = messenger.runtime.getManifest().version;
  const filename = `clam-mail-check-installer-${version}.pyz`;
  const command = operation => `python3 -I ./${filename} ${operation}`;
  let uninstallStarted = false;
  for (const id of ["installer-download", "uninstall-download"]) {
    $(id).href = messenger.runtime.getURL("installer.pyz");
    $(id).download = filename;
  }
  $("installer-command").textContent = command("install");
  $("uninstaller-command").textContent = command("uninstall");
  for (const [id, operation] of [["copy-install", "install"], ["copy-uninstall", "uninstall"]]) {
    $(id).addEventListener("click", () => {
      const report = $(operation === "uninstall" ? "uninstall-report" : "installation-report");
      void navigator.clipboard.writeText(command(operation)).then(() => {
        report.textContent = "コマンドをコピーしました。保存先のフォルダーのTerminalで実行してください。";
      }).catch(() => { report.textContent = "コピーできませんでした。表示されたコマンドを選択してコピーしてください。"; });
    });
  }
  function render() {
    const state = latest(), info = state?.installation, locked = busy() || state?.maintenance;
    const working = state?.batch?.active || state?.folderJob && ["collecting", "running", "stopping"].includes(state.folderJob.status) || state?.records.some(record => record.status === "scanning");
    $("installation-status").textContent = !info ? "まだ確認していません。「導入を確認」を押してください。" :
      info.state === "managed" ? `導入済み：${info.version} ／ ${info.healthy ? "設置ファイルは一致しています" : "修復が必要です"}` :
      info.state === "legacy" ? "既存の補助プログラムは管理機能に未対応です。Terminalで更新・修復または削除できます。" :
      info.state === "removed" ? "補助プログラムを削除済みです。拡張の削除を続けられます。" :
      "補助プログラムに接続できません。同梱ファイルで導入・修復し、「導入を確認」を押してください。";
    $("helper-check").disabled = Boolean(locked);
    $("helper-update").disabled = Boolean(locked || working || info?.state !== "managed");
    $("uninstall-start").disabled = Boolean(locked || working);
    $("uninstall-steps").hidden = !uninstallStarted;
    $("helper-uninstall").hidden = !uninstallStarted || info?.state !== "managed";
    $("helper-uninstall").disabled = Boolean(locked || working || info?.state !== "managed");
    $("cli-uninstall-guide").hidden = !uninstallStarted || ["managed", "removed"].includes(info?.state);
    $("uninstall-status").textContent = info?.state === "managed" ? "画面内で補助プログラムを削除できます。次のボタンから対象を確認してください。" :
      info?.state === "removed" ? "補助プログラムの削除を確認済みです。拡張の削除を続けられます。" : "補助プログラムの削除には、次のTerminalの手順が必要です。";
    $("remove-extension").hidden = !uninstallStarted || info?.state !== "removed";
    $("remove-extension").disabled = Boolean(locked || working);
    $("manual-uninstall-ack").disabled = Boolean(locked || working);
    $("finish-manual-uninstall").disabled = Boolean(locked || working || !$("manual-uninstall-ack").checked);
  }
  async function removeExtension() {
    try {
      await messenger.management.uninstallSelf({ showConfirmDialog: true,
        dialogMessage: "ClamAV Mail Checkを削除します。設定・検査履歴・再開情報は失われる可能性があります。メールとClamAVは残ります。" });
    } catch {
      $("uninstall-report").textContent = "拡張の削除は完了していません。削除を取り消した場合はこのまま残り、「拡張の削除を続ける」で再試行できます。再利用には同梱ファイルで補助プログラムを導入してください。";
    }
  }
  function confirmPlan(plan) {
    const removing = plan.operation === "uninstall", dialog = $("helper-dialog");
    $("helper-dialog-title").textContent = removing ? "アンインストール" : "補助プログラムを更新・修復";
    $("helper-dialog-detail").textContent = removing ?
      "次の場所の管理対象ファイルと接続登録を削除し、続いてThunderbirdの確認画面で拡張を削除します。設定・検査履歴・再開情報は失われる可能性があります。メール・アカウント・ClamAVは残ります。補助プログラムはこのOSユーザーで共通のため、他のThunderbirdプロファイルも接続できなくなります。変更されたファイルは残して表示します。再導入する場合は、先に導入用ファイルを保存してください。" :
      `補助プログラムを同梱の${plan.version}へ更新・修復します。メール・設定・検査履歴は残します。次の場所の管理対象ファイルと接続登録を変更します。`;
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
      void action(async () => {
        let packageData;
        if (operation === "repair") {
          const response = await fetch(messenger.runtime.getURL("installer.pyz"));
          if (!response.ok) throw new Error("同梱の導入用ファイルを読み取れません。");
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.length > 80 * 1024) throw new Error("導入用ファイルのサイズが上限を超えています。");
          packageData = bytesToBase64(bytes);
        }
        const { plan } = await request("helperPlan", { operation, package: packageData });
        let applied = false;
        try {
          if (!await confirmPlan(plan)) return "管理操作をキャンセルしました。";
          const response = await request("helperApply", { token: plan.token });
          applied = true;
          const retained = response.installation.retained || [];
          $(operation === "uninstall" ? "uninstall-report" : "installation-report").textContent = response.installation.detail + (retained.length ? " 残したファイル：" + retained.join(" ／ ") : "");
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
      return "導入状態に応じた削除手順を表示しました。まだ削除は行っていません。";
    });
  });
  $("helper-check").addEventListener("click", () => { void action(() => request("helperInfo"), "導入状態を確認しました。"); });
  $("manual-uninstall-ack").addEventListener("change", render);
  $("finish-manual-uninstall").addEventListener("click", () => {
    void action(async () => {
      await request("helperMarkRemoved", { acknowledged: $("manual-uninstall-ack").checked });
      await removeExtension();
      return "補助プログラムの削除完了を確認しました。";
    });
  });
  $("remove-extension").addEventListener("click", () => { void action(removeExtension); });
  return { render };
}
