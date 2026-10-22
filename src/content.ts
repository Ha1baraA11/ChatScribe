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
 * the API response. Older rendered turns are loaded while exporting images.
 */

import type {
  ApiConversationPage,
  ApiMessage,
  ApiMappingNode,
  ConversationData,
  ImageExportDiagnostics,
  ImageExportDiagnosticMessage,
  ExportMessage,
  ExportImageFile,
} from "./types.ts";
import {
  findBranchInsertionIndex,
  getMessageParentId,
  isMessageLinkedToActiveMessage,
  resolveActiveBranchNodes,
} from "./conversation-branch.ts";
import {
  createRenderedGeneratedImageMessage,
  deduplicateNamedImageResources,
  findActiveTurnUserId,
  findGeneratedImageMergeTarget,
  getFollowingAssistantsInTurn,
  getFollowingSandboxImageFilenames,
  getUnrecoveredImageFailureDetails,
  isGeneratedImageScanComplete,
  getGeneratedImageScanStep,
  getRelatedMessageIdsInTurn,
  isGeneratedImageSelected,
  isMatchingFilePreviewPanel,
  isRenderedGeneratedImageCandidate,
  mapImageFilenamesToKeys,
  mergeRecoveredGeneratedImageMessages,
  nudgeOlderMessagesLoader,
  recoverApiGeneratedImages,
  selectBlobResourcesForPrefetch,
} from "./generated-image-recovery.ts";
import { findConversationScroller } from "./conversation-scroller.ts";
import { renderSvgDataUrlToPngBase64 } from "./svg-template.ts";
import {
  BRIDGE_API_REQUEST_TYPE,
  BRIDGE_API_RESPONSE_TYPE,
  BRIDGE_ERROR_TYPE,
  BRIDGE_IMAGE_REQUEST_TYPE,
  BRIDGE_IMAGE_RESPONSE_TYPE,
  BRIDGE_PING_TYPE,
  BRIDGE_PONG_TYPE,
  CHATSCRIBE_BUILD_ID,
  CONTENT_LOAD_TYPE,
  CONTENT_PING_TYPE,
} from "./content-protocol.ts";

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
const BRIDGE_TIMEOUT_MS = 3_000;
const API_PAGE_TIMEOUT_MS = 30_000;
const IMAGE_TIMEOUT_MS = 60_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_TOTAL_IMAGE_BYTES = 200 * 1024 * 1024;
const CONVERSATION_CACHE_TTL_MS = 2 * 60_000;
const MAX_CONCURRENT_IMAGE_DOWNLOADS = 2;

// -----------------------------------------------------------------------
// BRIDGE STATE
// -----------------------------------------------------------------------

let bridgeInstalled = false;

const contentWindow = window as Window & {
  __chatScribeContentCleanupByBuild?: Map<string, () => void>;
};
const contentCleanupByBuild = contentWindow.__chatScribeContentCleanupByBuild ??= new Map();
try {
  contentCleanupByBuild.get(CHATSCRIBE_BUILD_ID)?.();
} catch {
  // A listener from an invalidated extension context must not block repair.
}

const onBridgeWindowMessage = (event: MessageEvent): void => {
  if (event.source !== window) return;
  const d = event.data as Record<string, unknown> | null;
  if (!d || d.source !== SOURCE) return;

  if (d.type === BRIDGE_PONG_TYPE) {
    bridgeInstalled = true;
  }
};
window.addEventListener("message", onBridgeWindowMessage);

/**
 * Wait only for the bridge listener. It can recover current session headers
 * itself when the page was already open and its initial API request was missed.
 */
async function waitForBridge(): Promise<void> {
  if (bridgeInstalled) return;

  // Send a ping to check current state
  window.postMessage({ source: SOURCE, type: BRIDGE_PING_TYPE }, "*");

  const deadline = Date.now() + BRIDGE_TIMEOUT_MS;

  while (!bridgeInstalled && Date.now() < deadline) {
    await sleep(80);
    if (!bridgeInstalled) window.postMessage({ source: SOURCE, type: BRIDGE_PING_TYPE }, "*");
  }

  if (!bridgeInstalled) {
    throw new Error(
      "ChatScribe bridge did not start. Reload the conversation and try again.",
    );
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
  inlineSvgDataUrl?: string;
  svgBackgroundColor?: string;
  inlineImageDataUrl?: string;
  filename?: string;
  filenameHint?: string;
  renderedFromDom?: boolean;
  downloadLink?: boolean;
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

      if (d.type === BRIDGE_ERROR_TYPE) {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        window.removeEventListener("message", handler);
        reject(new Error(d.error ?? "Unknown bridge error."));
        return;
      }

      if (d.type === BRIDGE_API_RESPONSE_TYPE) {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        window.removeEventListener("message", handler);
        try {
          resolve(normalizePage(d.data));
        } catch (error) {
          reject(error instanceof Error
            ? error
            : new Error("ChatGPT returned an invalid conversation page."));
        }
      }
    };

    window.addEventListener("message", handler);
    window.postMessage(
      { source: SOURCE, type: BRIDGE_API_REQUEST_TYPE, requestId, conversationId, cursor },
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

      if (d.type === BRIDGE_ERROR_TYPE) {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        window.removeEventListener("message", handler);
        reject(new Error(d.error ?? "Image download failed."));
        return;
      }

      if (d.type === BRIDGE_IMAGE_RESPONSE_TYPE) {
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
        type: BRIDGE_IMAGE_REQUEST_TYPE,
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

function normalizePage(value: unknown): ApiConversationPage {
  if (!isRecord(value)) {
    throw new Error("ChatGPT returned an invalid conversation page.");
  }

  const page = value as ApiConversationPage;
  if (page.mapping !== undefined && isRecord(page.mapping)) {
    // Tree / mapping format — flatten into messages array
    const messages: ApiMessage[] = [];

    for (const [nodeId, rawNode] of Object.entries(page.mapping)) {
      if (!isRecord(rawNode)) {
        throw new Error("ChatGPT returned an invalid conversation node.");
      }
      const node = rawNode as ApiMappingNode;
      if (node.message !== null && node.message !== undefined && !isRecord(node.message)) {
        throw new Error("ChatGPT returned an invalid conversation message.");
      }
      if (!node.message) {
        // Phantom node with no message (e.g. root placeholder)
        messages.push({
          id: nodeId,
          parent: node.parent,
          children: node.children ?? [],
        });
        continue;
      }

      const message = node.message as ApiMessage;
      messages.push({
        ...message,
        id: message.id ?? nodeId,
        parent: node.parent !== undefined ? node.parent : message.parent,
        children: node.children ?? message.children ?? [],
      });
    }

    return { ...page, messages };
  }

  if (page.messages !== undefined && !Array.isArray(page.messages)) {
    throw new Error("ChatGPT returned an invalid conversation message list.");
  }

  // Some responses nest the actual message inside a "message" property
  const raw = page.messages ?? [];
  if (!raw.every(isRecord)) {
    throw new Error("ChatGPT returned an invalid conversation message.");
  }
  if (raw.some((node) =>
    node.message !== null && node.message !== undefined && !isRecord(node.message)
  )) {
    throw new Error("ChatGPT returned an invalid nested conversation message.");
  }

  const hasNested = raw.some(
    (m) => m.message !== null && m.message !== undefined,
  );

  if (!hasNested) return { ...page, messages: raw as ApiMessage[] };

  const flat: ApiMessage[] = raw.map((node) => {
    const outer = node as unknown as ApiMappingNode;
    const inner = (node.message as ApiMessage | null | undefined) ?? {};
    return {
      ...inner,
      id: inner.id ?? outer.id,
      parent: outer.parent !== undefined
        ? outer.parent
        : inner.parent,
      children:
        outer.children ??
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
  includeGeneratedImages: boolean,
): boolean {
  const role = msg.author?.role;
  if (role !== "user" && role !== "assistant") return false;
  if (msg.metadata?.is_visually_hidden_from_conversation) return false;

  const hasText = Boolean(extractText(msg));
  const mayIncludeImages = downloadImages &&
    (role !== "assistant" || includeGeneratedImages);
  // Branch filtering runs repeatedly. Use API metadata here; rendered-image
  // fallbacks are collected once after the active branch has been resolved.
  const hasImage = mayIncludeImages && getImageResources(msg, false).length > 0;

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
  includeGeneratedImages: boolean,
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
      isExportable(chosen, downloadImages, includeGeneratedImages)
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
function getImageResources(
  msg: ApiMessage,
  includeRenderedImageParts = true,
): ImageResource[] {
  const variants = imageResourceCache.get(msg) ?? new Map<boolean, ImageResource[]>();
  const cached = variants.get(includeRenderedImageParts);
  // API-only results are stable for a message object. Rendered image parts
  // are not: ChatGPT virtualizes older turns, so a first scan can see no DOM
  // images and a later scan can see them after pagination loads that turn.
  // Re-scan the DOM on every rendered lookup, retaining only positive
  // discoveries so resources remain available after their turn scrolls away.
  if (!includeRenderedImageParts && cached) return cached;
  const cachedRenderedResources = includeRenderedImageParts
    ? variants.get(true)
    : undefined;

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

      const inlineImageDataUrl = getSafeRenderedImageDataUrl(value);
      if (inlineImageDataUrl) {
        mergeResource({
          key: `inline-image:${inlineImageDataUrl}`,
          inlineImageDataUrl,
        });
        return;
      }

      const imageUrl = getSafeHostedImageUrl(value);
      if (imageUrl) mergeResource({ key: `url:${imageUrl}`, imageUrl });
      return;
    }

    if (!isRecord(value)) return;

    const rawFilenameHint = value.image_filename_hint;
    const filenameHint = typeof rawFilenameHint === "string"
      ? rawFilenameHint.trim().slice(0, 256) || undefined
      : undefined;
    const inlineSvgDataUrl = getSafeRenderedSvgDataUrl(value.rendered_svg_data_url);
    const inlineSvgKey = value.rendered_svg_key;
    if (inlineSvgDataUrl && typeof inlineSvgKey === "string") {
      mergeResource({
        key: inlineSvgKey,
        inlineSvgDataUrl,
        filenameHint,
        svgBackgroundColor: getSafeRenderedSvgBackgroundColor(
          value.rendered_svg_background_color,
        ) ?? undefined,
        renderedFromDom: value.rendered_from_dom === true || value.rendered_from_dom === 1,
      });
    }

    const filename = getImageFilename(
      value.image_filename ?? value.file_name ?? value.filename ?? value.name,
    );
    const reference = getImageReference(value.asset_pointer) ??
      getImageFileIdReference(value, filename);
    const imageUrl = getImageUrlFromPart(value);
    const rasterDataUrl = getSafeRenderedImageDataUrl(value.inline_image_data_url);
    if (reference || imageUrl || rasterDataUrl) {
      const key = reference
        ? `${reference.scheme}:${reference.fileId}`
        : imageUrl
          ? `url:${imageUrl}`
          : `inline-image:${rasterDataUrl}`;
      mergeResource({
        key,
        ...reference,
        imageUrl: imageUrl ?? undefined,
        inlineImageDataUrl: rasterDataUrl ?? undefined,
        filename: filename ?? undefined,
        filenameHint,
        renderedFromDom: value.rendered_from_dom === true || value.rendered_from_dom === 1,
        downloadLink: value.rendered_download_link === true || value.rendered_download_link === 1,
      });
    }
  };

  const mergeResource = (resource: ImageResource): void => {
    const existing = resources.get(resource.key);
    resources.set(resource.key, existing
      ? {
          ...existing,
          ...resource,
          imageUrl: resource.imageUrl ?? existing.imageUrl,
          svgBackgroundColor: resource.svgBackgroundColor ?? existing.svgBackgroundColor,
          filename: resource.filename ?? existing.filename,
          filenameHint: resource.filenameHint ?? existing.filenameHint,
          renderedFromDom: resource.renderedFromDom || existing.renderedFromDom,
          downloadLink: resource.downloadLink || existing.downloadLink,
        }
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

  const cachedApiResources = variants.get(false);
  if (cachedApiResources) {
    cachedApiResources.forEach(mergeResource);
  } else {
    visit(msg.content?.parts, 0);
    visit(msg.metadata, 0);
    variants.set(false, [...resources.values()]);
  }

  cachedRenderedResources?.forEach(mergeResource);

  let foundRenderedParts = false;
  if (includeRenderedImageParts && msg.id) {
    const role = msg.author?.role;
    const renderedParts = getRenderedImagePartsForMessage(
      msg.id,
      role === "user" || role === "assistant" ? role : undefined,
    );
    foundRenderedParts = renderedParts.length > 0;
    visit(renderedParts, 0);

    // The API resource and rendered DOM image can use different keys for the
    // same SVG. Apply the page background to every SVG in this message so the
    // API copy cannot be rasterized with a mismatched white backdrop.
    const svgBackgroundColor = renderedParts
      .map((part) => getSafeRenderedSvgBackgroundColor(
        part.rendered_svg_background_color,
      ))
      .find((color): color is string => color !== null) ??
      getRenderedMessageSvgBackgroundColor(msg.id);
    if (svgBackgroundColor) {
      for (const resource of resources.values()) {
        if (resource.inlineSvgDataUrl && !resource.svgBackgroundColor) {
          resource.svgBackgroundColor = svgBackgroundColor;
        }
      }
    }
  }

  const result = deduplicateNamedImageResources([...resources.values()]);
  if (!includeRenderedImageParts) {
    variants.set(false, result);
  } else if (foundRenderedParts || cachedRenderedResources?.length) {
    // Do not cache a negative result: older virtualized turns may be mounted
    // later during the same export. Keep positive results for turns that are
    // unmounted again before final conversion.
    variants.set(true, result);
  }
  imageResourceCache.set(msg, variants);
  return result;
}

// Image metadata is walked several times while resolving the active branch.
// Cache per API object for the duration of one load to avoid repeating deep
// metadata traversal and full-page DOM image lookups.
let imageResourceCache = new WeakMap<ApiMessage, Map<boolean, ImageResource[]>>();

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

function getImageFileIdReference(
  value: Record<string, unknown>,
  filename: string | null,
): Pick<ImageResource, "fileId" | "scheme"> | null {
  const mimeType = value.mime_type ?? value.mimeType ?? value.content_type;
  const isImage =
    (typeof mimeType === "string" && mimeType.toLowerCase().startsWith("image/")) ||
    Boolean(filename);
  if (!isImage) return null;

  const fileId = value.file_id ?? value.fileId ?? value.asset_id;
  if (typeof fileId !== "string" || !/^file[-_][A-Za-z0-9_-]{1,255}$/i.test(fileId)) {
    return null;
  }

  const explicitScheme = value.scheme ?? value.storage_scheme;
  const scheme = explicitScheme === "sediment" ? "sediment" : "file-service";
  return { fileId, scheme };
}

function getImageFilename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().split(/[\\/]/).at(-1) ?? "";
  const decoded = (() => {
    try {
      return decodeURIComponent(candidate);
    } catch {
      return candidate;
    }
  })();
  return /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i.test(decoded)
    ? decoded
    : null;
}

function getSandboxImageFilenames(content: string): string[] {
  const filenames = new Set<string>();
  for (const match of content.matchAll(/sandbox:\/mnt\/data\/([^\s)>\]]+)/gi)) {
    const filename = getImageFilename(match[1].split(/[?#]/, 1)[0]);
    if (filename) filenames.add(filename);
  }
  return [...filenames];
}

function imageResourceToPart(
  resource: ImageResource,
  filename?: string,
): Record<string, string | number> {
  const part: Record<string, string | number> = {};
  if (resource.fileId) {
    part.asset_pointer = `${resource.scheme ?? "file-service"}://${resource.fileId}`;
  }
  if (resource.imageUrl) part.image_url = resource.imageUrl;
  if (resource.inlineSvgDataUrl) {
    part.rendered_svg_data_url = resource.inlineSvgDataUrl;
    part.rendered_svg_key = resource.key;
    if (resource.filenameHint) {
      part.image_filename_hint = resource.filenameHint;
    }
    if (resource.svgBackgroundColor) {
      part.rendered_svg_background_color = resource.svgBackgroundColor;
    }
  }
  if (resource.inlineImageDataUrl) {
    part.inline_image_data_url = resource.inlineImageDataUrl;
  }
  if (resource.filenameHint && !part.image_filename_hint) {
    part.image_filename_hint = resource.filenameHint;
  }
  const resolvedFilename = filename ?? resource.filename;
  if (resolvedFilename) part.image_filename = resolvedFilename;
  if (resource.renderedFromDom) part.rendered_from_dom = 1;
  if (resource.downloadLink) part.rendered_download_link = 1;
  return part;
}

function getGeneratedImagePartsWithKeys(message: ApiMessage): Array<{
  key: string;
  part: Record<string, string | number>;
}> {
  // Work from the synthetic message's own parts. Resource extraction can
  // deduplicate two sources with one filename, losing a prefetched blob
  // fallback before the next virtualized window is merged.
  return (message.content?.parts ?? []).flatMap((value) => {
    if (!isRecord(value)) return [];
    const part = value as Record<string, string | number>;
    const key = [
      part.asset_pointer,
      part.image_url,
      part.rendered_svg_key,
      part.inline_image_data_url,
    ].find((candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0
    );
    return key ? [{ key, part }] : [];
  });
}

function getSafeRenderedImageDataUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 28_000_000) return null;
  const match = value.match(
    /^data:(image\/(?:png|jpeg|gif|webp|avif|bmp));base64,([A-Za-z0-9+/=\r\n]+)$/i,
  );
  return match ? value : null;
}

function decodeRenderedImageDataUrl(value: string): {
  base64: string;
  mimeType: string;
  sizeBytes: number;
} {
  const match = value.match(
    /^data:(image\/(?:png|jpeg|gif|webp|avif|bmp));base64,([A-Za-z0-9+/=\r\n]+)$/i,
  );
  if (!match) throw new Error("Rendered image data is invalid.");

  const base64 = match[2].replace(/\s+/g, "");
  const sizeBytes = estimateBase64Size(base64);
  if (!sizeBytes || sizeBytes > MAX_IMAGE_BYTES) {
    throw new Error("Rendered image exceeds the 20 MB export limit.");
  }

  return { base64, mimeType: match[1].toLowerCase(), sizeBytes };
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

function getSafeRenderedSvgDataUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 900_000) {
    return null;
  }

  const comma = value.indexOf(",");
  if (comma < 0) return null;
  const header = value.slice(0, comma);
  return /^data:image\/svg\+xml(?:;charset=[\w-]+)?(?:;base64)?$/i.test(header)
    ? value
    : null;
}

function getSafeRenderedSvgBackgroundColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(
    /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i,
  );
  if (!match) return null;

  const [red, green, blue] = match.slice(1).map(Number);
  if ([red, green, blue].some((channel) => channel > 255)) return null;
  const linearize = (channel: number): number => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * linearize(red) +
    0.7152 * linearize(green) +
    0.0722 * linearize(blue);
  return luminance < 0.4 ? `rgb(${red}, ${green}, ${blue})` : null;
}

function getRenderedSvgBackgroundColor(element: Element): string | null {
  let current: Element | null = element;
  while (current) {
    const backgroundColor = window.getComputedStyle(current).backgroundColor;
    const match = backgroundColor.match(
      /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([\d.]+))?\s*\)$/i,
    );
    if (match) {
      const alpha = match[4] === undefined ? 1 : Number(match[4]);
      if (alpha >= 0.999) {
        return getSafeRenderedSvgBackgroundColor(
          `rgb(${match[1]}, ${match[2]}, ${match[3]})`,
        );
      }
    }
    current = current.parentElement;
  }
  return null;
}

function getRenderedMessageSvgBackgroundColor(messageId: string): string | null {
  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-dil-message-id], [data-message-id], [data-chatgpt-search-message-ids]",
  )) {
    if (!getRenderedMessageIds(element).includes(messageId)) continue;
    return getRenderedSvgBackgroundColor(element);
  }
  return null;
}

