import { messagePages } from "./core.mjs";

export const FOLDER_STATES = Object.freeze({
  collecting: "対象メールを確認中", running: "検査中", stopping: "中止しています",
  completed: "完了", stopped: "中止", interrupted: "中断", blocked: "停止", error: "失敗"
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

/** Runtime targets are never persisted: Thunderbird IDs are session-scoped. */
export class FolderScan {
  constructor(api, { changed = async () => {}, wake = () => {}, finished = async () => {},
    pause = () => new Promise(resolve => setTimeout(resolve, 0)), maxTargets = 100000 } = {}) {
    Object.assign(this, { api, changed, wake, finished, pause, maxTargets });
    this.job = null;
    this.targets = [];
    this.cursor = 0;
  }
  get active() { return ACTIVE.includes(this.job?.status); }
  snapshot() { return this.job ? structuredClone(this.job) : null; }
  restore(saved) {
    this.targets = [];
    this.cursor = 0;
    this.job = saved || null;
    if (this.active) {
      this.job.status = "interrupted";
      this.job.scanning = 0;
      this.job.detail = "Thunderbirdの終了または拡張の更新で中断しました。再検査する場合は改めて開始してください。";
      this.job.finishedAt = new Date().toISOString();
    }
  }
  async start(folder, includeSubfolders) {
    if (this.active) throw new Error("フォルダー検査は既に実行中です。");
    if (!realFolder(folder) || typeof includeSubfolders !== "boolean") {
      throw new Error("通常のメールフォルダーを1つ選択してください。統合・検索・タグの仮想フォルダーは対象外です。");
    }
    this.targets = [];
    this.cursor = 0;
    this.job = { id: crypto.randomUUID(), folder: { id: folder.id, accountId: folder.accountId,
      path: folder.path, name: folder.name || folder.path }, includeSubfolders,
      status: "collecting", startedAt: new Date().toISOString(), finishedAt: null,
      total: null, discovered: 0, completed: 0, scanning: 0, ignored: 0, skippedFolders: 0,
      counts: { clean: 0, detected: 0, incomplete: 0, error: 0 }, detail: "対象メールを確認しています。" };
    try { await this.changed(); }
    catch (error) {
      this.job.status = "error";
      this.job.detail = "検査の開始状態を保存できませんでした。";
      this.job.finishedAt = new Date().toISOString();
      throw error;
    }
    const job = this.job;
    this.collecting = this.collect(folder).catch(error => this.job === job ? this.finish("error", error.message || "対象一覧の取得に失敗しました。") : undefined);
    return this.snapshot();
  }
  async collect(root) {
    const folders = [root], seenFolders = new Set(), seenMessages = new Set();
    while (folders.length) {
      if (this.job.status === "stopping") return this.finish("stopped", "対象一覧の取得中に中止しました。");
      const folder = folders.shift(), identity = keyOf(folder);
      if (seenFolders.has(identity)) continue;
      seenFolders.add(identity);
      if (seenFolders.size > 5000) return this.finish("blocked", "対象フォルダーが多いため停止しました。範囲を分けてください。");
      if (!realFolder(folder) || folder.accountId !== root.accountId) { this.job.skippedFolders++; continue; }
      const first = await this.api.messages.list(ref(folder));
      for await (const message of messagePages(this.api.messages, first)) {
        if (this.job.status === "stopping") return this.finish("stopped", "対象一覧の取得中に中止しました。");
        if (message.external || !message.folder || keyOf(message.folder) !== identity || seenMessages.has(message.id)) {
          this.job.ignored++; continue;
        }
        if (this.targets.length >= this.maxTargets) {
          return this.finish("blocked", "対象メール数の上限に達しました。フォルダーを分けて検査してください。");
        }
        seenMessages.add(message.id);
        this.targets.push(targetOf(message));
        this.job.discovered = this.targets.length;
        if (this.targets.length % 100 === 0) { await this.changed(); await this.pause(); }
      }
      if (this.job.includeSubfolders && this.job.status !== "stopping") {
        folders.push(...await this.api.folders.getSubFolders(ref(folder), false));
      }
    }
    if (this.job.status === "stopping") return this.finish("stopped", "対象一覧の取得中に中止しました。");
    this.job.total = this.targets.length;
    if (!this.targets.length) return this.finish("completed", "対象メールはありませんでした。");
    this.job.status = "running";
    this.job.detail = "新着・手動検査を優先しながら1通ずつ検査します。";
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
  async complete(status) {
    if (!this.job?.scanning || !Object.hasOwn(this.job.counts, status)) throw new Error("フォルダー検査の結果状態が不正です。");
    this.job.scanning = 0;
    this.job.completed++;
    this.job.counts[status]++;
    if (this.job.status === "stopping") return this.finish("stopped", "実行中の1通を終えて中止しました。");
    if (this.job.completed === this.job.total) return this.finish("completed", "対象メールの処理が完了しました。未検査・失敗の内訳も確認してください。");
  }
  async stop() {
    if (!this.active || this.job.status === "stopping") return;
    const collecting = this.job.status === "collecting";
    this.job.status = "stopping";
    this.job.detail = "実行中の処理を終えて中止します。";
    if (!collecting && !this.job.scanning) return this.finish("stopped", "検査待ちのメールを残して中止しました。");
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
