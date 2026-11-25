import base64
import hashlib
import io
import json
from pathlib import Path
import struct
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from native import host
from scripts.build_mail_check import build
from scripts.register_mail_host import install


def frame(value):
    data = json.dumps(value).encode()
    return struct.pack("=I", len(data)) + data


class ProtocolTests(unittest.TestCase):
    def test_fragmented_reads_and_eof(self):
        class Fragmented(io.BytesIO):
            def read(self, size=-1):
                return super().read(min(size, 2))
        value = {"id": "1", "op": "health"}
        stream = Fragmented(frame(value))
        self.assertEqual(host.read_frame(stream), value)
        self.assertIsNone(host.read_frame(stream))

    def test_rejects_large_truncated_and_nonobject_frames(self):
        for data in [struct.pack("=I", host.MAX_FRAME + 1), b"\x04", frame([]),
                     struct.pack("=I", 5) + b"no"]:
            with self.subTest(data=data), self.assertRaises(host.ProtocolError):
                host.read_frame(io.BytesIO(data))

    def test_round_trip_preserves_binary_and_scans_only_after_digest(self):
        data = bytes(range(256)) * 300
        session = host.Session()
        session.handle({"op": "begin", "size": len(data)})
        for seq, start in enumerate(range(0, len(data), host.CHUNK_SIZE)):
            session.handle({"op": "chunk", "seq": seq,
                            "data": base64.b64encode(data[start:start + host.CHUNK_SIZE]).decode()})
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(host, "DATABASE", str(Path(tmp).resolve() / "database")), \
             patch.object(host, "health", return_value={"status": "ready", "engine": "test"}), \
             patch.object(host, "scan", return_value={"status": "clean"}) as scan:
            self.assertEqual(session.handle({"op": "end", "sha256": hashlib.sha256(data).hexdigest()})["status"], "clean")
            if sys.platform == "win32":
                scan.assert_called_once_with(data, None, None, host.DATABASE)
            else:
                scan.assert_called_once_with(data, session.scanner)
        self.assertIsNone(session.buffer)

    def test_rejects_sequence_overflow_short_data_and_wrong_digest(self):
        cases = [
            {"op": "chunk", "seq": 1, "data": "YQ=="},
            {"op": "chunk", "seq": 0, "data": "YWI="},
            {"op": "chunk", "seq": 0, "data": "!!!!"},
            {"op": "end", "sha256": "bad"},
        ]
        for request in cases:
            with self.subTest(request=request):
                session = host.Session()
                session.handle({"op": "begin", "size": 1})
                with self.assertRaises(host.ProtocolError):
                    session.handle(request)
        session = host.Session()
        session.handle({"op": "begin", "size": 1})
        session.handle({"op": "chunk", "seq": 0, "data": "YQ=="})
        with patch.object(host, "scan") as scan, self.assertRaises(host.ProtocolError):
            session.handle({"op": "end", "sha256": "bad"})
        scan.assert_not_called()

    def test_session_resets_after_protocol_error_without_arbitrary_operations(self):
        requests = [
            {"id": "1", "op": "begin", "size": 1},
            {"id": "2", "op": "chunk", "seq": 0, "data": "YWI="},
            {"id": "3", "op": "begin", "size": 1},
            {"id": "4", "op": "exec", "command": "never run"},
        ]
        output = io.BytesIO()
        self.assertEqual(host.main(io.BytesIO(b"".join(map(frame, requests))), output), 0)
        output.seek(0)
        values = [host.read_frame(output) for _ in requests]
        self.assertEqual([v["status"] for v in values], ["accepted", "error", "accepted", "error"])


