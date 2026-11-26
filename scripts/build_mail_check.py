#!/usr/bin/python3
"""Package the extension and prepare (but never register) its native host."""

import json
import argparse
import io
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile


def installer_bytes(root):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from setup.manager import CLI_PAYLOAD
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in (*CLI_PAYLOAD, "__main__.py"):
            data = ((root / name).read_bytes() if name != "__main__.py" else
                    b"from setup.cli import main\nraise SystemExit(main())\n")
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    return stream.getvalue()


def build(root, *, output_dir=None):
    source = root / "thunderbird"
    manifest = json.loads((source / "manifest.json").read_text())
    output = root / "dist" if output_dir is None else Path(output_dir)
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
    installer = installer_bytes(root)
    (output / ("clam-mail-check-installer-" + manifest["version"] + ".pyz")).write_bytes(installer)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        installer_info = zipfile.ZipInfo("installer.pyz", (2026, 1, 1, 0, 0, 0))
        installer_info.external_attr = 0o100644 << 16
        installer_info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(installer_info, installer)
        for path in sorted(source.rglob("*")):
            if not path.is_file() or path.suffix not in {".html", ".js", ".mjs", ".css", ".json", ".svg"}:
                continue
            info = zipfile.ZipInfo(path.relative_to(source).as_posix(), (2026, 1, 1, 0, 0, 0))
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
        files = ["setup.py", "setup/__init__.py", "setup/manager.py", "setup/gui.py", "setup/cli.py",
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
    parser = argparse.ArgumentParser()
    parser.add_argument("--legacy-gui", action="store_true", help="互換用の旧GUI配布物も作成")
    args = parser.parse_args()
    artifacts = build(root)
    version = json.loads((root / "thunderbird/manifest.json").read_text())["version"]
    for artifact in (*artifacts, root / "dist" / ("clam-mail-check-installer-" + version + ".pyz")):
        print(artifact)
    if args.legacy_gui:
        print(build_setup(root, artifacts[0]))
