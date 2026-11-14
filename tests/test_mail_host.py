import base64
import hashlib
import io
import json
from pathlib import Path
import struct
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
        with patch.object(host, "scan", return_value={"status": "clean"}) as scan:
            self.assertEqual(session.handle({"op": "end", "sha256": hashlib.sha256(data).hexdigest()})["status"], "clean")
            scan.assert_called_once_with(data)
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

    def test_private_temporary_directory_fixed_flags_and_no_shell(self):
        def fake_run(args, **kwargs):
            self.assertEqual(args[0], "/usr/bin/clamscan")
            self.assertNotIn("shell", kwargs)
            self.assertIn("--alert-exceeds-max=yes", args)
            self.assertIn("--alert-encrypted=yes", args)
            self.assertIn("--fail-if-cvd-older-than=3", args)
            self.assertFalse(any(arg.startswith(("--move", "--remove", "--log")) for arg in args))
            self.temp = Path(next(arg.split("=", 1)[1] for arg in args if arg.startswith("--tempdir=")))
            self.assertEqual(self.temp.stat().st_mode & 0o777, 0o700)
            self.assertEqual(kwargs["input"], b"Subject: test\r\n\r\nhello")
            return subprocess.CompletedProcess(args, 0, b"stdin: OK\n", b"")
        with patch.object(host.subprocess, "run", side_effect=fake_run):
            result = host.scan(b"Subject: test\r\n\r\nhello")
        self.assertEqual(result["status"], "clean")
        self.assertFalse(self.temp.exists())

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


class PackagingTests(unittest.TestCase):
    def test_build_and_registration_are_local_and_never_overwrite(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as temp:
            stage = Path(temp) / "project"
            import shutil
            shutil.copytree(root / "thunderbird", stage / "thunderbird")
            shutil.copytree(root / "native", stage / "native", ignore=shutil.ignore_patterns("__pycache__"))
            xpi, manifest = build(stage)
            with zipfile.ZipFile(xpi) as archive:
                self.assertIn("manifest.json", archive.namelist())
                extension = json.loads(archive.read("manifest.json"))
                self.assertNotIn("messagesDelete", extension["permissions"])
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


if __name__ == "__main__":
    unittest.main()
