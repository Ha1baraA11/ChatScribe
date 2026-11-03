/**
 * Claude web content script, injected only after the user grants optional
 * access to claude.ai. Claude has no equivalent of ChatGPT's MAIN-world bridge;
 * this script reads the signed-in page's same-origin conversation API.
 */

import {
  CHATSCRIBE_BUILD_ID,
  CONTENT_CHECK_REVISION_TYPE,
  CONTENT_CONVERSATION_CHANGED_TYPE,
  CONTENT_LOAD_TYPE,
  CONTENT_PING_TYPE,
  CONTENT_WATCH_CONVERSATION_TYPE,
} from "./content-protocol.ts";
import { getClaudeConversationId, parseClaudeConversation } from "./claude-conversation.ts";
import type { ConversationData, ExportImageFile, ExportMessage } from "./types.ts";

const MAX_CONVERSATION_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 200 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const REVISION_SNAPSHOT_TTL_MS = 5_000;

const cleanupWindow = window as Window & {
  __chatScribeClaudeCleanupByBuild?: Map<string, () => void>;
};
const cleanupByBuild = cleanupWindow.__chatScribeClaudeCleanupByBuild ??= new Map();
for (const cleanup of cleanupByBuild.values()) {
  try {
    cleanup();
  } catch {
    // A stale extension context must not block reinjection after an update.
  }
}
cleanupByBuild.clear();

type OrganizationRecord = Record<string, unknown>;

interface ClaudeLoadRequest {
  type: string;
  downloadImages?: boolean;
  fetchImages?: boolean;
  includeClaudeThinking?: boolean;
  selectedMessageIds?: string[];
  text?: string;
  watch?: boolean;
}

interface DownloadedImage {
  image: ExportImageFile;
  path: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function currentConversationId(): string {
  const id = getClaudeConversationId(window.location.href);
  if (!id) throw new Error("Open a regular Claude conversation before exporting.");
  return id;
}

function ensureCurrentConversation(conversationId: string): void {
  if (currentConversationId() !== conversationId) {
    throw new Error("The Claude conversation changed while it was loading.");
  }
}

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

async function fetchJson(path: string): Promise<unknown> {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin || url.protocol !== "https:") {
    throw new Error("Claude returned an unsafe API address.");
  }
  const response = await fetch(url.href, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: timeoutSignal(),
  });
  if (!response.ok) {
    const error = new Error(`CLAUDE_HTTP_${response.status}`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_CONVERSATION_BYTES) {
    throw new Error("This Claude conversation is too large to export safely.");
  }
  const text = await response.text();
  if (text.length > MAX_CONVERSATION_BYTES) {
    throw new Error("This Claude conversation is too large to export safely.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Claude returned an unreadable conversation response.");
  }
}

function getOrganizationIds(value: unknown): string[] {
  const record = asRecord(value);
  const organizations = Array.isArray(value)
    ? value
    : Array.isArray(record?.organizations)
      ? record.organizations
      : [];
  const ids = organizations.flatMap((organizationValue) => {
    const organization = asRecord(organizationValue) as OrganizationRecord | null;
    if (!organization) return [];
    const id = organization.uuid ?? organization.id ?? organization.organization_uuid;
    return typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) ? [id] : [];
  });
  return [...new Set(ids)];
}

function getHttpStatus(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error &&
      typeof error.status === "number"
    ? error.status
    : undefined;
}

