import { t } from "./i18n.mjs";
import { messagePages, locator, sha256 } from "./core.mjs";

export const FOLDER_STATES = Object.freeze({
  collecting: t("mail174", "対象メールを確認中"), running: t("mail085", "検査中"), stopping: t("mail175", "中止しています"),
  completed: t("mail176", "完了"), stopped: t("mail177", "中止"), interrupted: t("mail178", "中断"), blocked: t("mail179", "停止"), error: t("mail180", "失敗")
});
const ACTIVE = ["collecting", "running", "stopping"];
const keyOf = folder => JSON.stringify([folder.accountId, folder.path]);
const ref = folder => folder.id || folder;
export function realFolder(folder) {
  return Boolean(folder?.accountId && typeof folder.path === "string" && folder.path.length > 0 && folder.path !== "/" &&
    !folder.isRoot && !folder.isVirtual && !folder.isUnified && !folder.isTag);
}
function targetOf(message) {
  return { id: message.id, author: message.author, subject: message.subject, date: message.date,
    headerMessageId: message.headerMessageId, folder: { id: message.folder.id,
      accountId: message.folder.accountId, path: message.folder.path, name: message.folder.name },
    headersOnly: message.headersOnly, size: message.size, external: message.external };
}

export function checkpointHint(saved) {
  return sha256(new TextEncoder().encode(JSON.stringify([
    saved.accountId, saved.folder?.path, saved.headerMessageId || "",
    saved.author || "", saved.subject || "", saved.date || ""
  ])));
}
const CHECKPOINT_VERSION = 1;
const RESUMABLE = ["stopped", "interrupted", "blocked", "error"];

