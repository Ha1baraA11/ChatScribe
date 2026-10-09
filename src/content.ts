/**
 * content.ts — ChatScribe
 *
 * Content script running in the ISOLATED world on chatgpt.com.
 *
 * Responsibilities:
 *  1. Communicate with bridge.ts (MAIN world) via postMessage to fetch
 *     conversation data using ChatGPT's own authenticated API.
 *  2. Paginate through the full conversation history.
 *  3. Walk the message tree to find the correct current branch.
 *  4. Convert API messages to the ExportMessage format.
 *  5. Optionally download image attachments through the bridge.
 *  6. Show a brief, non-blocking success toast after a successful export.
 *
 * Conversation text and branches come from the ChatGPT API. Rendered page
 * nodes are consulted only as a fallback for generated images omitted by
 * the API response; the script never scrolls or scrapes message text.
 */

import type {
  ApiConversationPage,
  ApiMessage,
  ApiMappingNode,
  ConversationData,
  ExportMessage,
  ExportImageFile,
} from "./types.ts";
import {
  findBranchInsertionIndex,
  getMessageParentId,
  walkActiveBranchNodes,
} from "./conversation-branch.ts";

// -----------------------------------------------------------------------
// DEV LOGGING
// -----------------------------------------------------------------------

const devLog = (...args: unknown[]): void => {
  if (import.meta.env.DEV) console.log("[ChatScribe content]", ...args);
};

const devWarn = (...args: unknown[]): void => {
  if (import.meta.env.DEV) console.warn("[ChatScribe content]", ...args);
};

// -----------------------------------------------------------------------
// BRIDGE COMMUNICATION CONSTANTS
// -----------------------------------------------------------------------

const SOURCE = "ChatScribe";
const BRIDGE_TIMEOUT_MS = 20_000;
const API_PAGE_TIMEOUT_MS = 30_000;
const IMAGE_TIMEOUT_MS = 60_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB

// -----------------------------------------------------------------------
// BRIDGE STATE
// -----------------------------------------------------------------------

let bridgeInstalled = false;
let authReady = false;

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const d = event.data as Record<string, unknown> | null;
  if (!d || d.source !== SOURCE) return;

  if (d.type === "BRIDGE_PONG") {
    bridgeInstalled = true;
    if (d.authReady === true) authReady = true;
  }

  if (d.type === "AUTH_READY") {
    authReady = true;
  }
});

/**
 * Wait for the bridge to report both installed and auth-ready state.
 * Pings periodically in case the content script loaded after the bridge.
 */
async function waitForBridge(): Promise<void> {
  if (bridgeInstalled && authReady) return;

  // Send a ping to check current state
  window.postMessage({ source: SOURCE, type: "BRIDGE_PING" }, "*");

  const deadline = Date.now() + BRIDGE_TIMEOUT_MS;

  while ((!bridgeInstalled || !authReady) && Date.now() < deadline) {
    await sleep(80);
    if (!bridgeInstalled || !authReady) {
      window.postMessage({ source: SOURCE, type: "BRIDGE_PING" }, "*");
    }
  }

  if (!bridgeInstalled) {
    throw new Error(
      "ChatScribe bridge did not start. Reload the conversation and try again.",
    );
  }

  if (!authReady) {
    throw new Error("CHATGPT_CONNECTION_NOT_READY");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------
// CONVERSATION ID
// -----------------------------------------------------------------------

function extractConversationId(): string | null {
  const match = window.location.pathname.match(
    /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  return match ? match[1] : null;
}

// -----------------------------------------------------------------------
// BRIDGE API REQUEST (conversation page)
// -----------------------------------------------------------------------

interface BridgeMessage {
  source?: string;
  type?: string;
  requestId?: string;
  data?: unknown;
  base64?: string;
  mimeType?: string;
  sizeBytes?: number;
  error?: string;
  authReady?: boolean;
}

interface ImageResource {
  key: string;
  imageUrl?: string;
  fileId?: string;
  scheme?: "file-service" | "sediment";
}

function requestConversationPage(
  conversationId: string,
  cursor: string | null,
): Promise<ApiConversationPage> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    let done = false;

    const timer = window.setTimeout(() => {
      if (done) return;
      done = true;
      window.removeEventListener("message", handler);
      reject(new Error("Timed out waiting for conversation API response."));
    }, API_PAGE_TIMEOUT_MS);

    const handler = (event: MessageEvent<BridgeMessage>): void => {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.source !== SOURCE) return;
      if (d.requestId !== requestId) return;

      if (d.type === "BRIDGE_ERROR") {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        window.removeEventListener("message", handler);
        reject(new Error(d.error ?? "Unknown bridge error."));
        return;
      }

      if (d.type === "API_RESPONSE") {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        window.removeEventListener("message", handler);
        resolve(normalizePage(d.data as ApiConversationPage));
      }
    };

    window.addEventListener("message", handler);
    window.postMessage(
      { source: SOURCE, type: "API_REQUEST", requestId, conversationId, cursor },
      "*",
    );
  });
}

