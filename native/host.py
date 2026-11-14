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

HOST_NAME = "local.clam_mail_check"
PROTOCOL = 1
MAX_MAIL = 25 * 1024 * 1024
CHUNK_SIZE = 64 * 1024
MAX_FRAME = 128 * 1024
CLAMSCAN = "/usr/bin/clamscan"
TIMEOUT = 120
CLAMD = "/usr/sbin/clamd"
START_TIMEOUT = 60


class ProtocolError(Exception):
    pass


def read_exact(stream, size):
    data = bytearray()
    while len(data) < size:
        part = stream.read(size - len(data))
        if not part:
            raise ProtocolError("通信が途中で終了しました。")
        data.extend(part)
    return bytes(data)


def read_frame(stream):
    first = stream.read(1)
    if not first:
        return None
    length = struct.unpack("=I", first + read_exact(stream, 3))[0]
    if not 0 < length <= MAX_FRAME:
        raise ProtocolError("通信データのサイズが上限を超えています。")
    try:
        value = json.loads(read_exact(stream, length).decode("utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise ProtocolError("通信データの形式が不正です。") from exc
    if not isinstance(value, dict):
        raise ProtocolError("通信データはオブジェクトである必要があります。")
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
                "detail": "ClamAVが検査を完了できませんでした。終了コード: "
                          + str(returncode)}
    if threats:
        return {"status": "detected", "signatures": signatures,
                "detail": "脅威候補を検出しました。" + (
                    "検査できない部分もあります。" if incomplete else "")}
    if incomplete:
        return {"status": "incomplete", "signatures": signatures,
                "detail": "暗号化または検査上限により、検査できない部分があります。"}
    if returncode == 1:
        return {"status": "error", "signatures": [],
                "detail": "検出結果を解釈できませんでした。"}
    if "ERROR" in output or "stdin: OK" not in output.splitlines():
        return {"status": "error", "signatures": [],
                "detail": "ClamAVの検査完了を確認できませんでした。"}
    # An encrypted OpenPGP/S/MIME message isn't useful as ciphertext to ClamAV.
    return {"status": "clean", "signatures": [],
            "detail": "脅威は検出されませんでした。安全を保証するものではありません。"}


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
                    raise ProtocolError("clamdの応答が長すぎます。")
            if not reply or not reply.endswith(b"\0"):
                raise ProtocolError("clamdの応答が途中で終了しました。")
            return bytes(reply[:-1]).decode("utf-8", "replace")

    def start(self):
        if self.disabled:
            raise DaemonUnavailable()
        if self.process is not None:
            if self.process.poll() is not None:
                # A failed running daemon is an error, never silently clean.
                raise ProtocolError("メール検査用clamdが終了しました。")
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
                    "detail": "clamdの使用中の定義が古いか、更新日時を確認できません。"}
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
            diagnostic = os.pread(self.diagnostics.fileno(), min(size, MAX_FRAME), 0).upper()
            if size > MAX_FRAME or b"WARNING" in diagnostic or b"ERROR" in diagnostic:
                if value["status"] == "clean":
                    value["status"] = "incomplete"
                    value["detail"] = "clamdが警告を返しました。検査範囲を確認できません。"
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
                "detail": "検査が120秒以内に完了しませんでした。"}
    except OSError:
        return {"status": "error", "signatures": [],
                "detail": "ClamAVを起動できません。インストール状態を確認してください。"}
    value = classify(result.returncode, result.stdout.decode("utf-8", "replace"))
    if value["status"] == "clean" and (
        result.stderr.strip() or "Warning:" in result.stdout.decode("utf-8", "replace")
    ):
        value["status"] = "incomplete"
        value["detail"] = "ClamAVが警告を返しました。検査範囲を確認できません。"
    return value


def scan(data, scanner=None):
    if not data or len(data) > MAX_MAIL:
        return {"status": "incomplete", "signatures": [],
                "detail": "メールが空か、検査上限の25MiBを超えています。"}
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
                 "detail": "clamdとの通信に失敗しました。検査は完了していません。"}
    if fallback:
        value["detail"] += " clamdを利用できないため、通常のclamscanで検査しました。"
    try:
        encrypted = encrypted_mail(data)
    except (ValueError, RecursionError):
        encrypted = True
    if encrypted:
        if value["status"] == "clean":
            value["status"] = "incomplete"
            value["detail"] = "暗号化または外部参照の内容は検査していません。"
        elif value["status"] == "detected":
            value["detail"] += "暗号化されている部分は検査していません。"
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
        return {"status": "error", "detail": "ClamAVのバージョンを取得できません。"}
    return {"status": "ready", "protocol": PROTOCOL, "engine": version,
            "maxBytes": MAX_MAIL, "chunkBytes": CHUNK_SIZE,
            "detail": ("連続検査では専用clamdを利用します。初回は定義を読み込みます。"
                       "起動できない場合はclamscanを利用します。"
                       if os.access(CLAMD, os.X_OK) else "検査はclamscanで1通ずつ実行します。" )}


class Session:
    def __init__(self):
        self.buffer = None
        self.expected = 0
        self.sequence = 0
        self.scanner = MailDaemon()

    def close(self):
        self.reset()
        self.scanner.close()

    def reset(self):
        if self.buffer is not None:
            self.buffer.close()
        self.buffer = None
        self.expected = 0
        self.sequence = 0

    def handle(self, request):
        operation = request.get("op")
        if operation == "health":
            return health()
        if operation == "begin":
            if self.buffer is not None:
                raise ProtocolError("検査データの受信中です。")
            size = request.get("size")
            if type(size) is not int or not 0 < size <= MAX_MAIL:
                raise ProtocolError("メールサイズが不正か、25MiBを超えています。")
            self.expected = size
            self.sequence = 0
            self.buffer = io.BytesIO()
            return {"status": "accepted"}
        if operation == "abort":
            self.reset()
            return {"status": "aborted"}
        if operation == "chunk":
            if self.buffer is None or request.get("seq") != self.sequence:
                raise ProtocolError("受信データの順序が不正です。")
            encoded = request.get("data")
            if not isinstance(encoded, str) or len(encoded) > 4 * ((CHUNK_SIZE + 2) // 3):
                raise ProtocolError("データ片のサイズが不正です。")
            try:
                data = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error) as exc:
                raise ProtocolError("データ片の形式が不正です。") from exc
            if not data or len(data) > CHUNK_SIZE or self.buffer.tell() + len(data) > self.expected:
                raise ProtocolError("受信サイズが宣言サイズを超えています。")
            self.buffer.write(data)
            self.sequence += 1
            return {"status": "accepted", "seq": self.sequence}
        if operation == "end":
            if self.buffer is None or self.buffer.tell() != self.expected:
                raise ProtocolError("メールデータが不足しています。")
            data = self.buffer.getvalue()
            digest = hashlib.sha256(data).hexdigest()
            if request.get("sha256") != digest:
                raise ProtocolError("メールデータの照合に失敗しました。")
            self.reset()
            return scan(data, self.scanner)
        raise ProtocolError("未対応の操作です。")


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
                raise ProtocolError("通信IDが不正です。")
            try:
                value = session.handle(request)
            except ProtocolError as exc:
                session.reset()
                value = {"status": "error", "detail": str(exc)}
            write_frame(output_stream, {"id": request_id, **value})
    except (ProtocolError, BrokenPipeError):
        return 1
    finally:
        session.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
