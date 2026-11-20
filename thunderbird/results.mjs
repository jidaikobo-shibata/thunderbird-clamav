import { scanHistoryDescription, scanFailed } from "./scan-history.mjs";
import { advisoryDescription } from "./scan-policy.mjs";
import { isReviewed } from "./review.mjs";
import { createFolderIndex, folderLabel } from "./folder-labels.mjs";
import { localizeDetail } from "./i18n.mjs";
import { needsAttention } from "./core.mjs";

export const canRetry = record => ["clean", "detected", "incomplete", "error", "advisory"].includes(record.status);
export const canDelete = canRetry;
export const canForget = record => canRetry(record) || record.status === "deleted";
export const selectable = canForget;

export function filterRecords(records, { status = "all", account = "all", search = "", folderJobId = null, folders = [] } = {}) {
  const query = search.trim().toLocaleLowerCase();
  const folderNames = query && !(folders instanceof Map) ? createFolderIndex(folders) : folders;
  return records.filter(record => {
    if (folderJobId && record.folderJobId !== folderJobId) return false;
    if (status === "reviewed" && !isReviewed(record)) return false;
    if (status === "attention" && !needsAttention(record)) return false;
    if (status === "automatic-excluded" && !(record.status === "incomplete" && record.unscannedReason === "automaticExcluded")) return false;
    if (status === "pending" && !["queued", "scanning"].includes(record.status)) return false;
    if (!["all", "attention", "pending", "automatic-excluded", "reviewed"].includes(status) && record.status !== status && !(status === "error" && scanFailed(record))) return false;
    if (account !== "all" && record.locator.accountId !== account) return false;
    if (query && ![record.locator.author, record.locator.subject, record.locator.folder?.path, folderLabel(record.locator.folder, folderNames, record.locator.accountId),
      localizeDetail(record), scanHistoryDescription(record), advisoryDescription(record), record.review?.note || "", ...(record.signatures || [])].join("\n").toLocaleLowerCase().includes(query)) return false;
    return true;
  }).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export function resultPage(records, page, size = 50) {
  const pages = Math.max(1, Math.ceil(records.length / size));
  const current = Math.min(Math.max(0, page), pages - 1);
  return { records: records.slice(current * size, (current + 1) * size), page: current, pages };
}
