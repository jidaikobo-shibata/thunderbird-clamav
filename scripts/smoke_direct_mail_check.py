#!/usr/bin/python3
"""Real Thunderbird integration: synthetic local mail, migration, update and crash."""
import base64
import argparse
from email.message import EmailMessage
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import zipfile

from build_direct_mail_check import build

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests/fixtures/direct"
ID = "clam-mail-check@local.invalid"


def mails():
    eicar = base64.b64decode("WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=")
    data = {}
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
        zipped.writestr("synthetic.txt", eicar)
    for kind in ["plain", "attachment", "zip", "encrypted"]:
        message = EmailMessage()
        message["From"] = "synthetic@example.invalid"
        message["To"] = "test@example.invalid"
        message["Subject"] = "Synthetic " + kind
        message["Message-ID"] = "<" + kind + "@example.invalid>"
        message["Date"] = "Tue, 17 Nov 2026 10:00:00 +0900"
        message.set_content("Synthetic local mail only.")
        if kind in ["attachment", "zip"]:
            message.add_attachment(eicar if kind == "attachment" else archive.getvalue(), maintype="application", subtype="octet-stream", filename="synthetic.txt" if kind == "attachment" else "synthetic.zip")
        if kind == "encrypted":
            message.replace_header("Content-Type", 'multipart/encrypted; boundary="x"')
            message.set_payload('--x\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n--x--\r\n')
        data[kind] = message.as_bytes().decode("ascii")
    return data


