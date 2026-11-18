import { t } from "./i18n.mjs";

/** Protocol compatibility is required for scanning, beyond a version response. */
export const scannerReady = health => health?.status === "ready" && health.protocol === 1;

/** Preserve the distinction between an absent engine and a failed transport. */
export async function readScannerHealth(client, direct) {
  try {
    return { ...await client.request("health"), checkedAt: new Date().toISOString() };
  } catch (error) {
    if (direct) return { status: "error", code: "direct_unavailable", checkedAt: new Date().toISOString(), detail: t("directUnavailable", "内蔵の検査処理を開始できません。設定で状態を確認してください。") + " " + String(error.message).slice(0, 300) };
    return { status: "error", code: "helper_unavailable", checkedAt: new Date().toISOString(),
      detail: t("helperClamavUnknown", "補助プログラムに接続できないため、ClamAVの有無はまだ確認できません。補助プログラムの導入・接続を確認してください。") };
  }
}

/** Update the existing installation object without changing lifecycle ownership. */
export function applyScannerHealth(installation, health, direct) {
  if (!installation || installation.state === "removed") return;
  if (direct) { installation.state = "integrated"; installation.healthy = health.status === "ready"; installation.detail = health.detail; }
  installation.clamavCode = health.status === "ready" ? "ready" : health.code || "unconfirmed";
  if (health.code === "helper_unavailable") installation.state = "unavailable";
}