// -----------------------------------------------------------------------
// BRIDGE IMAGE REQUEST
// -----------------------------------------------------------------------

function requestImage(
  resource: ImageResource,
  conversationId: string,
): Promise<{
  base64: string;
  mimeType: string;
  sizeBytes: number;
}> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    let done = false;

    const timer = window.setTimeout(() => {
      if (done) return;
      done = true;
      window.removeEventListener("message", handler);
      reject(new Error("Timed out downloading image."));
    }, IMAGE_TIMEOUT_MS);

    const handler = (event: MessageEvent<BridgeMessage>): void => {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.source !== SOURCE) return;
      if (d.requestId !== requestId) return;

      if (d.type === "BRIDGE_ERROR") {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        window.removeEventListener("message", handler);
        reject(new Error(d.error ?? "Image download failed."));
        return;
      }

      if (d.type === "IMAGE_RESPONSE") {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        window.removeEventListener("message", handler);
        resolve({
          base64: d.base64 ?? "",
          mimeType: d.mimeType ?? "image/png",
          sizeBytes: d.sizeBytes ?? 0,
        });
      }
    };

    window.addEventListener("message", handler);
    window.postMessage(
      {
        source: SOURCE,
        type: "IMAGE_REQUEST",
        requestId,
        conversationId,
        imageUrl: resource.imageUrl,
        fileId: resource.fileId,
        scheme: resource.scheme,
      },
      "*",
    );
  });
}

// -----------------------------------------------------------------------
// NORMALIZE API PAGE (handle both flat and tree formats)
// -----------------------------------------------------------------------

function normalizePage(page: ApiConversationPage): ApiConversationPage {
  if (page.mapping) {
    // Tree / mapping format — flatten into messages array
    const messages: ApiMessage[] = [];

    for (const [nodeId, node] of Object.entries(
      page.mapping as Record<string, ApiMappingNode>,
    )) {
      if (!node.message) {
        // Phantom node with no message (e.g. root placeholder)
        messages.push({
          id: nodeId,
          parent: node.parent,
          children: node.children ?? [],
        });
        continue;
      }

      messages.push({
        ...node.message,
        id: node.message.id ?? nodeId,
        parent: node.parent !== undefined ? node.parent : node.message.parent,
        children: node.children ?? node.message.children ?? [],
      });
    }

    return { ...page, messages };
  }

  // Some responses nest the actual message inside a "message" property
  const raw = page.messages ?? [];
  const hasNested = raw.some(
    (m) => m.message !== null && m.message !== undefined,
  );

  if (!hasNested) return page;

  const flat: ApiMessage[] = raw.map((node) => {
    const inner = node.message ?? {};
    return {
      ...inner,
      id: inner.id ?? node.id,
      parent: (node as unknown as ApiMappingNode).parent !== undefined
        ? (node as unknown as ApiMappingNode).parent
        : inner.parent,
      children:
        (node as unknown as ApiMappingNode).children ??
        inner.children ??
        [],
    };
  });

  return { ...page, messages: flat };
}

// -----------------------------------------------------------------------
// MESSAGE PARENT RESOLUTION
// -----------------------------------------------------------------------

function getTimestamp(msg: ApiMessage): number {
  return msg.create_time ?? Number.MAX_SAFE_INTEGER;
}

// -----------------------------------------------------------------------
// DECIDE WHICH MESSAGES ARE EXPORTABLE
// -----------------------------------------------------------------------

