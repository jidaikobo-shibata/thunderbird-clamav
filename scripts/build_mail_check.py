#!/usr/bin/python3
"""Package the extension and prepare (but never register) its native host."""

import json
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
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


def build_setup(root, xpi):
    """Self-contained Ubuntu bundle; compiling the launcher needs a C compiler."""
    manifest = json.loads((root / "thunderbird/manifest.json").read_text())
    version = manifest["version"]
    name = "clam-mail-check-setup-" + version + "-linux-" + platform.machine()
    output = root / "dist" / (name + ".tar.gz")
    with tempfile.TemporaryDirectory(prefix="clam-setup-build-") as temp:
        bundle = Path(temp) / name
        files = ["setup.py", "setup/__init__.py", "setup/manager.py", "setup/gui.py",
                 "native/host.py", "thunderbird/manifest.json", "README.md"]
        for name_in_bundle in files:
            target = bundle / name_in_bundle
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / name_in_bundle, target)
        shutil.copyfile(xpi, bundle / "extension.xpi")
        launcher = bundle / "ClamAV-Mail-Check-Setup"
        subprocess.run(["/usr/bin/cc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
                        "-D_FORTIFY_SOURCE=2", "-fstack-protector-strong",
                        "-Wl,-z,relro,-z,now", str(root / "setup/launcher.c"),
                        "-o", str(launcher)], check=True)
        launcher.chmod(0o755)
        (bundle / "setup.py").chmod(0o755)
        with tarfile.open(output, "w:gz") as archive:
            archive.add(bundle, arcname=bundle.name)
    return output


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    artifacts = build(root)
    for artifact in (*artifacts, build_setup(root, artifacts[0])):
        print(artifact)
