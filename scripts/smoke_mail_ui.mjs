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
const catalogs = Object.fromEntries(await Promise.all(["ja", "en"].map(async language =>
  [language, JSON.parse(await readFile(path.join(root, "thunderbird/_locales", language, "messages.json"), "utf8"))])));
const profile = await mkdtemp(path.join(tmpdir(), "clam-mail-ui-"));
const server = createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname.slice(1);
  if (!["dashboard.html", "dashboard.css", "dashboard.js", "review.mjs", "quarantine.mjs", "quarantine-ui.mjs", "core.mjs", "results.mjs", "folder-scan.mjs", "folder-labels.mjs", "installation.mjs", "i18n.mjs", "installer.pyz", "icon.svg"].includes(name)) {
    response.writeHead(404).end(); return;
  }
  const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml", ".pyz": "application/octet-stream" };
  response.setHeader("Content-Type", types[path.extname(name)]);
  response.end(await readFile(name === "installer.pyz" ? path.join(root, "dist", "clam-mail-check-installer-0.17.3.pyz") : path.join(root, "thunderbird", name)));
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
    const catalogs = ${JSON.stringify(catalogs)};
    const language = sessionStorage.getItem("fixture-language") || "ja";
    const messages = catalogs[language === "ja" ? "ja" : "en"];
    const getMessage = (key, values = []) => {
      const entry = messages[key];
      if (!entry) throw new Error("Missing translation: " + key);
      return entry.message.replace(/\\$([A-Z0-9_]+)\\$/gi, (match, name) => {
        const content = entry.placeholders?.[name.toLowerCase()]?.content;
        return content?.startsWith("$") ? String(values[Number(content.slice(1)) - 1]) : content || match;
      });
    };
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
      installation: { state: sessionStorage.getItem("fixture-installation") || "managed", version: "0.17.3", healthy: true, detail: "導入済み" },
      settings: { enabled: false, accountIds: [], notifications: true },
      accounts: [{ id: "test", name: "テストアカウント", type: "imap" }, { id: "other", name: "別アカウント", type: "imap" }],
      records: [makeRecord("r0", "detected"), makeRecord("r1", "detected", "other"),
        makeRecord("r2", "clean"), makeRecord("r3", "incomplete", "other"),
        makeRecord("r4", "queued"), makeRecord("r5", "deleted"),
        ...Array.from({ length: 55 }, (_, i) => makeRecord("r" + (i + 6), "clean"))] };
    function fixtureHealth() {
      const code = testState.installation.state === "unavailable" ? "helper_unavailable" : sessionStorage.getItem("fixture-health");
      if (code) return { status: "error", code, checkedAt: new Date().toISOString(), detail: getMessage(code === "clamav_missing" ? "clamavMissing" : code === "clamav_unusable" ? "clamavUnusable" : "helperClamavUnknown") };
      return { status: "ready", engine: "ClamAV test", detail: "接続可能", checkedAt: new Date().toISOString() };
    }
    const target = key => { const record = testState.records.find(record => record.key === key);
      return { key, author: record.locator.author, subject: record.locator.subject,
        folder: "/Inbox", accountId: record.locator.accountId, status: record.status, signatures: record.signatures }; };
    let batchKeys = [], forgetKeys = [];
    window.messenger = { i18n: { getUILanguage: () => language, getMessage }, runtime: { getManifest: () => ({ version: "0.17.3" }), getURL: name => "/" + name, sendMessage: async request => {
      testCalls.push(request);
      if (request.type === "state") return structuredClone(testState);
      if (request.type === "helperInfo") {
        testState.lastHealth = fixtureHealth();
        testState.installation.clamavCode = testState.lastHealth.code || "ready";
        return { ok: true, installation: testState.installation, health: testState.lastHealth };
      }
      if (request.type === "helperPlan") { testState.maintenance = true; testState.maintenanceOperation = request.operation; return { ok: true,
        plan: { token: "maintenance-token", operation: request.operation, version: "0.17.3", paths: ["/synthetic/home/.local/lib/clam-mail-check"] } }; }
      if (request.type === "helperCancel") testState.maintenance = false;
      if (request.type === "helperApply") { testState.maintenance = false;
        testState.helperRemoved = testState.maintenanceOperation === "uninstall";
        testState.installation = { state: testState.helperRemoved ? "removed" : "managed", version: "0.17.3", healthy: true,
          detail: testState.helperRemoved ? "補助プログラムを削除しました。" : "補助プログラムを更新しました。", retained: [] };
        return { ok: true, installation: testState.installation }; }
      if (request.type === "helperMarkRemoved") { testState.helperRemoved = true; testState.installation = { state: "removed" }; }

      if (request.type === "settings") {
        if (failSettings) return { ok: false, error: "synthetic storage failure" };
        testState.settings = structuredClone(request.settings);
        for (const record of testState.records) {
          if (record.status === "queued" && record.source === "automatic" && (!request.settings.enabled || !request.settings.accountIds.includes(record.locator.accountId))) {
            record.status = "incomplete"; record.unscannedReason = "automaticExcluded"; record.detail = getMessage("automaticExcludedDetail");
          }
        }
        return { ok: true };
      }
      const fixtureFolders = [
        { id: "inbox", accountId: "test", path: "/Inbox", name: "受信トレイ" },
        { id: "spam", accountId: "test", path: "/Inbox/Spam", name: "迷惑メール", displayNames: ["受信トレイ", "迷惑メール"] },
        { id: "other-inbox", accountId: "other", path: "/Inbox", name: "受信トレイ" }
      ];
      if (request.type === "reviewMany") {
        const { reviewReason } = await import('/review.mjs');
        for (const key of request.keys) {
          const record = testState.records.find(record => record.key === key);
          if (request.reviewed) record.review = { at: new Date().toISOString(), note: request.note, reason: reviewReason(record), resultHash: record.sha256 || null, fingerprint: 'sha256:' + record.sha256 };
          else delete record.review;
        }
        return { ok: true, count: request.keys.length };
      }
      if (request.type === "quarantineMany") {
        for (const key of request.keys) {
          const record = testState.records.find(record => record.key === key), config = testState.settings.quarantine[record.locator.accountId];
          const folder = fixtureFolders.find(folder => folder.id === config.folderId);
          record.locator.folder = folder; record.quarantine = { status: "moved", destination: folder };
        }
        return { ok: true, moved: request.keys.length, failed: 0 };
      }
      if (request.type === "folderChoices") return { ok: true, folders: fixtureFolders };
      if (request.type === "folderContext") {
        const folders = (request.folderIds || ["inbox"]).map(id => fixtureFolders.find(folder => folder.id === id));
        testState.folderRequest = { token: "folder-token", folder: folders[0], folders };
        return { ok: true, ...testState.folderRequest };
      }
      if (request.type === "folderCancel") testState.folderRequest = null;
      if (request.type === "folderStart") {
        const folders = testState.folderRequest.folders;
        testState.folderRequest = null;
        testState.folderJob = { folders, id: "folder-job", status: "collecting", folder: { accountId: "test", path: "/Inbox" },
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
        testState.lastHealth = fixtureHealth();
        testState.installation.clamavCode = testState.lastHealth.code || "ready";
        return { ok: true, health: testState.lastHealth };
      }
      if (request.type === "clear") testState.records = testState.records.filter(record => ["queued", "scanning"].includes(record.status));
      if (request.type === "prepareForget") { forgetKeys = request.keys; return { ok: true, token: "history", targets: forgetKeys.map(target) }; }
      if (request.type === "forgetMany") {
        testState.records = testState.records.filter(record => !forgetKeys.includes(record.key));
        return { ok: true, keys: forgetKeys, count: forgetKeys.length, skipped: 0 };
      }
      if (request.type === "cancelBatch" && testState.batch?.id === request.id) {
        testState.batch.stopRequested = true; testState.batch.active = false;
        testState.batch.cancelled = testState.batch.total - testState.batch.completed;
      }
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
  assert.equal(await evaluate("document.querySelector('#panel-results [data-i18n=mail300]')"), null);
  assert.equal(await evaluate("document.querySelector('#panel-help [data-i18n=mail300]') !== null"), true);

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
  assert.match(await evaluate("document.getElementById('selected-count').textContent"), /1件.*画面外1件/);
  await evaluate("document.getElementById('previous-page').click()");
  await evaluate("document.getElementById('select-page').click()");
  assert.equal(await evaluate("document.getElementById('select-filtered').hidden"), false);
  await evaluate("document.getElementById('select-filtered').click()");
  assert.match(await evaluate("document.getElementById('selected-count').textContent"), /60件/);
  assert.match(await evaluate("document.getElementById('retry-selected').textContent"), /59通/);
  assert.match(await evaluate("document.getElementById('forget-selected').textContent"), /60件/);
  await evaluate("testState.records.push(makeRecord('new-fixed', 'clean'))");
  await until("document.getElementById('summary').textContent.includes('履歴62件')");
  assert.match(await evaluate("document.getElementById('selected-count').textContent"), /60件/);
  await evaluate("testState.records = testState.records.filter(record => record.key !== 'new-fixed'); document.getElementById('deselect').click()");
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
  assert.equal(await evaluate("document.getElementById('enabled')"), null);
  assert.equal(await evaluate("document.getElementById('automatic-status')"), null);
  assert.equal(await evaluate("document.querySelector('[data-i18n=autoAccountsHint], [data-i18n=mail297], [data-i18n=mail298]')"), null);

  assert.equal(await evaluate("document.getElementById('cancel-paused-queue')"), null);
  assert.equal(await evaluate("document.getElementById('clear')"), null);
  assert.equal(await evaluate("document.getElementById('forget-selected').closest('[role=tabpanel]').id"), "panel-results");
  await evaluate("document.querySelector('#accounts input').click()");
  await until("testState.settings.enabled && testState.settings.accountIds.length === 1 && document.getElementById('settings-status').textContent.includes('保存しました') && !document.getElementById('notifications').disabled");
  await evaluate("failSettings = true; document.querySelector('#accounts input').click()");
  await until("document.getElementById('settings-status').textContent.includes('保存できません') && !document.getElementById('notifications').disabled");
  assert.equal(await evaluate("document.querySelector('#accounts input').checked"), true);
  await evaluate("failSettings = true; document.getElementById('notifications').click()");
  await until("document.getElementById('settings-status').textContent.includes('保存できません') && !document.getElementById('notifications').disabled");
  assert.equal(await evaluate("document.getElementById('notifications').checked"), true);
  assert.equal(await evaluate("document.querySelector('#accounts input').checked"), true);
  await evaluate("failSettings = false; document.querySelector('#accounts input').click()");
  await until("!testState.settings.enabled && testState.settings.accountIds.length === 0 && !document.getElementById('notifications').disabled");
  assert.equal(await evaluate("document.getElementById('enabled')"), null);
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
  await until("document.getElementById('action-status').textContent.includes('完全削除1通')");
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
  await evaluate("document.getElementById('tab-results').click(); document.getElementById('reset-filters').click(); document.getElementById('select-page').click(); if (!document.getElementById('select-filtered').hidden) document.getElementById('select-filtered').click(); document.getElementById('forget-selected').click()");
  await until("document.getElementById('delete-dialog').open");
  assert.match(await evaluate("document.getElementById('delete-warning').textContent"), /メール本体は残ります/);
  await evaluate("document.getElementById('delete-ack').click(); document.getElementById('delete-confirm').click()");
  await until("testCalls.some(call => call.type === 'forgetMany') && !document.getElementById('filter').disabled");
  await evaluate("document.getElementById('tab-scan').click()");
  await until("document.getElementById('scan-account').options.length === 3");
  await change("scan-account", "test");
  await evaluate("document.querySelector('#folder-options input[value=inbox]').click()");
  assert.match(await evaluate("document.getElementById('scan-target-label').textContent"), /テストアカウント.*1フォルダー/);
  assert.equal(await evaluate("document.querySelector('#folder-options input[value=other-inbox]')"), null);
  assert.equal(await evaluate("document.querySelector('#folder-options input[value=spam]').parentElement.textContent"), "受信トレイ › 迷惑メール");
  await evaluate("document.getElementById('folder-search').value = '迷惑'; document.getElementById('folder-search').dispatchEvent(new Event('input'))");
  assert.equal(await evaluate("document.querySelectorAll('#folder-options input').length"), 1);
  await evaluate("document.getElementById('folder-select-visible').click()");
  assert.match(await evaluate("document.getElementById('folder-selection-count').textContent"), /選択2.*表示外の選択1/);
  await evaluate("document.getElementById('folder-search').value = '見つからない'; document.getElementById('folder-search').dispatchEvent(new Event('input'))");
  assert.equal(await evaluate("document.querySelectorAll('#folder-options input').length"), 0);
  assert.match(await evaluate("document.getElementById('folder-selection-count').textContent"), /選択2.*表示外の選択2/);
  await evaluate("document.getElementById('folder-search').value = ''; document.getElementById('folder-search').dispatchEvent(new Event('input'))");
  assert.equal(await evaluate("document.querySelectorAll('#folder-options input:checked').length"), 2);

  await evaluate("document.getElementById('scan-folder').click()");
  await until("document.getElementById('folder-dialog').open");
  assert.equal(await evaluate("document.getElementById('folder-subfolders').checked"), false);
  assert.equal(await evaluate("document.querySelectorAll('#folder-target-list li').length"), 2);
  assert.deepEqual(await evaluate("testCalls.find(call => call.type === 'folderContext').folderIds"), ["inbox", "spam"]);

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
  await change("scan-account", "other");
  assert.equal(await evaluate("document.querySelectorAll('#folder-options input:checked').length"), 0);
  await change("scan-account", "test");
  await evaluate("document.getElementById('folder-select-visible').click(); document.getElementById('folder-clear-selection').click()");
  assert.equal(await evaluate("document.querySelectorAll('#folder-options input:checked').length"), 0);
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
  assert.match(await evaluate("document.getElementById('installer-command').textContent"), /python3 -I.*0.17.3.*install/);
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
    downloaded = await readFile(path.join(downloads, "clam-mail-check-installer-0.17.3.pyz")).catch(() => null);
    if (downloaded) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.deepEqual(downloaded, await readFile(path.join(root, "dist/clam-mail-check-installer-0.17.3.pyz")));
  await evaluate("document.getElementById('installation-title').scrollIntoView()");
  const installationImage = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(path.join(root, "dist/ui-installation.png"), Buffer.from(installationImage.data, "base64"));

  assert.equal(await evaluate("document.getElementById('helper-task').classList.contains('needs-action')"), false);
  assert.equal(await evaluate("document.getElementById('helper-update').hidden"), true);
  assert.match(await evaluate("document.getElementById('helper-action-hint').textContent"), /不要/);
  await evaluate("testState.installation.healthy = false; document.getElementById('helper-check').click()");
  await until("!document.getElementById('helper-update').hidden && !document.getElementById('helper-update').disabled");
  assert.equal(await evaluate("document.getElementById('helper-update').textContent"), "補助プログラムを修復");
  await evaluate("document.getElementById('installation-title').scrollIntoView({block:'start'})");
  const taskImage = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(path.join(root, "dist/ui-setup-action.png"), Buffer.from(taskImage.data, "base64"));
  assert.equal(await evaluate("document.getElementById('helper-task').classList.contains('needs-action')"), true);
  assert.equal(await evaluate("document.getElementById('helper-install-steps').open"), false);
  assert.equal(await evaluate("document.getElementById('helper-task').compareDocumentPosition(document.getElementById('connection-title')) & Node.DOCUMENT_POSITION_FOLLOWING"), 4);
  await evaluate("document.getElementById('helper-update').click()");
  await until("document.getElementById('helper-dialog').open");
  assert.equal(await evaluate("document.getElementById('helper-dialog-title').textContent"), "補助プログラムを修復");
  await evaluate("document.getElementById('helper-cancel').click()");
  await until("!document.getElementById('helper-update').disabled");
  await evaluate("testState.installation.version = '0.9.2'; testState.installation.healthy = true; document.getElementById('helper-check').click()");
  await until("document.getElementById('helper-update').textContent.includes('更新') && !document.getElementById('helper-update').disabled");
  await evaluate("document.getElementById('tab-scan').click()");
  assert.equal(await evaluate("document.getElementById('setup-dot').hidden"), false);
  assert.equal(await evaluate("document.getElementById('tab-setup').textContent"), "セットアップ");
  assert.match(await evaluate("document.getElementById('tab-setup').getAttribute('aria-label')"), /更新/);
  await evaluate("document.getElementById('tab-setup').click()");
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
  assert.equal(await evaluate("document.getElementById('uninstaller-command').textContent"), "python3 -I './saved installer.pyz' uninstall --language ja");

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
  assert.equal(await evaluate("document.getElementById('helper-install-steps').open && document.getElementById('helper-task').classList.contains('needs-action')"), true);
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
  await evaluate("sessionStorage.setItem('fixture-language', 'en-US'); sessionStorage.removeItem('fixture-installation')");
  await call("Page.reload");
  await until("document.documentElement.lang === 'en-US' && document.querySelector('#tab-setup').textContent === 'Setup' && document.querySelector('#results tr')");
  assert.equal(await evaluate("document.title"), "ClamAV Mail Check");
  assert.match(await evaluate("document.getElementById('delete-selected').textContent"), /Permanently delete messages/);
  assert.match(await evaluate("document.getElementById('delete-warning').textContent"), /cannot be undone.*IMAP/);
  assert.equal(await evaluate("document.getElementById('search').placeholder"), "Sender, subject, detection name, etc.");
  assert.equal(await evaluate("document.getElementById('folder-bar').getAttribute('aria-label')"), "Processed messages in the folder scan");
  assert.match(await evaluate("document.getElementById('uninstaller-command').textContent"), /--language en-US$/);
  // Existing saved Japanese details and actual sender/subject text are preserved.
  assert.match(await evaluate("document.getElementById('results').textContent"), /脅威候補を検出しました/);
  await evaluate("document.getElementById('tab-help').click()");
  assert.match(await evaluate("document.getElementById('panel-help').textContent"), /Encrypted messages are not decrypted/);
  await evaluate("testState.installation.version = '0.9.5'; document.getElementById('helper-check').click()");
  await until("document.getElementById('helper-update').textContent === 'Update helper' && !document.getElementById('helper-update').disabled");
  assert.equal(await evaluate("document.getElementById('setup-dot').hidden"), false);
  assert.match(await evaluate("document.getElementById('tab-setup').getAttribute('aria-label')"), /helper update/);
  await evaluate("document.getElementById('tab-setup').click(); document.getElementById('helper-update').click()");
  await until("document.getElementById('helper-dialog').open");
  assert.match(await evaluate("document.getElementById('helper-dialog-detail').textContent"), /Messages, settings, and scan history will be kept/);
  assert.equal(await evaluate("document.getElementById('helper-confirm').disabled"), true);
  await evaluate("document.getElementById('helper-cancel').click()");
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate("document.getElementById('tab-scan').click(); window.scrollTo(0, 0)");
  await new Promise(resolve => setTimeout(resolve, 100));
  const englishDesktop = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(path.join(root, "dist/ui-en-desktop.png"), Buffer.from(englishDesktop.data, "base64"));
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate("document.getElementById('tab-setup').click(); window.scrollTo(0, 0)");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
  const englishMobile = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(path.join(root, "dist/ui-en-mobile.png"), Buffer.from(englishMobile.data, "base64"));
  await evaluate("document.getElementById('tab-settings').click()");
  assert.equal(await evaluate("document.getElementById('automatic-status')"), null);
  assert.match(await evaluate("document.getElementById('settings-form').textContent"), /Accounts to scan new messages automatically/);
  await evaluate("document.querySelector('#accounts input').click()");
  await until("testState.settings.enabled && !document.getElementById('notifications').disabled");
  await evaluate("window.scrollTo(0, 0)");
  const englishAccounts = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(path.join(root, "dist/ui-en-accounts.png"), Buffer.from(englishAccounts.data, "base64"));
  assert.equal(await evaluate("document.querySelectorAll('#panel-settings fieldset').length"), 3);
  assert.equal(await evaluate("document.getElementById('panel-settings').contains(document.getElementById('forget-selected'))"), false);
  await evaluate("testState.records.push({ ...makeRecord('excluded-ui', 'queued'), source: 'automatic', attempts: 0, sha256: null }); document.querySelector('#accounts input').click()");
  await until("testState.records.some(record => record.key === 'excluded-ui' && record.unscannedReason === 'automaticExcluded') && !document.getElementById('notifications').disabled");
  await evaluate("document.getElementById('tab-results').click()");
  await change("filter", "automatic-excluded");
  await until("document.querySelectorAll('#results tr').length === 1 && document.getElementById('results').textContent.includes('Not scanned because')");
  assert.match(await evaluate("document.getElementById('results').textContent"), /Unscanned: removed from automatic scanning/);
  await evaluate("document.getElementById('select-page').click()");
  assert.equal(await evaluate("document.getElementById('retry-selected').disabled"), false);
  assert.equal(await evaluate("document.getElementById('delete-selected').disabled"), false);
  await evaluate("document.getElementById('forget-selected').click()");
  await until("document.getElementById('delete-dialog').open");
  await evaluate("document.getElementById('delete-ack').click(); document.getElementById('delete-confirm').click()");
  await until("!testState.records.some(record => record.key === 'excluded-ui') && !document.getElementById('filter').disabled");
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate("testState.records = Array.from({length: 1000}, (_, i) => makeRecord('large' + i, i % 10 === 0 ? 'deleted' : 'clean')); document.getElementById('reset-filters').click()");
  await until("document.getElementById('summary').textContent.includes('History: 1000')");
  await evaluate("document.getElementById('select-page').click()");
  assert.match(await evaluate("document.getElementById('select-filtered').textContent"), /1000/);
  await evaluate("document.getElementById('select-filtered').click(); document.getElementById('next-page').click()");
  assert.equal(await evaluate("document.querySelectorAll('#results tr').length"), 50);
  assert.equal(await evaluate("document.querySelectorAll('#results input:checked').length"), 50);
  assert.match(await evaluate("document.getElementById('selected-count').textContent"), /1000.*950/);
  assert.match(await evaluate("document.getElementById('retry-selected').textContent"), /900/);
  await evaluate("window.scrollTo(0, 0)");
  const selectionImage = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(path.join(root, "dist/ui-selection-desktop.png"), Buffer.from(selectionImage.data, "base64"));
  await evaluate("document.getElementById('forget-selected').click()");
  await until("document.getElementById('delete-dialog').open");
  assert.equal(await evaluate("document.querySelectorAll('#delete-targets li').length"), 1000);
  assert.match(await evaluate("document.getElementById('delete-warning').textContent"), /Messages themselves will remain/);
  await evaluate("document.getElementById('delete-cancel').click()");
  await until("!document.getElementById('filter').disabled");
  assert.equal(await evaluate("testState.records.length"), 1000);
  await change("filter", "deleted");
  assert.match(await evaluate("document.getElementById('selected-count').textContent"), /Selected: 0/);
  await evaluate("document.getElementById('select-page').click(); document.getElementById('select-filtered').click()");
  assert.equal(await evaluate("document.getElementById('retry-selected').disabled"), true);
  assert.equal(await evaluate("document.getElementById('delete-selected').disabled"), true);
  assert.equal(await evaluate("document.getElementById('forget-selected').disabled"), false);
  await evaluate("document.getElementById('forget-selected').click()");
  await until("document.getElementById('delete-dialog').open");
  await evaluate("document.getElementById('delete-ack').click(); document.getElementById('delete-confirm').click()");
  await until("testState.records.length === 900 && !document.getElementById('filter').disabled");
  await evaluate("testState.batch = { id: 'mock-progress', operation: 'delete', phase: 'execute', active: true, stopRequested: false, total: 1000, completed: 7, failed: 0 }");
  await until("!document.getElementById('batch-stop').hidden");
  await evaluate("document.getElementById('batch-stop').click()");
  await until("testCalls.some(call => call.type === 'cancelBatch' && call.id === 'mock-progress') && document.getElementById('batch-stop').hidden");
  for (const language of ["ja", "en-US"]) {
    await evaluate(`sessionStorage.setItem('fixture-language', '${language}'); sessionStorage.setItem('fixture-health', 'clamav_missing'); sessionStorage.removeItem('fixture-installation')`);
    await call("Page.reload");
    await until("document.getElementById('clamav-install-guide').open && document.getElementById('health-result').textContent.includes('/usr/bin/clamscan')");
    await evaluate("document.getElementById('tab-setup').click()");
    assert.equal(await evaluate("document.getElementById('clamav-install-guide').hidden"), false);
    assert.match(await evaluate("document.getElementById('clamav-install-guide').textContent"), /sudo apt install clamav clamav-daemon clamav-freshclam/);
    assert.equal(await evaluate("document.getElementById('setup-dot').hidden"), false);
    if (language === "ja") {
      await evaluate("window.scrollTo(0, 0)");
      const image = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await writeFile(path.join(root, "dist/ui-clamav-missing.png"), Buffer.from(image.data, "base64"));
    }
    await evaluate("sessionStorage.setItem('fixture-health', 'clamav_unusable'); document.getElementById('health').click()");
    await until("document.getElementById('clamav-install-guide').dataset.code === 'clamav_unusable' && !document.getElementById('health').disabled");
    await evaluate("testState.installation.state = 'unavailable'; document.getElementById('health').click()");
    await until("document.getElementById('clamav-install-guide').dataset.code === 'helper_unavailable' && !document.getElementById('health').disabled");
    assert.match(await evaluate("document.getElementById('health-result').textContent"), language === "ja" ? /有無はまだ確認できません/ : /Cannot determine whether ClamAV/);
    await evaluate("sessionStorage.removeItem('fixture-health'); testState.installation.state = 'managed'; document.getElementById('health').click()");
    await until("document.getElementById('clamav-install-guide').hidden && !document.getElementById('health').disabled");
    assert.equal(await evaluate("document.getElementById('setup-dot').hidden"), true);
  }

  for (const language of ["ja", "en-US"]) {
    await evaluate(`sessionStorage.setItem('fixture-language', '${language}'); sessionStorage.removeItem('fixture-health'); sessionStorage.removeItem('fixture-installation')`);
    await call("Page.reload");
    await until("document.querySelectorAll('#quarantine-settings select').length === 2 && document.querySelector('#quarantine-settings select').options.length > 1");
    await evaluate("document.getElementById('tab-settings').click()");
    assert.equal(await evaluate("document.querySelector('#quarantine-settings input').checked"), false);
    await evaluate("const input = document.querySelector('#quarantine-settings select'); input.value = 'spam'; input.dispatchEvent(new Event('change', {bubbles:true}))");
    await until("testState.settings.quarantine?.test?.folderId === 'spam' && !document.querySelector('#quarantine-settings input').disabled");
    await evaluate("permissionGranted = false; document.querySelector('#quarantine-settings input').click()");
    await until("!document.querySelector('#quarantine-settings input').disabled && !document.querySelector('#quarantine-settings input').checked");
    assert.equal(await evaluate("testState.settings.quarantine.test.auto"), false);
    await evaluate("permissionGranted = true; document.querySelector('#quarantine-settings input').click()");
    await until("testState.settings.quarantine.test.auto === true && !document.querySelector('#quarantine-settings input').disabled");
    assert.equal(await evaluate("testCalls.some(call => call.type === 'permission' && call.permissions.includes('messagesMove'))"), true);
    if (language === "ja") {
      await evaluate("window.scrollTo(0,0)");
      const image = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      await writeFile(path.join(root, "dist/ui-quarantine-settings.png"), Buffer.from(image.data, "base64"));
    }
    await evaluate("document.getElementById('tab-results').click(); document.querySelector('#results input').click(); document.getElementById('quarantine-selected').click()");
    await until("document.getElementById('quarantine-dialog').open");
    assert.equal(await evaluate("document.querySelectorAll('#quarantine-targets li').length"), 1);
    assert.equal(await evaluate("document.querySelectorAll('#quarantine-targets img').length"), 0);
    await evaluate("document.getElementById('quarantine-cancel').click()");
    await until("!document.getElementById('quarantine-dialog').open && !document.getElementById('quarantine-selected').disabled");
    assert.equal(await evaluate("testCalls.some(call => call.type === 'quarantineMany')"), false);
    await evaluate("document.getElementById('quarantine-selected').click()");
    await until("document.getElementById('quarantine-dialog').open");
    await evaluate("document.querySelector('#quarantine-dialog button[value=move]').click()");
    await until("document.querySelector('#results .detail').textContent.includes('" + (language === "ja" ? "隔離先へ移動済み" : "Moved to quarantine") + "')");
    assert.equal(await evaluate("testCalls.find(call => call.type === 'quarantineMany').keys.length"), 1);
    assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);

    await evaluate("testState.records[0].locator.folder = { id: 'inbox', accountId: 'test', path: '/Inbox' }");
    await until("document.querySelector('#results .detail').textContent.includes('" + (language === "ja" ? "隔離先の外へ移動済み" : "Moved out of the quarantine folder") + "')");
    await evaluate("testState.settings.quarantine = { test: { folderId: 'gone', path: '/Gone', auto: true }, other: { folderId: 'gone-two', path: '/GoneTwo', auto: true } }; permissionGranted = false; document.getElementById('tab-settings').click()");
    await until("[...document.querySelectorAll('#quarantine-settings select')].every(input => input.value.startsWith('gone'))");
    const permissionCount = await evaluate("testCalls.filter(call => call.type === 'permission').length");
    await evaluate("document.getElementById('notifications').click()");
    await until("testState.settings.notifications === false && !document.getElementById('notifications').disabled");
    await evaluate("document.querySelector('#quarantine-settings input').click()");
    await until("testState.settings.quarantine.test.auto === false && !document.getElementById('notifications').disabled");
    await evaluate("document.querySelectorAll('#quarantine-settings input')[1].click()");
    await until("testState.settings.quarantine.other.auto === false && !document.getElementById('notifications').disabled");
    assert.equal(await evaluate("testCalls.filter(call => call.type === 'permission').length"), permissionCount);
  }

  for (const language of ["ja", "en-US"]) {
    await evaluate(`sessionStorage.setItem('fixture-language', '${language}'); sessionStorage.removeItem('fixture-health'); sessionStorage.removeItem('fixture-installation')`);
    await call("Page.reload");
    await until("document.querySelectorAll('#results tr').length === 50");
    await evaluate("document.getElementById('tab-results').click()");
    await change("filter", "incomplete");
    await evaluate("document.getElementById('select-page').click(); document.getElementById('review-selected').click()");
    await until("document.getElementById('review-dialog').open");
    assert.equal(await evaluate("document.activeElement.id"), "review-cancel");
    assert.equal(await evaluate("document.querySelectorAll('#review-targets li').length"), 1);
    await evaluate("document.getElementById('review-cancel').click()");
    await until("!document.getElementById('review-dialog').open && !document.getElementById('review-selected').disabled");
    assert.equal(await evaluate("testCalls.some(call => call.type === 'reviewMany')"), false);
    await evaluate("document.getElementById('review-selected').click()");
    await until("document.getElementById('review-dialog').open");
    await evaluate("document.getElementById('review-note').value = 'Known source <img src=x>'; document.getElementById('review-confirm').click()");
    await until("testState.records.find(record => record.key === 'r3').review && document.getElementById('tab-results').textContent.includes('2')");
    assert.match(await evaluate("document.querySelector('#results .detail').textContent"), /Known source/);
    assert.equal(await evaluate("document.querySelectorAll('#results img').length"), 0);
    await change("filter", "attention");
    assert.equal(await evaluate("document.querySelectorAll('#results tr').length"), 2);
    await change("filter", "reviewed");
    assert.equal(await evaluate("document.querySelectorAll('#results tr').length"), 1);
    assert.equal(await evaluate("document.querySelector('#results tr').dataset.attention"), "false");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#results tr')).backgroundColor"), "rgba(0, 0, 0, 0)");
    if (language === "ja") {
      await evaluate("window.scrollTo(0,0)");
      const image = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      await writeFile(path.join(root, "dist/ui-reviewed-results.png"), Buffer.from(image.data, "base64"));
    }
    await evaluate("document.getElementById('select-page').click(); document.getElementById('unreview-selected').click()");
    await until("document.getElementById('review-dialog').open");
    assert.equal(await evaluate("document.getElementById('review-note').disabled"), true);
    await evaluate("document.getElementById('review-confirm').click()");
    await until("!testState.records.find(record => record.key === 'r3').review && document.getElementById('tab-results').textContent.includes('3')");
    assert.equal(await evaluate("document.querySelectorAll('#results tr').length"), 0);
    await change("filter", "incomplete");
    assert.equal(await evaluate("document.querySelector('#results button').textContent"), language === "ja" ? "開く" : "Open");
    assert.equal(await evaluate("document.querySelector('#results .review-action').textContent"), language === "ja" ? "確認済み" : "Mark reviewed");
    assert.equal(await evaluate("document.querySelector('#results input').checked"), false);
    assert.equal(await evaluate("document.querySelector('#results button').getBoundingClientRect().height <= 50"), true);
    if (language === "ja") {
      await evaluate("window.scrollTo(0,0)");
      const image = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      await writeFile(path.join(root, "dist/ui-individual-review.png"), Buffer.from(image.data, "base64"));
    }
    await evaluate("document.querySelector('#results .review-action').click()");
    await until("document.getElementById('review-dialog').open");
    assert.equal(await evaluate("document.querySelectorAll('#review-targets li').length"), 1);
    await evaluate("document.getElementById('review-confirm').click()");
    await until("testState.records.find(record => record.key === 'r3').review && !document.querySelector('#results .review-action').disabled");
    assert.equal(await evaluate("document.querySelector('#results .review-action').textContent"), language === "ja" ? "未確認に" : "Unreview");
    await evaluate("document.querySelector('#results .review-action').click()");
    await until("document.getElementById('review-dialog').open");
    await evaluate("document.getElementById('review-confirm').click()");
    await until("!testState.records.find(record => record.key === 'r3').review && !document.querySelector('#results .review-action').disabled");
    await change("filter", "detected");
    assert.equal(await evaluate("[...document.querySelectorAll('#results .review-action')].every(button => button.hidden)"), true);
  }

  await evaluate("sessionStorage.setItem('fixture-language', 'ja')");
  await call("Page.reload");
  await until("document.querySelectorAll('#results tr').length === 50");
  await evaluate("testState.records = testState.records.slice(0,4); testState.records[1].status = 'error'; document.getElementById('tab-results').click()");
  await until("document.querySelectorAll('#results tr').length === 4");
  for (const scheme of ["light", "dark"]) {
    await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    assert.equal(await evaluate("document.querySelectorAll('#results tr[data-attention=true]').length"), 3);
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('#results tr')).backgroundColor"), "rgba(0, 0, 0, 0)");
    assert.equal(await evaluate("document.querySelector('#results tr[data-status=clean]').dataset.attention"), "false");
    await evaluate("document.querySelector('#results input').click()");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#results tr')).outlineStyle"), "solid");
    await evaluate("document.querySelector('#results input').click(); window.scrollTo(0,0)");
    const image = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await writeFile(path.join(root, 'dist/ui-attention-' + scheme + '.png'), Buffer.from(image.data, "base64"));
  }
  console.log("UI smoke: passed (Japanese/English, six tabs, help/setup/uninstall navigation, folder picker, autosave/rollback, connection history, filters, bulk actions, folder start/cancel/subfolders, progress counters, run filter, stop/interruption/resume/delete, desktop/mobile)");
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
