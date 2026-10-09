/**
 * popup.ts — ChatScribe
 *
 * Popup UI logic.
 *
 * Flow:
 *  1. On open, load settings and messages from the active ChatGPT tab.
 *  2. Show a loading overlay while messages are fetching.
 *  3. On success, make full-copy, latest-answer, and message-selection actions available.
 *  4. Copy the conversation or latest answer, or choose a subset to copy/export.
 *  5. Export → open the selector, let user pick messages + format, download.
 *  6. GitHub button in selector → open repo picker, confirm, save to repo.
 */

import { loadSettings, type Settings } from "./settings.ts";
import { initI18n, applyTranslations, t } from "./i18n.ts";
import {
  formatMarkdown,
  formatPlainText,
  formatJson,
  formatCsv,
  buildFilename,
  getExportMimeType,
  type ExportFormat,
} from "./formatter.ts";
import { buildZipBlob, blobToBase64 } from "./zip.ts";
import type { ConversationData, ExportMessage, ExportImageFile } from "./types.ts";
import {
  renderSvgTemplatesAsMarkdown,
  type SvgDiagramMode,
} from "./svg-template.ts";

// -----------------------------------------------------------------------
// INIT: apply theme + i18n before content renders
// -----------------------------------------------------------------------

void loadSettings().then((s) => applyTheme(s.theme));
void initI18n().then(() => applyTranslations());

function applyTheme(theme: Settings["theme"]): void {
  if (theme === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

// -----------------------------------------------------------------------
// DEV LOGGING
// -----------------------------------------------------------------------

const devLog = (...a: unknown[]): void => {
  if (import.meta.env.DEV) console.log("[ChatScribe popup]", ...a);
};

const devError = (...a: unknown[]): void => {
  if (import.meta.env.DEV) console.error("[ChatScribe popup]", ...a);
};

// -----------------------------------------------------------------------
// DOM ELEMENTS
// -----------------------------------------------------------------------

const ID_ALIASES: Record<string, string> = {
  "copy-btn": "copy",
  "export-btn": "export",
  "loading-message": "loading-overlay-message",
  "sel-filter-all": "selector-filter-all",
  "sel-filter-q": "selector-filter-questions",
  "sel-filter-a": "selector-filter-answers",
  "sel-filter-none": "selector-filter-none",
  "sel-filter-invert": "selector-filter-invert",
  "selector-github": "selector-github-button",
};

const $id = <T extends HTMLElement>(id: string) =>
  document.getElementById(ID_ALIASES[id] ?? id) as T;

const copyBtn = $id<HTMLButtonElement>("copy-btn");
const copyMenuToggle = $id<HTMLButtonElement>("copy-menu-toggle");
const copyLatestBtn = $id<HTMLButtonElement>("copy-latest");
const copySelectBtn = $id<HTMLButtonElement>("copy-select");
const copyControl = $id<HTMLDivElement>("copy-control");
const copyOptions = $id<HTMLDivElement>("copy-options");
const exportBtn = $id<HTMLButtonElement>("export-btn");
const optionsLink = $id<HTMLAnchorElement>("options-link");

const loadingOverlay = $id<HTMLDivElement>("loading-overlay");
const loadingMessage = $id<HTMLParagraphElement>("loading-message");

const toast = $id<HTMLDivElement>("toast");

const selectorOverlay = $id<HTMLDivElement>("selector-overlay");
const selFilterAll = $id<HTMLButtonElement>("sel-filter-all");
const selFilterQ = $id<HTMLButtonElement>("sel-filter-q");
const selFilterA = $id<HTMLButtonElement>("sel-filter-a");
const selFilterNone = $id<HTMLButtonElement>("sel-filter-none");
const selFilterInvert = $id<HTMLButtonElement>("sel-filter-invert");
const selExpandToggle = $id<HTMLInputElement>("selector-expand-toggle");
const selCountEl = $id<HTMLSpanElement>("selector-count");
const selList = $id<HTMLDivElement>("selector-list");
const selFormatSelect = $id<HTMLSelectElement>("selector-format-select");
const selCopyBtn = $id<HTMLButtonElement>("selector-copy");
const selGithubBtn = $id<HTMLButtonElement>("selector-github");
const selCancelBtn = $id<HTMLButtonElement>("selector-cancel");
const selExportBtn = $id<HTMLButtonElement>("selector-export");

const githubPanel = $id<HTMLDivElement>("github-panel");
const githubPanelMsg = $id<HTMLParagraphElement>("github-panel-message");
const githubRepoSelect = $id<HTMLSelectElement>("github-repo-select");
const githubPanelSave = $id<HTMLButtonElement>("github-panel-save");
const githubPanelCancel = $id<HTMLButtonElement>("github-panel-cancel");

const githubConfirmOverlay = $id<HTMLDivElement>("github-confirm-overlay");
const githubConfirmCancel = $id<HTMLButtonElement>("github-confirm-cancel");
const githubConfirmExport = $id<HTMLButtonElement>("github-confirm-export");

const ALL_BUTTONS = [
  copyBtn,
  copyMenuToggle,
  copyLatestBtn,
  copySelectBtn,
  exportBtn,
  selCopyBtn,
  selExportBtn,
  selGithubBtn,
  githubPanelSave,
];

// -----------------------------------------------------------------------
// STATE
// -----------------------------------------------------------------------

let conversationData: ConversationData | null = null;
let settings: Settings | null = null;
let pageTitle = "ChatGPT Conversation";

// -----------------------------------------------------------------------
// TOAST
// -----------------------------------------------------------------------

let toastTimer: number | undefined;

function showToast(msg: string, ms = 2200): void {
  toast.textContent = msg;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), ms);
}

