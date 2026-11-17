#!/usr/bin/python3
"""Packaged POSIX scanner supervisor. Never installed or registered."""
import ctypes
import errno
import importlib.util
import os
from pathlib import Path
import resource
import select
import shutil
import signal
import sys
import time


class MacProcessMonitor:
    """Darwin libproc RSS accounting, including foreground ClamAV descendants.

    Unlike Linux RLIMIT_AS, Darwin's RLIMIT_RSS is not a hard allocation cap.
    Sampling bounds sustained use, not an instantaneous allocation spike.
    Failure to inspect a live process fails closed.
    """
    def __init__(self):
        self.lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.lib.proc_listpgrppids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_listpgrppids.restype = ctypes.c_int
        self.lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_pidinfo.restype = ctypes.c_int

    def rss(self, pid):
        # proc_taskinfo: six uint64_t followed by twelve int32_t (SDK ABI).
        info = ctypes.create_string_buffer(96)
        count = self.lib.proc_pidinfo(pid, 4, 0, info, len(info))  # PROC_PIDTASKINFO
        if count != len(info):
            if not self.alive(pid):
                return 0
            raise OSError("Cannot inspect scanner memory")
        return int.from_bytes(info.raw[8:16], sys.byteorder)

    def alive(self, pid):
        info = ctypes.create_string_buffer(136)
        ctypes.set_errno(0)
        count = self.lib.proc_pidinfo(pid, 3, 0, info, len(info))  # PROC_PIDTBSDINFO
        if count == len(info):
            return int.from_bytes(info.raw[4:8], sys.byteorder) != 5  # SZOMB
        if count == 0 and ctypes.get_errno() == errno.ESRCH:
            return False  # Darwin hides zombies from proc_pidinfo.
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        raise OSError("Cannot inspect scanner process")

    def members(self, group):
        pids = (ctypes.c_int * 64)()
        count = self.lib.proc_listpgrppids(group, pids, ctypes.sizeof(pids))
        # libproc's convenience wrappers return a PID count (not byte count).
        if count < 0 or count >= len(pids):
            raise OSError("Cannot enumerate scanner group")
        return [pid for pid in pids[:count] if pid > 0]

    def group_rss(self, group):
        return sum(self.rss(pid) for pid in self.members(group))


def worker_exit_code(child, events):
    if events is not None:
        # NOTE_EXIT does not reap the group leader, including on Python 3.10–12.
        return 0 if events.control(None, 1, 0) else None
    state = os.waitid(os.P_PID, child, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    if state is None:
        return None
    return state.si_status if state.si_code == os.CLD_EXITED else 1


def main():
    root = Path(__file__).resolve().parent
    if root.parent != Path("/tmp").resolve() or not root.name.startswith("clam-mail-direct-"):
        return 1
    if root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        return 1
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        return 1
    parent = int(sys.argv[1])
    stopping = False

    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    child = None
    events = None
    monitor = None
    try:
        if os.getppid() != parent:
            return 1
        child = os.fork()
        if child == 0:
            orphaned = False
            try:
                os.setsid()
                signal.signal(signal.SIGTERM, signal.SIG_DFL)
                signal.signal(signal.SIGINT, signal.SIG_DFL)
                guardian = os.getppid()
                orphaned = False

                def check_guardian(_signal, _frame):
                    nonlocal orphaned
                    if os.getppid() != guardian:
                        orphaned = True
                        signal.setitimer(signal.ITIMER_REAL, 0)
                        raise SystemExit(1)

                signal.signal(signal.SIGALRM, check_guardian)
                signal.setitimer(signal.ITIMER_REAL, 0.1, 0.1)
                if sys.platform == "linux":
                    resource.setrlimit(resource.RLIMIT_AS, (4 * 1024 ** 3, 4 * 1024 ** 3))
                elif sys.platform != "darwin":
                    raise RuntimeError("Unsupported scanner platform")
                resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
                spec = importlib.util.spec_from_file_location("direct_scan_host", root / "host.py")
                host = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(host)
                host.TEMP_ROOT = str(root)
                host.DIRECT_RUNTIME = True
                original = host.Session

                class ScanSession(original):
                    def handle(self, request):
                        if request.get("op") not in {"health", "begin", "chunk", "end", "abort"}:
                            raise host.ProtocolError("Unsupported direct scan operation")
                        return super().handle(request)

                host.Session = ScanSession
                code = host.main()
            except BaseException:
                code = 1
            finally:
                if orphaned:
                    # The leader remains alive here, so its group ID cannot be
                    # reused. Kill ClamAV even if host cleanup was interrupted.
                    shutil.rmtree(root, ignore_errors=True)
                    os.killpg(os.getpgrp(), signal.SIGKILL)
            os._exit(code)
        # Only the scanner child owns the protocol pipes. The guardian never reads mail.
        with open(os.devnull, "r+b", buffering=0) as null:
            for fd in (0, 1, 2):
                os.dup2(null.fileno(), fd)
        monitor = MacProcessMonitor() if sys.platform == "darwin" else None
        if monitor:
            events = select.kqueue()
            events.control([select.kevent(child, filter=select.KQ_FILTER_PROC,
                           flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                           fflags=select.KQ_NOTE_EXIT)], 0, 0)
        else:
            resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 ** 2, 128 * 1024 ** 2))
        while not stopping and os.getppid() == parent:
            code = worker_exit_code(child, events)
            if code is not None:
                return code
            if monitor:
                if monitor.rss(os.getpid()) > 128 * 1024 ** 2:
                    return 1
                # The child might not have completed setsid() on the first tick.
                if os.getpgid(child) == child and monitor.group_rss(child) > 4 * 1024 ** 3:
                    return 1
            time.sleep(0.1)
        return 0
    finally:
        if events is not None:
            events.close()
        if child:
            # Keep the group leader unreaped until the entire scanner group is dead.
            # This prevents PID/group-ID reuse while cleaning descendants.
            try:
                os.killpg(child, signal.SIGKILL)
            except PermissionError:
                # Darwin can return EPERM for a group containing only zombies.
                # Accept it only after verifying that no member is still live.
                if monitor is None or any(monitor.alive(pid) for pid in monitor.members(child)):
                    raise
            except ProcessLookupError:
                # The child might not yet have called setsid(). Stop it first.
                try:
                    os.kill(child, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            try:
                os.waitpid(child, 0)
            except ChildProcessError:
                pass
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
