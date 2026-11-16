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
from native.host import CHUNK_SIZE, read_frame, scan_options  # noqa: E402


def encode(value):
    data = json.dumps(value).encode()
    return struct.pack("=I", len(data)) + data


def check(data, process, options=None):
    requests = [{"id": "health", "op": "health"},
                {"id": "begin", "op": "begin", "size": len(data), **({"scanSettings": options} if options else {})}]
    for seq, offset in enumerate(range(0, len(data), CHUNK_SIZE)):
        requests.append({"id": "chunk-" + str(seq), "op": "chunk", "seq": seq,
                         "data": base64.b64encode(data[offset:offset + CHUNK_SIZE]).decode()})
    requests.append({"id": "end", "op": "end", "sha256": hashlib.sha256(data).hexdigest()})
    process.stdin.write(b"".join(map(encode, requests)))
    process.stdin.flush()
    replies = [read_frame(process.stdout) for _ in requests]
    assert replies[0]["status"] == "ready", replies[0]
    assert replies[-1]["sha256"] == requests[-1]["sha256"], replies[-1]
    if options:
        assert replies[0].get("scanSettingsVersion") == 1, replies[0]
        assert replies[-1].get("scanSettings") == options, replies[-1]
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
    options = scan_options({"phishing": "display", "macros": "display", "pua": "display", "mailMiB": 50, "expandedMiB": 200, "seconds": 90}) if "--custom-settings" in sys.argv else None
    process = subprocess.Popen([sys.executable, str(ROOT / "native/host.py")],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL)
    try:
        for name, data, expected in cases:
            started = time.monotonic()
            result = check(data, process, options)
            print(name, result["status"], result.get("signatures", []),
                  f"{time.monotonic() - started:.3f}s", result.get("engine", "clamscan"), flush=True)
            assert result["status"] == expected, result
            if "--require-clamd" in sys.argv:
                assert "(clamd)" in result.get("engine", ""), result
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        process.stdout.close()
    assert process.returncode == 0



if __name__ == "__main__":
    main()
