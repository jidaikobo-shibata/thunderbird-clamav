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
  if (!["dashboard.html", "dashboard.css", "dashboard.js", "core.mjs", "icon.svg"].includes(name)) {
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
    window.confirm = () => true;
    window.testState = {
      ok: true, issue: "", settings: { enabled: false, accountIds: [], notifications: true },
      accounts: [{ id: "test", name: "テストアカウント", type: "imap" }],
      records: [{ key: "test-result", status: "detected", sha256: "test",
        updatedAt: "2026-11-14T09:00:00Z", engine: "ClamAV test",
        signatures: ["Eicar-Test-Signature"], detail: "脅威候補を検出しました。",
        locator: { author: '<img src=x onerror="window.bad=true">', subject: "テスト添付メール" } }]
    };
    window.messenger = { runtime: { sendMessage: async request => {
      testCalls.push(request);
      if (request.type === "state") return testState;
      if (request.type === "health") return { ok: true, health: { status: "ready", engine: "ClamAV test", detail: "接続可能" } };
      if (request.type === "clear") testState.records = [];
      return { ok: true };
    } } };
  ` });
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false });
  await call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/dashboard.html` });
  const ready = await evaluate(`new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (document.querySelector('#results tr')) { clearInterval(timer); resolve(true); }
    }, 50);
    setTimeout(() => { clearInterval(timer); reject(new Error('UI not ready')); }, 5000);
  })`);
  assert.equal(ready, true);
  assert.equal(await evaluate("document.querySelectorAll('#results img').length"), 0);
  assert.equal(await evaluate("Boolean(window.bad)"), false);
  assert.match(await evaluate("document.getElementById('results').textContent"), /<img/);
  await evaluate("document.getElementById('health').click()");
  assert.match(await evaluate("document.getElementById('health-result').textContent"), /ClamAV test/);
  await evaluate(`document.getElementById('enabled').checked = true;
    document.querySelector('#accounts input').checked = true;
    document.getElementById('settings-form').requestSubmit();`);
  assert.equal(await evaluate("testCalls.some(call => call.type === 'settings' && call.settings.accountIds[0] === 'test')"), true);
  await evaluate("document.querySelector('#results button').click()");
  assert.equal(await evaluate("testCalls.some(call => call.type === 'open')"), true);
  await mkdir(path.join(root, "dist"), { recursive: true });
  const desktop = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(path.join(root, "dist/ui-desktop.png"), Buffer.from(desktop.data, "base64"));
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
  const mobile = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(path.join(root, "dist/ui-mobile.png"), Buffer.from(mobile.data, "base64"));
  await evaluate("document.getElementById('clear').click()");
  assert.equal(await evaluate("testCalls.some(call => call.type === 'clear')"), true);
  assert.equal(await evaluate("document.querySelectorAll('#results tr').length"), 0);
  console.log("UI smoke: passed (settings, result opening, history clearing, literal untrusted text, desktop/mobile layout)");
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
