/* Test-only API. Never included in a distributable XPI. */
var testFixture = (() => {
  const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
  const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  return class extends ExtensionCommon.ExtensionAPI {
    getAPI(context) {
      const profile = PathUtils.profileDir;
      const guard = async () => { if (!await IOUtils.exists(PathUtils.join(profile, "real-mail-test-enabled"))) throw new Error("Test profile marker missing"); };
      const rawMessages = () => new Promise((resolve, reject) => {
        NetUtil.asyncFetch({ uri: context.extension.rootURI.resolve("fixture/mail.json"), loadUsingSystemPrincipal: true }, (stream, status) => {
          if (!Components.isSuccessCode(status)) { reject(new Error("Cannot read synthetic mail")); return; }
          try { resolve(JSON.parse(NetUtil.readInputStreamToString(stream, stream.available(), { charset: "UTF-8" }))); }
          catch (error) { reject(error); } finally { stream.close(); }
        });
      });
      const server = () => MailServices.accounts.localFoldersServer;
      const folder = name => server().rootFolder.getChildNamed(name);

      return { testFixture: {
        prepare: async () => {
          await guard();
          try { server(); } catch { MailServices.accounts.createLocalMailAccount(); }
          const root = server().rootFolder;
          for (const name of ["DirectSource", "DirectHistory", "DirectQuarantine"]) {
            if (!root.containsChildNamed(name)) root.createSubfolder(name, null);
          }
          await new Promise(resolve => setTimeout(resolve, 100));
          return { mails: await rawMessages(), accountId: [...MailServices.accounts.accounts].find(account => account.incomingServer.key === server().key).key,
            source: context.extension.folderManager.convert(folder("DirectSource")),
            history: context.extension.folderManager.convert(folder("DirectHistory")),
            quarantine: context.extension.folderManager.convert(folder("DirectQuarantine")) };
        },
        failNextScan: async () => {
          await guard();
          context.extension.__failNextScan = true;
        },
        inject: async id => {
          await guard();
          const message = context.extension.messageManager.get(id);
          if (!message || message.folder.URI !== folder("DirectSource").URI) throw new Error("Synthetic folder only");
          // messageManager may return a CachedMsgHeader rather than nsIMsgDBHdr.
          const header = message.folder.msgDatabase.getMsgHdrForKey(message.messageKey);
          header.flags |= Ci.nsMsgMessageFlags.New;
          MailServices.mfn.notifyMsgAdded(header);
        },
        update: async () => {
          await guard();
          const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          file.initWithPath(PathUtils.join(profile, context.extension.manifest.version === "0.19.2" ? "real-first.xpi" : "real-next.xpi"));
          const install = await AddonManager.getInstallForFile(file);
          await install.install();
        },
        backup: async path => {
          await guard();
          if (PathUtils.parent(path) !== profile || !PathUtils.filename(path).startsWith("clam-mail-check-backup-")) throw new Error("Invalid test backup path");
          return IOUtils.readJSON(path);
        },
        runtime: async () => {
          await guard();
          const transport = context.extension.__testDirect;
          return { parent: Services.appinfo.processID, sessions: transport ? [...transport.sessions.values()].map(session => ({ pid: session.process.pid, directory: session.directory })) : [] };
        },
        finish: async action => {
          await guard();
          if (!["quit", "uninstall", "disable"].includes(action)) throw new Error("Invalid test lifecycle action");
          const marker = PathUtils.join(profile, "direct-action-ready");
          for (let attempt = 0; attempt < 600; attempt++) {
            if (await IOUtils.exists(marker)) {
              if (action === "quit") Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
              else if (action === "disable") await (await AddonManager.getAddonByID(context.extension.id)).disable();
              else await (await AddonManager.getAddonByID(context.extension.id)).uninstall();
              return;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          throw new Error("Lifecycle launcher did not acknowledge process snapshot");
        },
        idle: async () => {
          await guard();
          for (let attempt = 0; attempt < 300; attempt++) {
            const transport = context.extension.__testDirect;
            const opened = transport?.opened || [];
            if (!transport?.sessions.size && !(await Promise.all(opened.map(value => IOUtils.exists(value.directory)))).some(Boolean)) return opened;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          throw new Error("Completed/cancelled scan left a runtime directory");
        },
        report: async data => {
          await guard();
          const value = JSON.parse(data);
          await IOUtils.writeJSON(PathUtils.join(profile, (value.running ? "direct-progress-" : "direct-result-") + context.extension.manifest.version + ".json"), value);
        }
      } };
    }
  };
})();
