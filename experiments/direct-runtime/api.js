/* Packaged, ephemeral scanner transport for Linux and macOS / 153 ESR. */
var clamDirect = (() => {
  Cu.importGlobalProperties(["TextEncoder", "TextDecoder"]);
  const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
  const { ExtensionUtils } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");
  const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
  const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
  const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const MAX_FRAME = 128 * 1024;
  const OPERATIONS = new Set(["health", "begin", "chunk", "end", "abort"]);
  const ENVIRONMENT = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  return class extends ExtensionCommon.ExtensionAPI {
    sessions = new Map();
    opening = 0;
    stopped = false;

    async smallCommand(command, args) {
      const process = await Subprocess.call({ command, arguments: args, environment: ENVIRONMENT, stderr: "pipe" });
      const timer = setTimeout(() => { void process.kill(0); }, 5000);
      try {
        const read = async pipe => {
          let text = "";
          while (true) {
            const chunk = await pipe.readString();
            if (!chunk) return text;
            text += chunk;
            if (text.length > 8192) { await process.kill(0); throw new Error("Executable verification output too large"); }
          }
        };
        const [output, errors, status] = await Promise.all([read(process.stdout), read(process.stderr), process.wait()]);
        if (status.exitCode !== 0 || errors.trim()) throw new Error("Executable verification failed");
        return output.trim();
      } catch (error) {
        await process.kill(0).catch(() => {});
        throw error;
      } finally { clearTimeout(timer); }
    }

    async python() {
      if (Services.appinfo.OS === "Linux") {
        if (!await IOUtils.exists("/usr/bin/python3")) throw new Error("Python3 is not available at /usr/bin/python3");
        return "/usr/bin/python3";
      }
      if (Services.appinfo.OS !== "Darwin") throw new Error("Unsupported scanner operating system");
      const uid = await this.smallCommand("/usr/bin/id", ["-u"]);
      const silicon = /^(aarch64|arm64)/.test(Services.appinfo.XPCOMABI);
      const prefixes = silicon ? ["/opt/homebrew", "/usr/local"] : ["/usr/local", "/opt/homebrew"];
      const candidates = [...prefixes.map(prefix => prefix + "/bin/python3"),
        "/Library/Frameworks/Python.framework/Versions/Current/bin/python3"];
      for (const candidate of candidates) {
        if (!await IOUtils.exists(candidate)) continue;
        try {
          // Inspect every directory and symlink target before executing Python.
          // Homebrew's admin-group writable directories are intentional; other
          // groups and world-writable paths are rejected. No PATH search occurs.
          const paths = new Map();
          const resolve = (path, depth = 0) => {
            if (depth > 32 || !path.startsWith("/")) throw new Error("Invalid Python symlink");
            const parts = path.split("/").filter(Boolean);
            let current = "";
            for (let index = 0; index < parts.length; index++) {
              current += "/" + parts[index];
              const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
              file.initWithPath(current); file.normalize(); current = file.path;
              const link = file.isSymlink();
              paths.set(file.path, link);
              if (link) return resolve(file.target + "/" + parts.slice(index + 1).join("/"), depth + 1);
              if (index === parts.length - 1 && (!file.isFile() || !file.isExecutable())) throw new Error("Python is not executable");
            }
            return current;
          };
          const command = resolve(candidate);
          resolve(command); // Also inspect ancestors exposed by normalization.
          if (!/^\/(?:opt\/homebrew|usr\/local)\/Cellar\/python(?:@3\.\d+|3)?\//.test(command) &&
              !command.startsWith("/Library/Frameworks/Python.framework/Versions/")) throw new Error("Python target is outside trusted installations");
          const entries = [...paths];
          const lines = (await this.smallCommand("/usr/bin/stat", ["-f", "%u:%g:%Lp", ...entries.map(([path]) => path)])).split("\n");
          if (lines.length !== entries.length) throw new Error("Incomplete Python verification");
          lines.forEach((line, index) => {
            if (!/^\d+:\d+:[0-7]+$/.test(line)) throw new Error("Invalid Python metadata");
            const [owner, group, mode] = line.split(":");
            if (owner !== "0" && owner !== uid) throw new Error("Untrusted Python owner");
            if (!entries[index][1] && ((parseInt(mode, 8) & 0o002) || ((parseInt(mode, 8) & 0o020) && !["0", "80"].includes(group)))) throw new Error("Unsafe Python permissions");
          });
          const version = JSON.parse(await this.smallCommand(command, ["-I", "-B", "-c", "import json,sys; print(json.dumps(list(sys.version_info[:2])))"]));
          if (version[0] === 3 && version[1] >= 10) return command;
        } catch (error) { console.warn("Python candidate rejected:", candidate, String(error)); }
      }
      throw new Error("Python3 3.10+ is unavailable in trusted Homebrew or python.org locations");
    }

    source(name) {
      return new Promise((resolve, reject) => {
        NetUtil.asyncFetch({ uri: this.extension.rootURI.resolve("direct/" + name), loadUsingSystemPrincipal: true }, (stream, status) => {
          if (!Components.isSuccessCode(status)) { reject(new Error("Cannot read packaged scanner")); return; }
          try {
            const size = stream.available();
            if (size > 256 * 1024) throw new Error("Packaged scanner exceeds size limit");
            const input = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
            input.setInputStream(stream);
            const bytes = new Uint8Array(input.readByteArray(size));
            resolve(bytes);
          } catch (error) { reject(error); } finally { try { stream.close(); } catch {} }
        });
      });
    }

    async open() {
      if (this.stopped || this.sessions.size + this.opening >= 8) throw new Error("Scanner session is unavailable or busy");
      this.opening++;
      const directory = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      directory.initWithPath("/tmp"); directory.append("clam-mail-direct-" + Services.uuid.generateUUID().toString().replace(/[{}-]/g, "").slice(0, 16));
      let process, created = false;
      try {
        const python = await this.python();
        directory.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700); created = true;
        for (const name of ["host.py", "guardian.py"]) await IOUtils.write(PathUtils.join(directory.path, name), await this.source(name), { permissions: 0o600 });
        if (this.stopped) throw new Error("Scanner is shutting down");
        process = await Subprocess.call({ command: python,
          arguments: ["-I", "-B", PathUtils.join(directory.path, "guardian.py"), String(Services.appinfo.processID)],
          environment: ENVIRONMENT, stderr: "pipe" });
        if (this.stopped) { await process.kill(1000); throw new Error("Scanner shut down during startup"); }
        const token = Services.uuid.generateUUID().toString();
        const session = { process, directory: directory.path, queue: Promise.resolve(), pending: 0 };
        this.sessions.set(token, session);
        void process.wait().then(() => this.close(token)).catch(() => {});
        session.errors = (async () => {
          let size = 0;
          while (true) {
            const bytes = await process.stderr.read();
            if (!bytes.byteLength) break;
            if ((size += bytes.byteLength) > MAX_FRAME) { void this.close(token).catch(() => {}); break; }
          }
        })().catch(() => {});
        return token;
      } catch (error) {
        if (process) await process.kill(1000).catch(() => {});
        if (created && directory.exists()) await IOUtils.remove(directory.path, { recursive: true, ignoreAbsent: true });
        throw error;
      } finally { this.opening--; }
    }

    request(token, data) {
      const session = this.sessions.get(token);
      if (!session || session.closing || this.stopped || session.pending >= 4) return Promise.reject(new Error("Scanner connection closed or busy"));
      const bytes = new TextEncoder().encode(data);
      if (bytes.length > MAX_FRAME) return Promise.reject(new Error("Scanner frame too large"));
      let value;
      try { value = JSON.parse(data); } catch { return Promise.reject(new Error("Invalid scanner frame")); }
      if (!value || !OPERATIONS.has(value.op) || typeof value.id !== "string" || value.id.length > 80) return Promise.reject(new Error("Unsupported scanner request"));
      session.pending++;
      const work = async () => {
        if (this.sessions.get(token) !== session || session.closing) throw new Error("Scanner connection closed");
        let timer;
        const expired = new Promise((_, reject) => { timer = setTimeout(() => { void this.close(token).catch(() => {}); reject(new Error("Scanner request timed out")); }, value.op === "end" ? (Services.appinfo.OS === "Darwin" ? 360000 : 225000) : 15000); });
        const transfer = async () => {
          await session.process.stdin.write(new Uint32Array([bytes.length]).buffer);
          await session.process.stdin.write(bytes.buffer);
          const header = await session.process.stdout.read(4);
          const length = new Uint32Array(header)[0];
          if (length < 2 || length > MAX_FRAME) throw new Error("Invalid scanner response size");
          const response = new TextDecoder("utf-8", { fatal: true }).decode(await session.process.stdout.read(length));
          const result = JSON.parse(response);
          if (!result || result.id !== value.id) throw new Error("Scanner response does not match request");
          return response;
        };
        try { return await Promise.race([transfer(), expired]); }
        catch (error) { void this.close(token).catch(() => {}); throw error; }
        finally { clearTimeout(timer); session.pending--; }
      };
      const result = session.queue.catch(() => {}).then(work);
      session.queue = result;
      return result;
    }

    close(token) {
      const session = this.sessions.get(token);
      if (!session) return Promise.resolve();
      if (session.closing) return session.closing;
      // Publish the closing promise before touching IO, including synchronous
      // failures. Keep this session counted until termination and cleanup end.
      session.closing = Promise.resolve().then(async () => {
        const pipe = Promise.resolve().then(() => session.process.stdin.close(true)).catch(() => {});
        try {
          await session.process.kill(3000);
          await pipe;
          await session.errors;
          await IOUtils.remove(session.directory, { recursive: true, ignoreAbsent: true });
        } catch (error) {
          // A failed cleanup remains counted; never open unlimited replacements.
          console.error("Scanner termination or cleanup failed:", error);
          throw error;
        }
        if (this.sessions.get(token) === session) this.sessions.delete(token);
      });
      return session.closing;
    }

    async backup(snapshot) {
      if (new TextEncoder().encode(snapshot).length > 64 * 1024 * 1024) throw new Error("Migration backup exceeds size limit");
      const data = JSON.parse(snapshot);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid migration backup");
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(PathUtils.profileDir);
      file.append("clam-mail-check-backup-" + Services.uuid.generateUUID().toString().replace(/[{}]/g, "") + ".json");
      file.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
      await IOUtils.writeUTF8(file.path, JSON.stringify({ format: 1, createdAt: new Date().toISOString(), storage: data }), { permissions: 0o600 });
      return { path: file.path, createdAt: new Date().toISOString() };
    }

    getAPI(context) {
      this.extension = context.extension;
      const exposed = operation => async (...args) => {
        try { return await operation(...args); }
        catch (error) { throw new ExtensionUtils.ExtensionError(String(error.message || error).slice(0, 400)); }
      };
      return { clamDirect: { open: exposed(() => this.open()), request: exposed((token, data) => this.request(token, data)),
        close: exposed(token => this.close(token)), backup: exposed(snapshot => this.backup(snapshot)) } };
    }

    onShutdown(isAppShutdown) {
      this.stopped = true;
      if (!isAppShutdown) Services.obs.notifyObservers(null, "startupcache-invalidate");
      for (const token of this.sessions.keys()) void this.close(token).catch(error => console.error("Scanner cleanup failed:", error));
    }
  };
})();
