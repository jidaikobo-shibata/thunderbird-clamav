import json
from pathlib import Path
import shutil
import tempfile
import subprocess
import tarfile
import unittest
from unittest.mock import patch

from setup.manager import Manager, SetupError, PAYLOAD, PRODUCT
from scripts.build_mail_check import build, build_setup

ROOT = Path(__file__).resolve().parents[1]


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="clam-setup-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "package"
        self.home = Path(self.temp.name) / "home with spaces"
        self.home.mkdir()
        for name in PAYLOAD:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if name == "extension.xpi":
                target.write_bytes(b"synthetic xpi")
            else:
                shutil.copyfile(ROOT / name, target)
        self.manager = Manager(self.root, self.home)
        self.probe = patch("setup.manager.probe_host", return_value={"status": "ready", "protocol": 1})
        self.probe.start()
        self.addCleanup(self.probe.stop)

    def apply(self, operation):
        plan = self.manager.plan(operation)
        return self.manager.apply(operation, plan["token"])

    def test_plan_and_cancel_do_not_create_files(self):
        before = list(self.home.rglob("*"))
        self.manager.plan("install")
        self.assertEqual(list(self.home.rglob("*")), before)

    def test_full_lifecycle_and_user_permissions(self):
        self.apply("install")
        state = self.manager.state()
        self.assertTrue(state["installed"] and state["healthy"])
        receipt = self.manager.receipt()
        release = self.manager.layout.base / receipt["release"]
        self.assertEqual((release / "native/host.py").stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.manager.layout.receipt.stat().st_mode & 0o777, 0o600)
        registration = json.loads(self.manager.layout.registration.read_text())
        self.assertEqual(registration["name"], PRODUCT)
        self.assertEqual(registration["allowed_extensions"], ["clam-mail-check@local.invalid"])
        self.apply("repair")
        self.assertFalse(release.exists())
        self.assertTrue(self.manager.state()["healthy"])
        self.apply("uninstall")
        self.assertFalse(self.manager.layout.registration.exists())
        self.assertFalse(self.manager.layout.desktop.exists())
        self.assertFalse(self.manager.state()["installed"])

    def test_update_switches_version_and_refuses_downgrade(self):
        self.apply("install")
        manifest = self.root / "thunderbird/manifest.json"
        value = json.loads(manifest.read_text())
        value["version"] = "0.5.0"
        manifest.write_text(json.dumps(value))
        newer = Manager(self.root, self.home)
        newer.apply("repair", newer.plan("repair")["token"])
        self.assertEqual(newer.state()["version"], "0.5.0")
        with self.assertRaises(SetupError):
            self.manager.plan("repair")

    def test_foreign_registration_and_user_edits_are_not_overwritten(self):
        registration = self.manager.layout.registration
        registration.parent.mkdir(parents=True)
        registration.write_text("foreign registration")
        with self.assertRaises(SetupError):
            self.manager.plan("install")
        self.assertEqual(registration.read_text(), "foreign registration")
        registration.unlink()
        self.apply("install")
        registration.write_text("user changed registration")
        with self.assertRaises(SetupError):
            self.manager.plan("uninstall")
        self.assertEqual(registration.read_text(), "user changed registration")

    def test_repair_replaces_missing_files_and_preserves_modified_old_file(self):
        self.apply("install")
        old = self.manager.layout.base / self.manager.receipt()["release"]
        (old / "native/host.py").write_text("user modified file")
        self.manager.layout.registration.unlink()
        self.assertFalse(self.manager.state()["healthy"])
        result = self.apply("repair")
        self.assertTrue(self.manager.state()["healthy"])
        self.assertEqual((old / "native/host.py").read_text(), "user modified file")
        self.assertIn(str(old / "native/host.py"), result["retained"])

    def test_installed_copy_cannot_repair_itself_from_modified_source(self):
        self.apply("install")
        release = self.manager.layout.base / self.manager.receipt()["release"]
        installed = Manager(release, self.home)
        (release / "native/host.py").write_text("modified source")
        with self.assertRaisesRegex(SetupError, "ダウンロード"):
            installed.apply("repair", installed.plan("repair")["token"])

    def test_running_installed_setup_switches_its_source_after_self_repair(self):
        self.apply("install")
        old = self.manager.layout.base / self.manager.receipt()["release"]
        installed = Manager(old, self.home)
        installed.apply("repair", installed.plan("repair")["token"])
        self.assertFalse(old.exists())
        self.assertNotEqual(installed.root, old)
        self.assertTrue((installed.root / "extension.xpi").exists())
        # A second repair must not refer back to the deleted old release.
        installed.apply("repair", installed.plan("repair")["token"])
        self.assertTrue(installed.state()["healthy"])

    def test_failed_probe_leaves_no_registration_or_release(self):
        with patch("setup.manager.probe_host", side_effect=SetupError("test failure")):
            with self.assertRaises(SetupError):
                self.apply("install")
        self.assertFalse(self.manager.layout.registration.exists())
        self.assertEqual(list((self.manager.layout.base / "releases").iterdir()), [])

    def test_partial_write_failure_rolls_back_previous_registration(self):
        self.apply("install")
        before = self.manager.layout.registration.read_bytes()
        receipt = self.manager.layout.receipt.read_bytes()
        replace = self.manager.replace
        failed = False

        def fail_once(path, data, mode=0o600):
            nonlocal failed
            if path == self.manager.layout.desktop and not failed:
                failed = True
                raise OSError("simulated write failure")
            return replace(path, data, mode)

        with patch.object(self.manager, "replace", side_effect=fail_once):
            with self.assertRaises(OSError):
                self.apply("repair")
        self.assertEqual(self.manager.layout.registration.read_bytes(), before)
        self.assertEqual(self.manager.layout.receipt.read_bytes(), receipt)
        self.assertTrue(self.manager.state()["healthy"])

    def test_stale_confirmation_is_rejected(self):
        plan = self.manager.plan("install")
        path = self.manager.layout.desktop
        path.parent.mkdir(parents=True)
        path.write_text("another application")
        with self.assertRaises(SetupError):
            self.manager.apply("install", plan["token"])
        self.assertEqual(path.read_text(), "another application")

    def test_symlink_and_invalid_receipt_cannot_delete_other_files(self):
        elsewhere = Path(self.temp.name) / "elsewhere"
        elsewhere.mkdir()
        (self.home / ".local").symlink_to(elsewhere, target_is_directory=True)
        with self.assertRaises(SetupError):
            self.manager.plan("install")
        (self.home / ".local").unlink()
        self.apply("install")
        receipt = self.manager.receipt()
        receipt["release"] = "../../elsewhere"
        self.manager.layout.receipt.write_text(json.dumps(receipt))
        with self.assertRaises(SetupError):
            self.manager.plan("uninstall")
        self.assertTrue(elsewhere.is_dir())

    def test_gui_dependencies_are_not_needed_by_installed_scanner(self):
        self.apply("install")
        receipt = self.manager.receipt()
        host = self.manager.layout.base / receipt["release"] / "native/host.py"
        text = host.read_text()
        self.assertNotIn("gi.repository", text)
        self.assertNotIn("setup.manager", text)

    def test_uninstall_preserves_unknown_user_files_and_empty_directories(self):
        self.apply("install")
        release = self.manager.layout.base / self.manager.receipt()["release"]
        (release / "user-notes.txt").write_text("keep this")
        (release / "user-directory").mkdir()
        result = self.apply("uninstall")
        self.assertEqual((release / "user-notes.txt").read_text(), "keep this")
        self.assertTrue((release / "user-directory").is_dir())
        self.assertIn(str(release), result["retained"])

    def test_bundle_is_self_contained_and_launcher_finds_neighbor_without_shell(self):
        shutil.copytree(ROOT / "thunderbird", self.root / "thunderbird", dirs_exist_ok=True)
        shutil.copyfile(ROOT / "setup/launcher.c", self.root / "setup/launcher.c")
        shutil.copyfile(ROOT / "README.md", self.root / "README.md")
        xpi, _ = build(self.root)
        bundle = build_setup(self.root, xpi)
        destination = Path(self.temp.name) / '展開先 with spaces %$"'
        with tarfile.open(bundle) as archive:
            archive.extractall(destination, filter="data")
        package = next(destination.iterdir())
        self.assertTrue(all((package / name).is_file() for name in PAYLOAD))
        self.assertEqual((package / "extension.xpi").read_bytes(), xpi.read_bytes())
        # Replace the entry point only in this disposable test fixture. The ELF
        # must locate its neighboring script even in a non-ASCII/spaced path.
        (package / "setup.py").write_text(
            "from pathlib import Path\nPath(__file__).with_name('launched').write_text('ok')\n"
        )
        subprocess.run([str(package / "ClamAV-Mail-Check-Setup")], check=True, timeout=10)
        self.assertEqual((package / "launched").read_text(), "ok")


if __name__ == "__main__":
    unittest.main()
