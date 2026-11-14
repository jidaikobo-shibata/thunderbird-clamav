#!/usr/bin/python3
"""Default: show an installation plan. --install registers the native host.

Never overwrites existing files. No sudo or system-wide configuration changes.
"""

import argparse
import json
import os
from pathlib import Path


def install(root, home, apply=False):
    extension = json.loads((root / "thunderbird" / "manifest.json").read_text())
    directory = home / ".local/lib/clam-mail-check" / extension["version"]
    host = directory / "host.py"
    registration = home / ".mozilla/native-messaging-hosts/local.clam_mail_check.json"
    manifest = {
        "name": "local.clam_mail_check", "description": "Local ClamAV mail scanner",
        "path": str(host), "type": "stdio",
        "allowed_extensions": [extension["browser_specific_settings"]["gecko"]["id"]]
    }
    print("作成対象:", host)
    print("作成対象:", registration)
    if host.exists() or host.is_symlink() or registration.exists() or registration.is_symlink():
        raise FileExistsError("登録先に既存のファイルがあります。上書きせず終了します。")
    if not apply:
        print("確認のみです。インストールする場合は --install を指定します。")
        return
    directory.mkdir(parents=True, exist_ok=True)
    registration.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation protects existing registration even if a concurrent
    # process creates it between the checks above and this write.
    with os.fdopen(os.open(host, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700), "wb") as stream:
        stream.write((root / "native" / "host.py").read_bytes())
    try:
        with os.fdopen(os.open(registration, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
            json.dump(manifest, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    except OSError:
        # Only roll back the new file this invocation created.
        host.unlink()
        raise
    print("ユーザー単位の補助プログラム登録が完了しました。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true")
    args = parser.parse_args()
    try:
        install(Path(__file__).resolve().parents[1], Path.home(), args.install)
    except OSError as error:
        parser.exit(1, str(error) + "\n")
