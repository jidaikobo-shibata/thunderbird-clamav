import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
STUB = '''import json,os,subprocess,sys
from pathlib import Path
class ProtocolError(Exception): pass
class Session:
 def handle(self,request): return request
def main():
 Path(__file__).with_name("synthetic-mail.tmp").write_bytes(b"synthetic private mail")
 child=subprocess.Popen([sys.executable,"-I","-B","-c","import time; time.sleep(60)"])
 print(json.dumps({"worker":os.getpid(),"child":child.pid}),flush=True)
 try:
  sys.stdin.buffer.read()
 finally:
  child.terminate();child.wait()
 return 0
'''


def alive(pid):
    if sys.platform == "darwin":
        import importlib.util
        spec = importlib.util.spec_from_file_location("guardian_monitor", ROOT / "experiments/direct-runtime/guardian.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.MacProcessMonitor().alive(pid)
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].strip().split()[0] != "Z"
    except FileNotFoundError:
        return False


class DirectGuardianTests(unittest.TestCase):
    def prepare(self):
        directory = Path(tempfile.mkdtemp(prefix="clam-mail-direct-", dir="/tmp"))
        shutil.copyfile(ROOT / "experiments/direct-runtime/guardian.py", directory / "guardian.py")
        (directory / "host.py").write_text(STUB)
        self.addCleanup(lambda: shutil.rmtree(directory, ignore_errors=True))
        return directory

    def wait_clean(self, directory, pids):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if not directory.exists() and not any(alive(pid) for pid in pids):
                return
            time.sleep(0.05)
        self.fail(f"Supervisor left runtime={directory.exists()} or processes={[pid for pid in pids if alive(pid)]}")

    def test_pipe_close_stops_worker_and_descendants_and_removes_files(self):
        directory = self.prepare()
        process = subprocess.Popen([sys.executable, "-I", "-B", str(directory / "guardian.py"), str(os.getpid())],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.addCleanup(lambda: process.poll() is None and process.terminate())
        pids = json.loads(process.stdout.readline())
        process.stdin.close()
        process.wait(timeout=5)
        process.stdout.close()
        self.wait_clean(directory, pids.values())

    def test_terminating_guardian_stops_the_entire_scan_group(self):
        directory = self.prepare()
        process = subprocess.Popen([sys.executable, "-I", "-B", str(directory / "guardian.py"), str(os.getpid())],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        pids = json.loads(process.stdout.readline())
        process.terminate()
        process.wait(timeout=5)
        process.stdin.close(); process.stdout.close()
        self.wait_clean(directory, pids.values())

    def test_parent_crash_is_detected_without_relying_on_clamd_parent_death_signal(self):
        directory = self.prepare()
        command = ("import os,subprocess,sys; "
                   "p=subprocess.Popen([sys.executable,'-I','-B',sys.argv[1],str(os.getpid())]); p.wait()")
        parent = subprocess.Popen([sys.executable, "-I", "-c", command, str(directory / "guardian.py")],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        pids = json.loads(parent.stdout.readline())
        parent.kill(); parent.wait(timeout=5)
        parent.stdin.close(); parent.stdout.close()
        self.wait_clean(directory, pids.values())

    def test_guardian_crash_still_allows_worker_to_clean_itself(self):
        directory = self.prepare()
        process = subprocess.Popen([sys.executable, "-I", "-B", str(directory / "guardian.py"), str(os.getpid())],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        pids = json.loads(process.stdout.readline())
        process.kill(); process.wait(timeout=5)
        # Keep the pipe open: the worker must notice its guardian disappeared.
        self.wait_clean(directory, pids.values())
        process.stdin.close(); process.stdout.close()

    def test_worker_crash_does_not_leave_its_child(self):
        directory = self.prepare()
        process = subprocess.Popen([sys.executable, "-I", "-B", str(directory / "guardian.py"), str(os.getpid())],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        pids = json.loads(process.stdout.readline())
        os.kill(pids["worker"], signal.SIGKILL)
        process.wait(timeout=5)
        process.stdin.close(); process.stdout.close()
        self.wait_clean(directory, pids.values())

    @unittest.skipUnless(sys.platform == "darwin", "Darwin libproc memory watchdog")
    def test_memory_watchdog_stops_group_and_cleans_mail_files(self):
        directory = self.prepare()
        source = (directory / "guardian.py").read_text().replace(
            "monitor.group_rss(child) > 4 * 1024 ** 3", "monitor.group_rss(child) > 64 * 1024 ** 2")
        (directory / "guardian.py").write_text(source)
        (directory / "host.py").write_text(STUB.replace("import time; time.sleep(60)",
            "import time; time.sleep(.3); data=bytearray(128*1024*1024); time.sleep(60)"))
        (directory / "synthetic-mail.tmp").write_bytes(b"synthetic mail only")
        process = subprocess.Popen([sys.executable, "-I", "-B", str(directory / "guardian.py"), str(os.getpid())],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        pids = json.loads(process.stdout.readline())
        process.wait(timeout=10)
        process.stdin.close(); process.stdout.close()
        self.assertNotEqual(process.returncode, 0)
        self.wait_clean(directory, pids.values())

    @unittest.skipUnless(sys.platform == "darwin", "Darwin libproc fail-closed monitoring")
    def test_monitor_failure_stops_scanner_instead_of_removing_memory_limit(self):
        directory = self.prepare()
        source = (directory / "guardian.py").read_text().replace(
            "return sum(self.rss(pid) for pid in self.members(group))", "raise OSError('synthetic monitor failure')")
        (directory / "guardian.py").write_text(source)
        process = subprocess.Popen([sys.executable, "-I", "-B", str(directory / "guardian.py"), str(os.getpid())],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        process.communicate(timeout=5)
        self.assertNotEqual(process.returncode, 0)
        self.assertFalse(directory.exists())

    @unittest.skipUnless(sys.platform == "darwin", "Darwin libproc fail-closed enumeration")
    def test_empty_group_listing_for_live_worker_is_a_monitor_failure(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("guardian_monitor", ROOT / "experiments/direct-runtime/guardian.py")
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        monitor = module.MacProcessMonitor()
        with patch.object(monitor.lib, "proc_listpgrppids", return_value=0), patch.object(monitor, "alive", return_value=True):
            with self.assertRaisesRegex(OSError, "Cannot enumerate"):
                monitor.group_rss(os.getpid())


if __name__ == "__main__":
    unittest.main()
