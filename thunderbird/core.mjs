import { directRuntime, directPort } from "./direct-transport.mjs";
import { scanPolicy } from "./scan-policy.mjs";
import { isReviewed } from "./review.mjs";
import { t, uiLanguage, localizeDetail } from "./i18n.mjs";
export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;
export const CHUNK_BYTES = 64 * 1024;
export const HOST = "local.clam_mail_check";
export const DEFAULTS = Object.freeze({
  enabled: false, accountIds: [], notifications: true
});
/** Preserve legacy OFF as an empty selection; never infer opt-in from saved IDs. */
export function normalizeAutomaticSettings(value = {}) {
  const settings = { ...DEFAULTS, ...value };
  const ids = Array.isArray(settings.accountIds) ? [...new Set(settings.accountIds.filter(id => typeof id === "string"))] : [];
  const accountIds = settings.enabled === true ? ids : [];
  return { enabled: accountIds.length > 0, notifications: settings.notifications, accountIds,
    ...(value.quarantine ? { quarantine: structuredClone(value.quarantine) } : {}),
    ...(value.scanSettings ? { scanSettings: scanPolicy(value.scanSettings) } : {}) };
}
export const LABELS = Object.freeze({
  queued: t("mail084", "検査待ち"), scanning: t("mail085", "検査中"), clean: t("mail086", "未検出"),
  detected: t("mail087", "脅威候補を検出"), incomplete: t("mail088", "一部または全部が未検査"), error: t("mail089", "検査失敗"),
  advisory: t("scanAdvisory", "注意情報"), deleted: t("mail090", "完全削除済み")
});
export const pausedAutomatic = (record, settings) => record.source === "automatic" && record.status === "queued" &&
  (!settings.enabled || !settings.accountIds.includes(record.locator.accountId));
export const needsAttention = record => ["detected", "incomplete", "error", "advisory"].includes(record.status) && !isReviewed(record);

export function accountOf(message) {
  return message.folder?.accountId || "";
}

export function locator(message) {
  return {
    accountId: accountOf(message), folder: message.folder,
    headerMessageId: message.headerMessageId || "",
    author: message.author || "", subject: message.subject || "",
    date: message.date ? new Date(message.date).toISOString() : "",
    size: message.size || 0
  };
}

export function sameEnvelope(message, saved) {
  return accountOf(message) === saved.accountId &&
    (message.headerMessageId || "") === saved.headerMessageId &&
    (message.author || "") === saved.author &&
    (message.subject || "") === saved.subject &&
    (message.date ? new Date(message.date).toISOString() : "") === saved.date;
}

export function validateSettings(value, knownIds) {
  if (!value || typeof value.enabled !== "boolean" ||
      typeof value.notifications !== "boolean" || !Array.isArray(value.accountIds) ||
      value.accountIds.some(id => typeof id !== "string" || !knownIds.includes(id))) {
    throw new Error(t("mail091", "設定値が不正です。画面を開き直してください。"));
  }
  if (value.enabled && !value.accountIds.length) {
    throw new Error(t("mail092", "自動検査するアカウントを選択してください。"));
  }
  if (value.scanSettings !== undefined) scanPolicy(value.scanSettings);
  return normalizeAutomaticSettings(value);
}

export function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function* messagePages(api, first) {
  let page = first;
  let complete = false;
  try {
    while (page) {
      for (const message of page.messages) yield message;
      if (!page.id) { complete = true; break; }
      page = await api.continueList(page.id);
    }
  } finally {
    if (!complete && page?.id && api.abortList) {
      try { await api.abortList(page.id); } catch { /* Already finalized. */ }
    }
  }
}

export class NativeClient {
  constructor(runtime) {
    this.direct = directRuntime(runtime);
    this.port = this.direct ? directPort(globalThis.messenger.clamDirect) : runtime.connectNative(HOST);
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.port.onMessage.addListener(message => {
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.detailMessages) message.detail = localizeDetail(message);
      request.resolve(message);
    });
    this.port.onDisconnect.addListener(() => this.close(
      this.direct ? t("directDisconnected", "内蔵の検査処理との接続が切れました。設定で状態を確認してください。") + (this.port.error?.message ? " " + String(this.port.error.message).slice(0, 300) : "") : t("mail093", "補助プログラムとの接続が切れました。登録状態を確認してください。")
    ));
  }

  request(op, values = {}, timeout = 15000) {
    // The first direct request includes fixed-path executable verification.
    // RPC deadlines in the privileged bridge remain bounded independently.
    if (this.direct && timeout === 15000) timeout = 45000;
    if (this.closed) return Promise.reject(new Error(this.direct ? t("directUnavailable", "内蔵の検査処理を開始できません。設定で状態を確認してください。") : t("mail094", "補助プログラムに接続できません。")));
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(this.direct ? t("directUnavailable", "内蔵の検査処理を開始できません。設定で状態を確認してください。") : t("mail095", "補助プログラムの応答がありません。")), timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.port.postMessage({ ...values, language: uiLanguage(), op, id }); }
      catch { this.close(t("mail096", "補助プログラムに送信できません。")); }
    });
  }

  close(reason = t("mail097", "接続を終了しました。")) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    this.pending.clear();
    this.port.disconnect();
  }

  async scan(bytes, digest, options) {
    let result = await this.request("begin", { size: bytes.length, ...(options ? { scanSettings: options } : {}) });
    if (result.status !== "accepted") throw new Error(result.detail || t("mail098", "検査を開始できません。"));
    let seq = 0;
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      result = await this.request("chunk", {
        seq, data: bytesToBase64(bytes.subarray(offset, offset + CHUNK_BYTES))
      });
      seq++;
      if (result.status !== "accepted" || result.seq !== seq) {
        throw new Error(result.detail || t("mail099", "メールの転送に失敗しました。"));
      }
    }
    result = await this.request("end", { sha256: digest }, this.direct ? 360000 : 225000);
    if (!["clean", "detected", "incomplete", "error", "advisory"].includes(result.status)) {
      throw new Error(t("mail100", "補助プログラムの結果を解釈できません。"));
    }
    if (result.status !== "error" && result.sha256 !== digest) {
      throw new Error(t("mail101", "検査対象の照合に失敗しました。"));
    }
    if (options && JSON.stringify(result.scanSettings) !== JSON.stringify(options)) throw new Error(this.direct ? t("directPolicyMismatch", "指定した検査条件の適用を確認できません。拡張を更新して再検査してください。") : t("scanPolicyMismatch", "指定した検査条件の適用を確認できません。補助プログラムを更新して再検査してください。"));
    return result;
  }
}
