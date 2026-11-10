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
import {
  getClaudeConversationId,
  parseClaudeConversation,
  type ClaudeImageReference,
} from "./claude-conversation.ts";
import { readResponseBytesLimited, assertNoRedirect } from "./bounded-response.ts";
import type {
  ConversationData,
  ExportImageFile,
  ExportMessage,
  ImageExportDiagnosticMessage,
  ImageExportDiagnostics,
} from "./types.ts";

const MAX_CONVERSATION_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 200 * 1024 * 1024;
const MAX_PARALLEL_IMAGE_DOWNLOADS = 4;
const REQUEST_TIMEOUT_MS = 30_000;

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
  forceRefresh?: boolean;
  knownRevision?: string;
  returnDataIfChanged?: boolean;
  text?: string;
  watch?: boolean;
}

interface FetchedClaudeConversation {
  raw: unknown;
  organizationId: string;
}

let cachedOrganization: { conversationId: string; organizationId: string } | null = null;

function clearCachedOrganization(): void {
  cachedOrganization = null;
}

interface DownloadedImage {
  image: ExportImageFile;
  path: string;
}

interface AttachedImagesResult {
  images: ExportImageFile[];
  diagnostics?: ImageExportDiagnostics;
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
    redirect: "error",
    headers: { Accept: "application/json" },
    signal: timeoutSignal(),
  });
  assertNoRedirect(response, window.location.origin, "Claude redirected an export request.");
  if (!response.ok) {
    const error = new Error(`CLAUDE_HTTP_${response.status}`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  const bytes = await readResponseBytesLimited(
    response,
    MAX_CONVERSATION_BYTES,
    "This Claude conversation is too large to export safely.",
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
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

async function fetchConversationFromOrganization(
  conversationId: string,
  organizationId: string,
): Promise<unknown> {
  const path = `/api/organizations/${encodeURIComponent(organizationId)}` +
    `/chat_conversations/${encodeURIComponent(conversationId)}` +
    // Read the complete message tree from a strongly consistent snapshot.
    "?tree=True&rendering_mode=messages&render_all_tools=true&consistency=strong";
  const value = await fetchJson(path);
  ensureCurrentConversation(conversationId);
  const record = asRecord(value);
  return asRecord(record?.conversation) ?? value;
}

async function fetchClaudeConversation(
  conversationId: string,
): Promise<FetchedClaudeConversation> {
  if (cachedOrganization && cachedOrganization.conversationId !== conversationId) {
    clearCachedOrganization();
  }

  const cached = cachedOrganization;
  if (cached) {
    try {
      return {
        raw: await fetchConversationFromOrganization(conversationId, cached.organizationId),
        organizationId: cached.organizationId,
      };
    } catch (error) {
      const status = getHttpStatus(error);
      if (status !== 401 && status !== 403 && status !== 404) throw error;
      // Organization membership can change while the tab stays open. Drop
      // only this in-memory lookup and rediscover it once below.
      clearCachedOrganization();
    }
  }

  const organizations = getOrganizationIds(await fetchJson("/api/organizations"));
  ensureCurrentConversation(conversationId);
  if (organizations.length === 0) {
    throw new Error("No Claude organization was available in the signed-in session.");
  }

  let notFoundCount = 0;
  for (const organizationId of organizations) {
    try {
      return {
        raw: await fetchConversationFromOrganization(conversationId, organizationId),
        organizationId,
      };
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

async function downloadImage(
  url: string,
  index: number,
  remainingTotalBytes: number,
  source: "https" | "blob" = "https",
): Promise<DownloadedImage> {
  const parsed = new URL(url, window.location.origin);
  const isPageBlob = source === "blob" && parsed.protocol === "blob:" &&
    parsed.origin === window.location.origin;
  const isClaudeHttps = source === "https" && parsed.protocol === "https:" &&
    (parsed.hostname === "claude.ai" || parsed.hostname.endsWith(".claude.ai") ||
      parsed.hostname === "anthropic.com" || parsed.hostname.endsWith(".anthropic.com"));
  if (!isPageBlob && !isClaudeHttps) {
    throw new Error("external-host");
  }
  const response = await fetch(parsed.href, {
    credentials: parsed.origin === window.location.origin ? "include" : "omit",
    cache: "no-store",
    redirect: "error",
    signal: timeoutSignal(),
  });
  if (source === "blob") {
    if (response.redirected) throw new Error("redirected");
    if (response.url) {
      const finalUrl = new URL(response.url);
      if (finalUrl.protocol !== "blob:" || finalUrl.origin !== window.location.origin) {
        throw new Error("redirected");
      }
    }
  } else {
    assertNoRedirect(response, parsed.origin, "Claude redirected an image request.");
  }
  if (!response.ok) throw new Error("download-failed");
  const bytes = await readResponseBytesLimited(
    response,
    Math.min(MAX_IMAGE_BYTES, remainingTotalBytes),
    "image-too-large",
  );
  if (bytes.length === 0) {
    throw new Error("image-too-large");
  }
  const mimeType = (response.headers.get("content-type") ?? "")
    .toLowerCase().split(";")[0].trim();
  if (!mimeType.startsWith("image/")) throw new Error("not-an-image");
  const path = `images/claude-image-${String(index).padStart(3, "0")}.${extensionForMimeType(mimeType)}`;
  const image: ExportImageFile = {
    path,
    mimeType,
    base64: bytesToBase64(bytes),
    sizeBytes: bytes.length,
  };
  return { image, path };
}

function inlineImageBytes(
  base64: string,
  remainingTotalBytes: number,
): Uint8Array {
  const maximum = Math.min(MAX_IMAGE_BYTES, remainingTotalBytes);
  if (base64.length === 0 || base64.length > Math.ceil(maximum / 3) * 4 + 4) {
    throw new Error("image-too-large");
  }
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error("unreadable-image");
  }
  if (!binary.length || binary.length > maximum) throw new Error("image-too-large");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function createDownloadedImage(
  bytes: Uint8Array,
  mimeTypeValue: string,
  index: number,
): DownloadedImage {
  const mimeType = mimeTypeValue.toLowerCase().split(";")[0].trim();
  if (!mimeType.startsWith("image/")) throw new Error("not-an-image");
  const path = `images/claude-image-${String(index).padStart(3, "0")}.${extensionForMimeType(mimeType)}`;
  const image: ExportImageFile = {
    path,
    mimeType,
    base64: bytesToBase64(bytes),
    sizeBytes: bytes.length,
  };
  return { image, path };
}

function renderedBlobPreviews(messageIds: ReadonlySet<string>): Map<string, string[]> {
  const previews = new Map<string, string[]>();
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const thumbnails = document.querySelectorAll<HTMLElement>(
    '[data-testid="file-thumbnail"][data-item-key]',
  );
  for (const thumbnail of thumbnails) {
    const itemKey = thumbnail.getAttribute("data-item-key") ?? "";
    const messageId = itemKey.split(":")[0];
    if (!uuidPattern.test(messageId) || !messageIds.has(messageId)) continue;

    const row = thumbnail.closest('[data-testid="transcript-row"]');
    const message = row?.querySelector<HTMLElement>(
      '[data-testid="user-message"], [data-testid="assistant-message"]',
    );
    const renderedMessageId = message?.id.match(uuidPattern)?.[0];
    if (renderedMessageId !== messageId) continue;

    for (const image of thumbnail.querySelectorAll<HTMLImageElement>("img")) {
      const rawUrl = image.currentSrc || image.getAttribute("src") || "";
      try {
        const url = new URL(rawUrl);
        if (url.protocol !== "blob:" || url.origin !== window.location.origin) continue;
        const existing = previews.get(messageId) ?? [];
        if (!existing.includes(url.href)) existing.push(url.href);
        previews.set(messageId, existing);
      } catch {
        // Ignore rendered assets that are not a verified same-origin blob.
      }
    }
  }
  return previews;
}

function mergeRenderedPreviews(
  destination: Map<string, string[]>,
  additions: Map<string, string[]>,
): void {
  for (const [messageId, urls] of additions) {
    const existing = destination.get(messageId) ?? [];
    for (const url of urls) if (!existing.includes(url)) existing.push(url);
    destination.set(messageId, existing);
  }
}

function findLoadEarlierButton(): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => {
    const label = `${button.getAttribute("aria-label") ?? ""} ${button.textContent ?? ""}`
      .trim()
      .toLowerCase();
    return !button.disabled && (
      label === "load earlier messages" ||
      label === "load earlier" ||
      label.includes("加载更早")
    );
  }) ?? null;
}

function getMessageIdFromRenderedRow(row: Element): string | null {
  const message = row.querySelector<HTMLElement>(
    '[data-testid="user-message"], [data-testid="assistant-message"]',
  );
  const match = message?.id.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return match?.[0] ?? null;
}

async function collectRenderedBlobPreviews(
  requiredPreviewsByMessage: ReadonlyMap<string, number>,
  conversationId: string,
): Promise<Map<string, string[]>> {
  const messageIds = new Set(requiredPreviewsByMessage.keys());
  const previews = renderedBlobPreviews(messageIds);
  const allFound = (): boolean => [...requiredPreviewsByMessage].every(([id, required]) =>
    (previews.get(id)?.length ?? 0) >= required
  );
  if (!messageIds.size || allFound()) return previews;

  const firstRow = document.querySelector<HTMLElement>('[data-testid="transcript-row"]');
  let scroller: HTMLElement | null = null;
  for (let ancestor = firstRow?.parentElement ?? null; ancestor; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor);
    if (
      ancestor.scrollHeight > ancestor.clientHeight + 32 &&
      (style.overflowY === "auto" || style.overflowY === "scroll")
    ) {
      scroller = ancestor;
      break;
    }
  }
  if (!scroller) return previews;

  const originalScrollTop = scroller.scrollTop;
  const initialVisibleRows = [...document.querySelectorAll<HTMLElement>(
    '[data-testid="transcript-row"]',
  )].filter((row) => {
    const bounds = row.getBoundingClientRect();
    return bounds.bottom > 0 && bounds.top < window.innerHeight;
  });
  const anchorRow = initialVisibleRows[0];
  const anchorMessageId = anchorRow ? getMessageIdFromRenderedRow(anchorRow) : null;
  const anchorOffset = anchorRow?.getBoundingClientRect().top ?? 0;
  try {
    for (const [messageId, requiredCount] of requiredPreviewsByMessage) {
      let row = [...document.querySelectorAll<HTMLElement>(
        '[data-testid="transcript-row"]',
      )].find((candidate) => getMessageIdFromRenderedRow(candidate) === messageId) ?? null;

      // Older rows may be held behind Claude's explicit load-earlier control.
      // Fetch only until this selected message appears or the bound is reached.
      for (let page = 0; !row && page < 64; page++) {
        const button = findLoadEarlierButton();
        if (!button) break;
        scroller.scrollTop = 0;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 60));
        button.click();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 180));
        ensureCurrentConversation(conversationId);
        mergeRenderedPreviews(previews, renderedBlobPreviews(messageIds));
        row = [...document.querySelectorAll<HTMLElement>(
          '[data-testid="transcript-row"]',
        )].find((candidate) => getMessageIdFromRenderedRow(candidate) === messageId) ?? null;
      }

      if (row && (previews.get(messageId)?.length ?? 0) < requiredCount) {
        const scrollerTop = scroller.getBoundingClientRect().top;
        scroller.scrollTop += row.getBoundingClientRect().top - scrollerTop;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 90));
        ensureCurrentConversation(conversationId);
        mergeRenderedPreviews(previews, renderedBlobPreviews(messageIds));
      }
    }
  } finally {
    const anchor = anchorMessageId
      ? [...document.querySelectorAll<HTMLElement>('[data-testid="transcript-row"]')]
        .find((row) => getMessageIdFromRenderedRow(row) === anchorMessageId)
      : null;
    if (anchor) {
      scroller.scrollTop += anchor.getBoundingClientRect().top - anchorOffset;
    } else {
      scroller.scrollTop = originalScrollTop;
    }
  }
  return previews;
}

