"""Linux user installation lifecycle. No GTK dependency or privilege escalation."""

from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
import uuid

PRODUCT = "local.clam_mail_check"
EXTENSION = "clam-mail-check@local.invalid"
LEGACY_PAYLOAD = ("setup.py", "setup/__init__.py", "setup/manager.py", "setup/gui.py",
           "native/host.py", "thunderbird/manifest.json", "extension.xpi")
PAYLOAD = (*LEGACY_PAYLOAD, "setup/cli.py")


CLI_PAYLOAD = ("setup/__init__.py", "setup/manager.py", "setup/cli.py",
               "native/host.py", "thunderbird/manifest.json")


class SetupError(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def desktop_argument(value):
    # Desktop Entry string escaping followed by Exec argument escaping.
    if any(char in value for char in "\n\r\x00"):
        raise SetupError("改行を含むインストール先は使用できません。")
    value = value.replace("%", "%%")
    for char in ("\\", '"', "`", "$"):
        value = value.replace(char, "\\" + char)
    return '"' + value.replace("\\", "\\\\") + '"'


class Layout:
    """OS-specific paths live here, not in extension or scanning logic."""

    def __init__(self, home):
        self.home = Path(home).absolute()
        self.base = self.home / ".local/lib/clam-mail-check"
        self.receipt = self.base / "installation.json"
        self.registration = self.home / ".mozilla/native-messaging-hosts" / (PRODUCT + ".json")
        self.desktop = self.home / ".local/share/applications/clam-mail-check-setup.desktop"

    def safe(self, path):
        path = Path(path)
        if not path.is_relative_to(self.home) or ".." in path.parts:
            raise SetupError("インストール先の範囲が不正です。")
        for item in (path, *path.parents):
            if item == self.home:
                break
            if item.is_symlink():
                raise SetupError("シンボリックリンクのある設置先は変更しません: " + str(item))

    def read(self, path):
        self.safe(path)
        if path.exists() and not path.is_file():
            raise SetupError("通常ファイルではない対象があります: " + str(path))
        return path.read_bytes() if path.exists() else None


def probe_host(path):
    request = json.dumps({"id": "setup", "op": "health"}).encode()
    try:
        result = subprocess.run(["/usr/bin/python3", "-I", str(path)],
                                input=struct.pack("=I", len(request)) + request,
                                capture_output=True, timeout=20, check=True)
        if len(result.stdout) < 4:
            raise ValueError("missing frame")
        size = struct.unpack("=I", result.stdout[:4])[0]
        if not 0 < size <= 4096 or len(result.stdout) != size + 4:
            raise ValueError("invalid frame")
        reply = json.loads(result.stdout[4:])
        if reply.get("status") != "ready" or reply.get("protocol") != 1:
            raise ValueError("not ready")
        return reply
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise SetupError("補助プログラムとClamAVの接続確認に失敗しました。変更は確定しません。") from exc


def environment():
    """Read-only checks. Do not start Thunderbird or inspect mail profiles."""
    try:
        result = subprocess.run(["/usr/bin/clamscan", "--version"], capture_output=True,
                                timeout=10, check=True)
        engine = result.stdout.decode("utf-8", "replace").strip()[:300]
        clam = bool(engine)
    except (OSError, subprocess.SubprocessError):
        engine, clam = "ClamAVが見つからないか、起動できません。", False
    binary = shutil.which("thunderbird")
    kind = "unknown"
    if binary:
        resolved = Path(binary).resolve()
        if str(resolved).startswith("/snap/") or str(binary).startswith("/snap/"):
            kind = "snap"
        elif "/.var/app/" in str(resolved):
            kind = "flatpak"
        else:
            # A shell wrapper may start Snap/Flatpak. Do not assume it is a
            # normal installation just because it lives in /usr/bin.
            try:
                with resolved.open("rb") as stream:
                    if stream.read(4) == b"\x7fELF":
                        kind = "normal"
            except OSError:
                pass
    return {"clam": clam, "engine": engine, "thunderbird": binary, "kind": kind}


class Manager:
    def __init__(self, root, home, headless=False):
        self.headless = headless
        self.payload = CLI_PAYLOAD if headless else PAYLOAD
        self.root = Path(root).absolute()
        self.layout = Layout(home)
        manifest = json.loads((self.root / "thunderbird/manifest.json").read_text())
        self.version = manifest["version"]
        if (not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", self.version) or
                manifest["browser_specific_settings"]["gecko"]["id"] != EXTENSION):
            raise SetupError("セットアップの識別情報が一致しません。")

    def receipt(self):
        data = self.layout.read(self.layout.receipt)
        if data is None:
            return None
        try:
            value = json.loads(data)
            if value["product"] != PRODUCT or value["format"] not in (1, 2):
                raise ValueError("identity")
            if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", value["version"]):
                raise ValueError("version")
            if not re.fullmatch(r"releases/[0-9a-f]{32}", value["release"]):
                raise ValueError("release")
            allowed = [set(PAYLOAD), set(LEGACY_PAYLOAD)] if value["format"] == 1 else [set(CLI_PAYLOAD)]
            if set(value["files"]) not in allowed:
                raise ValueError("files")
            if any(not re.fullmatch(r"[0-9a-f]{64}", item) for item in
                   [*value["files"].values(), value["registration"], *([value["desktop"]] if value["desktop"] is not None else [])]):
                raise ValueError("hash")
            if value["format"] == 1 and value["desktop"] is None:
                raise ValueError("desktop")
            if value["format"] == 2 and value["desktop"] is not None:
                raise ValueError("desktop")
            return value
        except (ValueError, TypeError, KeyError) as exc:
            raise SetupError("設置記録を確認できません。既存ファイルは変更しません。") from exc

    def snapshot(self):
        paths = (self.layout.receipt, self.layout.registration, self.layout.desktop)
        return digest(encoded([digest(data) if (data := self.layout.read(path)) is not None else None
                               for path in paths]))

    def state(self):
        receipt = self.receipt()
        controls = ((self.layout.registration, "registration"), (self.layout.desktop, "desktop"))
        for path, key in controls:
            data = self.layout.read(path)
            if data is not None and (not receipt or digest(data) != receipt[key]):
                raise SetupError("既存の登録または起動メニューに変更があります。上書きしません: " + str(path))
        if receipt is None:
            return {"installed": False, "healthy": False, "version": None}
        release = self.layout.base / receipt["release"]
        healthy = True
        for name, expected in receipt["files"].items():
            data = self.layout.read(release / name)
            if data is None or digest(data) != expected:
                healthy = False
        if any(self.layout.read(path) is None and receipt[key] is not None for path, key in controls):
            healthy = False
        return {"installed": True, "healthy": healthy, "version": receipt["version"]}

    @contextmanager
    def lock(self):
        self.layout.safe(self.layout.base)
        self.layout.base.mkdir(parents=True, exist_ok=True)
        lock = self.layout.base / ".setup.lock"
        self.layout.safe(lock)
        descriptor = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise SetupError("別のセットアップが実行中です。") from exc
            yield
        finally:
            os.close(descriptor)

    def replace(self, path, data, mode=0o600):
        self.layout.safe(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        if data is None:
            path.unlink(missing_ok=True)
            return
        descriptor, temporary = tempfile.mkstemp(prefix=".setup-", dir=path.parent)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                os.fchmod(stream.fileno(), mode)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            self.layout.safe(path)
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def transaction(self, changes):
        applied = []
        try:
            for path, data, mode in changes:
                before = self.layout.read(path)
                self.replace(path, data, mode)
                applied.append((path, before, data, mode))
        except (OSError, SetupError):
            for path, before, after, mode in reversed(applied):
                # Preserve unrelated concurrent edits rather than overwrite them.
                if self.layout.read(path) == after:
                    self.replace(path, before, mode)
            raise

    def cleanup(self, receipt):
        """Remove only files matching our old receipt; leave modified files."""
        if not receipt:
            return []
        release = self.layout.base / receipt["release"]
        try:
            self.layout.safe(release)
        except SetupError:
            return [str(release)]
        retained = []
        for name, expected in receipt["files"].items():
            path = release / name
            try:
                data = self.layout.read(path)
                if data is not None:
                    if digest(data) != expected:
                        retained.append(str(path))
                    else:
                        path.unlink()
            except OSError:
                retained.append(str(path))
            except SetupError:
                retained.append(str(path))
        # Only remove the known package directories when empty; do not walk
        # or remove unrelated directories a user may have put alongside them.
        for directory in [release / "setup", release / "native", release / "thunderbird", release]:
            try:
                self.layout.safe(directory)
                if directory.exists():
                    directory.rmdir()
            except (OSError, SetupError):
                if directory == release:
                    retained.append(str(release))
        return list(dict.fromkeys(retained))

    def plan(self, operation):
        state = self.state()
        if operation not in ("install", "repair", "uninstall"):
            raise SetupError("未対応の操作です。")
        if operation == "install" and state["installed"]:
            raise SetupError("既に導入済みです。更新／修復を選択してください。")
        if operation != "install" and not state["installed"]:
            raise SetupError("このセットアップで管理する設置記録がありません。")
        if operation == "repair":
            current = tuple(map(int, state["version"].split(".")))
            wanted = tuple(map(int, self.version.split(".")))
            if wanted < current:
                raise SetupError("導入済みより古いセットアップでは更新できません。")
        return {"token": self.snapshot(), "operation": operation,
                "paths": [str(self.layout.base), str(self.layout.registration), str(self.layout.desktop)]}

    def apply(self, operation, token):
        with self.lock():
            plan = self.plan(operation)
            if token != plan["token"]:
                raise SetupError("確認後に設置状態が変わりました。状態を再確認してください。")
            previous = self.receipt()
            if operation == "uninstall":
                self.transaction([(self.layout.registration, None, 0o600),
                                  (self.layout.desktop, None, 0o644),
                                  (self.layout.receipt, None, 0o600)])
                return {"retained": self.cleanup(previous)}
            release = self.layout.base / "releases" / uuid.uuid4().hex
            self.layout.safe(release)
            release.mkdir(parents=True, mode=0o700)
            committed = False
            try:
                files = {}
                for name in self.payload:
                    source = self.root / name
                    if name == "extension.xpi" and not source.exists():
                        source = self.root / "dist" / ("clam-mail-check-" + self.version + ".xpi")
                    if source.is_symlink() or not source.is_file():
                        raise SetupError("配布ファイルが不足しています: " + name)
                    data = source.read_bytes()
                    if previous and self.root == self.layout.base / previous["release"]:
                        if digest(data) != previous["files"][name]:
                            raise SetupError("設置済みの配布ファイルに変更があります。ダウンロードしたセットアップから修復してください。")
                    target = release / name
                    self.replace(target, data, 0o700 if name == "native/host.py" else 0o600)
                    files[name] = digest(data)
                health = probe_host(release / "native/host.py")
                registration = encoded({"name": PRODUCT, "description": "Local ClamAV mail scanner",
                                        "path": str(release / "native/host.py"), "type": "stdio",
                                        "allowed_extensions": [EXTENSION]})
                desktop = ("[Desktop Entry]\nType=Application\nName=ClamAV Mail Check セットアップ\n"
                           "Comment=補助プログラムの状態確認・更新・削除\n"
                           "Exec=/usr/bin/python3 -B -I " + desktop_argument(str(release / "setup.py")) +
                           "\nIcon=application-x-executable\nTerminal=false\nCategories=Utility;\n").encode()
                if self.headless:
                    desktop = None
                receipt = {"format": 2 if self.headless else 1, "product": PRODUCT, "version": self.version,
                           "release": str(release.relative_to(self.layout.base)), "files": files,
                           "registration": digest(registration), "desktop": digest(desktop) if desktop is not None else None}
                if self.snapshot() != token:
                    raise SetupError("処理中に設置状態が変わりました。変更を確定しません。")
                self.transaction([(self.layout.registration, registration, 0o600),
                                  (self.layout.desktop, desktop, 0o644),
                                  (self.layout.receipt, encoded(receipt), 0o600)])
                committed = True
                if previous and self.root == self.layout.base / previous["release"]:
                    # The running installed GUI survives removal of its old
                    # release. Subsequent actions must use the new payload.
                    self.root = release
                return {"health": health, "retained": self.cleanup(previous)}
            finally:
                if not committed:
                    # This new, random release was created only by this invocation.
                    shutil.rmtree(release)