// -----------------------------------------------------------------------
// BUSY STATE
// -----------------------------------------------------------------------

function setBusy(busy: boolean): void {
  ALL_BUTTONS.forEach((b) => { b.disabled = busy; });
}

// -----------------------------------------------------------------------
// LOADING OVERLAY
// -----------------------------------------------------------------------

function showLoading(msg?: string): void {
  loadingMessage.textContent = msg ?? t("popup.loading");
  loadingOverlay.classList.add("open");
}

function hideLoading(): void {
  loadingOverlay.classList.remove("open");
}

// -----------------------------------------------------------------------
// OPTIONS LINK
// -----------------------------------------------------------------------

optionsLink.addEventListener("click", (event) => {
  event.preventDefault();
  void chrome.runtime.openOptionsPage();
});

// -----------------------------------------------------------------------
// INITIALISE: get active tab + load conversation
// -----------------------------------------------------------------------

async function init(): Promise<void> {
  settings = await loadSettings();
  applyTheme(settings.theme);

  showLoading(t("popup.loading"));

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    hideLoading();
    showToast(t("popup.error.noTab"), 4000);
    return;
  }

  if (!tab.url?.includes("chatgpt.com")) {
    hideLoading();
    showToast(t("popup.error.notChatGpt"), 4000);
    return;
  }

  pageTitle = tab.title ?? "ChatGPT Conversation";

  // Forward progress updates to loading message
  const progressListener = (msg: { type?: string; collected?: number }): void => {
    if (msg.type === "EXPORT_PROGRESS" && typeof msg.collected === "number") {
      loadingMessage.textContent = `${t("popup.loading")} (${msg.collected})`;
    }
  };
  chrome.runtime.onMessage.addListener(progressListener);

  try {
    const response = await chrome.tabs.sendMessage<unknown, {
      success: boolean;
      data?: ConversationData;
      error?: string;
    }>(tab.id, {
      type: "LOAD_CONVERSATION",
      downloadImages: settings.downloadImages,
    });

    if (!response?.success || !response.data) {
      throw new Error(response?.error ?? t("popup.error.loadFailed"));
    }

    const loaded = response.data;
    conversationData = loaded;

    if (loaded.messages.length === 0) {
      throw new Error(t("popup.error.noMessages"));
    }

    devLog("Conversation loaded:", loaded.messages.length, "messages");

    hideLoading();
  } catch (err) {
    devError("Failed to load conversation:", err);
    hideLoading();
    const errorMessage = err instanceof Error ? err.message : "";
    const isContentScriptUnavailable =
      /receiving end does not exist|no receiver|could not establish connection/i
        .test(errorMessage);
    const isChatGptConnectionNotReady =
      errorMessage === "CHATGPT_CONNECTION_NOT_READY";
    showToast(
      isChatGptConnectionNotReady
        ? t("popup.error.chatGptConnectionNotReady")
        : isContentScriptUnavailable
          ? t("popup.error.contentScriptUnavailable")
          : errorMessage || t("popup.error.loadFailed"),
      5000,
    );
    return;
  } finally {
    chrome.runtime.onMessage.removeListener(progressListener);
  }
}

