// Dependency-free UI smoke test using a separate headless Chrome profile/CDP.
// It serves only extension assets and uses synthetic mail, never a real profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = await mkdtemp(path.join(tmpdir(), "clam-mail-ui-"));
const server = createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname.slice(1);
  if (!["dashboard.html", "dashboard.css", "dashboard.js", "core.mjs", "results.mjs", "folder-scan.mjs", "icon.svg"].includes(name)) {
    response.writeHead(404).end(); return;
  }
  const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml" };
  response.setHeader("Content-Type", types[path.extname(name)]);
  response.end(await readFile(path.join(root, "thunderbird", name)));
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const chrome = spawn("/opt/google/chrome/chrome", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-component-update", "--remote-debugging-pipe",
  "--user-data-dir=" + profile, "about:blank"
], {
  stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  env: { ...process.env, DISPLAY: "", WAYLAND_DISPLAY: "",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=" + path.join(profile, "no-session-bus") }
});
let sequence = 0, buffer = "", errors = "";
const pending = new Map();
chrome.stderr.on("data", data => { errors = (errors + data).slice(-4000); });
chrome.stdio[4].on("data", data => {
  buffer += data.toString();
  let end;
  while ((end = buffer.indexOf("\0")) !== -1) {
    const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    const waiter = pending.get(value.id);
    if (!waiter) continue;
    pending.delete(value.id); clearTimeout(waiter.timer);
    value.error ? waiter.reject(new Error(JSON.stringify(value.error))) : waiter.resolve(value.result);
  }
});
function cdp(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timed out: " + errors)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
}