class ScannerTests(unittest.TestCase):
    def test_classifies_threats_limits_and_failures(self):
        cases = [
            (0, "stdin: OK\n", "clean"),
            (0, "", "error"),
            (0, "stdin: ERROR\n", "error"),
            (1, "stdin: Win.Test.EICAR_HDB-1 FOUND\n", "detected"),
            (1, "stdin: Heuristics.Limits.Exceeded.MaxScanSize FOUND\n", "incomplete"),
            (1, "stdin: Heuristics.Encrypted.Zip FOUND\n", "incomplete"),
            (1, "stdin: Heuristics.Encrypted.Zip FOUND\nstdin: Malware.Example FOUND\n", "detected"),
            (2, "stdin: Malware.Example FOUND\n", "error"),
            (1, "unknown output", "error"),
        ]
        for code, output, expected in cases:
            with self.subTest(output=output):
                self.assertEqual(host.classify(code, output)["status"], expected)

    @unittest.skipIf(sys.platform == "win32", "Checks POSIX file modes; Windows uses a private DACL")
    def test_private_temporary_directory_fixed_flags_and_no_shell(self):
        def fake_run(args, **kwargs):
            self.assertEqual(args[0], host.CLAMSCAN)
            self.assertNotIn("shell", kwargs)
            self.assertIn("--alert-exceeds-max=yes", args)
            self.assertIn("--alert-encrypted=yes", args)
            self.assertIn("--fail-if-cvd-older-than=3", args)
            self.assertFalse(any(arg.startswith(("--move", "--remove", "--log")) for arg in args))
            self.temp = Path(next(arg.split("=", 1)[1] for arg in args if arg.startswith("--tempdir=")))
            self.assertEqual(self.temp.stat().st_mode & 0o777, 0o700)
            self.assertEqual(kwargs["input"], b"Subject: test\r\n\r\nhello")
            return subprocess.CompletedProcess(args, 0, b"stdin: OK\n", b"")
        with patch.object(host.subprocess, "run", side_effect=fake_run), patch.object(host, "mime_inspection", return_value="clear"):
            result = host.scan(b"Subject: test\r\n\r\nhello")
        self.assertEqual(result["status"], "clean")
        self.assertFalse(self.temp.exists())

    @patch.object(host, "CLAMSCAN", "synthetic-scanner")
    @patch.object(host, "TEMP_ROOT", None)
    @patch.object(host, "windows_definitions_present", lambda database=None: True)
    def test_encrypted_mail_warnings_and_timeout_never_clean(self):
        encrypted = b'Content-Type: multipart/encrypted; boundary="x"\r\n\r\n--x--\r\n'
        with patch.object(host.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"stdin: OK\n", b"")):
            self.assertEqual(host.scan(encrypted)["status"], "incomplete")
        with patch.object(host.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"stdin: OK\n", b"warning")):
            self.assertEqual(host.scan(b"hello")["status"], "incomplete")
        with patch.object(host.subprocess, "run", side_effect=subprocess.TimeoutExpired([], 120)):
            self.assertEqual(host.scan(b"hello")["status"], "error")
        with patch.object(host.subprocess, "run", side_effect=FileNotFoundError):
            self.assertEqual(host.scan(b"hello")["status"], "error")

    def test_inline_pgp_and_smime_are_incomplete_but_signed_mail_is_not(self):
        self.assertTrue(host.encrypted_mail(b"Content-Type: text/plain\r\n\r\n-----BEGIN PGP MESSAGE-----\r\nexample"))
        self.assertTrue(host.encrypted_mail(b"Content-Type: application/pkcs7-mime; smime-type=enveloped-data\r\n\r\nexample"))
        self.assertFalse(host.encrypted_mail(b"Content-Type: application/pkcs7-mime; smime-type=signed-data\r\n\r\nexample"))


