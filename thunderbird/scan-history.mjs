import { LABELS } from "./core.mjs";
import { t, localizeDetail } from "./i18n.mjs";

const fields = ["status", "detail", "detailMessages", "signatures", "advisories", "sha256", "engine", "scanSettings", "updatedAt", "unscannedReason"];
function snapshot(record) {
  return structuredClone(Object.fromEntries(fields.filter(key => record[key] !== undefined).map(key => [key, record[key]])));
}

/** Persist the verdict before replacing it with queued/scanning state. */
export function rememberResult(record) {
  if (!record.lastResult && ["clean", "detected", "incomplete", "advisory"].includes(record.status)) record.lastResult = snapshot(record);
}

/** A failed/partial rescan cannot retract a known detection of the same bytes. */
export function finishScanAttempt(record, digest) {
  const previous = record.lastResult;
  const failed = record.status === "error" || record.status === "incomplete" && previous?.status === "detected";
  if (!failed) {
    delete record.lastResult;
    delete record.lastAttempt;
    return;
  }
  if (!previous) { delete record.lastAttempt; return; }
  record.lastAttempt = { ...snapshot(record), checkedAt: new Date().toISOString() };
  if (previous?.status === "detected" && (!digest || previous.sha256 === digest)) {
    // When raw retrieval failed, keep the old hash. Destructive operations still
    // verify the actual bytes against it, and cannot act on a changed message.
    for (const key of fields) delete record[key];
    Object.assign(record, structuredClone(previous));
  }
}

/** Merge an independently known detection into a newer, unfinished attempt. */
export function retainKnownDetection(record, known, digest) {
  if (!["error", "incomplete"].includes(record.status) || known.status !== "detected" ||
      !digest || record.sha256 !== digest || known.sha256 !== digest) return false;
  record.lastResult = snapshot(known);
  finishScanAttempt(record, digest);
  return true;
}

export const scanFailed = record => !["queued", "scanning", "deleted"].includes(record.status) &&
  (record.status === "error" || record.lastAttempt?.status === "error");

export function scanHistoryDescription(record) {
  if (!record.lastAttempt || ["queued", "scanning", "deleted"].includes(record.status)) return "";
  const previous = record.lastResult;
  const parts = [];
  if (previous) parts.push(t("rescanPrevious", "前回の結果：$1（$2）。", [LABELS[previous.status] || previous.status,
    [localizeDetail(previous), ...(previous.signatures || [])].filter(Boolean).join(" / ")]));
  parts.push(t("rescanFailure", "今回の再検査：$1", [localizeDetail(record.lastAttempt)]));
  return parts.join(" ");
}
