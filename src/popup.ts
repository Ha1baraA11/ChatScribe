/**
 * popup.ts — ChatScribe's persistent browser panel
 *
 * Shared Chrome Side Panel / Firefox Sidebar UI logic.
 *
 * Flow:
 *  1. On open, load settings and messages from the active ChatGPT tab.
 *  2. Keep the panel and its progress visible while users switch tabs.
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
  buildDownloadPath,
  getExportMimeType,
  type ExportFormat,
} from "./formatter.ts";
import { buildZipBlob, blobToBase64 } from "./zip.ts";
import { selectHydratedExport } from "./export-selection.ts";
import { CONTENT_LOAD_TYPE } from "./content-protocol.ts";
import type {
  ConversationData,
  ExportMessage,
  ExportImageFile,
  ImageExportDiagnostics,
} from "./types.ts";
import {
  normalizeChatGptComponents,
  replaceSvgTemplatesWithRenderedImages,
  renderSvgTemplatesAsMarkdown,
  type SvgDiagramMode,
} from "./svg-template.ts";

// -----------------------------------------------------------------------
// INIT: apply theme + i18n before content renders
// -----------------------------------------------------------------------

void loadSettings().then((s) => applyTheme(s.theme));
void initI18n().then(() => {
  applyTranslations();
  applyCopyOptionsPreference();
});

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
let sourceTabId: number | null = null;
let loadSequence = 0;
let githubReturnSelection: Set<string> | null = null;
const PANEL_TARGET_TAB_KEY = "chatscribePanelTargetTabId";

function isMissingReceiver(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /receiving end does not exist|no receiver|could not establish connection/i
    .test(message);
}

async function requestConversation(
  tabId: number,
  downloadImages: boolean,
  includeGeneratedImages: boolean,
  fetchImages = downloadImages,
  selectedMessageIds?: string[],
  forceRefresh = false,
): Promise<{
  success: boolean;
  data?: ConversationData;
  error?: string;
  imageDiagnostics?: ImageExportDiagnostics;
}> {
  const request = {
    type: CONTENT_LOAD_TYPE,
    downloadImages,
    includeGeneratedImages,
    fetchImages,
    selectedMessageIds,
    forceRefresh,
  };

  // Ensure both the isolated content script and MAIN-world bridge. The content
  // listener can still be alive after an extension reload even when its bridge
  // has disappeared, so a successful content ping alone is not sufficient.
  const ensured = await chrome.runtime.sendMessage({
    type: "ENSURE_CONTENT_SCRIPT",
    tabId,
  }) as { success?: boolean; error?: string } | undefined;
  if (!ensured?.success) {
    throw new Error(ensured?.error ?? "ChatScribe could not reconnect to this tab.");
  }

  try {
    return await chrome.tabs.sendMessage(tabId, request);
  } catch (error) {
    if (isMissingReceiver(error)) {
      throw new Error("ChatScribe could not reconnect to this tab.");
    }
    throw error;
  }
}

class ImageExportFailure extends Error {
  readonly imageDiagnostics?: ImageExportDiagnostics;
  readonly stage: string;

  constructor(
    message: string,
    imageDiagnostics?: ImageExportDiagnostics,
    stage = "image-export",
  ) {
    super(message);
    this.name = "ImageExportFailure";
    this.imageDiagnostics = imageDiagnostics;
    this.stage = stage;
  }
}

function safeImageExportFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(?:https?|blob|data):\/\/\S+/gi, "[url]")
    .replace(/data:image\/[^\s;,]+;base64,[^\s)]+/gi, "[inline image]")
    .replace(/[\r\n\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

async function downloadImageDiagnostics(
  diagnostics: ImageExportDiagnostics,
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `ChatScribe-image-diagnostics-${timestamp}.json`;
  const blob = new Blob([JSON.stringify(diagnostics, null, 2)], {
    type: "application/json",
  });
  const objectUrl = URL.createObjectURL(blob);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "TRACKED_DOWNLOAD",
      url: objectUrl,
      // Keep the diagnostic report in Downloads root so a bad configured
      // subfolder cannot prevent the failure report from being saved too.
      filename,
      saveAs: false,
    }) as { success?: boolean; error?: string } | undefined;
    if (!response?.success) {
      throw new Error(response?.error ?? "Chrome did not start the diagnostic download.");
    }
    return filename;
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  }
}

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

async function loadConversationForTab(tabId: number): Promise<void> {
  const requestId = ++loadSequence;
  setBusy(false);
  if (!settings) {
    settings = await loadSettings();
    applyTheme(settings.theme);
    applyCopyOptionsPreference();
  }
  if (requestId !== loadSequence) return;
  sourceTabId = tabId;
  conversationData = null;
  closeSelector();
  showLoading(t("popup.loading"));

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url?.includes("chatgpt.com")) {
      throw new Error(t("popup.error.notChatGpt"));
    }

    pageTitle = tab.title ?? "ChatGPT Conversation";
    const response = await requestConversation(
      tabId,
      settings?.downloadImages ?? false,
      settings?.includeGeneratedImages ?? true,
      false,
    );

    if (!response?.success || !response.data) {
      throw new Error(response?.error ?? t("popup.error.loadFailed"));
    }

    if (requestId !== loadSequence) return;

    const loaded = response.data;
    conversationData = loaded;
    if (loaded.messages.length === 0) {
      throw new Error(t("popup.error.noMessages"));
    }

    devLog("Conversation loaded:", loaded.messages.length, "messages");

    hideLoading();
  } catch (err) {
    if (requestId !== loadSequence) return;
    devError("Failed to load conversation:", err);
    hideLoading();
    const errorMessage = err instanceof Error ? err.message : "";
    const isContentScriptUnavailable = isMissingReceiver(err) ||
      /could not reconnect to this tab/i.test(errorMessage);
    const isChatGptConnectionNotReady =
      errorMessage === "CHATGPT_CONNECTION_NOT_READY" ||
      /ChatScribe bridge did not start/i.test(errorMessage);

    showToast(
      isChatGptConnectionNotReady
        ? t("popup.error.chatGptConnectionNotReady")
        : isContentScriptUnavailable
          ? t("popup.error.contentScriptUnavailable")
          : errorMessage || t("popup.error.loadFailed"),
      5000,
    );
  } finally {
    if (requestId === loadSequence) hideLoading();
  }
}

async function init(): Promise<void> {
  settings = await loadSettings();
  applyTheme(settings.theme);
  applyCopyOptionsPreference();

  const storedTarget = await chrome.storage.local.get(PANEL_TARGET_TAB_KEY);
  const requestedTabId = storedTarget[PANEL_TARGET_TAB_KEY];
  if (Number.isInteger(requestedTabId)) {
    await chrome.storage.local.remove(PANEL_TARGET_TAB_KEY);
    await loadConversationForTab(requestedTabId as number);
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    hideLoading();
    showToast(t("popup.error.noTab"), 4000);
    return;
  }
  await loadConversationForTab(tab.id);
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (
    message.type === "PANEL_TARGET_TAB_REQUESTED" &&
    Number.isInteger(message.tabId)
  ) {
    void chrome.storage.local.remove(PANEL_TARGET_TAB_KEY);
    void loadConversationForTab(message.tabId as number);
    return false;
  }

  if (
    message.type === "EXPORT_PROGRESS" &&
    typeof message.collected === "number" &&
    sender.tab?.id === sourceTabId
  ) {
    if (message.stage === "images") {
      const completed = typeof message.completed === "number" ? message.completed : 0;
      const total = typeof message.total === "number" ? message.total : 0;
      loadingMessage.textContent = total > 0
        ? `${t("popup.loadingImages")} (${completed}/${total})`
        : t("popup.loadingImages");
    } else {
      loadingMessage.textContent = `${t("popup.loading")} (${message.collected})`;
    }
  }

  if (message.type === "DOWNLOAD_COMPLETE") {
    void sendToPage({
      type: "SHOW_EXPORT_SUCCESS",
      message: t("popup.toast.exported"),
    });
  }
  return false;
});

void init();

// -----------------------------------------------------------------------
// DOWNLOAD COMPLETE → show a brief success toast on the page
// -----------------------------------------------------------------------

async function sendToPage(message: object): Promise<void> {
  if (sourceTabId === null) return;
  chrome.tabs.sendMessage(sourceTabId, message).catch(() => { /* tab may be gone */ });
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
  void copyMessages(conversationData.messages, { title: pageTitle });
});

