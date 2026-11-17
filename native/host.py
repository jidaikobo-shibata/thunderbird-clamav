#!/usr/bin/python3
"""Bounded Native Messaging host. Reads mail bytes, never arbitrary file paths."""

import base64
import binascii
import hashlib
import io
import json
import os
from pathlib import Path
import signal
import socket
import re
import struct
import subprocess
import sys
import tempfile
import time

# Translation catalog; keep protocol/status values independent of language.
_LANGUAGE = "ja"
_EN_MESSAGES = {'メールが空か、検査上限の25MiBを超えています。': 'The message is empty or exceeds the 25 MiB scan limit.',
 '脅威は検出されませんでした。安全を保証するものではありません。': 'No threats were detected. This does not guarantee safety.',
 'ClamAVが警告を返しました。検査範囲を確認できません。': 'ClamAV returned a warning. Scan coverage could not be confirmed.',
 ' clamdを利用できないため、通常のclamscanで検査しました。': ' clamd was unavailable, so the message was scanned using regular '
                                        'clamscan.',
 '通信データのサイズが上限を超えています。': 'The communication data exceeds the size limit.',
 '通信データはオブジェクトである必要があります。': 'Communication data must be an object.',
 '暗号化または検査上限により、検査できない部分があります。': 'Some content could not be scanned due to encryption or scan limits.',
 '検出結果を解釈できませんでした。': 'Could not interpret the detection result.',
 'ClamAVの検査完了を確認できませんでした。': 'Could not confirm that ClamAV completed the scan.',
 '暗号化または外部参照の内容は検査していません。': 'Encrypted or externally referenced content was not scanned.',
 '連続検査では専用clamdを利用します。初回は定義を読み込みます。起動できない場合はclamscanを利用します。': 'Continuous scans use a dedicated clamd. '
                                                              'Definitions are loaded on first use. clamscan '
                                                              'is used if clamd cannot start.',
 '検査はclamscanで1通ずつ実行します。': 'Each message is scanned individually with clamscan.',
 '通信が途中で終了しました。': 'Communication ended unexpectedly.',
 '通信データの形式が不正です。': 'Invalid communication data format.',
 'ClamAVが検査を完了できませんでした。終了コード: ': 'ClamAV could not complete the scan. Exit code: ',
 '脅威候補を検出しました。': 'A potential threat was detected.',
 '検査が120秒以内に完了しませんでした。': 'The scan did not complete within 120 seconds.',
 'ClamAVを起動できません。インストール状態を確認してください。': 'Cannot start ClamAV. Check its installation.',
 'clamdとの通信に失敗しました。検査は完了していません。': 'Communication with clamd failed. The scan has not completed.',
 '暗号化されている部分は検査していません。': 'Encrypted parts were not scanned.',
 'ClamAVのバージョンを取得できません。': 'Cannot retrieve the ClamAV version.',
 '検査できない部分もあります。': 'Some content could not be scanned.',
 'clamdの応答が途中で終了しました。': 'clamd stopped responding before the response was complete.',
 'メール検査用clamdが終了しました。': 'The mail-scanning clamd exited.',
 'clamdの使用中の定義が古いか、更新日時を確認できません。': "clamd's loaded definitions are outdated, or their age could not be "
                                   'determined.',
 'clamdが警告を返しました。検査範囲を確認できません。': 'clamd returned a warning. Scan coverage could not be confirmed.',
 'メール転送中は管理操作を実行できません。': 'Maintenance cannot run during message transfer.',
 '検査データの受信中です。': 'Scan data is being received.',
 'メールサイズが不正か、25MiBを超えています。': 'The message size is invalid or exceeds 25 MiB.',
 '受信データの順序が不正です。': 'Received data is out of sequence.',
 'データ片のサイズが不正です。': 'Invalid chunk size.',
 '受信サイズが宣言サイズを超えています。': 'Received data exceeds the declared size.',
 'メールデータが不足しています。': 'Message data is incomplete.',
 'メールデータの照合に失敗しました。': 'Message data verification failed.',
 '通信IDが不正です。': 'Invalid communication ID.',
 'clamdの応答が長すぎます。': 'The clamd response is too long.',
 'データ片の形式が不正です。': 'Invalid chunk format.',
 '管理機能を利用できません。CLIで導入・修復してください。': 'Maintenance is unavailable. Use the command-line installer to install or '
                                  'repair the helper.',
 '未対応の操作です。': 'This operation is not supported.'}

def set_language(language):
    global _LANGUAGE
    _LANGUAGE = "ja" if str(language).lower().replace("_", "-").startswith("ja") else "en-US"

def current_language():
    return _LANGUAGE

class LocalizedText(str):
    def __new__(cls, text, parts):
        value = super().__new__(cls, text)
        value.parts = parts
        return value

    def __add__(self, other):
        parts = other.parts if isinstance(other, LocalizedText) else [{"text": str(other)}]
        return LocalizedText(str(self) + str(other), self.parts + parts)

    def __radd__(self, other):
        return LocalizedText(str(other) + str(self), [{"text": str(other)}] + self.parts)