function getImageUrlFromPart(part: Record<string, unknown>): string | null {
  const imageUrl = part.image_url ?? part.download_url ?? part.downloadUrl;
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
  expectedRole?: "user" | "assistant",
  root: ParentNode = document,
): Array<Record<string, string | number>> {
  const parts: Array<Record<string, string | number>> = [];

  for (const element of root.querySelectorAll<HTMLElement>(
    "[data-dil-message-id], [data-message-id], [data-chatgpt-search-message-ids]",
  )) {
    const ids = getRenderedMessageIds(element);

    if (!ids.includes(messageId)) continue;

    let svgIndex = 0;
    for (const image of element.querySelectorAll<HTMLImageElement>("img")) {
      const renderedRole = getRenderedMessageRole(image);
      if (expectedRole && renderedRole && renderedRole !== expectedRole) continue;

      const src = image.currentSrc || image.src;
      const filename = getRenderedImageFilename(image, element);
      if (image.dataset.dComponent === "svg" && getSafeRenderedSvgDataUrl(src)) {
        const svgBackgroundColor = getRenderedSvgBackgroundColor(image);
        parts.push({
          rendered_svg_data_url: src,
          rendered_svg_key: `rendered-svg:${messageId}:${svgIndex++}`,
          ...(svgBackgroundColor
            ? { rendered_svg_background_color: svgBackgroundColor }
            : {}),
          rendered_from_dom: 1,
          ...(image.alt ? { image_filename_hint: image.alt } : {}),
          ...(filename ? { image_filename: filename } : {}),
        });
        continue;
      }

      const inlineImageDataUrl = getSafeRenderedImageDataUrl(src);
      if (inlineImageDataUrl) {
        parts.push({
          inline_image_data_url: inlineImageDataUrl,
          rendered_from_dom: 1,
          ...(image.alt ? { image_filename_hint: image.alt } : {}),
          ...(filename ? { image_filename: filename } : {}),
        });
        continue;
      }

      const imageUrl = getSafeHostedImageUrl(src);
      if (imageUrl) {
        parts.push({
          image_url: imageUrl,
          rendered_from_dom: 1,
          ...(image.alt ? { image_filename_hint: image.alt } : {}),
          ...(filename ? { image_filename: filename } : {}),
        });
      }
    }

    // Some file cards expose their authenticated download URL on a link even
    // when the thumbnail is rendered as a background instead of an <img>.
    for (const link of element.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const renderedRole = getRenderedMessageRole(link);
      if (expectedRole && renderedRole && renderedRole !== expectedRole) continue;

      const imageUrl = getSafeHostedImageUrl(link.href);
      const filename = getRenderedImageFilename(link, element);
      if (!imageUrl || (!filename && !/image|download/i.test(link.textContent ?? ""))) {
        continue;
      }
      parts.push({
        image_url: imageUrl,
        rendered_from_dom: 1,
        rendered_download_link: 1,
        ...(filename ? { image_filename: filename } : {}),
      });
    }
  }

  return parts;
}

function getRenderedMessageRole(element: Element): "user" | "assistant" | null {
  const role = element.closest<HTMLElement>("[data-message-author-role]")
    ?.getAttribute("data-message-author-role");
  return role === "user" || role === "assistant" ? role : null;
}

function getRenderedImageFilename(element: Element, messageElement: Element): string | null {
  const pattern = /[\p{L}\p{N}][\p{L}\p{N} ._()\-]*\.(?:png|jpe?g|gif|webp|avif|bmp)\b/iu;
  let current: Element | null = element;
  let depth = 0;

  while (current && current !== messageElement && depth < 5) {
    const candidates = [
      current.getAttribute("alt"),
      current.getAttribute("aria-label"),
      current.getAttribute("title"),
      current.getAttribute("download"),
      current.getAttribute("href"),
      current.childElementCount <= 4 ? current.textContent : null,
    ];
    for (const candidate of candidates) {
      const match = candidate?.match(pattern)?.[0];
      const filename = getImageFilename(match);
      if (filename) return filename;
    }
    current = current.parentElement;
    depth++;
  }

  return null;
}

function getRenderedImagePartsFromElements(
  images: readonly HTMLImageElement[],
  messageElement: Element,
  messageId: string,
): Array<Record<string, string | number>> {
  const parts: Array<Record<string, string | number>> = [];
  let svgIndex = 0;

  for (const image of images) {
    const src = image.currentSrc || image.src;
    const filename = getRenderedImageFilename(image, messageElement);
    const filenameHint = image.alt.trim();
    const label: Record<string, string | number> = filenameHint
      ? { image_filename_hint: filenameHint }
      : {};
    if (image.dataset.dComponent === "svg" && getSafeRenderedSvgDataUrl(src)) {
      const svgBackgroundColor = getRenderedSvgBackgroundColor(image);
      parts.push({
        rendered_svg_data_url: src,
        rendered_svg_key: `rendered-svg:${messageId}:${svgIndex++}`,
        ...(svgBackgroundColor
          ? { rendered_svg_background_color: svgBackgroundColor }
          : {}),
        rendered_from_dom: 1,
        ...label,
        ...(filename ? { image_filename: filename } : {}),
      });
      continue;
    }

    const inlineImageDataUrl = getSafeRenderedImageDataUrl(src);
    if (inlineImageDataUrl) {
      parts.push({
        inline_image_data_url: inlineImageDataUrl,
        rendered_from_dom: 1,
        ...label,
        ...(filename ? { image_filename: filename } : {}),
      });
      continue;
    }

    const imageUrl = getSafeHostedImageUrl(src);
    if (imageUrl) {
      parts.push({
        image_url: imageUrl,
        rendered_from_dom: 1,
        ...label,
        ...(filename ? { image_filename: filename } : {}),
      });
    }
  }

  return parts;
}

function getImagePartsWithSandboxFilenames(
  apiResources: readonly ImageResource[],
  renderedResources: readonly ImageResource[],
  sandboxFilenames: readonly string[],
): Array<Record<string, string | number>> {
  const combinedResources = getImageResources({
    content: {
      content_type: "multimodal",
      parts: [
        ...apiResources.map((resource) => imageResourceToPart(resource)),
        ...renderedResources.map((resource) => imageResourceToPart(resource)),
      ],
    },
  }, false);
  const filenamesByKey = mapImageFilenamesToKeys(
    combinedResources,
    sandboxFilenames,
  );
  return combinedResources.map((resource) =>
    imageResourceToPart(resource, filenamesByKey.get(resource.key))
  );
}

/**
 * Rewrite ChatGPT's temporary sandbox links to the image files bundled in the
 * export. Those links are only valid inside ChatGPT's sandbox and otherwise
 * become dead links in the downloaded Markdown.
 */