copyMenuToggle.addEventListener("click", () => {
  if (settings?.keepCopyOptionsOpen) return;
  const open = copyMenuToggle.getAttribute("aria-expanded") !== "true";
  setCopyOptionsExpanded(open);
});

copyLatestBtn.addEventListener("click", () => {
  closeCopyOptions();
  if (!settings?.keepCopyOptionsOpen) copyMenuToggle.focus();
  void copyLatestAnswer();
});

async function copyLatestAnswer(): Promise<void> {
  const tabId = sourceTabId;
  const copySettings = settings;
  const requestId = loadSequence;
  if (tabId === null || !copySettings) {
    showToast(t("popup.error.loadFailed"));
    return;
  }

  setBusy(true);
  showLoading(t("popup.loading"));
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url?.startsWith("https://chatgpt.com/")) {
      throw new Error(t("popup.error.notChatGpt"));
    }

    // Copying text does not need export-only image fallbacks. Excluding them
    // also prevents an older unpaired generated image from appearing after
    // the latest text answer and being mistaken for that answer.
    const response = await requestConversation(
      tabId,
      false,
      false,
      false,
      undefined,
      true,
    );
    if (requestId !== loadSequence || sourceTabId !== tabId) return;
    if (!response?.success || !response.data) {
      throw new Error(response?.error ?? t("popup.error.loadFailed"));
    }
    if (response.data.messages.length === 0) {
      throw new Error(t("popup.error.noMessages"));
    }

    conversationData = response.data;
    pageTitle = tab.title ?? pageTitle;
    const latestAnswer = [...response.data.messages]
      .reverse()
      .find((message) =>
        message.role === "assistant" && message.content.trim().length > 0
      );
    if (!latestAnswer) {
      showToast(t("popup.error.noAssistantAnswer"));
      return;
    }

    hideLoading();
    await copyMessages([latestAnswer], { includeRoleHeadings: false });
  } catch (error) {
    if (requestId !== loadSequence || sourceTabId !== tabId) return;
    devError("Failed to refresh conversation for latest-answer copy:", error);
    const message = error instanceof Error ? error.message : "";
    showToast(message || t("popup.error.loadFailed"), 5000);
  } finally {
    if (requestId === loadSequence && sourceTabId === tabId) {
      hideLoading();
      setBusy(false);
    }
  }
}

