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

const report = { ok: false, version: messenger.runtime.getManifest().version };
try {
  const options = await (await fetch(messenger.runtime.getURL("fixture/options.json"))).json();
  if (options.scenario === "invalid-storage") { await invalidStorageScenario(); }
  else if (options.scenario === "recovery") { await recoveryScenario(); } else {
  let state = await request("state");
  const fixture = await messenger.testFixture.prepare();
  check(state.installation.state === "integrated", "Integrated scanner state");
  if (options.scenario === "missing") {
    check(state.lastHealth.code === "clamav_missing", "Missing ClamAV is explicit");
    const previous = JSON.stringify(state.records);
    const context = await request("folderContext", { folderId: fixture.source.id });
    const response = await messenger.runtime.sendMessage({type:"folderStart",token:context.token,includeSubfolders:false});
    check(!response.ok && response.setupRequired, "Missing scanner blocks folder start");
    state = await request("state");
    check(JSON.stringify(state.records) === previous && !state.folderJob, "Missing scanner preserves records and review notes");
    const held = new NativeClient(messenger.runtime);
    check((await held.request("health")).code === "clamav_missing", "Missing scanner never reports clean");
    report.missingScanner = true;
    report.runtime = await messenger.testFixture.runtime();
    report.ok = true;
    await messenger.testFixture.report(JSON.stringify(report));
  } else {
  check(state.lastHealth.status === "ready", "Health ready: " + JSON.stringify(state.lastHealth));
  check(state.settings.accountIds.includes(fixture.accountId) && state.settings.notifications === false, "Settings retained");
  check(state.records.find(record => record.key === "preserved-review")?.review.note === "Synthetic human decision", "Human decision retained");
  const backup = await messenger.testFixture.backup(state.directMigrationBackup.path);
  check(backup.storage.records.length === 1 && backup.storage.records[0].review.note === "Synthetic human decision", "Pre-migration backup retained");
  report.migration = true;
  await messenger.testFixture.report(JSON.stringify({...report,running:true}));
  if (["quit", "uninstall"].includes(options.scenario)) {
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
    let threat = state.records.find(record => record.locator.subject === "Synthetic attachment");
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
    report.stage = "forget-history";
    const historyBeforeForget = state.records.length;
    const forget = await request("prepareForget", {keys:[largeKey]});
    check((await request("forgetMany", {token:forget.token})).count === 1, "Selected history removal commits");
    state = await request("state");
    check(state.records.length === historyBeforeForget - 1 && !state.records.some(record => record.key === largeKey), "Only selected history removed");
    check((await messenger.messages.get(incomplete.messageId)).id === incomplete.messageId, "History removal preserves other mail");
    check(state.records.find(record => record.key === incomplete.key).review?.note === "Synthetic reviewed encryption", "History removal preserves human review");
    report.historyRemoval = true;
  } else {
    check(state.settings.scanSettings.mailMiB === 50 && state.settings.quarantine[fixture.accountId].auto, "Updated settings retained");
    check(state.records.some(record => record.status === "deleted") && state.records.some(record => record.quarantine?.status === "moved"), "Updated result history retained");
    check(!state.records.some(record => record.locator.subject === "Synthetic size preflight"), "Committed history removal survives update");
    report.experimentalUpdate = true;
  }
  // Leave one actual clamd alive so the launcher can verify update/crash cleanup.
  const retained = new NativeClient(messenger.runtime);
  const sample = new TextEncoder().encode("Subject: synthetic lifecycle\r\n\r\nhello");
  check((await retained.scan(sample, await sha256(sample), state.settings.scanSettings)).status === "clean", "Lifecycle scan");
  const lifecycleRaw = fixture.mails.plain.replace(/Subject: [^\r\n]+/, "Subject: Synthetic lifecycle background " + report.version).replace(/Message-ID: [^\r\n]+/i, "Message-ID: <lifecycle-background-" + report.version + "@example.invalid>");
  const lifecycleMail = await messenger.messages.import(new File([lifecycleRaw], "lifecycle.eml", {type:"message/rfc822"}), fixture.source.id, {read:false,new:true});
  await messenger.testFixture.inject(lifecycleMail.id);
  await settled(state=>state.records.some(record=>record.messageId===lifecycleMail.id&&record.status==="clean"));
  report.runtime = await messenger.testFixture.runtime();
  check(report.runtime.sessions.length >= 2, "Lifecycle cleanup includes a retained background scanner");
  report.retainedBackgroundScanner = true;
  report.ok = true;
  await messenger.testFixture.report(JSON.stringify(report));
  if (report.version === "0.20.0a1") await messenger.testFixture.update();
  else if (["quit", "uninstall"].includes(options.scenario)) await messenger.testFixture.finish(options.scenario);
  }
  }
} catch (error) {
  report.error = String(error) + "\n" + error.stack;
  await messenger.testFixture.report(JSON.stringify(report));
}
