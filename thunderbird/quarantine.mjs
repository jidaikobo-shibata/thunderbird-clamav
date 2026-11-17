import { t } from "./i18n.mjs";
import { realFolder } from "./folder-scan.mjs";
import { locator, sameEnvelope, messagePages, sha256 } from "./core.mjs";

export function quarantineFolder(folder) {
  return realFolder(folder) && typeof folder.id === "string" &&
    (folder.specialUse || []).length === 0;
}
export function canQuarantine(record) { return record?.status === "detected" && Boolean(record.sha256); }
export async function inQuarantine(message, settings, records = [], { session, digestOf } = {}) {
  // A quarantine destination must never exclude an entire folder. Suppress only a
  // known detected message, identified by its current session ID or contents.
  const candidates = records.filter(record => record.status === "detected" && record.sha256 &&
    ["moving", "moved", "error"].includes(record.quarantine?.status) &&
    record.quarantine.destination?.accountId === message.folder?.accountId &&
    record.quarantine.destination?.path === message.folder?.path && sameEnvelope(message, record.locator));
  if (session && candidates.some(record => record.session === session && record.messageId === message.id)) return true;
  if (!candidates.length || !digestOf) return false;
  try {
    const digest = await digestOf(message);
    return candidates.some(record => record.sha256 === digest);
  } catch { return false; } // Let normal scanning report/retry unreadable mail.
}
export function quarantineNeedsPermission(previous = {}, next = {}) {
  return Object.entries(next).some(([accountId, config]) => config.auto &&
    !(previous[accountId]?.auto && previous[accountId].folderId === config.folderId && previous[accountId].path === config.path));
}
export function refreshQuarantineLocation(record, message) {
  record.messageId = message.id;
  record.locator = locator(message);
  const info = record.quarantine;
  if (!info || !["moved", "outside"].includes(info.status)) return;
  const inside = info.destination?.accountId === message.folder?.accountId && info.destination?.path === message.folder?.path;
  info.status = inside ? "moved" : "outside";
}
export async function validateQuarantine(api, value, knownIds, previous = {}) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 100) throw new Error(t("qInvalid", "隔離先の設定が不正です。"));
  const result = {};
  for (const [accountId, config] of Object.entries(value)) {
    if (!knownIds.includes(accountId) || !config || typeof config.folderId !== "string" || typeof config.path !== "string" || typeof config.auto !== "boolean") throw new Error(t("qInvalid", "隔離先の設定が不正です。"));
    // Validate new opt-ins/targets; unchanged settings must not block stopping
    // scanning, disabling quarantine or changing unrelated preferences.
    if (quarantineNeedsPermission(previous, { [accountId]: config })) {
      await destinationFolder(api, accountId, config);
      if (!await api.permissions.contains({ permissions: ["messagesMove"] })) throw new Error(t("qPermission", "隔離にはメール移動の権限が必要です。"));
    }
    result[accountId] = { folderId: config.folderId, path: config.path, auto: config.auto };
  }
  return result;
}
export async function destinationFolder(api, accountId, config) {
  let folder;
  try { folder = await api.folders.get(config.folderId, false); } catch { /* Report a stable translated error below. */ }
  if (!quarantineFolder(folder) || folder.accountId !== accountId || folder.path !== config.path) throw new Error(t("qTargetMissing", "隔離先を確認できません。設定で同じアカウント内の専用フォルダーを選び直してください。"));
  const capabilities = await api.folders.getFolderCapabilities(folder.id);
  if (capabilities.canAddMessages !== true) throw new Error(t("qTargetReadOnly", "隔離先にメールを追加できません。別のフォルダーを選んでください。"));
  return folder;
}

/** No copy/delete fallback. Scan verdict is never replaced by a move failure. */
export async function moveToQuarantine(api, record, config, { verified, rawBytes, save, session, automatic = false }) {
  if (!canQuarantine(record)) throw new Error(t("qDetectedOnly", "隔離できるのは脅威を検出したメールだけです。"));
  if (!await api.permissions.contains({ permissions: ["messagesMove"] })) throw new Error(t("qPermission", "隔離にはメール移動の権限が必要です。"));
  if (!config) throw new Error(t("qTargetMissing", "隔離先を確認できません。設定で同じアカウント内の専用フォルダーを選び直してください。"));
  const target = await destinationFolder(api, record.locator.accountId, config);
  const { message } = await verified(record);
  const prior = record.quarantine;
  if (message.folder.id === target.id) {
    record.quarantine = { status: "moved", destination: target, updatedAt: new Date().toISOString() };
    await save(); return;
  }
  const source = await api.folders.get(message.folder.id, false);
  const capabilities = await api.folders.getFolderCapabilities(source.id);
  if (capabilities.canDeleteMessages !== true) throw new Error(t("qSourceReadOnly", "元のフォルダーからメールを移動できません。隔離は行っていません。"));
  if (!message.headerMessageId) throw new Error(t("qIdentityMissing", "メールの識別情報がないため、安全に隔離を確認できません。Thunderbirdで移動してください。"));
  record.quarantine = { status: "moving", destination: target, source: message.folder, updatedAt: new Date().toISOString() };
  try { await save(); } catch (error) { record.quarantine = prior; throw error; }
  const current = await api.messages.get(message.id);
  if (current.folder?.id !== source.id || !sameEnvelope(current, record.locator) || !canQuarantine(record)) throw new Error(t("qChanged", "対象または隔離先が変わりました。もう一度確認してください。"));
  await api.messages.move([message.id], target.id, { isUserAction: !automatic });
  const matches = [];
  let candidates = 0;
  const first = await api.messages.query({ folderId: target.id, headerMessageId: message.headerMessageId });
  for await (const candidate of messagePages(api.messages, first)) {
    if (candidate.folder?.id !== target.id || !sameEnvelope(candidate, record.locator)) continue;
    if (++candidates > 20) throw new Error(t("qMoveUnconfirmed", "隔離の完了を確認できません。元のフォルダーと隔離先をThunderbirdで確認してください。自動で再移動はしません。"));
    if (await sha256(await rawBytes(candidate.id)) === record.sha256) matches.push(candidate);
    if (matches.length > 1) break;
  }
  // get() can also fail for transient reasons; confirm absence in the source folder.
  const sourcePage = await api.messages.query({ folderId: source.id, headerMessageId: message.headerMessageId });
  let sourceRemains = false;
  for await (const candidate of messagePages(api.messages, sourcePage)) {
    if (candidate.folder?.id === source.id && sameEnvelope(candidate, record.locator)) { sourceRemains = true; break; }
  }
  let old;
  try { old = await api.messages.get(message.id); } catch { /* Source ID normally disappears after a move. */ }
  if (matches.length !== 1 || sourceRemains || old?.folder?.id === source.id) throw new Error(t("qMoveUnconfirmed", "隔離の完了を確認できません。元のフォルダーと隔離先をThunderbirdで確認してください。自動で再移動はしません。"));
  record.messageId = matches[0].id; record.session = session; record.locator = locator(matches[0]);
  record.quarantine = { status: "moved", destination: target, source: source, updatedAt: new Date().toISOString() };
  await save();
}