copySelectBtn.addEventListener("click", () => {
  closeCopyOptions();
  if (!conversationData) {
    showToast(t("popup.error.loadFailed"));
    return;
  }
  openSelector(false);
});

function closeCopyOptions(): void {
  setCopyOptionsExpanded(false);
}

function setCopyOptionsExpanded(expanded: boolean): void {
  const keepExpanded = settings?.keepCopyOptionsOpen === true;
  const isExpanded = keepExpanded || expanded;
  copyOptions.hidden = !isExpanded;
  copyControl.classList.toggle("open", isExpanded);
  copyMenuToggle.setAttribute("aria-expanded", String(isExpanded));
  const ariaLabelKey = keepExpanded
    ? "popup.copyOptions.alwaysOpen"
    : "popup.copyOptions.toggle";
  copyMenuToggle.dataset.i18nAriaLabel = ariaLabelKey;
  copyMenuToggle.setAttribute("aria-label", t(ariaLabelKey));
  copyMenuToggle.setAttribute("aria-disabled", String(keepExpanded));
}

function applyCopyOptionsPreference(): void {
  setCopyOptionsExpanded(
    copyMenuToggle.getAttribute("aria-expanded") === "true",
  );
}

document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    !copyOptions.hidden &&
    !settings?.keepCopyOptionsOpen
  ) {
    closeCopyOptions();
    copyMenuToggle.focus();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !settings) return;
  if (changes.keepCopyOptionsOpen) {
    const wasExpanded = !copyOptions.hidden;
    settings = {
      ...settings,
      keepCopyOptionsOpen: changes.keepCopyOptionsOpen.newValue === true,
    };
    setCopyOptionsExpanded(wasExpanded);
  }
  if (changes.selectorOrder) {
    settings = {
      ...settings,
      selectorOrder: changes.selectorOrder.newValue === "oldest-first"
        ? "oldest-first"
        : "newest-first",
    };
  }
});

// -----------------------------------------------------------------------
// EXPORT BUTTON → open selector
// -----------------------------------------------------------------------

exportBtn.addEventListener("click", () => {
  closeCopyOptions();
  if (!conversationData || !settings || sourceTabId === null) {
    showToast(t("popup.error.loadFailed"));
    return;
  }
  void refreshConversationForExport();
});

