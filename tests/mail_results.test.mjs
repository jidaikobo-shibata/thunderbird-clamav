import assert from "node:assert/strict";
import { test } from "node:test";
import { filterRecords, resultPage, selectable, canDelete, canRetry, canForget } from "../thunderbird/results.mjs";

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
test("selection includes terminal history while message deletion excludes deleted entries", () => {
  assert.equal(records.filter(selectable).length, 5);
  assert.deepEqual(records.filter(canDelete).map(record => record.status), ["clean", "detected", "incomplete", "error"]);
  assert.equal(canDelete({ status: "incomplete" }), true);
  assert.equal(canDelete({ status: "unknown" }), false);
});

test("folder job filter combines with account and state without mixing other runs", () => {
  const tagged = records.map((record, i) => ({ ...record, folderJobId: i < 3 ? "job-a" : "job-b" }));
  assert.equal(filterRecords(tagged, { folderJobId: "job-a" }).length, 3);
  assert.deepEqual(filterRecords(tagged, { folderJobId: "job-a", status: "detected", account: "a" }).map(record => record.key), ["1"]);
  assert.equal(filterRecords(tagged, { folderJobId: "unknown" }).length, 0);
});

test("folder searches match displayed Unicode hierarchy and isolate account names", () => {
  const record = { status: "clean", locator: { accountId: "one", folder: { path: "/INBOX/&ZeVnLIqe-", name: "日本語" } } };
  assert.equal(filterRecords([record], { search: "日本語" }).length, 1);
  const folders = [{ accountId: "one", path: record.locator.folder.path, displayNames: ["親の名前", "日本語"] },
    { accountId: "two", path: record.locator.folder.path, displayNames: ["別アカウント"] }];
  assert.equal(filterRecords([record], { search: "親の名前", folders }).length, 1);
  assert.equal(filterRecords([record], { search: "別アカウント", folders }).length, 0);
});

test("excluded automatic mail is reviewable in attention, incomplete and dedicated filters", () => {
  const excluded = { key: "excluded", status: "incomplete", unscannedReason: "automaticExcluded", locator: {} };
  const other = { key: "other", status: "incomplete", locator: {} };
  for (const status of ["attention", "incomplete"]) assert.equal(filterRecords([excluded, other], { status }).length, 2);
  assert.deepEqual(filterRecords([excluded, other], { status: "automatic-excluded" }).map(record => record.key), ["excluded"]);
  assert.equal(selectable(excluded), true);
});

test("shared selection includes deleted history while action eligibility stays separate", () => {
  const deleted = { status: "deleted" }, queued = { status: "queued" };
  assert.equal(selectable(deleted), true);
  assert.equal(canForget(deleted), true);
  assert.equal(canRetry(deleted), false);
  assert.equal(canDelete(deleted), false);
  assert.equal(selectable(queued), false);
  assert.equal(canForget(queued), false);
});

test("repeated history searches reuse the supplied folder index without scanning candidates", async () => {
  const { createFolderIndex } = await import("../thunderbird/folder-labels.mjs");
  let pathReads = 0;
  const folders = Array.from({ length: 5000 }, (_, i) => ({ accountId: "one", get path() { pathReads++; return "/Folder" + i; }, displayNames: ["Parent", "Folder " + i] }));
  const many = Array.from({ length: 1000 }, (_, i) => ({ key: String(i), status: "clean", updatedAt: "2026-11-20T10:00:00Z",
    locator: { accountId: "one", folder: { path: "/Folder4999" } } }));
  const index = createFolderIndex(folders), readsAfterBuild = pathReads;
  assert.equal(readsAfterBuild, 5000);
  for (let i = 0; i < 3; i++) {
    assert.equal(filterRecords(many, { folders: index, search: "parent" }).length, 1000);
    assert.equal(filterRecords(many, { folders: index, search: "missing" }).length, 0);
  }
  assert.equal(pathReads, readsAfterBuild);
  assert.equal(filterRecords(many, { folders, search: "parent" }).length, 1000);
  assert.equal(pathReads, readsAfterBuild + 5000); // Array callers build once per search, never per record.
});

test("quiet encrypted ZIP affects attention only and never hides mixed findings", () => {
  const single = {...records[2], signatures:["Heuristics.Encrypted.Zip"]};
  const mixed = {...single, signatures:[...single.signatures,"Heuristics.Limits.Exceeded.MaxScanSize"]};
  const threat = {...single, status:"detected"};
  const options = {settings:{quietEncryptedZip:true}};
  assert.equal(filterRecords([single], {status:"attention"}).length, 1);
  assert.deepEqual(filterRecords([single,mixed,threat], {...options,status:"attention"}), [mixed,threat]);
  assert.equal(filterRecords([single], {...options,status:"incomplete"}).length, 1);
});