function isExportable(
  msg: ApiMessage,
  downloadImages: boolean,
): boolean {
  const role = msg.author?.role;
  if (role !== "user" && role !== "assistant") return false;
  if (msg.metadata?.is_visually_hidden_from_conversation) return false;

  const hasText = Boolean(extractText(msg));
  const hasImage = downloadImages && getImageResources(msg).length > 0;

  if (!hasText && !hasImage) return false;

  // For assistant messages, only include completed turns
  if (role === "assistant") {
    return msg.end_turn === true || hasImage;
  }

  return true;
}

// -----------------------------------------------------------------------
// WALK THE ACTIVE BRANCH
// -----------------------------------------------------------------------

/**
 * Walk backwards from `currentNode` up the parent chain to reconstruct
 * the active conversation branch, then reverse to get chronological order.
 */
/**
 * Chronological pairing fallback: match users to the nearest assistant
 * response that came after them, using a time-ordered scan.
 */
function buildChronologicalMessages(
  exportable: ApiMessage[],
  downloadImages: boolean,
): ApiMessage[] {
  const users = exportable
    .filter((m) => m.author?.role === "user")
    .sort((a, b) => getTimestamp(a) - getTimestamp(b));

  const assistants = exportable
    .filter((m) => m.author?.role === "assistant")
    .sort((a, b) => getTimestamp(a) - getTimestamp(b));

  // Build a lookup: parentId → assistant messages (for explicit parent-linking)
  const byParent = new Map<string, ApiMessage[]>();
  for (const a of assistants) {
    const pid = getMessageParentId(a);
    if (!pid) continue;
    const list = byParent.get(pid) ?? [];
    list.push(a);
    byParent.set(pid, list);
  }

  const used = new Set<string>();
  const result: ApiMessage[] = [];

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    if (!user.id) continue;

    result.push(user);

    const userTime = getTimestamp(user);
    const nextUserTime =
      i + 1 < users.length ? getTimestamp(users[i + 1]) : Infinity;

    // Prefer explicitly-linked child, otherwise first assistant in window
    const linked = (byParent.get(user.id) ?? [])
      .filter((a) => a.id && !used.has(a.id))
      .sort((a, b) => getTimestamp(b) - getTimestamp(a))[0];

    const chronological = assistants.find(
      (a) =>
        a.id &&
        !used.has(a.id) &&
        getTimestamp(a) > userTime &&
        getTimestamp(a) < nextUserTime,
    );

    const chosen = linked ?? chronological;

    if (
      chosen?.id &&
      !used.has(chosen.id) &&
      isExportable(chosen, downloadImages)
    ) {
      used.add(chosen.id);
      result.push(chosen);
    }
  }

  return result;
}

// -----------------------------------------------------------------------
// TEXT EXTRACTION
// -----------------------------------------------------------------------

function extractText(msg: ApiMessage): string {
  const parts = msg.content?.parts;
  if (!Array.isArray(parts)) return "";

  return parts
    .filter((p) => typeof p === "string" && p.trim().length > 0)
    .join("\n")
    .trim();
}

// -----------------------------------------------------------------------
// IMAGE URL EXTRACTION
// -----------------------------------------------------------------------

/**
 * ChatGPT exposes images as URLs, nested metadata, or file-service pointers.
 * Generated images can also exist only in the rendered page, so the DOM is a
 * narrowly scoped fallback for images attached to this message's ID.
 */