function replaceSandboxImageLinks(
  content: string,
  pathsByFilename: ReadonlyMap<string, string>,
  preserveUnresolved = false,
): string {
  const pattern = /(!?\[[^\]]*\]\(\s*)(<sandbox:\/mnt\/data\/[^>]+>|sandbox:\/mnt\/data\/[^)\s]+)([^)]*\))/gi;
  const resolvedPaths = new Map(pathsByFilename);
  const references: Array<{
    full: string;
    prefix: string;
    destination: string;
    suffix: string;
    filename: string;
    key: string;
    isImage: boolean;
    path?: string;
  }> = [];

  for (const match of content.matchAll(pattern)) {
    const destination = match[2].replace(/^<|>$/g, "").split(/[?#]/, 1)[0];
    const filename = getImageFilename(destination);
    if (!filename || !match[0]) continue;
    references.push({
      full: match[0],
      prefix: match[1],
      destination: match[2],
      suffix: match[3],
      filename,
      key: filename.toLocaleLowerCase(),
      isImage: match[1].startsWith("!"),
      path: resolvedPaths.get(filename.toLocaleLowerCase()),
    });
  }

  const embeddedPaths = new Set(
    references.flatMap((reference) =>
      reference.path && reference.isImage ? [reference.path] : [],
    ),
  );
  const seenEmbeddedPaths = new Set<string>();
  const seenLinkPaths = new Set<string>();
  let referenceIndex = 0;

  let rewritten = content.replace(pattern, (full, prefix: string, destination: string, suffix: string) => {
    const filename = getImageFilename(
      destination.replace(/^<|>$/g, "").split(/[?#]/, 1)[0],
    );
    if (!filename) return full;
    const reference = references[referenceIndex++];
    if (!reference) return full;

    if (!reference.path) {
      return preserveUnresolved
        ? full
        : `[Image not bundled: ${reference.filename}]`;
    }
    if (!reference.isImage && embeddedPaths.has(reference.path)) return "";

    if (reference.isImage) {
      if (seenEmbeddedPaths.has(reference.path)) return "";
      seenEmbeddedPaths.add(reference.path);
    } else {
      if (seenLinkPaths.has(reference.path)) return "";
      seenLinkPaths.add(reference.path);
    }

    return `${prefix}${reference.path}${suffix}`;
  });

  // Also handle sandbox image paths written as bare URLs rather than Markdown
  // links. Non-image sandbox files are deliberately left untouched.
  rewritten = rewritten.replace(
    /sandbox:\/mnt\/data\/([^\s)\]>]*?\.(?:png|jpe?g|gif|webp|avif|bmp)(?:[?#][^\s)\]>]*)?)/gi,
    (full, rawFilename: string) => {
      const filename = getImageFilename(rawFilename.split(/[?#]/, 1)[0]);
      if (!filename) return full;
      return resolvedPaths.get(filename.toLocaleLowerCase()) ??
        (preserveUnresolved ? full : `[Image not bundled: ${filename}]`);
    },
  );

  return rewritten.replace(/\n{3,}/g, "\n\n");
}

function getRenderedMessageIds(element: Element): string[] {
  return [
    element.getAttribute("data-dil-message-id"),
    element.getAttribute("data-message-id"),
    element.getAttribute("data-chatgpt-search-message-ids"),
  ]
    .filter((id): id is string => Boolean(id))
    .flatMap((id) => id.split(/[\s,]+/));
}

function getRenderedTurnUserId(
  element: Element,
  allMessagesById: ReadonlyMap<string, ApiMessage>,
  activeMessageIds: ReadonlySet<string>,
  branchNodes: readonly ApiMessage[] | null,
): string | null {
  const anchorIds: string[] = [];
  let current: Element | null = element;
  for (let depth = 0; current && depth < 16; depth++, current = current.parentElement) {
    anchorIds.push(...getRenderedMessageIds(current));
    const turnKey = current.getAttribute("data-turn-key");
    if (turnKey) {
      anchorIds.push(turnKey);
      // ChatGPT can put the user's ID on a sibling node inside the virtualized
      // turn wrapper while the image card itself carries an assistant ID.
      anchorIds.push(...Array.from(current.querySelectorAll<HTMLElement>(
        "[data-dil-message-id], [data-message-id], [data-chatgpt-search-message-ids]",
      )).flatMap(getRenderedMessageIds));
    }
    if (current.classList.contains("thread-scroll-container")) break;
  }

  return findActiveTurnUserId(
    [...new Set(anchorIds)],
    branchNodes,
    allMessagesById,
    activeMessageIds,
  );
}

interface RenderedTurnProgressReference {
  turnKey: string;
  userId: string | null;
  referenceId: string | null;
}

function getRenderedTurnProgressReference(
  scroller: HTMLElement | null,
  earliestActiveUserId: string | null,
  allMessagesById: ReadonlyMap<string, ApiMessage>,
  activeMessageIds: ReadonlySet<string>,
  branchNodes: readonly ApiMessage[] | null,
): RenderedTurnProgressReference {
  const firstTurn = scroller?.querySelector<HTMLElement>("[data-turn-key]") ?? null;
  const turnKey = firstTurn?.getAttribute("data-turn-key") ?? "";
  const userId = firstTurn
    ? getRenderedTurnUserId(firstTurn, allMessagesById, activeMessageIds, branchNodes)
    : null;

  // data-turn-key identifies a rendered UI turn; it is not guaranteed to be
  // the API ID of that turn's user message. Compare the resolved user ID and
  // retain direct-key matching only for pages that use the same identifier.
  return {
    turnKey,
    userId,
    referenceId: userId ?? (turnKey === earliestActiveUserId ? turnKey : null),
  };
}

function getRenderedImageApiRole(
  image: Element,
  allMessagesById: ReadonlyMap<string, ApiMessage>,
): string | null {
  let current: Element | null = image;
  for (let depth = 0; current && depth < 12; depth++, current = current.parentElement) {
    const roles = getRenderedMessageIds(current)
      .flatMap((id) => {
        const role = allMessagesById.get(id)?.author?.role;
        return role ? [role] : [];
      });
    const role = roles.find((candidate) =>
      candidate === "assistant" || candidate === "tool"
    ) ?? roles.find((candidate) => candidate === "user");
    if (role) return role;
    if (current.classList.contains("thread-scroll-container")) break;
  }
  return null;
}

interface RenderedFilePreviewScan {
  messages: ApiMessage[];
  candidates: number;
  captured: number;
  failed: number;
}

function getRenderedFilePreviewPart(
  panel: HTMLElement,
  filename: string,
): Record<string, string | number> | null {
  const image = panel.querySelector<HTMLImageElement>("img[src]");
  const source = image?.currentSrc || image?.src;
  const inlineImageDataUrl = getSafeRenderedImageDataUrl(source);
  const imageUrl = inlineImageDataUrl ? null : getSafeHostedImageUrl(source);
  if (!inlineImageDataUrl && !imageUrl) return null;
  return {
    ...(inlineImageDataUrl
      ? { inline_image_data_url: inlineImageDataUrl }
      : { image_url: imageUrl! }),
    image_filename: filename,
    rendered_from_dom: 1,
  };
}

/** ChatGPT file cards expose a button, not an img or download URL, until opened. */
async function getRenderedFilePreviewImages(
  scroller: HTMLElement | null,
  branchNodes: ApiMessage[] | null,
  allMessagesById: ReadonlyMap<string, ApiMessage>,
  activeMessageIds: ReadonlySet<string>,
  selectedMessageIds: ReadonlySet<string> | null,
  attempted: Map<string, number>,
  unresolved: Set<string>,
): Promise<RenderedFilePreviewScan> {
  const result: RenderedFilePreviewScan = {
    messages: [], candidates: 0, captured: 0, failed: 0,
  };
  if (!scroller) return result;

  const viewport = scroller.getBoundingClientRect();
  const buttons = Array.from(scroller.querySelectorAll<HTMLButtonElement>(
    'button[aria-label]',
  ));
  for (const button of buttons) {
    if (!button.isConnected) continue;
    const card = button.parentElement;
    if (!card) continue;
    const title = card.querySelector<HTMLElement>('[title]')?.getAttribute('title');
    const filename = getImageFilename(title);
    if (!filename || !button.getAttribute('aria-label')?.includes(filename)) {
      continue;
    }
    const rect = card.getBoundingClientRect();
    if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
    if (getRenderedMessageRole(button) === "user") continue;
    const sourceId = (() => {
      let current: Element | null = button;
      while (current && current !== scroller) {
        const id = getRenderedMessageIds(current).find((candidate) =>
          ["assistant", "tool"].includes(allMessagesById.get(candidate)?.author?.role ?? "")
        );
        if (id) return id;
        current = current.parentElement;
      }
      return null;
    })();
    if (!sourceId) continue;
    const turnUserId = getRenderedTurnUserId(
      button, allMessagesById, activeMessageIds, branchNodes,
    );
    if (!turnUserId) continue;
    const rowIndex = card.parentElement
      ? Array.from(card.parentElement.children).indexOf(card)
      : 0;
    const key = `${sourceId}:${filename.toLocaleLowerCase()}:${rowIndex}`;
    if ((attempted.get(key) ?? 0) >= 2) continue;
    const sourceMessage = allMessagesById.get(sourceId);
    const hasApiImage = Boolean(sourceMessage && getImageResources({
      ...sourceMessage, id: undefined,
    }, false).some((resource) =>
      resource.filename?.toLocaleLowerCase() === filename.toLocaleLowerCase()
    ));
    const noteFailure = () => {
      result.failed++;
      if (!hasApiImage) unresolved.add(key);
    };
    const candidate = createRenderedGeneratedImageMessage(
      sourceId, sourceMessage, turnUserId, [],
    );
    if (!isGeneratedImageSelected(
      candidate, selectedMessageIds, branchNodes, allMessagesById,
    )) continue;
    result.candidates++;

    // Preserve an existing viewer tab. It may already show this exact file.
    const panelsBefore = Array.from(document.querySelectorAll<HTMLElement>(
      '[role="tabpanel"][data-tab-id^="chatgpt-file:"]',
    ));
    const existingPanel = panelsBefore.find((panel) => isMatchingFilePreviewPanel(
      panel.getAttribute("data-tab-id"),
      panel.getAttribute("aria-label"),
      sourceId,
      filename,
    )) ?? null;
    const openedByScan = !existingPanel;
    attempted.set(key, (attempted.get(key) ?? 0) + 1);
    const originalScrollTop = scroller.scrollTop;
    let previewPanel: HTMLElement | null = existingPanel;
    let capturedThisCard = false;
    try {
      if (openedByScan) button.click();
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        previewPanel = Array.from(document.querySelectorAll<HTMLElement>(
          '[role="tabpanel"][data-tab-id^="chatgpt-file:"]',
        )).find((panel) =>
          isMatchingFilePreviewPanel(
            panel.getAttribute("data-tab-id"),
            panel.getAttribute("aria-label"),
            sourceId,
            filename,
          )
        ) ?? null;
        const part = previewPanel
          ? getRenderedFilePreviewPart(previewPanel, filename)
          : null;
        if (part) {
          result.messages.push(createRenderedGeneratedImageMessage(
            sourceId,
            sourceMessage,
            turnUserId,
            [part],
          ));
          result.captured++;
          attempted.set(key, 2);
          unresolved.delete(key);
          capturedThisCard = true;
          break;
        }
        await sleep(100);
      }
      if (!capturedThisCard) noteFailure();
    } catch (error) {
      noteFailure();
      devWarn("Could not read a ChatGPT image file preview", error);
    } finally {
      const panelToClose = openedByScan
        ? previewPanel ?? Array.from(document.querySelectorAll<HTMLElement>(
          '[role="tabpanel"][data-tab-id^="chatgpt-file:"]',
        )).find((panel) => !panelsBefore.includes(panel))
        : null;
      if (panelToClose) {
        panelToClose.querySelector<HTMLButtonElement>(
          'button[aria-label="Close viewer"]',
        )?.click();
        await sleep(100);
      }
      if (scroller.isConnected) scroller.scrollTop = originalScrollTop;
    }
  }
  return result;
}

interface RenderedRecoveryScanStats {
  domContainersVisited: number;
  imageElementsExamined: number;
  generatedImageCandidates: number;
  candidatesWithActiveTurn: number;
  candidatesWithoutActiveTurn: number;
  containersWithSandboxNames: number;
  containersLinkedToActiveBranch: number;
  containersWithImageResources: number;
  apiRecoveredMessages: number;
  apiRecoveredImageResources: number;
  recoveredImageResources: number;
  renderedTurnSnapshots: Array<{
    questionNumber: number | null;
    userResolved: boolean;
    imageElementCount: number;
    generatedImageCandidateCount: number;
    imageSourceKinds: string[];
    emptyAltImageCount: number;
    generatedImagePreviewCount: number;
    generatedImageGalleryCount: number;
    visibleUnhydratedGalleryCount: number;
    sandboxFilenameCount: number;
  }>;
  questionRecoveryPipeline: Array<{
    questionNumber: number;
    candidateContainerCount: number;
    candidateImageCount: number;
    candidateContainersRejectedAsInactive: number;
    candidateContainersWithoutSource: number;
    containersWithSandboxFilenames: number;
    sandboxFilenameCount: number;
    containersWithApiImageResources: number;
    apiImageResourceCount: number;
    containersWithRenderedParts: number;
    renderedPartCount: number;
    renderedResourceCount: number;
    containersWithNoCombinedResources: number;
    containersWithImageResources: number;
    containersWithDuplicateResources: number;
    recoveredImageResourceCount: number;
  }>;
}

function getUnattachedRenderedGeneratedImages(
  existingMessages: ApiMessage[],
  branchNodes: ApiMessage[] | null,
  allMessagesById: ReadonlyMap<string, ApiMessage>,
  scroller: HTMLElement,
): { messages: ApiMessage[]; stats: RenderedRecoveryScanStats } {
  const stats: RenderedRecoveryScanStats = {
    domContainersVisited: 0,
    imageElementsExamined: 0,
    generatedImageCandidates: 0,
    candidatesWithActiveTurn: 0,
    candidatesWithoutActiveTurn: 0,
    containersWithSandboxNames: 0,
    containersLinkedToActiveBranch: 0,
    containersWithImageResources: 0,
    apiRecoveredMessages: 0,
    apiRecoveredImageResources: 0,
    recoveredImageResources: 0,
    renderedTurnSnapshots: [],
    questionRecoveryPipeline: [],
  };
  const questionByMessageId = getQuestionNumberByMessageId(existingMessages);
  const questionRecoveryByNumber = new Map<number, {
    questionNumber: number;
    candidateContainerCount: number;
    candidateImageCount: number;
    candidateContainersRejectedAsInactive: number;
    candidateContainersWithoutSource: number;
    containersWithSandboxFilenames: number;
    sandboxFilenameCount: number;
    containersWithApiImageResources: number;
    apiImageResourceCount: number;
    containersWithRenderedParts: number;
    renderedPartCount: number;
    renderedResourceCount: number;
    containersWithNoCombinedResources: number;
    containersWithImageResources: number;
    containersWithDuplicateResources: number;
    recoveredImageResourceCount: number;
  }>();
  const getQuestionRecovery = (questionNumber: number | null) => {
    if (questionNumber === null) return null;
    let pipeline = questionRecoveryByNumber.get(questionNumber);
    if (!pipeline) {
      pipeline = {
        questionNumber,
        candidateContainerCount: 0,
        candidateImageCount: 0,
        candidateContainersRejectedAsInactive: 0,
        candidateContainersWithoutSource: 0,
        containersWithSandboxFilenames: 0,
        sandboxFilenameCount: 0,
        containersWithApiImageResources: 0,
        apiImageResourceCount: 0,
        containersWithRenderedParts: 0,
        renderedPartCount: 0,
        renderedResourceCount: 0,
        containersWithNoCombinedResources: 0,
        containersWithImageResources: 0,
        containersWithDuplicateResources: 0,
        recoveredImageResourceCount: 0,
      };
      questionRecoveryByNumber.set(questionNumber, pipeline);
    }
    return pipeline;
  };
  const sandboxFilenamesByQuestion = new Map<number, Set<string>>();
  for (const message of allMessagesById.values()) {
    if (message.author?.role !== "assistant") continue;
    const questionNumber = getDiagnosticQuestionNumber(
      message,
      questionByMessageId,
      allMessagesById,
    );
    if (questionNumber === null) continue;
    const filenames = sandboxFilenamesByQuestion.get(questionNumber) ?? new Set<string>();
    getSandboxImageFilenames(extractText(message)).forEach((filename) => filenames.add(filename));
    sandboxFilenamesByQuestion.set(questionNumber, filenames);
  }
  const activeMessageIds = new Set(
    existingMessages.flatMap((message) => message.id ? [message.id] : []),
  );
  const resolvedBranchIds = branchNodes
    ? new Set(branchNodes.flatMap((message) => message.id ? [message.id] : []))
    : null;
  const existingImageKeys = new Set(
    existingMessages.flatMap((message) =>
      getImageResources(message).map((resource) => resource.key),
    ),
  );
  const generatedBySource = new Map<string, ApiMessage>();
  const recoveredKeys = new Set(existingImageKeys);

  // Keep a question-level snapshot of the DOM before the virtualized page is
  // moved. These counts reveal whether an image node was absent, unclassified,
  // or present but failed later in the recovery pipeline without logging text,
  // IDs, URLs, filenames, or image data.
  stats.renderedTurnSnapshots = Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-turn-key]"),
  ).map((turn) => {
    const turnUserId = getRenderedTurnUserId(
      turn,
      allMessagesById,
      activeMessageIds,
      branchNodes,
    );
    const questionNumber = turnUserId
      ? questionByMessageId.get(turnUserId) ?? null
      : null;
    const images = Array.from(turn.querySelectorAll<HTMLImageElement>("img"));
    const galleries = Array.from(turn.querySelectorAll<HTMLElement>(
      '[data-testid="generated-image-gallery"]',
    ));
    const scrollRect = scroller.getBoundingClientRect();
    const candidateImages = images.filter((image) =>
      isRenderedGeneratedImageCandidate(
        getRenderedMessageRole(image),
        getRenderedImageApiRole(image, allMessagesById),
        image.alt,
        image.closest("[data-chatgpt-search-message-ids]") !== null,
        image.closest(
          '[data-testid="generated-image-preview"], [data-testid="generated-image-gallery"], [data-dil-message-id]',
        ) !== null,
      )
    );
    const sourceKind = (image: HTMLImageElement): string => {
      const src = image.currentSrc || image.src;
      if (!src) return "empty";
      if (src.startsWith("data:image/")) return "data-url";
      if (src.startsWith("blob:")) return "blob";
      if (src.startsWith("https:")) return "https";
      return "other";
    };

    return {
      questionNumber,
      userResolved: Boolean(turnUserId),
      imageElementCount: images.length,
      generatedImageCandidateCount: candidateImages.length,
      imageSourceKinds: [...new Set(candidateImages.map(sourceKind))].sort(),
      emptyAltImageCount: candidateImages.filter((image) => !image.alt.trim()).length,
      generatedImagePreviewCount: candidateImages.filter((image) =>
        image.closest('[data-testid="generated-image-preview"], [data-testid="generated-image-gallery"]') !== null
      ).length,
      generatedImageGalleryCount: galleries.length,
      visibleUnhydratedGalleryCount: scrollRect
        ? galleries.filter((gallery) => {
          const rect = gallery.getBoundingClientRect();
          return rect.bottom > scrollRect.top && rect.top < scrollRect.bottom &&
            !gallery.querySelector('img[src]');
        }).length
        : 0,
      sandboxFilenameCount: questionNumber === null
        ? 0
        : sandboxFilenamesByQuestion.get(questionNumber)?.size ?? 0,
    };
  });

  // Older turns are not mounted in ChatGPT's virtualized page. Recover image
  // generation results from persisted tool nodes before consulting the DOM.
  const apiImages = recoverApiGeneratedImages(
    activeMessageIds,
    branchNodes,
    allMessagesById,
    recoveredKeys,
    (message) => {
      const resources = getImageResources({ ...message, id: undefined }, false);
      const filenamesByKey = mapImageFilenamesToKeys(
        resources,
        [
          ...getSandboxImageFilenames(extractText(message)),
          ...getFollowingSandboxImageFilenames(
            message.id ?? "",
            branchNodes,
            allMessagesById,
          ),
        ],
      );
      return resources.map((resource) => ({
        key: resource.key,
        part: imageResourceToPart(resource, filenamesByKey.get(resource.key)),
      }));
    },
  );
  stats.apiRecoveredMessages = apiImages.length;
  for (const image of apiImages) {
    stats.apiRecoveredImageResources += getImageResources(image, false).length;
    const sourceId = getMessageParentId(image);
    if (sourceId) generatedBySource.set(sourceId, image);
  }

  for (const element of scroller.querySelectorAll<HTMLElement>(
    "[data-turn-key], [data-dil-message-id], [data-message-id], [data-chatgpt-search-message-ids]",
  )) {
    stats.domContainersVisited++;
    const ids = [
      element.dataset.turnKey,
      element.dataset.dilMessageId,
      element.dataset.messageId,
      element.dataset.chatgptSearchMessageIds,
    ]
      .filter((id): id is string => Boolean(id))
      .flatMap((id) => id.split(/[\s,]+/));
    if (ids.length === 0) continue;

    const isTurnWrapper = element.hasAttribute("data-turn-key");
    const containerImages = Array.from(
      element.querySelectorAll<HTMLImageElement>("img"),
    );
    stats.imageElementsExamined += containerImages.length;
    const generatedImages = containerImages.filter((image) => {
      if (isTurnWrapper && image.closest(
        "[data-dil-message-id], [data-message-id], [data-chatgpt-search-message-ids]",
      )) return false;
      const renderedRole = getRenderedMessageRole(image);
      return isRenderedGeneratedImageCandidate(
        renderedRole,
        getRenderedImageApiRole(image, allMessagesById),
        image.alt,
        image.closest("[data-chatgpt-search-message-ids]") !== null,
        image.closest(
          '[data-testid="generated-image-preview"], [data-testid="generated-image-gallery"], [data-dil-message-id]',
        ) !== null,
      );
    });
    stats.generatedImageCandidates += generatedImages.length;
    const turnUserId = generatedImages.length > 0
      ? getRenderedTurnUserId(
        element,
        allMessagesById,
        activeMessageIds,
        branchNodes,
      )
      : null;
    const questionNumber = (turnUserId
      ? questionByMessageId.get(turnUserId)
      : undefined) ?? ids.map((id) => questionByMessageId.get(id))
      .find((number): number is number => number !== undefined) ?? null;
    const questionPipeline = getQuestionRecovery(questionNumber);
    if (generatedImages.length > 0) {
      if (turnUserId) stats.candidatesWithActiveTurn++;
      else stats.candidatesWithoutActiveTurn++;
      if (questionPipeline) {
        questionPipeline.candidateContainerCount++;
        questionPipeline.candidateImageCount += generatedImages.length;
      }
    }

    const candidateIds = [...new Set(ids)].filter((id) => {
      if (resolvedBranchIds?.has(id)) return true;
      if (allMessagesById.has(id) && isMessageLinkedToActiveMessage(
        id,
        allMessagesById,
        activeMessageIds,
      )) return true;
      // The image card's ID may be absent from the API. Its nearest user
      // message must belong to the active branch before recovering the card.
      return turnUserId !== null;
    });
    if (candidateIds.length === 0) {
      if (generatedImages.length > 0 && questionPipeline) {
        questionPipeline.candidateContainersRejectedAsInactive++;
      }
      continue;
    }
    stats.containersLinkedToActiveBranch++;

    // Sandbox links live in the assistant's text, while the corresponding
    // image can be attached to a related tool message. Walk the candidate
    // messages and their parents so the filename can be matched to that image.
    const relatedIds = getRelatedMessageIdsInTurn(candidateIds, allMessagesById);
    const sandboxFilenames = [...new Set([
      ...(turnUserId
        ? getFollowingSandboxImageFilenames(
          turnUserId,
          branchNodes,
          allMessagesById,
        )
        : []),
      ...[...relatedIds].flatMap((id) => {
        const message = allMessagesById.get(id);
        if (!message || !["assistant", "tool"].includes(message.author?.role ?? "")) {
          return [];
        }
        return getSandboxImageFilenames(extractText(message));
      }),
    ])];
    if (sandboxFilenames.length > 0) stats.containersWithSandboxNames++;
    if (sandboxFilenames.length > 0 && questionPipeline) {
      questionPipeline.containersWithSandboxFilenames++;
      questionPipeline.sandboxFilenameCount = Math.max(
        questionPipeline.sandboxFilenameCount,
        sandboxFilenames.length,
      );
    }
    if (generatedImages.length === 0 && sandboxFilenames.length === 0) continue;
    // ChatGPT's generated-image cards sometimes render with an empty alt, so
    // use the message's own image nodes when its text provides a sandbox name.
    const renderedImageCandidates = generatedImages.length > 0
      ? generatedImages
      : sandboxFilenames.length > 0
        ? Array.from(element.querySelectorAll<HTMLImageElement>("img"))
        : [];

    // Generated images can be represented by an assistant or tool message.
    // Prefer that API node so its authenticated file pointer is used instead
    // of a short-lived page blob URL.
    const apiImageId = [...relatedIds].find((id) => {
      const message = allMessagesById.get(id);
      return Boolean(
        message &&
          ["assistant", "tool"].includes(message.author?.role ?? "") &&
          getImageResources({ ...message, id: undefined }, false).length > 0,
      );
    });
    const sandboxMessageId = [...relatedIds].find((id) => {
      const message = allMessagesById.get(id);
      return message?.author?.role === "assistant" &&
        getSandboxImageFilenames(extractText(message)).length > 0;
    });
    const assistantCandidateId = candidateIds.find((id) => {
      const role = allMessagesById.get(id)?.author?.role;
      return role === "assistant" || role === "tool";
    });
    const sourceId = apiImageId ?? sandboxMessageId ?? assistantCandidateId ?? candidateIds[0];
    if (!sourceId) {
      if (questionPipeline) questionPipeline.candidateContainersWithoutSource++;
      continue;
    }
    const sourceMessage = allMessagesById.get(sourceId);
    const alreadyRecovered = generatedBySource.get(sourceId);
    // A turn wrapper is keyed by the user message. Its uploaded attachments
    // are unrelated to the generated image rendered later in that turn.
    const apiImageResources = sourceMessage &&
      ["assistant", "tool"].includes(sourceMessage.author?.role ?? "")
      ? getImageResources({ ...sourceMessage, id: undefined }, false)
      : alreadyRecovered
        ? getImageResources({ ...alreadyRecovered, id: undefined }, false)
        : [];
    if (apiImageResources.length > 0 && questionPipeline) {
      questionPipeline.containersWithApiImageResources++;
      questionPipeline.apiImageResourceCount = Math.max(
        questionPipeline.apiImageResourceCount,
        apiImageResources.length,
      );
    }

    // A turn wrapper is keyed by its user message, while the image can live
    // in an assistant card with no message ID. Read that card directly.
    let renderedParts = sourceMessage?.author?.role === "user"
      ? []
      : getRenderedImagePartsForMessage(sourceId, "assistant", scroller);
    if (renderedParts.length === 0) {
      renderedParts = getRenderedImagePartsFromElements(
        renderedImageCandidates,
        element,
        sourceId,
      );
    }
    if (renderedParts.length > 0 && questionPipeline) {
      questionPipeline.containersWithRenderedParts++;
      questionPipeline.renderedPartCount = Math.max(
        questionPipeline.renderedPartCount,
        renderedParts.length,
      );
    }

    const renderedResources = renderedParts.length > 0
      ? getImageResources({
          content: { content_type: "multimodal", parts: renderedParts },
        }, false)
      : [];
    if (renderedResources.length > 0 && questionPipeline) {
      questionPipeline.renderedResourceCount = Math.max(
        questionPipeline.renderedResourceCount,
        renderedResources.length,
      );
    }
    const combinedResources = getImageResources({
      content: {
        content_type: "multimodal",
        parts: [
          ...apiImageResources.map((resource) => imageResourceToPart(resource)),
          ...renderedResources.map((resource) => imageResourceToPart(resource)),
        ],
      },
    }, false);
    if (combinedResources.length === 0) {
      if (questionPipeline) questionPipeline.containersWithNoCombinedResources++;
      continue;
    }
    stats.containersWithImageResources++;
    if (questionPipeline) questionPipeline.containersWithImageResources++;

    const parts = getImagePartsWithSandboxFilenames(
      apiImageResources,
      renderedResources,
      sandboxFilenames,
    );
    const currentImageMessage = createRenderedGeneratedImageMessage(
      sourceId,
      sourceMessage,
      turnUserId,
      parts,
    );
    if (alreadyRecovered) {
      generatedBySource.set(sourceId, mergeRecoveredGeneratedImageMessages(
        alreadyRecovered,
        currentImageMessage,
        getGeneratedImagePartsWithKeys,
        turnUserId ?? getMessageParentId(alreadyRecovered),
      ));
      combinedResources.forEach((resource) => recoveredKeys.add(resource.key));
      continue;
    }

    const newResources = combinedResources.filter((resource) =>
      !recoveredKeys.has(resource.key)
    );
    if (newResources.length === 0) {
      if (questionPipeline) questionPipeline.containersWithDuplicateResources++;
      continue;
    }
    stats.recoveredImageResources += newResources.length;
    if (questionPipeline) {
      questionPipeline.recoveredImageResourceCount += newResources.length;
    }
    combinedResources.forEach((resource) => recoveredKeys.add(resource.key));
    generatedBySource.set(sourceId, currentImageMessage);
  }

  stats.questionRecoveryPipeline = [...questionRecoveryByNumber.values()]
    .sort((left, right) => left.questionNumber - right.questionNumber);
  return { messages: [...generatedBySource.values()], stats };
}

function hasOlderMessagesLoader(scroller: HTMLElement): boolean {
  // ChatGPT keeps the pagination spinner as the first child of the
  // conversation root. Its accessible text is localized, so use structure.
  return scroller.querySelector(
    '[data-chatgpt-conversation-selection-target] > :first-child > [role="status"]',
  ) !== null;
}

async function waitForRenderedPageToSettle(scroller: HTMLElement | null): Promise<number> {
  if (!scroller) return 0;
  const startedAt = Date.now();
  let lastChangeAt = startedAt;
  const observer = new MutationObserver(() => {
    lastChangeAt = Date.now();
  });
  observer.observe(scroller, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"],
  });
  try {
    while (
      Date.now() - startedAt < 2_500 &&
      (Date.now() - startedAt < 600 || Date.now() - lastChangeAt < 350)
    ) {
      await sleep(100);
    }
  } finally {
    observer.disconnect();
  }

  // Image galleries may mount before their blob <img> nodes. Wait while a
  // visible gallery is still empty, before scrolling it out of the viewport.
  const unhydratedVisibleGalleries = () => {
    const viewport = scroller.getBoundingClientRect();
    return Array.from(scroller.querySelectorAll<HTMLElement>(
      '[data-testid="generated-image-gallery"]',
    )).filter((gallery) => {
      const rect = gallery.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom &&
        !gallery.querySelector('img[src]');
    });
  };
  const hydrationDeadline = Date.now() + 2_000;
  while (unhydratedVisibleGalleries().length > 0 && Date.now() < hydrationDeadline) {
    await sleep(200);
  }
  // Some galleries remain empty because ChatGPT has not mounted their active
  // image yet. Keep scanning other sources and record the unresolved count;
  // a later window may expose the image, but this count is not proof of it.
  return unhydratedVisibleGalleries().length;
}

function addImageDiagnosticEvent(
  diagnostics: ImageExportDiagnostics,
  startedAtMs: number,
  stage: string,
  details: Record<string, unknown>,
): void {
  diagnostics.events.push({
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAtMs)),
    stage,
    details,
  });
}

function getImageDiagnosticKind(resource: ImageResource): string {
  if (resource.inlineSvgDataUrl) return "inline-svg";
  if (resource.inlineImageDataUrl) return "inline-data";
  if (resource.fileId) return resource.scheme ?? "file-service";
  if (resource.imageUrl?.startsWith("blob:")) return "blob-url";
  if (resource.imageUrl) return "hosted-url";
  return "unknown";
}

function safeImageDiagnosticError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(?:https?|blob|data):\/\/\S+/gi, "[url]")
    .replace(/data:image\/[^\s;,]+;base64,[^\s)]+/gi, "[inline image]")
    .replace(/[\r\n\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "unknown image error";
}

function getQuestionNumberByMessageId(
  messages: readonly ApiMessage[],
): Map<string, number> {
  const questionByMessageId = new Map<string, number>();
  let questionNumber = 0;
  for (const message of messages) {
    if (message.author?.role === "user") questionNumber++;
    if (message.id && questionNumber > 0) {
      questionByMessageId.set(message.id, questionNumber);
    }
  }
  return questionByMessageId;
}

function getDiagnosticQuestionNumber(
  message: ApiMessage,
  questionByMessageId: ReadonlyMap<string, number>,
  allMessagesById: ReadonlyMap<string, ApiMessage>,
): number | null {
  const id = message.id ?? "";
  const sourceId = id.startsWith("rendered-generated-image:")
    ? id.slice("rendered-generated-image:".length)
    : id;
  const direct = questionByMessageId.get(sourceId);
  if (direct !== undefined) return direct;
  let currentId = getMessageParentId(message) ??
    (sourceId !== id ? sourceId : null);
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const questionNumber = questionByMessageId.get(currentId);
    if (questionNumber !== undefined) return questionNumber;
    const current = allMessagesById.get(currentId);
    if (!current) break;
    currentId = getMessageParentId(current);
  }
  return null;
}

