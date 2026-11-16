import { t } from "./i18n.mjs";
export const SCAN_DEFAULTS = Object.freeze({ phishing: "off", macros: "off", pua: "off", mailMiB: 25, expandedMiB: 100, seconds: 60 });
export function scanPolicy(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(SCAN_DEFAULTS, key))) throw new Error(t("scanSettingsInvalid", "検査設定が不正です。"));
  const policy = { ...SCAN_DEFAULTS, ...value };
  if (["phishing", "macros", "pua"].some(key => !["off", "display", "notify"].includes(policy[key])) ||
      [["mailMiB",5,100],["expandedMiB",25,500],["seconds",10,120]].some(([key,min,max]) => !Number.isInteger(policy[key]) || policy[key] < min || policy[key] > max) ||
      policy.expandedMiB < policy.mailMiB) throw new Error(t("scanSettingsInvalid", "検査設定が不正です。"));
  return policy;
}
export const defaultScanPolicy = policy => JSON.stringify(scanPolicy(policy)) === JSON.stringify(SCAN_DEFAULTS);
export const advisoryNotifies = record => (record.advisories || []).some(item => record.scanSettings?.[item.kind] === "notify");
export function policyDescription(value) {
  const p = scanPolicy(value);
  const mode = value => value === "off" ? t("scanModeOff", "検査しない") : value === "notify" ? t("scanModeNotify", "検査して通知する") : t("scanModeDisplay", "検査して結果に表示");
  return t("scanPolicySummary", "メール$1MiB・展開後$2MiB・内部検査$3秒 ／ フィッシング：$4 ／ マクロ：$5 ／ PUA：$6", [p.mailMiB,p.expandedMiB,p.seconds,mode(p.phishing),mode(p.macros),mode(p.pua)]);
}
export function syncScanPolicy(value, force = false) {
  const p = scanPolicy(value);
  for (const key of Object.keys(SCAN_DEFAULTS)) {
    const input = document.getElementById("scan-" + key);
    if (force || document.activeElement !== input) input.value = p[key];
  }
}
export function readScanPolicy() {
  return scanPolicy(Object.fromEntries(Object.keys(SCAN_DEFAULTS).map(key => [key, typeof SCAN_DEFAULTS[key] === "number" ? Number(document.getElementById("scan-" + key).value) : document.getElementById("scan-" + key).value])));
}

export function advisoryDescription(record) {
  const labels = { phishing: t("scanLabelphishing", "フィッシング"), macros: t("scanLabelmacros", "マクロを含む文書"), pua: t("scanLabelpua", "不要な可能性のあるアプリ（PUA）") };
  const found = (record.advisories || []).map(item => labels[item.kind] || item.kind);
  return found.length ? t("scanFindings", "注意情報：$1", [found.join(" / ")]) : "";
}
