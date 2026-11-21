import assert from "node:assert/strict";
import { test } from "node:test";
import { locator } from "../thunderbird/core.mjs";
import { FolderScan, checkpointHint, refreshScanFolders } from "../thunderbird/folder-scan.mjs";

const root = { id: "root", accountId: "one", path: "/Inbox", name: "受信トレイ" };
const child = { id: "child", accountId: "one", path: "/Inbox/Child", name: "子" };
const nested = { id: "nested", accountId: "one", path: "/Inbox/Child/Nested", name: "孫" };
const mail = (id, folder = root) => ({ id, author: "sender", subject: "mail", date: new Date(), headerMessageId: "id" + id, folder });
function fixture({ maxTargets, pause } = {}) {
  const listed = [], aborted = [], notifications = [], changes = [];
  const api = { messages: { list: async id => { listed.push(id); return { messages: [mail(1)], id: "page2" }; },
    continueList: async () => ({ messages: [mail(2)] }), abortList: async id => aborted.push(id) },
    folders: { getSubFolders: async id => id === "root" ? [child] : id === "child" ? [nested] : [] } };
  const scan = new FolderScan(api, { maxTargets, pause: pause || (async () => {}),
    changed: async () => changes.push(scan.snapshot()), finished: async job => notifications.push(job) });
  return { scan, api, listed, aborted, notifications, changes };
}

test("enumerates pages, freezes total, and counts every result category separately", async () => {
  const { scan, api } = fixture();
  api.messages.list = async () => ({ messages: [mail(1), mail(2), mail(3), mail(4)] });
  await scan.start(root, false); await scan.collecting;
  assert.equal(scan.job.total, 4);
  for (const status of ["clean", "detected", "incomplete", "error"]) {
    assert.ok(scan.take()); assert.equal(scan.job.scanning, 1);
    await scan.complete(status);
  }
  assert.equal(scan.job.status, "completed");
  assert.equal(scan.job.completed, 4);
  assert.deepEqual(scan.job.counts, { clean: 1, detected: 1, incomplete: 1, error: 1 });
  assert.equal(scan.targets.length, 0);
});

test("subfolders are opt-in and traversed from the actual API tree", async () => {
  const { scan, api, listed } = fixture();
  api.messages.list = async id => { listed.push(id); return { messages: [mail(id, id === "root" ? root : id === "child" ? child : nested)] }; };
  await scan.start(root, false); await scan.collecting;
  assert.deepEqual(listed, ["root"]);
  await scan.stop();
  listed.length = 0;
  await scan.start(root, true); await scan.collecting;
  assert.deepEqual(listed, ["root", "child", "nested"]);
  assert.equal(scan.job.total, 3);
});

test("stopping during enumeration is idempotent and finalizes the message list", async () => {
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const { scan, api, aborted } = fixture({ pause: () => gate });
  api.messages.list = async () => ({ messages: Array.from({ length: 150 }, (_, i) => mail(i)), id: "unfinished" });
  await scan.start(root, false);
  while (scan.job.discovered < 100) await new Promise(resolve => setImmediate(resolve));
  await scan.stop(); await scan.stop();
  assert.equal(scan.job.status, "stopped");
  assert.equal(scan.take(), null);
  resume(); await scan.collecting;
  assert.equal(scan.job.status, "stopped");
  assert.equal(scan.job.total, null);
  assert.equal(scan.job.completed, 0);
  assert.deepEqual(aborted, ["unfinished"]);
});

test("stop waits for the active message and leaves the rest unprocessed", async () => {
  const { scan } = fixture();
  await scan.start(root, false); await scan.collecting;
  assert.equal(scan.take().id, 1);
  await scan.stop();
  assert.equal(scan.job.status, "stopping");
  assert.equal(scan.take(), null);
  await scan.complete("detected");
  assert.equal(scan.job.status, "stopped");
  assert.equal(scan.job.total, 2); assert.equal(scan.job.completed, 1);
});

test("restart converts active work to interrupted and never reuses runtime targets", async () => {
  const { scan } = fixture();
  await scan.start(root, false); await scan.collecting;
  scan.take();
  const saved = scan.snapshot();
  assert.equal(Object.hasOwn(saved, "targets"), false);
  const next = fixture().scan;
  next.restore(saved);
  assert.equal(next.job.status, "interrupted");
  assert.equal(next.job.scanning, 0);
  assert.equal(next.take(), null);
  assert.equal(next.targets.length, 0);
});

