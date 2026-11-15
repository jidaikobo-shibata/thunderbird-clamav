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
TIMEOUT = 120
CLAMD = "/usr/sbin/clamd"
START_TIMEOUT = 60
sys.dont_write_bytecode = True


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
    signatures = list(dict.fromkeys(signatures))[:30]
    incomplete = [s for s in signatures if s.startswith((
        "Heuristics.Limits.Exceeded", "Heuristics.Encrypted."
    ))]
    threats = [s for s in signatures if s not in incomplete]
    if returncode not in (0, 1):
        return {"status": "error", "signatures": signatures,
                "detail": tr('ClamAVが検査を完了できませんでした。終了コード: ')
                          + str(returncode)}
    if threats:
        return {"status": "detected", "signatures": signatures,
                "detail": tr('脅威候補を検出しました。') + (
                    tr('検査できない部分もあります。') if incomplete else "")}
    if incomplete:
        return {"status": "incomplete", "signatures": signatures,
                "detail": tr('暗号化または検査上限により、検査できない部分があります。')}
    if returncode == 1:
        return {"status": "error", "signatures": [],
                "detail": tr('検出結果を解釈できませんでした。')}
    if "ERROR" in output or "stdin: OK" not in output.splitlines():
        return {"status": "error", "signatures": [],
                "detail": tr('ClamAVの検査完了を確認できませんでした。')}
    # An encrypted OpenPGP/S/MIME message isn't useful as ciphertext to ClamAV.
    return {"status": "clean", "signatures": [],
            "detail": tr('脅威は検出されませんでした。安全を保証するものではありません。')}


def encrypted_mail(data):
    # Only parse MIME structure; never render HTML or open URLs/attachments.
    from email import policy
    from email.parser import BytesParser

    message = BytesParser(policy=policy.default).parsebytes(data)
    for part in message.walk():
        if part.get_content_type() in {
            "multipart/encrypted", "application/pgp-encrypted", "message/external-body"
        }:
            return True
        if part.get_content_type() in {
            "application/pkcs7-mime", "application/x-pkcs7-mime"
        } and part.get_param("smime-type") != "signed-data":
            return True
        if part.get_content_maintype() == "text":
            payload = part.get_payload(decode=True) or b""
            if b"-----BEGIN PGP MESSAGE-----" in payload:
                return True
    return False


class DaemonUnavailable(Exception):
    pass


