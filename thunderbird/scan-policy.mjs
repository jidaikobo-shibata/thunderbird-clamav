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
  const value = {}, fields = [];
  const labels = { phishing: t("scanLabelphishing", "フィッシング"), macros: t("scanLabelmacros", "マクロを含む文書"), pua: t("scanLabelpua", "不要な可能性のあるアプリ（PUA）"),
    mailMiB: t("scanFieldMail", "メール全体の上限"), expandedMiB: t("scanFieldExpanded", "展開後の検査量上限"), seconds: t("scanFieldSeconds", "ClamAV内部の検査時間上限") };
  for (const key of Object.keys(SCAN_DEFAULTS)) {
    const raw = document.getElementById("scan-" + key).value;
    value[key] = typeof SCAN_DEFAULTS[key] === "number" ? Number(raw) : raw;
  }
  for (const [key, min, max] of [["mailMiB",5,100],["expandedMiB",25,500],["seconds",10,120]]) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) fields.push({ key,
      message: t("scanRangeError", "$1は$2〜$3の整数で入力してください。", [labels[key], min, max]) });
  }
  for (const key of ["phishing", "macros", "pua"]) if (!["off", "display", "notify"].includes(value[key])) fields.push({ key,
    message: t("scanChoiceError", "$1の選択肢を選び直してください。", [labels[key]]) });
  if (!fields.some(field => ["mailMiB", "expandedMiB"].includes(field.key)) && value.expandedMiB < value.mailMiB) fields.push({ key: "expandedMiB",
    message: t("scanExpandedError", "展開後の検査量上限は、メール全体の上限（$1MiB）以上にしてください。", [value.mailMiB]) });
  if (fields.length) throw Object.assign(new Error(fields.map(field => field.message).join(" ")), { fields });
  return scanPolicy(value);
}

export function advisoryDescription(record) {
  const labels = { phishing: t("scanLabelphishing", "フィッシング"), macros: t("scanLabelmacros", "マクロを含む文書"), pua: t("scanLabelpua", "不要な可能性のあるアプリ（PUA）") };
  const found = (record.advisories || []).map(item => labels[item.kind] || item.kind);
  return found.length ? t("scanFindings", "注意情報：$1", [found.join(" / ")]) : "";
}
