import assert from "node:assert/strict";
import { test } from "node:test";
import { filterRecords, resultPage, selectable, canDelete } from "../thunderbird/results.mjs";

const states = ["clean", "detected", "incomplete", "error", "queued", "scanning", "deleted"];
const records = states.map((status, index) => ({ key: String(index), status, sha256: "hash",
  updatedAt: new Date(1000 * index).toISOString(), detail: "details", signatures: ["Test.Signature"],
  locator: { accountId: index % 2 ? "a" : "b", author: "Sender", subject: "件名" + index, folder: { path: "/Inbox" } } }));

test("filters distinguish every status and grouped attention/pending", () => {
  for (const status of states) assert.deepEqual(filterRecords(records, { status }).map(record => record.status), [status]);
  assert.equal(filterRecords(records, { status: "attention" }).length, 3);
  assert.equal(filterRecords(records, { status: "pending" }).length, 2);
});
test("account, state and text filters combine without changing the input", () => {
  assert.deepEqual(filterRecords(records, { account: "a", status: "detected", search: "sender" }).map(record => record.key), ["1"]);
  assert.equal(filterRecords(records, { search: "signature" }).length, 7);
  assert.equal(filterRecords(records, { search: "件名3" }).length, 1);
  assert.equal(filterRecords(records, { search: "/inbox" }).length, 7);
  assert.equal(filterRecords(records, { search: "no match" }).length, 0);
  assert.equal(records[0].key, "0");
  assert.equal(filterRecords(records)[0].key, "6");
});
test("pagination reaches all history and clamps after results shrink", () => {
  const many = Array.from({ length: 121 }, (_, i) => ({ key: i }));
  assert.equal(resultPage(many, 0).records.length, 50);
  assert.equal(resultPage(many, 1).records[0].key, 50);
  assert.equal(resultPage(many, 2).records.length, 21);
  assert.equal(resultPage(many.slice(0, 3), 2).page, 0);
  assert.deepEqual(resultPage([], 9), { records: [], page: 0, pages: 1 });
});
test("selection excludes pending/deleted mail and deletion requires a detection and digest", () => {
  assert.equal(records.filter(selectable).length, 4);
  assert.deepEqual(records.filter(canDelete).map(record => record.status), ["detected"]);
  assert.equal(canDelete({ status: "detected" }), false);
});