function safeImageFailure(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code.includes("image-too-large")) return "over-limit";
  if (code.includes("not-an-image")) return "unsupported-type";
  if (code.includes("external-host")) return "unverified-source";
  if (code.includes("redirect")) return "redirect-blocked";
  if (code.includes("unreadable-image")) return "unreadable";
  return "unavailable";
}

async function attachImages(
  messages: ExportMessage[],
  references: ClaudeImageReference[],
  conversationId: string,
  selectedMessageIds?: string[],
): Promise<AttachedImagesResult> {
  const selected = selectedMessageIds ? new Set(selectedMessageIds) : null;
  const eligible = references.filter((reference) => !selected || selected.has(reference.messageId));
  if (eligible.length === 0) return { images: [] };
  const startedAt = Date.now();
  const failuresByReference = new Map<ClaudeImageReference, string>();
  const kindsByMessage = new Map<string, Set<string>>();
  const attemptsByMessage = new Map<string, number>();
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const images: ExportImageFile[] = [];
  let totalBytes = 0;
  let maxConcurrentUrlDownloads = 0;
  const uniqueReferences: ClaudeImageReference[] = [];
  const uniqueReferenceIndexes = new Map<string, number>();
  for (const reference of eligible) {
    if (uniqueReferenceIndexes.has(reference.resourceId)) continue;
    uniqueReferenceIndexes.set(reference.resourceId, uniqueReferences.length);
    uniqueReferences.push(reference);
  }
  const resultsByResource = new Map<string, DownloadedImage | null>();
  const failuresByResource = new Map<string, string>();
  const pendingRendered = new Set<string>();
  const resultsByReference = new Map<ClaudeImageReference, DownloadedImage | null>();
  const messagePreviewQueues = new Map<string, string[]>();
  const messagePreviewOffsets = new Map<string, number>();

  const addImage = (reference: ClaudeImageReference, result: DownloadedImage): void => {
    const message = messagesById.get(reference.messageId);
    if (message && !message.imagePaths.includes(result.path)) message.imagePaths.push(result.path);
  };

  const recordFailure = (reference: ClaudeImageReference, reason: string): void => {
    failuresByReference.set(reference, reason);
  };

  const addKind = (reference: ClaudeImageReference, kind: string): void => {
    const kinds = kindsByMessage.get(reference.messageId) ?? new Set<string>();
    kinds.add(kind);
    kindsByMessage.set(reference.messageId, kinds);
  };

  for (let offset = 0; offset < uniqueReferences.length;) {
    const remainingTotalBytes = MAX_TOTAL_IMAGE_BYTES - totalBytes;
    if (remainingTotalBytes <= 0) {
      for (const reference of uniqueReferences.slice(offset)) {
        resultsByResource.set(reference.resourceId, null);
        failuresByResource.set(reference.resourceId, "over-limit");
        pendingRendered.add(reference.messageId);
      }
      break;
    }

    // Each request can use at most 20 MB. Batch width is capped so the sum of
    // per-request limits never exceeds the 200 MB conversation budget.
    const batchWidth = Math.max(
      1,
      Math.floor(remainingTotalBytes / MAX_IMAGE_BYTES),
    );
    const batchSize = Math.min(
      MAX_PARALLEL_IMAGE_DOWNLOADS,
      batchWidth,
      uniqueReferences.length - offset,
    );
    const batch = uniqueReferences.slice(offset, offset + batchSize);
    maxConcurrentUrlDownloads = Math.max(
      maxConcurrentUrlDownloads,
      batch.filter((reference) => Boolean(reference.url)).length,
    );
    const batchResults = await Promise.all(batch.map(async (reference, batchIndex) => {
      const resourceIndex = offset + batchIndex;
      attemptsByMessage.set(
        reference.messageId,
        (attemptsByMessage.get(reference.messageId) ?? 0) + 1,
      );
      try {
        if (reference.inlineData) {
          const bytes = inlineImageBytes(reference.inlineData, remainingTotalBytes);
          return {
            reference,
            resourceIndex,
            result: createDownloadedImage(
              bytes,
              reference.mimeType ?? "image/png",
              resourceIndex + 1,
            ),
          };
        }
        if (reference.url) {
          return {
            reference,
            resourceIndex,
            result: await downloadImage(
              reference.url,
              resourceIndex + 1,
              remainingTotalBytes,
            ),
          };
        }
        return { reference, resourceIndex, result: null };
      } catch (error) {
        return { reference, resourceIndex, error };
      }
    }));

    for (const item of batchResults) {
      const { reference } = item;
      if ("error" in item) {
        const reason = safeImageFailure(item.error);
        resultsByResource.set(reference.resourceId, null);
        failuresByResource.set(reference.resourceId, reason);
        pendingRendered.add(reference.messageId);
        continue;
      }
      const result = item.result;
      resultsByResource.set(reference.resourceId, result);
      if (!result) {
        pendingRendered.add(reference.messageId);
        continue;
      }
      totalBytes += result.image.sizeBytes;
      images.push(result.image);
    }
    offset += batchSize;
  }

  for (const reference of eligible) {
    const result = resultsByResource.get(reference.resourceId) ?? null;
    resultsByReference.set(reference, result);
    if (!result) {
      const failure = failuresByResource.get(reference.resourceId);
      if (failure) recordFailure(reference, failure);
      pendingRendered.add(reference.messageId);
      continue;
    }
    addImage(reference, result);
    addKind(reference, reference.inlineData ? "api-inline" : "api-url");
  }

  if (pendingRendered.size > 0) {
    const requiredPreviewsByMessage = new Map<string, number>();
    for (const reference of eligible) {
      if (pendingRendered.has(reference.messageId) && !resultsByReference.get(reference)) {
        requiredPreviewsByMessage.set(
          reference.messageId,
          (requiredPreviewsByMessage.get(reference.messageId) ?? 0) + 1,
        );
      }
    }
    const previews = await collectRenderedBlobPreviews(
      requiredPreviewsByMessage,
      conversationId,
    );
    for (const messageId of pendingRendered) {
      messagePreviewQueues.set(messageId, previews.get(messageId) ?? []);
    }

    for (const reference of eligible) {
      if (!pendingRendered.has(reference.messageId) || resultsByReference.get(reference)) continue;
      const cachedResult = resultsByResource.get(reference.resourceId);
      if (cachedResult) {
        resultsByReference.set(reference, cachedResult);
        addImage(reference, cachedResult);
        addKind(reference, "page-blob-preview");
        continue;
      }
      const queue = messagePreviewQueues.get(reference.messageId) ?? [];
      const offset = messagePreviewOffsets.get(reference.messageId) ?? 0;
      const blobUrl = queue[offset];
      if (blobUrl) messagePreviewOffsets.set(reference.messageId, offset + 1);
      if (!blobUrl) continue;
      const imageIndex = (uniqueReferenceIndexes.get(reference.resourceId) ?? 0) + 1;
      try {
        const next = await downloadImage(
          blobUrl,
          imageIndex,
          MAX_TOTAL_IMAGE_BYTES - totalBytes,
          "blob",
        );
        totalBytes += next.image.sizeBytes;
        images.push(next.image);
        resultsByResource.set(reference.resourceId, next);
        resultsByReference.set(reference, next);
        addKind(reference, "page-blob-preview");
        addImage(reference, next);
        failuresByReference.delete(reference);
      } catch (error) {
        recordFailure(reference, safeImageFailure(error));
        resultsByResource.set(reference.resourceId, null);
        resultsByReference.set(reference, null);
      }
    }
  }

  for (const reference of eligible) {
    if (!resultsByReference.get(reference)) {
      if (!failuresByReference.has(reference)) {
        recordFailure(reference, "unavailable");
      }
    }
  }

  const diagnosticMessages: ImageExportDiagnosticMessage[] = messages
    .filter((message) => eligible.some((reference) => reference.messageId === message.id))
    .map((message) => {
      const resources = eligible.filter((reference) => reference.messageId === message.id);
      const failures = resources.flatMap((reference) => {
        const reason = failuresByReference.get(reference);
        return reason ? [reason] : [];
      });
      return {
        questionNumber: null,
        role: message.role,
        origin: resources.some((reference) => reference.source === "rendered-image-recovery")
          ? "rendered-image-recovery"
          : "conversation-api",
        includedBySettings: true,
        imageResourceCount: resources.length,
        imageResourceKinds: [...(kindsByMessage.get(message.id) ?? new Set<string>())],
        sandboxReferenceCount: 0,
        downloadAttemptedCount: attemptsByMessage.get(message.id) ?? 0,
        downloadedPaths: [...message.imagePaths],
        downloadFailures: failures,
      };
    });
  const diagnostics: ImageExportDiagnostics = {
    schemaVersion: 1,
    buildId: CHATSCRIBE_BUILD_ID,
    startedAt: new Date(startedAt).toISOString(),
    settings: {
      bundleImages: true,
      includeGeneratedImages: true,
      fetchImages: true,
      selectedMessagesOnly: selectedMessageIds !== undefined,
    },
    events: [{
      elapsedMs: Math.max(0, Date.now() - startedAt),
      stage: "claude-image-recovery",
      details: {
        resourceCount: eligible.length,
        downloadedCount: images.length,
        failureCount: diagnosticMessages.reduce((sum, item) => sum + item.downloadFailures.length, 0),
        maxConcurrentUrlDownloads,
        renderedPreviewScan: pendingRendered.size > 0,
      },
    }],
    messages: diagnosticMessages,
  };
  return { images, diagnostics };
}