def fixture_xpi(target, original, version, scenario="full"):
    with zipfile.ZipFile(original) as source:
        payload = {name: source.read(name) for name in source.namelist()}
    manifest = json.loads(payload["manifest.json"])
    manifest["version"] = version
    manifest["permissions"].append("messagesImport")
    manifest["experiment_apis"]["testFixture"] = {"schema": "fixture/schema.json", "parent": {"scopes": ["addon_parent"], "paths": [["testFixture"]], "script": "fixture/api.js"}}
    params = {"prepare": [], "inject": [{"name": "message", "type": "integer"}], "update": [],
              "backup": [{"name": "path", "type": "string"}], "runtime": [], "report": [{"name": "data", "type": "string"}],
              "finish": [{"name": "action", "type": "string"}], "idle": []}
    payload["fixture/schema.json"] = json.dumps([{"namespace": "testFixture", "functions": [{"name": name, "type": "function", "async": True, "parameters": values} for name, values in params.items()]}]).encode()
    payload["fixture/mail.json"] = json.dumps(mails()).encode()
    payload["fixture/options.json"] = json.dumps({"scenario": scenario}).encode()
    log_path = str(target.parent / "direct-daemon.log")
    payload["direct/host.py"] += ("\n_TestDaemonBase = MailDaemon\nclass MailDaemon(_TestDaemonBase):\n"
        " def close(self):\n"
        "  if self.diagnostics is not None:\n"
        "   try:\n"
        "    self.diagnostics.seek(0)\n"
        f"    with open({log_path!r}, 'ab') as log: log.write(self.diagnostics.read(MAX_FRAME))\n"
        "   except OSError: pass\n"
        "  return super().close()\n").encode()
    if scenario == "missing":
        payload["direct/host.py"] += b'\nCLAMSCAN = "/nonexistent-clam-mail-test/clamscan"\nCLAMD = "/nonexistent-clam-mail-test/clamd"\nCLAMAV_TRUST_ERROR = False\n'
    for name in ["api.js", "seed.js", "driver.js"]:
        payload["fixture/" + name] = (FIXTURE / name).read_bytes()
    if scenario in ("full", "quit", "uninstall"):
        # A one-off admission fault exercises the real receipt retry timer.
        payload["background.js"] = payload["background.js"].replace(b"const api = messenger;", b"""
        const api = messenger;
        const testStorageSet = api.storage.local.set.bind(api.storage.local);
        const testRaw = api.messages.getRaw.bind(api.messages);
        const testNotification = api.notifications.create.bind(api.notifications);
        api.notifications.create = async (id, options) => {
          const record = [...records,...(overflowReport?.recent || []),...(overflowPending ? [overflowPending] : [])].find(record=>record.key===id);
          if(record?.locator.subject === 'Synthetic held notification') {
            await testStorageSet({fixtureNotificationStarted:true,fixtureNotificationPayload:options});
            for(let attempt=0;attempt<4800;attempt++) {
              if((await api.storage.local.get('fixtureNotificationRelease')).fixtureNotificationRelease) break;
              await new Promise(resolve=>setTimeout(resolve,25));
            }
            await testStorageSet({fixtureNotificationReturned:true});
            return id;
          }
          return testNotification(id,options);
        };
        const testContinue = api.messages.continueList.bind(api.messages);
        let testPagedReceipt = null, testPagedMove = null, testOverflowSaved = null, testOverflowReads = 0, testFocusRecord = null;
        api.messages.continueList = async id => {
          if (id === 'fixture-receipt-page' || id === 'fixture-move-page') {
            const receipt = id === 'fixture-receipt-page';
            await testStorageSet({[receipt ? 'fixtureReceiptPageStarted' : 'fixtureMovePageStarted']:true});
            for (let attempt=0;attempt<4800;attempt++) {
              if ((await api.storage.local.get(receipt ? 'fixtureReceiptPageRelease' : 'fixtureMovePageRelease'))[receipt ? 'fixtureReceiptPageRelease' : 'fixtureMovePageRelease']) break;
              await new Promise(resolve => setTimeout(resolve,25));
            }
            const messages = receipt ? [await api.messages.get(testPagedReceipt)] : testPagedMove.messages;
            await testStorageSet({[receipt ? 'fixtureReceiptPageReturned' : 'fixtureMovePageReturned']:true});
            return {messages};
          }
          return testContinue(id);
        };
        let failedEarlyInput = false, failedLateInput = false, holdEarlyMove = false, failedSlowInput = false, reviewCarryReads = 0;
        const testAddNew = api.messages.onNewMailReceived.addListener.bind(api.messages.onNewMailReceived);
        let testNewListener;
        api.messages.onNewMailReceived.addListener = (listener, ...args) => {
          testNewListener = listener; return testAddNew(listener,...args);
        };
        const testAddMoved = api.messages.onMoved.addListener.bind(api.messages.onMoved);
        api.messages.onMoved.addListener = listener => testAddMoved((before,after) => {
          void (async () => {
            const hold = await api.storage.local.get('fixtureMovePageSourceId');
            if (!testPagedMove && before.messages.some(message => message.id === hold.fixtureMovePageSourceId)) {
              testPagedMove = before;
              await listener({messages:[],id:'fixture-move-page'},after);
              return;
            }
            if (holdEarlyMove) {
              holdEarlyMove = false;
              const target = after.messages.find(message => message.subject === 'Synthetic early raw move');
              if (!target) throw new Error('Missing synthetic moved header');
              // Replay the real destination header before forwarding its move.
              // Local folders do not always emit a second new-mail event.
              testNewListener(target.folder,{messages:[target]});
              const distinctIds = before.messages[0].id !== target.id;
              for (let attempt = 0; attempt < 200; attempt++) {
                if (!distinctIds || records.filter(record => record.locator.subject === target.subject).length === 2) break;
                await new Promise(resolve => setTimeout(resolve,10));
              }
              await testStorageSet({fixturePendingMoveStaged:distinctIds && records.filter(record => record.locator.subject === target.subject).length === 2});
              await listener(before,after);
              await testStorageSet({fixtureMoveForwarded:true});
              return;
            }
            await listener(before,after);
          })().catch(console.error);
        });
        api.storage.onChanged.addListener((changes, area) => {
          const focusKey = changes.fixtureFocusRecordKey?.newValue;
          if(area === 'local' && focusKey) {
            const record=records.find(record=>record.key===focusKey);
            if(record){testFocusRecord={record,updatedAt:record.updatedAt};record.updatedAt=new Date(Date.now()+60000).toISOString();void save().catch(console.error);}
          }
          if(area === 'local' && changes.fixtureFocusRestore?.newValue && testFocusRecord) {
            testFocusRecord.record.updatedAt=testFocusRecord.updatedAt;testFocusRecord=null;
            void save().then(()=>testStorageSet({fixtureFocusRestored:true})).catch(console.error);
          }
          const overflowContext = changes.fixtureOverflowContext?.newValue;
          if (area === 'local' && overflowContext) {
            testOverflowSaved = {records,overflowPending,overflowReport};
            records = Array.from({length:1000},(_,index)=>({key:'fixture-protected-'+index,status:'detected',
              locator:{accountId:overflowContext.accountId,folder:overflowContext.folder,headerMessageId:'fixture-protected-'+index+'@example.invalid'}}));
            overflowPending = null; overflowReport = null;
            void save().then(()=>testStorageSet({fixtureOverflowReady:true})).catch(console.error);
          }
          if (area === 'local' && changes.fixtureOverflowRestore?.newValue && testOverflowSaved) {
            void (async()=>{
              for(let attempt=0;attempt<2400&&automaticQuarantineTasks.size;attempt++) await new Promise(resolve=>setTimeout(resolve,25));
              if(automaticQuarantineTasks.size) throw new Error('Pending synthetic quarantine work');
              ({records,overflowPending,overflowReport}=testOverflowSaved);
              testOverflowSaved=null;
              await save(); await testStorageSet({fixtureOverflowRestored:true});
            })().catch(console.error);
          }
          const paged = changes.fixtureReceiptPageId?.newValue;
          if (area === 'local' && Number.isInteger(paged)) {
            testPagedReceipt = paged;
            void api.messages.get(paged).then(message => testNewListener(message.folder,{messages:[],id:'fixture-receipt-page'})).catch(console.error);
          }
          const replay = changes.fixtureQuarantineReplayId?.newValue ?? changes.fixtureReviewReplayId?.newValue;
          if (area === 'local' && Number.isInteger(replay)) {
            // Replay a resync notification using the real current header. The
            // local-folder notifier does not resend an already-known message.
            void api.messages.get(replay).then(message => testNewListener(message.folder,{messages:[message]})).catch(console.error);
          }
          const id = changes.fixtureQuarantineInvalidateId?.newValue;
          if (area !== 'local' || !Number.isInteger(id)) return;
          const record = records.find(record => record.messageId === id && record.quarantine?.status === 'moved');
          if (!record) return;
          // Model a stored quarantine identity before resynchronization. Keep
          // the real message and folder intact; production code never does this.
          record.messageId = null; record.session = null;
          void save().then(() => testStorageSet({fixtureQuarantineInvalidated:true})).catch(console.error);
        });
        api.messages.getRaw = async (id, options) => {
          const header = await api.messages.get(id);
          let reviewCarryHeld = false;
          let automaticHeld = false, receiptHeld = false;
          const quarantineGate = await api.storage.local.get('fixtureQuarantinePendingId');
          const alreadyHeld = await api.storage.local.get('fixtureQuarantineHeldId');
          if (quarantineGate.fixtureQuarantinePendingId === id && alreadyHeld.fixtureQuarantineHeldId !== id) {
            receiptHeld = true;
            await testStorageSet({fixtureQuarantineHeldId:id});
            await testStorageSet({fixtureQuarantineProofStarted:true});
            for (let attempt=0;attempt<4800;attempt++) {
              if ((await api.storage.local.get('fixtureQuarantineProofRelease')).fixtureQuarantineProofRelease) break;
              await new Promise(resolve => setTimeout(resolve,25));
            }
          }
          if (header.subject === 'Synthetic overflow threat 0' && ++testOverflowReads === 2) {
            await testStorageSet({fixtureOverflowQuarantineStarted:true});
            for(let attempt=0;attempt<4800;attempt++) {
              if((await api.storage.local.get('fixtureOverflowQuarantineRelease')).fixtureOverflowQuarantineRelease) break;
              await new Promise(resolve=>setTimeout(resolve,25));
            }
          }
          if (header.subject === 'Synthetic slow quarantine') {
            const state = await api.storage.local.get('fixtureAutoRawCount');
            const count = (state.fixtureAutoRawCount || 0) + 1;
            await testStorageSet({fixtureAutoRawCount:count});
            if (count === 2) {
              automaticHeld = true;
              await testStorageSet({fixtureAutoStarted:true});
              for (let attempt=0;attempt<4800;attempt++) {
                if ((await api.storage.local.get('fixtureAutoRelease')).fixtureAutoRelease) break;
                await new Promise(resolve => setTimeout(resolve,25));
              }
            }
          }
          if (header.subject === 'Synthetic reviewed oversized') {
            const hold = await api.storage.local.get('fixtureHoldReviewCarry');
            if (hold.fixtureHoldReviewCarry && ++reviewCarryReads === 2) {
              reviewCarryHeld = true;
              await testStorageSet({fixtureReviewCarryStarted:true});
              for (let attempt=0;attempt<4800;attempt++) {
                if ((await api.storage.local.get('fixtureReleaseReviewCarry')).fixtureReleaseReviewCarry) break;
                await new Promise(resolve => setTimeout(resolve,25));
              }
            }
          }
          if (!failedSlowInput && header.subject === 'Synthetic slow input') {
            failedSlowInput = true;
            await testStorageSet({fixtureSlowInputStarted:true});
            for (let attempt=0;attempt<4800;attempt++) {
              if ((await api.storage.local.get('fixtureReleaseSlowInput')).fixtureReleaseSlowInput) break;
              await new Promise(resolve => setTimeout(resolve,25));
            }
          }
          if (!failedEarlyInput && header.subject === 'Synthetic early raw move') {
            failedEarlyInput = true; holdEarlyMove = true;
            await testStorageSet({fixtureRawGateStarted:true});
            for (let attempt = 0; attempt < 400; attempt++) {
              if ((await api.storage.local.get('fixtureReleaseRawGate')).fixtureReleaseRawGate) throw new Error('synthetic old-body move failure');
              await new Promise(resolve => setTimeout(resolve,25));
            }
            throw new Error('synthetic raw gate timed out');
          }
          if (!failedLateInput && header.subject === 'Synthetic late raw move') {
            failedLateInput = true; throw new Error('synthetic late-body move failure');
          }
          const file = await testRaw(id,options);
          if (receiptHeld) await testStorageSet({fixtureQuarantineProofReturned:true});
          if (automaticHeld) await testStorageSet({fixtureAutoReturned:true});
          if (reviewCarryHeld) await testStorageSet({fixtureReviewCarryReturned:true});
          return file;
        };
        let failedReceipt = false;
        api.storage.local.set = async value => {
          if (!failedReceipt && Object.entries(value).some(([key, page]) => key.startsWith('historyPage:') && Array.isArray(page) &&
              page.some(record => record.source === 'automatic' && record.status === 'queued' && record.locator?.subject === 'Synthetic receipt recovery'))) {
            failedReceipt = true; throw new Error('synthetic incoming receipt failure');
          }
          return testStorageSet(value);
        };
        """)
    if scenario == "invalid-storage":
        payload["fixture/seed.js"] = payload["fixture/seed.js"].replace(
            b"await messenger.testFixture.update();", b"""
            const valid = await messenger.storage.local.get(null);
            await messenger.storage.local.set({fixtureValidStorage:valid, records:{format:99, keys:['preserved-review']}});
            await messenger.testFixture.update();
            """)
    if scenario in ("full", "quit", "uninstall"):
        # Exercise the real timer at a short deadline only for this synthetic mail.
        payload["background.js"] = payload["background.js"].replace(
            b"}, SCAN_INPUT_TIMEOUT_MS);",
            b"}, record.locator.subject === 'Synthetic slow input' ? 2000 : SCAN_INPUT_TIMEOUT_MS);")
        payload["background.js"] = payload["background.js"].replace(
            b"}, REVIEW_FINGERPRINT_TIMEOUT_MS);",
            b"}, record.locator.subject === 'Synthetic reviewed oversized' ? 2000 : REVIEW_FINGERPRINT_TIMEOUT_MS);")
    if scenario in ("full", "quit", "uninstall"):
        payload["background.js"] = payload["background.js"].replace(
            b"}, QUARANTINE_TIMEOUT_MS);",
            b"}, copy.locator.subject === 'Synthetic slow quarantine' ? 2000 : QUARANTINE_TIMEOUT_MS);")
        payload["background.js"] = payload["background.js"].replace(
            b"}, QUARANTINE_RECEIPT_TIMEOUT_MS);",
            b"}, (await api.storage.local.get('fixtureReceiptDeadline')).fixtureReceiptDeadline ? 2000 : QUARANTINE_RECEIPT_TIMEOUT_MS);")
    if scenario == "recovery":
        # Faults exist only in instrumented, disposable-profile XPIs.
        payload["fixture/seed.js"] = payload["fixture/seed.js"].replace(
            b"await messenger.testFixture.update();", b"""
            const {checkpointHint} = await import('../folder-scan.mjs');
            await messenger.storage.local.set({
              folderJob:{id:'preserved-job',folder:fixture.history,folders:[fixture.history],
                includeSubfolders:false,status:'stopped',completed:1,total:2,scanning:0,
                counts:{clean:0,detected:0,incomplete:1,error:0},detail:'Saved synthetic progress'},
              folderCheckpoint:{version:1,id:'preserved-job',entries:[[await checkpointHint(record.locator)+':'+digest,1]]}
            });
            await messenger.testFixture.update();
            """)
        payload["background.js"] = payload["background.js"].replace(b"const api = messenger;", b"""
        const api = messenger;
        const realStorageSet = api.storage.local.set.bind(api.storage.local);
        let testWrites = 0, failedFolderStart = false;
        api.storage.local.set = async value => {
          if (++testWrites === 3) throw new Error('synthetic startup storage failure');
          if (value.folderJob?.status === 'collecting' && !failedFolderStart) {
            failedFolderStart = true; throw new Error('synthetic folder start failure');
          }
          return realStorageSet(value);
        };
        """)
    if version == "0.19.2":
        manifest["experiment_apis"].pop("clamDirect")
        manifest["background"] = {"page": "fixture-seed.html"}
        payload["fixture-seed.html"] = b'<script type="module" src="fixture/seed.js"></script>'
    else:
        payload["dashboard.html"] = payload["dashboard.html"].replace(b'</body>', b'<script type="module" src="fixture/driver.js"></script></body>')
        # A dedicated extension iframe avoids platform-dependent first-run mail
        # windows. Requests still originate from the actual dashboard URL.
        payload["background.html"] = payload["background.html"].replace(b"</html>", b'<iframe src="dashboard.html"></iframe></html>')
        payload["background.js"] = payload["background.js"].replace(
            b'api.runtime.onInstalled.addListener(() => { void openDashboard().catch(report); });', b'// Test iframe opens the dashboard.')
        payload["direct/api.js"] += b'''\nvar TestDirectBase = clamDirect; clamDirect = class extends TestDirectBase {
          trace = [];
          async smallCommand(command, args) {
            const entry = {command, started: Date.now()}; this.trace.push(entry);
            try { const value = await super.smallCommand(command, args); entry.ok = true; return value; }
            catch (error) { entry.error = String(error); throw error; }
            finally { entry.elapsed = Date.now() - entry.started; await IOUtils.writeJSON(PathUtils.join(PathUtils.profileDir, "direct-startup.json"), this.trace); }
          }
          opened = [];
          async open() { const token = await super.open(); this.extension.__testDirect = this;
            const value = this.sessions.get(token); this.opened.push({pid:value.process.pid,directory:value.directory}); return token; }
        };\n'''
    payload["manifest.json"] = json.dumps(manifest).encode()
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as output:
        for name, value in payload.items():
            output.writestr(name, value)


