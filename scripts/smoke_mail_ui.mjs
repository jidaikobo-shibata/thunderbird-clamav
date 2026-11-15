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
  if (!["dashboard.html", "dashboard.css", "dashboard.js", "core.mjs", "results.mjs", "folder-scan.mjs", "installation.mjs", "installer.pyz", "icon.svg"].includes(name)) {
    response.writeHead(404).end(); return;
  }
  const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml", ".pyz": "application/octet-stream" };
  response.setHeader("Content-Type", types[path.extname(name)]);
  response.end(await readFile(name === "installer.pyz" ? path.join(root, "dist", "clam-mail-check-installer-0.9.3.pyz") : path.join(root, "thunderbird", name)));
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
    window.permissionGranted = true;
    window.failSettings = false;
    window.cancelUninstall = true;
    window.failSave = false;
    window.customSaveName = null;
    const downloadItems = new Map(), downloadListeners = new Set();
    window.confirm = () => confirmResult;
    const makeRecord = (key, status, accountId = "test") => ({ key, status, sha256: "test",
      updatedAt: new Date(Date.UTC(2026, 10, 14, 9) - Number(key.replace(/[^0-9]/g, '') || 0) * 1000).toISOString(),
      engine: "ClamAV test", signatures: status === "detected" ? ["Eicar-Test-Signature"] : [],
      detail: status === "detected" ? "脅威候補を検出しました。" : "検査結果",
      locator: { accountId, author: key === "r0" ? '<img src=x onerror="window.bad=true">' : "送信者",
        subject: key === "r0" ? "テスト添付メール" : "メール " + key, folder: { path: "/Inbox" } } });
    window.testState = { ok: true, issue: "", batch: null, folderJob: null, folderRequest: null,
      installation: { state: sessionStorage.getItem("fixture-installation") || "managed", version: "0.9.3", healthy: true, detail: "導入済み" },
      settings: { enabled: false, accountIds: [], notifications: true },
      accounts: [{ id: "test", name: "テストアカウント", type: "imap" }, { id: "other", name: "別アカウント", type: "imap" }],
      records: [makeRecord("r0", "detected"), makeRecord("r1", "detected", "other"),
        makeRecord("r2", "clean"), makeRecord("r3", "incomplete", "other"),
        makeRecord("r4", "queued"), makeRecord("r5", "deleted"),
        ...Array.from({ length: 55 }, (_, i) => makeRecord("r" + (i + 6), "clean"))] };
    const target = key => { const record = testState.records.find(record => record.key === key);
      return { key, author: record.locator.author, subject: record.locator.subject,
        folder: "/Inbox", accountId: record.locator.accountId, status: record.status, signatures: record.signatures }; };
    let batchKeys = [];
    window.messenger = { runtime: { getManifest: () => ({ version: "0.9.3" }), getURL: name => "/" + name, sendMessage: async request => {
      testCalls.push(request);
      if (request.type === "state") return structuredClone(testState);
      if (request.type === "helperInfo") return { ok: true, installation: testState.installation };
      if (request.type === "helperPlan") { testState.maintenance = true; testState.maintenanceOperation = request.operation; return { ok: true,
        plan: { token: "maintenance-token", operation: request.operation, version: "0.9.3", paths: ["/synthetic/home/.local/lib/clam-mail-check"] } }; }
      if (request.type === "helperCancel") testState.maintenance = false;
      if (request.type === "helperApply") { testState.maintenance = false;
        testState.helperRemoved = testState.maintenanceOperation === "uninstall";
        testState.installation = { state: testState.helperRemoved ? "removed" : "managed", version: "0.9.3", healthy: true,
          detail: testState.helperRemoved ? "補助プログラムを削除しました。" : "補助プログラムを更新しました。", retained: [] };
        return { ok: true, installation: testState.installation }; }
      if (request.type === "helperMarkRemoved") { testState.helperRemoved = true; testState.installation = { state: "removed" }; }

      if (request.type === "settings") {
        if (failSettings) return { ok: false, error: "synthetic storage failure" };
        testState.settings = structuredClone(request.settings); return { ok: true };
      }
      if (request.type === "folderChoices") return { ok: true, folders: [
        { id: "inbox", accountId: "test", path: "/Inbox", name: "受信トレイ" },
        { id: "spam", accountId: "test", path: "/Inbox/Spam", name: "迷惑メール" },
        { id: "other-inbox", accountId: "other", path: "/Inbox", name: "受信トレイ" }
      ] };
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
      if (request.type === "folderResume") {
        testState.folderJob.status = "collecting"; testState.folderJob.total = null;
        testState.folderJob.finishedAt = null; testState.folderJob.detail = "処理済みメールと照合中";
      }
      if (request.type === "folderDelete") testState.folderJob = null;
      if (request.type === "folderStop") { testState.folderJob.status = "stopped"; testState.folderJob.scanning = 0;
        testState.folderJob.finishedAt = new Date().toISOString(); testState.folderJob.detail = "中止しました。"; }

      if (request.type === "health") {
        testState.lastHealth = { status: "ready", engine: "ClamAV test", detail: "接続可能", checkedAt: new Date().toISOString() };
        return { ok: true, health: testState.lastHealth };
      }
      if (request.type === "clear") testState.records = testState.records.filter(record => ["queued", "scanning"].includes(record.status));
      if (request.type === "prepareDelete") return { ok: true, token: "test-ticket", ...target(request.key) };
      if (request.type === "deletePermanently") testState.records.find(record => record.key === request.key).status = "deleted";
      if (request.type === "prepareDeleteBatch") { batchKeys = request.keys; return { ok: true, token: "batch", targets: batchKeys.map(target) }; }
      if (request.type === "deleteBatch") return { ok: true, results: batchKeys.map((key, i) => {
        if (i === 0) testState.records.find(record => record.key === key).status = "deleted";
        return { key, deleted: i === 0, error: i === 0 ? undefined : "模擬の削除失敗" }; }) };
      if (request.type === "retryMany") return { ok: true, count: request.keys.length };
      return { ok: true };
    } }, management: { uninstallSelf: async options => {
      testCalls.push({ type: "uninstallSelf", ...options });
      if (cancelUninstall) throw new Error("synthetic cancel");
    } }, downloads: {
      onChanged: { addListener: listener => downloadListeners.add(listener), removeListener: listener => downloadListeners.delete(listener) },
      search: async query => downloadItems.has(query.id) ? [downloadItems.get(query.id)] : [],
      cancel: async id => { downloadItems.get(id).state = "interrupted"; },
      download: async options => {
        testCalls.push({ type: "saveDownload", ...options });
        if (failSave) throw new Error("synthetic save dialog canceled");
        const name = customSaveName || options.filename;
        const anchor = document.createElement("a"); anchor.href = options.url; anchor.download = name;
        document.body.append(anchor); anchor.click(); anchor.remove();
        const id = downloadItems.size + 1;
        downloadItems.set(id, { id, state: "complete", filename: "/synthetic/downloads/" + name });
        return id;
      }
    }, permissions: { request: async value => { testCalls.push({ type: "permission", ...value }); return permissionGranted; } } };
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
  assert.equal(await evaluate("document.querySelectorAll('[role=tab]').length"), 6);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[role=tab]')].map(tab => tab.id)"),
    ["tab-scan", "tab-results", "tab-settings", "tab-setup", "tab-uninstall", "tab-help"]);
  assert.equal(await evaluate("document.getElementById('panel-scan').hidden"), false);
  assert.equal(await evaluate("document.getElementById('scan-selection')"), null);
  await evaluate("document.getElementById('tab-help').click()");
  assert.match(await evaluate("document.getElementById('panel-help').textContent"), /検査範囲/);
  assert.match(await evaluate("document.getElementById('panel-help').textContent"), /セットアップ/);
  assert.match(await evaluate("document.getElementById('panel-help').textContent"), /アンインストール/);
  await evaluate("document.querySelector('[data-open-tab=uninstall]').click()");
  assert.equal(await evaluate("document.getElementById('panel-uninstall').hidden"), false);
  assert.equal(await evaluate("document.getElementById('uninstall-steps').hidden"), true);
  assert.equal(await evaluate("testCalls.some(call => call.type === 'helperPlan' || call.type === 'helperApply')"), false);
  await evaluate("document.getElementById('tab-uninstall').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))");
  assert.equal(await evaluate("document.activeElement.id"), "tab-help");
  await evaluate("document.getElementById('tab-help').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))");
  assert.equal(await evaluate("document.activeElement.id"), "tab-scan");
  await evaluate("document.getElementById('tab-results').click()");
  await evaluate("window.scrollTo(0, 600)");
  assert.ok(await evaluate("Math.abs(document.querySelector('.tabs').getBoundingClientRect().top) < 1"));
  assert.ok(await evaluate("document.querySelector('header').getBoundingClientRect().bottom < 0"));
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.tabs')).backgroundColor === getComputedStyle(document.body).backgroundColor"), true);
  await evaluate("window.scrollTo(0, 0)");


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
  assert.equal(await evaluate("document.getElementById('delete-selected').disabled"), false);
  await change("filter", "detected");
  assert.match(await evaluate("document.getElementById('selected-count').textContent"), /0件/);
  await evaluate("document.getElementById('tab-results').focus(); document.getElementById('tab-results').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
  assert.equal(await evaluate("document.getElementById('panel-results').hidden"), true);
  assert.equal(await evaluate("document.activeElement.id"), "tab-settings");
  assert.equal(await evaluate("document.querySelector('#panel-settings #health')"), null);
  await evaluate("document.getElementById('tab-setup').click(); document.getElementById('health').click()");
  await until("document.getElementById('health-result').textContent.includes('ClamAV test') && !document.getElementById('health').disabled");
  await evaluate("document.getElementById('tab-settings').click()");
  assert.equal(await evaluate("document.querySelector('#settings-form button[type=submit]')"), null);
  assert.equal(await evaluate("document.getElementById('enabled').disabled"), true);
  await evaluate("document.querySelector('#accounts input').click()");
  await until("testState.settings.accountIds.length === 1 && !document.getElementById('enabled').disabled");
  await evaluate("document.getElementById('enabled').click()");
  await until("testState.settings.enabled && document.getElementById('settings-status').textContent.includes('保存しました') && !document.getElementById('enabled').disabled");
  await evaluate("failSettings = true; document.getElementById('notifications').click()");
  await until("document.getElementById('settings-status').textContent.includes('保存できません') && !document.getElementById('notifications').disabled");
  assert.equal(await evaluate("document.getElementById('notifications').checked"), true);
  await evaluate("failSettings = false; document.querySelector('#accounts input').click()");
  await until("!testState.settings.enabled && testState.settings.accountIds.length === 0 && !document.getElementById('notifications').disabled");
  assert.equal(await evaluate("document.getElementById('enabled').disabled"), true);
  assert.match(await evaluate("document.getElementById('health-result').textContent"), /最終接続確認.*応答あり/);
  await evaluate("testState.lastScan = { checkedAt: new Date().toISOString(), engine: 'ClamAV actual (clamd)', status: 'clean' }; document.getElementById('tab-setup').click(); document.getElementById('health').click()");
  await until("document.getElementById('last-scan-result').textContent.includes('clamd') && !document.getElementById('health').disabled");
  await mkdir(path.join(root, "dist"), { recursive: true });
  const settingsImage = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(path.join(root, "dist/ui-settings.png"), Buffer.from(settingsImage.data, "base64"));
  assert.equal(await evaluate("document.getElementById('allow-delete')"), null);
  await evaluate("document.getElementById('tab-results').click(); document.getElementById('select-page').click(); permissionGranted = false; document.getElementById('delete-selected').click()");
  await until("document.getElementById('action-status').textContent.includes('許可されなかった') && !document.getElementById('delete-selected').disabled");
  assert.equal(await evaluate("document.getElementById('delete-dialog').open"), false);
  assert.equal(await evaluate("testCalls.some(call => call.type === 'prepareDeleteBatch' || call.type === 'deleteBatch')"), false);
  await evaluate("permissionGranted = true; document.getElementById('delete-selected').click()");
  await until("document.getElementById('delete-dialog').open");
  assert.equal(await evaluate("testCalls.some(call => call.type === 'permission')"), true);
  assert.equal(await evaluate("testCalls.findIndex(call => call.type === 'permission') < testCalls.findIndex(call => call.type === 'prepareDeleteBatch')"), true);
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
  const singlePrepares = await evaluate("testCalls.filter(call => call.type === 'prepareDelete').length");
  await evaluate("permissionGranted = false; document.querySelector('#results button:last-child').click()");
  await until("document.getElementById('action-status').textContent.includes('許可されなかった') && !document.querySelector('#results button:last-child').disabled");
  assert.equal(await evaluate("testCalls.filter(call => call.type === 'prepareDelete').length"), singlePrepares);
  assert.equal(await evaluate("document.getElementById('delete-dialog').open"), false);
  await evaluate("permissionGranted = true; document.querySelector('#results button:last-child').click()");
  await until("document.getElementById('delete-dialog').open");
  await evaluate("document.getElementById('delete-ack').click(); document.getElementById('delete-confirm').click()");
  await until("document.getElementById('action-status').textContent.includes('対象メールを完全削除')");
  await change("filter", "deleted");
  assert.equal(await evaluate("document.querySelector('#results button').disabled"), true);
  await change("filter", "clean");
  assert.notEqual(await evaluate("getComputedStyle(document.querySelector('#results button:last-child')).display"), "none");
  assert.equal(await evaluate("document.querySelector('#results button:last-child').disabled"), false);
  await evaluate("testState.records.find(record => record.key === 'r3').sha256 = null");
  await change("filter", "incomplete");
  await evaluate("document.getElementById('select-page').click()");
  assert.equal(await evaluate("document.getElementById('delete-selected').disabled"), false);
  await evaluate("document.getElementById('delete-selected').click()");
  await until("document.getElementById('delete-dialog').open");
  assert.equal(await evaluate("document.querySelectorAll('#delete-targets li').length"), 1);
  assert.match(await evaluate("document.getElementById('delete-targets').textContent"), /一部または全部が未検査/);
  await evaluate("document.getElementById('delete-cancel').click()");
  await until("!document.getElementById('delete-dialog').open && !document.getElementById('delete-selected').disabled");
  await change("filter", "clean");

  await evaluate("document.querySelector('#results input').click(); document.getElementById('retry-selected').click()");
  await until("testCalls.some(call => call.type === 'retryMany') && !document.getElementById('filter').disabled");
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
  const mobile = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(path.join(root, "dist/ui-mobile.png"), Buffer.from(mobile.data, "base64"));
  await evaluate("document.getElementById('tab-settings').click(); document.getElementById('clear').click()");
  await until("testCalls.some(call => call.type === 'clear') && !document.getElementById('clear').disabled");
  await evaluate("document.getElementById('tab-scan').click()");
  await until("document.getElementById('scan-account').options.length === 3");
  await change("scan-account", "test");
  await change("scan-target", "inbox");
  assert.match(await evaluate("document.getElementById('scan-target-label').textContent"), /テストアカウント.*Inbox/);
  assert.equal(await evaluate("document.querySelector('#scan-target option[value=other-inbox]')"), null);
  await evaluate("document.getElementById('scan-folder').click()");
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
  const scanImage = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(path.join(root, "dist/ui-scan.png"), Buffer.from(scanImage.data, "base64"));
  await evaluate("document.getElementById('folder-results').click()");
  assert.equal(await evaluate("document.querySelectorAll('#results tr').length"), 1);
  assert.match(await evaluate("document.getElementById('results').textContent"), /フォルダー検査結果/);
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  const folderImage = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(path.join(root, "dist/ui-folder-progress.png"), Buffer.from(folderImage.data, "base64"));
  await evaluate("document.getElementById('tab-scan').click(); document.getElementById('folder-stop').click()");
  await until("document.getElementById('folder-status').textContent.includes('中止') && document.getElementById('folder-stop').disabled");
  assert.match(await evaluate("document.getElementById('folder-status').textContent"), /未処理75件/);
  await evaluate("testState.folderJob.status = 'interrupted'; document.getElementById('health').click()");
  await until("document.getElementById('folder-status').textContent.includes('中断')");
  assert.equal(await evaluate("document.getElementById('folder-resume').hidden"), false);
  await evaluate("document.getElementById('folder-resume').click()");
  await until("document.getElementById('folder-status').textContent.includes('対象メールを確認中')");
  assert.equal(await evaluate("document.getElementById('folder-delete').disabled"), true);
  assert.equal(await evaluate("testCalls.filter(call => call.type === 'folderResume').length"), 1);
  await evaluate("testState.folderJob.status = 'stopped'; document.getElementById('health').click()");
  await until("!document.getElementById('folder-delete').disabled");
  await evaluate("document.getElementById('folder-delete').click()");
  await until("document.getElementById('folder-delete-dialog').open");
  assert.equal(await evaluate("document.activeElement.id"), "folder-delete-cancel");
  assert.match(await evaluate("document.getElementById('folder-delete-warning').textContent"), /メール本体.*削除しません/);
  await evaluate("document.getElementById('folder-delete-cancel').click()");
  await until("!document.getElementById('folder-delete-dialog').open");
  assert.equal(await evaluate("testCalls.some(call => call.type === 'folderDelete')"), false);
  await evaluate("document.getElementById('folder-delete').click()");
  await until("document.getElementById('folder-delete-dialog').open");
  await evaluate("document.getElementById('folder-delete-confirm').click()");
  await until("document.getElementById('folder-progress').hidden");
  assert.equal(await evaluate("document.getElementById('folder-only').checked"), false);
  assert.equal(await evaluate("document.querySelectorAll('#results tr').length > 0"), true);
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
  await evaluate("document.getElementById('tab-setup').click()");
  assert.match(await evaluate("document.getElementById('installer-command').textContent"), /python3 -I.*0.9.3.*install/);
  assert.equal(await evaluate("document.getElementById('installer-download').tagName"), "BUTTON");
  const downloads = path.join(profile, "downloads");
  await mkdir(downloads, { recursive: true });
  await cdp("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  await evaluate("permissionGranted = false; document.getElementById('installer-download').click()");
  await until("document.getElementById('installation-report').textContent.includes('許可されなかった') && !document.getElementById('installer-download').disabled");
  assert.equal(await evaluate("testCalls.some(call => call.type === 'saveDownload')"), false);
  await evaluate("permissionGranted = true; failSave = true; document.getElementById('installer-download').click()");
  await until("document.getElementById('installation-report').textContent.includes('保存できません') && !document.getElementById('installer-download').disabled");
  await evaluate("failSave = false; document.getElementById('installer-download').click()");
  await until("document.getElementById('installation-report').textContent.includes('保存しました') && !document.getElementById('installer-download').disabled");
  assert.equal(await evaluate("testCalls.filter(call => call.type === 'permission').some(call => call.permissions.includes('downloads'))"), true);
  assert.equal(await evaluate("testCalls.find(call => call.type === 'saveDownload').saveAs"), true);

  let downloaded;
  for (let attempt = 0; attempt < 100; attempt++) {
    downloaded = await readFile(path.join(downloads, "clam-mail-check-installer-0.9.3.pyz")).catch(() => null);
    if (downloaded) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.deepEqual(downloaded, await readFile(path.join(root, "dist/clam-mail-check-installer-0.9.3.pyz")));
  await evaluate("document.getElementById('installation-title').scrollIntoView()");
  const installationImage = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(path.join(root, "dist/ui-installation.png"), Buffer.from(installationImage.data, "base64"));

  assert.equal(await evaluate("document.getElementById('helper-update').hidden"), true);
  assert.match(await evaluate("document.getElementById('helper-action-hint').textContent"), /不要/);
  await evaluate("testState.installation.healthy = false; document.getElementById('helper-check').click()");
  await until("!document.getElementById('helper-update').hidden && !document.getElementById('helper-update').disabled");
  assert.equal(await evaluate("document.getElementById('helper-update').textContent"), "補助プログラムを修復");
  await evaluate("document.getElementById('helper-update').click()");
  await until("document.getElementById('helper-dialog').open");
  assert.equal(await evaluate("document.getElementById('helper-dialog-title').textContent"), "補助プログラムを修復");
  await evaluate("document.getElementById('helper-cancel').click()");
  await until("!document.getElementById('helper-update').disabled");
  await evaluate("testState.installation.version = '0.9.2'; testState.installation.healthy = true; document.getElementById('helper-check').click()");
  await until("document.getElementById('helper-update').textContent.includes('更新') && !document.getElementById('helper-update').disabled");
  await evaluate("document.getElementById('helper-update').click()");
  await until("document.getElementById('helper-dialog').open");
  assert.equal(await evaluate("testCalls.find(call => call.type === 'helperPlan' && call.operation === 'repair').package.length > 0"), true);
  await evaluate("document.getElementById('helper-cancel').click()");
  await until("!document.getElementById('helper-update').disabled");
  await evaluate("document.getElementById('helper-update').click()");
  await until("document.getElementById('helper-dialog').open");
  await evaluate("document.getElementById('helper-ack').click(); document.getElementById('helper-confirm').click()");
  await until("document.getElementById('installation-report').textContent.includes('更新しました') && document.getElementById('helper-update').hidden");
  assert.equal(await evaluate("testCalls.some(call => call.type === 'uninstallSelf')"), false);

  await evaluate("document.getElementById('tab-uninstall').click()");
  assert.equal(await evaluate("document.getElementById('uninstall-steps').hidden"), true);
  await evaluate("document.getElementById('uninstall-start').click()");
  await until("!document.getElementById('uninstall-steps').hidden && !document.getElementById('helper-uninstall').disabled");
  await evaluate("customSaveName = 'saved installer.pyz'; document.getElementById('uninstall-download').click()");
  await until("document.getElementById('uninstall-report').textContent.includes('保存しました') && !document.getElementById('uninstall-download').disabled");
  assert.match(await evaluate("document.getElementById('uninstall-report').textContent"), /synthetic.*saved installer.pyz/);
  assert.equal(await evaluate("document.getElementById('uninstaller-command').textContent"), "python3 -I './saved installer.pyz' uninstall");

  await evaluate("document.getElementById('helper-uninstall').click()");
  await until("document.getElementById('helper-dialog').open");
  assert.equal(await evaluate("document.activeElement.id"), "helper-cancel");
  assert.equal(await evaluate("document.getElementById('helper-confirm').disabled"), true);
  await evaluate("document.getElementById('helper-cancel').click()");
  await until("testCalls.some(call => call.type === 'helperCancel') && !document.getElementById('helper-uninstall').disabled");
  assert.equal(await evaluate("testCalls.filter(call => call.type === 'helperApply').length"), 1);
  await evaluate("document.getElementById('helper-uninstall').click()");
  await until("document.getElementById('helper-dialog').open");
  await evaluate("document.getElementById('helper-ack').click(); document.getElementById('helper-confirm').click()");
  await until("testCalls.some(call => call.type === 'uninstallSelf') && !document.getElementById('remove-extension').hidden && !document.getElementById('remove-extension').disabled");
  assert.equal(await evaluate("testCalls.find(call => call.type === 'uninstallSelf').showConfirmDialog"), true);
  assert.match(await evaluate("document.getElementById('uninstall-report').textContent"), /完了していません/);
  await evaluate("cancelUninstall = false; document.getElementById('remove-extension').click()");
  await until("testCalls.filter(call => call.type === 'uninstallSelf').length === 2 && !document.getElementById('remove-extension').disabled");
  await evaluate("testState.installation = { state: 'legacy' }; testState.helperRemoved = false; document.getElementById('uninstall-start').click()");
  await until("document.getElementById('installation-status').textContent.includes('未対応') && !document.getElementById('uninstall-start').disabled");
  assert.equal(await evaluate("document.getElementById('helper-uninstall').hidden"), true);
  assert.equal(await evaluate("document.getElementById('cli-uninstall-guide').hidden"), false);
  await evaluate("document.getElementById('manual-uninstall-ack').click(); document.getElementById('finish-manual-uninstall').click()");
  await until("testCalls.some(call => call.type === 'helperMarkRemoved' && call.acknowledged === true) && testCalls.filter(call => call.type === 'uninstallSelf').length === 3");
  await evaluate("sessionStorage.setItem('fixture-installation', 'unavailable')");
  await call("Page.reload");
  await until("!document.getElementById('panel-setup').hidden && document.getElementById('installation-status').textContent.includes('接続できません')");
  assert.equal(await evaluate("testCalls.some(call => call.type === 'helperApply' || call.type === 'helperMarkRemoved' || call.type === 'uninstallSelf')"), false);
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
  console.log("UI smoke: passed (six tabs, help/setup/uninstall navigation, folder picker, autosave/rollback, connection history, filters, bulk actions, folder start/cancel/subfolders, progress counters, run filter, stop/interruption/resume/delete, desktop/mobile)");
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
