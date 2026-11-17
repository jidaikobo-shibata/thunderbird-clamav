import assert from "node:assert/strict";
import { test } from "node:test";
import { rememberResult, finishScanAttempt, scanFailed, scanHistoryDescription } from "../thunderbird/scan-history.mjs";
import { filterRecords } from "../thunderbird/results.mjs";

function detected() {
  return { status: "detected", signatures: ["Synthetic.Threat"], sha256: "original", detail: "known threat", locator: {}, updatedAt: "2026-01-01" };
}

test("retrieval failure preserves the known threat and hash without allowing a false clean result", () => {
  const record = detected();
  rememberResult(record);
  Object.assign(record, { status: "error", sha256: null, signatures: [], detail: "retrieval failed" });
  finishScanAttempt(record, null);
  assert.equal(record.status, "detected");
  assert.equal(record.sha256, "original");
  assert.equal(scanFailed(record), true);
  assert.match(scanHistoryDescription(record), /retrieval failed/);
  assert.match(scanHistoryDescription(record), /Synthetic.Threat/);
  assert.equal(filterRecords([record], { status: "detected" }).length, 1);
  assert.equal(filterRecords([record], { status: "error" }).length, 1);
  assert.equal(filterRecords([record], { search: "retrieval failed" }).length, 1);
  record.status = "deleted";
  assert.equal(scanFailed(record), false);
  assert.equal(scanHistoryDescription(record), "");
});

test("an old clean verdict is retained as history but never restored over an error", () => {
  const record = { ...detected(), status: "clean", signatures: [] };
  rememberResult(record);
  Object.assign(record, { status: "error", detail: "failed" });
  finishScanAttempt(record, "original");
  assert.equal(record.status, "error");
  assert.equal(record.lastResult.status, "clean");
  assert.equal(scanFailed(record), true);
});

test("a changed digest cannot reuse a prior detection and new definitive results clear stale attempts", () => {
  const record = detected();
  rememberResult(record);
  Object.assign(record, { status: "error", sha256: "changed", signatures: [], detail: "failed" });
  finishScanAttempt(record, "changed");
  assert.equal(record.status, "error");
  assert.equal(record.lastResult.sha256, "original");
  rememberResult(record);
  assert.equal(record.lastResult.status, "detected");
  Object.assign(record, { status: "clean", detail: "OK" });
  finishScanAttempt(record, "changed");
  assert.equal(record.lastResult, undefined);
  assert.equal(record.lastAttempt, undefined);
});