async function readConversation(
  includeThinking: boolean,
  fetchedValue?: FetchedClaudeConversation,
  conversationIdValue?: string,
): Promise<{
  data: ConversationData;
  conversationId: string;
  imageReferences: ClaudeImageReference[];
}> {
  const conversationId = conversationIdValue ?? currentConversationId();
  const fetched = fetchedValue ?? await fetchClaudeConversation(conversationId);
  const parsed = parseClaudeConversation(fetched.raw, {
    includeThinking,
    expectedConversationId: conversationId,
  });
  ensureCurrentConversation(conversationId);
  cachedOrganization = { conversationId, organizationId: fetched.organizationId };
  return {
    conversationId,
    data: {
      messages: parsed.messages,
      images: [],
      revision: parsed.revision,
      artifacts: parsed.artifacts,
      imageMetadataIncluded: true,
    },
    imageReferences: parsed.imageReferences,
  };
}

async function handleLoad(message: ClaudeLoadRequest): Promise<ConversationData> {
  const conversationId = currentConversationId();
  const { data, imageReferences } = await readConversation(
    message.includeClaudeThinking === true,
    undefined,
    conversationId,
  );
  if (message.downloadImages === true && message.fetchImages !== false) {
    const attached = await attachImages(
      data.messages,
      imageReferences,
      conversationId,
      message.selectedMessageIds,
    );
    data.images = attached.images;
    if (attached.diagnostics) data.imageDiagnostics = attached.diagnostics;
    ensureCurrentConversation(conversationId);
  }
  return data;
}