async function refreshConversationForExport(): Promise<void> {
  const requestId = loadSequence;
  const tabId = sourceTabId;
  if (!settings || tabId === null) return;

  setBusy(true);
  showLoading(t("popup.loading"));
  try {
    const exportSettings = await loadSettings();
    if (requestId !== loadSequence || sourceTabId !== tabId) return;
    settings = exportSettings;
    const response = await requestConversation(
      tabId,
      exportSettings.downloadImages,
      exportSettings.includeGeneratedImages,
      false,
      undefined,
      true,
    );
    if (requestId !== loadSequence || sourceTabId !== tabId) return;
    if (!response?.success || !response.data) {
      throw new Error(response?.error ?? t("popup.error.loadFailed"));
    }
    if (response.data.messages.length === 0) {
      throw new Error(t("popup.error.noMessages"));
    }

    const tab = await chrome.tabs.get(tabId);
    if (requestId !== loadSequence || sourceTabId !== tabId) return;
    conversationData = response.data;
    pageTitle = tab.title ?? pageTitle;
    openSelector(true);
  } catch (error) {
    if (requestId !== loadSequence || sourceTabId !== tabId) return;
    const message = error instanceof Error ? error.message : "";
    devError("Failed to refresh conversation for export:", error);
    showToast(message || t("popup.error.loadFailed"), 5000);
  } finally {
    if (requestId === loadSequence && sourceTabId === tabId) {
      hideLoading();
      setBusy(false);
    }
  }
}

// -----------------------------------------------------------------------
// SELECTOR LOGIC
// -----------------------------------------------------------------------

