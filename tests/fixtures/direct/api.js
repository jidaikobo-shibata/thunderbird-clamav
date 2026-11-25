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

      let pausedMain;
      return { testFixture: {
        prepare: async () => {
          await guard();
          try { server(); } catch { MailServices.accounts.createLocalMailAccount(); }
          const root = server().rootFolder;
          for (const name of ["DirectSource", "DirectHistory", "DirectQuarantine", "DirectDrafts"]) {
            if (!root.containsChildNamed(name)) root.createSubfolder(name, null);
          }
          folder("DirectDrafts").setFlag(Ci.nsMsgFolderFlags.Drafts);
          await new Promise(resolve => setTimeout(resolve, 100));
          return { drafts: context.extension.folderManager.convert(folder("DirectDrafts")), mails: await rawMessages(), accountId: [...MailServices.accounts.accounts].find(account => account.incomingServer.key === server().key).key,
            source: context.extension.folderManager.convert(folder("DirectSource")),
            history: context.extension.folderManager.convert(folder("DirectHistory")),
            quarantine: context.extension.folderManager.convert(folder("DirectQuarantine")) };
        },
        inject: async id => {
          await guard();
          const message = context.extension.messageManager.get(id);
          if (!message || ![folder("DirectSource").URI, folder("DirectHistory").URI, folder("DirectDrafts").URI].includes(message.folder.URI)) throw new Error("Synthetic folder only");
          // messageManager may return a CachedMsgHeader rather than nsIMsgDBHdr.
          const header = message.folder.GetMessageHeader(message.messageKey);
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
        coverMain: async (pauseFallback = false) => {
          await guard();
          const main = Services.wm.getMostRecentWindow("mail:3pane");
          const account = [...MailServices.accounts.accounts].find(value => value.incomingServer.key === server().key);
          const identity = MailServices.accounts.createIdentity();
          identity.email = "synthetic@example.invalid"; account.addIdentity(identity);
          const params = Cc["@mozilla.org/messengercompose/composeparams;1"].createInstance(Ci.nsIMsgComposeParams);
          params.type = Ci.nsIMsgCompType.New; params.format = Ci.nsIMsgCompFormat.PlainText; params.identity = identity;
          params.composeFields = Cc["@mozilla.org/messengercompose/composefields;1"].createInstance(Ci.nsIMsgCompFields);
          MailServices.compose.OpenComposeWindowWithParams(null, params);
          let compose;
          for (let attempt = 0; attempt < 100; attempt++) {
            compose = Services.wm.getMostRecentWindow("msgcompose");
            if (compose?.document.getElementById("messageEditor") && compose.GetCurrentEditor?.()) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!compose?.GetCurrentEditor?.()) throw new Error("Synthetic compose window not ready");
          // The full dashboard test may have additional mail windows. Hide
          // their native widgets, keeping the synthetic compose window visible.
          for (const window of Services.wm.getEnumerator("mail:3pane")) {
            const app = window.docShell.treeOwner.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIAppWindow);
            app.QueryInterface(Ci.nsIBaseWindow).visibility = false;
          }
          compose.focus();
          let painted = true;
          for (let attempt = 0; attempt < 8 && painted; attempt++) {
            painted = false;
            const id = main.requestAnimationFrame(() => { painted = true; });
            await new Promise(resolve => setTimeout(resolve, 250));
            main.cancelAnimationFrame(id);
          }
          if (painted && pauseFallback) {
            // Some compositors paint hidden widgets. For the toolbar regression
            // exercise the stalled refresh driver explicitly in this fixture.
            pausedMain = main.windowUtils;
            pausedMain.advanceTimeAndRefresh(0);
            painted = false;
            main.requestAnimationFrame(() => { painted = true; });
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          return { composeURL: compose.document.documentURI, mainFramePending: !painted, controlledRefresh: Boolean(pausedMain) };
        },
        restoreFrames: async () => {
          await guard();
          pausedMain?.restoreNormalRefresh();
          pausedMain = null;
        },
        composeFrames: async () => {
          await guard();
          const compose = Services.wm.getMostRecentWindow("msgcompose");
          if (!compose?.GetCurrentEditor?.()) throw new Error("Synthetic compose is unavailable");
          const intervals = [];
          return new Promise(resolve => {
            let previous = compose.performance.now(), active = true;
            const frame = now => {
              if (!active) return;
              intervals.push(now - previous);
              previous = now;
              compose.requestAnimationFrame(frame);
            };
            compose.requestAnimationFrame(frame);
            compose.setTimeout(() => {
              active = false;
              intervals.sort((a,b) => a-b);
              resolve({ frames:intervals.length, p95Ms:intervals[Math.floor(intervals.length * 0.95)],
                longestMs:intervals.at(-1) });
            }, 1500);
          });
        },
        runtime: async () => {
          await guard();
          const transport = context.extension.__testDirect;
          return { parent: Services.appinfo.processID, openCount: transport?.opened.length || 0, sessions: transport ? [...transport.sessions.values()].map(session => ({ pid: session.process.pid, directory: session.directory })) : [] };
        },
        finish: async action => {
          await guard();
          if (!["quit", "uninstall"].includes(action)) throw new Error("Invalid test lifecycle action");
          const marker = PathUtils.join(profile, "direct-action-ready");
          for (let attempt = 0; attempt < 600; attempt++) {
            if (await IOUtils.exists(marker)) {
              if (action === "quit") Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
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
