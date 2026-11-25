import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";
const source = await readFile(new URL("../experiments/direct-runtime/api.js", import.meta.url), "utf8");
function api(os = "Linux", script = source) {
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
    Services: {appinfo: {OS: os, XPCOMABI: os === "WINNT" ? "x86_64-msvc" : "aarch64-gcc3"}, dirsvc: {get: () => ({path:"C:\\Private"})}, uuid: {generateUUID: () => "fixed-uuid"}},
    IOUtils: {exists: async () => false, remove: async () => { removals++; }}
  };
  vm.createContext(sandbox); vm.runInContext(script, sandbox);
  const instance = new sandbox.clamDirect();
  return { instance, sandbox, exposed: instance.getAPI({extension:{}}).clamDirect, ExtensionError, removals: () => removals };
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

function macPython({badOwner = false, badMode = false, version = [3, 14], link = false} = {}) {
  const value = api("Darwin"), commands = [];
  value.sandbox.IOUtils.exists = async name => name === "/opt/homebrew/bin/python3";
  value.sandbox.Cc["@mozilla.org/file/local;1"].createInstance = () => ({
    initWithPath(name) { this.path = name; },
    normalize() { this.path = path.posix.normalize(this.path); },
    isSymlink() { return this.path === "/opt/homebrew/bin/python3"; },
    get target() { return link ? "/tmp/untrusted-python" : "/opt/homebrew/Cellar/python@3.14/3.14.8/bin/python3.14"; }, isFile: () => true, isExecutable: () => true
  });
  value.instance.smallCommand = async (command, args) => {
    commands.push({command, args});
    if (command === "/usr/bin/id") return "502";
    if (command === "/usr/bin/stat") return args.slice(2).map(name =>
      `${badOwner ? "999" : "502"}:80:${badMode || name === "/tmp" ? "777" : "755"}`).join("\n");
    return JSON.stringify(version);
  };
  return {...value, commands};
}
test("macOS chooses a verified fixed Python path without reading PATH or invoking a shell", async () => {
  const value = macPython();
  assert.equal(await value.instance.python(), "/opt/homebrew/Cellar/python@3.14/3.14.8/bin/python3.14");
  assert.deepEqual(value.commands.map(call => call.command), ["/usr/bin/id", "/usr/bin/stat", "/opt/homebrew/Cellar/python@3.14/3.14.8/bin/python3.14"]);
  assert.deepEqual(Array.from(value.commands[2].args.slice(0, 2)), ["-I", "-B"]);
});
test("macOS refuses an untrusted owner, writable path, unsafe symlink and old Python", async () => {
  for (const options of [{badOwner:true}, {badMode:true}, {link:true}, {version:[3,9]}]) {
    const value = macPython(options);
    await assert.rejects(value.instance.python(), /Python3 3.10/);
    if (!options.version) assert(value.commands.every(call => call.command.startsWith("/usr/bin/")), "unsafe executable was never started");
  }
});
test("unsupported systems fail before starting a scanner", async () => {
  await assert.rejects(api("FreeBSD").exposed.open(), /Unsupported scanner operating system/);
});

test("Windows rejects missing Python and reparse points before executing a candidate", async () => {
  const value = api("WINNT");
  value.sandbox.PathUtils = {join: path.win32.join};
  const library = {declare: () => () => 0x400, close() {}};
  value.sandbox.ChromeUtils.importESModule = () => ({ctypes:{
    open: () => library, char16_t: {ptr: {}}
  }});
  await assert.rejects(value.exposed.open(), /Python3 unavailable/);
  value.sandbox.IOUtils.exists = async () => true;
  await assert.rejects(value.exposed.open(), /Untrusted Python installation/);
  assert.equal(value.removals(), 0);
});

test("Windows rejects writable scanner paths and accepts only harmless ancestor creation rights", () => {
  const script = source.replace("  const windows =", "  globalThis.verify = verifyWindowsDescriptor; const windows =");
  const verify = api("Linux", script).sandbox.verify;
  const trusted = new Set(["SY", "BA", "S-1-5-21-123"]);
  for (const descriptor of ["O:BAD:(A;;FA;;;BU)", "O:BUD:(A;;FR;;;WD)", "O:SYD:NO_ACCESS_CONTROL",
    "O:SYD:(A;;0x40000;;;BU)", "O:SYD:(XA;;FA;;;BU;(condition))"]) {
    assert.throws(() => verify(descriptor, trusted, false));
  }
  const root = "O:SYD:(A;;LC;;;AU)(A;OICIIO;FA;;;AU)(A;;0x1200a9;;;BU)";
  assert.throws(() => verify(root, trusted, false));
  verify(root, trusted, true);
  verify("O:S-1-5-21-123D:(A;;FA;;;BA)(A;;FRFX;;;BU)", trusted, false);
});

test("close force-closes stdin and kills without awaiting a blocked write", async () => {
  const value = api();
  let release, killed = false, forced;
  const gate = new Promise(resolve => { release = resolve; });
  value.instance.sessions.set("test", {
    process: { stdin: { close(force) { forced = force; return gate; } },
      async kill() { killed = true; release(); } },
    errors: Promise.resolve(), directory: "/synthetic/runtime"
  });
  const closing = value.instance.close("test");
  assert.equal(value.instance.close("test"), closing);
  assert(value.instance.sessions.has("test"), "closing session remains counted");
  await closing;
  assert.equal(forced, true);
  assert.equal(killed, true);
  assert.equal(value.removals(), 1);
  assert.equal(value.instance.sessions.has("test"), false);
});
test("a synchronous pipe failure cannot skip termination", async () => {
  const value = api(); let killed = false;
  value.instance.sessions.set("test", {
    process: { stdin: { close() { throw Error("broken pipe"); } }, async kill() { killed = true; } },
    errors: Promise.resolve(), directory: "/synthetic/runtime"
  });
  await value.instance.close("test");
  assert.equal(killed, true);
  assert.equal(value.removals(), 1);
});
test("failed cleanup remains counted and rejects further requests", async () => {
  const value = api();
  value.sandbox.console = { error() {} };
  value.sandbox.IOUtils.remove = async () => { throw Error("cleanup failed"); };
  value.instance.sessions.set("test", {
    process: { stdin: { close() {} }, async kill() {} },
    errors: Promise.resolve(), pending: 0, directory: "/synthetic/runtime"
  });
  await assert.rejects(value.instance.close("test"), /cleanup failed/);
  assert(value.instance.sessions.has("test"));
  await assert.rejects(value.exposed.request("test", '{"op":"health","id":"1"}'));
});