function openSelector(
  selectAll = false,
  selectedIds?: ReadonlySet<string>,
): void {
  if (!conversationData) return;
  closeCopyOptions();
  const orderedMessages = settings?.selectorOrder === "oldest-first"
    ? conversationData.messages
    : [...conversationData.messages].reverse();
  populateSelector(orderedMessages, selectAll, selectedIds);
  document.body.classList.add("overlay-open");
  selectorOverlay.classList.add("open");
  updateSelectorCount();
  const firstCheckbox = getCheckboxes()[0];
  if (firstCheckbox) {
    firstCheckbox.focus({ preventScroll: true });
    selList.scrollTop = 0;
  } else {
    selCancelBtn.focus();
  }
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

function populateSelector(
  messages: ExportMessage[],
  selectAll: boolean,
  selectedIds?: ReadonlySet<string>,
): void {
  selList.innerHTML = "";
  const expanded = selExpandToggle.checked;
  selList.classList.toggle("expanded", expanded);

  for (const msg of messages) {
    const item = document.createElement("div");
    item.className = "selector-row";
    item.setAttribute("role", "listitem");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selectedIds ? selectedIds.has(msg.id) : selectAll;
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

async function hydrateSelectedImages(
  messages: ExportMessage[],
): Promise<{
  messages: ExportMessage[];
  images: ExportImageFile[];
  imageDiagnostics?: ImageExportDiagnostics;
  messageQuestionNumbersById?: Record<string, number>;
}> {
  if (!settings?.downloadImages || sourceTabId === null) {
    return { messages, images: [] };
  }

  showLoading(t("popup.loadingImages"));
  try {
    const response = await requestConversation(
      sourceTabId,
      true,
      settings.includeGeneratedImages,
      true,
      messages.map((message) => message.id),
    );
    if (!response?.success || !response.data) {
      const reason = response?.error ?? t("popup.error.loadFailed");
      if (response?.imageDiagnostics) {
        throw new ImageExportFailure(
          reason,
          response.imageDiagnostics,
          response.imageDiagnostics.failure?.stage ?? "conversation-image-load",
        );
      }
      throw new Error(reason);
    }

    return selectHydratedExport(
      response.data,
      new Set(messages.map((message) => message.id)),
    );
  } finally {
    hideLoading();
  }
}

function buildImageExportDiagnosticsForArchive(
  source: ImageExportDiagnostics | undefined,
  markdown: string,
  images: ExportImageFile[],
  messages: ExportMessage[],
  messageQuestionNumbersById?: Record<string, number>,
): ImageExportDiagnostics | undefined {
  if (!source) return undefined;

  const diagnostics: ImageExportDiagnostics = {
    ...source,
    events: [...source.events],
    messages: source.messages.map((message) => ({
      ...message,
      imageResourceKinds: [...message.imageResourceKinds],
      downloadedPaths: [...message.downloadedPaths],
      downloadFailures: [...message.downloadFailures],
    })),
  };
  const markdownImageReferences = [
    ...[...markdown.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)]
      .map((match) => match[1])
      .filter((path) => path.startsWith("images/")),
    ...[...markdown.matchAll(/!\[[^\]]*\]\((images\/[^)\s]+)\)/gi)]
      .map((match) => match[1]),
  ];
  const markdownImagePaths = [...new Set(markdownImageReferences)];
  const referencedPaths = new Set(markdownImagePaths);
  const bundledPaths = new Set(images.map((image) => image.path));
  const missingReferencedImagePaths = markdownImagePaths.filter((path) =>
    !bundledPaths.has(path)
  );
  const unreferencedBundledImagePaths = images
    .map((image) => image.path)
    .filter((path) => !referencedPaths.has(path));
  const unresolvedSandboxReferenceCount =
    [...markdown.matchAll(/sandbox:\/mnt\/data\//gi)].length;
  const downloadFailureNoticeCount =
    [...markdown.matchAll(/\[\d+ images? could not be downloaded:/gi)].length;
  const notBundledNoticeCount = [...markdown.matchAll(/\[Image not bundled:/gi)].length;
  const questionCount = [...markdown.matchAll(/^## Question \d+\s*$/gm)].length;
  const questionMessages = new Map<number, ExportMessage[]>();
  const sourceQuestionsByExportQuestion = new Map<number, Set<number>>();
  let exportQuestionNumber = 0;
  for (const message of messages) {
    if (message.role === "user") exportQuestionNumber++;
    if (exportQuestionNumber === 0) exportQuestionNumber = 1;
    const group = questionMessages.get(exportQuestionNumber) ?? [];
    group.push(message);
    questionMessages.set(exportQuestionNumber, group);
    const sourceQuestionNumber = messageQuestionNumbersById?.[message.id];
    if (sourceQuestionNumber !== undefined) {
      const sourceQuestions = sourceQuestionsByExportQuestion.get(exportQuestionNumber) ??
        new Set<number>();
      sourceQuestions.add(sourceQuestionNumber);
      sourceQuestionsByExportQuestion.set(exportQuestionNumber, sourceQuestions);
    }
  }
  const questions = [...questionMessages].map(([number, exportMessages]) => {
    const sourceQuestionNumbers = [...(sourceQuestionsByExportQuestion.get(number) ?? [])]
      .sort((a, b) => a - b);
    const sourceQuestions = new Set(sourceQuestionNumbers);
    const scannedMessages = diagnostics.messages.filter((message) =>
      message.questionNumber !== null && sourceQuestions.has(message.questionNumber)
    );
    const uniquePaths = (paths: string[]): string[] => [...new Set(paths)];
    return {
      exportQuestionNumber: number,
      sourceQuestionNumbers,
      userImageResourcesDetected: scannedMessages
        .filter((message) => message.role === "user")
        .reduce((sum, message) => sum + message.imageResourceCount, 0),
      assistantImageResourcesDetected: scannedMessages
        .filter((message) => message.role === "assistant" || message.role === "tool")
        .reduce((sum, message) => sum + message.imageResourceCount, 0),
      imageDownloadAttempts: scannedMessages.reduce(
        (sum, message) => sum + message.downloadAttemptedCount,
        0,
      ),
      imageDownloadFailures: scannedMessages.flatMap((message) =>
        message.downloadFailures.map((reason) => `${message.role}: ${reason}`)
      ),
      downloadedImagePaths: uniquePaths(scannedMessages.flatMap((message) =>
        message.downloadedPaths
      )),
      exportedImagePaths: uniquePaths(exportMessages.flatMap((message) =>
        message.imagePaths
      )),
      sandboxReferenceCount: scannedMessages.reduce(
        (sum, message) => sum + message.sandboxReferenceCount,
        0,
      ),
      downloadFailureNoticeCount: exportMessages.reduce(
        (sum, message) => sum + [...message.content.matchAll(
          /\[\d+ images? could not be downloaded:/gi,
        )].length,
        0,
      ),
      notBundledNoticeCount: exportMessages.reduce(
        (sum, message) => sum + [...message.content.matchAll(/\[Image not bundled:/gi)].length,
        0,
      ),
    };
  });
  const archive = {
    questionCount,
    questions,
    markdownImageReferenceCount: markdownImageReferences.length,
    markdownImagePaths,
    missingReferencedImagePaths,
    unreferencedBundledImagePaths,
    unresolvedSandboxReferenceCount,
    downloadFailureNoticeCount,
    notBundledNoticeCount,
    bundledImages: images.map((image) => ({
      path: image.path,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
    })),
  };
  diagnostics.archive = archive;
  diagnostics.events.push({
    elapsedMs: Math.max(0, Date.now() - Date.parse(diagnostics.startedAt)),
    stage: "zip-assembly",
    details: {
      questionCount,
      markdownImageReferenceCount: markdownImageReferences.length,
      imageFileCount: images.length,
      missingReferencedImagePaths,
      unreferencedBundledImagePaths,
      unresolvedSandboxReferenceCount,
      downloadFailureNoticeCount,
      notBundledNoticeCount,
      diagnosticsSidecarIncluded: true,
    },
  });
  return diagnostics;
}

async function prepareDiagramMessages(
  messages: ExportMessage[],
  mode: SvgDiagramMode,
): Promise<{ messages: ExportMessage[]; assets: ExportImageFile[] }> {
  if (mode === "none") {
    // Even when diagram rendering is disabled, normalize ChatGPT component
    // markup so unsupported widgets such as <LearningViz .../> do not leak
    // into the exported Markdown as broken pseudo-code.
    return {
      messages: messages.map((message) => ({
        ...message,
        content: normalizeChatGptComponents(message.content),
      })),
      assets: [],
    };
  }

  const prepared: ExportMessage[] = [];
  const assets: ExportImageFile[] = [];

  for (const message of messages) {
    const sourceContent = mode === "assets"
      ? message.imageMarkdownContent ?? message.content
      : message.content;
    const pageRendered = message.renderedDiagramPaths?.length
      ? replaceSvgTemplatesWithRenderedImages(
          sourceContent,
          message.renderedDiagramPaths,
          mode,
        )
      : null;
    const rendered = pageRendered !== null
      ? { markdown: pageRendered, assets: [] }
      : await renderSvgTemplatesAsMarkdown(
          sourceContent,
          mode,
          assets.length + 1,
          message.svgBackgroundColor,
        );
    prepared.push({
      ...message,
      content: normalizeChatGptComponents(rendered.markdown),
    });
    assets.push(...rendered.assets);
  }

  return { messages: prepared, assets };
}

// -----------------------------------------------------------------------
// FORMAT + DOWNLOAD
// -----------------------------------------------------------------------

async function exportSelected(): Promise<void> {
  if (!settings || !conversationData) return;

  let chosen = getSelectedMessages();
  if (chosen.length === 0) return;

  let imageDiagnostics: ImageExportDiagnostics | undefined;
  setBusy(true);
  closeSelector();

  try {
    settings = await loadSettings();
    const fmt = selFormatSelect.value as ExportFormat;
    const diagramMode: SvgDiagramMode =
      fmt === "md" ? "assets" : fmt === "txt" ? "text" : "none";

    let selectedImages: ExportImageFile[] = [];
    let messageQuestionNumbersById: Record<string, number> | undefined;
    if (fmt === "md" && settings.downloadImages && sourceTabId !== null) {
      const hydrated = await hydrateSelectedImages(chosen);
      chosen = hydrated.messages;
      selectedImages = hydrated.images;
      imageDiagnostics = hydrated.imageDiagnostics;
      messageQuestionNumbersById = hydrated.messageQuestionNumbersById;
    }

    const prepared = await prepareDiagramMessages(chosen, diagramMode);
    const exportMessages = prepared.messages;
    const images = [...selectedImages, ...prepared.assets];
    const hasImages = images.length > 0;
    const exportTime = new Date();

    let filename: string;
    let blob: Blob;

    if (fmt === "md" && (hasImages || imageDiagnostics)) {
      // Bundle Markdown + images into ZIP
      const md = formatMarkdown(exportMessages, settings, { title: pageTitle });
      const mdFilename = buildFilename(pageTitle, "md", settings.filenameTemplate, exportTime);
      filename = buildFilename(pageTitle, "zip", settings.filenameTemplate, exportTime);
      const archiveDiagnostics = buildImageExportDiagnosticsForArchive(
        imageDiagnostics,
        md,
        images,
        exportMessages,
        messageQuestionNumbersById,
      );
      blob = buildZipBlob(md, mdFilename, images, archiveDiagnostics);
    } else {
      let text: string;
      let ext: string;

      switch (fmt) {
        case "md":
          text = formatMarkdown(exportMessages, settings, { title: pageTitle });
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
          text = formatMarkdown(chosen, settings, { title: pageTitle });
          ext = "md";
      }

      filename = buildFilename(pageTitle, ext, settings.filenameTemplate, exportTime);
      blob = new Blob([text], { type: getExportMimeType(fmt) });
    }

    const objectUrl = URL.createObjectURL(blob);

    const dlResponse = await chrome.runtime.sendMessage({
      type: "TRACKED_DOWNLOAD",
      url: objectUrl,
      filename: settings.promptToSave
        ? filename
        : buildDownloadPath(filename, settings.downloadSubfolder),
      saveAs: settings.promptToSave,
    }) as { success?: boolean; error?: string } | undefined;
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);

    if (!dlResponse?.success) {
      const reason = dlResponse?.error ??
        "Chrome did not start the export download.";
      throw new ImageExportFailure(reason, imageDiagnostics, "archive-download");
    }

    showToast(t("popup.toast.downloadStarted"));

  } catch (err) {
    hideLoading();
    devError("Export failed:", err);
    const diagnostics = err instanceof ImageExportFailure
      ? err.imageDiagnostics ?? imageDiagnostics
      : imageDiagnostics;
    const reason = safeImageExportFailure(err);
    if (diagnostics) {
      diagnostics.failure = {
        stage: err instanceof ImageExportFailure ? err.stage : "export",
        reason,
      };
      try {
        const reportFilename = await downloadImageDiagnostics(diagnostics);
        showToast(
          `${t("popup.toast.exportFailedDiagnosticsSaved")} ${reportFilename} — ${reason}`,
          9000,
        );
      } catch (diagnosticError) {
        const reportReason = safeImageExportFailure(diagnosticError);
        showToast(
          `${t("popup.toast.downloadFailed")}: ${reason}. Diagnostic report also failed: ${reportReason}`,
          9000,
        );
      }
    } else {
      showToast(`${t("popup.toast.downloadFailed")}: ${reason}`, 6000);
    }
  } finally {
    setBusy(false);
  }
}

async function copySelected(): Promise<void> {
  if (!settings || !conversationData) return;

  let chosen = getSelectedMessages();
  if (chosen.length === 0) return;

  await copyMessages(chosen, { title: pageTitle });
}

async function copyMessages(
  messages: ExportMessage[],
  options: { includeRoleHeadings?: boolean; title?: string } = {},
): Promise<void> {
  if (!settings || messages.length === 0) return;

  setBusy(true);
  closeSelector();

  try {
    const prepared = await prepareDiagramMessages(messages, "text");
    const markdown = formatMarkdown(prepared.messages, settings, options);
    if (!markdown.trim()) {
      showToast(t("popup.error.noCopyableContent"));
      return;
    }
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
  githubReturnSelection = new Set(getCheckedIds());
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
  openSelector(false, githubReturnSelection ?? new Set());
  githubReturnSelection = null;
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

  let chosen = getSelectedMessages();
  if (chosen.length === 0) return;

  setBusy(true);
  githubPanelSave.textContent = t("popup.github.saving");

  try {
    const hydrated = await hydrateSelectedImages(chosen);
    chosen = hydrated.messages;
    const prepared = await prepareDiagramMessages(chosen, "assets");
    const images = [...hydrated.images, ...prepared.assets];
    const hasImages = images.length > 0;
    const exportTime = new Date();

    const md = formatMarkdown(prepared.messages, settings, { title: pageTitle });
    const mdFilename = buildFilename(pageTitle, "md", settings.filenameTemplate, exportTime);

    let filename: string;
    let content: string;
    let isBinary = false;

    if (hasImages) {
      filename = buildFilename(pageTitle, "zip", settings.filenameTemplate, exportTime);
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
    tabId: sourceTabId ?? undefined,
  }) as { success?: boolean; error?: string } | undefined;

  if (!response?.success) {
    throw new Error(response?.error ?? "Clipboard write was denied.");
  }
}
