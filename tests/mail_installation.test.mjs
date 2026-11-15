import assert from "node:assert/strict";
import { test } from "node:test";
import { compareHelperVersions, helperAction } from "../thunderbird/installation.mjs";

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
