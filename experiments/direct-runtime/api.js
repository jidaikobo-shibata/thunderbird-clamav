/* Experiment-only transport for the packaged, ephemeral scanner. Linux/153 ESR. */
var clamDirect = (() => {
  Cu.importGlobalProperties(["TextEncoder", "TextDecoder"]);
  const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
  const { ExtensionUtils } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");
  const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
  const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
  const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const MAX_FRAME = 128 * 1024;
  const OPERATIONS = new Set(["health", "begin", "chunk", "end", "abort"]);
  return class extends ExtensionCommon.ExtensionAPI {
    sessions = new Map();
    opening = 0;
    stopped = false;

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
        if (!await IOUtils.exists("/usr/bin/python3")) throw new Error("Python3 is not available at /usr/bin/python3");
        directory.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700); created = true;
        for (const name of ["host.py", "guardian.py"]) await IOUtils.write(PathUtils.join(directory.path, name), await this.source(name), { permissions: 0o600 });
        if (this.stopped) throw new Error("Scanner is shutting down");
        process = await Subprocess.call({ command: "/usr/bin/python3",
          arguments: ["-I", "-B", PathUtils.join(directory.path, "guardian.py"), String(Services.appinfo.processID)],
          environment: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stderr: "pipe" });
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
            if ((size += bytes.byteLength) > MAX_FRAME) { void this.close(token); break; }
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
      if (!session || this.stopped || session.pending >= 4) return Promise.reject(new Error("Scanner connection closed or busy"));
      const bytes = new TextEncoder().encode(data);
      if (bytes.length > MAX_FRAME) return Promise.reject(new Error("Scanner frame too large"));
      let value;
      try { value = JSON.parse(data); } catch { return Promise.reject(new Error("Invalid scanner frame")); }
      if (!value || !OPERATIONS.has(value.op) || typeof value.id !== "string" || value.id.length > 80) return Promise.reject(new Error("Unsupported scanner request"));
      session.pending++;
      const work = async () => {
        if (this.sessions.get(token) !== session) throw new Error("Scanner connection closed");
        let timer;
        const expired = new Promise((_, reject) => { timer = setTimeout(() => { void this.close(token); reject(new Error("Scanner request timed out")); }, value.op === "end" ? 225000 : 15000); });
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
        catch (error) { void this.close(token); throw error; }
        finally { clearTimeout(timer); session.pending--; }
      };
      const result = session.queue.catch(() => {}).then(work);
      session.queue = result;
      return result;
    }

    async close(token) {
      const session = this.sessions.get(token);
      if (!session) return;
      this.sessions.delete(token);
      await session.process.stdin.close().catch(() => {});
      // SIGTERM reaches the guardian, which kills its scanner group and cleans files.
      await session.process.kill(3000).catch(() => {});
      await session.errors;
      await IOUtils.remove(session.directory, { recursive: true, ignoreAbsent: true });
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