_MESSAGE_KEYS = {'メールが空か、検査上限の25MiBを超えています。': 'mail033',
 '脅威は検出されませんでした。安全を保証するものではありません。': 'mail361',
 'ClamAVが警告を返しました。検査範囲を確認できません。': 'mail362',
 ' clamdを利用できないため、通常のclamscanで検査しました。': 'mail363',
 '通信データのサイズが上限を超えています。': 'mail364',
 '通信データはオブジェクトである必要があります。': 'mail365',
 '暗号化または検査上限により、検査できない部分があります。': 'mail366',
 '検出結果を解釈できませんでした。': 'mail367',
 'ClamAVの検査完了を確認できませんでした。': 'mail368',
 '暗号化または外部参照の内容は検査していません。': 'mail369',
 '連続検査では専用clamdを利用します。初回は定義を読み込みます。起動できない場合はclamscanを利用します。': 'mail370',
 '検査はclamscanで1通ずつ実行します。': 'mail371',
 '通信が途中で終了しました。': 'mail372',
 '通信データの形式が不正です。': 'mail373',
 'ClamAVが検査を完了できませんでした。終了コード: ': 'mail374',
 '脅威候補を検出しました。': 'mail375',
 '検査が120秒以内に完了しませんでした。': 'mail376',
 'ClamAVを起動できません。インストール状態を確認してください。': 'mail377',
 'clamdとの通信に失敗しました。検査は完了していません。': 'mail378',
 '暗号化されている部分は検査していません。': 'mail379',
 'ClamAVのバージョンを取得できません。': 'mail380',
 '検査できない部分もあります。': 'mail381',
 'clamdの応答が途中で終了しました。': 'mail382',
 'メール検査用clamdが終了しました。': 'mail383',
 'clamdの使用中の定義が古いか、更新日時を確認できません。': 'mail384',
 'clamdが警告を返しました。検査範囲を確認できません。': 'mail385',
 'メール転送中は管理操作を実行できません。': 'mail386',
 '検査データの受信中です。': 'mail387',
 'メールサイズが不正か、25MiBを超えています。': 'mail388',
 '受信データの順序が不正です。': 'mail389',
 'データ片のサイズが不正です。': 'mail390',
 '受信サイズが宣言サイズを超えています。': 'mail391',
 'メールデータが不足しています。': 'mail392',
 'メールデータの照合に失敗しました。': 'mail393',
 '通信IDが不正です。': 'mail394',
 'clamdの応答が長すぎます。': 'mail395',
 'データ片の形式が不正です。': 'mail396',
 '管理機能を利用できません。CLIで導入・修復してください。': 'mail397',
 '未対応の操作です。': 'mail082'}



_EN_MESSAGES.update({'ClamAVが対応する導入先に見つかりません。設定の導入案内を確認してください。': 'ClamAV was not found in a supported installation location. See the installation guide in Settings.', 'ClamAVを起動・確認できません。導入状態と実行権限を確認してください。': 'ClamAV could not be started or verified. Check its installation and execution permissions.'})

_MESSAGE_KEYS.update({'ClamAVが対応する導入先に見つかりません。設定の導入案内を確認してください。': 'clamavMissing', 'ClamAVを起動・確認できません。導入状態と実行権限を確認してください。': 'clamavUnusable'})

_EN_MESSAGES.update({"検査設定が不正です。": "Invalid scan settings.", "注意情報を検出しました。ウイルスの検出とは区別して確認してください。": "Advisory findings detected. Review them separately from malware detections."})
_MESSAGE_KEYS.update({"検査設定が不正です。": "scanSettingsInvalid", "注意情報を検出しました。ウイルスの検出とは区別して確認してください。": "scanAdvisoryDetail"})

_EN_MESSAGES["検査が制限時間内に完了しませんでした。"] = "The scan did not finish within the time limit."
_MESSAGE_KEYS["検査が制限時間内に完了しませんでした。"] = "scanTimeout"

_EN_MESSAGES.update({"MIME解析の上限に達したため、検査範囲を確認できない部分があります。": "MIME analysis reached its resource limit; some scan coverage could not be verified.", " MIME解析の上限に達した部分があります。脅威の検出結果は保持しています。": " MIME analysis reached its resource limit. The malware detection is preserved."})
_MESSAGE_KEYS.update({"MIME解析の上限に達したため、検査範囲を確認できない部分があります。": "mimeLimited", " MIME解析の上限に達した部分があります。脅威の検出結果は保持しています。": "mimeLimitedThreat"})

def tr(message):
    text = message if _LANGUAGE == "ja" else _EN_MESSAGES.get(message, message)
    key = _MESSAGE_KEYS.get(message)
    return LocalizedText(text, [{"key": key, "text": text}]) if key else text


def describe_result(value):
    detail = value.get("detail")
    if isinstance(detail, LocalizedText):
        value = {**value, "detailMessages": detail.parts}
    return value