async function handleRevision(message: ClaudeLoadRequest): Promise<{
  conversationId: string;
  revision: string;
  changed?: boolean;
  data?: ConversationData;
}> {
  const conversationId = currentConversationId();
  const fetched = await fetchClaudeConversation(conversationId);
  const { data } = await readConversation(
    message.returnDataIfChanged === true && message.includeClaudeThinking === true,
    fetched,
    conversationId,
  );
  if (!data.revision) throw new Error("Claude did not return a conversation revision.");
  const revisionChanged = message.knownRevision !== data.revision;
  return {
    conversationId,
    revision: data.revision,
    ...(message.returnDataIfChanged === true ? { changed: revisionChanged } : {}),
    ...(message.returnDataIfChanged === true && revisionChanged ? { data } : {}),
  };
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
      if (
        locationChanged &&
        getClaudeConversationId(lastWatchLocation) !== conversationId
      ) {
        clearCachedOrganization();
      }
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
      void handleRevision(message)
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
const onPageHide = (): void => {
  stopWatching();
  clearCachedOrganization();
};
window.addEventListener("pagehide", onPageHide, { once: true });

cleanupByBuild.set(CHATSCRIBE_BUILD_ID, () => {
  chrome.runtime.onMessage.removeListener(onMessage);
  window.removeEventListener("pagehide", onPageHide);
  stopWatching();
  clearCachedOrganization();
});
