import { t } from "./i18n.mjs";

document.documentElement.lang = globalThis.messenger.i18n.getUILanguage();
document.title = t("directAppTitle", "ClamAV メール検査");
// sessionStorage stays with this tab across navigation, so another dashboard
// or a toolbar click cannot consume the settings request.
sessionStorage.setItem("clam-open-settings", "1");
location.replace(messenger.runtime.getURL("dashboard.html"));