HOST_NAME = "local.clam_mail_check"
PROTOCOL = 1
MAX_MAIL = 25 * 1024 * 1024
CHUNK_SIZE = 64 * 1024
MAX_FRAME = 128 * 1024
CLAMSCAN = "/usr/bin/clamscan"
TEMP_ROOT = "/tmp"
TIMEOUT = 120
CLAMD = "/usr/sbin/clamd"
DATABASE = "/var/lib/clamav"
DIRECT_RUNTIME = False
CLAMAV_TRUST_ERROR = False
START_TIMEOUT = 180 if sys.platform == "darwin" else 60
sys.dont_write_bytecode = True


def trusted_macos_path(path, prefix):
    """Only an installed Homebrew ClamAV, owned by root/current user/admin.

    Resolve symlinks and inspect both the link path and target's ancestors.
    This does not attempt to defend against another process of the same user.
    """
    path, prefix = Path(path), Path(prefix)
    target = path.resolve(strict=True)
    if not target.is_relative_to(prefix / "Cellar/clamav") or not target.is_file() or not os.access(target, os.X_OK):
        raise OSError("ClamAV is outside the trusted installation")
    for item in {*path.parents, path, *target.parents, target}:
        info = item.stat()
        if info.st_uid not in (0, os.getuid()) or info.st_mode & 0o002:
            raise OSError("Untrusted ClamAV ownership or permissions")
        if info.st_mode & 0o020 and info.st_gid not in (0, 80):
            raise OSError("Untrusted writable ClamAV group")
    return str(target)


def macos_clamav():
    prefixes = ("/opt/homebrew", "/usr/local") if os.uname().machine == "arm64" else ("/usr/local", "/opt/homebrew")
    rejected = False
    for prefix in prefixes:
        executable = Path(prefix) / "bin/clamscan"
        if not executable.exists() and not executable.is_symlink():
            continue
        try:
            scan = trusted_macos_path(executable, prefix)
        except OSError:
            rejected = True
            continue
        try:
            daemon = trusted_macos_path(Path(prefix) / "sbin/clamd", prefix)
        except OSError:
            daemon = None
        return scan, daemon, prefix + "/var/lib/clamav", False
    prefix = prefixes[0]
    return None, None, prefix + "/var/lib/clamav", rejected


if sys.platform == "darwin":
    CLAMSCAN, CLAMD, DATABASE, CLAMAV_TRUST_ERROR = macos_clamav()


def macos_rss(pid):
    import ctypes
    lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    lib.proc_pidinfo.restype = ctypes.c_int
    info = ctypes.create_string_buffer(96)  # Darwin proc_taskinfo
    if lib.proc_pidinfo(pid, 4, 0, info, len(info)) != len(info):
        raise OSError(ctypes.get_errno(), "Cannot inspect MIME worker memory")
    return int.from_bytes(info.raw[8:16], sys.byteorder)


SCAN_DEFAULTS = {"phishing": "off", "macros": "off", "pua": "off", "mailMiB": 25, "expandedMiB": 100, "seconds": 60}
MAX_TRANSFER = 100 * 1024 * 1024

def scan_options(value=None):
    if value is None:
        return dict(SCAN_DEFAULTS)
    if not isinstance(value, dict) or set(value) - set(SCAN_DEFAULTS):
        raise ProtocolError(tr("検査設定が不正です。"))
    result = {**SCAN_DEFAULTS, **value}
    for key in ("phishing", "macros", "pua"):
        if result[key] not in ("off", "display", "notify"):
            raise ProtocolError(tr("検査設定が不正です。"))
    for key, low, high in (("mailMiB", 5, 100), ("expandedMiB", 25, 500), ("seconds", 10, 120)):
        if type(result[key]) is not int or not low <= result[key] <= high:
            raise ProtocolError(tr("検査設定が不正です。"))
    if result["expandedMiB"] < result["mailMiB"]:
        raise ProtocolError(tr("検査設定が不正です。"))
    return result


def advisory_kind(signature):
    if signature.startswith(("Heuristics.Phishing.", "HTML.Phishing.", "Email.Phishing.", "Phishing.")):
        return "phishing"
    if signature == "Heuristics.OLE2.ContainsMacros":
        return "macros"
    if signature.startswith("PUA."):
        return "pua"
    return None


class ProtocolError(Exception):
    pass


def read_exact(stream, size):
    data = bytearray()
    while len(data) < size:
        part = stream.read(size - len(data))
        if not part:
            raise ProtocolError(tr('通信が途中で終了しました。'))
        data.extend(part)
    return bytes(data)


