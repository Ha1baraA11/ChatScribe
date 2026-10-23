/**
 * options.ts — ChatScribe
 *
 * Options page controller.
 *
 * Manages user settings:
 *  - Message heading style (h2, bold, none)
 *  - Message separator (single, double, rule)
 *  - Downloads: prompt to save, bundle images into ZIP
 *  - Timestamps: include export date/time
 *  - Appearance: theme (system, light, dark)
 *  - Language: interface locale (auto, en, zh, zh-TW, es, fr, de, ru, ja, ko, pt-BR)
 *  - GitHub connection: Device Flow authentication and status
 */

import {
  type Settings,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
} from "./settings.ts";
import {
  initI18n,
  applyTranslations,
  setLocale,
  setLocaleFromBrowser,
  t,
} from "./i18n.ts";
import {
  buildDownloadPath,
  buildFilename,
  isValidFilenameTemplate,
} from "./formatter.ts";

const devError = (...args: unknown[]): void => {
  if (import.meta.env.DEV) {
    console.error("[ChatScribe options]", ...args);
  }
};

const ID_ALIASES: Record<string, string> = {
  promptToSave: "askWhereToSave",
  downloadImages: "downloadImagesLocally",
  "theme-select": "theme",
  "language-select": "language",
  "save-btn": "save",
  "saved-label": "status",
  "github-connect-btn": "github-connect",
  "github-disconnect-btn": "github-disconnect",
};

const $id = <T extends HTMLElement>(id: string) =>
  document.getElementById(ID_ALIASES[id] ?? id) as T;

// Form inputs
const promptToSaveInput = $id<HTMLInputElement>("promptToSave");
const filenameTemplateInput = $id<HTMLInputElement>("filenameTemplate");
const filenamePresetSelect = $id<HTMLSelectElement>("filenamePreset");
const customTemplateOption = $id<HTMLDivElement>("custom-template-option");
const downloadSubfolderInput = $id<HTMLInputElement>("downloadSubfolder");
const downloadSubfolderOption = $id<HTMLDivElement>("download-subfolder-option");
const filenameTemplateError = $id<HTMLParagraphElement>("filename-template-error");
const downloadSubfolderError = $id<HTMLParagraphElement>("download-subfolder-error");
const filenamePreview = $id<HTMLParagraphElement>("filename-preview");
const downloadImagesInput = $id<HTMLInputElement>("downloadImages");
const includeGeneratedImagesInput = $id<HTMLInputElement>("includeGeneratedImages");
const includeTimestampInput = $id<HTMLInputElement>("includeTimestamp");
const keepCopyOptionsOpenInput = $id<HTMLInputElement>("keepCopyOptionsOpen");
const selectorOrderSelect = $id<HTMLSelectElement>("selectorOrder");
const themeSelect = $id<HTMLSelectElement>("theme-select");
const panelModeSelect = $id<HTMLSelectElement>("panelMode");
const languageSelect = $id<HTMLSelectElement>("language-select");
const downloadsSettingsLink = $id<HTMLAnchorElement>("downloads-settings-link");

const FILENAME_PRESETS: Record<string, string> = {
  title: "{title}",
  "title-date": "{title}_{date}",
  "date-title": "{date}_{title}",
  "title-datetime": "{title}_{datetime}",
  "datetime-title": "{datetime}_{title}",
};

// Save UI
const saveBtn = $id<HTMLButtonElement>("save-btn");
const savedLabel = $id<HTMLSpanElement>("saved-label");
let savedLabelTimer: number | undefined;

function showSavedLabel(): void {
  savedLabel.classList.add("visible");
  window.clearTimeout(savedLabelTimer);
  savedLabelTimer = window.setTimeout(() => {
    savedLabel.classList.remove("visible");
  }, 1800);
}

// GitHub UI
const githubStatus = $id<HTMLParagraphElement>("github-status");
const githubConnectBtn = $id<HTMLButtonElement>("github-connect-btn");
const githubDisconnectBtn = $id<HTMLButtonElement>("github-disconnect-btn");

// GitHub overlay UI
const githubOverlay = $id<HTMLDivElement>("github-overlay");
const githubOverlayCode = $id<HTMLParagraphElement>("github-overlay-code");
const githubOverlayError = $id<HTMLParagraphElement>("github-overlay-error");
const githubOverlaySpinner = $id<HTMLDivElement>("github-overlay-spinner");
const githubOverlayCancel = $id<HTMLButtonElement>("github-overlay-cancel");

