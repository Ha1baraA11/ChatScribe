/**
 * background.ts — ChatScribe
 *
 * Service worker (background script) for Chrome MV3.
 *
 * Handles:
 *   - Offscreen document management for clipboard writes
 *   - chrome.downloads tracking (for the DOWNLOAD_COMPLETE message)
 *   - GitHub Device Flow auth (must live here so the poll survives popup closure)
 *   - GitHub API proxy (list repos, save file, status, disconnect)
 *
 * All handlers validate that messages come from within the extension.
 */

import {
  startDeviceFlow,
  pollForToken,
  getCurrentUser,
  listUserRepos,
  saveFileToRepo,
  disconnectGitHub,
  getStoredToken,
} from "./github.ts";

// -----------------------------------------------------------------------
// DEV LOGGING
// -----------------------------------------------------------------------

const devLog = (...args: unknown[]): void => {
  if (import.meta.env.DEV) console.log("[ChatScribe bg]", ...args);
};

const devError = (...args: unknown[]): void => {
  if (import.meta.env.DEV) console.error("[ChatScribe bg]", ...args);
};

const chromeCapabilities = chrome as unknown as {
  offscreen?: { createDocument?: unknown };
  runtime: { getContexts?: unknown };
  sidePanel?: {
    open?: (options: { windowId: number }) => Promise<void>;
    setPanelBehavior?: (behavior: {
      openPanelOnActionClick: boolean;
    }) => Promise<void>;
  };
  sidebarAction?: { open?: () => Promise<void> };
  action?: {
    onClicked?: {
      addListener: (listener: (tab: chrome.tabs.Tab) => void) => void;
    };
    setPopup?: (details: { popup: string }) => Promise<void> | void;
  };
  scripting?: {
    executeScript: (details: {
      target: { tabId: number };
      files: string[];
    }) => Promise<unknown[]>;
  };
};

type PanelMode = "popup" | "sidebar";

function isPanelMode(value: unknown): value is PanelMode {
  return value === "popup" || value === "sidebar";
}

// Keep the popup as the default. The selected sidebar mode removes the action
// popup so the toolbar click can open the browser's persistent panel instead.
async function applyPanelMode(mode: PanelMode): Promise<void> {
  const setPopup = chromeCapabilities.action?.setPopup;
  if (setPopup) {
    await Promise.resolve(setPopup({
      popup: mode === "sidebar" ? "" : "popup.html",
    }));
  }

  // Older Chrome versions can open the configured side panel natively, but do
  // not expose sidePanel.open().
  if (!chromeCapabilities.sidePanel?.open && chromeCapabilities.sidePanel?.setPanelBehavior) {
    await chromeCapabilities.sidePanel.setPanelBehavior({
      openPanelOnActionClick: mode === "sidebar",
    });
  }
}

function readAndApplyPanelMode(): void {
  void chrome.storage.sync.get("panelMode")
    .then(({ panelMode }) => applyPanelMode(isPanelMode(panelMode) ? panelMode : "popup"))
    .catch((error: unknown) => devError("Could not load the panel setting:", error));
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes.panelMode) return;
  void applyPanelMode(
    isPanelMode(changes.panelMode.newValue) ? changes.panelMode.newValue : "popup",
  ).catch((error: unknown) => devError("Could not apply the panel setting:", error));
});

readAndApplyPanelMode();
chrome.runtime.onStartup.addListener(readAndApplyPanelMode);
chrome.runtime.onInstalled.addListener(readAndApplyPanelMode);

// Keep the export UI open while users switch tabs. Chrome and Firefox expose
// different persistent panel APIs, so each browser uses its native surface.
function rememberPanelTarget(tabId: number | undefined): void {
  if (tabId === undefined) return;
  void chrome.storage.local.set({ chatscribePanelTargetTabId: tabId })
    .then(() => chrome.runtime.sendMessage({
      type: "PANEL_TARGET_TAB_REQUESTED",
      tabId,
    }).catch(() => {
      /* The panel may not have opened yet; it reads the saved tab on startup. */
    }))
    .catch((error: unknown) => devError("Could not save the panel tab:", error));
}

