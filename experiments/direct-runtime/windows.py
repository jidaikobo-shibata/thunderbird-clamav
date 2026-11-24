"""Supervise the packaged scanner with Windows kernel handles (64-bit Python)."""
import ctypes as c
from ctypes import wintypes as w
import importlib.util
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid


def api(name, result, *args):
    fn = getattr(kernel, name)
    fn.argtypes, fn.restype = args, result
    return fn


kernel = c.WinDLL("kernel32", use_last_error=True)
create_job = api("CreateJobObjectW", w.HANDLE, c.c_void_p, w.LPCWSTR)
open_job = api("OpenJobObjectW", w.HANDLE, w.DWORD, w.BOOL, w.LPCWSTR)
assign = api("AssignProcessToJobObject", w.BOOL, w.HANDLE, w.HANDLE)
set_limits = api("SetInformationJobObject", w.BOOL, w.HANDLE, c.c_int, c.c_void_p, w.DWORD)
open_process = api("OpenProcess", w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
wait = api("WaitForSingleObject", w.DWORD, w.HANDLE, w.DWORD)
close = api("CloseHandle", w.BOOL, w.HANDLE)


class BasicLimits(c.Structure):
    _fields_ = [("process_time", c.c_int64), ("job_time", c.c_int64), ("flags", w.DWORD),
                ("min_ws", c.c_size_t), ("max_ws", c.c_size_t), ("active", w.DWORD),
                ("affinity", c.c_size_t), ("priority", w.DWORD), ("schedule", w.DWORD)]


class Limits(c.Structure):
    _fields_ = [("basic", BasicLimits), ("io", c.c_uint64 * 6), ("process_memory", c.c_size_t),
                ("job_memory", c.c_size_t), ("peak_process", c.c_size_t), ("peak_job", c.c_size_t)]


def checked(value):
    if not value:
        raise c.WinError(c.get_last_error())
    return value


def job(name=None, mime=False):
    handle = checked(create_job(None, name))
    limits = Limits()
    if mime:
        limits.basic.flags = 0x100 | 0x2  # process commit and user CPU time
        limits.process_memory = 512 << 20
        limits.basic.process_time = 3 * 10_000_000
    else:
        limits.basic.flags = 0x2000 | 0x200  # kill on last close and aggregate commit
        limits.job_memory = 4 << 30
    try:
        checked(set_limits(handle, 9, c.byref(limits), c.sizeof(limits)))
        return handle
    except BaseException:
        close(handle)
        raise


def limit_mime():
    handle = job(mime=True)
    try:
        checked(assign(handle, -1))
    finally:
        close(handle)


def worker(name, root):
    # Enter the guardian's job before importing the host or reading a frame.
    handle = checked(open_job(1, False, name))
    try:
        checked(assign(handle, -1))
    finally:
        close(handle)
    private = root / "mail"
    private.mkdir(mode=0o700)  # Python 3.13+ creates a restrictive Windows DACL.
    os.chdir(private)
    os.environ.update(TMP=str(private), TEMP=str(private))
    spec = importlib.util.spec_from_file_location("direct_scan_host", root / "host.py")
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    host.DIRECT_RUNTIME = True
    host.TEMP_ROOT = str(private)
    return host.main()


def supervise(parent_id, root):
    name = "Local\\ClamMail-" + uuid.uuid4().hex
    if os.getppid() != parent_id:
        raise ValueError("Unexpected scanner parent")
    parent = checked(open_process(0x100000, False, parent_id))
    child = None
    try:
        handle = job(name)
        try:
            child = subprocess.Popen([sys.executable, "-I", "-S", "-B", __file__, "--worker", name],
                                     stdin=sys.stdin.buffer, stdout=sys.stdout.buffer,
                                     stderr=sys.stderr.buffer, creationflags=subprocess.CREATE_NO_WINDOW)
            while child.poll() is None and wait(parent, 100) == 258:
                if (root / "stop").exists():
                    break
        finally:
            close(handle)
            if child:
                if child.poll() is None:
                    child.kill()
                child.wait()
    finally:
        close(parent)
        for attempt in range(60):
            try:
                shutil.rmtree(root)
                break
            except FileNotFoundError:
                break
            except OSError:
                if attempt == 59:
                    raise
                time.sleep(0.05)


if __name__ == "__main__":
    root = Path(__file__).resolve().parent
    if root.parent != Path(os.environ["LOCALAPPDATA"]).resolve() or not re.fullmatch(r"clam-mail-direct-[0-9a-f]{16}", root.name):
        raise SystemExit(1)
    if len(sys.argv) == 3 and sys.argv[1] == "--worker":
        raise SystemExit(worker(sys.argv[2], root))
    supervise(int(sys.argv[1]), root)