void init();

// -----------------------------------------------------------------------
// DOWNLOAD COMPLETE → show a brief success toast on the page
// -----------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg.type === "DOWNLOAD_COMPLETE") {
    void sendToPage({
      type: "SHOW_EXPORT_SUCCESS",
      message: t("popup.toast.exported"),
    });
  }
});

async function sendToPage(message: object): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, message).catch(() => { /* tab may be gone */ });
}

// -----------------------------------------------------------------------
// COPY ACTIONS
// -----------------------------------------------------------------------

copyBtn.addEventListener("click", () => {
  if (!conversationData || !settings) {
    showToast(t("popup.error.loadFailed"));
    return;
  }
  closeCopyOptions();
  void copyMessages(conversationData.messages);
});

copyMenuToggle.addEventListener("click", () => {
  const open = copyMenuToggle.getAttribute("aria-expanded") !== "true";
  copyOptions.hidden = !open;
  copyControl.classList.toggle("open", open);
  copyMenuToggle.setAttribute("aria-expanded", String(open));
});

copyLatestBtn.addEventListener("click", () => {
  if (!conversationData || !settings) {
    showToast(t("popup.error.loadFailed"));
    return;
  }

  const latestAnswer = [...conversationData.messages]
    .reverse()
    .find((message) => message.role === "assistant");

  closeCopyOptions();
  copyMenuToggle.focus();
  if (!latestAnswer) {
    showToast(t("popup.error.noAssistantAnswer"));
    return;
  }
  void copyMessages([latestAnswer]);
});

copySelectBtn.addEventListener("click", () => {
  closeCopyOptions();
  if (!conversationData) {
    showToast(t("popup.error.loadFailed"));
    return;
  }
  openSelector();
});

function closeCopyOptions(): void {
  copyOptions.hidden = true;
  copyControl.classList.remove("open");
  copyMenuToggle.setAttribute("aria-expanded", "false");
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !copyOptions.hidden) {
    closeCopyOptions();
    copyMenuToggle.focus();
  }
});

// -----------------------------------------------------------------------
// EXPORT BUTTON → open selector
// -----------------------------------------------------------------------

exportBtn.addEventListener("click", () => {
  closeCopyOptions();
  if (!conversationData) {
    showToast(t("popup.error.loadFailed"));
    return;
  }
  openSelector();
});

// -----------------------------------------------------------------------
// SELECTOR LOGIC
// -----------------------------------------------------------------------

function openSelector(): void {
  if (!conversationData) return;
  closeCopyOptions();
  populateSelector(conversationData.messages);
  document.body.classList.add("overlay-open");
  selectorOverlay.classList.add("open");
  updateSelectorCount();
  const firstCheckbox = selList.querySelector<HTMLInputElement>(
    "input[type='checkbox']",
  );
  (firstCheckbox ?? selCancelBtn).focus();
}

function closeSelector(): void {
  selectorOverlay.classList.remove("open");
  document.body.classList.remove("overlay-open");
}

function getCheckboxes(): HTMLInputElement[] {
  return Array.from(
    selList.querySelectorAll<HTMLInputElement>("input[type='checkbox']"),
  );
}

function getCheckedIds(): string[] {
  return getCheckboxes()
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.id ?? "");
}