function getImageResources(msg: ApiMessage): ImageResource[] {
  const resources = new Map<string, ImageResource>();
  const visited = new WeakSet<object>();
  let visitedValues = 0;

  const add = (value: unknown): void => {
    if (typeof value === "string") {
      const reference = getImageReference(value);
      if (reference) {
        mergeResource({ ...reference, key: `${reference.scheme}:${reference.fileId}` });
        return;
      }

      const imageUrl = getSafeHostedImageUrl(value);
      if (imageUrl) mergeResource({ key: `url:${imageUrl}`, imageUrl });
      return;
    }

    if (!isRecord(value)) return;

    const reference = getImageReference(value.asset_pointer);
    const imageUrl = getImageUrlFromPart(value);
    if (reference || imageUrl) {
      const key = reference
        ? `${reference.scheme}:${reference.fileId}`
        : `url:${imageUrl}`;
      mergeResource({ key, ...reference, imageUrl: imageUrl ?? undefined });
    }
  };

  const mergeResource = (resource: ImageResource): void => {
    const existing = resources.get(resource.key);
    resources.set(resource.key, existing
      ? { ...existing, ...resource, imageUrl: resource.imageUrl ?? existing.imageUrl }
      : resource);
  };

  const visit = (value: unknown, depth: number): void => {
    if (depth > 12 || visitedValues++ > 10_000) return;

    if (typeof value === "string") {
      add(value);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }

    if (!isRecord(value) || visited.has(value)) return;
    visited.add(value);
    add(value);
    Object.values(value).forEach((item) => visit(item, depth + 1));
  };

  visit(msg.content?.parts, 0);
  visit(msg.metadata, 0);

  if (msg.id) {
    visit(getRenderedImagePartsForMessage(msg.id), 0);
  }

  return [...resources.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getImageReference(value: unknown): Pick<
  ImageResource,
  "fileId" | "scheme"
> | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(file-service|sediment):\/\/(.+)$/i);
  if (!match) return null;

  const referencedIds = match[2].match(/file[-_][A-Za-z0-9_-]+/gi);
  const fileId = referencedIds?.at(-1);
  if (!fileId) return null;

  return {
    fileId,
    scheme: match[1].toLowerCase() as ImageResource["scheme"],
  };
}

function getSafeHostedImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;

  try {
    const url = new URL(value, window.location.origin);
    if (url.username || url.password) return null;

    if (url.protocol === "blob:") {
      return url.origin === window.location.origin ? url.toString() : null;
    }
    if (url.protocol !== "https:") return null;

    const hostname = url.hostname.toLowerCase();
    if (
      hostname === "oaiusercontent.com" ||
      hostname.endsWith(".oaiusercontent.com") ||
      hostname === "oaistatic.com" ||
      hostname.endsWith(".oaistatic.com")
    ) {
      return url.toString();
    }

    if (url.origin !== window.location.origin) return null;
    if (
      /^\/backend-api\/estuary\/content$/i.test(url.pathname) ||
      /^\/backend-api\/files\/(?:download\/)?file[-_][a-z0-9_-]+(?:\/download)?$/i.test(url.pathname) ||
      /^\/backend-api\/conversation\/[0-9a-f-]{36}\/attachment\/file[-_][a-z0-9_-]+\/download$/i.test(url.pathname)
    ) {
      return url.toString();
    }
  } catch {
    return null;
  }

  return null;
}

function getImageUrlFromPart(part: Record<string, unknown>): string | null {
  const imageUrl = part.image_url;
  if (typeof imageUrl === "string") {
    return getSafeHostedImageUrl(imageUrl);
  }
  if (isRecord(imageUrl)) {
    const nestedUrl = getSafeHostedImageUrl(imageUrl.url);
    if (nestedUrl) return nestedUrl;
  }
  return getSafeHostedImageUrl(part.url);
}

function getRenderedImagePartsForMessage(
  messageId: string,
): Array<{ image_url: string }> {
  const parts: Array<{ image_url: string }> = [];

  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-message-id], [data-chatgpt-search-message-ids]",
  )) {
    const ids = [
      element.dataset.messageId,
      element.dataset.chatgptSearchMessageIds,
    ]
      .filter((id): id is string => Boolean(id))
      .flatMap((id) => id.split(/[\s,]+/));

    if (!ids.includes(messageId)) continue;

    for (const image of element.querySelectorAll<HTMLImageElement>("img")) {
      const imageUrl = getSafeHostedImageUrl(image.currentSrc || image.src);
      if (imageUrl) parts.push({ image_url: imageUrl });
    }
  }

  return parts;
}

