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

test("indexed names preserve first matches and isolate account/path boundaries", async () => {
  const { createFolderIndex } = await import("../thunderbird/folder-labels.mjs");
  const choices = [{ accountId: "one:/a", path: "/b", displayNames: ["First"] },
    { accountId: "one", path: "/a:/b", displayNames: ["Other"] },
    { accountId: "one:/a", path: "/b", displayNames: ["Duplicate"] }];
  const index = createFolderIndex(choices);
  for (const folder of choices) assert.equal(folderLabel(folder, index), folderLabel(folder, choices));
  assert.equal(folderLabel({ accountId: "missing", path: "/b", name: "Fallback" }, index), "Fallback");
  assert.equal(folderLabel(null, index), "");
});

test("indexed entries reflect name edits and a refreshed index reflects replacement/removal", async () => {
  const { createFolderIndex } = await import("../thunderbird/folder-labels.mjs");
  const folder = { accountId: "one", path: "/Inbox", displayNames: ["Original"] };
  const choices = [folder], index = createFolderIndex(choices);
  folder.displayNames = ["Renamed"];
  assert.equal(folderLabel({ path: "/Inbox" }, index, "one"), "Renamed");
  choices.splice(0, 1, { accountId: "two", path: "/Inbox", displayNames: ["Replacement"] });
  const refreshed = createFolderIndex(choices);
  assert.equal(folderLabel({ path: "/Inbox", name: "Fallback" }, refreshed, "one"), "Fallback");
  assert.equal(folderLabel({ path: "/Inbox" }, refreshed, "two"), "Replacement");
});