function updateSelectorCount(): void {
  const boxes = getCheckboxes();
  const checked = boxes.filter((b) => b.checked).length;
  selCountEl.textContent = t("popup.selector.count", {
    checked,
    total: boxes.length,
  });

  selExportBtn.disabled = checked === 0;
  selCopyBtn.disabled = checked === 0;
  selGithubBtn.disabled = checked === 0;
}

function populateSelector(messages: ExportMessage[]): void {
  selList.innerHTML = "";
  const expanded = selExpandToggle.checked;
  selList.classList.toggle("expanded", expanded);

  for (const msg of messages) {
    const item = document.createElement("div");
    item.className = "selector-row";
    item.setAttribute("role", "listitem");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = false;
    cb.dataset.id = msg.id;
    cb.dataset.role = msg.role;
    cb.addEventListener("change", updateSelectorCount);

    const roleEl = document.createElement("span");
    roleEl.className = "selector-role-icon";
    roleEl.textContent = msg.role === "user" ? "User" : "Assistant";

    const textEl = document.createElement("div");
    textEl.className = "selector-preview";
    textEl.textContent = msg.content || "[Image]";

    item.appendChild(cb);
    item.appendChild(roleEl);
    item.appendChild(textEl);

    // Click on row (not the checkbox itself) toggles the checkbox
    item.addEventListener("click", (e) => {
      if (e.target !== cb) {
        cb.checked = !cb.checked;
        updateSelectorCount();
      }
    });

    selList.appendChild(item);
  }

  updateSelectorCount();
}

// Filter buttons
selFilterAll.addEventListener("click", () => {
  getCheckboxes().forEach((cb) => { cb.checked = true; });
  updateSelectorCount();
});

selFilterQ.addEventListener("click", () => {
  getCheckboxes().forEach((cb) => {
    cb.checked = cb.dataset.role === "user";
  });
  updateSelectorCount();
});

selFilterA.addEventListener("click", () => {
  getCheckboxes().forEach((cb) => {
    cb.checked = cb.dataset.role === "assistant";
  });
  updateSelectorCount();
});

selFilterNone.addEventListener("click", () => {
  getCheckboxes().forEach((cb) => { cb.checked = false; });
  updateSelectorCount();
});

selFilterInvert.addEventListener("click", () => {
  getCheckboxes().forEach((cb) => { cb.checked = !cb.checked; });
  updateSelectorCount();
});

selExpandToggle.addEventListener("change", () => {
  selList.classList.toggle("expanded", selExpandToggle.checked);
});

selCancelBtn.addEventListener("click", closeSelector);

// -----------------------------------------------------------------------
// GET SELECTED MESSAGES
// -----------------------------------------------------------------------

function getSelectedMessages(): ExportMessage[] {
  if (!conversationData) return [];
  const ids = new Set(getCheckedIds());
  return conversationData.messages.filter((m) => ids.has(m.id));
}

function getSelectedImages(messages: ExportMessage[]): ExportImageFile[] {
  if (!conversationData) return [];
  const paths = new Set(messages.flatMap((m) => m.imagePaths));
  return conversationData.images.filter((img) => paths.has(img.path));
}

async function prepareDiagramMessages(
  messages: ExportMessage[],
  mode: SvgDiagramMode,
): Promise<{ messages: ExportMessage[]; assets: ExportImageFile[] }> {
  if (mode === "none") return { messages, assets: [] };

  const prepared: ExportMessage[] = [];
  const assets: ExportImageFile[] = [];

  for (const message of messages) {
    const rendered = await renderSvgTemplatesAsMarkdown(
      message.content,
      mode,
      assets.length + 1,
    );
    prepared.push({ ...message, content: rendered.markdown });
    assets.push(...rendered.assets);
  }

  return { messages: prepared, assets };
}

// -----------------------------------------------------------------------
// FORMAT + DOWNLOAD
// -----------------------------------------------------------------------

