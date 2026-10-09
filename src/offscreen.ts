/**
 * offscreen.ts — ChatScribe
 *
 * Runs inside the offscreen document (offscreen.html).
 * Handles clipboard writes that require a document context
 * (not available in the background service worker).
 */

chrome.runtime.onMessage.addListener(
  (
    message: { type?: string; text?: string },
    sender,
    sendResponse,
  ) => {
    if (message.type !== "OFFSCREEN_COPY") return false;
    if (sender.id !== chrome.runtime.id) return false;

    const text = message.text ?? "";

    void (async () => {
      try {
        if (navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(text);
            sendResponse({ success: true });
            return;
          } catch {
            // Fall back to the offscreen document's selected textarea.
          }
        }

        const helper = document.getElementById(
          "clipboard-helper",
        ) as HTMLTextAreaElement | null;
        if (!helper) throw new Error("Clipboard helper is unavailable.");

        helper.value = text;
        helper.focus();
        helper.select();
        const copied = document.execCommand("copy");
        helper.value = "";
        if (!copied) throw new Error("Clipboard write was denied.");

        sendResponse({ success: true });
      } catch (err) {
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return true; // Keep channel open
  },
);
