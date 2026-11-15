/** Display names are presentation only; IDs and paths still identify scan targets. */
export function folderLabel(folder, choices = [], accountId = folder?.accountId) {
  if (!folder) return "";
  const known = accountId && choices.find(choice => choice.accountId === accountId && choice.path === folder.path);
  const names = known?.displayNames || folder.displayNames;
  if (Array.isArray(names) && names.length && names.every(name => typeof name === "string" && name.length)) {
    return names.join(" › ");
  }
  return known?.name || folder.name || folder.path || "";
}