function getUnattachedRenderedGeneratedImages(
  existingMessages: ApiMessage[],
  conversationMessageIds: ReadonlySet<string>,
): ApiMessage[] {
  const knownIds = new Set(conversationMessageIds);
  const existingImageKeys = new Set(
    existingMessages.flatMap((message) =>
      getImageResources(message).map((resource) => resource.key),
    ),
  );
  const generatedByParent = new Map<string, Array<{ image_url: string }>>();
  const recoveredKeys = new Set(existingImageKeys);

  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-chatgpt-search-message-ids]",
  )) {
    const ids = element.dataset.chatgptSearchMessageIds
      ?.split(/[\s,]+/)
      .filter(Boolean);
    const parentId = ids?.find((id) => knownIds.has(id));
    if (!parentId) continue;

    for (const image of element.querySelectorAll<HTMLImageElement>("img")) {
      if (!/generated image/i.test(image.alt)) continue;
      const imageUrl = getSafeHostedImageUrl(image.currentSrc || image.src);
      if (!imageUrl) continue;

      const key = `url:${imageUrl}`;
      if (recoveredKeys.has(key)) continue;
      recoveredKeys.add(key);
      const parts = generatedByParent.get(parentId) ?? [];
      parts.push({ image_url: imageUrl });
      generatedByParent.set(parentId, parts);
    }
  }

  return [...generatedByParent.entries()].map(([parentId, parts]) => ({
    id: `rendered-generated-image:${parentId}`,
    parent: parentId,
    author: { role: "assistant" },
    create_time: Date.now(),
    end_turn: true,
    content: { content_type: "multimodal", parts },
  }));
}

// -----------------------------------------------------------------------
// MIME TYPE HELPERS
// -----------------------------------------------------------------------

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

function mimeToExtension(mime: string): string | null {
  const base = mime.split(";")[0].trim().toLowerCase();
  return MIME_TO_EXT[base] ?? null;
}

// -----------------------------------------------------------------------
// MAIN: LOAD ENTIRE CONVERSATION
// -----------------------------------------------------------------------

let loadInFlight: Promise<ConversationData> | null = null;

/**
 * Load the full conversation, paginating through all pages.
 * Deduplicates concurrent calls with a single-flight guard.
 */
async function loadConversation(downloadImages: boolean): Promise<ConversationData> {
  if (loadInFlight) return loadInFlight;
  loadInFlight = doLoadConversation(downloadImages).finally(() => {
    loadInFlight = null;
  });
  return loadInFlight;
}