async function exportSelected(): Promise<void> {
  if (!settings || !conversationData) return;

  const chosen = getSelectedMessages();
  if (chosen.length === 0) return;

  setBusy(true);
  closeSelector();

  try {
    const fmt = selFormatSelect.value as ExportFormat;
    const diagramMode: SvgDiagramMode =
      fmt === "md" ? "assets" : fmt === "txt" ? "text" : "none";
    const prepared = await prepareDiagramMessages(chosen, diagramMode);
    const exportMessages = prepared.messages;
    const images = [...getSelectedImages(chosen), ...prepared.assets];
    const hasImages = images.length > 0;

    let filename: string;
    let blob: Blob;

    if (fmt === "md" && hasImages) {
      // Bundle Markdown + images into ZIP
      const md = formatMarkdown(exportMessages, settings);
      const mdFilename = buildFilename(pageTitle, "md");
      filename = buildFilename(pageTitle, "zip");
      blob = buildZipBlob(md, mdFilename, images);
    } else {
      let text: string;
      let ext: string;

      switch (fmt) {
        case "md":
          text = formatMarkdown(exportMessages, settings);
          ext = "md";
          break;
        case "txt":
          text = formatPlainText(exportMessages, settings);
          ext = "txt";
          break;
        case "json":
          text = formatJson(chosen);
          ext = "json";
          break;
        case "csv":
          text = formatCsv(chosen);
          ext = "csv";
          break;
        default:
          text = formatMarkdown(chosen, settings);
          ext = "md";
      }

      filename = buildFilename(pageTitle, ext);
      blob = new Blob([text], { type: getExportMimeType(fmt) });
    }

    const objectUrl = URL.createObjectURL(blob);

    const dlResponse = await chrome.runtime.sendMessage({
      type: "TRACKED_DOWNLOAD",
      url: objectUrl,
      filename,
      saveAs: settings.promptToSave,
    }) as { success: boolean } | undefined;

    if (!dlResponse?.success) {
      showToast(t("popup.toast.downloadFailed"), 3500);
    } else {
      showToast(t("popup.toast.downloadStarted"));
    }

    // Revoke object URL after a delay
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  } catch (err) {
    devError("Export failed:", err);
    showToast(t("popup.toast.downloadFailed"), 3500);
  } finally {
    setBusy(false);
  }
}

async function copySelected(): Promise<void> {
  if (!settings || !conversationData) return;

  const chosen = getSelectedMessages();
  if (chosen.length === 0) return;

  await copyMessages(chosen);
}

async function copyMessages(messages: ExportMessage[]): Promise<void> {
  if (!settings || messages.length === 0) return;

  setBusy(true);
  closeSelector();

  try {
    const prepared = await prepareDiagramMessages(messages, "text");
    const markdown = formatMarkdown(prepared.messages, settings);
    await writeClipboard(markdown);
    showToast(t("popup.toast.copied"));
  } catch (err) {
    devError("Copy failed:", err);
    showToast(t("popup.toast.copyFailed"), 3500);
  } finally {
    setBusy(false);
  }
}

selCopyBtn.addEventListener("click", () => {
  void copySelected();
});

selExportBtn.addEventListener("click", () => {
  void exportSelected();
});

// -----------------------------------------------------------------------
// GITHUB PANEL
// -----------------------------------------------------------------------

selGithubBtn.addEventListener("click", () => {
  const chosen = getSelectedMessages();
  if (chosen.length === 0) return;
  closeSelector();
  void openGithubPanel();
});

