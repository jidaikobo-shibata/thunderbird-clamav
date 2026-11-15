import { localizeDetail } from "./i18n.mjs";
import { needsAttention } from "./core.mjs";

export const selectable = record => ["clean", "detected", "incomplete", "error"].includes(record.status);
export const canDelete = record => selectable(record);

export function filterRecords(records, { status = "all", account = "all", search = "", folderJobId = null } = {}) {
  const query = search.trim().toLocaleLowerCase();
  return records.filter(record => {
    if (folderJobId && record.folderJobId !== folderJobId) return false;
    if (status === "attention" && !needsAttention(record)) return false;
    if (status === "pending" && !["queued", "scanning"].includes(record.status)) return false;
    if (!["all", "attention", "pending"].includes(status) && record.status !== status) return false;
    if (account !== "all" && record.locator.accountId !== account) return false;
    if (query && ![record.locator.author, record.locator.subject, record.locator.folder?.path,
      localizeDetail(record), ...(record.signatures || [])].join("\n").toLocaleLowerCase().includes(query)) return false;
    return true;
  }).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export function resultPage(records, page, size = 50) {
  const pages = Math.max(1, Math.ceil(records.length / size));
  const current = Math.min(Math.max(0, page), pages - 1);
  return { records: records.slice(current * size, (current + 1) * size), page: current, pages };
}
