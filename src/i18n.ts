/**
 * i18n.ts — ChatScribe
 *
 * Lightweight internationalization.
 * Strings live in src/locales/*.json.
 * The active locale is chosen from:
 *   1. The "language" setting (if not "auto")
 *   2. chrome.i18n.getUILanguage()
 *   3. navigator.language
 *   4. Fallback: "en"
 */

import en from "./locales/en.json";
import zh from "./locales/zh.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import de from "./locales/de.json";
import ru from "./locales/ru.json";

type LocaleBundle = Record<string, string>;
type SupportedLocale = "en" | "zh" | "es" | "fr" | "de" | "ru";

const BUNDLES: Record<SupportedLocale, LocaleBundle> = {
  en,
  zh,
  es,
  fr,
  de,
  ru,
};

const SUPPORTED = new Set<string>(Object.keys(BUNDLES));

// Keep the polished ChatScribe markup and its accessible labels while using
// the independently written controller's concise message keys.
const KEY_ALIASES: Record<string, string> = {
  "popup.settingsLink": "popup.settings",
  "popup.loading.default": "popup.loading",
  "popup.loading.aria": "popup.loading",
  "popup.selector.filterAll": "popup.selector.all",
  "popup.selector.filterQuestions": "popup.selector.questions",
  "popup.selector.filterAnswers": "popup.selector.answers",
  "popup.selector.filterNone": "popup.selector.none",
  "popup.selector.filterInvert": "popup.selector.invert",
  "popup.selector.formatMd": "popup.selector.format.md",
  "popup.selector.formatTxt": "popup.selector.format.txt",
  "popup.selector.formatJson": "popup.selector.format.json",
  "popup.selector.formatCsv": "popup.selector.format.csv",
  "popup.githubConfirm.title": "popup.confirm.title",
  "popup.githubConfirm.message": "popup.confirm.body",
  "popup.githubConfirm.private": "popup.confirm.private",
  "popup.githubConfirm.confirmQuestion": "popup.confirm.question",
  "popup.githubConfirm.cancel": "popup.confirm.cancel",
  "popup.githubConfirm.export": "popup.confirm.export",
  "options.appearance.themeSystem": "options.appearance.system",
  "options.appearance.themeLight": "options.appearance.light",
  "options.appearance.themeDark": "options.appearance.dark",
  "options.downloads.askWhereToSave": "options.downloads.promptToSave",
  "options.downloads.bundleImages": "options.downloads.downloadImages",
  "options.downloads.bundleImagesHint": "options.downloads.imagesHint",
  "options.spacing.legend": "options.separator.legend",
  "options.spacing.single": "options.separator.single",
  "options.spacing.double": "options.separator.double",
  "options.spacing.rule": "options.separator.rule",
  "options.github.statusDisconnected": "options.github.disconnected",
  "options.githubOverlay.eyebrow": "options.githubOverlay.title",
};

let activeLocale: SupportedLocale = "en";

function isSupportedLocale(v: string): v is SupportedLocale {
  return SUPPORTED.has(v);
}

function detectBrowserLocale(): SupportedLocale {
  const candidates: string[] = [];

  try {
    const ui = chrome?.i18n?.getUILanguage?.();
    if (ui) candidates.push(ui);
  } catch {
    /* not available in content scripts */
  }

  candidates.push(navigator.language, ...(navigator.languages ?? []));

  for (const c of candidates) {
    if (!c) continue;
    const short = c.slice(0, 2).toLowerCase();
    if (isSupportedLocale(short)) return short;
  }

  return "en";
}

/**
 * Initialise i18n by reading the "language" preference from storage.
 * Call once on popup/options startup.
 */
export async function initI18n(): Promise<void> {
  const stored = await chrome.storage.sync.get({ language: "auto" });
  const pref = String(stored.language ?? "auto");

  if (pref === "auto") {
    activeLocale = detectBrowserLocale();
  } else if (isSupportedLocale(pref)) {
    activeLocale = pref;
  } else {
    activeLocale = "en";
  }
}

/** Override the locale immediately (for the language switcher in options). */
export function setLocale(locale: string): void {
  if (isSupportedLocale(locale)) {
    activeLocale = locale;
  }
}

export function getLocale(): SupportedLocale {
  return activeLocale;
}

/** Translate a key, with optional {{placeholder}} substitution. */
export function t(
  key: string,
  vars?: Record<string, string | number>,
): string {
  const bundle = BUNDLES[activeLocale] ?? BUNDLES.en;
  const resolvedKey = KEY_ALIASES[key] ?? key;
  let text = bundle[resolvedKey] ?? BUNDLES.en[resolvedKey] ?? key;

  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{{${k}}}`, String(v));
    }
  }

  return text;
}

/**
 * Apply translations to DOM elements using data attributes:
 *   data-i18n              → textContent
 *   data-i18n-html         → innerHTML (for strings with intentional markup)
 *   data-i18n-placeholder  → placeholder attribute
 *   data-i18n-aria-label   → aria-label attribute
 *   data-i18n-title        → title attribute
 */
export function applyTranslations(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });

  root.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((el) => {
    const key = el.dataset.i18nHtml;
    if (key) el.innerHTML = t(key);
  });

  root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {
    const key = el.dataset.i18nPlaceholder;
    if (key) el.setAttribute("placeholder", t(key));
  });

  root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((el) => {
    const key = el.dataset.i18nAriaLabel;
    if (key) el.setAttribute("aria-label", t(key));
  });

  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const key = el.dataset.i18nTitle;
    if (key) el.setAttribute("title", t(key));
  });

  if (root === document) {
    document.documentElement.lang = activeLocale;
  }
}