async function fetchClaudeConversation(conversationId: string): Promise<unknown> {
  const organizations = getOrganizationIds(await fetchJson("/api/organizations"));
  ensureCurrentConversation(conversationId);
  if (organizations.length === 0) {
    throw new Error("No Claude organization was available in the signed-in session.");
  }

  let notFoundCount = 0;
  for (const organizationId of organizations) {
    const path = `/api/organizations/${encodeURIComponent(organizationId)}` +
      `/chat_conversations/${encodeURIComponent(conversationId)}` +
      // Read the complete message tree from a strongly consistent snapshot.
      "?tree=True&rendering_mode=messages&render_all_tools=true&consistency=strong";
    try {
      const value = await fetchJson(path);
      ensureCurrentConversation(conversationId);
      const record = asRecord(value);
      return asRecord(record?.conversation) ?? value;
    } catch (error) {
      const status = getHttpStatus(error);
      if (status === 404) {
        notFoundCount++;
        continue;
      }
      if (status === 401 || status === 403) {
        throw new Error("Claude did not authorize this conversation. Refresh Claude and retry.");
      }
      throw error;
    }
  }

  if (notFoundCount === organizations.length) {
    throw new Error("Claude could not find this conversation in the signed-in account.");
  }
  throw new Error("Claude could not load this conversation.");
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase().split(";")[0].trim()) {
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/svg+xml": return "svg";
    case "image/avif": return "avif";
    case "image/bmp": return "bmp";
    case "image/tiff": return "tiff";
    default: return "img";
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function downloadImage(url: string, index: number): Promise<DownloadedImage> {
  const parsed = new URL(url, window.location.origin);
  if (parsed.origin !== window.location.origin || parsed.protocol !== "https:") {
    throw new Error("external-host");
  }
  const response = await fetch(parsed.href, {
    credentials: "include",
    cache: "no-store",
    signal: timeoutSignal(),
  });
  if (!response.ok) throw new Error("download-failed");
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_IMAGE_BYTES) throw new Error("image-too-large");
  const blob = await response.blob();
  if (blob.size === 0 || blob.size > MAX_IMAGE_BYTES) {
    throw new Error("image-too-large");
  }
  const mimeType = blob.type.toLowerCase().split(";")[0].trim();
  if (!mimeType.startsWith("image/")) throw new Error("not-an-image");
  const path = `images/claude-image-${String(index).padStart(3, "0")}.${extensionForMimeType(mimeType)}`;
  const image: ExportImageFile = {
    path,
    mimeType,
    base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
    sizeBytes: blob.size,
  };
  return { image, path };
}

async function attachImages(
  messages: ExportMessage[],
  references: Array<{ messageId: string; url: string }>,
  selectedMessageIds?: string[],
): Promise<ExportImageFile[]> {
  const selected = selectedMessageIds ? new Set(selectedMessageIds) : null;
  const eligible = references.filter((reference) => !selected || selected.has(reference.messageId));
  const byUrl = new Map<string, DownloadedImage | null>();
  const failuresByMessage = new Map<string, number>();
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const images: ExportImageFile[] = [];
  let totalBytes = 0;

  for (const reference of eligible) {
    let result = byUrl.get(reference.url);
    if (result === undefined) {
      try {
        const next = await downloadImage(reference.url, images.length + 1);
        if (totalBytes + next.image.sizeBytes > MAX_TOTAL_IMAGE_BYTES) {
          throw new Error("total-too-large");
        }
        totalBytes += next.image.sizeBytes;
        images.push(next.image);
        result = next;
      } catch {
        result = null;
      }
      byUrl.set(reference.url, result);
    }

    if (result) {
      const message = messagesById.get(reference.messageId);
      if (message && !message.imagePaths.includes(result.path)) message.imagePaths.push(result.path);
    } else {
      failuresByMessage.set(
        reference.messageId,
        (failuresByMessage.get(reference.messageId) ?? 0) + 1,
      );
    }
  }

  for (const [messageId, count] of failuresByMessage) {
    const message = messagesById.get(messageId);
    if (message) {
      message.content += `\n\n[${count} image${count === 1 ? "" : "s"} could not be bundled.]`;
    }
  }
  return images;
}

async function readConversation(
  includeThinking: boolean,
  rawValue?: unknown,
  conversationIdValue?: string,
): Promise<{
  data: ConversationData;
  conversationId: string;
  imageReferences: Array<{ messageId: string; url: string }>;
}> {
  const conversationId = conversationIdValue ?? currentConversationId();
  const raw = rawValue ?? await fetchClaudeConversation(conversationId);
  const parsed = parseClaudeConversation(raw, {
    includeThinking,
    expectedConversationId: conversationId,
  });
  return {
    conversationId,
    data: { messages: parsed.messages, images: [], revision: parsed.revision },
    imageReferences: parsed.imageReferences,
  };
}

let revisionSnapshot: {
  conversationId: string;
  raw: unknown;
  createdAt: number;
} | null = null;