function applyTheme(theme: Settings["theme"]): void {
  if (theme === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

function getRadioValue<T extends string>(name: string, fallback: T): T {
  const actualName = name === "separatorStyle" ? "messageSeparator" : name;
  const checked = document.querySelector<HTMLInputElement>(
    `input[name="${actualName}"]:checked`,
  );
  return (checked?.value as T) ?? fallback;
}

function setRadioValue(name: string, value: string): void {
  const actualName = name === "separatorStyle" ? "messageSeparator" : name;
  const target = document.querySelector<HTMLInputElement>(
    `input[name="${actualName}"][value="${value}"]`,
  );
  if (target) {
    target.checked = true;
  }
}

function populateForm(settings: Settings): void {
  setRadioValue("headingStyle", settings.headingStyle);
  setRadioValue("separatorStyle", settings.separatorStyle);

  promptToSaveInput.checked = settings.promptToSave;
  const storedTemplate = settings.filenameTemplate.trim()
    ? settings.filenameTemplate
    : DEFAULT_SETTINGS.filenameTemplate;
  filenameTemplateInput.value = storedTemplate;
  filenamePresetSelect.value = Object.entries(FILENAME_PRESETS).find(
    ([, template]) => template === storedTemplate,
  )?.[0] ?? "custom";
  downloadSubfolderInput.value = settings.downloadSubfolder;
  downloadImagesInput.checked = settings.downloadImages;
  includeGeneratedImagesInput.checked = settings.includeGeneratedImages;
  includeTimestampInput.checked = settings.includeTimestamp;
  keepCopyOptionsOpenInput.checked = settings.keepCopyOptionsOpen;
  selectorOrderSelect.value = settings.selectorOrder;

  themeSelect.value = settings.theme;
  panelModeSelect.value = settings.panelMode;
  applyTheme(settings.theme);

  languageSelect.value = settings.language;
  updateDownloadLocationControls();
  updateFilenameControls();
  updateExportPreview();
}

function getFilenameTemplate(): string {
  return filenamePresetSelect.value === "custom"
    ? filenameTemplateInput.value.trim()
    : FILENAME_PRESETS[filenamePresetSelect.value] ?? DEFAULT_SETTINGS.filenameTemplate;
}

function gatherSettings(): Settings {
  return {
    headingStyle: getRadioValue("headingStyle", DEFAULT_SETTINGS.headingStyle),
    separatorStyle: getRadioValue(
      "separatorStyle",
      DEFAULT_SETTINGS.separatorStyle,
    ),
    promptToSave: promptToSaveInput.checked,
    filenameTemplate: getFilenameTemplate(),
    downloadSubfolder: downloadSubfolderInput.value.trim(),
    downloadImages: downloadImagesInput.checked,
    includeGeneratedImages: includeGeneratedImagesInput.checked,
    includeTimestamp: includeTimestampInput.checked,
    keepCopyOptionsOpen: keepCopyOptionsOpenInput.checked,
    selectorOrder: selectorOrderSelect.value as Settings["selectorOrder"],
    theme: themeSelect.value as Settings["theme"],
    panelMode: panelModeSelect.value as Settings["panelMode"],
    language: languageSelect.value as Settings["language"],
  };
}

function updateDownloadLocationControls(): void {
  downloadSubfolderOption.hidden = promptToSaveInput.checked;
}

function updateFilenameControls(): void {
  customTemplateOption.hidden = filenamePresetSelect.value !== "custom";
}

function updateExportPreview(): boolean {
  const usingCustomTemplate = filenamePresetSelect.value === "custom";
  const template = getFilenameTemplate();
  const templateIsValid = isValidFilenameTemplate(template);
  filenameTemplateInput.setAttribute(
    "aria-invalid",
    String(usingCustomTemplate && !templateIsValid),
  );
  filenameTemplateError.hidden = !usingCustomTemplate || templateIsValid;

  let pathIsValid = true;
  let filename = "";
  try {
    filename = buildFilename(
      t("options.downloads.previewTitle"),
      "md",
      template,
    );
    if (!promptToSaveInput.checked) {
      filename = buildDownloadPath(filename, downloadSubfolderInput.value);
    }
  } catch {
    pathIsValid = false;
  }

  downloadSubfolderInput.setAttribute("aria-invalid", String(!pathIsValid));
  downloadSubfolderError.hidden = pathIsValid || promptToSaveInput.checked;
  filenamePreview.textContent = t("options.downloads.filenamePreview", {
    filename: pathIsValid ? filename : "",
  });

  return templateIsValid && (pathIsValid || promptToSaveInput.checked);
}

// -----------------------------------------------------------------------
// GITHUB INTEGRATION
// -----------------------------------------------------------------------

async function refreshGitHubStatus(): Promise<void> {
  githubConnectBtn.disabled = true;
  githubDisconnectBtn.disabled = true;

  try {
    const res = (await chrome.runtime.sendMessage({
      type: "GITHUB_GET_STATUS",
    })) as { success: boolean; data?: { connected: boolean; login?: string } };

    if (res?.success && res.data?.connected && res.data.login) {
      githubStatus.textContent = t("options.github.connected", {
        login: res.data.login,
      });
      githubConnectBtn.style.display = "none";
      githubDisconnectBtn.removeAttribute("hidden");
      githubDisconnectBtn.style.display = "inline-block";
    } else {
      githubStatus.textContent = t("options.github.disconnected");
      githubConnectBtn.style.display = "inline-block";
      githubDisconnectBtn.setAttribute("hidden", "");
      githubDisconnectBtn.style.removeProperty("display");
    }
  } catch (err) {
    devError("Failed to check GitHub status:", err);
    githubStatus.textContent = t("options.github.disconnected");
    githubConnectBtn.style.display = "inline-block";
    githubDisconnectBtn.setAttribute("hidden", "");
    githubDisconnectBtn.style.removeProperty("display");
  } finally {
    githubConnectBtn.disabled = false;
    githubDisconnectBtn.disabled = false;
  }
}

let authPollAborted = false;

async function startGitHubAuth(): Promise<void> {
  authPollAborted = false;
  githubOverlayError.classList.remove("visible");
  githubOverlaySpinner.style.display = "block";
  githubOverlayCode.textContent = "···· ····";
  githubOverlay.classList.add("open");

  try {
    const res = (await chrome.runtime.sendMessage({
      type: "GITHUB_START_AUTH",
    })) as {
      success: boolean;
      data?: { userCode: string; verificationUri: string };
      error?: string;
    };

    if (!res?.success || !res.data) {
      throw new Error(res?.error ?? t("options.error.githubStartFailed"));
    }

    const { userCode, verificationUri } = res.data;
    githubOverlayCode.textContent = userCode;

    // Open GitHub auth page in a new tab
    void chrome.tabs.create({ url: verificationUri });

    // Listen for background auth completion
    const onAuthComplete = (msg: {
      type?: string;
      success?: boolean;
      error?: string;
    }): void => {
      if (msg.type !== "GITHUB_AUTH_COMPLETE") return;
      chrome.runtime.onMessage.removeListener(onAuthComplete);

      if (authPollAborted) return;

      if (msg.success) {
        githubOverlay.classList.remove("open");
        void refreshGitHubStatus();
      } else {
        githubOverlaySpinner.style.display = "none";
        githubOverlayError.textContent =
          msg.error ?? t("options.error.githubSigninFailed");
        githubOverlayError.classList.add("visible");
      }
    };

    chrome.runtime.onMessage.addListener(onAuthComplete);
  } catch (err) {
    devError("GitHub start error:", err);
    githubOverlaySpinner.style.display = "none";
    githubOverlayError.textContent =
      err instanceof Error ? err.message : t("options.error.githubStartFailed");
    githubOverlayError.classList.add("visible");
  }
}

githubConnectBtn.addEventListener("click", () => {
  void startGitHubAuth();
});

githubDisconnectBtn.addEventListener("click", async () => {
  githubDisconnectBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "GITHUB_DISCONNECT" });
    await refreshGitHubStatus();
  } catch (err) {
    devError("Disconnect error:", err);
  } finally {
    githubDisconnectBtn.disabled = false;
  }
});

