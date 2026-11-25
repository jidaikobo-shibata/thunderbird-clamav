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

async function invalidStorageScenario() {
  const before = await messenger.storage.local.get(null);
  const failure = await messenger.runtime.sendMessage({type:"state"});
  check(!failure.ok && failure.startupFailed, "Unsupported storage stops initialization");
  const retry = await messenger.runtime.sendMessage({type:"health"});
  check(!retry.ok && retry.startupFailed, "Connection retry cannot silently reset invalid storage");
  check(JSON.stringify(await messenger.storage.local.get(null)) === JSON.stringify(before), "Invalid storage is preserved without writes");
  for(let i=0;i<100 && !document.getElementById("notifications").disabled;i++) await wait(100);
  check(document.getElementById("notifications").disabled, "Editing remains locked while storage is invalid");
  check(!document.getElementById("health").disabled, "Explicit recovery remains available");
  await messenger.storage.local.set(before.fixtureValidStorage);
  await messenger.storage.local.remove("fixtureValidStorage");
  document.getElementById("health").click();
  const state = await settled(state=>state.records.some(record=>record.key==="preserved-review"));
  check(state.records[0].review.note === "Synthetic human decision", "Restoring valid storage preserves human notes");
  check((await messenger.storage.local.get("records")).records.format === 2, "Valid restored history migrates successfully");
  const held = new NativeClient(messenger.runtime);
  await held.request("health");
  report.unsupportedStorageProtected = true;
  report.runtime = await messenger.testFixture.runtime();
  report.ok = true;
  await messenger.testFixture.report(JSON.stringify(report));
}

async function latencyScenario() {
  const fixture = await messenger.testFixture.prepare(), ids = [];
  report.compose = await messenger.testFixture.coverMain();
  for (let i = 0; i < 32; i++) {
    const raw = fixture.mails.plain.replace(/Subject: [^\r\n]+/, "Subject: Synthetic latency " + i)
      .replace(/Message-ID: [^\r\n]+/i, "Message-ID: <latency-" + i + "@example.invalid>");
    const msg = await messenger.messages.import(new File([raw], "latency.eml", {type:"message/rfc822"}),
      fixture.source.id,{read:true,new:false});
    ids.push(msg.id);
  }
  report.quiet = await messenger.testFixture.composeFrames();
  const frames = messenger.testFixture.composeFrames();
  await messenger.storage.local.set({fixtureReplayMissing:ids});
  report.receiving = await frames;
  const state = await request("state");
  report.durableReceipts = state.incomingCount ?? state.records.filter(r => r.status==="queued").length + Number(Boolean(state.overflowPending));
  check(report.quiet.frames > 0 && report.receiving.frames > 0, "Compose window is drawing real frames");
  const client = new NativeClient(messenger.runtime);
  const sample = new TextEncoder().encode("Subject: synthetic cleanup\r\n\r\nfixture");
  await client.scan(sample,await sha256(sample),state.settings.scanSettings);
  report.runtime = await messenger.testFixture.runtime();
  report.ok = true;
  await messenger.testFixture.report(JSON.stringify(report));
}

async function intakeScenario() {
  const fixture = await messenger.testFixture.prepare();
  let state = await request("state");
  check(state.records.length === 1000, "Protected history restored");
  const flags = await messenger.storage.local.get(["fixtureBurstPrepared","fixtureRunningIntake"]);
  if (report.version === "0.20.0a1" && flags.fixtureBurstPrepared) {
    check(state.incomingCount === 12 && state.idleWaiting, "Receipts survived a real process restart");
    await messenger.testFixture.update();
    return;
  }
  if (report.version === "0.20.0a1") {
    report.compose = await messenger.testFixture.coverMain();
    const imported = [];
    for (let i = 0; i < 12; i++) {
      // Two physical copies intentionally share their envelope and Message-ID.
      const label = i === 1 ? 0 : i;
      const raw = fixture.mails.plain.replace(/Subject: [^\r\n]+/, "Subject: Synthetic queued " + label)
        .replace(/Message-ID: [^\r\n]+/i, "Message-ID: <queued-" + label + "@example.invalid>");
      const message = await messenger.messages.import(new File([raw], "incoming.eml", {type:"message/rfc822"}),
        i === 1 ? fixture.history.id : fixture.source.id, {read:true,new:false});
      imported.push(message);
      await messenger.testFixture.inject(message.id);
    }
    // Local-folder injection may omit a notification. Only the fixture has
    // independent knowledge of every delivered physical message in this burst.
    await wait(1000);
    const observed = Object.entries(await messenger.storage.local.get(null)).filter(([key]) => key.startsWith("incomingReceipt:"));
    const ids = new Set(observed.map(([, entry]) => entry.messageId));
    const missing = imported.filter(message => !ids.has(message.id)).map(message => message.id);
    report.nativeDelivered = ids.size;
    report.replayedFromFixtureInventory = missing.length;
    if (missing.length) await messenger.storage.local.set({fixtureReplayMissing:missing});
    state = await settled(value => value.incomingCount === imported.length && value.idleWaiting, 20);
    await messenger.messages.move([imported[2].id],fixture.history.id);
    await messenger.messages.delete([imported[3].id],{deletePermanently:true,isUserAction:true});
    const deleted = await messenger.messages.query({headerMessageId:imported[3].headerMessageId});
    check(!deleted.messages.length, "Deleted synthetic message is absent before restart");
    let receipts;
    for (let attempt = 0; attempt < 100; attempt++) {
      receipts = Object.entries(await messenger.storage.local.get(null)).filter(([key]) => key.startsWith("incomingReceipt:"));
      if (receipts.some(([, entry]) => entry.locator.subject === imported[2].subject && entry.locator.folder.id === fixture.history.id)) break;
      await wait(50);
    }
    check(receipts.some(([, entry]) => entry.locator.subject === imported[2].subject && entry.locator.folder.id === fixture.history.id), "Explicit move persisted before restart");
    check(receipts.length === 12 && !state.overflowReport && !state.overflowPending, "Burst is durable before any scan");
    report.queuedBeforeRestart = receipts.length;
    report.oldest = state.oldestIncoming;
  } else {
    if (!flags.fixtureRunningIntake) {
      check(state.incomingCount === 12 && state.idleWaiting, "Every receipt survives background restart");
      await messenger.storage.local.set({fixtureRunningIntake:true});
      await request("settings",{settings:{...state.settings,idleAutomatic:false}});
    }
    state = await settled(value => !value.incomingCount && value.overflowReport?.total === 12);
    // After restart, indistinguishable copies and the deleted delivery each
    // require attention. The explicit filter move remains inspectable.
    const counts = state.overflowReport.counts;
    report.counts = counts;
    report.uninspected = state.overflowReport.recent.map(item => ({subject:item.locator.subject,status:item.status,detail:item.detail}));
    check(counts.clean === 9 && counts.incomplete === 3, "Only unambiguous surviving messages are inspected");
    check(state.records.every(item => item.review?.note === "Synthetic human decision"), "Protected history retained");
    const {fixtureBodyReads} = await messenger.storage.local.get("fixtureBodyReads");
    check(fixtureBodyReads === 2, "Only the unfinished verdict is rescanned after process restarts");
    report.crashTargetBodyReads = fixtureBodyReads;
    const client = new NativeClient(messenger.runtime);
    const bytes = new TextEncoder().encode("Subject: synthetic cleanup\r\n\r\nfixture");
    await client.scan(bytes, await sha256(bytes),state.settings.scanSettings);
  }
  report.runtime = await messenger.testFixture.runtime();
  report.ok = true;
  await messenger.testFixture.report(JSON.stringify(report));
  if (report.version === "0.20.0a1") {
    await messenger.storage.local.set({fixtureBurstPrepared:true});
    await messenger.testFixture.report(JSON.stringify({running:true,restart:"before-scan",parent:report.runtime.parent}));
    await messenger.testFixture.finish("quit");
  }
}