try {
  await cdp("Browser.getVersion");
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  const call = (method, params) => cdp(method, params, sessionId);
  const evaluate = async expression => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call("Page.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.testCalls = [];
    window.confirmResult = true;
    window.confirm = () => confirmResult;
    const makeRecord = (key, status, accountId = "test") => ({ key, status, sha256: "test",
      updatedAt: new Date(Date.UTC(2026, 10, 14, 9) - Number(key.replace(/[^0-9]/g, '') || 0) * 1000).toISOString(),
      engine: "ClamAV test", signatures: status === "detected" ? ["Eicar-Test-Signature"] : [],
      detail: status === "detected" ? "脅威候補を検出しました。" : "検査結果",
      locator: { accountId, author: key === "r0" ? '<img src=x onerror="window.bad=true">' : "送信者",
        subject: key === "r0" ? "テスト添付メール" : "メール " + key, folder: { path: "/Inbox" } } });
    window.testState = { ok: true, issue: "", batch: null, folderJob: null, folderRequest: null,
      settings: { enabled: false, accountIds: [], notifications: true },
      accounts: [{ id: "test", name: "テストアカウント", type: "imap" }, { id: "other", name: "別アカウント", type: "imap" }],
      records: [makeRecord("r0", "detected"), makeRecord("r1", "detected", "other"),
        makeRecord("r2", "clean"), makeRecord("r3", "incomplete", "other"),
        makeRecord("r4", "queued"), makeRecord("r5", "deleted"),
        ...Array.from({ length: 55 }, (_, i) => makeRecord("r" + (i + 6), "clean"))] };
    const target = key => { const record = testState.records.find(record => record.key === key);
      return { key, author: record.locator.author, subject: record.locator.subject,
        folder: "/Inbox", accountId: record.locator.accountId, signatures: record.signatures }; };
    let batchKeys = [];
    window.messenger = { runtime: { sendMessage: async request => {
      testCalls.push(request);
      if (request.type === "state") return structuredClone(testState);
      if (request.type === "folderContext") {
        testState.folderRequest = { token: "folder-token", folder: { accountId: "test", path: "/Inbox", name: "受信トレイ" } };
        return { ok: true, ...testState.folderRequest };
      }
      if (request.type === "folderCancel") testState.folderRequest = null;
      if (request.type === "folderStart") {
        testState.folderRequest = null;
        testState.folderJob = { id: "folder-job", status: "collecting", folder: { accountId: "test", path: "/Inbox" },
          includeSubfolders: request.includeSubfolders, total: null, discovered: 10, completed: 0, scanning: 0,
          counts: { clean: 0, detected: 0, incomplete: 0, error: 0 }, detail: "対象メールを確認しています。",
          startedAt: new Date().toISOString(), finishedAt: null, ignored: 0, skippedFolders: 0 };
        return { ok: true, job: testState.folderJob };
      }
      if (request.type === "folderStop") { testState.folderJob.status = "stopped"; testState.folderJob.scanning = 0;
        testState.folderJob.finishedAt = new Date().toISOString(); testState.folderJob.detail = "中止しました。"; }

      if (request.type === "health") return { ok: true, health: { status: "ready", engine: "ClamAV test", detail: "接続可能" } };
      if (request.type === "clear") testState.records = testState.records.filter(record => ["queued", "scanning"].includes(record.status));
      if (request.type === "prepareDelete") return { ok: true, token: "test-ticket", ...target(request.key) };
      if (request.type === "deletePermanently") testState.records.find(record => record.key === request.key).status = "deleted";
      if (request.type === "prepareDeleteBatch") { batchKeys = request.keys; return { ok: true, token: "batch", targets: batchKeys.map(target) }; }
      if (request.type === "deleteBatch") return { ok: true, results: batchKeys.map((key, i) => {
        if (i === 0) testState.records.find(record => record.key === key).status = "deleted";
        return { key, deleted: i === 0, error: i === 0 ? undefined : "模擬の削除失敗" }; }) };
      if (request.type === "retryMany") return { ok: true, count: request.keys.length };
      return { ok: true };
    } }, permissions: { request: async value => { testCalls.push({ type: "permission", ...value }); return true; } } };
  ` });
  const until = expression => evaluate(`new Promise((resolve, reject) => {
    const timer = setInterval(() => { if (${expression}) { clearInterval(timer); clearTimeout(deadline); resolve(true); } }, 20);
    const deadline = setTimeout(() => { clearInterval(timer); reject(new Error('UI condition timed out')); }, 5000);
  })`);
  const change = async (id, value, event = "change") => evaluate(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)};
    document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event(${JSON.stringify(event)}));`);
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/dashboard.html` });
  await until("document.querySelectorAll('#results tr').length === 50");
  assert.equal(await evaluate("document.getElementById('panel-settings').hidden"), true);
  assert.equal(await evaluate("document.querySelectorAll('#results img').length"), 0);
  assert.match(await evaluate("document.getElementById('results').textContent"), /<img/);
  await evaluate("document.querySelector('#results input').click()");
  assert.match(await evaluate("document.getElementById('selected-count').textContent"), /1件/);
  await evaluate("document.getElementById('next-page').click()");
  assert.equal(await evaluate("document.querySelectorAll('#results tr').length"), 11);
  assert.match(await evaluate("document.getElementById('selected-count').textContent"), /0件/);
  await evaluate("document.getElementById('previous-page').click()");
  await change("filter", "detected");
  assert.equal(await evaluate("document.querySelectorAll('#results tr').length"), 2);
  await change("account-filter", "other");
  assert.equal(await evaluate("document.querySelectorAll('#results tr').length"), 1);
  await change("search", "not found", "input");
  assert.equal(await evaluate("document.querySelectorAll('#results tr').length"), 0);
  assert.equal(await evaluate("document.getElementById('empty-results').hidden"), false);
  await evaluate("document.getElementById('reset-filters').click()");
  await evaluate("document.getElementById('select-page').click()");
  assert.equal(await evaluate("document.getElementById('delete-selected').disabled"), true);
  await change("filter", "detected");
  assert.match(await evaluate("document.getElementById('selected-count').textContent"), /0件/);
  await evaluate("document.getElementById('tab-results').focus(); document.getElementById('tab-results').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
  assert.equal(await evaluate("document.getElementById('panel-results').hidden"), true);
  assert.equal(await evaluate("document.activeElement.id"), "tab-settings");
  await evaluate("document.getElementById('health').click()");
  await until("document.getElementById('health-result').textContent.includes('ClamAV test') && !document.getElementById('health').disabled");
  await evaluate(`document.getElementById('enabled').checked = true;
    document.querySelector('#accounts input').checked = true;
    document.getElementById('settings-form').requestSubmit();`);
  await until("testCalls.some(call => call.type === 'settings') && !document.getElementById('health').disabled");
  await evaluate("document.getElementById('allow-delete').click()");
  await until("testCalls.some(call => call.type === 'permission') && !document.getElementById('health').disabled");
  await evaluate("document.getElementById('tab-results').click(); document.getElementById('select-page').click(); document.getElementById('delete-selected').click()");
  await until("document.getElementById('delete-dialog').open");
  assert.equal(await evaluate("document.querySelectorAll('#delete-targets li').length"), 2);
  assert.equal(await evaluate("document.querySelectorAll('#delete-targets img').length"), 0);
  assert.equal(await evaluate("document.activeElement.id"), "delete-cancel");
  assert.equal(await evaluate("document.getElementById('delete-confirm').disabled"), true);
  await evaluate("document.getElementById('delete-cancel').click()");
  await until("testCalls.some(call => call.type === 'cancelDeleteBatch') && !document.getElementById('delete-selected').disabled");
  assert.equal(await evaluate("testCalls.some(call => call.type === 'deleteBatch')"), false);
  await mkdir(path.join(root, "dist"), { recursive: true });
  const desktop = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(path.join(root, "dist/ui-desktop.png"), Buffer.from(desktop.data, "base64"));
  await evaluate("document.getElementById('delete-selected').click()");
  await until("document.getElementById('delete-dialog').open");
  await evaluate("document.getElementById('delete-ack').click(); document.getElementById('delete-confirm').click()");
  await until("document.getElementById('action-status').textContent.includes('完全削除1件')");
  assert.equal(await evaluate("document.querySelectorAll('#results tr').length"), 1);
  assert.match(await evaluate("document.getElementById('batch-report').textContent"), /模擬の削除失敗/);
  await evaluate("document.querySelector('#results button:last-child').click()");
  await until("document.getElementById('delete-dialog').open");
  await evaluate("document.getElementById('delete-ack').click(); document.getElementById('delete-confirm').click()");
  await until("document.getElementById('action-status').textContent.includes('対象メールを完全削除')");
  await change("filter", "deleted");
  assert.equal(await evaluate("document.querySelector('#results button').disabled"), true);
  await change("filter", "clean");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#results button:last-child')).display"), "none");
  await evaluate("document.querySelector('#results input').click(); document.getElementById('retry-selected').click()");
  await until("testCalls.some(call => call.type === 'retryMany') && !document.getElementById('filter').disabled");
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
  const mobile = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(path.join(root, "dist/ui-mobile.png"), Buffer.from(mobile.data, "base64"));
  await evaluate("document.getElementById('tab-settings').click(); document.getElementById('clear').click()");
  await until("testCalls.some(call => call.type === 'clear') && !document.getElementById('clear').disabled");
  await evaluate("document.getElementById('tab-results').click(); document.getElementById('scan-folder').click()");
  await until("document.getElementById('folder-dialog').open");
  assert.equal(await evaluate("document.getElementById('folder-subfolders').checked"), false);
  assert.equal(await evaluate("document.activeElement.id"), "folder-cancel");
  await evaluate("document.getElementById('folder-cancel').click()");
  await until("testCalls.some(call => call.type === 'folderCancel')");
  assert.equal(await evaluate("testCalls.some(call => call.type === 'folderStart')"), false);
  await evaluate("document.getElementById('scan-folder').click()");
  await until("document.getElementById('folder-dialog').open");
  await evaluate("document.getElementById('folder-subfolders').click(); document.getElementById('folder-confirm').click()");
  await until("!document.getElementById('folder-progress').hidden && !document.getElementById('folder-stop').disabled");
  assert.equal(await evaluate("document.getElementById('folder-bar').hasAttribute('value')"), false);
  assert.match(await evaluate("document.getElementById('folder-status').textContent"), /対象10件/);
  assert.equal(await evaluate("testCalls.find(call => call.type === 'folderStart').includeSubfolders"), true);
  await evaluate(`testState.folderJob = { ...testState.folderJob, status: 'running', total: 100, completed: 25, scanning: 1,
    counts: { clean: 20, detected: 2, incomplete: 1, error: 2 }, detail: '1通ずつ検査しています。' };
    testState.records.push({ key: 'folder-result', status: 'clean', sha256: 'hash', folderJobId: 'folder-job',
      updatedAt: new Date().toISOString(), locator: { accountId: 'test', author: '送信者', subject: 'フォルダー検査結果' },
      signatures: [], detail: '未検出' }); document.getElementById('health').click();`);
  await until("document.getElementById('folder-status').textContent.includes('25 / 100') && !document.getElementById('folder-results').disabled");
  assert.equal(await evaluate("document.getElementById('folder-bar').value"), 25);
  assert.equal(await evaluate("document.getElementById('folder-bar').max"), 100);
  assert.match(await evaluate("document.getElementById('folder-counts').textContent"), /検出2件/);
  await evaluate("document.getElementById('folder-results').click()");
  assert.equal(await evaluate("document.querySelectorAll('#results tr').length"), 1);
  assert.match(await evaluate("document.getElementById('results').textContent"), /フォルダー検査結果/);
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  const folderImage = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(path.join(root, "dist/ui-folder-progress.png"), Buffer.from(folderImage.data, "base64"));
  await evaluate("document.getElementById('folder-stop').click()");
  await until("document.getElementById('folder-status').textContent.includes('中止') && document.getElementById('folder-stop').disabled");
  assert.match(await evaluate("document.getElementById('folder-status').textContent"), /未処理75件/);
  await evaluate("testState.folderJob.status = 'interrupted'; document.getElementById('health').click()");
  await until("document.getElementById('folder-status').textContent.includes('中断')");
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
  console.log("UI smoke: passed (tabs, filters, bulk actions, folder start/cancel/subfolders, progress counters, run filter, stop/interruption, desktop/mobile)");
} finally {
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  chrome.kill();
  await new Promise(resolve => {
    if (chrome.exitCode !== null || chrome.signalCode !== null) resolve();
    else chrome.once("exit", resolve);
  });
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
