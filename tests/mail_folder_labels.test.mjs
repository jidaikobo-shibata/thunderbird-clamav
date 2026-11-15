import assert from "node:assert/strict";
import { test } from "node:test";
import { folderLabel } from "../thunderbird/folder-labels.mjs";

test("encoded IMAP paths display Unicode names and preserve hierarchy and identity", () => {
  const folder = { id: "opaque", accountId: "one", path: "/INBOX/&ZeVnLIqe-", name: "日本語", displayNames: ["受信トレイ", "取引先/資料", "日本語"] };
  assert.equal(folderLabel(folder), "受信トレイ › 取引先/資料 › 日本語");
  assert.equal(folder.path, "/INBOX/&ZeVnLIqe-");
  const legacy = { path: folder.path };
  assert.equal(folderLabel(legacy, [folder], "one"), "受信トレイ › 取引先/資料 › 日本語");
  assert.equal(folderLabel({ ...folder, displayNames: undefined }, [], "one"), "日本語");
});

test("identical paths across accounts never borrow another account's name", () => {
  const choices = [{ accountId: "one", path: "/INBOX", displayNames: ["一方"] },
    { accountId: "two", path: "/INBOX", displayNames: ["もう一方"] }];
  assert.equal(folderLabel({ path: "/INBOX" }, choices, "two"), "もう一方");
  assert.equal(folderLabel({ path: "/INBOX", name: "元の名前" }, choices, "missing"), "元の名前");
  assert.equal(folderLabel(null, choices), "");
});