test("empty, virtual, disconnected and excessive targets have explicit terminal outcomes", async () => {
  const { scan, api } = fixture({ maxTargets: 1 });
  await assert.rejects(scan.start({ ...root, isVirtual: true }, false));
  await assert.rejects(scan.start({ ...root, path: "/", isRoot: true }, false));
  await assert.rejects(scan.start({ ...root, path: "" }, false));
  api.messages.list = async () => ({ messages: [] });
  await scan.start(root, false); await scan.collecting;
  assert.equal(scan.job.status, "completed"); assert.equal(scan.job.total, 0);
  api.messages.list = async () => { throw new Error("offline"); };
  await scan.start(root, false); await scan.collecting;
  assert.equal(scan.job.status, "error"); assert.match(scan.job.detail, /offline/);
  api.messages.list = async () => ({ messages: [mail(1), mail(2)] });
  await scan.start(root, false); await scan.collecting;
  assert.equal(scan.job.status, "blocked"); assert.equal(scan.job.completed, 0);
});

test("duplicates and virtual child folders do not inflate the scan total", async () => {
  const { scan, api } = fixture();
  api.messages.list = async () => ({ messages: [mail(1), mail(1), { ...mail(2), external: true }] });
  api.folders.getSubFolders = async () => [{ ...child, isVirtual: true }];
  await scan.start(root, true); await scan.collecting;
  assert.equal(scan.job.total, 1); assert.equal(scan.job.ignored, 2); assert.equal(scan.job.skippedFolders, 1);
});

test("failed initial persistence does not leave an unstartable active job", async () => {
  const scan = new FolderScan({}, { changed: async () => { throw new Error("storage failure"); } });
  await assert.rejects(scan.start(root, false), /storage/);
  assert.equal(scan.active, false); assert.equal(scan.job, null);
});

test("a completed run notification keeps its own summary when a new run starts during persistence", async () => {
  const { scan, notifications } = fixture();
  await scan.start(root, false); await scan.collecting;
  const oldId = scan.job.id;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  scan.changed = async () => { if (scan.job.status === "completed") await gate; };
  scan.take(); await scan.complete("clean");
  scan.take(); const finishing = scan.complete("clean");
  assert.equal(scan.job.status, "completed");
  await scan.start(root, false); await scan.collecting;
  assert.notEqual(scan.job.id, oldId);
  release(); await finishing;
  assert.equal(notifications[0].id, oldId);
  assert.equal(notifications[0].status, "completed");
  assert.equal(notifications[0].completed, 2);
});


test("resume restores hashed checkpoints across changed runtime IDs and includes fresh/changed mail", async () => {
  const { scan, api } = fixture();
  const original = [mail(1), mail(2)];
  let listed = original;
  api.messages.list = async () => ({ messages: listed });
  const digest = "a".repeat(64);
  await scan.start(root, false); await scan.collecting;
  scan.take(); await scan.stop();
  await scan.complete("clean", { hint: await checkpointHint(locator(original[0])), digest });
  const saved = scan.snapshot(), checkpoint = scan.checkpointState();
  const next = new FolderScan(api, { digestOf: async () => digest });
  next.restore(saved, checkpoint);
  listed = [{ ...original[0], id: 101 }, { ...original[1], id: 102 }, mail(103)];
  await next.resume(root); await next.collecting;
  assert.equal(next.job.id, saved.id);
  assert.equal(next.job.completed, 1);
  assert.equal(next.job.resumedMatched, 1);
  assert.equal(next.job.total, 3);
  assert.equal(next.take().id, 102);
  await next.stop(); await next.complete("clean");
  next.digestOf = async () => "b".repeat(64);
  await next.resume(root); await next.collecting;
  assert.equal(next.job.resumedMatched, 0);
  assert.equal(next.take().id, 101); // Same headers, changed body: must inspect again.
  assert.equal(JSON.stringify(checkpoint).includes("sender"), false);
  assert.equal(JSON.stringify(checkpoint).includes("mail"), false);
});