async function doLoadConversation(
  downloadImages: boolean,
): Promise<ConversationData> {
  await waitForBridge();

  const rawConvId = extractConversationId();
  if (!rawConvId) {
    throw new Error(
      "Could not determine the ChatGPT conversation ID from the URL.",
    );
  }
  const conversationId = rawConvId;

  devLog("Loading conversation", conversationId);

  // ---- Paginate through all pages ----
  const allById = new Map<string, ApiMessage>();

  async function fetchAndCollect(cursor: string | null): Promise<{
    page: ApiConversationPage;
    collected: number;
  }> {
    const page = await requestConversationPage(conversationId, cursor);
    let collected = 0;

    for (const msg of page.messages ?? []) {
      const id = msg.id;
      if (!id) continue;

      const existing = allById.get(id);
      if (!existing) {
        allById.set(id, msg);
      } else {
        // Merge: prefer non-null fields from the newer record
        allById.set(id, {
          ...existing,
          ...msg,
          metadata: { ...existing.metadata, ...msg.metadata },
          children: msg.children ?? existing.children,
        });
      }

      if (isExportable(allById.get(id)!, downloadImages)) {
        collected++;
      }
    }

    return { page, collected };
  }

  let { page, collected } = await fetchAndCollect(null);

  const currentNode = page.current_node ?? null;
  const seenCursors = new Set<string>();
  let pageNum = 1;

  devLog(`Page ${pageNum}: ${collected} exportable messages`);

  while (page.page_info?.has_previous_page === true) {
    const cursor = page.page_info.start_cursor;

    if (!cursor) {
      throw new Error(
        "ChatGPT reported more pages but provided no cursor.",
      );
    }

    if (seenCursors.has(cursor)) {
      throw new Error("Received a duplicate pagination cursor. Stopping.");
    }

    seenCursors.add(cursor);
    pageNum++;

    const result = await fetchAndCollect(cursor);
    page = result.page;
    collected = result.collected;

    devLog(`Page ${pageNum}: ${collected} exportable messages so far`);

    try {
      chrome.runtime.sendMessage({ type: "EXPORT_PROGRESS", collected });
    } catch {
      /* progress notifications never break export */
    }
  }

  devLog(`Pagination complete. Raw messages: ${allById.size}`);

  // ---- Resolve the active branch ----
  const exportableAll = Array.from(allById.values()).filter((m) =>
    isExportable(m, downloadImages),
  );

  let orderedMessages: ApiMessage[];
  let activeBranchNodes: ApiMessage[] | null = null;

  if (currentNode) {
    activeBranchNodes = walkActiveBranchNodes(allById, currentNode);
    const branch = activeBranchNodes?.filter((message) =>
      isExportable(message, downloadImages),
    );
    if (branch && branch.length > 0) {
      orderedMessages = branch;
      devLog(
        `Branch walk succeeded: ${orderedMessages.length} messages (current_node path)`,
      );
    } else {
      devWarn("Branch walk failed; falling back to chronological pairing");
      orderedMessages = buildChronologicalMessages(exportableAll, downloadImages);
    }
  } else {
    devWarn("No current_node; using chronological pairing");
    orderedMessages = buildChronologicalMessages(exportableAll, downloadImages);
  }

  if (downloadImages) {
    const activeIds = new Set(
      (activeBranchNodes ?? orderedMessages).flatMap((message) =>
        message.id ? [message.id] : [],
      ),
    );
    const generatedMessages = getUnattachedRenderedGeneratedImages(
      orderedMessages,
      activeIds,
    );

    for (const generated of generatedMessages) {
      const parentId = getMessageParentId(generated);
      const insertionIndex = parentId
        ? findBranchInsertionIndex(
            orderedMessages,
            activeBranchNodes,
            parentId,
          )
        : orderedMessages.length;
      orderedMessages.splice(
        insertionIndex,
        0,
        generated,
      );
    }

    if (generatedMessages.length > 0) {
      devLog(`Recovered ${generatedMessages.length} rendered generated-image message(s)`);
    }
  }

  devLog(`Active messages: ${orderedMessages.length}`);

  // ---- Download images ----
  const imageCache = new Map<string, Promise<ExportImageFile>>();
  let nextImageIdx = 1;
  let totalImageBytes = 0;

  // Simple concurrency limiter (max 2 parallel downloads)
  let activeDownloads = 0;
  const downloadQueue: Array<() => void> = [];

  async function limitedDownload<T>(fn: () => Promise<T>): Promise<T> {
    if (activeDownloads >= 2) {
      await new Promise<void>((r) => downloadQueue.push(r));
    }
    activeDownloads++;
    try {
      return await fn();
    } finally {
      activeDownloads--;
      downloadQueue.shift()?.();
    }
  }

  // ---- Convert to ExportMessage ----
  const converted = await Promise.all(
    orderedMessages.map(async (msg, idx): Promise<ExportMessage | null> => {
      if (!msg.id) return null;

      const role = msg.author?.role as "user" | "assistant" | undefined;
      if (role !== "user" && role !== "assistant") return null;

      const text = extractText(msg);
      const imagePaths: string[] = [];
      let failedImageCount = 0;

      if (downloadImages) {
        const imageResources = getImageResources(msg);

        for (const resource of imageResources) {
          if (!imageCache.has(resource.key)) {
            const imgIdx = nextImageIdx++;
            imageCache.set(
              resource.key,
              limitedDownload(async () => {
                const downloaded = await requestImage(resource, conversationId);

                if (totalImageBytes + downloaded.sizeBytes > MAX_IMAGE_BYTES) {
                  throw new Error(
                    "Images exceed the 20 MB export limit.",
                  );
                }
                totalImageBytes += downloaded.sizeBytes;

                const ext = mimeToExtension(downloaded.mimeType) ?? "png";
                const path = `images/image-${String(imgIdx).padStart(3, "0")}.${ext}`;

                return {
                  path,
                  mimeType: downloaded.mimeType,
                  base64: downloaded.base64,
                  sizeBytes: downloaded.sizeBytes,
                };
              }),
            );
          }

          try {
            const imgFile = await imageCache.get(resource.key)!;
            imagePaths.push(imgFile.path);
          } catch (err) {
            failedImageCount++;
            devWarn("Image download failed:", resource.key, err);
          }
        }
      }

      if (!text && imagePaths.length === 0 && failedImageCount === 0) return null;

      const content = failedImageCount > 0
        ? `${text}${text ? "\n\n" : ""}[${failedImageCount} image${failedImageCount === 1 ? "" : "s"} could not be downloaded]`
        : text;

      return {
        id: msg.id,
        role,
        content,
        index: idx,
        imagePaths,
        timestamp: msg.create_time ?? undefined,
      };
    }),
  );

  const messages = converted
    .filter((m): m is ExportMessage => m !== null)
    .map((m, i) => ({ ...m, index: i }));

  // Collect settled image files
  const settled = await Promise.allSettled(imageCache.values());
  const images: ExportImageFile[] = settled.flatMap((r) =>
    r.status === "fulfilled" ? [r.value] : [],
  );

  devLog(`Export ready: ${messages.length} messages, ${images.length} images`);

  return { messages, images };
}