@unittest.skipIf(sys.platform == "win32", "POSIX private clamd")
class DaemonTests(unittest.TestCase):
    def version(self):
        from datetime import datetime
        return "ClamAV 1.5.4/1/" + datetime.now().strftime("%a %b %d %H:%M:%S %Y")

    def test_stream_results_fail_closed_and_preserve_digest(self):
        cases = [("stream: OK", "clean"), ("stream: Eicar-Test FOUND", "detected"),
                 ("stream: Heuristics.Encrypted.Zip FOUND", "incomplete"),
                 ("stream: Heuristics.Limits.Exceeded.MaxScanSize FOUND", "incomplete"),
                 ("stream: failure ERROR", "error"), ("stream: Test FOUND\0stream: failure ERROR", "error"),
                 ("OK", "error"), ("", "error")]
        for reply, expected in cases:
            with self.subTest(reply=reply):
                daemon = host.MailDaemon()
                with patch.object(daemon, "start"), patch.object(daemon, "exchange", side_effect=[self.version(), reply]):
                    result = host.scan(b"hello", daemon)
                self.assertEqual(result["status"], expected)
                self.assertEqual(result["sha256"], hashlib.sha256(b"hello").hexdigest())
                self.assertIn("clamd", result["engine"])

    def test_loaded_stale_or_unparseable_database_never_clean(self):
        for version in ["ClamAV 1/1/Sat Jan 01 00:00:00 2000", "invalid"]:
            daemon = host.MailDaemon()
            with patch.object(daemon, "start"), patch.object(daemon, "exchange", return_value=version) as exchange:
                self.assertEqual(host.scan(b"hello", daemon)["status"], "error")
                exchange.assert_called_once_with(b"VERSION", timeout=2)

    def test_startup_failure_falls_back_but_scan_failure_does_not(self):
        daemon = host.MailDaemon()
        with patch.object(daemon, "start", side_effect=host.DaemonUnavailable), patch.object(host, "scan_clamscan", return_value={"status": "clean", "detail": "normal"}) as fallback:
            result = host.scan(b"hello", daemon)
            self.assertEqual(result["status"], "clean")
            self.assertIn("clamscan", result["detail"])
            fallback.assert_called_once()
        with patch.object(daemon, "start"), patch.object(daemon, "exchange", side_effect=TimeoutError), patch.object(host, "scan_clamscan") as fallback:
            self.assertEqual(host.scan(b"hello", daemon)["status"], "error")
            fallback.assert_not_called()

    def test_binary_absence_is_cached_and_existing_daemon_is_not_used(self):
        daemon = host.MailDaemon()
        with patch.object(host.os, "access", return_value=False) as access:
            for _ in range(2):
                with self.assertRaises(host.DaemonUnavailable):
                    daemon.start()
            access.assert_called_once_with(host.CLAMD, host.os.X_OK)

    def test_private_config_single_process_reuse_and_cleanup(self):
        from unittest.mock import Mock
        daemon = host.MailDaemon()
        process = Mock()
        process.poll.return_value = None
        with patch.object(host.os, "access", return_value=True), patch.object(host.subprocess, "Popen", return_value=process) as popen, patch.object(daemon, "exchange", side_effect=["PONG", self.version()]):
            daemon.start()
            directory = Path(daemon.temp.name)
            config = (directory / "clamd.conf").read_text()
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            self.assertEqual((directory / "clamd.conf").stat().st_mode & 0o777, 0o600)
            for flag in ["LocalSocketMode 600", "FailIfCvdOlderThan 3", "AlertEncrypted yes", "AlertExceedsMax yes", "PhishingSignatures no", "PhishingScanURLs no", "MaxFileSize 25M", "MaxScanSize 100M", "MaxRecursion 16", "MaxScanTime 60000"]:
                self.assertIn(flag, config)
            self.assertNotIn("TCPSocket", config)
            self.assertNotIn("/etc/clamav", config)
            daemon.start()
            popen.assert_called_once()
            self.assertTrue(callable(popen.call_args.kwargs["preexec_fn"]))
            daemon.close()
            process.terminate.assert_called_once()
            self.assertFalse(directory.exists())
            daemon.close()

    def test_stream_wire_format_and_bounded_truncated_replies(self):
        from unittest.mock import MagicMock
        for reply, expected in [(b"stream: OK\0", "stream: OK"), (b"stream: OK", None),
                                (b"x" * (host.MAX_FRAME + 1), None)]:
            connection = MagicMock()
            connection.__enter__.return_value = connection
            connection.recv.side_effect = [reply, b""]
            daemon = host.MailDaemon()
            daemon.address = "/tmp/synthetic-only.sock"
            with patch.object(host.socket, "socket", return_value=connection) as factory:
                if expected is None:
                    with self.assertRaises(host.ProtocolError):
                        daemon.exchange(b"INSTREAM", b"abc")
                else:
                    self.assertEqual(daemon.exchange(b"INSTREAM", b"abc"), expected)
                factory.assert_called_once_with(host.socket.AF_UNIX, host.socket.SOCK_STREAM)
                self.assertEqual([call.args[0] for call in connection.sendall.call_args_list],
                                 [b"zINSTREAM\0", b"\0\0\0\3abc", b"\0\0\0\0"])

    def test_daemon_warning_and_encrypted_mime_never_clean(self):
        daemon = host.MailDaemon()
        with tempfile.TemporaryFile() as diagnostic:
            diagnostic.write(b"WARNING: synthetic warning\n")
            diagnostic.flush()
            daemon.diagnostics = diagnostic
            with patch.object(daemon, "start"), patch.object(daemon, "exchange", side_effect=[self.version(), "stream: OK"]):
                self.assertEqual(host.scan(b"hello", daemon)["status"], "incomplete")
        daemon.diagnostics = None
        with patch.object(daemon, "start"), patch.object(daemon, "exchange", side_effect=[self.version(), "stream: OK"]):
            self.assertEqual(host.scan(b"Content-Type: application/pgp-encrypted\r\n\r\nx", daemon)["status"], "incomplete")

    def test_daemon_warnings_apply_only_to_new_diagnostic_bytes(self):
        daemon = host.MailDaemon()
        with tempfile.TemporaryFile() as diagnostic:
            daemon.diagnostics = diagnostic
            with patch.object(daemon, "start"), patch.object(daemon, "exchange", side_effect=lambda command, *args, **kwargs: self.version() if command == b"VERSION" else "stream: OK"):
                diagnostic.write(b"WARNING: first scan\n"); diagnostic.flush()
                self.assertEqual(daemon.scan(b"first")["status"], "incomplete")
                self.assertEqual(daemon.scan(b"second")["status"], "clean")
                diagnostic.write(b"ERROR: next scan\n"); diagnostic.flush()
                self.assertEqual(daemon.scan(b"third")["status"], "incomplete")
                self.assertEqual(daemon.scan(b"fourth")["status"], "clean")
                diagnostic.write(b"x" * (host.MAX_FRAME + 1)); diagnostic.flush()
                self.assertEqual(daemon.scan(b"large log")["status"], "incomplete")
                self.assertEqual(daemon.scan(b"after large log")["status"], "clean")
            daemon.close()
            self.assertEqual(daemon.diagnostic_offset, 0)

    def test_session_owns_daemon_until_final_close(self):
        session = host.Session()
        with patch.object(session.scanner, "close") as close:
            session.reset()
            close.assert_not_called()
            session.close()
            close.assert_called_once()


