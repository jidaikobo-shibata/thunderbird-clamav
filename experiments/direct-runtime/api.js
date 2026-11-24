/* Packaged, ephemeral scanner transport for Thunderbird 153 ESR. */
var clamDirect = (() => {
  Cu.importGlobalProperties(["TextEncoder", "TextDecoder"]);
  const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
  const { ExtensionUtils } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");
  const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
  const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
  const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const MAX_FRAME = 128 * 1024;
  const OPERATIONS = new Set(["health", "begin", "chunk", "end", "abort"]);
  // SDDL may express file masks using generic or directory-service abbreviations.
  const readRights = /^(FR|FX|GR|GX|RC|CC|SW|WP|LO)*$/;
  const ancestorRights = /^(FR|FX|GR|GX|RC|CC|SW|WP|LO|DC|LC)*$/;
  function verifyWindowsDescriptor(sddl, trusted, ancestor) {
    const owner = /^O:(.+?)D:/.exec(sddl);
    if (!owner || !trusted.has(owner[1]) || sddl.includes("NO_ACCESS_CONTROL") || /\([^()]*\(/.test(sddl)) throw new Error("Untrusted installation owner or DACL");
    for (const entry of sddl.matchAll(/\(([^()]*)\)/g)) {
      const [type, flags, rights, , , sid] = entry[1].split(";");
      if (flags.includes("IO") || trusted.has(sid) || type === "D") continue;
      if (type !== "A") throw new Error("Unsupported installation permissions");
      // Ancestors may allow creation of unrelated siblings (the drive root does).
      const allowed = ancestor ? 0x1200af : 0x1200a9;
      const safe = /^0x[0-9a-f]+$/i.test(rights) ? (Number(rights) & ~allowed) === 0 :
        (ancestor ? ancestorRights : readRights).test(rights);
      if (!safe) throw new Error("Unexpected installation permissions (" + rights + ")");
    }
  }
  const windows = Services.appinfo.OS === "WINNT";
  const ENVIRONMENT = windows ? {
    SystemRoot: Services.dirsvc.get("WinD", Ci.nsIFile).path,
    LOCALAPPDATA: Services.dirsvc.get("LocalAppData", Ci.nsIFile).path
  } : { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
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

    async windowsPrincipals() {
      if (this.trustedPrincipals) return this.trustedPrincipals;
      const who = await this.smallCommand(PathUtils.join(ENVIRONMENT.SystemRoot, "System32", "whoami.exe"),
        ["/user", "/fo", "csv", "/nh"]);
      const user = who.match(/,"(S-1-[0-9-]+)"$/i)?.[1];
      if (!user) throw new Error("Cannot verify current Windows user");
      // Current user, local administrators, LocalSystem and TrustedInstaller.
      this.trustedPrincipals = new Set([user, "BA", "SY", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"]);
      return this.trustedPrincipals;
    }

    async checkWindowsPermissions(command) {
      // Ask Windows for the owner and effective (non-inherit-only) allow ACEs.
      // An unknown permission representation fails closed on customized installations.
      const { ctypes: c } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
      const security = c.open("advapi32.dll");
      const kernel = c.open("kernel32.dll");
      try {
        const u32 = c.uint32_t, str = c.char16_t.ptr, ptr = c.voidptr_t;
        const get = security.declare("GetFileSecurityW", c.winapi_abi, c.int, str, u32, ptr, u32, u32.ptr);
        const convert = security.declare("ConvertSecurityDescriptorToStringSecurityDescriptorW",
          c.winapi_abi, c.int, ptr, u32, u32, str.ptr, u32.ptr);
        const free = kernel.declare("LocalFree", c.winapi_abi, ptr, ptr);
        const trusted = await this.windowsPrincipals();
        for (let path = command; path; path = PathUtils.parent(path)) {
          const absolute = /^[A-Za-z]:$/.test(path) ? path + "\\" : path;
          const length = u32();
          get(absolute, 5, null, 0, length.address()); // OWNER | DACL
          if (!length.value || length.value > 65536) throw new Error("Invalid installation security descriptor");
          const data = c.uint8_t.array(length.value)(), string = str();
          if (!get(absolute, 5, data, length.value, length.address()) ||
              !convert(data, 1, 5, string.address(), null)) throw new Error("Cannot read installation permissions");
          let sddl;
          try { sddl = string.readString(); } finally { free(string); }
          verifyWindowsDescriptor(sddl, trusted, path !== command && path !== PathUtils.parent(command));
        }
      } finally { security.close(); kernel.close(); }
    }

    async windowsPython() {
      if (!/^x86_64-/.test(Services.appinfo.XPCOMABI)) throw new Error("Windows x64 Thunderbird is required");
      const local = ENVIRONMENT.LOCALAPPDATA;
      const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
      const kernel = ctypes.open("kernel32.dll");
      try {
        const attrs = kernel.declare("GetFileAttributesW", ctypes.winapi_abi, ctypes.uint32_t, ctypes.char16_t.ptr);
        for (const minor of [15, 14, 13]) {
          for (const parts of [["Python", "pythoncore-3." + minor + "-64"], ["Programs", "Python", "Python3" + minor]]) {
            const command = PathUtils.join(local, ...parts, "python.exe");
            if (!await IOUtils.exists(command)) continue;
            for (let path = command; path; path = PathUtils.parent(path)) {
              const flags = attrs(/^[A-Za-z]:$/.test(path) ? path + "\\" : path);
              if (flags === 0xffffffff || (flags & 0x400)) throw new Error("Untrusted Python installation path");
            }
            await this.checkWindowsPermissions(command);
            const scanner = PathUtils.join(Services.dirsvc.get("ProgF", Ci.nsIFile).path, "ClamAV", "clamscan.exe");
            if (await IOUtils.exists(scanner)) await this.checkWindowsPermissions(scanner);
            const probe = await this.smallCommand(command, ["-I", "-S", "-B", "-c",
              "import sys; print(sys.version_info.major, sys.version_info.minor, sys.maxsize.bit_length())"]);
            if (probe !== "3 " + minor + " 63") throw new Error("Unexpected Windows Python runtime");
            return command;
          }
        }
      } finally { kernel.close(); }
      throw new Error("Python3 unavailable in supported Windows installation locations");
    }

    async python() {
      if (windows) return this.windowsPython();
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
      directory.initWithPath(windows ? ENVIRONMENT.LOCALAPPDATA : "/tmp"); directory.append("clam-mail-direct-" + Services.uuid.generateUUID().toString().replace(/[{}-]/g, "").slice(0, 16));
      let process, created = false;
      try {
        const python = await this.python();
        directory.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700); created = true;
        const guardian = windows ? "windows.py" : "guardian.py";
        if (windows) await this.checkWindowsPermissions(directory.path);
        for (const name of ["host.py", guardian]) {
          const path = PathUtils.join(directory.path, name);
          await IOUtils.write(path, await this.source(name), { permissions: 0o600 });
          if (windows) await this.checkWindowsPermissions(path);
        }
        if (this.stopped) throw new Error("Scanner is shutting down");
        process = await Subprocess.call({ command: python,
          arguments: ["-I", ...(windows ? ["-S"] : []), "-B", PathUtils.join(directory.path, guardian), String(Services.appinfo.processID)],
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
        const expired = new Promise((_, reject) => { timer = setTimeout(() => { void this.close(token); reject(new Error("Scanner request timed out")); }, value.op === "end" ? (Services.appinfo.OS === "Darwin" ? 360000 : 225000) : 15000); });
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
      // Keep the Windows guardian alive to clean the directory even if Thunderbird
      // exits while clamscan is busy. Closing the job handle terminates its descendants.
      if (windows) {
        let timer;
        try {
          await IOUtils.write(PathUtils.join(session.directory, "stop"), new Uint8Array());
          await Promise.race([session.process.wait(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Guardian shutdown timed out")), 5000);
          })]);
        } catch { await session.process.kill(0).catch(() => {}); }
        finally { clearTimeout(timer); }
      }
      await session.process.stdin.close().catch(() => {});
      if (!windows) await session.process.kill(3000).catch(() => {});
      await session.errors;
      for (let attempt = 0; ; attempt++) {
        try { await IOUtils.remove(session.directory, { recursive: true, ignoreAbsent: true }); break; }
        catch (error) {
          if (!windows || attempt >= 60) throw error;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
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
