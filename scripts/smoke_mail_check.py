#!/usr/bin/python3
"""Explicit local integration test using in-memory synthetic mail and EICAR.

No accounts, network access, profile changes, or mail files are involved.
"""

import base64
from email.message import EmailMessage
import hashlib
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from native.host import CHUNK_SIZE, read_frame  # noqa: E402


def encode(value):
    data = json.dumps(value).encode()
    return struct.pack("=I", len(data)) + data


def check(data):
    requests = [{"id": "health", "op": "health"},
                {"id": "begin", "op": "begin", "size": len(data)}]
    for seq, offset in enumerate(range(0, len(data), CHUNK_SIZE)):
        requests.append({"id": "chunk-" + str(seq), "op": "chunk", "seq": seq,
                         "data": base64.b64encode(data[offset:offset + CHUNK_SIZE]).decode()})
    requests.append({"id": "end", "op": "end", "sha256": hashlib.sha256(data).hexdigest()})
    process = subprocess.run([sys.executable, str(ROOT / "native/host.py")],
                             input=b"".join(map(encode, requests)), capture_output=True,
                             timeout=150, check=True)
    output = io.BytesIO(process.stdout)
    replies = [read_frame(output) for _ in requests]
    assert replies[0]["status"] == "ready", replies[0]
    assert replies[-1]["sha256"] == requests[-1]["sha256"], replies[-1]
    return replies[-1]


def message(attachment=None, filename="test.txt"):
    mail = EmailMessage()
    mail["From"] = "test@example.invalid"
    mail["To"] = "test@example.invalid"
    mail["Subject"] = "Local scanner test"
    mail.set_content("This is a local, synthetic test message.")
    if attachment is not None:
        mail.add_attachment(attachment, maintype="application", subtype="octet-stream", filename=filename)
    return mail.as_bytes()


def main():
    eicar = base64.b64decode(
        "WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElW"
        "SVJVUy1URVNULUZJTEUhJEgrSCo="
    )
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zipped:
        zipped.writestr("test.txt", eicar)
    cases = [
        ("plain", message(), "clean"),
        ("attachment", message(eicar), "detected"),
        ("zip-attachment", message(archive.getvalue(), "test.zip"), "detected"),
        ("encrypted-mail", b'Content-Type: multipart/encrypted; boundary="x"\r\n\r\n--x--\r\n', "incomplete")
    ]
    for name, data, expected in cases:
        started = time.monotonic()
        result = check(data)
        print(name, result["status"], result.get("signatures", []),
              f"{time.monotonic() - started:.1f}s", flush=True)
        assert result["status"] == expected, result


if __name__ == "__main__":
    main()
