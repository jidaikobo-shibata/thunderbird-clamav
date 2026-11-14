#!/usr/bin/python3
"""Bounded Native Messaging host. Reads mail bytes, never arbitrary file paths."""

import base64
import binascii
import hashlib
import io
import json
import re
import struct
import subprocess
import sys
import tempfile

HOST_NAME = "local.clam_mail_check"
PROTOCOL = 1
MAX_MAIL = 25 * 1024 * 1024
CHUNK_SIZE = 64 * 1024
MAX_FRAME = 128 * 1024
CLAMSCAN = "/usr/bin/clamscan"
TIMEOUT = 120


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


def scan(data):
    if not data or len(data) > MAX_MAIL:
        return {"status": "incomplete", "signatures": [],
                "detail": "メールが空か、検査上限の25MiBを超えています。"}
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
            "detail": "検査はclamscanで1通ずつ実行します。"}


class Session:
    def __init__(self):
        self.buffer = None
        self.expected = 0
        self.sequence = 0

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
            return scan(data)
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
        session.reset()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
