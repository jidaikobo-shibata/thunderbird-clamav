"""GUI-free, self-contained installer entry point and bounded addon management."""

import argparse
import base64
import binascii
import io
import json
import os
from pathlib import Path
import tempfile
import time
import uuid
import zipfile

from .manager import CLI_PAYLOAD, Manager, SetupError

ARCHIVE_FILES = set(CLI_PAYLOAD) | {"__main__.py"}
MAX_PACKAGE = 80 * 1024


def unpack(data, target):
    if not data or len(data) > MAX_PACKAGE:
        raise SetupError("導入用ファイルのサイズが不正です。")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = archive.namelist()
            if len(names) != len(ARCHIVE_FILES) or set(names) != ARCHIVE_FILES:
                raise SetupError("導入用ファイルの構成が一致しません。")
            if sum(item.file_size for item in archive.infolist()) > 1024 * 1024:
                raise SetupError("導入用ファイルの展開サイズが上限を超えています。")
            # Never extract paths supplied by an archive: write only fixed names.
            for name in CLI_PAYLOAD:
                path = target / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(archive.read(name))
                path.chmod(0o600)
    except (zipfile.BadZipFile, RuntimeError, KeyError) as error:
        raise SetupError("導入用ファイルを読み取れません。") from error


class Administration:
    def __init__(self, root=None, home=None):
        self.root = Path(root) if root is not None else Path(__file__).resolve().parents[1]
        self.home = Path(home) if home is not None else Path.home()
        self.pending = None
        self.temp = None

    def manager(self):
        return Manager(self.root, self.home, headless=True)

    def info(self):
        manager = self.manager()
        state = manager.state()
        receipt = manager.receipt()
        active = bool(receipt and manager.root == manager.layout.base / receipt["release"])
        return {"status": "managed" if active else "unmanaged", "management": 1,
                "version": state["version"], "healthy": state["healthy"],
                "detail": "導入状態を確認しました。" if active else "管理対象の補助プログラムではありません。CLIで導入し直してください。"}

    def prepare(self, operation, package=None):
        self.close()
        if self.info()["status"] != "managed":
            raise SetupError("この補助プログラムはアドオンから管理できません。CLIを利用してください。")
        if operation not in ("repair", "uninstall"):
            raise SetupError("未対応の管理操作です。")
        manager = self.manager()
        if operation == "repair":
            if not isinstance(package, str):
                raise SetupError("同梱の導入用ファイルが必要です。")
            try:
                data = base64.b64decode(package, validate=True)
            except (ValueError, binascii.Error) as error:
                raise SetupError("導入用ファイルの形式が不正です。") from error
            self.temp = tempfile.TemporaryDirectory(prefix="clam-mail-update-")
            root = Path(self.temp.name)
            try:
                unpack(data, root)
                manager = Manager(root, self.home, headless=True)
            except Exception:
                self.close()
                raise
        plan = manager.plan(operation)
        token = uuid.uuid4().hex
        self.pending = (token, time.monotonic() + 300, manager, operation, plan["token"])
        return {"status": "prepared", "token": token, "operation": operation,
                "version": manager.version, "paths": plan["paths"]}

    def apply(self, token):
        pending, self.pending = self.pending, None
        if not pending or token != pending[0] or time.monotonic() > pending[1]:
            raise SetupError("管理操作の確認が期限切れか、無効です。")
        _, _, manager, operation, snapshot = pending
        try:
            result = manager.apply(operation, snapshot)
            return {"status": "removed" if operation == "uninstall" else "updated",
                    "version": manager.version, "retained": result["retained"]}
        finally:
            self.close()

    def close(self):
        self.pending = None
        if self.temp is not None:
            self.temp.cleanup()
            self.temp = None


def run(root, home, argv=None):
    parser = argparse.ArgumentParser(description="ClamAV Mail Check 補助プログラムの導入・削除（GUI不要）")
    parser.add_argument("operation", choices=["install", "uninstall", "status"])
    parser.add_argument("--yes", action="store_true", help="表示される変更内容を承認済みとして実行")
    args = parser.parse_args(argv)
    manager = Manager(root, home, headless=True)
    state = manager.state()
    print("導入用ファイルの版:", manager.version)
    print("補助プログラム:", state["version"] or "未導入")
    if args.operation == "status":
        return 0
    if args.operation == "uninstall" and not state["installed"]:
        print("補助プログラムは未導入です。変更はありません。")
        return 0
    operation = "repair" if args.operation == "install" and state["installed"] else args.operation
    plan = manager.plan(operation)
    print("次の場所の管理対象ファイルを" + ("削除します。" if operation == "uninstall" else "作成・更新します。"))
    print("\n".join(plan["paths"]))
    print("メール、ClamAV本体、Thunderbirdの拡張と設定・履歴は変更しません。sudoは不要です。")
    print("実行前に新着メールの自動検査をオフにし、検査を中止して停止を待ってください。補助プログラムはこのOSユーザーで共通です。")
    if not args.yes and input("実行しますか？ [y/N]: ").strip().lower() != "y":
        print("キャンセルしました。変更はありません。")
        return 0
    result = manager.apply(operation, plan["token"])
    print("補助プログラムの削除が完了しました。" if operation == "uninstall" else "補助プログラムの設置とClamAVの応答確認が完了しました。")
    for path in result["retained"]:
        print("変更されたファイルは残しました:", path)
    print("アドオンの画面に戻り、" + ("拡張の削除を続けてください。" if operation == "uninstall" else "「導入を確認」を押してください。"))
    return 0


def main():
    if os.getuid() == 0:
        print("通常のユーザーとして実行してください。sudoは不要です。")
        return 1
    import sys
    try:
        with tempfile.TemporaryDirectory(prefix="clam-mail-installer-") as temp:
            root = Path(temp)
            unpack(Path(sys.argv[0]).read_bytes(), root)
            return run(root, Path.home())
    except (OSError, SetupError, EOFError) as error:
        print("処理できませんでした:", error, file=sys.stderr)
        return 1
