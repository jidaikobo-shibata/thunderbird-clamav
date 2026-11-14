#!/usr/bin/python3
"""Package the extension and prepare (but never register) its native host."""

import json
from pathlib import Path
import zipfile


def build(root):
    source = root / "thunderbird"
    manifest = json.loads((source / "manifest.json").read_text())
    output = root / "dist"
    native = output / "native"
    native.mkdir(parents=True, exist_ok=True)
    host = native / "host.py"
    host.write_bytes((root / "native" / "host.py").read_bytes())
    host.chmod(0o700)
    host_manifest = {
        "name": "local.clam_mail_check",
        "description": "Local ClamAV mail scanner",
        "path": str(host.resolve()),
        "type": "stdio",
        "allowed_extensions": [manifest["browser_specific_settings"]["gecko"]["id"]]
    }
    (native / "local.clam_mail_check.json").write_text(
        json.dumps(host_manifest, ensure_ascii=False, indent=2) + "\n"
    )
    target = output / ("clam-mail-check-" + manifest["version"] + ".xpi")
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source.iterdir()):
            if path.suffix not in {".html", ".js", ".mjs", ".css", ".json", ".svg"}:
                continue
            info = zipfile.ZipInfo(path.name, (2026, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, path.read_bytes())
    return target, native / "local.clam_mail_check.json"


if __name__ == "__main__":
    for artifact in build(Path(__file__).resolve().parents[1]):
        print(artifact)