async function openGithubPanel(): Promise<void> {
  githubPanel.classList.add("open");

  githubPanelMsg.textContent = t("popup.github.loading");
  githubRepoSelect.innerHTML = "";
  githubRepoSelect.disabled = true;
  githubPanelSave.disabled = true;

  const status = await chrome.runtime.sendMessage({ type: "GITHUB_GET_STATUS" }) as {
    success: boolean;
    data?: { connected: boolean; login?: string };
  } | undefined;

  if (!status?.success || !status.data?.connected) {
    githubPanelMsg.innerHTML = t("popup.github.notConnectedHtml");
    const link = document.getElementById("github-settings-link");
    link?.addEventListener("click", (e) => {
      e.preventDefault();
      void chrome.runtime.openOptionsPage();
    });
    return;
  }

  const reposResponse = await chrome.runtime.sendMessage({
    type: "GITHUB_LIST_REPOS",
  }) as { success: boolean; data?: { full_name: string }[]; error?: string } | undefined;

  if (!reposResponse?.success) {
    githubPanelMsg.textContent =
      reposResponse?.error ?? t("popup.github.failedToLoad");
    return;
  }

  const repos = reposResponse.data ?? [];

  if (repos.length === 0) {
    githubPanelMsg.textContent = t("popup.github.noRepos");
    return;
  }

  githubPanelMsg.textContent = t("popup.github.chooseRepo");

  for (const repo of repos) {
    const opt = document.createElement("option");
    opt.value = repo.full_name;
    opt.textContent = repo.full_name;
    githubRepoSelect.appendChild(opt);
  }

  githubRepoSelect.disabled = false;
  githubPanelSave.disabled = false;
}

githubPanelCancel.addEventListener("click", () => {
  githubPanel.classList.remove("open");
  openSelector();
});

githubPanelSave.addEventListener("click", () => {
  if (!githubRepoSelect.value) return;
  githubConfirmOverlay.classList.add("open");
});

githubConfirmCancel.addEventListener("click", () => {
  githubConfirmOverlay.classList.remove("open");
});

githubConfirmOverlay.addEventListener("click", (e) => {
  if (e.target === githubConfirmOverlay) {
    githubConfirmOverlay.classList.remove("open");
  }
});

githubConfirmExport.addEventListener("click", () => {
  githubConfirmOverlay.classList.remove("open");
  void saveToGitHub();
});

async function saveToGitHub(): Promise<void> {
  if (!settings) return;

  const fullName = githubRepoSelect.value;
  if (!fullName) return;

  const chosen = getSelectedMessages();
  if (chosen.length === 0) return;

  setBusy(true);
  githubPanelSave.textContent = t("popup.github.saving");

  try {
    const prepared = await prepareDiagramMessages(chosen, "assets");
    const images = [...getSelectedImages(chosen), ...prepared.assets];
    const hasImages = images.length > 0;

    const md = formatMarkdown(prepared.messages, settings);
    const mdFilename = buildFilename(pageTitle, "md");

    let filename: string;
    let content: string;
    let isBinary = false;

    if (hasImages) {
      filename = buildFilename(pageTitle, "zip");
      const zipBlob = buildZipBlob(md, mdFilename, images);
      content = await blobToBase64(zipBlob);
      isBinary = true;
    } else {
      filename = mdFilename;
      content = md;
    }

    const saveResp = await chrome.runtime.sendMessage({
      type: "GITHUB_SAVE_FILE",
      fullName,
      filename,
      content,
      isBinary,
    }) as { success: boolean; error?: string; data?: { htmlUrl: string } } | undefined;

    if (!saveResp?.success) {
      throw new Error(saveResp?.error ?? t("popup.error.githubFailed"));
    }

    devLog("GitHub save complete:", saveResp.data?.htmlUrl);

    githubPanel.classList.remove("open");
    showToast(t("popup.toast.githubSaved"));
    void sendToPage({
      type: "SHOW_EXPORT_SUCCESS",
      message: t("popup.toast.githubSaved"),
    });
  } catch (err) {
    devError("GitHub save failed:", err);
    const msg = err instanceof Error ? err.message : String(err);
    showToast(msg.length < 70 ? msg : t("popup.toast.githubFailed"), 3500);
  } finally {
    setBusy(false);
    githubPanelSave.textContent = t("popup.github.save");
  }
}

async function writeClipboard(text: string): Promise<void> {
  const response = await chrome.runtime.sendMessage({
    type: "COPY_TO_CLIPBOARD",
    text,
  }) as { success?: boolean; error?: string } | undefined;

  if (!response?.success) {
    throw new Error(response?.error ?? "Clipboard write was denied.");
  }
}