if (chromeCapabilities.action?.onClicked) {
  chromeCapabilities.action.onClicked.addListener((tab) => {
    // The browser only dispatches this event when no action popup is configured.
    // That makes the browser's current click surface authoritative even after
    // the MV3 service worker has been suspended and restarted.
    if (chromeCapabilities.sidePanel?.open) {
      if (tab.windowId === undefined) return;
      void chromeCapabilities.sidePanel.open({ windowId: tab.windowId })
        .catch((error: unknown) => devError("Could not open the side panel:", error));
    } else if (chromeCapabilities.sidebarAction?.open) {
      void Promise.resolve(chromeCapabilities.sidebarAction.open())
        .catch((error: unknown) => devError("Could not open the sidebar:", error));
    }

    rememberPanelTarget(tab.id);
  });
}

// -----------------------------------------------------------------------
// SENDER VALIDATION
// -----------------------------------------------------------------------

function isOwnExtension(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id;
}

// -----------------------------------------------------------------------
// OFFSCREEN DOCUMENT (for clipboard)
// -----------------------------------------------------------------------

let offscreenCreating: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
  });

  if (existing.length > 0) return;

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: "Copy conversation text to clipboard",
    })
    .finally(() => {
      offscreenCreating = null;
    });

  await offscreenCreating;
}

// -----------------------------------------------------------------------
// DOWNLOAD TRACKING
// -----------------------------------------------------------------------

const pendingDownloads = new Set<number>();

chrome.downloads.onChanged.addListener((delta) => {
  if (!pendingDownloads.has(delta.id)) return;

  if (delta.state?.current === "complete") {
    pendingDownloads.delete(delta.id);

    // Notify the popup so it can show a brief success toast on the page
    chrome.runtime.sendMessage({ type: "DOWNLOAD_COMPLETE" }).catch(() => {
      /* popup may have closed — fine */
    });
  } else if (
    delta.state?.current === "interrupted" ||
    delta.error?.current
  ) {
    pendingDownloads.delete(delta.id);
  }
});

// -----------------------------------------------------------------------
// INPUT VALIDATION HELPERS
// -----------------------------------------------------------------------

/** Validates a GitHub full repo name like "user/repo". */
function isValidRepoName(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+$/.test(v) &&
    v.length <= 200
  );
}

/** Validates a file name (no directory traversal). */
function isValidFilename(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= 200 &&
    !/[/\\<>:"|?*\x00-\x1f]/.test(v)
  );
}

/** Validates a base64-encoded content string (text or binary export). */
function isValidContent(v: unknown): v is string {
  return typeof v === "string" && v.length <= 10_000_000;
}

// -----------------------------------------------------------------------
// MESSAGE HANDLERS
// -----------------------------------------------------------------------