test("resume treats identical copies as a multiset and never skips failed identity reads", async () => {
  const { scan, api } = fixture();
  const original = mail(1), duplicate = { ...original, id: 2 };
  api.messages.list = async () => ({ messages: [original, duplicate] });
  await scan.start(root, false); await scan.collecting;
  scan.take(); await scan.stop();
  await scan.complete("detected", { hint: await checkpointHint(locator(original)), digest: "a".repeat(64) });
  scan.digestOf = async () => "a".repeat(64);
  await scan.resume(root); await scan.collecting;
  assert.equal(scan.job.resumedMatched, 1);
  assert.equal(scan.targets.length, 1);
  await scan.stop();
  scan.digestOf = async () => { throw new Error("offline"); };
  await scan.resume(root); await scan.collecting;
  assert.equal(scan.job.resumedMatched, 0);
  assert.equal(scan.targets.length, 2);
  await assert.rejects(scan.resume(root), /再開できません/);
  await assert.rejects(scan.remove(), /実行中/);
});

test("removing a stopped summary clears resume data and handles persistence failure", async () => {
  const { scan } = fixture();
  await scan.start(root, false); await scan.collecting;
  await scan.stop();
  scan.remember("a".repeat(64), "b".repeat(64));
  const saved = scan.snapshot();
  scan.changed = async () => { throw new Error("quota"); };
  await assert.rejects(scan.resume(root), /quota/);
  assert.deepEqual(scan.snapshot(), saved);
  await assert.rejects(scan.remove(), /quota/);
  assert.deepEqual(scan.snapshot(), saved);
  assert.equal(scan.checkpointState().entries.length, 1);
  scan.changed = async () => {};
  await scan.remove();
  assert.equal(scan.snapshot(), null);
  assert.equal(scan.checkpointState(), null);
  assert.equal(scan.targets.length, 0);
  await assert.rejects(scan.resume(root), /再開できません/);
});

test("resume re-enumeration can be cancelled and rejects a moved root", async () => {
  const { scan, api } = fixture();
  await scan.start(root, false); await scan.collecting;
  await scan.stop();
  await assert.rejects(scan.resume({ ...root, path: "/Moved" }), /元のフォルダー/);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  api.messages.list = async () => { await gate; return { messages: [mail(5)], id: "resume-page" }; };
  await scan.resume(root);
  await scan.stop();
  assert.equal(scan.job.status, "stopped");
  release(); await scan.collecting;
  assert.equal(scan.job.status, "stopped");
});

test("multiple roots share progress, deduplicate parent/child traversal and resume checkpoints", async () => {
  const { scan, api, listed } = fixture();
  const byId = { root, child, nested };
  const messages = Object.fromEntries(Object.entries(byId).map(([id, folder]) => [id, mail(id, folder)]));
  api.messages.list = async id => { listed.push(id); return { messages: [messages[id]] }; };
  await scan.start([root, child], true); await scan.collecting;
  assert.deepEqual(listed, ["root", "child", "nested"]);
  assert.equal(scan.job.total, 3);
  assert.equal(scan.job.folders.length, 2);
  const target = scan.take();
  await scan.complete("clean", { hint: await checkpointHint(locator(target)), digest: "a".repeat(64) });
  await scan.stop();
  assert.equal(scan.job.status, "stopped");
  const saved = scan.snapshot(), checkpoint = scan.checkpointState();
  const next = new FolderScan(api, { digestOf: async () => "a".repeat(64) });
  next.restore(saved, checkpoint);
  await assert.rejects(next.resume([root]), /見つからない|場所/);
  await next.resume([root, child]); await next.collecting;
  assert.equal(next.job.resumedMatched, 1);
  assert.equal(next.job.total, 3);
  for (let i = 0; i < 2; i++) { assert.ok(next.take()); await next.complete("clean"); }
  assert.equal(next.job.completed, 3);
  assert.equal(next.job.status, "completed");
});

test("multiple roots without subfolders include only explicit targets and reject cross-account roots", async () => {
  const { scan, api, listed } = fixture();
  api.messages.list = async id => { listed.push(id); return { messages: [mail(id, id === "root" ? root : child)] }; };
  await assert.rejects(scan.start([root, { ...child, accountId: "other" }], false));
  await assert.rejects(scan.start([root, root], false));
  await scan.start([root, child], false); await scan.collecting;
  assert.deepEqual(listed, ["root", "child"]);
  assert.equal(scan.job.total, 2);
});