function findQuestionInsertionIndex(
  messages: readonly ApiMessage[],
  questionNumber: number,
  questionByMessageId: ReadonlyMap<string, number>,
  allMessagesById: ReadonlyMap<string, ApiMessage>,
): number {
  let lastMessageInQuestion = -1;
  messages.forEach((message, index) => {
    if (
      getDiagnosticQuestionNumber(message, questionByMessageId, allMessagesById) ===
      questionNumber
    ) {
      lastMessageInQuestion = index;
    }
  });
  return lastMessageInQuestion >= 0
    ? lastMessageInQuestion + 1
    : messages.length;
}

async function collectPaginatedGeneratedImages(
  existingMessages: ApiMessage[],
  branchNodes: ApiMessage[] | null,
  allMessagesById: ReadonlyMap<string, ApiMessage>,
  conversationId: string,
  diagnostics: ImageExportDiagnostics,
  diagnosticStartedAtMs: number,
  questionByMessageId: ReadonlyMap<string, number>,
  selectedMessageIds: ReadonlySet<string> | null,
): Promise<{
  messages: ApiMessage[];
  prefetched: Map<string, Awaited<ReturnType<typeof requestImage>>>;
}> {
  const recovered = new Map<string, ApiMessage>();
  const prefetched = new Map<string, Awaited<ReturnType<typeof requestImage>>>();
  const attemptedFilePreviews = new Map<string, number>();
  const unresolvedFilePreviews = new Set<string>();
  const blobPrefetchAttempts = new Map<string, number>();
  const activeBranchMessages = branchNodes ?? existingMessages;
  const activeMessageIds = new Set(
    activeBranchMessages.flatMap((message) => message.id ? [message.id] : []),
  );
  const conversationMessageIds = new Set(allMessagesById.keys());
  const readinessStartedAt = performance.now();
  const readinessDeadline = Date.now() + 15_000;
  let scroller: HTMLElement | null = null;
  let previousReadyScroller: HTMLElement | null = null;
  let consecutiveReadySamples = 0;
  let lastScrollerSelection = findConversationScroller(
    document, activeMessageIds, conversationMessageIds,
  );
  let lastScrollerMeasurement = {
    scrollHeight: 0,
    viewportHeight: 0,
    renderedTurnCount: 0,
  };
  while (Date.now() < readinessDeadline) {
    lastScrollerSelection = findConversationScroller(
      document, activeMessageIds, conversationMessageIds,
    );
    const candidate = lastScrollerSelection.scroller;
    const measured = candidate ?? document.querySelector<HTMLElement>(
      ".thread-scroll-container",
    );
    lastScrollerMeasurement = {
      scrollHeight: measured?.scrollHeight ?? 0,
      viewportHeight: measured?.clientHeight ?? 0,
      renderedTurnCount: measured?.querySelectorAll("[data-turn-key]").length ?? 0,
    };
    consecutiveReadySamples = candidate
      ? previousReadyScroller === candidate ? consecutiveReadySamples + 1 : 1
      : 0;
    previousReadyScroller = candidate;
    if (candidate && consecutiveReadySamples >= 2) {
      scroller = candidate;
      break;
    }
    await sleep(100);
  }
  const scrollerReadyWaitMs = Math.max(
    0,
    Math.round(performance.now() - readinessStartedAt),
  );
  addImageDiagnosticEvent(diagnostics, diagnosticStartedAtMs, "image-scan-readiness", {
    ready: Boolean(scroller),
    waitedMs: scrollerReadyWaitMs,
    consecutiveReadySamples,
    scrollerSource: lastScrollerSelection.source,
    threadScrollerCount: lastScrollerSelection.threadScrollerCount,
    visibleThreadScrollerCount: lastScrollerSelection.visibleThreadScrollerCount,
    readyThreadScrollerCount: lastScrollerSelection.readyThreadScrollerCount,
    rejectedForeignThreadScrollerCount:
      lastScrollerSelection.rejectedForeignThreadScrollerCount,
    visibleTurnCount: lastScrollerSelection.visibleTurnCount,
    activeVisibleTurnCount: lastScrollerSelection.activeVisibleTurnCount,
    activeMessageMatches: lastScrollerSelection.activeMessageMatches,
    ...lastScrollerMeasurement,
  });
  if (!scroller) {
    throw new Error(
      "ChatGPT is still loading the conversation. Wait until its messages appear, then export again.",
    );
  }
  const earliestActiveUserId = activeBranchMessages.find(
    (message) => message.author?.role === "user" && message.id,
  )?.id ?? null;
  const initialPageEstimate = scroller
    ? Math.ceil(scroller.scrollHeight / Math.max(1, scroller.clientHeight / 2)) + 10
    : 1;
  // ChatGPT grows the scroll container as older turns are fetched. A page
  // limit based only on its initial height can therefore expire while the
  // export is still making progress through the active conversation.
  const safetyPageLimit = Math.max(40, activeBranchMessages.length * 4 + 20);
  const maxPages = scroller
    ? Math.max(initialPageEstimate, safetyPageLimit)
    : 1;
  const distanceFromBottom = scroller
    ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
    : 0;
  let stopReason = "completed";
  addImageDiagnosticEvent(diagnostics, diagnosticStartedAtMs, "image-scan-start", {
    scrollContainerFound: Boolean(scroller),
    initialScrollTop: scroller?.scrollTop ?? null,
    scrollHeight: scroller?.scrollHeight ?? null,
    viewportHeight: scroller?.clientHeight ?? null,
    earliestActiveUserFound: Boolean(earliestActiveUserId),
    activeBranchMessageCount: activeBranchMessages.length,
    initialPageEstimate,
    safetyPageLimit,
    maxPages,
    scrollerReadyWaitMs,
  });

  async function prefetchVisibleBlobs(
    messages: readonly ApiMessage[],
    existing: readonly ImageResource[],
    page: number,
    phase: string,
  ): Promise<void> {
    const blobResources = selectBlobResourcesForPrefetch(
      messages.flatMap((message) => getImageResources(message, false)),
      existing,
      new Set(prefetched.keys()),
    ).filter((resource) => (blobPrefetchAttempts.get(resource.key) ?? 0) < 3);
    let nextBlob = 0;
    let succeeded = 0;
    let bytesPrefetched = 0;
    const failures: Array<{ resourceKind: string; reason: string }> = [];
    await Promise.all(Array.from(
      { length: Math.min(MAX_CONCURRENT_IMAGE_DOWNLOADS, blobResources.length) },
      async () => {
        while (nextBlob < blobResources.length) {
          const resource = blobResources[nextBlob++];
          blobPrefetchAttempts.set(
            resource.key,
            (blobPrefetchAttempts.get(resource.key) ?? 0) + 1,
          );
          try {
            const downloaded = await requestImage(resource, conversationId);
            prefetched.set(resource.key, downloaded);
            succeeded++;
            bytesPrefetched += downloaded.sizeBytes;
          } catch (error) {
            failures.push({
              resourceKind: getImageDiagnosticKind(resource),
              reason: safeImageDiagnosticError(error),
            });
            devWarn("Could not prefetch a rendered image", error);
          }
        }
      },
    ));
    if (blobResources.length > 0) {
      addImageDiagnosticEvent(diagnostics, diagnosticStartedAtMs, "blob-prefetch", {
        page, phase,
        attempted: blobResources.length,
        succeeded,
        failed: failures.length,
        bytesPrefetched,
        failures,
      });
    }
  }

  try {
    for (let page = 0; page < maxPages; page++) {
      const unresolvedVisibleGalleryCount = await waitForRenderedPageToSettle(scroller);
      const scan = getUnattachedRenderedGeneratedImages(
        existingMessages,
        branchNodes,
        allMessagesById,
        scroller,
      );
      // Fetch ephemeral blobs before opening a file viewer changes the page
      // layout and can unmount this virtualized turn.
      await prefetchVisibleBlobs(
        scan.messages,
        page === 0
          ? existingMessages.flatMap((message) => getImageResources(message))
          : [],
        page,
        "rendered-scan",
      );
      const filePreviews = await getRenderedFilePreviewImages(
        scroller,
        branchNodes,
        allMessagesById,
        activeMessageIds,
        selectedMessageIds,
        attemptedFilePreviews,
        unresolvedFilePreviews,
      );
      await prefetchVisibleBlobs(filePreviews.messages, [], page, "file-preview");
      const visible = [...scan.messages, ...filePreviews.messages];
      const newlyRecoveredQuestions = new Set<number>();
      let newlyRecoveredImageResources = 0;
      for (const message of visible) {
        if (!message.id) continue;
        const previous = recovered.get(message.id);
        const previousKeys = new Set(previous
          ? getGeneratedImagePartsWithKeys(previous).map(({ key }) => key)
          : []);
        if (!previous) {
          recovered.set(message.id, message);
        } else {
          const preferredParentId = [getMessageParentId(message), getMessageParentId(previous)]
            .find((id) => id && allMessagesById.get(id)?.author?.role === "user") ??
            getMessageParentId(message) ?? getMessageParentId(previous);
          recovered.set(message.id, mergeRecoveredGeneratedImageMessages(
            previous,
            message,
            getGeneratedImagePartsWithKeys,
            preferredParentId,
          ));
        }
        const added = getGeneratedImagePartsWithKeys(recovered.get(message.id)!)
          .filter(({ key }) => !previousKeys.has(key)).length;
        newlyRecoveredImageResources += added;
        if (added > 0) {
          const questionNumber = getDiagnosticQuestionNumber(
            recovered.get(message.id)!, questionByMessageId, allMessagesById,
          );
          if (questionNumber !== null) newlyRecoveredQuestions.add(questionNumber);
        }
      }
      const visibleQuestions = [...new Set(visible.flatMap((message) => {
        const questionNumber = getDiagnosticQuestionNumber(
          message,
          questionByMessageId,
          allMessagesById,
        );
        return questionNumber === null ? [] : [questionNumber];
      }))].sort((a, b) => a - b);
      const visibleImageResourceCount = visible.reduce(
        (sum, message) => sum + getImageResources(message, false).length,
        0,
      );
      const firstRenderedTurn = getRenderedTurnProgressReference(
        scroller,
        earliestActiveUserId,
        allMessagesById,
        activeMessageIds,
        branchNodes,
      );
      const olderMessagesLoaderPresent = scroller
        ? hasOlderMessagesLoader(scroller)
        : false;
      const earlierTurnsRemain = scroller
        ? !isGeneratedImageScanComplete(
          firstRenderedTurn.referenceId,
          earliestActiveUserId,
          olderMessagesLoaderPresent,
          scroller.scrollTop,
        )
        : false;
      addImageDiagnosticEvent(diagnostics, diagnosticStartedAtMs, "image-scan-window", {
        page,
        scrollTop: scroller?.scrollTop ?? null,
        scrollHeight: scroller?.scrollHeight ?? null,
        viewportHeight: scroller?.clientHeight ?? null,
        mountedTurnCount: scroller?.querySelectorAll("[data-turn-key]").length ?? 0,
        firstRenderedTurnMatchesEarliestActiveUser: Boolean(
          earliestActiveUserId && firstRenderedTurn.referenceId === earliestActiveUserId
        ),
        firstRenderedTurnUserResolved: Boolean(firstRenderedTurn.userId),
        firstRenderedTurnKeyMatchesEarliestActiveUser: Boolean(
          earliestActiveUserId && firstRenderedTurn.turnKey === earliestActiveUserId
        ),
        olderMessagesLoaderPresent,
        earlierTurnsRemain,
        ...scan.stats,
        recoveredMessagesThisWindow: visible.length,
        recoveredImageResourcesThisWindow: visibleImageResourceCount,
        recoveredQuestionNumbers: visibleQuestions,
        newlyRecoveredQuestionNumbers: [...newlyRecoveredQuestions].sort((a, b) => a - b),
        newlyRecoveredImageResources,
        unresolvedVisibleGalleryCount,
        filePreviewCandidates: filePreviews.candidates,
        filePreviewImagesCaptured: filePreviews.captured,
        filePreviewFailures: filePreviews.failed,
      });

      if (!scroller) {
        stopReason = "scroll-container-not-found";
        break;
      }
      const firstTurnKey = firstRenderedTurn.turnKey;
      if (!earlierTurnsRemain) {
        stopReason = "earliest-active-turn-reached";
        break;
      }
      const firstMessageId = getRenderedMessageIds(
        scroller.querySelector<HTMLElement>(
          "[data-dil-message-id], [data-message-id], [data-chatgpt-search-message-ids]",
        ) ?? scroller,
      ).join(" ");
      const renderedTurns = Array.from(
        scroller.querySelectorAll<HTMLElement>("[data-turn-key]"),
      );
      const renderedSpan = renderedTurns.length > 1
        ? renderedTurns.at(-1)!.getBoundingClientRect().bottom -
          renderedTurns[0].getBoundingClientRect().top
        : renderedTurns[0]?.getBoundingClientRect().height ?? 0;
      // ChatGPT renders the conversation inside one virtualized spacer. Jumping
      // straight to scrollTop=0 skips all intermediate turns, so walk upward in
      // overlapping steps and inspect each mounted window before it unmounts.
      const scrollStep = getGeneratedImageScanStep(scroller.clientHeight, renderedSpan);
      const previousScrollTop = scroller.scrollTop;
      const previousHeight = scroller.scrollHeight;
      scroller.scrollTop = Math.max(0, previousScrollTop - scrollStep);

      let loaded = false;
      const deadline = Date.now() + 20_000;
      const navigationStartedAt = performance.now();
      let paginationRetryCount = 0;
      let nextPaginationRetryAt = Date.now() + 3_000;
      while (Date.now() < deadline) {
        await sleep(150);
        const nextFirstTurn = getRenderedTurnProgressReference(
          scroller,
          earliestActiveUserId,
          allMessagesById,
          activeMessageIds,
          branchNodes,
        );
        const nextTurnKey = nextFirstTurn.turnKey;
        const nextMessageId = getRenderedMessageIds(
          scroller.querySelector<HTMLElement>(
            "[data-dil-message-id], [data-message-id], [data-chatgpt-search-message-ids]",
          ) ?? scroller,
        ).join(" ");
        if (
          scroller.scrollHeight !== previousHeight ||
          Math.abs(scroller.scrollTop - previousScrollTop) > 1 ||
          nextTurnKey !== firstTurnKey ||
          nextMessageId !== firstMessageId
        ) {
          loaded = true;
          break;
        }
        if (isGeneratedImageScanComplete(
          nextFirstTurn.referenceId,
          earliestActiveUserId,
          hasOlderMessagesLoader(scroller),
          scroller.scrollTop,
        )) {
          loaded = true;
          break;
        }
        // Once scrollTop is already zero, setting it to zero again emits no
        // scroll event. Move the top sentinel out of view and back to give
        // ChatGPT's older-message pagination a bounded second chance.
        if (
          previousScrollTop <= 1 && scroller.scrollTop <= 1 &&
          hasOlderMessagesLoader(scroller) &&
          paginationRetryCount < 2 && Date.now() >= nextPaginationRetryAt
        ) {
          paginationRetryCount++;
          const retryScrollTop = await nudgeOlderMessagesLoader(
            scroller,
            previousHeight,
            sleep,
          );
          nextPaginationRetryAt = Date.now() + 5_000;
          addImageDiagnosticEvent(diagnostics, diagnosticStartedAtMs, "image-scan-pagination-retry", {
            page,
            attempt: paginationRetryCount,
            retryScrollTop,
            scrollHeight: scroller.scrollHeight,
            firstRenderedTurnMatchesEarliestActiveUser: Boolean(
              earliestActiveUserId &&
                nextFirstTurn.referenceId === earliestActiveUserId
            ),
          });
        }
      }
      if (!loaded) {
        const currentFirstTurn = getRenderedTurnProgressReference(
          scroller,
          earliestActiveUserId,
          allMessagesById,
          activeMessageIds,
          branchNodes,
        );
        if (isGeneratedImageScanComplete(
          currentFirstTurn.referenceId,
          earliestActiveUserId,
          hasOlderMessagesLoader(scroller),
          scroller.scrollTop,
        )) {
          stopReason = "earliest-active-turn-reached-during-scroll";
          addImageDiagnosticEvent(diagnostics, diagnosticStartedAtMs, "image-scan-scroll", {
            page,
            loaded: false,
            fromScrollTop: previousScrollTop,
            requestedScrollTop: Math.max(0, previousScrollTop - scrollStep),
            actualScrollTop: scroller.scrollTop,
            scrollHeightBefore: previousHeight,
            scrollHeightAfter: scroller.scrollHeight,
            elapsedMs: Math.round(performance.now() - navigationStartedAt),
            paginationRetryCount,
            firstRenderedTurnUserResolved: Boolean(currentFirstTurn.userId),
            firstRenderedTurnMatchesEarliestActiveUser: Boolean(
              earliestActiveUserId &&
                currentFirstTurn.referenceId === earliestActiveUserId
            ),
            firstRenderedTurnKeyMatchesEarliestActiveUser: Boolean(
              earliestActiveUserId && currentFirstTurn.turnKey === earliestActiveUserId
            ),
            stopReason,
          });
          break;
        }
        stopReason = "older-messages-did-not-load";
        addImageDiagnosticEvent(diagnostics, diagnosticStartedAtMs, "image-scan-scroll", {
          page,
          loaded: false,
          fromScrollTop: previousScrollTop,
          requestedScrollTop: Math.max(0, previousScrollTop - scrollStep),
          actualScrollTop: scroller.scrollTop,
          scrollHeightBefore: previousHeight,
          scrollHeightAfter: scroller.scrollHeight,
          elapsedMs: Math.round(performance.now() - navigationStartedAt),
          paginationRetryCount,
          firstRenderedTurnUserResolved: Boolean(currentFirstTurn.userId),
          firstRenderedTurnMatchesEarliestActiveUser: Boolean(
            earliestActiveUserId &&
              currentFirstTurn.referenceId === earliestActiveUserId
          ),
          firstRenderedTurnKeyMatchesEarliestActiveUser: Boolean(
            earliestActiveUserId && currentFirstTurn.turnKey === earliestActiveUserId
          ),
          stopReason,
        });
        throw new Error(
          "ChatGPT did not load older messages needed for generated images. Try exporting again after the conversation finishes loading.",
        );
      }
      const currentFirstTurn = getRenderedTurnProgressReference(
        scroller,
        earliestActiveUserId,
        allMessagesById,
        activeMessageIds,
        branchNodes,
      );
      // The newly reached viewport has not been scanned yet. Even if this
      // scroll reaches the top, ending here would omit its lazy-loaded images.
      if (page === maxPages - 1) {
        stopReason = "scan-page-limit";
        addImageDiagnosticEvent(diagnostics, diagnosticStartedAtMs, "image-scan-limit", {
          maxPages,
          reachedOldestTurn: isGeneratedImageScanComplete(
            currentFirstTurn.referenceId,
            earliestActiveUserId,
            hasOlderMessagesLoader(scroller),
            scroller.scrollTop,
          ),
        });
        throw new Error("ChatGPT has more image pages than this export can safely load.");
      }
      addImageDiagnosticEvent(diagnostics, diagnosticStartedAtMs, "image-scan-scroll", {
        page,
        loaded: true,
        fromScrollTop: previousScrollTop,
        requestedScrollTop: Math.max(0, previousScrollTop - scrollStep),
        actualScrollTop: scroller.scrollTop,
        scrollHeightBefore: previousHeight,
        scrollHeightAfter: scroller.scrollHeight,
        mountedTurnCount: scroller.querySelectorAll("[data-turn-key]").length,
        elapsedMs: Math.round(performance.now() - navigationStartedAt),
      });
    }
    if (unresolvedFilePreviews.size > 0) {
      stopReason = "selected-file-preview-unavailable";
      addImageDiagnosticEvent(diagnostics, diagnosticStartedAtMs, "image-file-preview-error", {
        unresolvedSelectedFilePreviewCount: unresolvedFilePreviews.size,
      });
      throw new Error(
        "ChatGPT did not load one or more selected image file previews needed for export.",
      );
    }
  } catch (error) {
    stopReason = stopReason === "completed" ? "error" : stopReason;
    addImageDiagnosticEvent(diagnostics, diagnosticStartedAtMs, "image-scan-error", {
      reason: safeImageDiagnosticError(error),
      pagesVisited: diagnostics.events.filter((event) => event.stage === "image-scan-window")
        .length,
    });
    throw error;
  } finally {
    const scrollTopBeforeRestore = scroller?.scrollTop ?? null;
    if (scroller?.isConnected) {
      scroller.scrollTop = Math.max(
        0,
        scroller.scrollHeight - scroller.clientHeight - distanceFromBottom,
      );
    }
    addImageDiagnosticEvent(diagnostics, diagnosticStartedAtMs, "image-scan-finish", {
      stopReason,
      recoveredMessageCount: recovered.size,
      prefetchedImageCount: prefetched.size,
      scrollTopBeforeRestore,
      scrollTopAfterRestore: scroller?.scrollTop ?? null,
    });
  }

  return { messages: [...recovered.values()], prefetched };
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

async function fingerprintImage(base64: string): Promise<string> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function estimateBase64Size(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

// -----------------------------------------------------------------------
// MAIN: LOAD ENTIRE CONVERSATION
// -----------------------------------------------------------------------

let loadInFlight: {
  key: string;
  promise: Promise<ConversationData>;
} | null = null;
let cachedLoad: {
  key: string;
  data: ConversationData;
  completedAt: number;
} | null = null;
let cachedRawConversation: {
  key: string;
  messages: Map<string, ApiMessage>;
  currentNode: string | null;
  completedAt: number;
} | null = null;
let lastLoadProgress = 0;

function publishLoadProgress(progress: {
  stage?: "messages" | "images";
  completed?: number;
  total?: number;
} = {}): void {
  void chrome.runtime.sendMessage({
    type: "EXPORT_PROGRESS",
    collected: lastLoadProgress,
    ...progress,
  }).catch(() => {
    /* Progress is optional when the panel is closed. */
  });
}

/**
 * Load the full conversation, paginating through all pages.
 * Deduplicates concurrent calls with a single-flight guard.
 */
async function loadConversation(
  downloadImages: boolean,
  includeGeneratedImages: boolean,
  fetchImages: boolean,
  selectedMessageIds?: string[],
  forceRefresh = false,
): Promise<ConversationData> {
  const selectedKey = selectedMessageIds
    ? [...selectedMessageIds].sort().join(",")
    : "all";
  const key = `${location.pathname}:${downloadImages}:${includeGeneratedImages}:${fetchImages}:${selectedKey}:${forceRefresh}`;
  if (loadInFlight?.key === key) return loadInFlight.promise;
  if (
    !forceRefresh &&
    cachedLoad?.key === key &&
    Date.now() - cachedLoad.completedAt < CONVERSATION_CACHE_TTL_MS
  ) {
    return Promise.resolve(cachedLoad.data);
  }

  lastLoadProgress = 0;
  const promise = doLoadConversation(
    downloadImages,
    includeGeneratedImages,
    fetchImages,
    selectedMessageIds ? new Set(selectedMessageIds) : null,
    forceRefresh,
  )
    .then((data) => {
      cachedLoad = { key, data, completedAt: Date.now() };
      return data;
    })
    .finally(() => {
      if (loadInFlight?.promise === promise) loadInFlight = null;
    });
  loadInFlight = { key, promise };
  return promise;
}

async function doLoadConversation(
  downloadImages: boolean,
  includeGeneratedImages: boolean,
  fetchImages: boolean,
  selectedMessageIds: ReadonlySet<string> | null,
  forceRefresh: boolean,
): Promise<ConversationData> {
  imageResourceCache = new WeakMap();
  const diagnosticStartedAtMs = performance.now();
  const imageDiagnostics: ImageExportDiagnostics = {
    schemaVersion: 1,
    buildId: CHATSCRIBE_BUILD_ID,
    startedAt: new Date().toISOString(),
    settings: {
      bundleImages: downloadImages,
      includeGeneratedImages,
      fetchImages,
      selectedMessagesOnly: selectedMessageIds !== null,
    },
    events: [],
    messages: [],
  };
  addImageDiagnosticEvent(imageDiagnostics, diagnosticStartedAtMs, "conversation-load-start", {
    bundleImages: downloadImages,
    includeGeneratedImages,
    fetchImages,
    selectedMessagesOnly: selectedMessageIds !== null,
  });
  await waitForBridge();

  const rawConvId = extractConversationId();
  if (!rawConvId) {
    throw new Error(
      "Could not determine the ChatGPT conversation ID from the URL.",
    );
  }
  const conversationId = rawConvId;

  devLog("Loading conversation", conversationId);

  // ---- Paginate through all pages (reuse raw API data for export-time image downloads) ----
  const rawCacheKey = location.pathname;
  let allById: Map<string, ApiMessage>;
  let currentNode: string | null;
  let reusedRawConversation = false;

  if (
    !forceRefresh &&
    cachedRawConversation?.key === rawCacheKey &&
    Date.now() - cachedRawConversation.completedAt < CONVERSATION_CACHE_TTL_MS
  ) {
    reusedRawConversation = true;
    allById = new Map(cachedRawConversation.messages);
    currentNode = cachedRawConversation.currentNode;
    lastLoadProgress = allById.size;
    publishLoadProgress();
    devLog(`Reusing ${allById.size} cached raw conversation messages`);
  } else {
    allById = new Map<string, ApiMessage>();

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

        if (isExportable(
          allById.get(id)!,
          downloadImages,
          includeGeneratedImages,
        )) {
          collected++;
        }
      }

      return { page, collected };
    }

    let { page, collected } = await fetchAndCollect(null);
    lastLoadProgress = collected;
    publishLoadProgress();

    currentNode = page.current_node ?? null;
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
      lastLoadProgress = collected;

      devLog(`Page ${pageNum}: ${collected} exportable messages so far`);

      publishLoadProgress();
    }

    cachedRawConversation = {
      key: rawCacheKey,
      messages: new Map(allById),
      currentNode,
      completedAt: Date.now(),
    };
  }

  devLog(`Pagination complete. Raw messages: ${allById.size}`);
  addImageDiagnosticEvent(imageDiagnostics, diagnosticStartedAtMs, "conversation-pagination", {
    rawApiMessageCount: allById.size,
    reusedRawCache: reusedRawConversation,
    currentNodeFound: Boolean(currentNode),
  });

  // ---- Resolve the active branch ----
  const exportableAll = Array.from(allById.values()).filter((m) =>
    isExportable(m, downloadImages, includeGeneratedImages),
  );

  let orderedMessages: ApiMessage[];
  let activeBranchNodes: ApiMessage[] | null = null;
  let branchWalkStopReason = currentNode ? "unresolved" : "no-current-node";
  let branchWalkVisitedNodeCount = 0;
  let usedChronologicalFallback = false;

  if (currentNode) {
    const branchWalk = resolveActiveBranchNodes(allById, currentNode);
    activeBranchNodes = branchWalk.messages;
    branchWalkStopReason = branchWalk.stopReason;
    branchWalkVisitedNodeCount = branchWalk.visitedNodeCount;
    const branch = activeBranchNodes?.filter((message) =>
      isExportable(message, downloadImages, includeGeneratedImages),
    );
    if (branch && branch.length > 0) {
      orderedMessages = branch;
      devLog(
        `Branch walk succeeded: ${orderedMessages.length} messages (current_node path)`,
      );
    } else {
      usedChronologicalFallback = true;
      devWarn("Branch walk failed; falling back to chronological pairing");
      orderedMessages = buildChronologicalMessages(
        exportableAll,
        downloadImages,
        includeGeneratedImages,
      );
    }
  } else {
    usedChronologicalFallback = true;
    devWarn("No current_node; using chronological pairing");
    orderedMessages = buildChronologicalMessages(
      exportableAll,
      downloadImages,
      includeGeneratedImages,
    );
  }

  const questionByMessageId = getQuestionNumberByMessageId(orderedMessages);
  let currentDiagnosticQuestion: number | null = null;
  for (const message of activeBranchNodes ?? []) {
    if (message.author?.role === "user") {
      const exportQuestionNumber = message.id
        ? questionByMessageId.get(message.id)
        : undefined;
      if (exportQuestionNumber !== undefined) {
        currentDiagnosticQuestion = exportQuestionNumber;
      }
    }
    if (message.id && currentDiagnosticQuestion !== null &&
      !questionByMessageId.has(message.id)) {
      questionByMessageId.set(message.id, currentDiagnosticQuestion);
    }
  }
  const apiNodeAuditByQuestion = new Map<number, {
    rawUserNodes: number;
    rawAssistantNodes: number;
    exportableAssistantNodes: number;
    assistantNodesWithText: number;
    assistantApiImageResources: number;
    assistantSandboxReferences: number;
    rawToolNodes: number;
    toolApiImageResources: number;
  }>();
  let unmappedAssistantOrToolNodeCount = 0;
  for (const message of allById.values()) {
    const role = message.author?.role;
    if (role !== "user" && role !== "assistant" && role !== "tool") continue;
    const questionNumber = getDiagnosticQuestionNumber(
      message,
      questionByMessageId,
      allById,
    );
    if (questionNumber === null) {
      if (role === "assistant" || role === "tool") unmappedAssistantOrToolNodeCount++;
      continue;
    }
    const audit = apiNodeAuditByQuestion.get(questionNumber) ?? {
      rawUserNodes: 0,
      rawAssistantNodes: 0,
      exportableAssistantNodes: 0,
      assistantNodesWithText: 0,
      assistantApiImageResources: 0,
      assistantSandboxReferences: 0,
      rawToolNodes: 0,
      toolApiImageResources: 0,
    };
    if (role === "user") audit.rawUserNodes++;
    if (role === "assistant") {
      audit.rawAssistantNodes++;
      if (isExportable(message, downloadImages, includeGeneratedImages)) {
        audit.exportableAssistantNodes++;
      }
      if (extractText(message)) audit.assistantNodesWithText++;
      audit.assistantApiImageResources += getImageResources(message, false).length;
      audit.assistantSandboxReferences += [
        ...extractText(message).matchAll(/sandbox:\/mnt\/data\//gi),
      ].length;
    }
    if (role === "tool") {
      audit.rawToolNodes++;
      audit.toolApiImageResources += getImageResources(message, false).length;
    }
    apiNodeAuditByQuestion.set(questionNumber, audit);
  }
  addImageDiagnosticEvent(imageDiagnostics, diagnosticStartedAtMs, "active-branch-resolved", {
    branchWalkSucceeded: activeBranchNodes !== null,
    branchWalkStopReason,
    branchWalkVisitedNodeCount,
    usedChronologicalFallback,
    activeBranchMessageCount: activeBranchNodes?.length ?? null,
    exportableMessageCount: orderedMessages.length,
    questionCount: new Set(questionByMessageId.values()).size,
    selectedMessageCount: selectedMessageIds?.size ?? orderedMessages.length,
    selectedMessagesOnly: selectedMessageIds !== null,
    unmappedAssistantOrToolNodeCount,
    apiNodeAuditByQuestion: [...apiNodeAuditByQuestion]
      .sort(([left], [right]) => left - right)
      .map(([questionNumber, counts]) => ({ questionNumber, ...counts })),
  });

  let prefetchedGeneratedImages = new Map<
    string,
    Awaited<ReturnType<typeof requestImage>>
  >();
  if (downloadImages && includeGeneratedImages && fetchImages) {
    let recovered: Awaited<ReturnType<typeof collectPaginatedGeneratedImages>>;
    try {
      recovered = await collectPaginatedGeneratedImages(
        orderedMessages,
        activeBranchNodes,
        allById,
        conversationId,
        imageDiagnostics,
        diagnosticStartedAtMs,
        questionByMessageId,
        selectedMessageIds,
      );
    } catch (error) {
      const reason = safeImageDiagnosticError(error);
      imageDiagnostics.failure = { stage: "generated-image-scan", reason };
      addImageDiagnosticEvent(imageDiagnostics, diagnosticStartedAtMs, "image-export-failed", {
        stage: "generated-image-scan",
        reason,
      });
      const diagnosticError = new Error(reason);
      Object.assign(diagnosticError, { imageDiagnostics });
      throw diagnosticError;
    }
    const generatedMessages = recovered.messages;
    prefetchedGeneratedImages = recovered.prefetched;
    addImageDiagnosticEvent(imageDiagnostics, diagnosticStartedAtMs, "generated-image-recovery", {
      recoveredMessageCount: generatedMessages.length,
      recoveredImageResourceCount: generatedMessages.reduce(
        (sum, message) => sum + getImageResources(message, false).length,
        0,
      ),
      recoveredQuestionNumbers: [...new Set(generatedMessages.flatMap((message) => {
        const questionNumber = getDiagnosticQuestionNumber(
          message,
          questionByMessageId,
          allById,
        );
        return questionNumber === null ? [] : [questionNumber];
      }))].sort((a, b) => a - b),
      recoveredMessagesWithoutQuestionNumber: generatedMessages.filter((message) =>
        getDiagnosticQuestionNumber(message, questionByMessageId, allById) === null
      ).length,
      prefetchedBlobCount: prefetchedGeneratedImages.size,
    });

    for (const generated of generatedMessages) {
      const parentId = getMessageParentId(generated);
      const sourceOnBranch = Boolean(parentId && activeBranchNodes?.some(
        (message) => message.id === parentId,
      ));
      const questionNumber = getDiagnosticQuestionNumber(
        generated,
        questionByMessageId,
        allById,
      );
      const insertionIndex = parentId && activeBranchNodes && sourceOnBranch
        ? findBranchInsertionIndex(
            orderedMessages,
            activeBranchNodes,
            parentId,
          )
        : questionNumber !== null
          ? findQuestionInsertionIndex(
            orderedMessages,
            questionNumber,
            questionByMessageId,
            allById,
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
  const imageFilesByFingerprint = new Map<string, ExportImageFile>();
  const imageResourcesToDownload = new Map<string, ImageResource>();
  const diagnosticMessagesById = new Map<string, ImageExportDiagnosticMessage>();
  for (const msg of orderedMessages) {
    if (!msg.id) continue;
    const role = msg.author?.role;
    const resources = getImageResources(msg);
    const text = extractText(msg);
    const sandboxReferenceCount = [...text.matchAll(/sandbox:\/mnt\/data\//gi)].length;
    if (
      role !== "user" && role !== "assistant" &&
      resources.length === 0 && sandboxReferenceCount === 0
    ) continue;
    diagnosticMessagesById.set(msg.id, {
      questionNumber: getDiagnosticQuestionNumber(
        msg,
        questionByMessageId,
        allById,
      ),
      role: role ?? "unknown",
      origin: msg.id.startsWith("rendered-generated-image:")
        ? "rendered-image-recovery"
        : "conversation-api",
      includedBySettings: downloadImages &&
        (role === "user" || (role === "assistant" && includeGeneratedImages)),
      imageResourceCount: resources.length,
      imageResourceKinds: [...new Set(resources.map(getImageDiagnosticKind))].sort(),
      sandboxReferenceCount,
      downloadAttemptedCount: 0,
      downloadedPaths: [],
      downloadFailures: [],
    });
  }
  if (fetchImages) {
    for (const msg of orderedMessages) {
      if (!msg.id) continue;
      if (!isSelectedForImageDownload(msg, selectedMessageIds)) continue;
      const role = msg.author?.role;
      if (role !== "user" && !(role === "assistant" && includeGeneratedImages)) {
        continue;
      }
      const resources = getImageResources(msg);
      const diagnosticMessage = diagnosticMessagesById.get(msg.id);
      if (diagnosticMessage) {
        diagnosticMessage.downloadAttemptedCount = resources.length;
      }
      for (const resource of resources) {
        imageResourcesToDownload.set(resource.key, resource);
      }
    }
  }
  const totalImageDownloads = imageResourcesToDownload.size;
  addImageDiagnosticEvent(imageDiagnostics, diagnosticStartedAtMs, "image-download-plan", {
    uniqueResourceCount: totalImageDownloads,
    messageResourceRecords: [...diagnosticMessagesById.values()].filter((message) =>
      message.downloadAttemptedCount > 0
    ).map((message) => ({
      questionNumber: message.questionNumber,
      role: message.role,
      origin: message.origin,
      imageResourceCount: message.imageResourceCount,
      imageResourceKinds: message.imageResourceKinds,
      sandboxReferenceCount: message.sandboxReferenceCount,
    })),
  });
  let completedImageDownloads = 0;
  if (totalImageDownloads > 0) {
    publishLoadProgress({ stage: "images", completed: 0, total: totalImageDownloads });
  }

  let nextImageIdx = 1;
  let totalImageBytes = 0;

  // Bound parallel image fetches to keep the panel responsive and memory use sane.
  let activeDownloads = 0;
  const downloadQueue: Array<() => void> = [];

  async function limitedDownload<T>(fn: () => Promise<T>): Promise<T> {
    if (activeDownloads >= MAX_CONCURRENT_IMAGE_DOWNLOADS) {
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

  function isSelectedForImageDownload(
    message: ApiMessage,
    selectedIds: ReadonlySet<string> | null,
  ): boolean {
    return isGeneratedImageSelected(
      message,
      selectedIds,
      activeBranchNodes,
      allById,
    );
  }

  // ---- Convert to ExportMessage ----
  const converted = await Promise.all(
    orderedMessages.map(async (msg, idx): Promise<ExportMessage | null> => {
      if (!msg.id) return null;

      const role = msg.author?.role as "user" | "assistant" | undefined;
      if (role !== "user" && role !== "assistant") return null;

      const text = extractText(msg);
      const svgBackgroundColor = getRenderedMessageSvgBackgroundColor(msg.id);
      const imagePaths: string[] = [];
      const renderedDiagramPaths: string[] = [];
      const localImagePathsByFilename = new Map<string, string>();
      let failedImageCount = 0;
      let failedImageDetails: string[] = [];

      const mayIncludeImages = downloadImages &&
        (role !== "assistant" || includeGeneratedImages);
      const hasImageResource = mayIncludeImages && getImageResources(msg).length > 0;
      const mayDownloadImages = fetchImages && mayIncludeImages &&
        isSelectedForImageDownload(msg, selectedMessageIds);
      const diagnosticMessage = diagnosticMessagesById.get(msg.id);
      if (mayDownloadImages) {
        const imageResources = getImageResources(msg);
        if (diagnosticMessage) {
          diagnosticMessage.downloadAttemptedCount = imageResources.length;
        }
        const filenamesByKey = mapImageFilenamesToKeys(
          imageResources,
          getSandboxImageFilenames(text),
        );
        const failedResources: Array<{ filename?: string; detail: string }> = [];

        const downloadedResults = await Promise.all(imageResources.map(async (resource) => {
          const filename = resource.filename ?? filenamesByKey.get(resource.key);
          if (!imageCache.has(resource.key)) {
            imageCache.set(
              resource.key,
              limitedDownload(async () => {
                try {
                  const inlineSvgBase64 = resource.inlineSvgDataUrl
                    ? await renderSvgDataUrlToPngBase64(
                        resource.inlineSvgDataUrl,
                        resource.svgBackgroundColor,
                      )
                    : null;
                  if (resource.inlineSvgDataUrl && !inlineSvgBase64) {
                    throw new Error("Could not render ChatGPT's SVG diagram.");
                  }
                  const downloaded = resource.inlineImageDataUrl
                    ? decodeRenderedImageDataUrl(resource.inlineImageDataUrl)
                    : inlineSvgBase64
                    ? {
                        base64: inlineSvgBase64,
                        mimeType: "image/png",
                        sizeBytes: estimateBase64Size(inlineSvgBase64),
                      }
                    : prefetchedGeneratedImages.get(resource.key) ??
                      await requestImage(resource, conversationId);
                  const fingerprint = await fingerprintImage(downloaded.base64);
                  const existingImage = imageFilesByFingerprint.get(fingerprint);
                  if (existingImage) return existingImage;

                  if (totalImageBytes + downloaded.sizeBytes > MAX_TOTAL_IMAGE_BYTES) {
                    throw new Error(
                      "Images exceed the 200 MB export limit.",
                    );
                  }
                  totalImageBytes += downloaded.sizeBytes;

                  const ext = mimeToExtension(downloaded.mimeType) ?? "png";
                  const imgIdx = nextImageIdx++;
                  const path = `images/image-${String(imgIdx).padStart(3, "0")}.${ext}`;

                  const imageFile = {
                    path,
                    mimeType: downloaded.mimeType,
                    base64: downloaded.base64,
                    sizeBytes: downloaded.sizeBytes,
                  };
                  imageFilesByFingerprint.set(fingerprint, imageFile);
                  return imageFile;
                } finally {
                  completedImageDownloads++;
                  publishLoadProgress({
                    stage: "images",
                    completed: completedImageDownloads,
                    total: totalImageDownloads,
                  });
                }
              }),
            );
          }

          try {
            const imgFile = await imageCache.get(resource.key)!;
            if (diagnosticMessage && !diagnosticMessage.downloadedPaths.includes(imgFile.path)) {
              diagnosticMessage.downloadedPaths.push(imgFile.path);
            }
            return {
              path: imgFile.path,
              renderedSvg: Boolean(resource.inlineSvgDataUrl),
              filename,
              renderedFromDom: resource.renderedFromDom,
            };
          } catch (err) {
            diagnosticMessage?.downloadFailures.push(safeImageDiagnosticError(err));
            const safeFilename = filename?.replace(/[\r\n\]]/g, " ").trim();
            const reason = (err instanceof Error ? err.message : String(err))
              .replace(/https?:\/\/\S+/g, "[image URL]")
              .replace(/[\r\n\]]/g, " ")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 140);
            failedResources.push({
              filename,
              detail: [safeFilename, reason].filter(Boolean).join(": ") ||
                "unknown download error",
            });
            devWarn("Image download failed:", resource.key, err);
            return null;
          }
        }));
        const successfulDownloads = downloadedResults.flatMap((result) =>
          result ? [result] : [],
        );
        failedImageDetails = getUnrecoveredImageFailureDetails(
          failedResources,
          successfulDownloads.flatMap((result) => result.filename ? [result.filename] : []),
        );
        failedImageCount = failedImageDetails.length;
        imagePaths.push(...new Set(successfulDownloads.map((result) => result.path)));
        renderedDiagramPaths.push(...new Set(successfulDownloads
          .filter((result) => result.renderedSvg)
          .map((result) => result.path)));
        for (const result of successfulDownloads) {
          if (result.filename) {
            const normalizedFilename = result.filename.toLocaleLowerCase();
            if (!localImagePathsByFilename.has(normalizedFilename) ||
              !result.renderedFromDom) {
              localImagePathsByFilename.set(normalizedFilename, result.path);
            }
          }
        }
      }

      if (
        !text &&
        imagePaths.length === 0 &&
        failedImageCount === 0 &&
        !hasImageResource
      ) return null;

      const imageMarkdownText = replaceSandboxImageLinks(
        text,
        localImagePathsByFilename,
        true,
      );
      const failureNotice = failedImageCount > 0
        ? `[${failedImageCount} image${failedImageCount === 1 ? "" : "s"} could not be downloaded: ${failedImageDetails.join("; ")}]`
        : "";
      const content = `${text}${text && failureNotice ? "\n\n" : ""}${failureNotice}`;
      const imageMarkdownContent = `${imageMarkdownText}${imageMarkdownText && failureNotice ? "\n\n" : ""}${failureNotice}`;

      return {
        id: msg.id,
        role,
        content,
        ...(svgBackgroundColor ? { svgBackgroundColor } : {}),
        ...(imageMarkdownContent !== content ? { imageMarkdownContent } : {}),
        ...(localImagePathsByFilename.size > 0
          ? { imagePathsByFilename: Object.fromEntries(localImagePathsByFilename) }
          : {}),
        index: idx,
        imagePaths,
        ...(renderedDiagramPaths.length > 0 ? { renderedDiagramPaths } : {}),
        timestamp: msg.create_time ?? undefined,
      };
    }),
  );

  let messages = converted
    .filter((m): m is ExportMessage => m !== null)
    .map((m, i) => ({ ...m, index: i }));

  // A rendered generated-image card may be recovered as a synthetic message
  // because ChatGPT's API omits its bytes. Attach it to the corresponding
  // visible assistant response so its sandbox link and image file become one
  // Markdown image instead of two separate Assistant entries.
  const generatedImageMessages = messages.filter((message) =>
    message.id.startsWith("rendered-generated-image:"),
  );
  const generatedImagesByTarget = new Map<string, ExportMessage[]>();
  const syntheticIdsToMerge = new Set<string>();

  for (const generated of generatedImageMessages) {
    const sourceId = generated.id.slice("rendered-generated-image:".length);
    const followingAssistants = getFollowingAssistantsInTurn(
      sourceId,
      activeBranchNodes,
      messages,
      allById,
    );
    // A later answer can link to a different, corrected image. Only attach
    // this generated card to that answer when its actual filename matches.
    const target = findGeneratedImageMergeTarget(
      sourceId,
      generated.imagePathsByFilename ?? {},
      messages,
      followingAssistants,
      getSandboxImageFilenames,
      selectedMessageIds,
    );

    if (!target) continue;
    syntheticIdsToMerge.add(generated.id);
    const group = generatedImagesByTarget.get(target.id) ?? [];
    group.push(generated);
    generatedImagesByTarget.set(target.id, group);
  }

  for (const [targetId, generatedImages] of generatedImagesByTarget) {
    const target = messages.find((message) => message.id === targetId);
    if (!target) continue;

    const generatedPaths = generatedImages.flatMap((message) => message.imagePaths);
    target.imagePaths = [...new Set([...target.imagePaths, ...generatedPaths])];
    const imagePathsByFilename = new Map(
      Object.entries(target.imagePathsByFilename ?? {}),
    );
    for (const generatedImage of generatedImages) {
      Object.entries(generatedImage.imagePathsByFilename ?? {}).forEach(([filename, path]) => {
        imagePathsByFilename.set(filename, path);
      });
    }
    if (imagePathsByFilename.size > 0) {
      target.imagePathsByFilename = Object.fromEntries(imagePathsByFilename);
    }
    const generatedDiagramPaths = generatedImages.flatMap((message) =>
      message.renderedDiagramPaths ?? [],
    );
    if (generatedDiagramPaths.length > 0) {
      target.renderedDiagramPaths = [...new Set([
        ...(target.renderedDiagramPaths ?? []),
        ...generatedDiagramPaths,
      ])];
    }

    const failureNotices = generatedImages
      .map((message) => message.content)
      .filter(Boolean);
    const sourceContent = [
      target.imageMarkdownContent ?? target.content,
      ...failureNotices,
    ].filter(Boolean).join("\n\n");
    if (failureNotices.length > 0) {
      target.content = [target.content, ...failureNotices].filter(Boolean).join("\n\n");
    }
    const imageMarkdownContent = replaceSandboxImageLinks(
      sourceContent,
      new Map(imagePathsByFilename),
      true,
    );
    if (imageMarkdownContent !== target.content) {
      target.imageMarkdownContent = imageMarkdownContent;
    }
  }

  if (syntheticIdsToMerge.size > 0) {
    messages = messages.filter((message) => !syntheticIdsToMerge.has(message.id));
    messages.forEach((message, index) => {
      message.index = index;
    });
  }

  // Resolve any remaining sandbox references after all recovered image paths
  // have been associated with their visible assistant messages.
  if (fetchImages) {
    for (const message of messages) {
      const sourceContent = message.imageMarkdownContent ?? message.content;
      const imageMarkdownContent = replaceSandboxImageLinks(
        sourceContent,
        new Map(Object.entries(message.imagePathsByFilename ?? {})),
      );
      if (imageMarkdownContent !== message.content) {
        message.imageMarkdownContent = imageMarkdownContent;
      } else {
        delete message.imageMarkdownContent;
      }
      delete message.imagePathsByFilename;
    }
  }

  // Collect settled image files
  const settled = await Promise.allSettled(imageCache.values());
  const imagesByPath = new Map<string, ExportImageFile>();
  for (const result of settled) {
    if (result.status === "fulfilled") {
      imagesByPath.set(result.value.path, result.value);
    }
  }
  const images = [...imagesByPath.values()];
  const messageQuestionNumbersById = Object.fromEntries(orderedMessages.flatMap((message) => {
    if (!message.id) return [];
    const questionNumber = getDiagnosticQuestionNumber(
      message,
      questionByMessageId,
      allById,
    );
    return questionNumber === null ? [] : [[message.id, questionNumber] as const];
  }));

  devLog(`Export ready: ${messages.length} messages, ${images.length} images`);
  imageDiagnostics.messages = [...diagnosticMessagesById.values()];
  addImageDiagnosticEvent(imageDiagnostics, diagnosticStartedAtMs, "image-download-results", {
    uniqueResourcesPlanned: totalImageDownloads,
    imageFilesCreated: images.length,
    totalImageBytes,
    messagesWithImageResources: imageDiagnostics.messages.filter((message) =>
      message.imageResourceCount > 0
    ).length,
    messagesWithDownloadFailures: imageDiagnostics.messages.filter((message) =>
      message.downloadFailures.length > 0
    ).length,
    failedResourceAttempts: imageDiagnostics.messages.reduce(
      (sum, message) => sum + message.downloadFailures.length,
      0,
    ),
    imagePaths: images.map((image) => image.path),
  });
  addImageDiagnosticEvent(imageDiagnostics, diagnosticStartedAtMs, "conversation-export-finish", {
    exportedMessageCount: messages.length,
    exportedQuestionCount: new Set(messages.flatMap((message) => {
      const questionNumber = getDiagnosticQuestionNumber(
        orderedMessages.find((candidate) => candidate.id === message.id) ?? {},
        questionByMessageId,
        allById,
      );
      return questionNumber === null ? [] : [questionNumber];
    })).size,
    imageFileCount: images.length,
  });

  return { messages, images, imageDiagnostics, messageQuestionNumbersById };
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

const onContentStorageChanged: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (changes, area) => {
  if (area !== "sync" || !changes.theme) return;
  const v = changes.theme.newValue;
  toastTheme = v === "light" || v === "dark" ? v : "system";
};
chrome.storage.onChanged.addListener(onContentStorageChanged);

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

const onContentMessage: Parameters<typeof chrome.runtime.onMessage.addListener>[0] =
  (
    message: {
      type: string;
      downloadImages?: boolean;
      includeGeneratedImages?: boolean;
      fetchImages?: boolean;
      forceRefresh?: boolean;
      selectedMessageIds?: string[];
      text?: string;
      message?: string;
    },
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

    if (message.type === CONTENT_LOAD_TYPE) {
      if (loadInFlight) publishLoadProgress();
      void loadConversation(
        message.downloadImages === true,
        message.includeGeneratedImages === true,
        message.fetchImages ?? message.downloadImages === true,
        message.selectedMessageIds,
        message.forceRefresh === true,
      )
        .then((data) => sendResponse({ success: true, data }))
        .catch((err: unknown) => {
          const imageDiagnostics = err && typeof err === "object" &&
              "imageDiagnostics" in err
            ? (err as { imageDiagnostics?: ImageExportDiagnostics }).imageDiagnostics
            : undefined;
          sendResponse({
            success: false,
            error: err instanceof Error ? err.message : String(err),
            ...(imageDiagnostics ? { imageDiagnostics } : {}),
          });
        });
      return true; // Keep channel open for async response
    }

    if (message.type === CONTENT_PING_TYPE) {
      sendResponse({ ready: true, buildId: CHATSCRIBE_BUILD_ID });
      return false;
    }

    if (message.type === "SHOW_EXPORT_SUCCESS") {
      const successMessage = message.message?.trim();
      if (successMessage) showExportSuccess(successMessage);
      return false;
    }

    return false;
  };
chrome.runtime.onMessage.addListener(onContentMessage);

contentCleanupByBuild.set(CHATSCRIBE_BUILD_ID, () => {
  window.removeEventListener("message", onBridgeWindowMessage);
  chrome.storage.onChanged.removeListener(onContentStorageChanged);
  chrome.runtime.onMessage.removeListener(onContentMessage);
  window.clearTimeout(successToastTimer);
  successToast?.remove();
  successToastStyle?.remove();
});