// -----------------------------------------------------------------------
// EXPORT SUCCESS TOAST (shown on the ChatGPT page)
// -----------------------------------------------------------------------

const SUCCESS_TOAST_ATTRIBUTE = `data-chatscribe-toast-${crypto.randomUUID().replaceAll("-", "")}`;
const SUCCESS_TOAST_SELECTOR = `[${SUCCESS_TOAST_ATTRIBUTE}]`;
let successToast: HTMLDivElement | null = null;
let successToastLabel: HTMLSpanElement | null = null;
let successToastStyle: HTMLStyleElement | null = null;
let successToastTimer: number | undefined;
let successToastSequence = 0;
let toastTheme: "system" | "light" | "dark" = "system";

void chrome.storage.sync.get({ theme: "system" }).then((r) => {
  if (r.theme === "light" || r.theme === "dark") toastTheme = r.theme;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.theme) return;
  const v = changes.theme.newValue;
  toastTheme = v === "light" || v === "dark" ? v : "system";
});

function ensureSuccessToast(): HTMLDivElement {
  if (successToast?.isConnected) return successToast;

  const toast = document.createElement("div");
  toast.setAttribute(SUCCESS_TOAST_ATTRIBUTE, "");
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.setAttribute("aria-atomic", "true");

  const icon = document.createElement("span");
  icon.className = "cs-icon";
  icon.setAttribute("aria-hidden", "true");

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("focusable", "false");

  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", "10");
  circle.setAttribute("cy", "10");
  circle.setAttribute("r", "9");
  circle.setAttribute("class", "cs-ring");

  const check = document.createElementNS("http://www.w3.org/2000/svg", "path");
  check.setAttribute("d", "M5.5 10.2 8.6 13l5.9-6");
  check.setAttribute("class", "cs-check");

  svg.append(circle, check);
  icon.append(svg);

  const label = document.createElement("span");
  label.className = "cs-label";
  toast.append(icon, label);

  const style = document.createElement("style");
  style.textContent = `
    ${SUCCESS_TOAST_SELECTOR} {
      all: initial;
      box-sizing: border-box;
      position: fixed !important;
      left: 50% !important;
      top: 50% !important;
      right: auto !important;
      bottom: auto !important;
      z-index: 2147483647 !important;
      display: flex !important;
      align-items: center;
      gap: 10px;
      max-width: calc(100vw - 32px);
      padding: 9px 15px 9px 10px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 999px;
      background: rgba(39, 43, 55, 0.96);
      color: #f4f6f9;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
      font: 600 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0.01em;
      white-space: nowrap;
      opacity: 0;
      transform: translate3d(-50%, calc(-50% + 8px), 0) scale(0.985);
      pointer-events: none !important;
      user-select: none;
      -webkit-backdrop-filter: blur(14px);
      backdrop-filter: blur(14px);
      transition:
        opacity 180ms cubic-bezier(0.22, 1, 0.36, 1),
        transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    ${SUCCESS_TOAST_SELECTOR}[data-theme="light"] {
      border-color: rgba(39, 43, 55, 0.12);
      background: rgba(255, 255, 255, 0.96);
      color: #242936;
      box-shadow: 0 12px 32px rgba(39, 43, 55, 0.2);
    }
    @media (prefers-color-scheme: light) {
      ${SUCCESS_TOAST_SELECTOR}[data-theme="system"] {
        border-color: rgba(39, 43, 55, 0.12);
        background: rgba(255, 255, 255, 0.96);
        color: #242936;
        box-shadow: 0 12px 32px rgba(39, 43, 55, 0.2);
      }
    }
    ${SUCCESS_TOAST_SELECTOR} .cs-icon {
      box-sizing: border-box;
      display: grid;
      width: 22px;
      height: 22px;
      flex: 0 0 22px;
      place-items: center;
      border-radius: 50%;
      background: rgba(123, 213, 167, 0.14);
    }
    ${SUCCESS_TOAST_SELECTOR} .cs-label {
      min-width: 0;
      max-width: calc(100vw - 80px);
      overflow: hidden;
      color: inherit;
      font: inherit;
      text-overflow: ellipsis;
    }
    ${SUCCESS_TOAST_SELECTOR} svg {
      display: block;
      width: 19px;
      height: 19px;
      overflow: visible;
    }
    ${SUCCESS_TOAST_SELECTOR} .cs-ring {
      fill: none;
      stroke: #7bd5a7;
      stroke-width: 1.4;
    }
    ${SUCCESS_TOAST_SELECTOR} .cs-check {
      fill: none;
      stroke: #7bd5a7;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-dasharray: 20;
      stroke-dashoffset: 20;
    }
    ${SUCCESS_TOAST_SELECTOR}.visible {
      opacity: 1;
      transform: translate3d(-50%, -50%, 0) scale(1);
    }
    ${SUCCESS_TOAST_SELECTOR}.visible .cs-check {
      animation: chatscribe-toast-check 240ms 70ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }
    @keyframes chatscribe-toast-check {
      to { stroke-dashoffset: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      ${SUCCESS_TOAST_SELECTOR} {
        transition: none;
        transform: translate3d(-50%, -50%, 0) scale(1);
      }
      ${SUCCESS_TOAST_SELECTOR}.visible .cs-check {
        animation: none;
        stroke-dashoffset: 0;
      }
    }
  `;

  (document.head ?? document.documentElement).append(style);
  (document.body ?? document.documentElement).append(toast);
  successToast = toast;
  successToastLabel = label;
  successToastStyle = style;
  return toast;
}