def read_frame(stream):
    first = stream.read(1)
    if not first:
        return None
    length = struct.unpack("=I", first + read_exact(stream, 3))[0]
    if not 0 < length <= MAX_FRAME:
        raise ProtocolError(tr('通信データのサイズが上限を超えています。'))
    try:
        value = json.loads(read_exact(stream, length).decode("utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise ProtocolError(tr('通信データの形式が不正です。')) from exc
    if not isinstance(value, dict):
        raise ProtocolError(tr('通信データはオブジェクトである必要があります。'))
    return value


def write_frame(stream, value):
    data = json.dumps(value, ensure_ascii=False).encode("utf-8")
    stream.write(struct.pack("=I", len(data)))
    stream.write(data)
    stream.flush()


def classify(returncode, output):
    """Never interpret scanner failure or scan-limit alerts as a clean scan."""
    signatures = []
    for line in output.splitlines():
        match = re.match(r"^.*: (.+) FOUND$", line)
        if match:
            signatures.append(match[1][:200])
    signatures = list(dict.fromkeys(signatures))
    incomplete = [s for s in signatures if s.startswith((
        "Heuristics.Limits.Exceeded", "Heuristics.Encrypted."
    ))]
    advisories = [{"kind": key, "signatures": [sig for sig in signatures if advisory_kind(sig) == key][:30]}
                  for key in ("phishing", "macros", "pua") if any(advisory_kind(sig) == key for sig in signatures)]
    threats = [s for s in signatures if s not in incomplete and advisory_kind(s) is None]
    # Determine the verdict before truncating the display list.
    signatures = (threats + incomplete + [s for s in signatures if advisory_kind(s)])[:30]
    if returncode not in (0, 1):
        return {"status": "error", "signatures": signatures,
                "detail": tr('ClamAVが検査を完了できませんでした。終了コード: ')
                          + str(returncode)}
    if threats:
        return {"status": "detected", "signatures": signatures, "advisories": advisories,
                "detail": tr('脅威候補を検出しました。') + (
                    tr('検査できない部分もあります。') if incomplete else "")}
    if incomplete:
        return {"status": "incomplete", "signatures": signatures, "advisories": advisories,
                "detail": tr('暗号化または検査上限により、検査できない部分があります。')}
    if advisories:
        return {"status": "advisory", "signatures": signatures, "advisories": advisories,
                "detail": tr("注意情報を検出しました。ウイルスの検出とは区別して確認してください。")}
    if returncode == 1:
        return {"status": "error", "signatures": [],
                "detail": tr('検出結果を解釈できませんでした。')}
    if "ERROR" in output or "stdin: OK" not in output.splitlines():
        return {"status": "error", "signatures": [],
                "detail": tr('ClamAVの検査完了を確認できませんでした。')}
    # An encrypted OpenPGP/S/MIME message isn't useful as ciphertext to ClamAV.
    return {"status": "clean", "signatures": [],
            "detail": tr('脅威は検出されませんでした。安全を保証するものではありません。')}


class MimeLimitError(Exception):
    pass


def encrypted_mail(data):
    # Parsing is also isolated by mime_inspection; public factory limits bound
    # allocations before constructing a full Message tree.
    from email import policy
    from email.parser import BytesFeedParser
    from email.message import EmailMessage
    parts = 0
    def factory(*args, **kwargs):
        nonlocal parts
        parts += 1
        if parts > 2000:
            raise MimeLimitError("too many MIME parts")
        return EmailMessage(*args, **kwargs)
    parser = BytesFeedParser(_factory=factory, policy=policy.default)
    for offset in range(0, len(data), 64 * 1024):
        parser.feed(data[offset:offset + 64 * 1024])
    stack = [(parser.close(), 0)]
    encrypted = False
    while stack:
        part, depth = stack.pop()
        if depth > 32 or sum(len(name) + len(value) for name, value in part.raw_items()) > 256 * 1024:
            raise MimeLimitError("MIME depth or headers exceeded")
        content_type = part.get_content_type()
        if content_type in {"multipart/encrypted", "application/pgp-encrypted", "message/external-body"}:
            encrypted = True
        if content_type in {"application/pkcs7-mime", "application/x-pkcs7-mime"} and part.get_param("smime-type") != "signed-data":
            encrypted = True
        if part.is_multipart():
            stack.extend((child, depth + 1) for child in part.get_payload())
        elif part.get_content_maintype() == "text" and b"-----BEGIN PGP MESSAGE-----" in (part.get_payload(decode=True) or b""):
            encrypted = True
    return encrypted


def mime_worker():
    # Fail closed if limits or parent monitoring cannot be applied.
    try:
        import resource
        if sys.platform == "linux":
            resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
        elif sys.platform == "darwin":
            parent = os.getppid()

            def check_parent(_signal, _frame):
                if os.getppid() != parent:
                    raise SystemExit(1)

            signal.signal(signal.SIGALRM, check_parent)
            signal.setitimer(signal.ITIMER_REAL, 0.1, 0.1)
        else:
            return 1
        resource.setrlimit(resource.RLIMIT_CPU, (3, 3))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        child_lifetime(os.getppid())
        data = sys.stdin.buffer.read(MAX_TRANSFER + 1)
        if len(data) > MAX_TRANSFER:
            return 1
        encrypted = encrypted_mail(data)
        sys.stdout.buffer.write(b"encrypted" if encrypted else b"clear")
        return 0
    except (Exception, MemoryError):
        return 1
    finally:
        if sys.platform == "darwin":
            # Do not leave SIGALRM armed while Python restores signal defaults
            # during interpreter shutdown (it can turn a valid result into -14).
            signal.setitimer(signal.ITIMER_REAL, 0)


def mime_inspection(data):
    try:
        command = [sys.executable, "-I", "-B", str(Path(__file__).absolute()), "--mime-check"]
        if sys.platform == "darwin":
            with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as child:
                deadline = time.monotonic() + 5
                try:
                    first = True
                    while True:
                        try:
                            output, _ = child.communicate(input=data if first else None, timeout=0.05)
                            return output.decode("ascii") if child.returncode == 0 and output in (b"encrypted", b"clear") else "limited"
                        except subprocess.TimeoutExpired:
                            first = False
                            if time.monotonic() >= deadline:
                                return "limited"
                            try:
                                if macos_rss(child.pid) > 512 * 1024 ** 2:
                                    return "limited"
                            except ProcessLookupError:
                                continue  # Harvest the output of a just-exited worker.
                            except OSError:
                                if child.poll() is None:
                                    raise
                finally:
                    if child.poll() is None:
                        child.kill()
                    child.wait(timeout=5)
        result = subprocess.run(command,
                                input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=5, check=False)
        if result.returncode == 0 and result.stdout in (b"encrypted", b"clear"):
            return result.stdout.decode("ascii")
    except (OSError, subprocess.TimeoutExpired):
        pass
    return "limited"


class DaemonUnavailable(Exception):
    pass


def child_lifetime(parent):
    """Linux uses prctl; Darwin direct children stay in the supervised group."""
    if sys.platform == "darwin":
        if os.getppid() != parent:
            os._exit(1)
        return
    if sys.platform != "linux":
        os._exit(1)
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGTERM) != 0:
        os._exit(1)
    if os.getppid() != parent:
        os._exit(1)


class MailDaemon:
    """Private, foreground daemon; no OS service/config/registration changes."""

    def __init__(self):
        self.process = None
        self.temp = None
        self.address = None
        self.disabled = False
        self.engine = None
        self.diagnostics = None
        self.diagnostic_offset = 0
        self.options = scan_options()

    def configure(self, options):
        options = scan_options(options)
        def engine_key(value):
            return tuple(value[key] != "off" for key in ("phishing", "macros", "pua")) + tuple(value[key] for key in ("mailMiB", "expandedMiB", "seconds"))
        if engine_key(options) != engine_key(self.options):
            self.close()
            self.disabled = False
        self.options = options

    def exchange(self, command, data=None, timeout=TIMEOUT):
        deadline = time.monotonic() + timeout

        def remaining():
            value = deadline - time.monotonic()
            if value <= 0:
                raise TimeoutError("clamd request timed out")
            return value

        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(timeout)
            connection.connect(self.address)
            connection.sendall(b"z" + command + b"\0")
            if data is not None:
                for offset in range(0, len(data), CHUNK_SIZE):
                    chunk = data[offset:offset + CHUNK_SIZE]
                    connection.settimeout(remaining())
                    connection.sendall(struct.pack("!I", len(chunk)) + chunk)
                connection.sendall(struct.pack("!I", 0))
            reply = bytearray()
            while True:
                connection.settimeout(remaining())
                chunk = connection.recv(4096)
                if not chunk:
                    break
                reply.extend(chunk)
                if len(reply) > MAX_FRAME:
                    raise ProtocolError(tr('clamdの応答が長すぎます。'))
            if not reply or not reply.endswith(b"\0"):
                raise ProtocolError(tr('clamdの応答が途中で終了しました。'))
            return bytes(reply[:-1]).decode("utf-8", "replace")

    def start(self):
        if CLAMAV_TRUST_ERROR:
            raise ProtocolError(tr('ClamAVを起動・確認できません。導入状態と実行権限を確認してください。'))
        if self.disabled:
            raise DaemonUnavailable()
        if self.process is not None:
            if self.process.poll() is not None:
                # A failed running daemon is an error, never silently clean.
                raise ProtocolError(tr('メール検査用clamdが終了しました。'))
            return
        if not CLAMD or not os.access(CLAMD, os.X_OK):
            self.disabled = True
            raise DaemonUnavailable()
        try:
            # Fixed /tmp avoids long/newline-containing TMPDIR socket paths.
            self.temp = tempfile.TemporaryDirectory(prefix="clam-mail-daemon-", dir=TEMP_ROOT)
            directory = Path(self.temp.name)
            self.address = str(directory / "clamd.sock")
            config = directory / "clamd.conf"
            config.write_text("\n".join([
                "Foreground yes", "LocalSocket " + self.address, "LocalSocketMode 600",
                "TemporaryDirectory " + str(directory), "DatabaseDirectory " + DATABASE,
                "FailIfCvdOlderThan 3", "SelfCheck 60", "ConcurrentDatabaseReload no",
                "ScanMail yes", "ScanArchive yes", "AlertEncrypted yes", "AlertExceedsMax yes",
                "PhishingSignatures " + ("yes" if self.options["phishing"] != "off" else "no"),
                "PhishingScanURLs " + ("yes" if self.options["phishing"] != "off" else "no"),
                "AlertOLE2Macros " + ("yes" if self.options["macros"] != "off" else "no"),
                "DetectPUA " + ("yes" if self.options["pua"] != "off" else "no"),
                "HeuristicScanPrecedence no", "DisableCache yes",
                "MaxFileSize %sM" % self.options["mailMiB"], "MaxScanSize %sM" % self.options["expandedMiB"],
                "StreamMaxLength %sM" % self.options["mailMiB"],
                "MaxFiles 10000", "MaxRecursion 16", "MaxScanTime %s" % (self.options["seconds"] * 1000),
                "MaxThreads 1", "MaxQueue 2", "LogSyslog no", "LogClean no",
                "LeaveTemporaryFiles no", "ExitOnOOM yes", "ReadTimeout 120", "",
            ]))
            config.chmod(0o600)
            self.diagnostics = tempfile.TemporaryFile(dir=directory)
            parent = os.getpid()
            self.process = subprocess.Popen(
                [CLAMD, "--foreground", "--config-file=" + str(config)],
                stdin=subprocess.DEVNULL, stdout=self.diagnostics, stderr=self.diagnostics,
                preexec_fn=lambda: child_lifetime(parent),
            )
            deadline = time.monotonic() + START_TIMEOUT
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise OSError("daemon startup failed")
                try:
                    if self.exchange(b"PING", timeout=1) == "PONG":
                        self.engine = self.exchange(b"VERSION", timeout=2)
                        if not self.engine.startswith("ClamAV "):
                            raise OSError("invalid daemon version")
                        return
                except (OSError, ProtocolError):
                    pass
                time.sleep(0.1)
            raise OSError("daemon startup timed out")
        except (OSError, subprocess.SubprocessError):
            self.close()
            self.disabled = True
            raise DaemonUnavailable() from None

    def scan(self, data):
        self.start()
        # Check the loaded database, not just the possibly newer on-disk files.
        version = self.exchange(b"VERSION", timeout=2)
        try:
            from datetime import datetime
            stamp = version.split("/", 2)[2]
            age = time.time() - datetime.strptime(stamp, "%a %b %d %H:%M:%S %Y").timestamp()
            if not -86400 <= age <= 3 * 86400:
                raise ValueError("stale database")
        except (ValueError, IndexError):
            return {"status": "error", "signatures": [],
                    "detail": tr('clamdの使用中の定義が古いか、更新日時を確認できません。')}
        if any(self.options[key] != "off" for key in ("phishing", "macros", "pua")):
            # ALLMATCHSCAN is file-based: private, short-lived input, removed even on errors.
            with tempfile.NamedTemporaryFile(prefix="mail-", dir=self.temp.name) as mail:
                mail.write(data)
                mail.flush()
                path = mail.name
                output = self.exchange(b"ALLMATCHSCAN " + os.fsencode(path), timeout=max(TIMEOUT, self.options["seconds"] + 30))
                output = output.replace(path + ":", "stream:")
        else:
            output = self.exchange(b"INSTREAM", data, **({"timeout": self.options["seconds"] + 30} if self.options["seconds"] > 90 else {}))
        # INSTREAM reports one match; preserve limit/encryption alerts as incomplete.
        lines = output.split("\0")
        valid = all(line == "stream: OK" or
                    re.fullmatch(r"stream: .+ FOUND", line) for line in lines)
        normalized = "\n".join("stdin:" + line[7:] if line.startswith("stream:") else line
                               for line in lines)
        found = any(line.endswith(" FOUND") for line in lines)
        value = classify((1 if found else 0) if valid else 2, normalized)
        value["engine"] = version + " (clamd)"
        if self.diagnostics is not None:
            size = os.fstat(self.diagnostics.fileno()).st_size
            offset = min(self.diagnostic_offset, size)
            length = size - offset
            diagnostic = os.pread(self.diagnostics.fileno(), min(length, MAX_FRAME), offset).upper()
            self.diagnostic_offset = size
            if length > MAX_FRAME or b"WARNING" in diagnostic or b"ERROR" in diagnostic:
                if value["status"] in ("clean", "advisory"):
                    value["status"] = "incomplete"
                    value["detail"] = tr('clamdが警告を返しました。検査範囲を確認できません。')
        return value

    def close(self):
        if self.process is not None:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
            self.process = None
        if self.diagnostics is not None:
            self.diagnostics.close()
            self.diagnostics = None
        self.diagnostic_offset = 0
        if self.temp is not None:
            self.temp.cleanup()
            self.temp = None


def scan_clamscan(data, options=None):
    if CLAMAV_TRUST_ERROR:
        return {"status": "error", "signatures": [], "detail": tr('ClamAVを起動・確認できません。導入状態と実行権限を確認してください。')}
    if not CLAMSCAN:
        return {"status": "error", "signatures": [], "detail": tr('ClamAVが対応する導入先に見つかりません。設定の導入案内を確認してください。')}
    options = scan_options(options)
    args = [CLAMSCAN, "--stdout", "--no-summary", "--scan-mail=yes",
            "--allmatch=yes", "--alert-encrypted=yes", "--alert-exceeds-max=yes",
            "--max-filesize=25M", "--max-scansize=100M", "--max-files=10000",
            "--max-recursion=16", "--max-scantime=60000", "--fail-if-cvd-older-than=3",
            "--phishing-sigs=no", "--phishing-scan-urls=no", "-"]
    args = [arg for arg in args if not arg.startswith(("--max-filesize=", "--max-scansize=", "--max-scantime=", "--phishing-sigs=", "--phishing-scan-urls="))]
    args[-1:-1] = ["--max-filesize=%sM" % options["mailMiB"], "--max-scansize=%sM" % options["expandedMiB"],
        "--max-scantime=%s" % (options["seconds"] * 1000), "--heuristic-scan-precedence=no",
        "--phishing-sigs=" + ("yes" if options["phishing"] != "off" else "no"),
        "--phishing-scan-urls=" + ("yes" if options["phishing"] != "off" else "no"),
        "--alert-macros=" + ("yes" if options["macros"] != "off" else "no"),
        "--detect-pua=" + ("yes" if options["pua"] != "off" else "no")]
    if sys.platform == "darwin":
        args.insert(1, "--database=" + DATABASE)
    try:
        # ClamAV may unpack containers internally. Give it a private temporary
        # directory, including on failures/timeouts, rather than keeping mail.
        with tempfile.TemporaryDirectory(prefix="clam-mail-check-", dir=TEMP_ROOT) as temp:
            result = subprocess.run(args[:-1] + ["--tempdir=" + temp, "-"],
                                    input=data, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=max(TIMEOUT, options["seconds"] + 30),
                                    check=False)
    except subprocess.TimeoutExpired:
        return {"status": "error", "signatures": [],
                "detail": tr("検査が制限時間内に完了しませんでした。")}
    except OSError:
        return {"status": "error", "signatures": [],
                "detail": tr('ClamAVを起動できません。インストール状態を確認してください。')}
    value = classify(result.returncode, result.stdout.decode("utf-8", "replace"))
    if value["status"] in ("clean", "advisory") and (
        result.stderr.strip() or "Warning:" in result.stdout.decode("utf-8", "replace")
    ):
        value["status"] = "incomplete"
        value["detail"] = tr('ClamAVが警告を返しました。検査範囲を確認できません。')
    return value


def scan(data, scanner=None, options=None):
    policy = scan_options(options)
    if not data or len(data) > policy["mailMiB"] * 1024 * 1024:
        return {"status": "incomplete", "signatures": [],
                "detail": tr('メールが空か、検査上限の25MiBを超えています。')}
    fallback = False
    if scanner is not None and (options is not None or isinstance(scanner, MailDaemon)):
        scanner.configure(policy)
    try:
        value = scanner.scan(data) if scanner else (scan_clamscan(data) if options is None else scan_clamscan(data, policy))
    except DaemonUnavailable:
        fallback = True
        value = scan_clamscan(data) if options is None else scan_clamscan(data, policy)
    except (OSError, ProtocolError):
        if scanner is not None:
            scanner.close()
            scanner.disabled = True
        value = {"status": "error", "signatures": [],
                 "detail": tr('clamdとの通信に失敗しました。検査は完了していません。')}
    if fallback:
        value["detail"] += tr(' clamdを利用できないため、通常のclamscanで検査しました。')
    inspection = mime_inspection(data) if value["status"] not in ("error", "incomplete") else "clear"
    if inspection == "limited":
        if value["status"] in ("clean", "advisory"):
            value["status"] = "incomplete"
            value["detail"] = tr("MIME解析の上限に達したため、検査範囲を確認できない部分があります。")
        elif value["status"] == "detected":
            value["detail"] += tr(" MIME解析の上限に達した部分があります。脅威の検出結果は保持しています。")
    elif inspection == "encrypted":
        if value["status"] in ("clean", "advisory"):
            value["status"] = "incomplete"
            value["detail"] = tr('暗号化または外部参照の内容は検査していません。')
        elif value["status"] == "detected":
            value["detail"] += tr('暗号化されている部分は検査していません。')
    value["sha256"] = hashlib.sha256(data).hexdigest()
    if options is not None:
        value["scanSettings"] = policy
    return value


def health():
    if CLAMAV_TRUST_ERROR:
        return {"status": "error", "code": "clamav_unusable", "detail": tr('ClamAVを起動・確認できません。導入状態と実行権限を確認してください。')}
    if not CLAMSCAN or not Path(CLAMSCAN).is_file():
        return {"status": "error", "code": "clamav_missing", "detail": tr('ClamAVが対応する導入先に見つかりません。設定の導入案内を確認してください。')}
    try:
        result = subprocess.run([CLAMSCAN, "--version"], capture_output=True,
                                timeout=10, check=False)
        if result.returncode:
            raise OSError("version failed")
        version = result.stdout.decode("utf-8", "replace").strip()[:300]
        if not version.startswith("ClamAV "):
            raise OSError("invalid version")
    except (OSError, subprocess.TimeoutExpired):
        return {"status": "error", "code": "clamav_unusable", "detail": tr('ClamAVを起動・確認できません。導入状態と実行権限を確認してください。')}
    return {"status": "ready", "protocol": PROTOCOL, "engine": version,
            "maxBytes": MAX_TRANSFER, "chunkBytes": CHUNK_SIZE, "scanSettingsVersion": 1,
            "detail": (tr('連続検査では専用clamdを利用します。初回は定義を読み込みます。起動できない場合はclamscanを利用します。')
                       if CLAMD and os.access(CLAMD, os.X_OK) else tr('検査はclamscanで1通ずつ実行します。') )}


class Session:
    def __init__(self):
        self.buffer = None
        self.expected = 0
        self.sequence = 0
        self.scanner = MailDaemon()
        self.administration = None
        self.scan_settings = None

    def close(self):
        self.reset()
        self.scanner.close()
        if self.administration is not None:
            self.administration.close()

    def reset(self):
        if self.buffer is not None:
            self.buffer.close()
        self.buffer = None
        self.expected = 0
        self.sequence = 0
        self.scan_settings = None

    def handle(self, request):
        set_language(request.get("language", "ja"))
        operation = request.get("op")
        if operation == "health":
            return health()
        if operation in {"manageInfo", "managePlan", "manageApply"}:
            if self.buffer is not None:
                raise ProtocolError(tr('メール転送中は管理操作を実行できません。'))
            try:
                if self.administration is None:
                    root = Path(__file__).resolve().parents[1]
                    sys.path.insert(0, str(root))
                    from setup.cli import Administration
                    self.administration = Administration(root)
                from setup import set_language as set_setup_language
                set_setup_language(current_language())
                if operation == "manageInfo":
                    return self.administration.info()
                if operation == "managePlan":
                    return self.administration.prepare(request.get("operation"), request.get("package"))
                self.scanner.close()
                return self.administration.apply(request.get("token"))
            except (ImportError, OSError, ValueError) as error:
                raise ProtocolError(tr('管理機能を利用できません。CLIで導入・修復してください。') + str(error)) from error
            except Exception as error:
                # SetupError is imported lazily: scanning has no setup dependency.
                if error.__class__.__name__ == "SetupError":
                    raise ProtocolError(str(error)) from error
                raise
        if operation == "begin":
            if self.buffer is not None:
                raise ProtocolError(tr('検査データの受信中です。'))
            self.scan_settings = scan_options(request["scanSettings"]) if "scanSettings" in request else None
            limit = (self.scan_settings or SCAN_DEFAULTS)["mailMiB"] * 1024 * 1024
            size = request.get("size")
            if type(size) is not int or not 0 < size <= limit:
                raise ProtocolError(tr('メールサイズが不正か、25MiBを超えています。'))
            self.expected = size
            self.sequence = 0
            self.buffer = io.BytesIO()
            return {"status": "accepted"}
        if operation == "abort":
            self.reset()
            return {"status": "aborted"}
        if operation == "chunk":
            if self.buffer is None or request.get("seq") != self.sequence:
                raise ProtocolError(tr('受信データの順序が不正です。'))
            encoded = request.get("data")
            if not isinstance(encoded, str) or len(encoded) > 4 * ((CHUNK_SIZE + 2) // 3):
                raise ProtocolError(tr('データ片のサイズが不正です。'))
            try:
                data = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error) as exc:
                raise ProtocolError(tr('データ片の形式が不正です。')) from exc
            if not data or len(data) > CHUNK_SIZE or self.buffer.tell() + len(data) > self.expected:
                raise ProtocolError(tr('受信サイズが宣言サイズを超えています。'))
            self.buffer.write(data)
            self.sequence += 1
            return {"status": "accepted", "seq": self.sequence}
        if operation == "end":
            if self.buffer is None or self.buffer.tell() != self.expected:
                raise ProtocolError(tr('メールデータが不足しています。'))
            data = self.buffer.getvalue()
            digest = hashlib.sha256(data).hexdigest()
            if request.get("sha256") != digest:
                raise ProtocolError(tr('メールデータの照合に失敗しました。'))
            options = self.scan_settings
            self.reset()
            self.scan_settings = None
            return scan(data, self.scanner) if options is None else scan(data, self.scanner, options)
        raise ProtocolError(tr('未対応の操作です。'))


def main(input_stream=None, output_stream=None):
    input_stream = input_stream or sys.stdin.buffer
    output_stream = output_stream or sys.stdout.buffer
    session = Session()
    try:
        while True:
            request = read_frame(input_stream)
            if request is None:
                break
            request_id = request.get("id")
            if not isinstance(request_id, str) or len(request_id) > 80:
                raise ProtocolError(tr('通信IDが不正です。'))
            try:
                value = session.handle(request)
            except ProtocolError as exc:
                session.reset()
                value = {"status": "error", "detail": exc.args[0] if exc.args else str(exc)}
            write_frame(output_stream, {"id": request_id, "detailLocale": current_language(), **describe_result(value)})
    except (ProtocolError, BrokenPipeError):
        return 1
    finally:
        session.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(mime_worker() if sys.argv[1:] == ["--mime-check"] else main())