def child_lifetime(parent):
    """Linux child: terminate if the Native Messaging host disappears."""
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
        if self.disabled:
            raise DaemonUnavailable()
        if self.process is not None:
            if self.process.poll() is not None:
                # A failed running daemon is an error, never silently clean.
                raise ProtocolError(tr('メール検査用clamdが終了しました。'))
            return
        if not os.access(CLAMD, os.X_OK):
            self.disabled = True
            raise DaemonUnavailable()
        try:
            # Fixed /tmp avoids long/newline-containing TMPDIR socket paths.
            self.temp = tempfile.TemporaryDirectory(prefix="clam-mail-daemon-", dir="/tmp")
            directory = Path(self.temp.name)
            self.address = str(directory / "clamd.sock")
            config = directory / "clamd.conf"
            config.write_text("\n".join([
                "Foreground yes", "LocalSocket " + self.address, "LocalSocketMode 600",
                "TemporaryDirectory " + str(directory), "DatabaseDirectory /var/lib/clamav",
                "FailIfCvdOlderThan 3", "SelfCheck 60", "ConcurrentDatabaseReload no",
                "ScanMail yes", "ScanArchive yes", "AlertEncrypted yes", "AlertExceedsMax yes",
                "PhishingSignatures no", "PhishingScanURLs no", "DisableCache yes",
                "MaxFileSize 25M", "MaxScanSize 100M", "StreamMaxLength 25M",
                "MaxFiles 10000", "MaxRecursion 16", "MaxScanTime 60000",
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
        output = self.exchange(b"INSTREAM", data)
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
                if value["status"] == "clean":
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


def scan_clamscan(data):
    args = [CLAMSCAN, "--stdout", "--no-summary", "--scan-mail=yes",
            "--allmatch=yes", "--alert-encrypted=yes", "--alert-exceeds-max=yes",
            "--max-filesize=25M", "--max-scansize=100M", "--max-files=10000",
            "--max-recursion=16", "--max-scantime=60000", "--fail-if-cvd-older-than=3",
            "--phishing-sigs=no", "--phishing-scan-urls=no", "-"]
    try:
        # ClamAV may unpack containers internally. Give it a private temporary
        # directory, including on failures/timeouts, rather than keeping mail.
        with tempfile.TemporaryDirectory(prefix="clam-mail-check-") as temp:
            result = subprocess.run(args[:-1] + ["--tempdir=" + temp, "-"],
                                    input=data, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=TIMEOUT,
                                    check=False)
    except subprocess.TimeoutExpired:
        return {"status": "error", "signatures": [],
                "detail": tr('検査が120秒以内に完了しませんでした。')}
    except OSError:
        return {"status": "error", "signatures": [],
                "detail": tr('ClamAVを起動できません。インストール状態を確認してください。')}
    value = classify(result.returncode, result.stdout.decode("utf-8", "replace"))
    if value["status"] == "clean" and (
        result.stderr.strip() or "Warning:" in result.stdout.decode("utf-8", "replace")
    ):
        value["status"] = "incomplete"
        value["detail"] = tr('ClamAVが警告を返しました。検査範囲を確認できません。')
    return value


def scan(data, scanner=None):
    if not data or len(data) > MAX_MAIL:
        return {"status": "incomplete", "signatures": [],
                "detail": tr('メールが空か、検査上限の25MiBを超えています。')}
    fallback = False
    try:
        value = scanner.scan(data) if scanner else scan_clamscan(data)
    except DaemonUnavailable:
        fallback = True
        value = scan_clamscan(data)
    except (OSError, ProtocolError):
        if scanner is not None:
            scanner.close()
            scanner.disabled = True
        value = {"status": "error", "signatures": [],
                 "detail": tr('clamdとの通信に失敗しました。検査は完了していません。')}
    if fallback:
        value["detail"] += tr(' clamdを利用できないため、通常のclamscanで検査しました。')
    try:
        encrypted = encrypted_mail(data)
    except (ValueError, RecursionError):
        encrypted = True
    if encrypted:
        if value["status"] == "clean":
            value["status"] = "incomplete"
            value["detail"] = tr('暗号化または外部参照の内容は検査していません。')
        elif value["status"] == "detected":
            value["detail"] += tr('暗号化されている部分は検査していません。')
    value["sha256"] = hashlib.sha256(data).hexdigest()
    return value


def health():
    try:
        result = subprocess.run([CLAMSCAN, "--version"], capture_output=True,
                                timeout=10, check=False)
        if result.returncode:
            raise OSError("version failed")
        version = result.stdout.decode("utf-8", "replace").strip()[:300]
    except (OSError, subprocess.TimeoutExpired):
        return {"status": "error", "detail": tr('ClamAVのバージョンを取得できません。')}
    return {"status": "ready", "protocol": PROTOCOL, "engine": version,
            "maxBytes": MAX_MAIL, "chunkBytes": CHUNK_SIZE,
            "detail": (tr('連続検査では専用clamdを利用します。初回は定義を読み込みます。起動できない場合はclamscanを利用します。')
                       if os.access(CLAMD, os.X_OK) else tr('検査はclamscanで1通ずつ実行します。') )}


class Session:
    def __init__(self):
        self.buffer = None
        self.expected = 0
        self.sequence = 0
        self.scanner = MailDaemon()
        self.administration = None

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
            size = request.get("size")
            if type(size) is not int or not 0 < size <= MAX_MAIL:
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
            self.reset()
            return scan(data, self.scanner)
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
    raise SystemExit(main())