function showExportSuccess(message: string): void {
  const toast = ensureSuccessToast();
  if (successToastStyle && !successToastStyle.isConnected) {
    (document.head ?? document.documentElement).append(successToastStyle);
  }

  toast.dataset.theme = toastTheme;
  if (successToastLabel) successToastLabel.textContent = message;

  window.clearTimeout(successToastTimer);
  const sequence = ++successToastSequence;
  toast.classList.remove("visible");
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (sequence === successToastSequence) toast.classList.add("visible");
    });
  });
  successToastTimer = window.setTimeout(() => {
    if (sequence !== successToastSequence) return;
    toast.classList.remove("visible");
    successToastTimer = window.setTimeout(() => {
      if (sequence === successToastSequence && successToastLabel) {
        successToastLabel.textContent = "";
      }
    }, 220);
  }, 2400);
}

// -----------------------------------------------------------------------
// CHROME MESSAGE LISTENER
// -----------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (
    message: { type: string; downloadImages?: boolean; text?: string; message?: string },
    _sender,
    sendResponse,
  ) => {
    if (message.type === "COPY_TO_CLIPBOARD") {
      if (!navigator.clipboard?.writeText) {
        sendResponse({
          success: false,
          error: "Clipboard access is unavailable in this browser context.",
        });
        return false;
      }

      void navigator.clipboard.writeText(message.text ?? "")
        .then(() => sendResponse({ success: true }))
        .catch((err: unknown) =>
          sendResponse({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === "LOAD_CONVERSATION") {
      void loadConversation(message.downloadImages === true)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err: unknown) =>
          sendResponse({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true; // Keep channel open for async response
    }

    if (message.type === "SHOW_EXPORT_SUCCESS") {
      const successMessage = message.message?.trim();
      if (successMessage) showExportSuccess(successMessage);
      return false;
    }

    return false;
  },
);
