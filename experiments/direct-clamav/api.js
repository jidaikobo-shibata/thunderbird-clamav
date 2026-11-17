/* Isolated Linux feasibility probe; not the production scanner. No shell or native host. */
var directClam = (() => {
  Cu.importGlobalProperties(["TextDecoder"]);
  const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
  const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
  const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const MAX_MAIL = 25 * 1024 * 1024, MAX_OUTPUT = 64 * 1024;
  const SAMPLE = "Subject: Synthetic test\r\n\r\nHello\r\n";
  const INFECTED = 'Subject: Synthetic attachment\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="sample"\r\n\r\n--sample\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="synthetic.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\nWDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=\r\n--sample--\r\n';

  return class extends ExtensionCommon.ExtensionAPI {
    processes = new Set();
    directory = null;
    daemon = null;
    daemonLog = "";
    busy = false;
    closed = false;

    async collect(pipe, process) {
      const chunks = [];
      let size = 0;
      while (true) {
        const chunk = await pipe.read();
        if (!chunk.byteLength) break;
        size += chunk.byteLength;
        if (size > MAX_OUTPUT) {
          await process.kill(0);
          throw new Error("Subprocess output limit exceeded");
        }
        chunks.push(new Uint8Array(chunk));
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return new TextDecoder().decode(bytes);
    }

    async spawn(command, args, memory = 4 * 1024 ** 3, cpu = 90) {
      if (this.closed) throw new Error("Experiment is shutting down");
      // Only fixed internal callers reach this method. No API accepts executable paths/options.
      const process = await Subprocess.call({ command: "/usr/bin/setpriv",
        arguments: ["--pdeathsig=KILL", "/usr/bin/prlimit", `--as=${memory}`, `--cpu=${cpu}`, "--", command, ...args],
        environment: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" }, stderr: "pipe" });
      this.processes.add(process);
      if (this.closed) { await process.kill(0); throw new Error("Experiment shut down during spawn"); }
      return process;
    }

    async execute(command, args, input = "", timeout = 120000, memory, cpu) {
      const process = await this.spawn(command, args, memory, cpu);
      let timer, timedOut = false;
      const stdout = this.collect(process.stdout, process), stderr = this.collect(process.stderr, process);
      // Attach rejection handlers immediately, including while stdin is being written.
      const collected = Promise.all([stdout, stderr]);
      collected.catch(() => {});
      timer = setTimeout(() => { timedOut = true; void process.kill(0); }, timeout);
      try {
        if (input.length) {
          const bytes = Uint8Array.from(input, character => character.charCodeAt(0));
          await process.stdin.write(bytes.buffer);
        }
        await process.stdin.close();
        const [out, err] = await collected;
        const { exitCode } = await process.wait();
        if (timedOut) throw new Error("Subprocess wall-clock timeout");
        return { exitCode, stdout: out, stderr: err };
      } finally {
        clearTimeout(timer);
        await process.kill(0).catch(() => {});
        this.processes.delete(process);
      }
    }

    ensureDirectory() {
      if (!this.directory) {
        this.directory = Services.dirsvc.get("TmpD", Ci.nsIFile);
        this.directory.append("direct-clam-probe");
        this.directory.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
      }
      return this.directory.path;
    }

    async start() {
      if (this.daemon) return;
      const dir = this.ensureDirectory();
      this.config = PathUtils.join(dir, "clamd.conf");
      await IOUtils.writeUTF8(this.config, [
        "Foreground yes", `LocalSocket ${dir}/clamd.sock`, "LocalSocketMode 600",
        `TemporaryDirectory ${dir}`, "DatabaseDirectory /var/lib/clamav",
        "FailIfCvdOlderThan 3", "SelfCheck 60", "ConcurrentDatabaseReload no",
        "ScanMail yes", "ScanArchive yes", "AlertEncrypted yes", "AlertExceedsMax yes",
        "PhishingSignatures no", "PhishingScanURLs no", "HeuristicScanPrecedence no",
        "DisableCache yes", "MaxFileSize 25M", "MaxScanSize 100M", "StreamMaxLength 25M",
        "MaxFiles 10000", "MaxRecursion 16", "MaxScanTime 60000", "MaxThreads 1", "MaxQueue 2",
        "LogSyslog no", "LogClean no", "LeaveTemporaryFiles no", "ExitOnOOM yes", "ReadTimeout 120", ""
      ].join("\n"), { permissions: 0o600 });
      this.daemon = await this.spawn("/usr/sbin/clamd", ["--foreground", "--config-file=" + this.config], undefined, 300);
      const daemon = this.daemon;
      this.daemonOutput = Promise.all([this.collect(daemon.stdout, daemon), this.collect(daemon.stderr, daemon)])
        .then(output => { this.daemonLog = output.join("\n"); }).catch(error => { this.daemonLog = error.message; });
      await daemon.stdin.close();
      let exited = false;
      daemon.wait().then(() => { exited = true; });
      for (let attempt = 0; attempt < 300; attempt++) {
        if (exited) throw new Error("clamd exited: " + this.daemonLog);
        if (await IOUtils.exists(dir + "/clamd.sock")) {
          const ping = await this.execute("/usr/bin/clamdscan", ["--config-file=" + this.config, "--ping=1"], "", 2000);
          if (!ping.exitCode) return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("clamd startup timeout");
    }

    async scan(content, mode) {
      if (this.busy) throw new Error("A scan is already running");
      if (!content || content.length > MAX_MAIL || /[^\x00-\xff]/.test(content)) throw new Error("Invalid or oversized binary mail");
      if (!["direct", "daemon"].includes(mode)) throw new Error("Unsupported scan mode");
      this.busy = true;
      const started = Date.now();
      try {
        let result;
        if (mode === "daemon") {
          await this.start();
          result = await this.execute("/usr/bin/clamdscan", ["--config-file=" + this.config, "--stream", "--no-summary", "-"], content);
        } else {
          result = await this.execute("/usr/bin/clamscan", ["--stdout", "--no-summary", "--scan-mail=yes", "--allmatch=yes",
            "--alert-encrypted=yes", "--alert-exceeds-max=yes", "--max-filesize=25M", "--max-scansize=100M",
            "--max-files=10000", "--max-recursion=16", "--max-scantime=60000", "--fail-if-cvd-older-than=3",
            "--phishing-sigs=no", "--phishing-scan-urls=no", "--tempdir=" + this.ensureDirectory(), "-"], content);
        }
        const signatures = [...result.stdout.matchAll(/: (.+) FOUND/g)].map(match => match[1]);
        const threats = signatures.filter(name => !/^Heuristics\.(Encrypted|Limits\.Exceeded)/.test(name));
        const status = ![0, 1].includes(result.exitCode) ? "error" : threats.length ? "detected" :
          signatures.length || result.stderr.trim() ? "incomplete" : result.exitCode === 0 && /: OK/.test(result.stdout) ? "clean" : "error";
        return { status, signatures, experimental: true, coverageVerified: false, elapsedMs: Date.now() - started, mode, ...result };
      } catch (error) {
        await this.stop();
        throw error;
      } finally { this.busy = false; }
    }

    async stop() {
      await Promise.all([...this.processes].map(process => process.kill(0).catch(() => {})));
      this.processes.clear(); this.daemon = null;
      await this.daemonOutput;
      this.daemonOutput = null;
      if (this.directory) {
        await IOUtils.remove(this.directory.path, { recursive: true, ignoreAbsent: true });
        this.directory = null;
      }
    }

    getAPI(context) {
      this.context = context;
      return { directClam: {
        health: async () => {
          const result = await this.execute("/usr/bin/clamscan", ["--version"], "", 10000);
          if (result.exitCode || !result.stdout.startsWith("ClamAV ")) throw new Error("ClamAV is unavailable");
          return { version: result.stdout.trim(), nativeMessaging: false, python: false };
        },
        scan: (content, mode) => this.scan(content, mode),
        close: () => this.stop(),
        selfTest: () => this.selfTest(context)
      } };
    }

    async selfTest(context) {
      const profile = PathUtils.profileDir;
      // Test automation is inert unless the launcher created this marker in its own profile.
      if (!await IOUtils.exists(PathUtils.join(profile, "direct-clam-test-enabled"))) return { skipped: true };
      const version = context.extension.manifest.version;
      const report = { version, thunderbird: Services.appinfo.version, results: [], nativeMessaging: false, python: false };
      const write = () => IOUtils.writeJSON(PathUtils.join(profile, "probe-result-" + version + ".json"), report);
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      try {
        report.clamav = (await this.execute("/usr/bin/clamscan", ["--version"], "", 10000)).stdout.trim();
        if (version === "0.1.2") {
          report.results.push(await this.scan(SAMPLE, "daemon"));
          report.daemonPid = this.daemon.pid;
          report.parentPid = Services.appinfo.processID;
          report.temporaryDirectory = this.directory.path;
          report.ok = true;
          await write();
          return report; // The isolated launcher will crash ONLY this Thunderbird instance.
        }
        if (version === "0.1.0") {
          report.results.push(await this.scan(SAMPLE, "direct"));
          check(report.results.at(-1).status === "clean", "Direct clean verdict");
          report.results.push(await this.scan(INFECTED, "direct"));
          check(report.results.at(-1).status === "detected", "Direct EICAR verdict");
          for (const mail of [SAMPLE, INFECTED, SAMPLE, SAMPLE,
            'Content-Type: multipart/encrypted; boundary="x"\r\n\r\n--x\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n--x--\r\n']) report.results.push(await this.scan(mail, "daemon"));
          check(report.results.slice(2).map(result => result.status).join() === "clean,detected,clean,clean,clean", "Daemon engine verdicts");
          report.knownGaps = ["Auxiliary MIME coverage checks are not ported: synthetic encrypted MIME is reported clean by ClamAV alone.", "Production scan policy, advisory handling, and mail integration are not ported."];
          let rejected = false;
          try { await this.scan("", "daemon"); } catch { rejected = true; }
          check(rejected, "Empty input must fail");
          rejected = false;
          try { await this.execute("/usr/bin/sleep", ["2"], "", 100); } catch { rejected = true; }
          check(rejected, "Wall-clock limit must terminate process");
          report.timeoutEnforced = true;
          const limits = (await this.execute("/usr/bin/prlimit", ["--pid=" + this.daemon.pid, "--as", "--raw", "--noheadings"], "", 2000)).stdout;
          report.addressSpaceLimit = limits.trim();
          check(limits.includes("4294967296"), "Daemon address-space limit");
          report.memoryLimitEnforced = true;
        } else {
          const result = await this.scan(SAMPLE, "daemon");
          check(result.status === "clean", "Updated extension scans");
          report.results.push(result);
        }
        report.daemonPid = this.daemon.pid;
        report.temporaryDirectory = this.directory.path;
        report.ok = true;
        await write();
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        const addon = await AddonManager.getAddonByID(context.extension.id);
        report.permissions = addon.userPermissions;
        await write();
        if (version === "0.1.0") {
          const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          file.initWithPath(PathUtils.join(profile, "probe-update.xpi"));
          const install = await AddonManager.getInstallForFile(file);
          await install.install();
        } else {
          await addon.uninstall();
        }
        return report;
      } catch (error) {
        report.ok = false; report.error = String(error) + "\n" + error.stack;
        report.daemonLog = this.daemonLog;
        await write(); await this.stop();
        return report;
      }
    }

    onShutdown(isAppShutdown) {
      this.closed = true;
      if (!isAppShutdown) Services.obs.notifyObservers(null, "startupcache-invalidate");
      const version = this.context?.extension.manifest.version;
      const profile = PathUtils.profileDir;
      void this.stop().then(async () => {
        if (await IOUtils.exists(PathUtils.join(profile, "direct-clam-test-enabled")))
          await IOUtils.writeJSON(PathUtils.join(profile, "probe-cleanup-" + version + ".json"), { ok: true, isAppShutdown });
      }).catch(error => console.error("ClamAV probe cleanup:", error));
    }
  };
})();
