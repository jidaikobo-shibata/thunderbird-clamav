/** Acknowledgement is separate from the scanner verdict. */
export function reviewReason(record) {
  const detail = Array.isArray(record.detailMessages) && record.detailMessages.length ?
    record.detailMessages.map(part => part.key ? { key: part.key, ...(part.args ? { args: part.args } : {}) } : { text: part.text }) : record.detail || "";
  const reason = [record.unscannedReason || null, detail, [...(record.signatures || [])].sort()];
  if (record.status === "advisory") reason.push("advisory");
  if (record.advisories?.length) reason.push(record.advisories.map(item => [item.kind, [...(item.signatures || [])].sort()]).sort((a,b) => a[0].localeCompare(b[0])));
  return JSON.stringify(reason);
}
export const isReviewed = record => ["incomplete", "advisory"].includes(record.status) && Boolean(record.review) &&
  record.review.reason === reviewReason(record) && record.review.resultHash === (record.sha256 || null);
export const canReview = record => ["incomplete", "advisory"].includes(record.status) && !isReviewed(record);
export const canUnreview = isReviewed;
export const reviewStamp = record => JSON.stringify([record.status, record.sha256 || null, reviewReason(record), record.review || null]);
export function reconcileReview(record, previous, fingerprint) {
  delete record.review;
  delete record.reviewBeforeScan;
  if (["incomplete", "advisory"].includes(record.status) && previous?.fingerprint && fingerprint === previous.fingerprint &&
      previous.reason === reviewReason(record) && previous.resultHash === (record.sha256 || null)) record.review = previous;
}