const report = { ok: false, version: messenger.runtime.getManifest().version };
try {
  messenger.idle.setDetectionInterval(30);
  report.systemIdleState = await messenger.idle.queryState(30);
  check(["active", "idle"].includes(report.systemIdleState), "System idle API is available");
  const options = await (await fetch(messenger.runtime.getURL("fixture/options.json"))).json();
  if (options.scenario === "latency") { await latencyScenario(); }
  else if (options.scenario === "intake") { await intakeScenario(); }
  else if (options.scenario === "invalid-storage") { await invalidStorageScenario(); }
  else if (options.scenario === "recovery") { await recoveryScenario(); } else {
  let state = await request("state");
  const fixture = await messenger.testFixture.prepare();
  check(state.installation.state === "integrated", "Integrated scanner state");
  if (options.shared) {
    if (report.version === "0.20.0a1") {
      check(!state.settings.definitionSource, "Existing installations keep their definition folder");
      const select = document.getElementById("definition-source");
      for (let i = 0; i < 100 && !document.querySelector("#accounts input:checked"); i++) await wait(100);
      check(document.querySelector("#accounts input:checked") && !select.disabled, "Settings are ready");
      select.value = "gui";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    state = await settled(value => value.settings.definitionSource === "gui" &&
      (value.lastHealth?.definitionSource === "gui" || value.lastHealth?.status === "error"), 30);
    check(state.lastHealth.status === "ready", "Shared folder health: " + JSON.stringify(state.lastHealth));
    report.sharedDefinitions = true;
  }
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
    // Separate requests inside the idle window must reuse the real clamd.
    const plainKey = state.records.find(record=>record.locator.subject==="Synthetic plain").key;
    await request("retry", {key:plainKey});
    state = await settled(state=>state.records.find(record=>record.key===plainKey)?.status==="clean");
    const warmFirst = await messenger.testFixture.runtime();
    check(warmFirst.sessions.length === 1, "One retained scanner after a standalone scan");
    await request("retry", {key:plainKey});
    state = await settled(state=>state.records.find(record=>record.key===plainKey)?.status==="clean");
    const warmSecond = await messenger.testFixture.runtime();
    check(warmSecond.sessions.length === 1 && warmSecond.sessions[0].pid === warmFirst.sessions[0].pid, "Separate scans reuse the same supervised process");
    report.warmReuse = true;
    await messenger.testFixture.idle();
    check((await messenger.testFixture.runtime()).sessions.length === 0, "Retained scanner closes after bounded idle time");
    report.warmIdleCleanup = true;

    report.verdicts = results;
    let incomplete = state.records.find(record => record.locator.subject === "Synthetic encrypted");
    await request("reviewMany", { keys: [incomplete.key], reviewed: true, note: "Synthetic reviewed encryption", stamps: { [incomplete.key]: reviewStamp(incomplete) } });
    report.stage = "rescan";
    await request("retry", { key: incomplete.key });
    state = await settled(state => state.records.find(record => record.key === incomplete.key)?.status === "incomplete");
    await wait(200);
    check(state.records.find(record => record.key === incomplete.key).review?.note === "Synthetic reviewed encryption", "Review retained on identical rescan");
    report.rescanCleanup = await messenger.testFixture.idle();
    report.stage = "bulk-preflight";
    const previousSettings = structuredClone(state.settings);
    await request("settings", {settings:{...previousSettings,scanSettings:{...previousSettings.scanSettings,mailMiB:5}}});
    const largeRaw = fixture.mails.plain.replace(/Subject: [^\r\n]+/, "Subject: Synthetic size preflight").replace(/Message-ID: [^\r\n]+/i, "Message-ID: <size-preflight@example.invalid>") + ("x".repeat(998)+"\r\n").repeat(5300);
    const largeMail = await messenger.messages.import(new File([largeRaw], "large.eml", {type:"message/rfc822"}), fixture.source.id, {read:true,new:false});
    await messenger.testFixture.inject(largeMail.id);
    state = await settled(state=>state.records.some(record=>record.messageId===largeMail.id&&record.status==="incomplete"));
    const largeKey = state.records.find(record=>record.messageId===largeMail.id).key;
    await messenger.testFixture.idle();
    const openCount = (await messenger.testFixture.runtime()).openCount;
    const retryKeys = [plainKey,largeKey,incomplete.key];
    await request("retryMany", {keys:retryKeys});
    state = await settled(state=>!state.batch?.active&&retryKeys.every(key=>["clean","incomplete"].includes(state.records.find(record=>record.key===key)?.status)));
    await wait(200);
    check((await messenger.testFixture.runtime()).openCount===openCount+1, "Preflight size rejection does not restart the real scanner");
    check(state.records.find(record=>record.key===incomplete.key).review?.note==="Synthetic reviewed encryption", "Bulk retry retains matching review notes");
    const largeDeletion = await request("prepareDelete", {key:largeKey});
    await request("deletePermanently", {key:largeKey,token:largeDeletion.token});
    await request("settings", {settings:previousSettings});
    state = await request("state");
    report.bulkPreflightReuse = true;

    report.stage = "ordinary-move";
    incomplete = state.records.find(record => record.key === incomplete.key);
    const historyCount = state.records.length;
    await messenger.messages.move([incomplete.messageId], fixture.history.id, {isUserAction:true});
    state = await settled(state => state.records.find(record => record.key === incomplete.key)?.locator.folder.id === fixture.history.id);
    incomplete = state.records.find(record => record.key === incomplete.key);
    check(incomplete.review?.note === "Synthetic reviewed encryption", "Ordinary move retains review notes");
    await messenger.messages.move([incomplete.messageId], fixture.source.id, {isUserAction:true});
    state = await settled(state => state.records.find(record => record.key === incomplete.key)?.locator.folder.id === fixture.source.id);
    incomplete = state.records.find(record => record.key === incomplete.key);
    await messenger.testFixture.inject(incomplete.messageId);
    await wait(500);
    state = await request("state");
    check(state.records.length === historyCount, "Moved mail notification does not duplicate history");
    check(state.records.find(record => record.key === incomplete.key)?.review.note === "Synthetic reviewed encryption", "Move round trip retains human notes");
    report.ordinaryMoves = true;
    report.stage = "paged-notification-isolation";
    await messenger.testFixture.report(JSON.stringify({...report,running:true}));
    const pagedRaw = fixture.mails.plain.replace(/Subject: [^\r\n]+/, "Subject: Synthetic paged receipt").replace(/Message-ID: [^\r\n]+/i, "Message-ID: <paged-receipt@example.invalid>");
    const pagedMail = await messenger.messages.import(new File([pagedRaw], "paged.eml", {type:"message/rfc822"}), fixture.source.id, {read:true,new:false});
    await messenger.storage.local.set({fixtureReceiptPageId:pagedMail.id});
    for(let attempt=0;attempt<200;attempt++) {
      if((await messenger.storage.local.get('fixtureReceiptPageStarted')).fixtureReceiptPageStarted) break;
      await wait(25);
    }
    check((await messenger.storage.local.get('fixtureReceiptPageStarted')).fixtureReceiptPageStarted, "Real-header receipt page held");
    const separateRaw = fixture.mails.plain.replace(/Subject: [^\r\n]+/, "Subject: Synthetic separate receipt").replace(/Message-ID: [^\r\n]+/i, "Message-ID: <separate-receipt@example.invalid>");
    const separateMail = await messenger.messages.import(new File([separateRaw], "separate.eml", {type:"message/rfc822"}), fixture.source.id, {read:true,new:false});
    await messenger.testFixture.inject(separateMail.id);
    state = await settled(state=>state.records.some(r=>r.messageId===separateMail.id&&r.status==="clean"));
    check(!state.records.some(r=>r.messageId===pagedMail.id), "Other receipt scanned before the held page returns");
    await messenger.storage.local.set({fixtureReceiptPageRelease:true});
    await settled(state=>state.records.some(r=>r.messageId===pagedMail.id&&r.status==="clean"));
    report.pagedReceiptIsolation = true;
    const plainMove = (await request("state")).records.find(r=>r.key===plainKey);
    await messenger.storage.local.set({fixtureMovePageSourceId:plainMove.messageId});
    await messenger.messages.move([plainMove.messageId],fixture.history.id,{isUserAction:true});
    for(let attempt=0;attempt<200;attempt++) {
      if((await messenger.storage.local.get('fixtureMovePageStarted')).fixtureMovePageStarted) break;
      await wait(25);
    }
    check((await messenger.storage.local.get('fixtureMovePageStarted')).fixtureMovePageStarted, "Real move metadata page held");
    await messenger.messages.move([incomplete.messageId],fixture.history.id,{isUserAction:true});
    state = await settled(state=>state.records.find(r=>r.key===incomplete.key)?.locator.folder.id===fixture.history.id);
    incomplete = state.records.find(r=>r.key===incomplete.key);
    check(state.records.find(r=>r.key===plainKey).locator.folder.id===fixture.source.id, "Other move completes before held metadata returns");
    const movedPlain = (await messenger.messages.list(fixture.history.id)).messages.find(m=>m.subject==="Synthetic plain");
    check(movedPlain, "Physically moved real mail located");
    await messenger.messages.move([movedPlain.id],fixture.quarantine.id,{isUserAction:true});
    await wait(200);
    await messenger.storage.local.set({fixtureMovePageRelease:true});
    state = await settled(state=>state.records.find(r=>r.key===plainKey)?.locator.folder.id===fixture.quarantine.id);
    check(state.records.find(r=>r.key===incomplete.key).review?.note==="Synthetic reviewed encryption", "Unrelated human review survives replay");
    report.pagedMoveIsolation = true;
    report.pagedMoveReplay = true;
    let threat = state.records.find(record => record.locator.subject === "Synthetic attachment");
    await messenger.testFixture.failNextScan();
    await request("retry", {key:threat.key});
    state = await settled(value => value.fixtureScanRunning === false &&
      value.records.find(row => row.key === threat.key)?.lastAttempt?.status === "error");
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
    report.stage = "quarantine-receipt-isolation";
    await messenger.testFixture.report(JSON.stringify({...report,running:true}));
    const repeatedQuarantine = {id:state.records.find(record => record.locator.subject === "Synthetic incoming attachment" && record.quarantine?.status === "moved").messageId};
    await messenger.storage.local.set({fixtureQuarantinePendingId:repeatedQuarantine.id,fixtureQuarantineInvalidateId:repeatedQuarantine.id});
    for (let attempt=0;attempt<200;attempt++) {
      if ((await messenger.storage.local.get('fixtureQuarantineInvalidated')).fixtureQuarantineInvalidated) break;
      await wait(25);
    }
    check((await messenger.storage.local.get('fixtureQuarantineInvalidated')).fixtureQuarantineInvalidated, "Stored quarantine identity was made stale for the resync test");
    await messenger.storage.local.set({fixtureQuarantineReplayId:repeatedQuarantine.id});
    for (let attempt=0;attempt<200;attempt++) {
      if ((await messenger.storage.local.get('fixtureQuarantineProofStarted')).fixtureQuarantineProofStarted) break;
      await wait(25);
    }
    check((await messenger.storage.local.get('fixtureQuarantineProofStarted')).fixtureQuarantineProofStarted, "Quarantine proof is held in the separate worker");
    state = await request("state");
    check(state.records.some(record => record.messageId === repeatedQuarantine.id && record.quarantineCheckPending), "Pending quarantine proof is in durable history");
    const duringProofRaw = fixture.mails.plain.replace(/Subject: [^\r\n]+/, "Subject: Synthetic receipt during quarantine proof").replace(/Message-ID: [^\r\n]+/i, "Message-ID: <during-proof@example.invalid>");
    const duringProof = await messenger.messages.import(new File([duringProofRaw], "during.eml", {type:"message/rfc822"}), fixture.source.id, {read:true,new:false});
    await messenger.testFixture.inject(duringProof.id);
    state = await settled(state => state.records.some(record => record.messageId === duringProof.id && record.status === "clean"));
    check(state.records.some(record => record.messageId === repeatedQuarantine.id && record.quarantineCheckPending), "Unrelated real mail finishes while proof remains held");
    await messenger.storage.local.set({fixtureQuarantineProofRelease:true});
    state = await settled(state => !state.records.some(record => record.messageId === repeatedQuarantine.id && (record.quarantineCheckPending || ["queued","scanning"].includes(record.status))));
    report.quarantineReceiptIsolation = true;
    report.quarantineReceiptDeduplicated = !state.records.some(record => record.messageId === repeatedQuarantine.id);
    report.stage = "automatic-quarantine-deadline";
    const slowQuarantineRaw = fixture.mails.attachment.replace(/Subject: [^\r\n]+/, "Subject: Synthetic slow quarantine").replace(/Message-ID: [^\r\n]+/i, "Message-ID: <slow-quarantine@example.invalid>");
    const slowQuarantine = await messenger.messages.import(new File([slowQuarantineRaw], "slow-quarantine.eml", {type:"message/rfc822"}), fixture.source.id, {read:true,new:false});
    await messenger.testFixture.inject(slowQuarantine.id);
    for (let attempt=0;attempt<200;attempt++) {
      if ((await messenger.storage.local.get('fixtureAutoStarted')).fixtureAutoStarted) break;
      await wait(25);
    }
    check((await messenger.storage.local.get('fixtureAutoStarted')).fixtureAutoStarted, "Automatic quarantine proof held");
    const independentRaw = fixture.mails.plain.replace(/Subject: [^\r\n]+/, "Subject: Synthetic during auto quarantine").replace(/Message-ID: [^\r\n]+/i, "Message-ID: <during-auto@example.invalid>");
    const independent = await messenger.messages.import(new File([independentRaw], "independent.eml", {type:"message/rfc822"}), fixture.source.id, {read:true,new:false});
    await messenger.testFixture.inject(independent.id);
    await settled(state => state.records.some(r => r.messageId === independent.id && r.status === "clean"));
    state = await settled(state => state.records.some(r => r.messageId === slowQuarantine.id && r.quarantine?.status === "error"));
    const expiredQuarantine = JSON.stringify(state.records.find(r => r.messageId === slowQuarantine.id));
    await messenger.storage.local.set({fixtureAutoRelease:true});
    for (let attempt=0;attempt<200;attempt++) {
      if ((await messenger.storage.local.get('fixtureAutoReturned')).fixtureAutoReturned) break;
      await wait(25);
    }
    check((await messenger.storage.local.get('fixtureAutoReturned')).fixtureAutoReturned, "Expired automatic proof actually returned");
    state = await request("state");
    check(JSON.stringify(state.records.find(r => r.messageId === slowQuarantine.id)) === expiredQuarantine, "Late automatic proof cannot move or overwrite history");
    check((await messenger.messages.get(slowQuarantine.id)).folder.id === fixture.source.id, "No late automatic move");
    report.automaticQuarantineDeadline = true;
    // Repeat the known quarantined message, now deliberately expire its proof.
    await messenger.storage.local.set({fixtureQuarantineProofRelease:false,fixtureQuarantineHeldId:null,fixtureQuarantineProofStarted:false,fixtureQuarantineProofReturned:false,fixtureReceiptDeadline:true});
    await messenger.storage.local.set({fixtureQuarantineReplayId:null});
    await messenger.storage.local.set({fixtureQuarantineReplayId:repeatedQuarantine.id});
    state = await settled(state => state.records.some(r => r.messageId === repeatedQuarantine.id && r.status === "detected" && !r.quarantineCheckPending));
    const receiptKeys = state.records.filter(r => r.messageId === repeatedQuarantine.id).map(r => r.key).sort().join();
    await messenger.storage.local.set({fixtureQuarantineProofRelease:true});
    for (let attempt=0;attempt<200;attempt++) {
      if ((await messenger.storage.local.get('fixtureQuarantineProofReturned')).fixtureQuarantineProofReturned) break;
      await wait(25);
    }
    check((await messenger.storage.local.get('fixtureQuarantineProofReturned')).fixtureQuarantineProofReturned, "Expired receipt proof actually returned");
    state = await request("state");
    check(state.records.filter(r => r.messageId === repeatedQuarantine.id).map(r => r.key).sort().join() === receiptKeys, "Late receipt proof cannot erase inspected mail");
    await messenger.storage.local.set({fixtureReceiptDeadline:false});
    report.quarantineReceiptDeadline = true;
    report.stage = "input-deadline";
    await messenger.testFixture.report(JSON.stringify({...report,running:true}));
    const slowRaw = fixture.mails.plain.replace(/Subject: [^\r\n]+/, "Subject: Synthetic slow input").replace(/Message-ID: [^\r\n]+/i, "Message-ID: <slow-input@example.invalid>");
    const slow = await messenger.messages.import(new File([slowRaw], "slow.eml", {type:"message/rfc822"}), fixture.source.id, {read:true,new:false});
    await messenger.testFixture.inject(slow.id);
    state = await settled(state => state.records.some(record => record.messageId === slow.id && record.status === "error" && record.nextRetry));
    const slowKey = state.records.find(record => record.messageId === slow.id).key;
    check((await messenger.storage.local.get('fixtureSlowInputStarted')).fixtureSlowInputStarted, "Real input read was held until its deadline");
    const afterTimeoutRaw = fixture.mails.plain.replace(/Subject: [^\r\n]+/, "Subject: Synthetic after input timeout").replace(/Message-ID: [^\r\n]+/i, "Message-ID: <after-timeout@example.invalid>");
    const afterTimeout = await messenger.messages.import(new File([afterTimeoutRaw], "after.eml", {type:"message/rfc822"}), fixture.source.id, {read:true,new:false});
    await messenger.testFixture.inject(afterTimeout.id);
    state = await settled(state => state.records.some(record => record.messageId === afterTimeout.id && record.status === "clean"));
    const timedOut = JSON.stringify(state.records.find(record => record.key === slowKey));
    await messenger.storage.local.set({fixtureReleaseSlowInput:true});
    await wait(400);
    state = await request("state");
    check(JSON.stringify(state.records.find(record => record.key === slowKey)) === timedOut, "Late real input completion cannot overwrite the failure");
    await request("retry", {key:slowKey});
    state = await settled(state => state.records.find(record => record.key === slowKey)?.status === "clean");
    report.inputDeadlineIsolation = true;
    report.inputDeadlineRecovery = true;
    report.stage = "review-carry-deadline";
    await messenger.testFixture.report(JSON.stringify({...report,running:true}));
    const beforeReviewSettings = structuredClone(state.settings);
    await request("settings", {settings:{...state.settings,scanSettings:{...(state.settings.scanSettings || {}),mailMiB:5}}});
    const reviewCarryRaw = fixture.mails.plain.replace(/Subject: [^\r\n]+/, "Subject: Synthetic reviewed oversized").replace(/Message-ID: [^\r\n]+/i, "Message-ID: <review-carry@example.invalid>") +
      ("x".repeat(76)+"\r\n").repeat(Math.ceil((6*1024*1024)/78));
    const largeReview = await messenger.messages.import(new File([reviewCarryRaw], "large-review.eml", {type:"message/rfc822"}), fixture.history.id, {read:true,new:false});
    await messenger.storage.local.set({fixtureReviewReplayId:largeReview.id});
    state = await settled(state => state.records.some(record => record.messageId === largeReview.id && record.status === "incomplete"));
    await wait(200);
    let reviewRecord = state.records.find(record => record.messageId === largeReview.id);
    await request("reviewMany", {keys:[reviewRecord.key],reviewed:true,note:"",stamps:{[reviewRecord.key]:reviewStamp(reviewRecord)}});
    await messenger.storage.local.set({fixtureHoldReviewCarry:true});
    await request("retry", {key:reviewRecord.key});
    state = await settled(state => {const record=state.records.find(record => record.key === reviewRecord.key);return record?.status === "incomplete" && !record.review && !record.reviewBeforeScan;});
    check((await messenger.storage.local.get('fixtureReviewCarryStarted')).fixtureReviewCarryStarted, "Review carry proof was held until its deadline");
    const afterReviewRaw = fixture.mails.plain.replace(/Subject: [^\r\n]+/, "Subject: Synthetic after review deadline").replace(/Message-ID: [^\r\n]+/i, "Message-ID: <after-review@example.invalid>");
    const afterReview = await messenger.messages.import(new File([afterReviewRaw], "after-review.eml", {type:"message/rfc822"}), fixture.source.id, {read:true,new:false});
    await messenger.testFixture.inject(afterReview.id);
    state = await settled(state => state.records.some(record => record.messageId === afterReview.id && record.status === "clean"));
    await wait(200);
    reviewRecord = state.records.find(record => record.key === reviewRecord.key);
    await request("reviewMany", {keys:[reviewRecord.key],reviewed:true,note:"",stamps:{[reviewRecord.key]:reviewStamp(reviewRecord)}});
    state = await request("state");
    const newReviewSnapshot = JSON.stringify(state.records.find(record => record.key === reviewRecord.key));
    await messenger.storage.local.set({fixtureReleaseReviewCarry:true});
    for (let attempt=0;attempt<400;attempt++) {
      if ((await messenger.storage.local.get('fixtureReviewCarryReturned')).fixtureReviewCarryReturned) break;
      await wait(25);
    }
    check((await messenger.storage.local.get('fixtureReviewCarryReturned')).fixtureReviewCarryReturned, "The late real body response was delivered");
    await wait(100);
    state = await request("state");
    check(JSON.stringify(state.records.find(record => record.key === reviewRecord.key)) === newReviewSnapshot, "Expired carry proof cannot change a later human review");
    await request("settings", {settings:beforeReviewSettings});
    report.reviewCarryDeadlineIsolation = true;
    report.reviewCarryHumanDecisionPreserved = true;
    report.stage = "draft-exclusion";
    check(fixture.drafts.specialUse.includes("drafts"), "Thunderbird exposes the real draft folder attribute");
    const draftRaw = fixture.mails.plain.replace(/Subject: [^\r\n]+/, "Subject: Synthetic draft excluded").replace(/Message-ID: [^\r\n]+/i, "Message-ID: <draft-excluded@example.invalid>");
    const draftMail = await messenger.messages.import(new File([draftRaw], "draft.eml", {type:"message/rfc822"}), fixture.drafts.id, {read:true,new:false});
    await messenger.testFixture.inject(draftMail.id);
    await wait(700);
    state = await request("state");
    check(!state.records.some(record => record.messageId === draftMail.id), "Draft new-mail event adds no automatic history");
    const draftContext = await request("folderContext", {folderId:fixture.drafts.id});
    await request("folderStart", {token:draftContext.token,includeSubfolders:false});
    state = await settled(state => state.folderJob?.status === "completed");
    check(state.folderJob.completed === 1 && state.records.some(record => record.messageId === draftMail.id && record.source === "folder" && record.status === "clean"), "Explicit real draft-folder scan remains available");
    report.draftExclusion = true;
    report.stage = "receipt-recovery";
    const receiptRaw = fixture.mails.plain.replace(/Subject: [^\r\n]+/, "Subject: Synthetic receipt recovery").replace(/Message-ID: [^\r\n]+/i, "Message-ID: <receipt-recovery@example.invalid>");
    const receiptMail = await messenger.messages.import(new File([receiptRaw], "receipt.eml", {type:"message/rfc822"}), fixture.source.id, {read:true,new:false});
    await messenger.testFixture.inject(receiptMail.id);
    await settled(state => state.issue.includes("synthetic incoming receipt failure"));
    const laterRaw = receiptRaw.replace(/Synthetic receipt recovery/, "Synthetic later receipt").replace(/receipt-recovery@example.invalid/, "later-receipt@example.invalid");
    const laterMail = await messenger.messages.import(new File([laterRaw], "later.eml", {type:"message/rfc822"}), fixture.source.id, {read:true,new:false});
    await messenger.testFixture.inject(laterMail.id);
    await settled(state => state.records.some(record => record.messageId === laterMail.id && record.status === "clean"));
    state = await settled(state => !state.issue && state.records.some(record => record.messageId === receiptMail.id && record.status === "clean"));
    check(state.records.filter(record => record.messageId === receiptMail.id).length === 1, "Retried reception has no duplicate history");
    report.receiptRecovery = true;
    report.stage = "raw-move-recovery";
    await messenger.testFixture.report(JSON.stringify({...report,running:true}));
    for (const mode of ["early", "late"]) {
      const raw = fixture.mails.plain.replace(/Subject: [^\r\n]+/, "Subject: Synthetic " + mode + " raw move").replace(/Message-ID: [^\r\n]+/i, "Message-ID: <" + mode + "-raw-move@example.invalid>");
      const message = await messenger.messages.import(new File([raw], "move.eml", {type:"message/rfc822"}), fixture.source.id, {read:true,new:false});
      await messenger.testFixture.inject(message.id);
      if (mode === "early") {
        for (let attempt=0;attempt<100;attempt++) { if ((await messenger.storage.local.get('fixtureRawGateStarted')).fixtureRawGateStarted) break; await wait(25); }
        check((await messenger.storage.local.get('fixtureRawGateStarted')).fixtureRawGateStarted, "Raw retrieval is waiting before the real move");
      } else await settled(state => state.records.some(record => record.messageId === message.id && record.status === "error"));
      const originKey = (await request("state")).records.find(record => record.messageId === message.id).key;
      await messenger.messages.move([message.id], fixture.history.id, {isUserAction:true});
      if (mode === "early") {
        for (let attempt=0;attempt<200;attempt++) { if ((await messenger.storage.local.get('fixtureMoveForwarded')).fixtureMoveForwarded) break;await wait(25); }
        check((await messenger.storage.local.get('fixtureMoveForwarded')).fixtureMoveForwarded, "Moved notification was forwarded after its destination notification");
        report.pendingMoveStaged = (await messenger.storage.local.get('fixturePendingMoveStaged')).fixturePendingMoveStaged;
        await settled(state => state.records.find(record => record.key === originKey)?.locator.folder.id === fixture.history.id,30);
        await messenger.storage.local.set({fixtureReleaseRawGate:true});
      } else await settled(state => state.records.some(record => record.locator.subject === "Synthetic " + mode + " raw move" && record.locator.folder.id === fixture.history.id));
      state = await settled(state => { const entries=state.records.filter(record => record.locator.subject === "Synthetic " + mode + " raw move");return entries.length===1&&entries[0].status==="clean"; },30);
      const matches = state.records.filter(record => record.locator.subject === "Synthetic " + mode + " raw move");
      check(matches.length === 1 && matches[0].locator.folder.id === fixture.history.id, "Real move recovery has one history at the current location");
      if (mode === "early") check(matches[0].attempts === 1, "Known in-flight move recovers without delayed scan retry");
    }
    report.rawMoveRecovery = true;
    report.pendingMoveDeduplication = true;
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
    report.stage = "forget-history";
    const historyBeforeForget = state.records.length;
    const forget = await request("prepareForget", {keys:[largeKey]});
    check((await request("forgetMany", {token:forget.token})).count === 1, "Selected history removal commits");
    state = await request("state");
    check(state.records.length === historyBeforeForget - 1 && !state.records.some(record => record.key === largeKey), "Only selected history removed");
    check((await messenger.messages.get(incomplete.messageId)).id === incomplete.messageId, "History removal preserves other mail");
    check(state.records.find(record => record.key === incomplete.key).review?.note === "Synthetic reviewed encryption", "History removal preserves human review");
    report.historyRemoval = true;
    report.stage = "overflow-quarantine-ownership";
    await messenger.testFixture.report(JSON.stringify({...report,running:true}));
    await messenger.storage.local.set({fixtureOverflowContext:{accountId:fixture.accountId,folder:fixture.source}});
    for(let attempt=0;attempt<200;attempt++) {
      if((await messenger.storage.local.get('fixtureOverflowReady')).fixtureOverflowReady) break;
      await wait(25);
    }
    check((await messenger.storage.local.get('fixtureOverflowReady')).fixtureOverflowReady,"Protected synthetic history filled");
    await messenger.storage.local.set({fixtureActiveInput:true});
    const beforeBurst = await request("state");
    await request("settings",{settings:{...beforeBurst.settings,idleAutomatic:true}});
    for(let index=0;index<22;index++) {
      const overflowRaw=fixture.mails.attachment.replace(/Subject: [^\r\n]+/,"Subject: Synthetic overflow threat "+index).replace(/Message-ID: [^\r\n]+/i,"Message-ID: <overflow-threat-"+index+"@example.invalid>");
      const imported=await messenger.messages.import(new File([overflowRaw],"overflow.eml",{type:"message/rfc822"}),fixture.source.id,{read:true,new:false});
      await messenger.testFixture.inject(imported.id);
    }
    state=await settled(state=>state.idleWaiting && state.incomingCount === 22);
    const persisted = Object.entries(await messenger.storage.local.get(null)).filter(([key]) => key.startsWith("incomingReceipt:"));
    check(persisted.length===22 && !state.overflowReport && !state.overflowPending, "Full history and active input retain all 22 receipts before scanning");
    check(Date.parse(state.oldestIncoming) > 0 && state.records.length === 1000, "Queue summary is independent of protected history");
    report.activeIntakeWithFullHistory = true;
    await messenger.storage.local.set({fixtureActiveInput:false});
    await request("settings",{settings:{...state.settings,idleAutomatic:false}});
    state=await settled(state=>state.overflowReport?.total===22 && !state.incomingCount);
    check((await messenger.storage.local.get('fixtureOverflowQuarantineStarted')).fixtureOverflowQuarantineStarted,"First real quarantine remains held");
    check(state.records.length===1000&&state.overflowReport.recent.length===20,"Visible history stays bounded while every task is retained");
    await messenger.storage.local.set({fixtureOverflowQuarantineRelease:true});
    state=await settled(state=>state.overflowReport?.recent.every(r=>r.quarantine?.status==="moved"));
    const isolatedOverflow=(await messenger.messages.list(fixture.quarantine.id)).messages.filter(m=>m.subject.startsWith("Synthetic overflow threat "));
    check(isolatedOverflow.length===22,"All 22 real threats were quarantined after history rotation");
    const remainingOverflow=(await messenger.messages.list(fixture.source.id)).messages.filter(m=>m.subject.startsWith("Synthetic overflow threat "));
    check(remainingOverflow.length===0,"No rotated threat remains in the source");
    report.overflowQuarantineOwnership=true;
    await messenger.storage.local.set({fixtureOverflowRestore:true});
    for(let attempt=0;attempt<200;attempt++) {
      if((await messenger.storage.local.get('fixtureOverflowRestored')).fixtureOverflowRestored) break;
      await wait(25);
    }
    check((await messenger.storage.local.get('fixtureOverflowRestored')).fixtureOverflowRestored,"Original synthetic test history restored");
    state=await request("state");
    report.stage = "notification-isolation";
    await messenger.testFixture.report(JSON.stringify({...report,running:true}));
    const notificationSettings=structuredClone(state.settings);
    await request("settings",{settings:{...notificationSettings,notifications:true}});
    const notificationRaw=fixture.mails.encrypted.replace(/Subject: [^\r\n]+/,"Subject: Synthetic held notification").replace(/Message-ID: [^\r\n]+/i,"Message-ID: <held-notification@example.invalid>");
    const notificationMail=await messenger.messages.import(new File([notificationRaw],"notification.eml",{type:"message/rfc822"}),fixture.source.id,{read:true,new:false});
    await messenger.testFixture.inject(notificationMail.id);
    for(let attempt=0;attempt<200;attempt++) {
      if((await messenger.storage.local.get('fixtureNotificationStarted')).fixtureNotificationStarted) break;
      await wait(25);
    }
    check((await messenger.storage.local.get('fixtureNotificationStarted')).fixtureNotificationStarted,"Notification API completion held");
    const notificationFreshRaw=fixture.mails.plain.replace(/Subject: [^\r\n]+/,"Subject: Synthetic during notification").replace(/Message-ID: [^\r\n]+/i,"Message-ID: <during-notification@example.invalid>");
    const notificationFresh=await messenger.messages.import(new File([notificationFreshRaw],"during-notification.eml",{type:"message/rfc822"}),fixture.source.id,{read:true,new:false});
    await messenger.testFixture.inject(notificationFresh.id);
    state=await settled(state=>state.records.some(r=>r.messageId===notificationFresh.id&&r.status==="clean"));
    const notificationRetry=state.records.find(r=>r.messageId===notificationFresh.id).key;
    await request("retry",{key:notificationRetry});
    state=await settled(state=>state.records.some(r=>r.key===notificationRetry&&r.source==="manual"&&r.status==="clean"));
    check(!(await messenger.storage.local.get('fixtureNotificationReturned')).fixtureNotificationReturned,"Automatic and manual inspections complete before notification response");
    const payload=(await messenger.storage.local.get('fixtureNotificationPayload')).fixtureNotificationPayload;
    check(!JSON.stringify(payload).includes("Synthetic held notification")&&!JSON.stringify(payload).includes("synthetic@example.invalid"),"Notification omits private mail headers");
    await messenger.storage.local.set({fixtureNotificationRelease:true});
    for(let attempt=0;attempt<200;attempt++) {
      if((await messenger.storage.local.get('fixtureNotificationReturned')).fixtureNotificationReturned) break;
      await wait(25);
    }
    check((await messenger.storage.local.get('fixtureNotificationReturned')).fixtureNotificationReturned,"Held notification response released");
    await request("settings",{settings:notificationSettings});
    report.notificationIsolation=true;
    state=await request("state");
    report.stage="dashboard-accessibility";
    document.getElementById('tab-results').click();
    let focusRow;
    for(let attempt=0;attempt<100;attempt++) {
      focusRow=[...document.querySelectorAll('#results tr')].find(row=>row.textContent.includes('Synthetic plain'));
      if(focusRow) break;
      await wait(100);
    }
    check(focusRow,"Native result row is available");
    const focusedControl=focusRow.querySelector('input');focusedControl.focus();
    await messenger.storage.local.set({fixtureFocusRecordKey:plainKey});
    for(let attempt=0;attempt<100;attempt++) {
      if(document.querySelector('#results tr')===focusRow) break;
      await wait(100);
    }
    check(document.querySelector('#results tr')===focusRow&&document.activeElement===focusedControl,"Native focus survives automatic row reordering");
    await messenger.storage.local.set({fixtureFocusRestore:true});
    for(let attempt=0;attempt<100;attempt++) {
      if((await messenger.storage.local.get('fixtureFocusRestored')).fixtureFocusRestored) break;
      await wait(100);
    }
    check((await messenger.storage.local.get('fixtureFocusRestored')).fixtureFocusRestored,"Synthetic timestamp restored");
    document.getElementById('tab-settings').click();
    const mailLimit=document.getElementById('scan-mailMiB');
    mailLimit.value='4';mailLimit.dispatchEvent(new Event('change',{bubbles:true}));mailLimit.blur();await wait(2300);
    check(mailLimit.value==='4'&&mailLimit.getAttribute('aria-invalid')==='true',"Native invalid input survives refresh");
    check(document.getElementById(mailLimit.getAttribute('aria-describedby')).textContent.includes('100'),"Native input error identifies its range");
    mailLimit.value=String(state.settings.scanSettings.mailMiB);mailLimit.dispatchEvent(new Event('change',{bubbles:true}));
    for(let attempt=0;attempt<100;attempt++) {
      if(!mailLimit.disabled&&!mailLimit.hasAttribute('aria-invalid')) break;
      await wait(100);
    }
    check(!mailLimit.disabled&&!mailLimit.hasAttribute('aria-invalid'),"Native corrected input saves and clears its error");
    report.dashboardAccessibility=true;
    state=await request("state");
    report.stage="deletion-preparation-dialog";
    document.getElementById('tab-results').click();
    for(let attempt=0;attempt<100;attempt++) {
      if(!document.getElementById('delete-selected').disabled||!document.getElementById('filter').disabled) break;
      await wait(100);
    }
    const deletionHeldRecord=state.records.find(r=>r.key===notificationRetry);
    await messenger.storage.local.set({fixtureDeleteHoldId:deletionHeldRecord.messageId});
    for(const subject of ['Synthetic plain','Synthetic during notification']) {
      const row=[...document.querySelectorAll('#results tr')].find(row=>row.textContent.includes(subject));
      check(row,"Native deletion target row available");
      const box=row.querySelector('input');if(!box.checked)box.click();
    }
    document.getElementById('delete-selected').click();
    check(document.getElementById('delete-dialog').open,"Deletion modal opens synchronously");
    check(document.getElementById('delete-ack').disabled&&document.getElementById('delete-confirm').disabled,"Deletion remains unavailable during verification");
    for(let attempt=0;attempt<200;attempt++) {
      if((await messenger.storage.local.get('fixtureDeleteStarted')).fixtureDeleteStarted&&document.getElementById('delete-preparation-bar').value===1) break;
      await wait(100);
    }
    check((await messenger.storage.local.get('fixtureDeleteStarted')).fixtureDeleteStarted&&document.getElementById('delete-preparation-bar').value===1,"Native modal shows 1 of 2 verified messages");
    document.getElementById('delete-cancel').click();
    for(let attempt=0;attempt<100;attempt++) {
      if(!document.getElementById('delete-selected').disabled) break;
      await wait(100);
    }
    check(!document.getElementById('delete-dialog').open&&!document.getElementById('delete-selected').disabled,"Cancellation finishes before blocked body returns");
    state=await request("state");const cancelledPreparation=JSON.stringify(state.batch);
    check((await messenger.messages.get(deletionHeldRecord.messageId)).id===deletionHeldRecord.messageId,"Cancelled mail remains present");
    await messenger.storage.local.set({fixtureDeleteRelease:true});
    for(let attempt=0;attempt<100;attempt++) {
      if((await messenger.storage.local.get('fixtureDeleteReturned')).fixtureDeleteReturned) break;
      await wait(100);
    }
    check((await messenger.storage.local.get('fixtureDeleteReturned')).fixtureDeleteReturned,"Expired body reply actually returned");
    check(JSON.stringify((await request('state')).batch)===cancelledPreparation&&!document.getElementById('delete-dialog').open,"Late verification cannot reopen or update the cancelled preparation");
    document.getElementById('delete-selected').click();
    const sameDeletionDialog=document.getElementById('delete-dialog');
    for(let attempt=0;attempt<100;attempt++) {
      if(!document.getElementById('delete-ack').disabled) break;
      await wait(100);
    }
    check(sameDeletionDialog.open&&!document.getElementById('delete-ack').disabled&&document.querySelectorAll('#delete-targets li').length===2,"Verified native targets appear in the same dialog");
    document.getElementById('delete-cancel').click();
    for(let attempt=0;attempt<100;attempt++) {
      if(!document.getElementById('delete-selected').disabled) break;
      await wait(100);
    }
    report.deletionPreparationDialog=true;
    await messenger.storage.local.set({fixtureDeleteMismatchId:deletionHeldRecord.messageId});
    document.getElementById('delete-selected').focus();
    document.getElementById('delete-selected').click();
    const recoveryDialog = document.getElementById('locate-dialog');
    for (let attempt=0; attempt<100 && !recoveryDialog.open; attempt++) await wait(100);
    check(recoveryDialog.open && recoveryDialog.contains(document.activeElement), "Content mismatch focuses target recovery");
    check(document.getElementById('locate-rows').textContent.length > 0 &&
      document.getElementById('delete-confirm').disabled, "Recovery shows the reason before any deletion can be confirmed");
    recoveryDialog.querySelector('[value="cancel"]').click();
    for (let attempt=0; attempt<100 && document.getElementById('delete-selected').disabled; attempt++) await wait(100);
    check(!document.getElementById('delete-dialog').open &&
      (await messenger.messages.get(deletionHeldRecord.messageId)).id === deletionHeldRecord.messageId, "Cancelling recovery leaves the message intact");
    await messenger.storage.local.remove('fixtureDeleteMismatchId');
    report.operationFeedback=true;
    report.coveredMain=await messenger.testFixture.coverMain(true);
    check(report.coveredMain.mainFramePending,"Main window frames are actually paused behind compose");
    const hiddenIds=[];
    for(let index=0;index<2;index++) {
      const raw=fixture.mails.plain.replace(/Subject: [^\r\n]+/,"Subject: Synthetic hidden toolbar "+index).replace(/Message-ID: [^\r\n]+/i,"Message-ID: <hidden-toolbar-"+index+"@example.invalid>");
      const message=await messenger.messages.import(new File([raw],"hidden.eml",{type:"message/rfc822"}),fixture.source.id,{read:false,new:true});
      hiddenIds.push(message.id);
      await messenger.storage.local.set({fixtureReviewReplayId:message.id});
    }
    for(let attempt=0;attempt<600;attempt++) {
      state=await request('state');
      if(hiddenIds.every(id=>state.records.some(record=>record.messageId===id&&record.status==='clean')))break;
      await wait(100);
    }
    check(hiddenIds.every(id=>state.records.some(record=>record.messageId===id&&record.status==='clean')),"Automatic admission and scanning continue with main frames paused");
    report.hiddenToolbarIsolation=true;
    await messenger.testFixture.restoreFrames();


    const candidateRaw = fixture.mails.plain.replace(/Subject: [^\r\n]+/, "Subject: Synthetic relocated candidate")
      .replace(/Message-ID: [^\r\n]+/i, "Message-ID: <receipt-candidate@example.invalid>");
    const candidate = await messenger.messages.import(new File([candidateRaw], "candidate.eml", {type:"message/rfc822"}),
      fixture.source.id, {read:true,new:false});
    await messenger.storage.local.set({fixtureCandidateReceipt:{id:candidate.id,folder:fixture.history}});
    state = await settled(value => value.records.some(item => item.messageId === candidate.id && item.candidateOrigin && item.status === "clean"));
    const found = state.records.find(item => item.messageId === candidate.id && item.candidateOrigin);
    check(found.sha256 && found.candidateOrigin.locator.folder.id === fixture.history.id && found.locator.folder.id === fixture.source.id,
      "A unique candidate is inspected while its receipt retains the unverified original location");
    report.automaticCandidate = true;
  } else {
    check(state.settings.scanSettings.mailMiB === 50 && state.settings.quarantine[fixture.accountId].auto, "Updated settings retained");
    check(state.records.some(record => record.status === "deleted") && state.records.some(record => record.quarantine?.status === "moved"), "Updated result history retained");
    check(!state.records.some(record => record.locator.subject === "Synthetic size preflight"), "Committed history removal survives update");
    if (options.shared) {
      check(!state.settings.enabled, "Automatic scanning stays disabled after update");
      const select = document.getElementById("definition-source");
      for (let i = 0; i < 100 && (select.value !== "gui" || select.disabled); i++) await wait(100);
      select.value = "addon";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      state = await settled(value => !value.settings.definitionSource && value.lastHealth?.status === "ready" &&
        !value.lastHealth.definitionSource, 30);
      check(!state.settings.enabled, "Switching back preserves automatic scanning off");
      await request("settings", {settings:{...state.settings, enabled:true, accountIds:[fixture.accountId]}});
      report.restoredDefaultDefinitions = true;
    }
    report.experimentalUpdate = true;
  }
  // Leave one actual clamd alive so the launcher can verify update/crash cleanup.
  const retained = new NativeClient(messenger.runtime);
  const sample = new TextEncoder().encode("Subject: synthetic lifecycle\r\n\r\nhello");
  check((await retained.scan(sample, await sha256(sample), state.settings.scanSettings)).status === "clean", "Lifecycle scan");
  if (!["guardian", "worker"].includes(options.scenario)) {
    const lifecycleRaw = fixture.mails.plain.replace(/Subject: [^\r\n]+/, "Subject: Synthetic lifecycle background " + report.version).replace(/Message-ID: [^\r\n]+/i, "Message-ID: <lifecycle-background-" + report.version + "@example.invalid>");
    const lifecycleMail = await messenger.messages.import(new File([lifecycleRaw], "lifecycle.eml", {type:"message/rfc822"}), fixture.source.id, {read:false,new:true});
    await messenger.testFixture.inject(lifecycleMail.id);
    await settled(state=>state.records.some(record=>record.messageId===lifecycleMail.id&&record.status==="clean"));
  }
  report.runtime = await messenger.testFixture.runtime();
  if (!["guardian", "worker"].includes(options.scenario)) {
    check(report.runtime.sessions.length >= 2, "Lifecycle cleanup includes a retained background scanner");
    report.retainedBackgroundScanner = true;
  }
  if (options.shared && report.version === "0.20.0a1") {
    await request("settings", {settings:{...state.settings, enabled:false, accountIds:[]}});
  }
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
