import { t } from "./i18n.mjs";

export async function findAttention(records, request, folderName) {
  const element = id => document.getElementById(id);
  const dialog = element("find-attention-dialog"), groups = element("find-groups");
  const scanButton = element("find-unique"), closeButton = element("find-close");
  const progress = element("find-progress"), bar = element("find-bar");
  const entries = records.map(record => ({record}));
  const labels = {
    verified: t("findVerified", "元のメールを特定"),
    single: t("findSingle", "候補が1通"),
    multiple: t("findMultiple", "候補が複数"),
    missing: t("findMissing", "候補なし"),
    linked: t("findLinked", "候補の検査履歴あり"),
    error: t("findFailed", "処理できなかった履歴")
  };
  let chosen = {};
  groups.replaceChildren();
  scanButton.hidden = true;
  dialog.showModal();
  closeButton.focus();

  async function process(items, operation) {
    groups.replaceChildren();
    scanButton.hidden = true;
    closeButton.textContent = t("findStop", "中止して閉じる");
    bar.hidden = false;
    bar.max = items.length;
    for (const [index, entry] of items.entries()) {
      if (!dialog.open) break;
      bar.value = index;
      progress.textContent = t("findProgress", "処理中：$1 / $2件", [index + 1, items.length]);
      try { await Promise.race([operation(entry), closed]); }
      catch (error) { entry.group = "error"; entry.detail = error.message; }
    }
    bar.hidden = true;
    closeButton.textContent = t("locateFinish", "閉じる");
  }

  async function search(entry) {
    const result = await request("locateHistory", {key:entry.record.key, bulk:true});
    if (result.verified || result.candidateKey) {
      entry.group = result.verified ? "verified" : "linked";
      entry.detail = folderName(result.folder);
      entry.candidateKey = result.candidateKey;
      return;
    }
    const candidates = result.candidates;
    entry.group = candidates.length === 1 ? "single" : candidates.length ? "multiple" : "missing";
    entry.detail = candidates.map(candidate => folderName(candidate.folder)).join(t("listSeparator", " ／ "));
    if (candidates.length === 1) {
      entry.candidate = candidates[0];
      entry.session = result.session;
    }
  }

  function render() {
    progress.textContent = t("findSummary", "検索対象：$1件。各グループから元の履歴をまとめて選択できます。", [records.length]);
    for (const [group, label] of Object.entries(labels)) {
      const items = entries.filter(entry => entry.group === group);
      if (!items.length) continue;
      const section = groups.appendChild(document.createElement("details"));
      section.appendChild(document.createElement("summary")).textContent = t("findGroup", "$1（$2件）", [label, items.length]);
      const list = section.appendChild(document.createElement("ul"));
      list.className = "dialog-targets";
      for (const {record, detail} of items) {
        list.appendChild(document.createElement("li")).textContent =
          [record.locator.subject || t("mail022", "件名なし"), detail].filter(Boolean).join(t("listSeparator", " ／ "));
      }
      if (group === "linked") {
        section.open = true;
        const show = section.appendChild(document.createElement("button"));
        show.type = "button";
        show.textContent = t("findShowResults", "候補の検査結果だけを表示");
        show.onclick = () => { chosen = {candidates:items.map(item => item.candidateKey)}; dialog.close(); };
      }
      const select = section.appendChild(document.createElement("button"));
      select.type = "button";
      select.textContent = t("findSelect", "このグループの元の履歴を選択（$1件）", [items.length]);
      select.onclick = () => { chosen = {originals:items.map(item => item.record.key)}; dialog.close(); };
      section.append(list);
    }
  }

  const closed = new Promise(resolve => dialog.addEventListener("close", resolve, {once:true}));
  try {
    await process(entries, search);
    if (!dialog.open) return {};
    render();
    const singles = entries.filter(entry => entry.group === "single");
    if (singles.length) {
      scanButton.hidden = false;
      scanButton.textContent = t("findScan", "1通に絞れた候補をまとめて別途検査（$1件）", [singles.length]);
      const scan = new Promise(resolve => { scanButton.onclick = () => resolve(true); });
      if (await Promise.race([scan, closed.then(() => false)]) && dialog.open) {
        await process(singles, async entry => {
          const result = await request("scanHistoryCandidate", {key:entry.record.key, position:entry.candidate.position,
            session:entry.session, messageId:entry.candidate.id, bulk:true, previousKey:entry.record.candidateScanKey || null});
          entry.group = "linked";
          entry.candidateKey = result.candidateKey;
        });
        if (dialog.open) { render(); closeButton.focus(); }
      }
    }
    await closed;
    return chosen;
  } finally {
    scanButton.onclick = null;
    if (dialog.open) dialog.close();
  }
}
