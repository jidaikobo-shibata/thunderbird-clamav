import { NativeClient, sha256 } from "../core.mjs";
import { reviewStamp } from "../review.mjs";
const check = (value, message) => { if (!value) throw new Error(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(type, values = {}) {
  const response = await messenger.runtime.sendMessage({ type, ...values });
  if (!response.ok) throw new Error(type + ": " + response.error);
  return response;
}
async function settled(predicate, seconds = 360) {
  const deadline = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < deadline) {
    const state = last = await request("state");
    if (predicate(state)) return state;
    await wait(100);
  }
  report.timeoutState = { issue: last?.issue, records: last?.records.map(record => ({key:record.key, status:record.status, subject:record.locator.subject, detail:record.detail, quarantine:record.quarantine})), folderJob:last?.folderJob };
  throw new Error("Mail integration did not settle");
}
async function recoveryScenario() {
  const failure = await messenger.runtime.sendMessage({type:'state'});
  check(!failure.ok && failure.startupFailed,'Startup failure is recoverable');
  for(let i=0;i<100 && !document.getElementById('health-result').textContent.includes('synthetic startup storage failure');i++) await wait(100);
  check(!document.getElementById('panel-settings').hidden,'Recovery instructions are visible');
  check(document.getElementById('notifications').disabled,'Settings are locked before recovery');
  check(!document.getElementById('health').disabled,'Recovery button remains usable');
  document.getElementById('health').click();
  const state = await settled(state=>state.records.some(record=>record.key==='preserved-review'));
  check(state.records[0].review.note==='Synthetic human decision','Startup recovery retains human notes');
  for(let i=0;i<100 && document.getElementById('notifications').disabled;i++) await wait(100);
  check(!document.getElementById('notifications').disabled,'Recovery unlocks settings');
  const fixture=await messenger.testFixture.prepare();
  const before=await messenger.storage.local.get(['folderJob','folderCheckpoint','records']);
  const context=await request('folderContext',{folderId:fixture.source.id});
  const failed=await messenger.runtime.sendMessage({type:'folderStart',token:context.token,includeSubfolders:false});
  check(!failed.ok && failed.error.includes('synthetic folder start failure'),'New start fails at persistence');
  const after=await request('state');
  check(JSON.stringify(after.folderJob)===JSON.stringify(state.folderJob),'Old progress is retained in memory');
  check(JSON.stringify(after.records)===JSON.stringify(state.records),'No mail history is replaced');
  check(JSON.stringify(await messenger.storage.local.get(['folderJob','folderCheckpoint','records']))===JSON.stringify(before),'Persistent progress and checkpoint remain intact');
  const held=new NativeClient(messenger.runtime);
  await held.request('health');
  report.recovery=true;
  report.runtime=await messenger.testFixture.runtime();
  report.ok=true;
  await messenger.testFixture.report(JSON.stringify(report));
}

const report = { ok: false, version: messenger.runtime.getManifest().version };
try {
  const options = await (await fetch(messenger.runtime.getURL("fixture/options.json"))).json();
  if (options.scenario === "recovery") { await recoveryScenario(); } else {
  let state = await request("state");
  const fixture = await messenger.testFixture.prepare();
  check(state.installation.state === "integrated", "Integrated scanner state");
  if (["missing", "no-python"].includes(options.scenario)) {
    const missingPython = options.scenario === "no-python";
    check(state.lastHealth.code === (missingPython ? "direct_unavailable" : "clamav_missing"), "Missing prerequisite: " + JSON.stringify(state.lastHealth));
    const saved = () => messenger.storage.local.get(["folderJob", "folderCheckpoint", "records"]);
    const guide = document.getElementById("clamav-install-guide");
    if ((await messenger.runtime.getPlatformInfo()).os === "win") {
      for (let i = 0; i < 100 && (!guide.open || guide.hidden); i++) await wait(100);
      check(guide.open && !guide.hidden && guide.textContent.includes("freshclam.exe"), "Windows installation guide is visible");
      const heading = missingPython ? "Install ClamAV on Windows" : "ClamAV の導入方法（Windows）";
      check(guide.querySelector("summary").textContent === heading, "Localized Windows guide: " + guide.querySelector("summary").textContent);
    }
    const previous = JSON.stringify(await saved());
    const context = await request("folderContext", { folderId: fixture.source.id });
    const response = await messenger.runtime.sendMessage({type:"folderStart",token:context.token,includeSubfolders:false});
    check(!response.ok && response.setupRequired, "Missing scanner blocks folder start");
    state = await request("state");
    const resume = await messenger.runtime.sendMessage({type:"folderResume",jobId:state.folderJob.id});
    check(!resume.ok && resume.setupRequired, "Missing scanner blocks resume");
    check(JSON.stringify(await saved()) === previous, "Missing scanner preserves records, review notes and progress");
    if (!missingPython) {
      const held = new NativeClient(messenger.runtime);
      check((await held.request("health")).code === "clamav_missing", "Missing scanner never reports clean");
    }
    report.missingScanner = true;
    report.runtime = await messenger.testFixture.runtime();
    report.ok = true;
    await messenger.testFixture.report(JSON.stringify(report));
  } else {
  check(state.lastHealth.status === "ready", "Health ready: " + JSON.stringify(state.lastHealth));
  check(!state.settings.notifications, "Notification preference retained");
  if (report.version === "0.20.0a1" || options.scenario !== "full") {
    check(state.settings.accountIds.includes(fixture.accountId), "Enabled account retained");
  }
  check(state.records.find(record => record.key === "preserved-review")?.review.note === "Synthetic human decision", "Human decision retained");
  const backup = await messenger.testFixture.backup(state.directMigrationBackup.path);
  check(backup.storage.records.length === 1 && backup.storage.records[0].review.note === "Synthetic human decision", "Pre-migration backup retained");
  report.migration = true;
  await messenger.testFixture.report(JSON.stringify({...report,running:true}));
  if (["quit", "uninstall", "disable", "guardian", "worker"].includes(options.scenario)) {
    report.lifecycleOnly = true;
  } else if (report.version === "0.20.0a1") {
    report.rawSamples = [];
    for (const message of (await messenger.messages.list(fixture.source.id)).messages) {
      try { const raw = await messenger.messages.getRaw(message.id, { data_format: "File", decrypt: false }); report.rawSamples.push({subject:message.subject,size:raw.size,start:(await raw.text()).slice(0,500)}); }
      catch(error) {report.rawSamples.push({subject:message.subject,error:String(error)});}
    }
    const context = await request("folderContext", { folderId: fixture.source.id });
    await request("folderStart", { token: context.token, includeSubfolders: false });
    state = await settled(state => state.folderJob?.status === "completed");
    await wait(200);
    report.completedSessions = await messenger.testFixture.idle();
    const results = Object.fromEntries(state.records.filter(record => record.source === "folder").map(record => [record.locator.subject, record.status]));
    report.verdicts = results;
    await messenger.testFixture.report(JSON.stringify({...report,running:true}));
    report.scanDetails = state.records.filter(record => record.source === "folder").map(record => ({ subject: record.locator.subject, status: record.status, detail: record.detail }));
    check(results["Synthetic plain"] === "clean", "Normal message verdict");
    check(results["Synthetic attachment"] === "detected", "EICAR attachment verdict");
    check(results["Synthetic zip"] === "detected", "EICAR ZIP verdict");
    check(results["Synthetic encrypted"] === "incomplete", "Encrypted mail coverage");
    report.verdicts = results;
    let incomplete = state.records.find(record => record.locator.subject === "Synthetic encrypted");
    await request("reviewMany", { keys: [incomplete.key], reviewed: true, note: "Synthetic reviewed encryption", stamps: { [incomplete.key]: reviewStamp(incomplete) } });
    report.stage = "rescan";
    await request("retry", { key: incomplete.key });
    state = await settled(state => state.records.find(record => record.key === incomplete.key)?.status === "incomplete");
    await wait(200);
    check(state.records.find(record => record.key === incomplete.key).review?.note === "Synthetic reviewed encryption", "Review retained on identical rescan");
    report.rescanCleanup = await messenger.testFixture.idle();
    let threat = state.records.find(record => record.locator.subject === "Synthetic attachment");
    await messenger.testFixture.failNextScan();
    await request("retry", {key:threat.key});
    state = await settled(value => value.records.find(row => row.key === threat.key)?.lastAttempt?.status === "error");
    const previousThreat = state.records.find(row => row.key === threat.key);
    check(previousThreat.status === "detected" && previousThreat.sha256 === threat.sha256 &&
      JSON.stringify(previousThreat.signatures) === JSON.stringify(threat.signatures) &&
      state.records.find(row => row.key === incomplete.key)?.review?.note === "Synthetic reviewed encryption",
      "Failed rescan preserves detection, signatures and review history");
    await messenger.testFixture.idle();
    report.failedRescan = true;
    report.stage = "quarantine";
    const moved = await request("quarantineMany", { keys: [threat.key], hashes: { [threat.key]: threat.sha256 }, destinations: state.settings.quarantine });
    check(moved.moved === 1, "Manual quarantine");
    state = await request("state");
    threat = state.records.find(record => record.key === threat.key);
    check(threat.locator.folder.path === fixture.quarantine.path, "Quarantine location verified");
    report.stage = "delete";
    const deletion = await request("prepareDelete", { key: threat.key });
    await request("deletePermanently", { key: threat.key, token: deletion.token });
    state = await request("state");
    check(state.records.find(record => record.key === threat.key).status === "deleted", "Permanent deletion");
    const settings = structuredClone(state.settings);
    settings.quarantine[fixture.accountId].auto = true;
    await request("settings", { settings });
    const incomingRaw = fixture.mails.attachment.replace(/Subject: [^\r\n]+/, "Subject: Synthetic incoming attachment").replace(/Message-ID: [^\r\n]+/i, "Message-ID: <incoming-attachment@example.invalid>");
    report.stage = "automatic";
    await messenger.testFixture.report(JSON.stringify({...report,running:true}));
    const incoming = await messenger.messages.import(new File([incomingRaw], "incoming.eml", { type: "message/rfc822" }), fixture.source.id, { read: false, new: true });
    await messenger.testFixture.inject(incoming.id);
    state = await settled(state => state.records.some(record => record.source === "automatic" && record.locator.subject === "Synthetic incoming attachment" && record.quarantine?.status === "moved"));
    report.automaticQuarantine = true;
    report.reviewAndDeletion = true;
    await request("settings", { settings: { ...state.settings, scanSettings: { phishing: "display", macros: "notify", pua: "display", mailMiB: 50, expandedMiB: 200, seconds: 90 } } });
    const client = new NativeClient(messenger.runtime);
    try {
      const bytes = new TextEncoder().encode("Subject: synthetic custom policy\r\n\r\nhello");
      const result = await client.scan(bytes, await sha256(bytes), { phishing: "display", macros: "notify", pua: "display", mailMiB: 50, expandedMiB: 200, seconds: 90 });
      check(result.status === "clean" && result.scanSettings.mailMiB === 50, "Custom policy applied");
      report.customPolicy = true;
    } finally { client.close(); }
    const stopContext = await request("folderContext", {folderId:fixture.source.id});
    await request("folderStart", {token:stopContext.token,includeSubfolders:false});
    state = await request("state");
    await request("folderStop", {jobId:state.folderJob.id});
    state = await settled(value => value.folderJob?.status === "stopped");
    report.cancelledSessions = await messenger.testFixture.idle();
    report.cancellation = true;
    await request("folderResume", {jobId:state.folderJob.id});
    state = await settled(value => value.folderJob?.status === "completed");
    await messenger.testFixture.idle();
    await request("settings", {settings:{...state.settings, enabled:false}});
    report.resumed = true;
  } else {
    check(state.settings.scanSettings.mailMiB === 50 && state.settings.quarantine[fixture.accountId].auto, "Updated settings retained");
    check(state.records.some(record => record.status === "deleted") && state.records.some(record => record.quarantine?.status === "moved"), "Updated result history retained");
    check(!state.settings.enabled, "Automatic scanning stays disabled after update");
    report.experimentalUpdate = true;
  }
  // Leave one actual clamd alive so the launcher can verify update/crash cleanup.
  const retained = new NativeClient(messenger.runtime);
  const sample = new TextEncoder().encode("Subject: synthetic lifecycle\r\n\r\nhello");
  check((await retained.scan(sample, await sha256(sample), state.settings.scanSettings)).status === "clean", "Lifecycle scan");
  report.runtime = await messenger.testFixture.runtime();
  check(report.runtime.sessions.length > 0, "Live supervised scanner");
  report.ok = true;
  await messenger.testFixture.report(JSON.stringify(report));
  if (report.version === "0.20.0a1") await messenger.testFixture.update();
  else if (["quit", "uninstall", "disable"].includes(options.scenario)) await messenger.testFixture.finish(options.scenario);
  }
  }
} catch (error) {
  report.error = String(error) + "\n" + error.stack;
  await messenger.testFixture.report(JSON.stringify(report));
}