async function handleLoad(message: ClaudeLoadRequest): Promise<ConversationData> {
  const conversationId = currentConversationId();
  const snapshot = revisionSnapshot &&
      revisionSnapshot.conversationId === conversationId &&
      Date.now() - revisionSnapshot.createdAt <= REVISION_SNAPSHOT_TTL_MS
    ? revisionSnapshot
    : null;
  revisionSnapshot = null;
  const { data, imageReferences } = await readConversation(
    message.includeClaudeThinking === true,
    snapshot?.raw,
    conversationId,
  );
  if (message.downloadImages === true && message.fetchImages !== false) {
    data.images = await attachImages(data.messages, imageReferences, message.selectedMessageIds);
    ensureCurrentConversation(conversationId);
  }
  return data;
}

async function handleRevision(): Promise<{ conversationId: string; revision: string }> {
  const conversationId = currentConversationId();
  const raw = await fetchClaudeConversation(conversationId);
  const { data } = await readConversation(false, raw, conversationId);
  if (!data.revision) throw new Error("Claude did not return a conversation revision.");
  revisionSnapshot = { conversationId, raw, createdAt: Date.now() };
  return { conversationId, revision: data.revision };
}

let watchObserver: MutationObserver | null = null;
let watchTimer: number | undefined;
let lastWatchLocation = "";

function stopWatching(): void {
  watchObserver?.disconnect();
  watchObserver = null;
  window.clearTimeout(watchTimer);
  watchTimer = undefined;
}

function startWatching(): void {
  if (watchObserver || !document.body) return;
  lastWatchLocation = window.location.href;
  watchObserver = new MutationObserver(() => {
    window.clearTimeout(watchTimer);
    watchTimer = window.setTimeout(() => {
      const conversationId = getClaudeConversationId(window.location.href);
      if (!conversationId) return;
      const locationChanged = lastWatchLocation !== window.location.href;
      lastWatchLocation = window.location.href;
      void chrome.runtime.sendMessage({
        type: CONTENT_CONVERSATION_CHANGED_TYPE,
        conversationId,
        locationChanged,
      }).catch(() => {
        /* The panel may have closed while the page changed. */
      });
    }, 750);
  });
  watchObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
}

function isOwnExtensionMessage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id;
}

const onMessage: Parameters<typeof chrome.runtime.onMessage.addListener>[0] =
  (rawMessage, sender, sendResponse) => {
    if (!isOwnExtensionMessage(sender)) return false;
    const message = rawMessage as ClaudeLoadRequest;

    if (message.type === CONTENT_PING_TYPE) {
      sendResponse({ ready: true, buildId: CHATSCRIBE_BUILD_ID });
      return false;
    }
    if (message.type === CONTENT_WATCH_CONVERSATION_TYPE) {
      if (message.watch === true) startWatching();
      else stopWatching();
      sendResponse({ success: true });
      return false;
    }
    if (message.type === CONTENT_LOAD_TYPE) {
      void handleLoad(message)
        .then((data) => sendResponse({ success: true, data }))
        .catch((error: unknown) => sendResponse({
          success: false,
          error: error instanceof Error ? error.message : "Claude conversation export failed.",
        }));
      return true;
    }
    if (message.type === CONTENT_CHECK_REVISION_TYPE) {
      void handleRevision()
        .then((data) => sendResponse({ success: true, ...data }))
        .catch((error: unknown) => sendResponse({
          success: false,
          error: error instanceof Error ? error.message : "Claude conversation refresh failed.",
        }));
      return true;
    }
    if (message.type === "COPY_TO_CLIPBOARD") {
      void navigator.clipboard.writeText(message.text ?? "")
        .then(() => sendResponse({ success: true }))
        .catch((error: unknown) => sendResponse({
          success: false,
          error: error instanceof Error ? error.message : "Clipboard access is unavailable.",
        }));
      return true;
    }
    return false;
  };

chrome.runtime.onMessage.addListener(onMessage);
window.addEventListener("pagehide", stopWatching, { once: true });

cleanupByBuild.set(CHATSCRIBE_BUILD_ID, () => {
  chrome.runtime.onMessage.removeListener(onMessage);
  window.removeEventListener("pagehide", stopWatching);
  stopWatching();
  revisionSnapshot = null;
});
