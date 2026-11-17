"""Platform selection and fail-closed behavior without system modifications."""
import errno
import io
import resource
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from native import host


class MacRuntimeTests(unittest.TestCase):
    def test_homebrew_cpu_preference_keeps_daemon_and_database_in_same_prefix(self):
        for machine, prefix in [("arm64", "/opt/homebrew"), ("x86_64", "/usr/local")]:
            with self.subTest(machine=machine), patch.object(host.os, "uname", return_value=SimpleNamespace(machine=machine)), \
                 patch.object(Path, "exists", return_value=True), \
                 patch.object(host, "trusted_macos_path", side_effect=lambda path, _prefix: str(path)):
                scan, daemon, database, rejected = host.macos_clamav()
            self.assertEqual(scan, prefix + "/bin/clamscan")
            self.assertEqual(daemon, prefix + "/sbin/clamd")
            self.assertEqual(database, prefix + "/var/lib/clamav")
            self.assertFalse(rejected)

    def test_untrusted_clamav_never_starts_from_health_or_scan(self):
        with patch.object(host, "CLAMAV_TRUST_ERROR", True), patch.object(host.subprocess, "run") as run, \
             patch.object(host.subprocess, "Popen") as spawn:
            self.assertEqual(host.health()["code"], "clamav_unusable")
            self.assertEqual(host.scan_clamscan(b"synthetic")["status"], "error")
            daemon = host.MailDaemon()
            with self.assertRaises(host.ProtocolError):
                daemon.start()
            run.assert_not_called(); spawn.assert_not_called()

    def test_symlink_target_outside_clamav_cellar_is_rejected(self):
        with patch.object(Path, "resolve", return_value=Path("/tmp/other/clamscan")):
            with self.assertRaisesRegex(OSError, "outside the trusted installation"):
                host.trusted_macos_path("/opt/homebrew/bin/clamscan", "/opt/homebrew")

    def test_missing_or_rejected_candidate_cannot_be_executed_later(self):
        with patch.object(Path, "exists", return_value=False), patch.object(Path, "is_symlink", return_value=False):
            scan, daemon, _, rejected = host.macos_clamav()
        self.assertIsNone(scan)
        self.assertIsNone(daemon)
        self.assertFalse(rejected)

    def test_mime_memory_limit_or_unobservable_worker_is_incomplete_and_killed(self):
        for value in [513 * 1024 ** 2, OSError(errno.EPERM, "unobservable")]:
            child = MagicMock()
            child.communicate.side_effect = subprocess.TimeoutExpired([], .05)
            child.poll.return_value = None
            child.pid = 1234
            child.__enter__.return_value = child
            with self.subTest(value=value), patch.object(host.sys, "platform", "darwin"), \
                 patch.object(host.subprocess, "Popen", return_value=child), \
                 patch.object(host, "macos_rss", side_effect=value if isinstance(value, Exception) else None,
                              return_value=value):
                self.assertEqual(host.mime_inspection(b"synthetic"), "limited")
            child.kill.assert_called_once(); child.wait.assert_called_once()

    def test_linux_mime_keeps_hard_memory_cpu_and_core_limits(self):
        output = io.BytesIO()
        with patch.object(host.sys, "platform", "linux"), \
             patch.object(host.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(b"Subject: test\r\n\r\nhello"))), \
             patch.object(host.sys, "stdout", SimpleNamespace(buffer=output)), \
             patch.object(resource, "setrlimit") as limit, patch.object(host, "child_lifetime"):
            self.assertEqual(host.mime_worker(), 0)
        self.assertEqual(output.getvalue(), b"clear")
        self.assertIn(((resource.RLIMIT_AS, (512 * 1024 ** 2, 512 * 1024 ** 2)),), [(call.args,) for call in limit.call_args_list])
        limit.assert_any_call(resource.RLIMIT_CPU, (3, 3))
        limit.assert_any_call(resource.RLIMIT_CORE, (0, 0))


class MacMissingExecutableTests(unittest.TestCase):
    def test_missing_candidates_cannot_execute_an_unverified_fallback_file(self):
        with patch.object(Path, "exists", return_value=False), patch.object(Path, "is_symlink", return_value=False):
            scan, daemon, _, rejected = host.macos_clamav()
        # Even if an arbitrary fallback file exists, only discovery may authorize
        # execution; the health check must not turn absence into an executable.
        with patch.object(host, "CLAMSCAN", scan), patch.object(host, "CLAMD", daemon), \
             patch.object(host, "CLAMAV_TRUST_ERROR", rejected), patch.object(Path, "is_file", return_value=True), \
             patch.object(host.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=b"ClamAV 1.5.4")) as run:
            self.assertEqual(host.health()["code"], "clamav_missing")
            self.assertEqual(host.scan_clamscan(b"synthetic")["status"], "error")
            run.assert_not_called()

    def test_absent_daemon_cannot_start_an_unverified_fallback_file(self):
        with patch.object(host.os, "uname", return_value=SimpleNamespace(machine="arm64")), \
             patch.object(Path, "exists", return_value=True), \
             patch.object(host, "trusted_macos_path", side_effect=["/opt/homebrew/Cellar/clamav/1/bin/clamscan", OSError("missing")]):
            _, daemon, _, _ = host.macos_clamav()
        with patch.object(host, "CLAMD", daemon), patch.object(host, "CLAMAV_TRUST_ERROR", False), \
             patch.object(host.os, "access", return_value=True), patch.object(host.subprocess, "Popen") as spawn:
            with self.assertRaises(host.DaemonUnavailable):
                host.MailDaemon().start()
            spawn.assert_not_called()