test("advisory counts remain separate and are compatible with old folder summaries", async () => {
  const { scan, api } = fixture();
  api.messages.list = async () => ({ messages: [mail(1)] });
  await scan.start(root, false); await scan.collecting;
  assert.equal(scan.job.counts.advisory, undefined);
  scan.take(); await scan.complete("advisory");
  assert.equal(scan.job.counts.advisory, 1);
  assert.equal(scan.job.counts.detected, 0);
  assert.equal(scan.job.status, "completed");
});


test("refreshing scan targets rejects moved, cross-account, virtual and missing folders", async () => {
  for (const replacement of [{ ...root, path: "/Moved" }, { ...root, accountId: "other" },
    { ...root, isVirtual: true }, { ...root, isRoot: true }, null]) {
    const api = { folders: { get: async () => replacement } };
    assert.equal(await refreshScanFolders(api, [root]), null);
  }
  const renamed = { ...root, name: "New display name" };
  assert.deepEqual(await refreshScanFolders({ folders: { get: async () => renamed } }, [root]), [renamed]);
  const legacy = { ...root }; delete legacy.id;
  assert.deepEqual(await refreshScanFolders({ folders: { get: async () => { throw new Error("no runtime ID"); } } }, [legacy]), [legacy]);
});


test("failed new folder start restores the prior job, checkpoints and pending targets", async () => {
  const {scan} = fixture();
  await scan.start(root, false); await scan.collecting;
  scan.take(); await scan.complete("clean", {hint:"a".repeat(64),digest:"b".repeat(64)});
  await scan.stop();
  const job = scan.snapshot(), checkpoints = scan.checkpointState();
  const targets = scan.targets, cursor = scan.cursor;
  scan.changed = async () => { throw new Error("synthetic storage failure"); };
  await assert.rejects(scan.start(child, false), /storage failure/);
  assert.deepEqual(scan.snapshot(), job);
  assert.deepEqual(scan.checkpointState(), checkpoints);
  assert.equal(scan.targets, targets);
  assert.equal(scan.cursor, cursor);
  assert.equal(scan.resumable, true);
  scan.changed = async () => {};
  await scan.resume(root); await scan.collecting;
  assert.equal(scan.job.id, job.id);
});

for (const expire of [false, true]) test(`resume proof is bounded and late digest cannot change a newer job (expire=${expire})`, async () => {
  const { scan, api } = fixture();
  const originals = [mail(1), mail(2)];
  api.messages.list = async () => ({ messages: originals });
  await scan.start(root, false); await scan.collecting;
  scan.take(); await scan.stop();
  await scan.complete("clean", { hint: await checkpointHint(locator(originals[0])), digest: "a".repeat(64) });
  let enter, release;
  const started = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  let guard;
  scan.proofTimeout = 15;
  scan.digestOf = async (message, check) => { guard = check; enter(); await gate; check(); return "a".repeat(64); };
  await scan.resume(root); await started;
  if (expire) {
    await scan.collecting;
    assert.equal(scan.job.resumedMatched, 0);
    assert.equal(scan.job.total, 3);
    assert.equal(scan.take().id, 1);
    await scan.stop(); await scan.complete("clean");
  } else {
    await scan.stop();
    assert.equal(scan.job.status, "stopped");
    assert.equal(scan.active, false);
  }
  assert.throws(guard);
  await scan.remove();
  api.messages.list = async () => ({ messages: [mail(90)] });
  await scan.start(root, false); await scan.collecting;
  const before = scan.snapshot();
  release(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(scan.snapshot(), before);
  assert.equal(scan.take().id, 90);
});

for (const phase of ["list", "page", "subfolder"]) test(`collection stop does not wait for ${phase} and discards late lists`, async () => {
  const { scan, api, aborted } = fixture();
  let enter, release;
  const started = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  api.messages.list = async () => {
    if (phase === "list") { enter(); await gate; return { messages: [mail(1)], id: "late" }; }
    return phase === "page" ? { messages: [], id: "early" } : { messages: [] };
  };
  api.messages.continueList = async () => { enter(); await gate; return { messages: [mail(2)], id: "late" }; };
  api.folders.getSubFolders = async () => { enter(); await gate; return [child]; };
  await scan.start(root, phase === "subfolder"); await started;
  await scan.stop();
  assert.equal(scan.job.status, "stopped");
  await scan.remove();
  release(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(scan.job, null);
  if (phase !== "subfolder") assert.ok(aborted.includes("late"));
});
