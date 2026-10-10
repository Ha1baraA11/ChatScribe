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
  isMessageLinkedToActiveMessage,
  walkActiveBranchNodes,
} from "./conversation-branch.ts";
import { renderSvgDataUrlToPngBase64 } from "./svg-template.ts";

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
const CONVERSATION_CACHE_TTL_MS = 2 * 60_000;
const MAX_CONCURRENT_IMAGE_DOWNLOADS = 4;

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
  inlineSvgDataUrl?: string;
  inlineImageDataUrl?: string;
  filename?: string;
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
  if (cached) return cached;

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

    const inlineSvgDataUrl = getSafeRenderedSvgDataUrl(value.rendered_svg_data_url);
    const inlineSvgKey = value.rendered_svg_key;
    if (inlineSvgDataUrl && typeof inlineSvgKey === "string") {
      mergeResource({
        key: inlineSvgKey,
        inlineSvgDataUrl,
        renderedFromDom: value.rendered_from_dom === true,
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
        renderedFromDom: value.rendered_from_dom === true,
        downloadLink: value.rendered_download_link === true,
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
          filename: resource.filename ?? existing.filename,
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

  if (includeRenderedImageParts && msg.id) {
    visit(getRenderedImagePartsForMessage(msg.id), 0);
  }

  const result = deduplicateNamedImageResources([...resources.values()]);
  variants.set(includeRenderedImageParts, result);
  imageResourceCache.set(msg, variants);
  return result;
}

function deduplicateNamedImageResources(resources: ImageResource[]): ImageResource[] {
  const apiFilenames = new Set(resources.flatMap((resource) =>
    !resource.renderedFromDom && resource.filename
      ? [resource.filename.toLocaleLowerCase()]
      : [],
  ));
  const downloadLinkFilenames = new Set(resources.flatMap((resource) =>
    resource.renderedFromDom && resource.downloadLink && resource.filename
      ? [resource.filename.toLocaleLowerCase()]
      : [],
  ));

  return resources.filter((resource) => {
    if (!resource.renderedFromDom || !resource.filename) return true;
    const filename = resource.filename.toLocaleLowerCase();
    if (apiFilenames.has(filename)) return false;
    return resource.downloadLink || !downloadLinkFilenames.has(filename);
  });
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
  }
  if (resource.inlineImageDataUrl) {
    part.inline_image_data_url = resource.inlineImageDataUrl;
  }
  const resolvedFilename = filename ?? resource.filename;
  if (resolvedFilename) part.image_filename = resolvedFilename;
  if (resource.renderedFromDom) part.rendered_from_dom = 1;
  if (resource.downloadLink) part.rendered_download_link = 1;
  return part;
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
): Array<Record<string, string | number>> {
  const parts: Array<Record<string, string | number>> = [];

  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-dil-message-id], [data-message-id], [data-chatgpt-search-message-ids]",
  )) {
    const ids = getRenderedMessageIds(element);

    if (!ids.includes(messageId)) continue;

    let svgIndex = 0;
    for (const image of element.querySelectorAll<HTMLImageElement>("img")) {
      const src = image.currentSrc || image.src;
      const filename = getRenderedImageFilename(image, element);
      if (image.dataset.dComponent === "svg" && getSafeRenderedSvgDataUrl(src)) {
        parts.push({
          rendered_svg_data_url: src,
          rendered_svg_key: `rendered-svg:${messageId}:${svgIndex++}`,
          rendered_from_dom: 1,
          ...(filename ? { image_filename: filename } : {}),
        });
        continue;
      }

      const inlineImageDataUrl = getSafeRenderedImageDataUrl(src);
      if (inlineImageDataUrl) {
        parts.push({
          inline_image_data_url: inlineImageDataUrl,
          rendered_from_dom: 1,
          ...(filename ? { image_filename: filename } : {}),
        });
        continue;
      }

      const imageUrl = getSafeHostedImageUrl(src);
      if (imageUrl) {
        parts.push({
          image_url: imageUrl,
          rendered_from_dom: 1,
          ...(filename ? { image_filename: filename } : {}),
        });
      }
    }

    // Some file cards expose their authenticated download URL on a link even
    // when the thumbnail is rendered as a background instead of an <img>.
    for (const link of element.querySelectorAll<HTMLAnchorElement>("a[href]")) {
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

function getRenderedImageFilename(element: Element, messageElement: Element): string | null {
  const pattern = /[\p{L}\p{N}][\p{L}\p{N} ._()\-]*\.(?:png|jpe?g|gif|webp|avif|bmp)\b/iu;
  let current: Element | null = element;
  let depth = 0;

  while (current && current !== messageElement && depth < 5) {
    const candidates = [
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

/**
 * Rewrite ChatGPT's temporary sandbox links to the image files bundled in the
 * export. Those links are only valid inside ChatGPT's sandbox and otherwise
 * become dead links in the downloaded Markdown.
 */
function replaceSandboxImageLinks(
  content: string,
  pathsByFilename: ReadonlyMap<string, string>,
  renderedImagePaths: readonly string[],
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

  const unmatchedNames = [...new Set(
    references.filter((reference) => !reference.path).map((reference) => reference.key),
  )];
  const matchedPaths = new Set(references.flatMap((reference) =>
    reference.path ? [reference.path] : [],
  ));
  const fallbackPaths = [...new Set(renderedImagePaths)].filter((path) =>
    !matchedPaths.has(path),
  );
  if (unmatchedNames.length > 0 && unmatchedNames.length === fallbackPaths.length) {
    unmatchedNames.forEach((filename, index) => {
      references.forEach((reference) => {
        if (reference.key === filename && !reference.path) {
          reference.path = fallbackPaths[index];
          resolvedPaths.set(filename, fallbackPaths[index]);
        }
      });
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

function isRenderedImageInActiveTurn(
  element: Element,
  candidateId: string,
  activeMessageIds: ReadonlySet<string>,
): boolean {
  let current: Element | null = element;
  for (let depth = 0; current && depth < 10; depth++, current = current.parentElement) {
    const ids = new Set([
      ...getRenderedMessageIds(current),
      ...Array.from(current.querySelectorAll<HTMLElement>(
        "[data-dil-message-id], [data-message-id], [data-chatgpt-search-message-ids]",
      )).flatMap(getRenderedMessageIds),
    ]);
    if (ids.has(candidateId) && [...ids].some((id) => activeMessageIds.has(id))) {
      return true;
    }
  }
  return false;
}

function getUnattachedRenderedGeneratedImages(
  existingMessages: ApiMessage[],
  branchNodes: ApiMessage[] | null,
  allMessagesById: ReadonlyMap<string, ApiMessage>,
): ApiMessage[] {
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

  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-dil-message-id], [data-message-id], [data-chatgpt-search-message-ids]",
  )) {
    const ids = [
      element.dataset.dilMessageId,
      element.dataset.messageId,
      element.dataset.chatgptSearchMessageIds,
    ]
      .filter((id): id is string => Boolean(id))
      .flatMap((id) => id.split(/[\s,]+/));
    if (ids.length === 0) continue;

    const generatedImages = Array.from(
      element.querySelectorAll<HTMLImageElement>("img"),
    ).filter((image) => /generated image/i.test(image.alt));

    const candidateIds = [...new Set(ids)].filter((id) => {
      if (resolvedBranchIds?.has(id)) return true;
      if (allMessagesById.has(id) && isMessageLinkedToActiveMessage(
        id,
        allMessagesById,
        activeMessageIds,
      )) return true;
      // The rendered image can have its own DOM message ID that is absent from
      // the paginated API response. Recover it only when the same visible
      // ChatGPT turn also contains an API ID on the active branch.
      if (generatedImages.length > 0) {
        return isRenderedImageInActiveTurn(element, id, activeMessageIds);
      }
      return false;
    });
    if (candidateIds.length === 0) continue;

    // Sandbox links live in the assistant's text, while the corresponding
    // image can be attached to a related tool message. Walk the candidate
    // messages and their parents so the filename can be matched to that image.
    const relatedIds = new Set(candidateIds);
    for (const candidateId of candidateIds) {
      let message = allMessagesById.get(candidateId);
      const visitedParents = new Set<string>();
      for (let depth = 0; message && depth < 4; depth++) {
        const parentId = getMessageParentId(message);
        if (!parentId || visitedParents.has(parentId)) break;
        visitedParents.add(parentId);
        const parent = allMessagesById.get(parentId);
        if (!parent) break;
        relatedIds.add(parentId);
        message = parent;
      }
    }
    const sandboxFilenames = [...new Set(
      [...relatedIds].flatMap((id) => {
        const message = allMessagesById.get(id);
        if (!message || !["assistant", "tool"].includes(message.author?.role ?? "")) {
          return [];
        }
        return getSandboxImageFilenames(extractText(message));
      }),
    )];
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
    const sourceId = apiImageId ?? sandboxMessageId ?? candidateIds[0];
    if (!sourceId || generatedBySource.has(sourceId)) continue;

    const sourceMessage = allMessagesById.get(sourceId);
    const apiImageResources = sourceMessage
      ? getImageResources({ ...sourceMessage, id: undefined }, false)
      : [];

    if (sourceMessage && apiImageResources.length > 0) {
      const canMapSandboxNames =
        sandboxFilenames.length === apiImageResources.length;
      // Even if the image bytes were already found on another message, keep
      // this synthetic association so the sandbox URL in this response gets
      // a local filename-to-path mapping of its own.
      const needsSandboxNameMapping = canMapSandboxNames;
      if (
        apiImageResources.every((resource) => recoveredKeys.has(resource.key)) &&
        !needsSandboxNameMapping
      ) {
        continue;
      }
      apiImageResources.forEach((resource) => recoveredKeys.add(resource.key));
      generatedBySource.set(sourceId, {
        ...sourceMessage,
        id: `rendered-generated-image:${sourceId}`,
        parent: sourceId,
        author: { role: "assistant" },
        create_time: sourceMessage.create_time ?? Date.now() / 1000,
        end_turn: true,
        content: {
          content_type: "multimodal",
          parts: apiImageResources.map((resource, index) =>
            imageResourceToPart(
              resource,
              canMapSandboxNames ? sandboxFilenames[index] : undefined,
            ),
          ),
        },
      });
      continue;
    }

    let renderedParts = getRenderedImagePartsForMessage(sourceId);
    if (renderedParts.length === 0) {
      let svgIndex = 0;
      const fallbackParts: Array<Record<string, string | number>> = [];
      for (const image of renderedImageCandidates) {
        const src = image.currentSrc || image.src;
        const filename = getRenderedImageFilename(image, element);
        if (image.dataset.dComponent === "svg" && getSafeRenderedSvgDataUrl(src)) {
          fallbackParts.push({
            rendered_svg_data_url: src,
            rendered_svg_key: `rendered-svg:${sourceId}:${svgIndex++}`,
            rendered_from_dom: 1,
            ...(filename ? { image_filename: filename } : {}),
          });
          continue;
        }
        const inlineImageDataUrl = getSafeRenderedImageDataUrl(src);
        if (inlineImageDataUrl) {
          fallbackParts.push({
            inline_image_data_url: inlineImageDataUrl,
            rendered_from_dom: 1,
            ...(filename ? { image_filename: filename } : {}),
          });
          continue;
        }
        const imageUrl = getSafeHostedImageUrl(src);
        if (imageUrl) {
          fallbackParts.push({
            image_url: imageUrl,
            rendered_from_dom: 1,
            ...(filename ? { image_filename: filename } : {}),
          });
        }
      }
      renderedParts = fallbackParts;
    }

    const renderedResources = renderedParts.length > 0
      ? getImageResources({
          content: { content_type: "multimodal", parts: renderedParts },
        }, false)
      : [];
    if (renderedResources.length > 0) {
      const canMapSandboxNames =
        sandboxFilenames.length === renderedResources.length;
      const needsSandboxNameMapping = canMapSandboxNames;
      if (
        renderedResources.every((resource) => recoveredKeys.has(resource.key)) &&
        !needsSandboxNameMapping
      ) {
        continue;
      }
      renderedResources.forEach((resource) => recoveredKeys.add(resource.key));
      generatedBySource.set(sourceId, {
        id: `rendered-generated-image:${sourceId}`,
        parent: sourceMessage ? sourceId : null,
        author: { role: "assistant" },
        create_time: sourceMessage?.create_time ?? Date.now() / 1000,
        end_turn: true,
        content: {
          content_type: "multimodal",
          parts: renderedResources.map((resource, index) =>
            imageResourceToPart(
              resource,
              canMapSandboxNames ? sandboxFilenames[index] : undefined,
            ),
          ),
        },
      });
    }
  }

  return [...generatedBySource.values()];
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

  if (
    !forceRefresh &&
    cachedRawConversation?.key === rawCacheKey &&
    Date.now() - cachedRawConversation.completedAt < CONVERSATION_CACHE_TTL_MS
  ) {
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

  // ---- Resolve the active branch ----
  const exportableAll = Array.from(allById.values()).filter((m) =>
    isExportable(m, downloadImages, includeGeneratedImages),
  );

  let orderedMessages: ApiMessage[];
  let activeBranchNodes: ApiMessage[] | null = null;

  if (currentNode) {
    activeBranchNodes = walkActiveBranchNodes(allById, currentNode);
    const branch = activeBranchNodes?.filter((message) =>
      isExportable(message, downloadImages, includeGeneratedImages),
    );
    if (branch && branch.length > 0) {
      orderedMessages = branch;
      devLog(
        `Branch walk succeeded: ${orderedMessages.length} messages (current_node path)`,
      );
    } else {
      devWarn("Branch walk failed; falling back to chronological pairing");
      orderedMessages = buildChronologicalMessages(
        exportableAll,
        downloadImages,
        includeGeneratedImages,
      );
    }
  } else {
    devWarn("No current_node; using chronological pairing");
    orderedMessages = buildChronologicalMessages(
      exportableAll,
      downloadImages,
      includeGeneratedImages,
    );
  }

  if (downloadImages && includeGeneratedImages) {
    const generatedMessages = getUnattachedRenderedGeneratedImages(
      orderedMessages,
      activeBranchNodes,
      allById,
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
  const imageFilesByFingerprint = new Map<string, ExportImageFile>();
  const imageResourcesToDownload = new Map<string, ImageResource>();
  if (fetchImages) {
    for (const msg of orderedMessages) {
      if (!msg.id) continue;
      if (!isSelectedForImageDownload(msg.id, selectedMessageIds)) continue;
      const role = msg.author?.role;
      if (role !== "user" && !(role === "assistant" && includeGeneratedImages)) {
        continue;
      }
      for (const resource of getImageResources(msg)) {
        imageResourcesToDownload.set(resource.key, resource);
      }
    }
  }
  const totalImageDownloads = imageResourcesToDownload.size;
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
    messageId: string,
    selectedIds: ReadonlySet<string> | null,
  ): boolean {
    if (!selectedIds) return true;
    if (selectedIds.has(messageId)) return true;
    const generatedSourceId = messageId.startsWith("rendered-generated-image:")
      ? messageId.slice("rendered-generated-image:".length)
      : null;
    return generatedSourceId !== null && selectedIds.has(generatedSourceId);
  }

  // ---- Convert to ExportMessage ----
  const converted = await Promise.all(
    orderedMessages.map(async (msg, idx): Promise<ExportMessage | null> => {
      if (!msg.id) return null;

      const role = msg.author?.role as "user" | "assistant" | undefined;
      if (role !== "user" && role !== "assistant") return null;

      const text = extractText(msg);
      const imagePaths: string[] = [];
      const renderedDiagramPaths: string[] = [];
      const localImagePathsByFilename = new Map<string, string>();
      const renderedAttachmentPaths: string[] = [];
      let failedImageCount = 0;
      const failedImageDetails: string[] = [];

      const mayIncludeImages = downloadImages &&
        (role !== "assistant" || includeGeneratedImages);
      const hasImageResource = mayIncludeImages && getImageResources(msg).length > 0;
      const mayDownloadImages = fetchImages && mayIncludeImages &&
        isSelectedForImageDownload(msg.id, selectedMessageIds);
      if (mayDownloadImages) {
        const imageResources = getImageResources(msg);

        const downloadedResults = await Promise.all(imageResources.map(async (resource) => {
          if (!imageCache.has(resource.key)) {
            imageCache.set(
              resource.key,
              limitedDownload(async () => {
                try {
                  const inlineSvgBase64 = resource.inlineSvgDataUrl
                    ? await renderSvgDataUrlToPngBase64(resource.inlineSvgDataUrl)
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
                    : await requestImage(resource, conversationId);
                  const fingerprint = await fingerprintImage(downloaded.base64);
                  const existingImage = imageFilesByFingerprint.get(fingerprint);
                  if (existingImage) return existingImage;

                  if (totalImageBytes + downloaded.sizeBytes > MAX_IMAGE_BYTES) {
                    throw new Error(
                      "Images exceed the 20 MB export limit.",
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
            return {
              path: imgFile.path,
              renderedSvg: Boolean(resource.inlineSvgDataUrl),
              filename: resource.filename,
              renderedFromDom: Boolean(resource.renderedFromDom),
            };
          } catch (err) {
            failedImageCount++;
            const filename = resource.filename?.replace(/[\r\n\]]/g, " ").trim();
            const reason = (err instanceof Error ? err.message : String(err))
              .replace(/https?:\/\/\S+/g, "[image URL]")
              .replace(/[\r\n\]]/g, " ")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 140);
            failedImageDetails.push(
              [filename, reason].filter(Boolean).join(": ") || "unknown download error",
            );
            devWarn("Image download failed:", resource.key, err);
            return null;
          }
        }));
        const successfulDownloads = downloadedResults.flatMap((result) =>
          result ? [result] : [],
        );
        imagePaths.push(...new Set(successfulDownloads.map((result) => result.path)));
        renderedDiagramPaths.push(...new Set(successfulDownloads
          .filter((result) => result.renderedSvg)
          .map((result) => result.path)));
        for (const result of successfulDownloads) {
          if (result.filename) {
            localImagePathsByFilename.set(
              result.filename.toLocaleLowerCase(),
              result.path,
            );
          }
          if (result.renderedFromDom && !result.renderedSvg) {
            renderedAttachmentPaths.push(result.path);
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
        renderedAttachmentPaths,
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
        ...(imageMarkdownContent !== content ? { imageMarkdownContent } : {}),
        ...(renderedAttachmentPaths.length > 0
          ? { renderedImageFallbackPaths: [...new Set(renderedAttachmentPaths)] }
          : {}),
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
    let sourceNode = allById.get(sourceId);
    let target = messages.find((message) =>
      message.id === sourceId && message.role === "assistant",
    );
    const visitedParents = new Set<string>();

    while (!target && sourceNode) {
      // Stop at the user turn. An image-only assistant response should remain
      // its own answer instead of being attached to an assistant from an
      // earlier turn in the conversation.
      if (sourceNode.author?.role === "user") break;
      const parentId = getMessageParentId(sourceNode);
      if (!parentId || visitedParents.has(parentId)) break;
      visitedParents.add(parentId);
      target = messages.find((message) =>
        message.id === parentId && message.role === "assistant",
      );
      sourceNode = allById.get(parentId);
    }

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
    const renderedImageFallbackPaths = [...new Set([
      ...(target.renderedImageFallbackPaths ?? []),
      ...generatedPaths,
    ])];
    if (renderedImageFallbackPaths.length > 0) {
      target.renderedImageFallbackPaths = renderedImageFallbackPaths;
    }
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

    const sourceContent = target.imageMarkdownContent ?? target.content;
    const imageMarkdownContent = replaceSandboxImageLinks(
      sourceContent,
      new Map(imagePathsByFilename),
      renderedImageFallbackPaths,
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
        message.renderedImageFallbackPaths ?? [],
      );
      if (imageMarkdownContent !== message.content) {
        message.imageMarkdownContent = imageMarkdownContent;
      } else {
        delete message.imageMarkdownContent;
      }
      delete message.renderedImageFallbackPaths;
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

    if (message.type === "LOAD_CONVERSATION") {
      if (loadInFlight) publishLoadProgress();
      void loadConversation(
        message.downloadImages === true,
        message.includeGeneratedImages === true,
        message.fetchImages ?? message.downloadImages === true,
        message.selectedMessageIds,
        message.forceRefresh === true,
      )
        .then((data) => sendResponse({ success: true, data }))
        .catch((err: unknown) =>
          sendResponse({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true; // Keep channel open for async response
    }

    if (message.type === "CHATSCRIBE_PING") {
      sendResponse({ ready: true });
      return false;
    }

    if (message.type === "SHOW_EXPORT_SUCCESS") {
      const successMessage = message.message?.trim();
      if (successMessage) showExportSuccess(successMessage);
      return false;
    }

    return false;
  },
);
