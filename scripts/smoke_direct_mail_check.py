#!/usr/bin/python3
"""Real Thunderbird integration: synthetic local mail, migration, update and crash."""
import base64
from email.message import EmailMessage
import io
import json
import os
from pathlib import Path
import signal
import subprocess
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


def fixture_xpi(target, original, version):
    with zipfile.ZipFile(original) as source:
        payload = {name: source.read(name) for name in source.namelist()}
    manifest = json.loads(payload["manifest.json"])
    manifest["version"] = version
    manifest["permissions"].append("messagesImport")
    manifest["experiment_apis"]["testFixture"] = {"schema": "fixture/schema.json", "parent": {"scopes": ["addon_parent"], "paths": [["testFixture"]], "script": "fixture/api.js"}}
    params = {"prepare": [], "inject": [{"name": "message", "type": "integer"}], "update": [],
              "backup": [{"name": "path", "type": "string"}], "runtime": [], "report": [{"name": "data", "type": "string"}]}
    payload["fixture/schema.json"] = json.dumps([{"namespace": "testFixture", "functions": [{"name": name, "type": "function", "async": True, "parameters": values} for name, values in params.items()]}]).encode()
    payload["fixture/mail.json"] = json.dumps(mails()).encode()
    for name in ["api.js", "seed.js", "driver.js"]:
        payload["fixture/" + name] = (FIXTURE / name).read_bytes()
    if version == "0.19.2":
        manifest["experiment_apis"].pop("clamDirect")
        manifest["background"] = {"page": "fixture-seed.html"}
        payload["fixture-seed.html"] = b'<script type="module" src="fixture/seed.js"></script>'
    else:
        payload["dashboard.html"] = payload["dashboard.html"].replace(b'</body>', b'<script type="module" src="fixture/driver.js"></script></body>')
        payload["direct/api.js"] += b'\nvar TestDirectBase = clamDirect; clamDirect = class extends TestDirectBase { async open() { const token = await super.open(); this.extension.__testDirect = this; return token; } };\n'
    payload["manifest.json"] = json.dumps(manifest).encode()
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as output:
        for name, value in payload.items():
            output.writestr(name, value)


def alive(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].strip().split()[0] != "Z"
    except FileNotFoundError:
        return False


def descendants(pid):
    result = [pid]
    try:
        for child in Path(f"/proc/{pid}/task/{pid}/children").read_text().split():
            result.extend(descendants(int(child)))
    except FileNotFoundError:
        pass
    return result


def main():
    xpi = build()
    output = ROOT / "dist/direct-mail-integration"
    output.mkdir(parents=True, exist_ok=True)
    (output / "result.json").write_text('{"status":"running"}\n')
    with tempfile.TemporaryDirectory(prefix="clam-direct-mail-") as temporary:
        directory = Path(temporary)
        runtime = directory / "runtime"; runtime.mkdir(mode=0o700)
        profile = directory / "profile"; (profile / "extensions").mkdir(parents=True)
        fixture_xpi(profile / "extensions" / (ID + ".xpi"), xpi, "0.19.2")
        fixture_xpi(profile / "real-first.xpi", xpi, "0.20.0a1")
        fixture_xpi(profile / "real-next.xpi", xpi, "0.20.0a2")
        (profile / "real-mail-test-enabled").touch()
        prefs = {"extensions.autoDisableScopes": 0, "extensions.enabledScopes": 15, "extensions.startupScanScopes": 15,
            "extensions.logging.enabled": True, "mail.shell.checkDefaultClient": False, "mail.provider.enabled": False,
            "mailnews.start_page.enabled": False, "app.update.auto": False, "extensions.update.enabled": False,
            "datareporting.policy.dataSubmissionEnabled": False, "datareporting.healthreport.uploadEnabled": False}
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
                compositor = subprocess.Popen(["/usr/bin/weston", "--backend=headless", "--renderer=pixman", "--shell=kiosk-shell.so", "--no-config", "--idle-time=0", "--socket=clam-direct-mail", "--log=" + str(directory / "weston.log")], env=env, stdout=log, stderr=log, start_new_session=True)
                processes.append(compositor)
                for _ in range(100):
                    if (runtime / "clam-direct-mail").exists(): break
                    time.sleep(0.05)
                else: raise RuntimeError("Independent Wayland did not start")
                browser = subprocess.Popen(["/usr/bin/dbus-run-session", "--config-file=" + str(bus), "--", "/usr/bin/thunderbird-esr", "--no-remote", "--new-instance", "--offline", "--profile", str(profile)], env=env, stdout=log, stderr=log, start_new_session=True)
                processes.append(browser)
                deadline = time.monotonic() + 240
                while time.monotonic() < deadline:
                    results = []
                    for version in ["0.20.0a1", "0.20.0a2"]:
                        path = profile / f"direct-result-{version}.json"
                        if path.exists():
                            result = json.loads(path.read_text())
                            if not result["ok"]: raise RuntimeError(result)
                            results.append(result)
                    if len(results) == 2:
                        old_sessions = results[0]["runtime"]["sessions"]
                        assert all(not Path(session["directory"]).exists() and not alive(session["pid"]) for session in old_sessions), "Update left a scanner"
                        active = results[1]["runtime"]
                        children = [pid for session in active["sessions"] for pid in descendants(session["pid"])]
                        assert len(children) >= 3, "Expected guardian, scanner and clamd"
                        os.kill(active["parent"], signal.SIGKILL)
                        for _ in range(100):
                            if not any(alive(pid) for pid in children) and all(not Path(session["directory"]).exists() for session in active["sessions"]): break
                            time.sleep(0.05)
                        else: raise RuntimeError("Parent crash left a scanner or private mail files")
                        report = {"ok": True, "results": results, "updateCleanup": True, "crashCleanup": True}
                        (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
                        print(json.dumps(report, indent=2))
                        return
                    diagnostic = (output / "thunderbird.log").read_text(errors="replace")
                    if "ERROR\tLoading extension 'clam-mail-check" in diagnostic or any("JavaScript Error" in line and "/fixture/" in line for line in diagnostic.splitlines()): raise RuntimeError("Extension load failed; see log")
                    if browser.poll() is not None: raise RuntimeError("Thunderbird exited before the integration completed")
                    time.sleep(0.2)
                raise RuntimeError("Real-mail integration timed out; see log")
            finally:
                for process in reversed(processes):
                    try:
                        os.killpg(process.pid, signal.SIGTERM); process.wait(timeout=5)
                    except ProcessLookupError: pass
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL); process.wait(timeout=5)
                for path in profile.glob("direct-result-*.json"):
                    (output / path.name).write_bytes(path.read_bytes())


if __name__ == "__main__":
    main()
