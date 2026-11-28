import base64
import hashlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from native import host
from scripts.build_direct_mail_check import build


@unittest.skipUnless(sys.platform == "win32", "Windows scanner runtime")
class WindowsRuntimeTests(unittest.TestCase):
    def test_packaged_guardian_on_unicode_path_rejects_oversize_and_administration(self):
        with tempfile.TemporaryDirectory(prefix="検査 profile ") as temp, zipfile.ZipFile(build(output_dir=temp)) as archive:
            session = Path(temp) / "clam-mail-direct-0123456789abcdef"
            session.mkdir()
            for name in ("host.py", "windows.py"):
                (session / name).write_bytes(archive.read("direct/" + name))
            with subprocess.Popen([sys.executable, "-I", "-S", "-B", str(session / "windows.py"), str(os.getpid())],
                                  env={**os.environ, "LOCALAPPDATA": temp}, stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE) as guardian:
                requests = [{"op": "manageInfo"}, {"op": "begin", "size": (5 << 20) + 1, "scanSettings": {"mailMiB": 5}},
                            {"op": "begin", "size": 1}, {"op": "abort"}]
                frames = io.BytesIO()
                for number, request in enumerate(requests):
                    host.write_frame(frames, {"id": str(number), **request})
                try:
                    output, _ = guardian.communicate(frames.getvalue(), timeout=10)
                finally:
                    if guardian.poll() is None:
                        guardian.kill()
                responses = io.BytesIO(output)
                self.assertEqual([host.read_frame(responses)["status"] for _ in requests],
                                 ["error", "error", "accepted", "aborted"])
            self.assertFalse(session.exists())

    @unittest.skipUnless(os.environ.get("CLAM_MAIL_TEST_DATABASE"), "Requires disposable official definitions")
    def test_real_engine_crash_does_not_report_clean_or_leave_temporary_files(self):
        # Exercise the unmodified packaged worker with an isolated LocalAppData.
        database = Path(os.environ["CLAM_MAIL_TEST_DATABASE"]).resolve(strict=True)
        with tempfile.TemporaryDirectory(dir=database.parent, prefix="検査 mail ") as temp, zipfile.ZipFile(build(output_dir=temp)) as archive:
            directory = Path(temp)
            private_db = directory / "ClamAV/database"
            private_db.mkdir(parents=True)
            for db in database.iterdir():
                if db.suffix in (".cld", ".cvd", ".sign"):
                    os.link(db, private_db / db.name)
            session = directory / "clam-mail-direct-0123456789abcdef"
            session.mkdir()
            for name in ("host.py", "windows.py"):
                (session / name).write_bytes(archive.read("direct/" + name))
            env = {**os.environ, "LOCALAPPDATA": temp}
            with subprocess.Popen([sys.executable, "-I", "-S", "-B", str(session / "windows.py"), str(os.getpid())],
                                  env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE) as guardian:
                data = b"Subject: synthetic\r\n\r\nhello"
                for request in [{"op": "begin", "size": len(data)},
                                {"op": "chunk", "seq": 0, "data": base64.b64encode(data).decode()}]:
                    host.write_frame(guardian.stdin, {"id": "test", **request})
                    self.assertEqual(host.read_frame(guardian.stdout)["status"], "accepted")
                host.write_frame(guardian.stdin, {"id": "end", "op": "end", "sha256": hashlib.sha256(data).hexdigest()})
                try:
                    # Identify the actual engine by parentage and the unique private input path.
                    script = """
$ErrorActionPreference = 'Stop'
$workers = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$env:CLAM_TEST_PARENT AND Name='python.exe'")
if ($workers.Count -ne 1) { exit 1 }
for ($i = 0; $i -lt 100; $i++) {
    $targets = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($workers[0].ProcessId) AND Name='clamscan.exe'")
    if ($targets.Count -eq 1 -and $targets[0].CommandLine.Contains($env:CLAM_TEST_SESSION)) {
        $process = [Diagnostics.Process]::GetProcessById($targets[0].ProcessId)
        $null = $process.Handle
        if ($process.MainModule.FileName -ne $env:CLAM_TEST_ENGINE) { exit 1 }
        $process.Kill()
        $process.WaitForExit()
        exit 0
    }
    Start-Sleep -Milliseconds 30
}
exit 1
"""
                    powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
                    subprocess.run([str(powershell), "-NoProfile", "-NonInteractive", "-Command", script],
                                   env={**os.environ, "CLAM_TEST_PARENT": str(guardian.pid),
                                        "CLAM_TEST_SESSION": str(session), "CLAM_TEST_ENGINE": host.CLAMSCAN},
                                   timeout=20, check=True)
                    output, _ = guardian.communicate(timeout=10)
                    self.assertEqual(host.read_frame(io.BytesIO(output))["status"], "error")
                finally:
                    if guardian.poll() is None:
                        (session / "stop").touch()
                        guardian.wait(timeout=10)
            self.assertFalse(session.exists())

    def test_gui_definitions_are_pinned_and_respect_the_gui_update_lock(self):
        import msvcrt
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, LOCALAPPDATA=str(Path(tmp).resolve())), \
                patch.object(host, "DIRECT_RUNTIME", True):
            root = Path(os.environ["LOCALAPPDATA"]) / "clamav-gui"
            (root / "database").mkdir(parents=True)
            session = host.Session()
            shared = {"definitionSource": "gui"}
            with patch.object(host, "health") as health:
                self.assertEqual(session.handle({"op": "health", **shared})["status"], "error")
                health.assert_not_called()
                with (root / "freshclam.lock").open("a+b") as lock:
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                    self.assertEqual(session.handle({"op": "health", **shared})["status"], "error")
                    health.assert_not_called()
                    session.handle({"op": "begin", "size": 1, **shared})
                    session.handle({"op": "chunk", "seq": 0, "data": "YQ=="})
                    end = {"op": "end", "sha256": hashlib.sha256(b"a").hexdigest()}
                    with patch.object(host, "scan") as scan:
                        self.assertEqual(session.handle(end)["status"], "error")
                        scan.assert_not_called()
                health.return_value = {"status": "ready", "engine": "ClamAV test", "definitionTimestamp": 1000}
                self.assertEqual(session.handle({"op": "health", **shared})["definitionSource"], "gui")
                health.assert_called_once_with(str(root / "database"))
                session.handle({"op": "begin", "size": 1, **shared})
                with patch.object(host, "DATABASE", str(root.parent / "ClamAV" / "database")):
                    session.handle({"op": "health"})  # Must not switch the in-flight message.
                session.handle({"op": "chunk", "seq": 0, "data": "YQ=="})
                with patch.object(host, "scan", return_value={"status": "clean"}) as scan:
                    session.handle(end)
                    scan.assert_called_once_with(b"a", None, None, str(root / "database"))
                with self.assertRaises(host.ProtocolError):
                    session.handle({"op": "health", "definitionSource": str(root)})

    def test_default_and_migrated_sources_share_standalone_lock(self):
        import msvcrt
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            database = root / "ClamAV" / "database"
            with patch.dict(os.environ, LOCALAPPDATA=str(root)), patch.object(host, "DATABASE", str(database)):
                with host.windows_definitions("addon") as first:
                    self.assertEqual(first, str(database))
                    (database.parent / "gui-definitions-ready").touch()
                    with host.windows_definitions("gui") as second:
                        self.assertEqual(first, second)
                        with (database.parent / "freshclam.lock").open("a+b") as stream:
                            with self.assertRaises(OSError):
                                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                with (database.parent / "freshclam.lock").open("a+b") as stream:
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                    for source in ("addon", "gui"):
                        with self.assertRaises(OSError), host.windows_definitions(source):
                            pass

    def test_partial_database_is_rejected_before_scanning(self):
        with tempfile.TemporaryDirectory(prefix="定義 test ") as directory:
            with patch.object(host, "DATABASE", directory), patch.object(host, "CLAMSCAN", sys.executable), \
                    patch.object(host, "CLAMAV_TRUST_ERROR", False), patch.object(host.subprocess, "run") as run:
                for name in ("main", "daily"):
                    Path(directory, name + ".cvd").touch()
                    self.assertEqual(host.scan_clamscan(b"synthetic")["code"], "definitions_unavailable")
                run.assert_not_called()

    def test_unparseable_version_fails_and_old_readable_version_is_ready(self):
        with patch.object(host, "CLAMSCAN", sys.executable), patch.object(host, "CLAMAV_TRUST_ERROR", False), \
                patch.object(host, "windows_definitions_present", return_value=True):
            for version in (b"ClamAV 1.5.5", b"ClamAV 1.5.5/123/unknown"):
                result = subprocess.CompletedProcess([], 0, version, b"")
                with self.subTest(version=version), patch.object(host.subprocess, "run", return_value=result):
                    self.assertEqual(host.health()["code"], "definitions_unavailable")

            version = b"ClamAV 1.5.5/123/Mon Nov 20 00:00:00 2000"
            with patch.object(host.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, version, b"")):
                self.assertEqual(host.health()["status"], "ready")

    def test_timeout_and_failed_launch_remove_temporary_input(self):
        with tempfile.TemporaryDirectory(prefix="メール test ") as directory:
            with patch.object(host, "CLAMSCAN", sys.executable), patch.object(host, "CLAMAV_TRUST_ERROR", False), \
                    patch.object(host, "windows_definitions_present", return_value=True), patch.object(host, "TEMP_ROOT", directory):
                for error in (subprocess.TimeoutExpired([], 1), PermissionError()):
                    with patch.object(host.subprocess, "run", side_effect=error):
                        self.assertEqual(host.scan_clamscan(b"synthetic")["status"], "error")
                    self.assertEqual(os.listdir(directory), [])

    def test_mime_job_enforces_commit_limit(self):
        guardian = Path(__file__).resolve().parents[1] / "experiments/direct-runtime/windows.py"
        program = """
import runpy, sys
runpy.run_path(sys.argv[1])["limit_mime"]()
try:
    bytearray(513 << 20)
except MemoryError:
    sys.exit(0)
sys.exit(1)
"""
        subprocess.run([sys.executable, "-I", "-S", "-B", "-c", program, str(guardian)], check=True, timeout=10)

    def test_mime_job_terminates_cpu_bound_child(self):
        guardian = Path(__file__).resolve().parents[1] / "experiments/direct-runtime/windows.py"
        program = """
import runpy, sys
runpy.run_path(sys.argv[1])["limit_mime"]()
print("limited", flush=True)
while True:
    pass
"""
        result = subprocess.run([sys.executable, "-I", "-S", "-B", "-c", program, str(guardian)],
                                capture_output=True, timeout=15)
        self.assertEqual(result.stdout.strip(), b"limited")
        self.assertNotEqual(result.returncode, 0)