def alive(pid):
    if sys.platform == "darwin":
        from importlib.util import spec_from_file_location, module_from_spec
        spec = spec_from_file_location("direct_guardian", ROOT / "experiments/direct-runtime/guardian.py")
        module = module_from_spec(spec); spec.loader.exec_module(module)
        return module.MacProcessMonitor().alive(pid)
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].strip().split()[0] != "Z"
    except FileNotFoundError:
        return False


def descendants(pid):
    result = [pid]
    if sys.platform == "darwin":
        rows = subprocess.check_output(["/bin/ps", "-axo", "pid=,ppid="], text=True)
        children = {}
        for row in rows.splitlines():
            child, parent = map(int, row.split())
            children.setdefault(parent, []).append(child)
        def visit(parent):
            for child in children.get(parent, []):
                result.append(child); visit(child)
        visit(pid)
        return result
    try:
        for child in Path(f"/proc/{pid}/task/{pid}/children").read_text().split():
            result.extend(descendants(int(child)))
    except FileNotFoundError:
        pass
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=["full", "missing", "quit", "uninstall", "recovery", "invalid-storage"], default="full")
    options = parser.parse_args()
    xpi = build()
    output = ROOT / ("dist/direct-mail-integration" + ("-" + options.scenario if options.scenario != "full" else ""))
    output.mkdir(parents=True, exist_ok=True)
    (output / "result.json").write_text('{"status":"running"}\n')
    with tempfile.TemporaryDirectory(prefix="clam-direct-mail-") as temporary:
        directory = Path(temporary)
        runtime = directory / "runtime"; runtime.mkdir(mode=0o700)
        profile = directory / "profile"; (profile / "extensions").mkdir(parents=True)
        fixture_xpi(profile / "extensions" / (ID + ".xpi"), xpi, "0.19.2", options.scenario)
        fixture_xpi(profile / "real-first.xpi", xpi, "0.20.0a1", options.scenario)
        fixture_xpi(profile / "real-next.xpi", xpi, "0.20.0a2", options.scenario)
        (profile / "real-mail-test-enabled").touch()
        prefs = {"extensions.autoDisableScopes": 0, "extensions.enabledScopes": 15, "extensions.startupScanScopes": 15,
            "extensions.logging.enabled": True, "mail.shell.checkDefaultClient": False, "mail.provider.enabled": False,
            "mailnews.start_page.enabled": False, "app.update.auto": False, "extensions.update.enabled": False,
            "datareporting.policy.dataSubmissionEnabled": False, "datareporting.healthreport.uploadEnabled": False,
            "extensions.getAddons.cache.enabled": False, "devtools.console.stdout.content": True,
            "browser.dom.window.dump.enabled": True}
        (profile / "user.js").write_text("".join(f"user_pref({json.dumps(k)}, {json.dumps(v)});\n" for k, v in prefs.items()))
        bus = directory / "bus.conf"
        bus.write_text('<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>')
        env = {**os.environ, "XDG_RUNTIME_DIR": str(runtime), "DISPLAY": "", "WAYLAND_DISPLAY": "clam-direct-mail",
               "MOZ_ENABLE_WAYLAND": "1", "GDK_BACKEND": "wayland", "GSETTINGS_BACKEND": "memory",
               "XDG_CONFIG_HOME": str(directory / "config"), "XDG_CACHE_HOME": str(directory / "cache"),
               "XDG_DATA_HOME": str(directory / "data"), "GTK_USE_PORTAL": "0", "MOZ_NO_REMOTE": "1",
               "MOZ_CRASHREPORTER_DISABLE": "1", "MOZ_LOG": "PageMessages:5,console:5"}
        processes = []
        with (output / "thunderbird.log").open("w") as log:
            try:
                if sys.platform == "darwin":
                    command = ["/Applications/Thunderbird.app/Contents/MacOS/thunderbird", "--headless"]
                    env = {**os.environ, "MOZ_NO_REMOTE": "1", "MOZ_CRASHREPORTER_DISABLE": "1",
                           "MOZ_LOG": "PageMessages:5,console:5"}
                elif sys.platform == "linux":
                    compositor = subprocess.Popen(["/usr/bin/weston", "--backend=headless", "--renderer=pixman", "--shell=kiosk-shell.so", "--no-config", "--idle-time=0", "--socket=clam-direct-mail", "--log=" + str(directory / "weston.log")], env=env, stdout=log, stderr=log, start_new_session=True)
                    processes.append(compositor)
                    for _ in range(100):
                        if (runtime / "clam-direct-mail").exists(): break
                        time.sleep(0.05)
                    else: raise RuntimeError("Independent Wayland did not start")
                    command = ["/usr/bin/dbus-run-session", "--config-file=" + str(bus), "--", "/usr/bin/thunderbird-esr"]
                else:
                    raise RuntimeError("Unsupported integration platform")
                browser = subprocess.Popen(command + ["--no-remote", "--new-instance", "--offline", "--profile", str(profile)], env=env, stdout=log, stderr=log, start_new_session=True)
                processes.append(browser)
                deadline = time.monotonic() + 1200
                while time.monotonic() < deadline:
                    results = []
                    versions = ["0.20.0a1"] if options.scenario in ("missing", "recovery", "invalid-storage") else ["0.20.0a1", "0.20.0a2"]
                    for version in versions:
                        path = profile / f"direct-result-{version}.json"
                        if path.exists():
                            result = json.loads(path.read_text())
                            if not result["ok"]: raise RuntimeError(result)
                            results.append(result)
                    if len(results) == len(versions):
                        if len(results) == 2:
                            old_sessions = results[0]["runtime"]["sessions"]
                            assert all(not Path(session["directory"]).exists() and not alive(session["pid"]) for session in old_sessions), "Update left a scanner"
                        active = results[-1]["runtime"]
                        for result in results:
                            closed = [*result.get("completedSessions", []), *result.get("rescanCleanup", []), *result.get("cancelledSessions", [])]
                            assert all(not Path(value["directory"]).exists() and not alive(value["pid"]) for value in closed), "Completed/cancelled scan left resources"
                        children = [pid for session in active["sessions"] for pid in descendants(session["pid"])]
                        assert len(children) >= (2 if options.scenario in ("missing", "recovery", "invalid-storage") else 3), "Expected supervised scanner descendants"
                        if options.scenario in ("full", "missing", "recovery", "invalid-storage"):
                            os.kill(active["parent"], signal.SIGKILL)
                        else:
                            (profile / "direct-action-ready").touch()
                        for _ in range(300):
                            if not any(alive(pid) for pid in children) and all(not Path(session["directory"]).exists() for session in active["sessions"]): break
                            time.sleep(0.05)
                        else: raise RuntimeError("Parent crash left a scanner or private mail files")
                        report = {"ok": True, "scenario": options.scenario, "results": results,
                                  "updateCleanup": len(results) == 2, "lifecycleCleanup": True}
                        (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
                        print(json.dumps(report, indent=2))
                        return
                    diagnostic = (output / "thunderbird.log").read_text(errors="replace")
                    if "ERROR\tLoading extension 'clam-mail-check" in diagnostic or any("JavaScript Error" in line and "/fixture/" in line for line in diagnostic.splitlines()): raise RuntimeError("Extension load failed; see log")
                    if browser.poll() is not None: raise RuntimeError(f"Thunderbird exited before integration: code={browser.returncode}; see log")
                    time.sleep(0.2)
                raise RuntimeError("Real-mail integration timed out; see log")
            except BaseException as error:
                (output / "result.json").write_text(json.dumps({"ok": False, "scenario": options.scenario, "error": str(error)}, ensure_ascii=False, indent=2) + "\n")
                raise
            finally:
                for process in reversed(processes):
                    try:
                        if process.poll() is None:
                            try:
                                os.killpg(process.pid, signal.SIGTERM)
                            except PermissionError:
                                if process.poll() is None:
                                    process.terminate()
                        process.wait(timeout=5)
                    except ProcessLookupError: pass
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL); process.wait(timeout=5)
                for path in profile.glob("direct-result-*.json"):
                    (output / path.name).write_bytes(path.read_bytes())
                for path in profile.glob("direct-startup.json"):
                    (output / path.name).write_bytes(path.read_bytes())
                for path in profile.glob("direct-daemon.log"):
                    (output / path.name).write_bytes(path.read_bytes())


if __name__ == "__main__":
    main()