// --- ENSURE CONTENT SCRIPT ---
// A page may have been open before ChatScribe was installed or updated. Inject
// only after a ping confirms that its isolated-world listener is absent.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "ENSURE_CONTENT_SCRIPT") return false;
  if (!isOwnExtension(sender)) return false;

  const tabId = message.tabId;
  if (!Number.isInteger(tabId)) {
    sendResponse({ success: false, error: "Invalid ChatGPT tab." });
    return false;
  }

  (async () => {
    try {
      const tab = await chrome.tabs.get(tabId as number);
      if (!tab.url?.startsWith("https://chatgpt.com/")) {
        throw new Error("Open a ChatGPT conversation before exporting.");
      }

      try {
        const ping = await chrome.tabs.sendMessage(tab.id!, {
          type: "CHATSCRIBE_PING",
        }) as { ready?: boolean } | undefined;
        if (ping?.ready) {
          sendResponse({ success: true });
          return;
        }
      } catch {
        // The content script is not present in this tab yet.
      }

      if (!chromeCapabilities.scripting?.executeScript) {
        throw new Error("This browser cannot reconnect ChatScribe without reloading the page.");
      }

      await chromeCapabilities.scripting.executeScript({
        target: { tabId: tab.id! },
        files: ["content.js"],
      });

      const ping = await chrome.tabs.sendMessage(tab.id!, {
        type: "CHATSCRIBE_PING",
      }) as { ready?: boolean } | undefined;
      if (!ping?.ready) throw new Error("ChatScribe could not reconnect to this tab.");
      sendResponse({ success: true });
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return true;
});

// --- CLIPBOARD COPY ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "COPY_TO_CLIPBOARD") return false;
  if (!isOwnExtension(sender)) return false;

  (async () => {
    try {
      let result: { success: boolean; error?: string } | undefined;

      if (
        chromeCapabilities.offscreen?.createDocument &&
        chromeCapabilities.runtime.getContexts
      ) {
        await ensureOffscreenDocument();
        result = await chrome.runtime.sendMessage({
          type: "OFFSCREEN_COPY",
          text: message.text,
        });
      } else {
        // Firefox does not expose Chrome's Offscreen API. Copy through the
        // ChatGPT tab currently represented by the persistent panel, which
        // may no longer be the browser's active tab.
        const tabId = message.tabId;
        if (!Number.isInteger(tabId)) {
          throw new Error("No ChatGPT tab is available for clipboard access.");
        }
        const tab = await chrome.tabs.get(tabId as number);
        if (!tab.url?.startsWith("https://chatgpt.com/")) {
          throw new Error("Open a ChatGPT conversation before copying.");
        }
        result = await chrome.tabs.sendMessage(tabId as number, {
          type: "COPY_TO_CLIPBOARD",
          text: message.text,
        });
      }

      sendResponse(result);
    } catch (err) {
      devError("Clipboard copy failed:", err);
      sendResponse({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  return true;
});

// --- TRACKED DOWNLOAD ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "TRACKED_DOWNLOAD") return false;
  if (!isOwnExtension(sender)) return false;

  const { url, filename, saveAs } = message as {
    url: string;
    filename: string;
    saveAs: boolean;
  };

  chrome.downloads.download(
    { url, filename, saveAs },
    (downloadId) => {
      if (downloadId !== undefined) {
        pendingDownloads.add(downloadId);
      }
      sendResponse({ success: downloadId !== undefined, downloadId });
    },
  );

  return true;
});

// --- GITHUB: START AUTH ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "GITHUB_START_AUTH") return false;
  if (!isOwnExtension(sender)) return false;

  (async () => {
    try {
      const flow = await startDeviceFlow();

      // Return the user_code immediately so UI can display it
      sendResponse({
        success: true,
        data: {
          userCode: flow.user_code,
          verificationUri: flow.verification_uri,
        },
      });

      // Poll in background — survives popup closure
      try {
        await pollForToken(flow.device_code, flow.interval, flow.expires_in);
        chrome.runtime
          .sendMessage({ type: "GITHUB_AUTH_COMPLETE", success: true })
          .catch(() => { /* no listener — fine */ });
      } catch (pollErr) {
        chrome.runtime
          .sendMessage({
            type: "GITHUB_AUTH_COMPLETE",
            success: false,
            error: pollErr instanceof Error ? pollErr.message : String(pollErr),
          })
          .catch(() => { /* no listener */ });
      }
    } catch (err) {
      sendResponse({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  return true;
});

// --- GITHUB: CONNECTION STATUS ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "GITHUB_GET_STATUS") return false;
  if (!isOwnExtension(sender)) return false;

  (async () => {
    try {
      const token = await getStoredToken();
      if (!token) {
        sendResponse({ success: true, data: { connected: false } });
        return;
      }

      // Try to fetch user info to confirm token is valid
      const user = await getCurrentUser();
      sendResponse({ success: true, data: { connected: true, login: user.login } });
    } catch {
      // Token invalid — report as disconnected
      sendResponse({ success: true, data: { connected: false } });
    }
  })();

  return true;
});

// --- GITHUB: DISCONNECT ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "GITHUB_DISCONNECT") return false;
  if (!isOwnExtension(sender)) return false;

  void disconnectGitHub().then(() => {
    sendResponse({ success: true });
  });

  return true;
});

// --- GITHUB: LIST REPOS ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "GITHUB_LIST_REPOS") return false;
  if (!isOwnExtension(sender)) return false;

  (async () => {
    try {
      const repos = await listUserRepos();
      sendResponse({ success: true, data: repos });
    } catch (err) {
      sendResponse({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  return true;
});

// --- GITHUB: SAVE FILE ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "GITHUB_SAVE_FILE") return false;
  if (!isOwnExtension(sender)) return false;

  const { fullName, filename, content, isBinary } = message as {
    fullName: unknown;
    filename: unknown;
    content: unknown;
    isBinary: unknown;
  };

  if (
    !isValidRepoName(fullName) ||
    !isValidFilename(filename) ||
    !isValidContent(content)
  ) {
    sendResponse({ success: false, error: "Invalid save request." });
    return true;
  }

  (async () => {
    try {
      const result = await saveFileToRepo(
        fullName,
        filename,
        content,
        isBinary === true,
      );
      sendResponse({ success: true, data: result });
    } catch (err) {
      devError("GitHub save failed:", err);
      sendResponse({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  return true;
});

devLog("Background service worker started");
