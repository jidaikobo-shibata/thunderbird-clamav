// Foreground operations interrupt only on failure; background refresh never does.
export function operationFeedback({ document, t }) {
  const $ = id => document.getElementById(id);
  const dialog = $("message-dialog");
  let current, toastContext, queue = Promise.resolve();
  const panels = new Map();
  for (const panel of document.querySelectorAll('[role="tabpanel"]')) {
    const host = document.createElement("div"); host.className = "operation-feedback";
    const error = host.appendChild(document.createElement("div")); error.className = "operation-error"; error.hidden = true;
    const heading = error.appendChild(document.createElement("strong")); heading.textContent = t("messagePrevious", "このタブで発生した問題");
    const detail = error.appendChild(document.createElement("p"));
    const button = error.appendChild(document.createElement("button")); button.type = "button";
    button.textContent = t("messageDetails", "メッセージを確認");
    const dismiss = error.appendChild(document.createElement("button")); dismiss.type = "button";
    dismiss.textContent = t("messageClear", "この案内を消す");
    dismiss.addEventListener("click", () => { error.hidden = true; panel.focus(); });
    panel.querySelector("h2").after(host);
    panels.set(panel, { error, detail, button });
  }
  function capture(origin = document.activeElement) {
    const source = origin?.closest('[role="tabpanel"]');
    const panel = source && !source.hidden ? source : [...panels.keys()].find(panel => !panel.hidden);
    const label = source === panel && origin?.matches("button") ? origin.textContent.trim() : "";
    return { panel, origin, label };
  }
  function status(message, context = current) {
    toastContext = context;
    $("action-status").textContent = message;
    $("operation-toast").hidden = !message;
    protectFocus();
  }
  function restore(context) {
    const target = context?.origin;
    if (target?.isConnected && !target.disabled && !target.closest("[hidden]")) target.focus();
    else if (context?.panel?.isConnected && !context.panel.hidden) context.panel.focus();
  }
  function open(item) {
    const show = async () => {
      $("message-title").textContent = item.title;
      $("message-operation").textContent = item.context?.label || "";
      $("message-operation").hidden = !item.context?.label;
      $("message-detail").textContent = item.detail;
      $("message-guidance").textContent = item.guidance;
      dialog.returnValue = "close";
      await new Promise(resolve => {
        dialog.addEventListener("close", resolve, { once: true });
        dialog.showModal(); $("message-close").focus();
      });
      // The action wrapper restores focus after it releases its operation lock.
      restore(item.context);
    };
    const pending = queue.then(show);
    queue = pending.catch(() => {});
    return pending;
  }
  function error(error, context = current, { modal = true, warning = false } = {}) {
    const item = {
      context, detail: error?.message || String(error),
      title: warning ? t("messageWarning", "操作結果を確認してください") : t("messageError", "操作を完了できませんでした"),
      guidance: error?.guidance || t("messageGuidance", "表示内容を確認し、必要に応じて設定や検査結果を確認してから、もう一度お試しください。")
    };
    const local = panels.get(context?.panel);
    if (local) {
      local.detail.textContent = [item.title, context?.label, item.detail, item.guidance].filter(Boolean).join("\n");
      local.error.hidden = false;
      local.button.onclick = () => { void open({ ...item, context: { ...context, origin: local.button } }); };
    }
    // Errors belong to the dialog and its persistent tab entry, not a second
    // floating copy. Keep a single live announcement for ordinary status.
    status("", context);
    return modal ? open(item) : Promise.resolve();
  }
  // Keep the sole status visible without covering keyboard focus.
  // Prefer the bottom edge and move above only when needed.
  function protectFocus() {
    const toast = $("operation-toast"), target = document.activeElement;
    if (toast.hidden || toast.contains(target) || document.querySelector("dialog[open]")) return;
    if (!target?.matches("button,input,select,textarea,a[href],summary")) return;
    toast.classList.remove("operation-toast-top");
    const control = target.getBoundingClientRect(), notice = toast.getBoundingClientRect();
    if (control.top < notice.bottom && control.bottom > notice.top &&
        control.left < notice.right && control.right > notice.left) toast.classList.add("operation-toast-top");
  }
  document.addEventListener("focusin", protectFocus);
  document.addEventListener("scroll", protectFocus, true);
  document.defaultView.addEventListener("resize", protectFocus);
  $("message-dismiss").addEventListener("click", () => {
    $("operation-toast").hidden = true;
    restore(toastContext || current);
  });
  return { capture, status, error, restore, begin(context) { current = context; status(t("mail104", "処理しています。"), context); } };
}
