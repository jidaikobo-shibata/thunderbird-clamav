/** Acknowledgement is separate from the scanner verdict. */
export function reviewReason(record) {
  const detail = Array.isArray(record.detailMessages) && record.detailMessages.length ?
    record.detailMessages.map(part => part.key ? { key: part.key, ...(part.args ? { args: part.args } : {}) } : { text: part.text }) : record.detail || "";
  return JSON.stringify([record.unscannedReason || null, detail, [...(record.signatures || [])].sort()]);
}
export const isReviewed = record => record.status === "incomplete" && Boolean(record.review) &&
  record.review.reason === reviewReason(record) && record.review.resultHash === (record.sha256 || null);
export const canReview = record => record.status === "incomplete" && !isReviewed(record);
export const canUnreview = isReviewed;
export const reviewStamp = record => JSON.stringify([record.status, record.sha256 || null, reviewReason(record), record.review || null]);
export function reconcileReview(record, previous, fingerprint) {
  delete record.review;
  delete record.reviewBeforeScan;
  if (record.status === "incomplete" && previous?.fingerprint && fingerprint === previous.fingerprint &&
      previous.reason === reviewReason(record) && previous.resultHash === (record.sha256 || null)) record.review = previous;
}
