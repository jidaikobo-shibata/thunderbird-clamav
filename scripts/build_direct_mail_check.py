#!/usr/bin/python3
"""Build the integrated scanner XPI, without a native host installer."""
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.20.0a44"


def build():
    source = ROOT / "thunderbird"
    manifest = json.loads((source / "manifest.json").read_text())
    manifest["version"] = VERSION
    manifest["name"] = "ClamAV Mail Check"
    manifest["description"] = "__MSG_directExtensionDescription__"
    manifest["permissions"] = [value for value in manifest["permissions"] if value != "nativeMessaging"] + ["messagesDelete", "messagesMove"]
    manifest.pop("optional_permissions", None)
    manifest["browser_specific_settings"]["gecko"].update(strict_min_version="153.0", strict_max_version="153.*")
    manifest["experiment_apis"] = {"clamDirect": {"schema": "direct/schema.json", "parent": {
        "scopes": ["addon_parent"], "paths": [["clamDirect"]], "script": "direct/api.js"}}}
    output = ROOT / "dist" / f"clam-mail-check-direct-{VERSION}.xpi"
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source.rglob("*")):
            if path.is_file() and path.suffix in {".html", ".js", ".mjs", ".css", ".json", ".svg"}:
                name = path.relative_to(source).as_posix()
                archive.writestr(name, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n" if name == "manifest.json" else path.read_bytes())
        for name in ["api.js", "schema.json", "guardian.py"]:
            archive.writestr("direct/" + name, (ROOT / "experiments/direct-runtime" / name).read_bytes())
        archive.writestr("LICENSE", (ROOT / "LICENSE").read_bytes())
        archive.writestr("direct/host.py", (ROOT / "native/host.py").read_bytes())
    return output


if __name__ == "__main__":
    print(build())
