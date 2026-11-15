import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { filterRecords } from "../thunderbird/results.mjs";
import { t, uiLanguage, localizeDetail } from "../thunderbird/i18n.mjs";

const catalog = language => JSON.parse(readFileSync(new URL(`../thunderbird/_locales/${language}/messages.json`, import.meta.url)));
const ja = catalog("ja"), en = catalog("en");
function messages(language) {
  const entries = language === "ja" ? ja : en;
  return { getUILanguage: () => language, getMessage(key, values = []) {
    const entry = entries[key];
    if (!entry) return "";
    return entry.message.replace(/\$([A-Z0-9_]+)\$/gi, (match, name) => {
      const content = entry.placeholders?.[name.toLowerCase()]?.content;
      return content?.startsWith("$") ? String(values[Number(content.slice(1)) - 1]) : content || match;
    });
  } };
}

test("Japanese and English catalogs have identical keys and positional arguments", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ja).sort());
  for (const [key, entry] of Object.entries(en)) {
    assert.ok(entry.message.trim(), key);
    assert.doesNotMatch(entry.message, /[\u3040-\u9fff]/, key);
    assert.deepEqual(entry.placeholders, ja[key].placeholders, key);
    const used = [...entry.message.matchAll(/\$([A-Z0-9_]+)\$/gi)].map(match => match[1].toLowerCase()).sort();
    assert.deepEqual(used, Object.keys(entry.placeholders || {}).sort(), key);
  }
});

test("locale selection, positional substitution and English fallback preserve raw values", () => {
  const before = globalThis.messenger;
  try {
    globalThis.messenger = { i18n: messages("en-US") };
    assert.equal(uiLanguage(), "en-US");
    assert.equal(t("mail103", "選択$1件", [3]), "Selected: 3");
    assert.equal(t("mail219", "", ["a$1<img>.pyz"]), "Saved: a$1<img>.pyz. Open this folder in Terminal and run the displayed command.");
    assert.equal(t("missing", "fallback $1", ["raw"]), "fallback raw");
    globalThis.messenger.i18n = messages("ja");
    assert.equal(uiLanguage(), "ja");
    assert.equal(t("mail103", "", [3]), "選択3件");
    globalThis.messenger.i18n = messages("de");
    assert.equal(uiLanguage(), "en-US");
    assert.equal(t("mail103", "", [3]), "Selected: 3");
  } finally { globalThis.messenger = before; }
});

test("new helper detail keys localize without rewriting legacy history or raw engine output", () => {
  const before = globalThis.messenger;
  try {
    globalThis.messenger = { i18n: messages("en-US") };
    const legacy = { detail: "保存済みの説明" };
    assert.equal(localizeDetail(legacy), legacy.detail);
    assert.equal(localizeDetail({ detail: "旧表示", detailMessages: [{ key: "mail375", text: "脅威候補を検出しました。" }, { text: " Eicar-Test-Signature" }] }), "A potential threat was detected. Eicar-Test-Signature");
    const record = { status: "detected", updatedAt: "2026-01-01", locator: {}, detail: "脅威候補を検出しました。",
      detailMessages: [{ key: "mail375", text: "脅威候補を検出しました。" }] };
    assert.equal(filterRecords([record], { search: "potential threat" }).length, 1);
    assert.equal(localizeDetail({ detail: "fallback", detailMessages: [{ key: "untrusted-key", text: "raw" }] }), "fallback");
  } finally { globalThis.messenger = before; }
});
