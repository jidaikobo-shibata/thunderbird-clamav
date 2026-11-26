import json
from pathlib import Path
import unittest
import zipfile

from scripts.build_direct_mail_check import build


class DirectPackageTests(unittest.TestCase):
    def test_160_package_only_changes_compatibility(self):
        with zipfile.ZipFile(build()) as esr, zipfile.ZipFile(build(160)) as release:
            self.assertEqual(esr.namelist(), release.namelist())
            for name in esr.namelist():
                if name == "manifest.json":
                    manifest = json.loads(esr.read(name))
                    manifest["browser_specific_settings"]["gecko"].update(
                        strict_min_version="160.0", strict_max_version="160.*")
                    self.assertEqual(manifest, json.loads(release.read(name)))
                else:
                    self.assertEqual(esr.read(name), release.read(name), name)

    def test_real_mail_experiment_keeps_id_and_does_not_ship_installers_or_test_apis(self):
        root = Path(__file__).resolve().parents[1]
        stable = json.loads((root / 'thunderbird/manifest.json').read_text())
        with zipfile.ZipFile(build()) as archive:
            manifest = json.loads(archive.read('manifest.json'))
            self.assertEqual(manifest['browser_specific_settings']['gecko']['id'], stable['browser_specific_settings']['gecko']['id'])
            self.assertEqual(manifest['browser_specific_settings']['gecko']['strict_max_version'], '153.*')
            self.assertEqual(manifest['version'], '0.20.0a54')
            self.assertEqual(archive.read('direct/windows.py'), (root / 'experiments/direct-runtime/windows.py').read_bytes())
            self.assertEqual(manifest['name'], 'ClamAV Mail Check')
            self.assertEqual(manifest['options_ui'], {'page': 'options.html', 'open_in_tab': True})
            self.assertIn('options.mjs', archive.namelist())
            self.assertNotIn('nativeMessaging', manifest['permissions'])
            self.assertNotIn('messagesImport', manifest['permissions'])
            self.assertFalse(any(name.endswith(('.eml', '.cvd', '.cld', '.log')) for name in archive.namelist()))
            self.assertFalse(manifest.get('optional_permissions'))
            self.assertEqual(set(manifest['experiment_apis']), {'clamDirect'})
            self.assertIn('messagesDelete', manifest['permissions'])
            self.assertIn('messagesMove', manifest['permissions'])
            self.assertIn('idle', manifest['permissions'])
            self.assertEqual(archive.read('LICENSE'), (root / 'LICENSE').read_bytes())
            self.assertNotIn('installer.pyz', archive.namelist())
            self.assertFalse(any(name.startswith(('fixture/', 'setup/')) for name in archive.namelist()))
            self.assertEqual(archive.read('direct/host.py'), (root / 'native/host.py').read_bytes())
            self.assertEqual(archive.read('direct/guardian.py'), (root / 'experiments/direct-runtime/guardian.py').read_bytes())
            self.assertEqual(archive.read('direct/api.js'), (root / 'experiments/direct-runtime/api.js').read_bytes())
