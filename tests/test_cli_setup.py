import base64
import contextlib
import io
import json
from pathlib import Path
import tempfile
import subprocess
import struct
import select
import unittest
import sys
import warnings
from unittest.mock import patch
import zipfile

from native import host
from setup.cli import Administration, unpack, run
from setup.manager import Manager, SetupError, CLI_PAYLOAD, PAYLOAD
from scripts.build_mail_check import installer_bytes

ROOT = Path(__file__).resolve().parents[1]


class CliSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="clam-cli-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "package"
        self.home = Path(self.temp.name).resolve() / "home"
        self.root.mkdir(); self.home.mkdir()
        self.package = installer_bytes(ROOT)
        unpack(self.package, self.root)
        self.probe = patch("setup.manager.probe_host", return_value={"status": "ready", "protocol": 1})
        self.probe.start(); self.addCleanup(self.probe.stop)
        self.manager = Manager(self.root, self.home, headless=True)

    def install(self):
        return self.manager.apply("install", self.manager.plan("install")["token"])

    def administration(self):
        release = self.manager.layout.base / self.manager.receipt()["release"]
        admin = Administration(release, self.home)
        self.addCleanup(admin.close)
        return admin

    def test_cli_can_repeat_install_repair_uninstall_without_gui_or_desktop(self):
        with contextlib.redirect_stdout(io.StringIO()):
            for _ in range(3):
                self.assertEqual(run(self.root, self.home, ["install", "--yes"]), 0)
                self.assertEqual(self.manager.receipt()["format"], 2)
                self.assertEqual(set(self.manager.receipt()["files"]), set(CLI_PAYLOAD))
                self.assertFalse(self.manager.layout.desktop.exists())
                self.assertEqual(run(self.root, self.home, ["install", "--yes"]), 0)
                self.assertEqual(run(self.root, self.home, ["uninstall", "--yes"]), 0)
                self.assertFalse(self.manager.layout.registration.exists())
                self.assertFalse(self.manager.layout.receipt.exists())
                self.assertEqual(run(self.root, self.home, ["uninstall", "--yes"]), 0)
        self.assertFalse((self.home / ".thunderbird").exists())

    def test_cli_cancellation_does_not_install(self):
        with patch("builtins.input", return_value="n"), contextlib.redirect_stdout(io.StringIO()):
            run(self.root, self.home, ["install"])
        self.assertFalse(self.manager.layout.receipt.exists())

    def test_legacy_install_can_be_removed_or_migrated_without_touching_mail(self):
        import shutil
        for name in PAYLOAD:
            p = self.root / name; p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b"synthetic XPI" if name == "extension.xpi" else (ROOT / name).read_bytes())
        legacy = Manager(self.root, self.home)
        legacy.apply("install", legacy.plan("install")["token"])
        receipt = legacy.receipt()
        (legacy.layout.base / receipt["release"] / "setup/cli.py").unlink()
        del receipt["files"]["setup/cli.py"] # Existing 0.6 installations used the original seven files.
        legacy.layout.receipt.write_text(json.dumps(receipt))
        profile = self.home / ".thunderbird"; profile.mkdir()
        mail = profile / "keep.txt"; mail.write_text("keep mail and settings")
        with contextlib.redirect_stdout(io.StringIO()):
            run(self.root, self.home, ["install", "--yes"])
        self.assertEqual(self.manager.receipt()["format"], 2)
        self.assertFalse(self.manager.layout.desktop.exists())
        self.assertEqual(mail.read_text(), "keep mail and settings")
        admin = self.administration()
        plan = admin.prepare("uninstall")
        result = admin.apply(plan["token"])
        self.assertEqual(result["status"], "removed")
        self.assertEqual(mail.read_text(), "keep mail and settings")

    def test_original_gui_installation_can_be_uninstalled_directly_by_cli(self):
        for name in PAYLOAD:
            path = self.root / name; path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"synthetic XPI" if name == "extension.xpi" else (ROOT / name).read_bytes())
        old = Manager(self.root, self.home)
        old.apply("install", old.plan("install")["token"])
        receipt = old.receipt()
        (old.layout.base / receipt["release"] / "setup/cli.py").unlink()
        del receipt["files"]["setup/cli.py"]
        old.layout.receipt.write_text(json.dumps(receipt))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(run(self.root, self.home, ["uninstall", "--yes"]), 0)
        self.assertFalse(old.layout.registration.exists())
        self.assertFalse(old.layout.desktop.exists())
        self.assertFalse(old.layout.receipt.exists())
        self.assertFalse(self.manager.state()["installed"])

    def test_managed_update_is_confirmed_bounded_and_single_use(self):
        self.install(); admin = self.administration()
        plan = admin.prepare("repair", base64.b64encode(self.package).decode())
        self.assertEqual(plan["status"], "prepared")
        self.assertEqual(admin.apply(plan["token"])["status"], "updated")
        with self.assertRaises(SetupError): admin.apply(plan["token"])
        self.assertTrue(self.manager.state()["healthy"])
        self.assertFalse(self.manager.layout.desktop.exists())

    def test_uninstall_cancel_expiry_and_snapshot_changes_are_safe(self):
        self.install(); admin = self.administration()
        plan = admin.prepare("uninstall"); admin.close()
        self.assertTrue(self.manager.layout.registration.exists())
        with self.assertRaises(SetupError): admin.apply(plan["token"])
        plan = admin.prepare("uninstall")
        with patch("setup.cli.time.monotonic", return_value=10**20), self.assertRaises(SetupError): admin.apply(plan["token"])
        plan = admin.prepare("uninstall")
        self.manager.layout.desktop.write_text("foreign menu")
        with self.assertRaises(SetupError): admin.apply(plan["token"])
        self.assertTrue(self.manager.layout.registration.exists())

    def test_archive_rejects_traversal_duplicates_and_bombs(self):
        for names in [["../outside.py"], list(CLI_PAYLOAD) + ["__main__.py", "__main__.py"]]:
            stream = io.BytesIO()
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with zipfile.ZipFile(stream, "w") as archive:
                    for name in names: archive.writestr(name, b"x")
            with self.assertRaises(SetupError): unpack(stream.getvalue(), self.root)
        with self.assertRaises(SetupError): unpack(b"x" * (80 * 1024 + 1), self.root)
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name in [*CLI_PAYLOAD, "__main__.py"]:
                archive.writestr(name, b"x" * (2 * 1024 * 1024) if name == "native/host.py" else b"")
        with self.assertRaises(SetupError): unpack(stream.getvalue(), self.root)

    def test_modified_and_foreign_files_are_not_deleted(self):
        self.install(); admin = self.administration()
        release = self.manager.layout.base / self.manager.receipt()["release"]
        changed = release / "native/host.py"; changed.write_text("user modified")
        unknown = release / "notes.txt"; unknown.write_text("keep")
        plan = admin.prepare("uninstall"); result = admin.apply(plan["token"])
        self.assertIn(str(changed), result["retained"])
        self.assertEqual(changed.read_text(), "user modified")
        self.assertEqual(unknown.read_text(), "keep")
        self.assertFalse(self.manager.layout.registration.exists())

    def test_native_protocol_uses_only_its_own_administration_and_requires_a_plan(self):
        self.install()
        session = host.Session(); session.administration = self.administration()
        self.addCleanup(session.close)
        self.assertEqual(session.handle({"op": "manageInfo"})["status"], "managed")
        with self.assertRaises(host.ProtocolError): session.handle({"op": "manageApply", "token": "invented"})
        session.handle({"op": "begin", "size": 1})
        with self.assertRaises(host.ProtocolError): session.handle({"op": "managePlan", "operation": "uninstall"})
        session.reset()
        plan = session.handle({"op": "managePlan", "operation": "uninstall", "path": "/must-not-be-used"})
        self.assertEqual(session.handle({"op": "manageApply", "token": plan["token"]})["status"], "removed")

    def test_installed_native_host_real_framing_can_remove_only_the_fixture(self):
        self.probe.stop() # Use the real installed host's read-only ClamAV health check.
        self.install()
        release = self.manager.layout.base / self.manager.receipt()["release"]
        driver = "import pathlib,sys,runpy; home=pathlib.Path(sys.argv[2]); pathlib.Path.home=classmethod(lambda cls:home); runpy.run_path(sys.argv[1],run_name='__main__')"
        process = subprocess.Popen([sys.executable, "-I", "-c", driver,
                                    str(release / "native/host.py"), str(self.home)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def request(value):
            data = json.dumps({"id": "fixture", **value}).encode()
            process.stdin.write(struct.pack("=I", len(data)) + data); process.stdin.flush()
            self.assertTrue(select.select([process.stdout], [], [], 10)[0], "host response timed out")
            return host.read_frame(process.stdout)
        try:
            self.assertEqual(request({"op": "manageInfo"})["status"], "managed")
            plan = request({"op": "managePlan", "operation": "uninstall"})
            self.assertEqual(plan["status"], "prepared")
            result = request({"op": "manageApply", "token": plan["token"]})
            self.assertEqual(result["status"], "removed")
            self.assertEqual(result["retained"], [])
            self.assertFalse(self.manager.layout.registration.exists())
            self.assertFalse(self.manager.layout.receipt.exists())
        finally:
            process.stdin.close()
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=5)
            process.stdout.close(); process.stderr.close()
        self.assertEqual(process.returncode, 0)


if __name__ == "__main__": unittest.main()