githubOverlayCancel.addEventListener("click", () => {
  authPollAborted = true;
  githubOverlay.classList.remove("open");
});

// -----------------------------------------------------------------------
// EVENT LISTENERS
// -----------------------------------------------------------------------

themeSelect.addEventListener("change", () => {
  applyTheme(themeSelect.value as Settings["theme"]);
});

languageSelect.addEventListener("change", () => {
  if (languageSelect.value === "auto") {
    setLocaleFromBrowser();
    applyTranslations();
  } else {
    setLocale(languageSelect.value);
    applyTranslations();
  }
  updateExportPreview();
  void refreshGitHubStatus();
});

selectorOrderSelect.addEventListener("change", async () => {
  await chrome.storage.sync.set({
    selectorOrder: selectorOrderSelect.value as Settings["selectorOrder"],
  });
  showSavedLabel();
});

promptToSaveInput.addEventListener("change", () => {
  updateDownloadLocationControls();
  updateExportPreview();
});

filenamePresetSelect.addEventListener("change", () => {
  updateFilenameControls();
  updateExportPreview();
});

filenameTemplateInput.addEventListener("input", () => {
  updateExportPreview();
});

downloadSubfolderInput.addEventListener("input", () => {
  updateExportPreview();
});

saveBtn.addEventListener("click", async () => {
  if (!updateExportPreview()) {
    if (
      filenamePresetSelect.value === "custom" &&
      !isValidFilenameTemplate(filenameTemplateInput.value)
    ) {
      filenameTemplateInput.focus();
    } else {
      downloadSubfolderInput.focus();
    }
    return;
  }

  const current = gatherSettings();
  await saveSettings(current);

  showSavedLabel();
});

downloadsSettingsLink.addEventListener("click", (e) => {
  e.preventDefault();
  const isFirefox = navigator.userAgent.includes("Firefox");
  const url = isFirefox
    ? "about:preferences#general"
    : "chrome://settings/downloads";
  void chrome.tabs.create({ url });
});

// -----------------------------------------------------------------------
// INIT
// -----------------------------------------------------------------------

async function init(): Promise<void> {
  await initI18n();
  applyTranslations();

  const settings = await loadSettings();
  populateForm(settings);

  await refreshGitHubStatus();
}

void init();
