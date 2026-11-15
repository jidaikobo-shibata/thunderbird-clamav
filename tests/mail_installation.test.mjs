import assert from "node:assert/strict";
import { test } from "node:test";
import { compareHelperVersions, helperAction, helperNotice, toolbarNotice } from "../thunderbird/installation.mjs";

test("helper version comparison is numeric and pads missing zero components", () => {
  assert.equal(compareHelperVersions("0.9.10", "0.9.3"), 1);
  assert.equal(compareHelperVersions("0.9.3", "0.9.3.0"), 0);
  assert.equal(compareHelperVersions("0.9", "0.9.1"), -1);
  assert.equal(compareHelperVersions("bad", "0.9.3"), null);
});

test("only necessary update or repair is offered and downgrade is never offered", () => {
  assert.equal(helperAction({ state: "managed", version: "0.9.2", healthy: true }, "0.9.3"), "update");
  assert.equal(helperAction({ state: "managed", version: "0.9.2", healthy: false }, "0.9.3"), "update");
  assert.equal(helperAction({ state: "managed", version: "0.9.3", healthy: false }, "0.9.3"), "repair");
  assert.equal(helperAction({ state: "managed", version: "0.9.3", healthy: true }, "0.9.3"), null);
  assert.equal(helperAction({ state: "managed", version: "0.9.3.0", healthy: true }, "0.9.3"), null);
  assert.equal(helperAction({ state: "managed", version: "0.10.0", healthy: false }, "0.9.3"), null);
  for (const state of ["legacy", "removed", "unavailable"]) {
    assert.equal(helperAction({ state, version: "0.9.2", healthy: false }, "0.9.3"), null);
  }
  assert.equal(helperAction(null, "0.9.3"), null);
});

test("helper notices distinguish connection failure and prioritize mail attention", () => {
  const old = { state: "managed", version: "0.9.2", healthy: true };
  assert.equal(helperNotice(old, "0.9.4").kind, "update");
  assert.equal(toolbarNotice(old, "0.9.4", "", 0).text, "");
  assert.equal(toolbarNotice(old, "0.9.4", "", 0).dot, "update");
  assert.equal(toolbarNotice(old, "0.9.4", "", 0).setup, true);
  assert.equal(toolbarNotice(old, "0.9.4", "", 2).text, "2");
  assert.equal(toolbarNotice(old, "0.9.4", "", 2).setup, false);
  assert.equal(toolbarNotice(old, "0.9.4", "error", 0).setup, false);
  assert.equal(helperNotice({ state: "unavailable" }, "0.9.4").kind, "connection");
  assert.equal(helperNotice({ state: "removed" }, "0.9.4"), null);
  assert.equal(helperNotice({ state: "managed", version: "0.9.4", healthy: true }, "0.9.4"), null);
});

test("ClamAV prerequisite problems lead to setup without claiming the helper is missing", () => {
  const info = { state: "managed", version: "0.15.0", healthy: true, clamavCode: "clamav_missing" };
  const notice = toolbarNotice(info, "0.15.0", "", 0);
  assert.equal(notice.setup, true);
  assert.equal(notice.dot, "attention");
  assert.match(notice.title, /ClamAV/);
  assert.equal(helperNotice({ ...info, clamavCode: "ready" }, "0.15.0"), null);
});
