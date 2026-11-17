import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source = await readFile(new URL("../experiments/direct-runtime/api.js", import.meta.url), "utf8");
function api() {
  class ExtensionError extends Error {}
  let removals = 0;
  const sandbox = { TextEncoder, TextDecoder, Cu: { importGlobalProperties() {} },
    ChromeUtils: { importESModule(name) {
      if (name.includes("ExtensionCommon")) return { ExtensionCommon: { ExtensionAPI: class {} } };
      if (name.includes("ExtensionUtils")) return { ExtensionUtils: { ExtensionError } };
      if (name.includes("Subprocess")) return { Subprocess: { call() { throw Error("must not spawn"); } } };
      if (name.includes("NetUtil")) return { NetUtil: {} };
      return { setTimeout, clearTimeout };
    } },
    Cc: { "@mozilla.org/file/local;1": { createInstance: () => ({initWithPath() {}, append() {}}) } }, Ci: { nsIFile: {} },
    Services: {uuid: {generateUUID: () => "fixed-uuid"}},
    IOUtils: {exists: async () => false, remove: async () => { removals++; }}
  };
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  const instance = new sandbox.clamDirect();
  return { instance, exposed: instance.getAPI({extension:{}}).clamDirect, ExtensionError, removals: () => removals };
}
test("missing Python is reported to the caller and never deletes an uncreated runtime", async () => {
  const value = api();
  await assert.rejects(value.exposed.open(), error => error instanceof value.ExtensionError && /Python3/.test(error.message));
  assert.equal(value.removals(), 0);
});
test("direct transport refuses administration operations before touching a process", async () => {
  const value = api(); value.instance.sessions.set("test", {pending:0});
  await assert.rejects(value.exposed.request("test", JSON.stringify({id:"1",op:"manageApply",token:"fake"})), /Unsupported scanner request/);
  assert.equal(value.instance.sessions.get("test").pending, 0);
});
test("direct transport rejects oversized requests before decoding or writing them", async () => {
  const value = api(); value.instance.sessions.set("test", {pending:0});
  await assert.rejects(value.exposed.request("test", "x".repeat(131073)), /frame too large/);
  assert.equal(value.instance.sessions.get("test").pending, 0);
});
