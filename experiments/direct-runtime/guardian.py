#!/usr/bin/python3
"""Packaged, ephemeral Linux scanner supervisor. Never installed or registered."""
import importlib.util
import os
from pathlib import Path
import resource
import shutil
import signal
import sys
import time


def main():
    root = Path(__file__).resolve().parent
    if root.parent != Path("/tmp") or not root.name.startswith("clam-mail-direct-"):
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
                resource.setrlimit(resource.RLIMIT_AS, (4 * 1024 ** 3, 4 * 1024 ** 3))
                resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
                spec = importlib.util.spec_from_file_location("direct_scan_host", root / "host.py")
                host = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(host)
                host.TEMP_ROOT = str(root)
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
                    shutil.rmtree(root, ignore_errors=True)
            os._exit(code)
        # Only the scanner child owns the protocol pipes. The guardian never reads mail.
        for fd in (0, 1, 2):
            os.close(fd)
        resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 ** 2, 128 * 1024 ** 2))
        while not stopping and os.getppid() == parent:
            state = os.waitid(os.P_PID, child, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if state is not None:
                return state.si_status if state.si_code == os.CLD_EXITED else 1
            time.sleep(0.1)
        return 0
    finally:
        if child:
            # Keep the group leader unreaped until the entire scanner group is dead.
            # This prevents PID/group-ID reuse while cleaning descendants.
            try:
                os.killpg(child, signal.SIGKILL)
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
