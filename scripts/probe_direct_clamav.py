#!/usr/bin/python3
"""Run only synthetic scans in a disposable Thunderbird/Wayland/D-Bus profile."""
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "experiments/direct-clamav"
IDENTIFIER = "direct-clam-probe@local.invalid"


def package(target, version):
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(SOURCE.iterdir()):
            if path.suffix not in {".json", ".js", ".html"}:
                continue
            data = path.read_bytes()
            if path.name == "manifest.json":
                manifest = json.loads(data)
                manifest["version"] = version
                data = json.dumps(manifest).encode()
            archive.writestr(path.name, data)


def main():
    output = ROOT / "dist/direct-clamav-probe"
    output.mkdir(parents=True, exist_ok=True)
    (output / "result.json").write_text(json.dumps({"status": "running"}) + "\n")
    package(output / "direct-clam-probe-0.1.0.xpi", "0.1.0")
    with tempfile.TemporaryDirectory(prefix="direct-clam-thunderbird-") as temporary:
        directory = Path(temporary)
        runtime = directory / "runtime"
        runtime.mkdir(mode=0o700)
        profile = directory / "profile"
        (profile / "extensions").mkdir(parents=True)
        package(profile / "extensions" / (IDENTIFIER + ".xpi"), "0.1.0")
        package(profile / "probe-update.xpi", "0.1.1")
        (profile / "direct-clam-test-enabled").write_text("Synthetic test profile only\n")
        # Only this disposable profile is configured. No remote-control permission is used.
        prefs = {
            "extensions.autoDisableScopes": 0, "extensions.enabledScopes": 15,
            "extensions.startupScanScopes": 15,
            "extensions.logging.enabled": True, "devtools.console.stdout.chrome": True,
            "mail.shell.checkDefaultClient": False, "mail.provider.enabled": False,
            "mailnews.start_page.enabled": False, "mail.biff.play_sound": False,
            "app.update.auto": False, "extensions.update.enabled": False,
            "toolkit.telemetry.reportingpolicy.firstRun": False,
            "datareporting.policy.dataSubmissionEnabled": False,
            "datareporting.healthreport.uploadEnabled": False,
            "browser.dom.window.dump.enabled": True,
        }
        (profile / "user.js").write_text("".join(f"user_pref({json.dumps(key)}, {json.dumps(value)});\n" for key, value in prefs.items()))
        bus = directory / "session-bus.conf"
        bus.write_text('<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen>'
                       '<policy context="default"><allow send_destination="*"/>'
                       '<allow receive_sender="*"/><allow own="*"/></policy></busconfig>')
        env = {**os.environ, "XDG_RUNTIME_DIR": str(runtime), "DISPLAY": "",
               "WAYLAND_DISPLAY": "clam-direct-test", "MOZ_ENABLE_WAYLAND": "1",
               "GDK_BACKEND": "wayland", "GSETTINGS_BACKEND": "memory",
               "XDG_CONFIG_HOME": str(directory / "config"),
               "XDG_CACHE_HOME": str(directory / "cache"),
               "XDG_DATA_HOME": str(directory / "data"), "GTK_USE_PORTAL": "0",
               "MOZ_CRASHREPORTER_DISABLE": "1", "MOZ_NO_REMOTE": "1",
               "MOZ_LOG": "PageMessages:5,console:5"}
        processes = []
        with (output / "thunderbird.log").open("w") as log:
            try:
                weston = subprocess.Popen(["/usr/bin/weston", "--backend=headless", "--renderer=pixman",
                    "--shell=kiosk-shell.so", "--no-config", "--idle-time=0", "--width=1000", "--height=800",
                    "--socket=clam-direct-test", "--log=" + str(directory / "weston.log")],
                    env=env, stdout=log, stderr=log, start_new_session=True)
                processes.append(weston)
                for _ in range(100):
                    if (runtime / "clam-direct-test").exists():
                        break
                    if weston.poll() is not None:
                        raise RuntimeError("Headless Wayland did not start")
                    time.sleep(0.05)
                else:
                    raise RuntimeError("Headless Wayland timed out")
                thunderbird = subprocess.Popen(["/usr/bin/dbus-run-session", "--config-file=" + str(bus), "--",
                    "/usr/bin/thunderbird-esr", "--no-remote", "--new-instance", "--offline", "--profile", str(profile)],
                    env=env, stdout=log, stderr=log, start_new_session=True)
                processes.append(thunderbird)
                deadline = time.monotonic() + 180
                while time.monotonic() < deadline:
                    results = []
                    for version in ("0.1.0", "0.1.1"):
                        path = profile / ("probe-result-" + version + ".json")
                        if path.exists():
                            result = json.loads(path.read_text())
                            if not result["ok"]:
                                raise RuntimeError(result)
                            results.append(result)
                    cleanups = list(profile.glob("probe-cleanup-*.json"))
                    if len(results) == 2 and len(cleanups) == 2:
                        for result in results:
                            assert not Path(result["temporaryDirectory"]).exists(), result
                            assert not Path(f'/proc/{result["daemonPid"]}').exists(), result
                        report = {"ok": True, "results": results,
                                  "cleanup": [json.loads(path.read_text()) for path in sorted(cleanups)],
                                  "installedExtensionAbsent": not (profile / "extensions" / (IDENTIFIER + ".xpi")).exists()}
                        assert report["installedExtensionAbsent"]
                        # Restart the SAME disposable profile with a crash-test build.
                        # Killing only the Thunderbird PID (not its process group) tests PDEATHSIG.
                        os.killpg(thunderbird.pid, signal.SIGTERM)
                        thunderbird.wait(timeout=5)
                        processes.remove(thunderbird)
                        package(profile / "extensions" / (IDENTIFIER + ".xpi"), "0.1.2")
                        crash_browser = subprocess.Popen(["/usr/bin/dbus-run-session", "--config-file=" + str(bus), "--",
                            "/usr/bin/thunderbird-esr", "--no-remote", "--new-instance", "--offline", "--profile", str(profile)],
                            env=env, stdout=log, stderr=log, start_new_session=True)
                        processes.append(crash_browser)
                        crash_result = profile / "probe-result-0.1.2.json"
                        crash_deadline = time.monotonic() + 60
                        while not crash_result.exists() and time.monotonic() < crash_deadline:
                            time.sleep(0.1)
                        if not crash_result.exists():
                            raise RuntimeError("Crash test did not produce a result")
                        crash = json.loads(crash_result.read_text())
                        assert crash["ok"], crash
                        status = Path(f'/proc/{crash["daemonPid"]}/status').read_text()
                        report["crashDaemonStatusBefore"] = [line for line in status.splitlines() if line.startswith(("Name:", "State:", "PPid:"))]
                        os.kill(crash["parentPid"], signal.SIGKILL)
                        daemon_proc = Path(f'/proc/{crash["daemonPid"]}/stat')
                        def running():
                            try:
                                return daemon_proc.read_text().rsplit(")", 1)[1].strip().split()[0] != "Z"
                            except FileNotFoundError:
                                return False
                        for _ in range(100):
                            if not running():
                                break
                            time.sleep(0.05)
                        report["parentDeathStopsDaemon"] = not running()
                        if running():
                            status = Path(f'/proc/{crash["daemonPid"]}/status').read_text()
                            report["crashDaemonStatusAfter"] = [line for line in status.splitlines() if line.startswith(("Name:", "State:", "PPid:"))]
                            os.kill(crash["daemonPid"], signal.SIGKILL)
                            for _ in range(100):
                                if not running():
                                    break
                                time.sleep(0.05)
                            assert not running(), "Test launcher could not stop its daemon"
                        crash_directory = Path(crash["temporaryDirectory"])
                        assert crash_directory.parent == Path(tempfile.gettempdir())
                        assert crash_directory.name.startswith("direct-clam-probe")
                        if crash_directory.exists():
                            shutil.rmtree(crash_directory)
                        report["productionReady"] = False
                        report["crashTemporaryFilesCleanedByLauncher"] = True
                        (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
                        print(json.dumps(report, indent=2))
                        return
                    if thunderbird.poll() is not None:
                        raise RuntimeError("Thunderbird exited before producing results")
                    diagnostic = (output / "thunderbird.log").read_text(errors="replace")
                    if "ERROR\tLoading extension 'direct-clam-probe" in diagnostic or "ClamAV probe:" in diagnostic:
                        raise RuntimeError("Experiment API load failed; see thunderbird.log")
                    time.sleep(0.25)
                raise RuntimeError("Probe timed out; see dist/direct-clamav-probe/thunderbird.log")
            finally:
                for process in reversed(processes):
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                        process.wait(timeout=5)
                    except ProcessLookupError:
                        pass
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=5)
                for path in profile.glob("probe-*.json"):
                    (output / path.name).write_bytes(path.read_bytes())


if __name__ == "__main__":
    main()
