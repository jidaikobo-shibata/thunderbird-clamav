/** Thunderbird supplies locale selection and English fallback via default_locale. */
export function uiLanguage() {
  const language = globalThis.messenger?.i18n?.getUILanguage?.() || "ja";
  return language.toLowerCase().startsWith("ja") ? "ja" : "en-US";
}

export function t(key, fallback, values = []) {
  const translated = globalThis.messenger?.i18n?.getMessage?.(key, values.map(String));
  if (translated) return translated;
  // Allows protocol/unit tests without a Thunderbird extension context.
  return fallback.replace(/\$(\d+)/g, (match, index) => String(values[Number(index) - 1] ?? match));
}

export function localizeDocument(root = document) {
  root.documentElement.lang = uiLanguage();
  for (const element of root.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n, element.textContent);
  }
  for (const attribute of ["aria-label", "placeholder", "title"]) {
    for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`), element.getAttribute(attribute)));
    }
  }
}

/** New native results carry message keys; legacy history keeps its original text. */
export function localizeDetail(value) {
  if (!Array.isArray(value?.detailMessages) || value.detailMessages.length > 32 ||
      !globalThis.messenger?.i18n?.getMessage) return value?.detail || "";
  if (!value.detailMessages.every(part => typeof part?.text === "string" &&
      (part.key === undefined || /^mail[0-9]{3}$/.test(part.key)))) return value.detail || "";
  return value.detailMessages.map(part => part.key ? t(part.key, part.text) : part.text).join("");
}