class PrerequisiteTests(unittest.TestCase):
    def test_missing_clamav_has_specific_code_without_starting_any_process(self):
        with patch.object(host, "CLAMSCAN", "/synthetic/not-installed/clamscan"), patch.object(host.subprocess, "run") as run:
            result = host.health()
        self.assertEqual(result["code"], "clamav_missing")
        self.assertEqual(result["status"], "error")
        run.assert_not_called()
        self.assertEqual(host.describe_result(result)["detailMessages"][0]["key"], "clamavMissing")

    def test_broken_or_inaccessible_clamav_is_not_claimed_to_be_uninstalled(self):
        with patch.object(Path, "is_file", return_value=True):
            for error in [PermissionError("denied"), subprocess.TimeoutExpired("clamscan", 10)]:
                with patch.object(host.subprocess, "run", side_effect=error):
                    self.assertEqual(host.health()["code"], "clamav_unusable")
            with patch.object(host.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"not ClamAV", b"")):
                self.assertEqual(host.health()["code"], "clamav_unusable")


@unittest.skipIf(sys.platform == "win32", "Legacy POSIX installer")
class PackagingTests(unittest.TestCase):
    def test_build_and_registration_are_local_and_never_overwrite(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as temp:
            stage = Path(temp) / "project"
            import shutil
            shutil.copytree(root / "thunderbird", stage / "thunderbird")
            shutil.copytree(root / "native", stage / "native", ignore=shutil.ignore_patterns("__pycache__"))
            shutil.copytree(root / "setup", stage / "setup", ignore=shutil.ignore_patterns("__pycache__"))
            xpi, manifest = build(stage)
            with zipfile.ZipFile(xpi) as archive:
                self.assertIn("manifest.json", archive.namelist())
                extension = json.loads(archive.read("manifest.json"))
                self.assertNotIn("messagesDelete", extension["permissions"])
                self.assertIn("messagesDelete", extension["optional_permissions"])
                self.assertNotIn("downloads", extension["permissions"])
                self.assertIn("downloads", extension["optional_permissions"])
                self.assertNotIn("messagesMove", extension["permissions"])
            self.assertTrue(Path(json.loads(manifest.read_text())["path"]).is_file())
            home = Path(temp) / "home"
            install(stage, home)
            self.assertFalse(home.exists())
            install(stage, home, apply=True)
            registration = home / ".mozilla/native-messaging-hosts/local.clam_mail_check.json"
            before = registration.read_bytes()
            with self.assertRaises(FileExistsError):
                install(stage, home, apply=True)
            self.assertEqual(registration.read_bytes(), before)



class MimeIsolationTests(unittest.TestCase):
    def setUp(self):
        if sys.platform == "win32":
            import shutil
            temp = tempfile.TemporaryDirectory()
            self.addCleanup(temp.cleanup)
            target = Path(temp.name, "host.py")
            shutil.copyfile(host.__file__, target)
            guardian = Path(__file__).resolve().parents[1] / "experiments/direct-runtime/windows.py"
            shutil.copyfile(guardian, target.with_name("windows.py"))
            self.enterContext(patch.object(host, "__file__", str(target)))

    def test_worker_handles_clear_and_encrypted_mail(self):
        self.assertEqual(host.mime_inspection(b"Subject: sample\r\n\r\nhello"), "clear")
        self.assertEqual(host.mime_inspection(b"Content-Type: text/plain\r\n\r\n-----BEGIN PGP MESSAGE-----"), "encrypted")

    def test_large_part_count_is_bounded_in_worker(self):
        data = b'Content-Type: multipart/mixed; boundary="x"\r\n\r\n' + b'--x\r\nContent-Type: text/plain\r\n\r\nx\r\n' * 50000 + b'--x--\r\n'
        self.assertEqual(host.mime_inspection(data), "limited")

    def test_depth_and_header_limits(self):
        data = b"Content-Type: text/plain\r\n\r\nhello"
        for i in range(35):
            boundary = f"level-{i}".encode()
            data = b'Content-Type: multipart/mixed; boundary="' + boundary + b'"\r\n\r\n--' + boundary + b'\r\n' + data + b'\r\n--' + boundary + b'--\r\n'
        self.assertEqual(host.mime_inspection(data), "limited")
        self.assertEqual(host.mime_inspection(b"X-Large: " + b"x" * (257 * 1024) + b"\r\n\r\nhello"), "limited")

    def test_timeout_and_crashed_worker_fail_closed(self):
        for result in [subprocess.CompletedProcess([], 1, b"", b""), subprocess.CompletedProcess([], 0, b"unexpected", b"")]:
            with patch.object(host.sys, "platform", "linux"), patch.object(host.subprocess, "run", return_value=result):
                self.assertEqual(host.mime_inspection(b"hello"), "limited")
        with patch.object(host.sys, "platform", "linux"), patch.object(host.subprocess, "run", side_effect=subprocess.TimeoutExpired([], 5)):
            self.assertEqual(host.mime_inspection(b"hello"), "limited")

    def test_failed_auxiliary_parser_preserves_malware_verdict(self):
        for status, expected in [("clean", "incomplete"), ("advisory", "incomplete"), ("detected", "detected")]:
            with patch.object(host, "scan_clamscan", return_value={"status": status, "detail": "synthetic", "signatures": ["Synthetic"]}), patch.object(host, "mime_inspection", return_value="limited"):
                result = host.scan(b"hello")
            self.assertEqual(result["status"], expected)
            self.assertEqual(result["signatures"], ["Synthetic"])


if __name__ == "__main__":
    unittest.main()
