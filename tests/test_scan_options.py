import base64
import hashlib
from pathlib import Path
import os
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime
from native import host


class ScanOptionsTests(unittest.TestCase):
    def test_bounds_and_protocol_cannot_be_bypassed(self):
        for value in [[], True, {"mailMiB": True}, {"mailMiB": 101}, {"mailMiB": 4}, {"mailMiB": 5.5}, {"expandedMiB": 501}, {"seconds": 121}, {"seconds": 9}, {"mailMiB": 50, "expandedMiB": 25}, {"phishing": "yes; command"}, {"arbitrary": "yes"}]:
            with self.subTest(value=value), self.assertRaises(host.ProtocolError):
                host.scan_options(value)
        session = host.Session()
        try:
            with self.assertRaises(host.ProtocolError):
                session.handle({"op": "begin", "size": 26 * 1024 * 1024})
            self.assertEqual(session.handle({"op": "begin", "size": 26 * 1024 * 1024, "scanSettings": {"mailMiB": 50}})["status"], "accepted")
            session.handle({"op": "abort"})
            with self.assertRaises(host.ProtocolError):
                session.handle({"op": "begin", "size": 101 * 1024 * 1024, "scanSettings": {"mailMiB": 100}})
        finally:
            session.close()

    def test_policy_is_applied_only_after_complete_verified_transfer(self):
        options = host.scan_options({"phishing": "notify", "seconds": 120})
        session = host.Session()
        try:
            session.handle({"op": "begin", "size": 1, "scanSettings": options})
            session.handle({"op": "chunk", "seq": 0, "data": base64.b64encode(b"a").decode()})
            with tempfile.TemporaryDirectory() as tmp, \
                 patch.object(host, "DATABASE", str(Path(tmp).resolve() / "database")), \
                 patch.object(host, "health", return_value={"status": "ready", "engine": "test", "definitionTimestamp": 1000}), \
                 patch.object(host, "scan", return_value={"status": "clean"}) as scan:
                session.handle({"op": "end", "sha256": hashlib.sha256(b"a").hexdigest()})
                if sys.platform == "win32":
                    scan.assert_called_once_with(b"a", None, options, host.DATABASE)
                else:
                    scan.assert_called_once_with(b"a", session.scanner, options)
            self.assertIsNone(session.scan_settings)
        finally:
            session.close()

    def test_warning_signatures_do_not_mask_viruses_or_unscanned_parts(self):
        warnings = ["Heuristics.Phishing.Email.SpoofedDomain", "Heuristics.OLE2.ContainsMacros", "PUA.Example"]
        for name in warnings:
            result = host.classify(1, "stdin: " + name + " FOUND")
            self.assertEqual(result["status"], "advisory")
            self.assertEqual(len(result["advisories"]), 1)
        prefix = "\n".join("stdin: PUA.Example%d FOUND" % i for i in range(40))
        result = host.classify(1, prefix + "\nstdin: Eicar-Test-Signature FOUND")
        self.assertEqual(result["status"], "detected")
        self.assertEqual(result["signatures"][0], "Eicar-Test-Signature")
        self.assertEqual(host.classify(1, "stdin: PUA.Example FOUND\nstdin: Heuristics.Encrypted.Zip FOUND")["status"], "incomplete")
        self.assertEqual(host.classify(1, "stdin: Unknown.Phish.Name FOUND")["status"], "detected")

    @patch.object(host, "CLAMSCAN", "synthetic-scanner")
    @patch.object(host, "TEMP_ROOT", None)
    @patch.object(host, "windows_definitions_present", lambda database=None: True)
    def test_clamscan_flags_and_timeout_are_bounded_without_shell_interpretation(self):
        options = host.scan_options({"phishing": "notify", "macros": "display", "pua": "display", "mailMiB": 50, "expandedMiB": 200, "seconds": 120})
        with patch.object(host.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"stdin: OK\n", b"")) as run:
            self.assertEqual(host.scan_clamscan(b"a", options)["status"], "clean")
        args = run.call_args.args[0]
        for expected in ["--allmatch=yes", "--phishing-sigs=yes", "--phishing-scan-urls=yes", "--alert-macros=yes", "--detect-pua=yes", "--max-filesize=50M", "--max-scansize=200M", "--max-scantime=120000", "--heuristic-scan-precedence=no"]:
            self.assertIn(expected, args)
        self.assertEqual(run.call_args.kwargs["timeout"], 150)
        self.assertNotIn("shell", run.call_args.kwargs)

    def test_engine_reloads_for_engine_changes_but_not_notification_only_changes(self):
        daemon = host.MailDaemon()
        with patch.object(daemon, "close") as close:
            daemon.configure({"phishing": "display"})
            self.assertEqual(close.call_count, 1)
            daemon.configure({"phishing": "notify"})
            self.assertEqual(close.call_count, 1)
            daemon.configure({"phishing": "notify", "mailMiB": 50})
            self.assertEqual(close.call_count, 2)

    @unittest.skipIf(sys.platform == "win32", "POSIX clamd ALLMATCHSCAN")
    def test_allmatch_uses_private_temporary_input_and_removes_it(self):
        daemon = host.MailDaemon()
        daemon.configure({"macros": "display"})
        daemon.temp = tempfile.TemporaryDirectory()
        paths = []
        version = "ClamAV 1.5.4/1/" + datetime.now().strftime("%a %b %d %H:%M:%S %Y")

        def exchange(command, data=None, timeout=120):
            if command == b"VERSION":
                return version
            self.assertTrue(command.startswith(b"ALLMATCHSCAN "))
            path = Path(os.fsdecode(command.split(b" ", 1)[1]))
            paths.append(path)
            self.assertEqual(path.read_bytes(), b"Subject: test\r\n\r\nhello")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            return str(path) + ": Heuristics.OLE2.ContainsMacros FOUND\0" + str(path) + ": Eicar-Test-Signature FOUND"

        try:
            with patch.object(daemon, "start"), patch.object(daemon, "exchange", side_effect=exchange):
                result = host.scan(b"Subject: test\r\n\r\nhello", daemon, {"macros": "display"})
            self.assertEqual(result["status"], "detected")
            self.assertTrue(paths)
            self.assertFalse(paths[0].exists())
            self.assertEqual(result["scanSettings"]["macros"], "display")
            def broken(command, data=None, timeout=120):
                if command == b"VERSION": return version
                path = Path(os.fsdecode(command.split(b" ", 1)[1])); paths.append(path)
                self.assertTrue(path.exists())
                raise host.ProtocolError("synthetic failure")
            with patch.object(daemon, "start"), patch.object(daemon, "exchange", side_effect=broken):
                failed = host.scan(b"Subject: test\r\n\r\nhello", daemon, {"macros": "display"})
            self.assertEqual(failed["status"], "error")
            self.assertFalse(paths[-1].exists())
        finally:
            daemon.close()