/** Runtime targets are never persisted: Thunderbird IDs are session-scoped. */
export class FolderScan {
  constructor(api, { changed = async () => {}, wake = () => {}, finished = async () => {},
    digestOf = async () => null,
    pause = () => new Promise(resolve => setTimeout(resolve, 0)), maxTargets = 100000 } = {}) {
    Object.assign(this, { api, changed, wake, finished, pause, maxTargets, digestOf });
    this.job = null;
    this.targets = [];
    this.cursor = 0;
    this.checkpoints = new Map();
  }
  get resumable() { return Boolean(this.job && RESUMABLE.includes(this.job.status)); }
  checkpointState() {
    return this.job ? { version: CHECKPOINT_VERSION, id: this.job.id,
      entries: [...this.checkpoints].map(([key, count]) => [key, count]) } : null;
  }
  remember(hint, digest, count = 1) {
    if (!/^[a-f0-9]{64}$/.test(hint) || !/^[a-f0-9]{64}$/.test(digest)) return;
    const key = hint + ":" + digest;
    if (!this.checkpoints.has(key) && this.checkpoints.size >= this.maxTargets) return;
    this.checkpoints.set(key, Math.min(this.maxTargets, (this.checkpoints.get(key) || 0) + count));
  }
  get active() { return Boolean(this.removing) || ACTIVE.includes(this.job?.status); }
  snapshot() { return this.job ? structuredClone(this.job) : null; }
  restore(saved, checkpoint) {
    this.checkpoints.clear();
    if (checkpoint?.version === CHECKPOINT_VERSION && checkpoint.id === saved?.id &&
        Array.isArray(checkpoint.entries) && checkpoint.entries.length <= this.maxTargets) {
      for (const entry of checkpoint.entries) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && /^[a-f0-9]{64}:[a-f0-9]{64}$/.test(entry[0]) &&
            Number.isSafeInteger(entry[1]) && entry[1] > 0 && entry[1] <= this.maxTargets) {
          this.checkpoints.set(entry[0], entry[1]);
        }
      }
    }
    this.targets = [];
    this.cursor = 0;
    this.job = saved || null;
    if (this.active) {
      this.job.status = "interrupted";
      this.job.scanning = 0;
      this.job.detail = t("mail181", "Thunderbirdの終了または拡張の更新で中断しました。「再開」すると処理済みメールを照合して続行できます。");
      this.job.finishedAt = new Date().toISOString();
    }
  }
  async start(folder, includeSubfolders) {
    if (this.active) throw new Error(t("mail006", "フォルダー検査は既に実行中です。"));
    const roots = Array.isArray(folder) ? folder : [folder];
    if (!roots.length || roots.length > 5000 || roots.some(root => !realFolder(root) || root.accountId !== roots[0].accountId) || new Set(roots.map(keyOf)).size !== roots.length || typeof includeSubfolders !== "boolean") {
      throw new Error(t("foldersInvalid", "同じアカウントの通常のメールフォルダーを選択してください。"));
    }
    this.targets = [];
    this.cursor = 0;
    this.checkpoints.clear();
    folder = roots[0];
    const savedRoots = roots.map(root => ({ id: root.id, accountId: root.accountId, path: root.path, name: root.name || root.path, displayNames: root.displayNames }));
    this.job = { id: crypto.randomUUID(), folders: savedRoots, folder: { id: folder.id, accountId: folder.accountId,
      path: folder.path, name: folder.name || folder.path, displayNames: folder.displayNames }, includeSubfolders,
      status: "collecting", startedAt: new Date().toISOString(), finishedAt: null,
      total: null, discovered: 0, completed: 0, scanning: 0, ignored: 0, skippedFolders: 0,
      counts: { clean: 0, detected: 0, incomplete: 0, error: 0 }, detail: t("mail182", "対象メールを確認しています。") };
    try { await this.changed(); }
    catch (error) {
      this.job.status = "error";
      this.job.detail = t("mail183", "検査の開始状態を保存できませんでした。");
      this.job.finishedAt = new Date().toISOString();
      throw error;
    }
    this.launch(roots);
    return this.snapshot();
  }
  launch(folder, resume = false) {
    const job = this.job;
    this.collecting = this.collect(folder, resume).catch(error => this.job === job ? this.finish("error", error.message || t("mail184", "対象一覧の取得に失敗しました。")) : undefined);
  }
  async resume(folder) {
    if (!this.resumable || this.active) throw new Error(t("mail185", "このフォルダー検査は再開できません。"));
    const roots = Array.isArray(folder) ? folder : [folder], saved = this.job.folders || [this.job.folder];
    if (roots.length !== saved.length || roots.some((root, index) => !realFolder(root) || keyOf(root) !== keyOf(saved[index]))) throw new Error(t("mail072", "元のフォルダーが見つからないか、場所が変わりました。"));
    const previous = this.snapshot();
    this.targets = [];
    this.cursor = 0;
    Object.assign(this.job, { status: "collecting", scanning: 0, total: null, discovered: 0,
      ignored: 0, skippedFolders: 0, resumedMatched: 0, finishedAt: null,
      resumeCount: (this.job.resumeCount || 0) + 1,
      detail: t("mail186", "処理済みメールと照合しています。新着・変更されたメールも確認します。") });
    try { await this.changed(); }
    catch (error) { this.job = previous; throw error; }
    this.launch(roots, true);
    return this.snapshot();
  }
  async remove() {
    if (this.active) throw new Error(t("mail187", "実行中の検査は削除できません。先に中止してください。"));
    const previous = this.job, checkpoints = this.checkpoints;
    this.removing = true;
    this.job = null;
    this.checkpoints = new Map();
    this.targets = [];
    this.cursor = 0;
    try { await this.changed(); }
    catch (error) { this.job = previous; this.checkpoints = checkpoints; throw error; }
    finally { this.removing = false; }
  }
  async collect(root, resume = false) {
    const remaining = resume ? new Map(this.checkpoints) : new Map();
    const hints = new Set([...remaining.keys()].map(key => key.slice(0, 64)));
    const roots = Array.isArray(root) ? root : [root];
    const folders = [...roots], seenFolders = new Set(), seenMessages = new Set();
    while (folders.length) {
      if (this.job.status === "stopping") return this.finish("stopped", t("mail188", "対象一覧の取得中に中止しました。"));
      const folder = folders.shift(), identity = keyOf(folder);
      if (seenFolders.has(identity)) continue;
      seenFolders.add(identity);
      if (seenFolders.size > 5000) return this.finish("blocked", t("mail189", "対象フォルダーが多いため停止しました。範囲を分けてください。"));
      if (!realFolder(folder) || folder.accountId !== roots[0].accountId) { this.job.skippedFolders++; continue; }
      const first = await this.api.messages.list(ref(folder));
      for await (const message of messagePages(this.api.messages, first)) {
        if (this.job.status === "stopping") return this.finish("stopped", t("mail188", "対象一覧の取得中に中止しました。"));
        if (message.external || !message.folder || keyOf(message.folder) !== identity || seenMessages.has(message.id)) {
          this.job.ignored++; continue;
        }
        if (seenMessages.size >= this.maxTargets) {
          return this.finish("blocked", t("mail190", "対象メール数の上限に達しました。フォルダーを分けて検査してください。"));
        }
        seenMessages.add(message.id);
        this.job.discovered++;
        let matched = false;
        if (resume && hints.size) {
          const hint = await checkpointHint(locator(message));
          if (hints.has(hint)) {
            try {
              const digest = await this.digestOf(message);
              const key = hint + ":" + digest, count = remaining.get(key) || 0;
              if (count > 0) {
                remaining.set(key, count - 1);
                this.job.resumedMatched++;
                matched = true;
              }
            } catch { /* Unverifiable mail must be scanned, never silently skipped. */ }
          }
        }
        if (!matched) this.targets.push(targetOf(message));
        if (this.job.discovered % 100 === 0) { await this.changed(); await this.pause(); }
      }
      if (this.job.includeSubfolders && this.job.status !== "stopping") {
        folders.push(...await this.api.folders.getSubFolders(ref(folder), false));
      }
    }
    if (this.job.status === "stopping") return this.finish("stopped", t("mail188", "対象一覧の取得中に中止しました。"));
    this.job.total = this.job.completed + this.targets.length;
    if (!this.targets.length) return this.finish("completed", t("mail191", "未処理の対象メールはありませんでした。"));
    this.job.status = "running";
    this.job.detail = (resume ? t("mail192", "前回の処理済み$1件を照合しました。", [this.job.resumedMatched]) : "") +
      t("mail193", "新着・手動検査を優先しながら1通ずつ検査します。");
    await this.changed();
    this.wake();
  }
  available() { return this.job?.status === "running" && this.cursor < this.targets.length; }
  take() {
    if (!this.available() || this.job.scanning) return null;
    this.job.scanning = 1;
    const target = this.targets[this.cursor];
    this.targets[this.cursor++] = null;
    return target;
  }
  async complete(status, checkpoint) {
    if (status === "advisory" && this.job) this.job.counts.advisory ??= 0;
    if (!this.job?.scanning || !Object.hasOwn(this.job.counts, status)) throw new Error(t("mail194", "フォルダー検査の結果状態が不正です。"));
    if (checkpoint) this.remember(checkpoint.hint, checkpoint.digest);
    this.job.scanning = 0;
    this.job.completed++;
    this.job.counts[status]++;
    if (this.job.status === "stopping") return this.finish("stopped", t("mail195", "実行中の1通を終えて中止しました。"));
    if (this.job.completed === this.job.total) return this.finish("completed", t("mail196", "対象メールの処理が完了しました。未検査・失敗の内訳も確認してください。"));
  }
  async stop() {
    if (!this.active || this.job.status === "stopping") return;
    const collecting = this.job.status === "collecting";
    this.job.status = "stopping";
    this.job.detail = t("mail197", "実行中の処理を終えて中止します。");
    if (!collecting && !this.job.scanning) return this.finish("stopped", t("mail198", "検査待ちのメールを残して中止しました。"));
    await this.changed();
  }
  async finish(status, detail) {
    if (!this.job) return;
    this.job.status = status;
    this.job.detail = detail;
    this.job.scanning = 0;
    this.job.finishedAt = new Date().toISOString();
    this.targets = [];
    const summary = this.snapshot();
    await this.changed();
    await this.finished(summary);
  }
}
