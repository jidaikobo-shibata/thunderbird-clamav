#!/usr/bin/python3
"""Build the integrated scanner XPI, without a native host installer."""
import argparse
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.20.0a55"


def build(major=153):
    if major not in (153, 160):
        raise ValueError("Supported Thunderbird majors: 153, 160")
    source = ROOT / "thunderbird"
    manifest = json.loads((source / "manifest.json").read_text())
    manifest["version"] = VERSION
    manifest["name"] = "ClamAV Mail Check"
    manifest["description"] = "__MSG_directExtensionDescription__"
    manifest["permissions"] = [value for value in manifest["permissions"] if value != "nativeMessaging"] + ["messagesDelete", "messagesMove"]
    manifest.pop("optional_permissions", None)
    manifest["browser_specific_settings"]["gecko"].update(strict_min_version=f"{major}.0", strict_max_version=f"{major}.*")
    manifest["experiment_apis"] = {"clamDirect": {"schema": "direct/schema.json", "parent": {
        "scopes": ["addon_parent"], "paths": [["clamDirect"]], "script": "direct/api.js"}}}
    suffix = "-tb160" if major == 160 else ""
    output = ROOT / "dist" / f"clam-mail-check-direct-{VERSION}{suffix}.xpi"
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source.rglob("*")):
            if path.is_file() and path.suffix in {".html", ".js", ".mjs", ".css", ".json", ".svg"}:
                name = path.relative_to(source).as_posix()
                archive.writestr(name, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n" if name == "manifest.json" else path.read_bytes())
        for name in ["api.js", "schema.json", "guardian.py", "windows.py"]:
            archive.writestr("direct/" + name, (ROOT / "experiments/direct-runtime" / name).read_bytes())
        archive.writestr("LICENSE", (ROOT / "LICENSE").read_bytes())
        archive.writestr("direct/host.py", (ROOT / "native/host.py").read_bytes())
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--thunderbird-major", type=int, choices=(153, 160), default=153)
    print(build(parser.parse_args().thunderbird_major))
