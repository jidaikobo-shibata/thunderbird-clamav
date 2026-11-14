import assert from "node:assert/strict";
import { test } from "node:test";
import { FolderScan } from "../thunderbird/folder-scan.mjs";

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
  assert.equal(scan.job.status, "stopping");
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
  assert.equal(scan.active, false); assert.equal(scan.job.status, "error");
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
