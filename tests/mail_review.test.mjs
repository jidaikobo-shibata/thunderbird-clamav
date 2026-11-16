import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewReason, isReviewed, reconcileReview } from "../thunderbird/review.mjs";
import { needsAttention } from "../thunderbird/core.mjs";
import { filterRecords } from "../thunderbird/results.mjs";
const record = () => ({ status: "incomplete", sha256: "body-a", detail: "encrypted", signatures: ["Heuristics.Encrypted.Zip"],
  locator: { accountId: "one", subject: "Example" }, updatedAt: "2026-11-16" });
const acknowledge = target => ({ at: "2026-11-16", note: "Known source", reason: reviewReason(target), resultHash: target.sha256 || null,
  fingerprint: target.sha256 ? "sha256:" + target.sha256 : null });

test("reviewed incomplete results keep their verdict but leave attention counts and filters", () => {
  const r = record(); r.review = acknowledge(r);
  assert.equal(isReviewed(r), true);
  assert.equal(needsAttention(r), false);
  assert.equal(r.status, "incomplete");
  assert.equal(filterRecords([r], { status: "attention" }).length, 0);
  assert.equal(filterRecords([r], { status: "reviewed" }).length, 1);
  assert.equal(filterRecords([r], { status: "incomplete" }).length, 1);
  assert.equal(filterRecords([r], { search: "Known source" }).length, 1);
  for (const status of ["detected", "error"]) assert.equal(needsAttention({ ...r, status }), true);
});

test("a rescan preserves acknowledgement only for identical contents and incomplete reasons", () => {
  const r = record(), previous = acknowledge(r);
  reconcileReview(r, previous, "sha256:body-a"); assert.equal(r.review, previous);
  for (const changes of [{ sha256: "body-b" }, { detail: "different reason" }, { signatures: ["Heuristics.Limits.Exceeded"] }, { status: "detected" }, { status: "error" }, { status: "clean" }]) {
    const changed = { ...record(), ...changes, review: previous };
    reconcileReview(changed, previous, changed.sha256 ? "sha256:" + changed.sha256 : null);
    assert.equal(changed.review, undefined);
  }
  reconcileReview(r, previous, null); assert.equal(r.review, undefined);
});

test("semantic reason keys survive localization and signature reordering", () => {
  const r = { ...record(), signatures: ["b", "a"], detailMessages: [{ key: "mail050", text: "日本語" }, { text: "25" }] };
  const old = reviewReason(r);
  r.detailMessages[0].text = "English"; r.detail = "English"; r.signatures.reverse();
  assert.equal(reviewReason(r), old);
  r.detailMessages[1].text = "50"; assert.notEqual(reviewReason(r), old);
});

test("missing scan hashes require a verified full-content fingerprint for rescan retention", () => {
  const r = { ...record(), sha256: null }, previous = { ...acknowledge(r), fingerprint: "chunked-sha256-v1:large-a" };
  reconcileReview(r, previous, previous.fingerprint); assert.equal(isReviewed(r), true);
  reconcileReview(r, previous, "chunked-sha256-v1:large-b"); assert.equal(r.review, undefined);
  reconcileReview(r, { ...previous, fingerprint: null }, null); assert.equal(r.review, undefined);
});
