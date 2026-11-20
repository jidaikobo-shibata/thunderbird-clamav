/** Rebuild on list refresh; keep entries live so display-name edits are visible. */
export function createFolderIndex(choices) {
  const accounts = new Map();
  for (const folder of choices) {
    const { accountId, path } = folder;
    if (!accounts.has(accountId)) accounts.set(accountId, new Map());
    const paths = accounts.get(accountId);
    // Preserve the first match, just like Array.find on the original list.
    if (!paths.has(path)) paths.set(path, folder);
  }
  return accounts;
}

/** Display names are presentation only; IDs and paths still identify scan targets. */
export function folderLabel(folder, choices = [], accountId = folder?.accountId) {
  if (!folder) return "";
  const known = accountId && (choices instanceof Map ? choices.get(accountId)?.get(folder.path) :
    choices.find(choice => choice.accountId === accountId && choice.path === folder.path));
  const names = known?.displayNames || folder.displayNames;
  if (Array.isArray(names) && names.length && names.every(name => typeof name === "string" && name.length)) {
    return names.join(" › ");
  }
  return known?.name || folder.name || folder.path || "";
}
