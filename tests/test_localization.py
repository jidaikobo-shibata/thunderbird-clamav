import ast
import contextlib
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from native import host
from setup import current_language, set_language, tr
import sys
from scripts.build_mail_check import build, installer_bytes

ROOT = Path(__file__).resolve().parents[1]


class LocalizationTests(unittest.TestCase):
    def tearDown(self):
        set_language("ja")
        host.set_language("ja")

    def test_native_languages_preserve_status_signatures_and_message_keys(self):
        for language, snippet in [("ja", "脅威"), ("en-US", "potential threat")]:
            host.set_language(language)
            value = host.describe_result(host.classify(1, "stdin: Eicar-Test-Signature FOUND\n"))
            self.assertEqual(value["status"], "detected")
            self.assertEqual(value["signatures"], ["Eicar-Test-Signature"])
            self.assertIn(snippet, value["detail"])
            self.assertEqual(value["detailMessages"][0]["key"], "mail375")
        host.set_language("en-US")
        self.assertIn("Encrypted", host.tr("暗号化されている部分は検査していません。"))

    def test_protocol_language_and_error_codes_do_not_leak_between_requests(self):
        def frame(value):
            data = json.dumps(value).encode()
            return struct.pack("=I", len(data)) + data
        incoming = io.BytesIO(frame({"id": "en", "op": "unknown", "language": "en-US"}) +
                              frame({"id": "ja", "op": "unknown", "language": "ja"}))
        output = io.BytesIO()
        self.assertEqual(host.main(incoming, output), 0)
        output.seek(0)
        english, japanese = host.read_frame(output), host.read_frame(output)
        self.assertEqual(english["status"], "error")
        self.assertEqual(english["detailLocale"], "en-US")
        self.assertEqual(english["detail"], "This operation is not supported.")
        self.assertEqual(english["detailMessages"][0]["key"], "mail082")
        self.assertEqual(japanese["detail"], "未対応の操作です。")

    @unittest.skipIf(sys.platform == "win32", "Legacy POSIX installer")
    def test_cli_explicit_language_overrides_environment_without_installing(self):
        from setup.cli import run
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            for language, expected in [("ja", "補助プログラム:"), ("en-US", "Helper:")]:
                output = io.StringIO()
                with patch.dict("os.environ", {"LC_ALL": "fr_FR.UTF-8"}), contextlib.redirect_stdout(output):
                    self.assertEqual(run(ROOT, home, ["status", "--language", language]), 0)
                self.assertIn(expected, output.getvalue())
                self.assertFalse((home / ".local/lib/clam-mail-check/installation.json").exists())
            self.assertEqual(current_language(), "ja")

    def test_all_python_generated_messages_have_english_translations(self):
        import setup
        for filename, translations in [("native/host.py", host._EN_MESSAGES),
                                       ("setup/cli.py", setup._EN_MESSAGES),
                                       ("setup/manager.py", setup._EN_MESSAGES)]:
            for node in ast.walk(ast.parse((ROOT / filename).read_text(encoding="utf-8"))):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "tr":
                    source = node.args[0].value
                    self.assertIn(source, translations, filename + ": " + source)

    @unittest.skipIf(sys.platform == "win32", "Legacy POSIX installer")
    def test_translation_catalogs_are_packaged_and_installer_file_set_is_unchanged(self):
        with tempfile.TemporaryDirectory() as temp:
            # Build only writes dist; existing build tests use the same workspace artifacts.
            target, _ = build(ROOT)
            with ZipFile(target) as archive:
                self.assertIn("_locales/en/messages.json", archive.namelist())
                self.assertIn("_locales/ja/messages.json", archive.namelist())
                manifest = json.loads(archive.read("manifest.json"))
                self.assertEqual(manifest["default_locale"], "en")
            with ZipFile(io.BytesIO(installer_bytes(ROOT))) as archive:
                from setup.manager import CLI_PAYLOAD
                self.assertEqual(set(archive.namelist()), set(CLI_PAYLOAD) | {"__main__.py"})
