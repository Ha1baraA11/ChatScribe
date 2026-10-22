import type { ApiMessage, ExportMessage } from "./types.ts";
import {
  getMessageParentId,
  isMessageLinkedToActiveMessage,
} from "./conversation-branch.ts";

interface RecoverableImagePart {
  key: string;
  part: Record<string, string | number>;
}

/** Bind an opened file viewer to the card that was clicked in the current turn. */
export function isMatchingFilePreviewPanel(
  tabId: string | null,
  label: string | null,
  sourceId: string,
  filename: string,
): boolean {
  return Boolean(
    tabId?.startsWith("chatgpt-file:") &&
    tabId.includes(`:${sourceId}:`) &&
    label === filename,
  );
}

interface NamedImageResource {
  filename?: string;
  imageUrl?: string;
  inlineImageDataUrl?: string;
  renderedFromDom?: boolean;
  downloadLink?: boolean;
}

/** A failed API route is harmless when another source supplied the named image. */
export function getUnrecoveredImageFailureDetails(
  failures: readonly { filename?: string; detail: string }[],
  successfulFilenames: readonly string[],
): string[] {
  const successful = new Set(successfulFilenames.map((name) => name.toLocaleLowerCase()));
  return failures.filter((failure) =>
    !failure.filename || !successful.has(failure.filename.toLocaleLowerCase())
  ).map((failure) => failure.detail);
}

/** Keep browser image fallbacks even when an API image uses the same filename. */
export function deduplicateNamedImageResources<T extends NamedImageResource>(
  resources: readonly T[],
): T[] {
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
    // If the API pointer fails, a prefetched blob or inline preview may be
    // the only available copy. Byte-identical results are deduped later.
    if (resource.imageUrl?.startsWith("blob:") || resource.inlineImageDataUrl) return true;
    const filename = resource.filename.toLocaleLowerCase();
    if (apiFilenames.has(filename)) return false;
    return resource.downloadLink || !downloadLinkFilenames.has(filename);
  });
}

/** A recovered image is its own assistant message, not a copy of its source node. */
export function createRenderedGeneratedImageMessage(
  sourceId: string,
  sourceMessage: ApiMessage | undefined,
  turnUserId: string | null,
  parts: readonly Record<string, string | number>[],
): ApiMessage {
  return {
    id: `rendered-generated-image:${sourceId}`,
    parent: turnUserId ?? (sourceMessage ? sourceId : null),
    author: { role: "assistant" },
    create_time: sourceMessage?.create_time ?? Date.now() / 1000,
    end_turn: true,
    content: { content_type: "multimodal", parts: [...parts] },
  };
}

/** Preserve images found in earlier virtualized windows when a later window is sparse. */
export function mergeRecoveredGeneratedImageMessages(
  previous: ApiMessage,
  current: ApiMessage,
  getImageParts: (message: ApiMessage) => readonly RecoverableImagePart[],
  preferredParentId?: string | null,
): ApiMessage {
  const partsByKey = new Map<string, Record<string, string | number>>();
  for (const message of [previous, current]) {
    for (const { key, part } of getImageParts(message)) {
      partsByKey.set(key, { ...partsByKey.get(key), ...part });
    }
  }
  return {
    ...previous,
    ...current,
    parent: preferredParentId ?? current.parent ?? previous.parent ?? null,
    content: {
      ...previous.content,
      ...current.content,
      content_type: "multimodal",
      parts: [...partsByKey.values()],
    },
  };
}

/** Identify generated image cards when the page omits an assistant role or generic alt. */
export function isRenderedGeneratedImageCandidate(
  renderedRole: string | null,
  apiRole: string | null,
  imageAlt: string,
  hasImageCardId: boolean,
  hasGeneratedImageContainer = false,
): boolean {
  if (renderedRole === "user") return false;
  if (apiRole === "user") {
    return hasGeneratedImageContainer || /generated image/i.test(imageAlt);
  }
  const role = renderedRole ?? apiRole;
  if (role === "assistant" || role === "tool") return true;
  return hasImageCardId || hasGeneratedImageContainer || /generated image/i.test(imageAlt);
}

/** Decide whether older turns remain before the first active user message. */
export function hasEarlierRenderedTurns(
  firstRenderedTurnId: string | null,
  earliestActiveUserId: string | null,
  hasPaginationLoader: boolean,
): boolean {
  if (earliestActiveUserId) return firstRenderedTurnId !== earliestActiveUserId;
  return hasPaginationLoader;
}

/** A mounted first turn can still be several screens above the viewport. */
export function isGeneratedImageScanComplete(
  firstRenderedTurnId: string | null,
  earliestActiveUserId: string | null,
  hasPaginationLoader: boolean,
  scrollTop: number,
): boolean {
  return scrollTop <= 1 && !hasPaginationLoader &&
    !hasEarlierRenderedTurns(firstRenderedTurnId, earliestActiveUserId, hasPaginationLoader);
}

/** Do not start pagination while ChatGPT has mounted an unlaid-out scroller. */
export function isRenderedConversationScrollerReady(
  scrollHeight: number,
  clientHeight: number,
  renderedTurnCount: number,
): boolean {
  return Number.isFinite(scrollHeight) && Number.isFinite(clientHeight) &&
    scrollHeight > 0 && clientHeight > 0 && renderedTurnCount > 0;
}

/** Keep consecutive viewports overlapping so lazy image cards enter view. */
export function getGeneratedImageScanStep(
  viewportHeight: number,
  renderedSpan: number,
): number {
  const overlapStep = Math.max(1, viewportHeight * 0.75);
  return Math.max(1, Math.floor(Math.min(
    overlapStep,
    renderedSpan > 0 ? renderedSpan / 2 : overlapStep,
  )));
}

/** Re-enter the top pagination sentinel without skipping newly loaded turns. */
export async function nudgeOlderMessagesLoader(
  scroller: { scrollTop: number; scrollHeight: number; clientHeight: number },
  previousHeight: number,
  wait: (ms: number) => Promise<void>,
): Promise<number> {
  const retryScrollTop = Math.min(
    scroller.clientHeight + 1,
    Math.max(0, scroller.scrollHeight - scroller.clientHeight),
  );
  scroller.scrollTop = retryScrollTop;
  await wait(150);
  if (scroller.scrollHeight === previousHeight) scroller.scrollTop = 0;
  return retryScrollTop;
}

/** Include parents in the same user turn without reaching earlier answers. */
export function getRelatedMessageIdsInTurn(
  candidateIds: readonly string[],
  allMessagesById: ReadonlyMap<string, ApiMessage>,
): Set<string> {
  const relatedIds = new Set(candidateIds);
  for (const candidateId of candidateIds) {
    let message = allMessagesById.get(candidateId);
    const visitedParents = new Set<string>();
    for (let depth = 0; message && depth < 4; depth++) {
      if (message.author?.role === "user") break;
      const parentId = getMessageParentId(message);
      if (!parentId || visitedParents.has(parentId)) break;
      visitedParents.add(parentId);
      const parent = allMessagesById.get(parentId);
      if (!parent) break;
      relatedIds.add(parentId);
      if (parent.author?.role === "user") break;
      message = parent;
    }
  }
  return relatedIds;
}

/** Resolve a rendered image's DOM/API anchors to the active user turn. */
export function findActiveTurnUserId(
  anchorIds: readonly string[],
  branchNodes: readonly ApiMessage[] | null,
  allMessagesById: ReadonlyMap<string, ApiMessage>,
  activeMessageIds: ReadonlySet<string>,
): string | null {
  for (const anchorId of anchorIds) {
    let currentId: string | null = anchorId;
    const visited = new Set<string>();

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const current = allMessagesById.get(currentId) ??
        branchNodes?.find((node) => node.id === currentId);
      if (!current) break;

      if (current.author?.role === "user") {
        if (activeMessageIds.has(currentId)) return currentId;
        break;
      }

      // A rendered turn key may identify an assistant/tool node. The nearest
      // preceding active user is the reliable selector association even when
      // that node's parent metadata is missing or points at an internal tool.
      const branchIndex = branchNodes?.findIndex((node) => node.id === currentId) ?? -1;
      if (branchIndex >= 0 && branchNodes) {
        for (let index = branchIndex - 1; index >= 0; index--) {
          const node = branchNodes[index];
          if (node.author?.role !== "user") continue;
          if (node.id && activeMessageIds.has(node.id)) return node.id;
          break;
        }
      }

      currentId = getMessageParentId(current);
    }
  }

  return null;
}

function getNearestUserAncestorId(
  messageId: string,
  allMessagesById: ReadonlyMap<string, ApiMessage>,
): string | null {
  let currentId: string | null = messageId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const current = allMessagesById.get(currentId);
    if (!current) return null;
    if (current.author?.role === "user") return currentId;
    currentId = getMessageParentId(current);
  }
  return null;
}

function getFollowingAssistantsFromApiFallback(
  sourceId: string,
  allMessagesById: ReadonlyMap<string, ApiMessage>,
): ApiMessage[] {
  const source = allMessagesById.get(sourceId);
  const userId = getNearestUserAncestorId(sourceId, allMessagesById);
  if (!source || !userId) return [];

  const sameTurnAssistants = [...allMessagesById.values()]
    .filter((candidate) => {
      if (!candidate.id || candidate.author?.role !== "assistant") return false;
      return getNearestUserAncestorId(candidate.id, allMessagesById) === userId;
    });
  const descendants = sameTurnAssistants.filter((candidate) =>
    isMessageLinkedToActiveMessage(
      candidate.id ?? "",
      allMessagesById,
      new Set([sourceId]),
    )
  );
  if (descendants.length > 0) return descendants;

  const laterByTime = sameTurnAssistants.filter((candidate) =>
    typeof source.create_time === "number" &&
    typeof candidate.create_time === "number" &&
    candidate.create_time > source.create_time
  );
  const following = laterByTime.length > 0
    ? laterByTime
    : sameTurnAssistants.length === 1
      ? sameTurnAssistants
      : [];
  return following.sort((left, right) =>
    (left.create_time ?? Number.MAX_SAFE_INTEGER) -
    (right.create_time ?? Number.MAX_SAFE_INTEGER)
  );
}

/** Keep one copy of each live blob before pagination unmounts its turn. */
export function selectBlobResourcesForPrefetch<T extends {
  key: string;
  imageUrl?: string;
}>(
  recovered: readonly T[],
  existing: readonly T[],
  prefetchedKeys: ReadonlySet<string>,
): T[] {
  return [...new Map([...recovered, ...existing]
    .filter((resource) =>
      resource.imageUrl?.startsWith("blob:") && !prefetchedKeys.has(resource.key)
    )
    .map((resource) => [resource.key, resource] as const)).values()];
}

/** Read sandbox filenames from assistant replies after an image tool, in the same user turn. */
export function getFollowingSandboxImageFilenames(
  sourceId: string,
  branchNodes: readonly ApiMessage[] | null,
  allMessagesById?: ReadonlyMap<string, ApiMessage>,
): string[] {
  const filenames = new Set<string>();
  let followingNodes: ApiMessage[];
  if (branchNodes) {
    followingNodes = [];
    const sourceIndex = branchNodes.findIndex((node) => node.id === sourceId);
    if (sourceIndex >= 0) {
      for (const node of branchNodes.slice(sourceIndex + 1)) {
        if (node.author?.role === "user") break;
        followingNodes.push(node);
      }
    }
  } else {
    followingNodes = allMessagesById
      ? getFollowingAssistantsFromApiFallback(sourceId, allMessagesById)
      : [];
  }

  for (const node of followingNodes) {
    if (node.author?.role !== "assistant") continue;
    for (const part of node.content?.parts ?? []) {
      if (typeof part !== "string") continue;
      for (const match of part.matchAll(/sandbox:\/mnt\/data\/([^\s)>\]]+)/gi)) {
        const candidate = match[1].split(/[?#]/, 1)[0].split(/[\\/]/).at(-1) ?? "";
        let filename = candidate;
        try {
          filename = decodeURIComponent(candidate);
        } catch {
          // Keep the original filename when the URL contains malformed escapes.
        }
        if (/\.(?:png|jpe?g|gif|webp|avif|bmp)$/i.test(filename)) {
          filenames.add(filename);
        }
      }
    }
  }
  return [...filenames];
}

/** Match rendered labels first, then use order only when same-turn counts agree. */
export function mapImageFilenamesToKeys<T extends {
  key: string;
  filename?: string;
  filenameHint?: string;
}>(
  resources: readonly T[],
  filenames: readonly string[],
): Map<string, string> {
  const unnamed = resources.filter((resource) => !resource.filename);
  const usedFilenames = new Set(resources.flatMap((resource) =>
    resource.filename ? [resource.filename.toLocaleLowerCase()] : [],
  ));
  const availableFilenames = [...new Map(filenames
    .map((filename) => [filename.toLocaleLowerCase(), filename] as const))
    .values()]
    .filter((filename) => !usedFilenames.has(filename.toLocaleLowerCase()));

  const normalizedName = (value: string): string => {
    const basename = value.trim().split(/[\\/]/).at(-1) ?? "";
    const stem = basename.replace(/\.(?:png|jpe?g|gif|webp|avif|bmp)$/i, "");
    return stem.normalize("NFKC").toLocaleLowerCase()
      .replace(/的/g, "")
      .replace(/[^\p{L}\p{N}]/gu, "");
  };

  const filenamesByNormalizedName = new Map<string, string[]>();
  for (const filename of availableFilenames) {
    const normalized = normalizedName(filename);
    if (!normalized) continue;
    const matches = filenamesByNormalizedName.get(normalized) ?? [];
    matches.push(filename);
    filenamesByNormalizedName.set(normalized, matches);
  }

  const result = new Map<string, string>();
  const matchedFilenames = new Set<string>();
  for (const resource of unnamed) {
    if (!resource.filenameHint) continue;
    const candidates = filenamesByNormalizedName.get(
      normalizedName(resource.filenameHint),
    ) ?? [];
    if (candidates.length !== 1) continue;
    result.set(resource.key, candidates[0]);
    matchedFilenames.add(candidates[0].toLocaleLowerCase());
  }

  const remainingResources = unnamed.filter((resource) => !result.has(resource.key));
  const remainingFilenames = availableFilenames.filter((filename) =>
    !matchedFilenames.has(filename.toLocaleLowerCase())
  );
  if (remainingResources.length === remainingFilenames.length) {
    remainingResources.forEach((resource, index) => {
      result.set(resource.key, remainingFilenames[index]);
    });
  }
  return result;
}

/** Recover persisted image-generation results even when their turns are not rendered. */
export function recoverApiGeneratedImages(
  activeMessageIds: ReadonlySet<string>,
  branchNodes: readonly ApiMessage[] | null,
  allMessagesById: ReadonlyMap<string, ApiMessage>,
  recoveredKeys: Set<string>,
  getImageParts: (message: ApiMessage) => readonly RecoverableImagePart[],
): ApiMessage[] {
  const candidates = branchNodes ?? [...allMessagesById.values()];
  const recovered: ApiMessage[] = [];

  for (const message of candidates) {
    if (
      !message.id ||
      (message.author?.role !== "tool" && message.author?.role !== "assistant")
    ) continue;
    if (
      !branchNodes &&
      !isMessageLinkedToActiveMessage(message.id, allMessagesById, activeMessageIds)
    ) continue;

    const imageParts = getImageParts(message)
      .filter(({ key }) => !recoveredKeys.has(key));
    if (imageParts.length === 0) continue;

    imageParts.forEach(({ key }) => recoveredKeys.add(key));
    recovered.push({
      id: `rendered-generated-image:${message.id}`,
      parent: message.id,
      author: { role: "assistant" },
      create_time: message.create_time ?? Date.now() / 1000,
      end_turn: true,
      content: {
        content_type: "multimodal",
        parts: imageParts.map(({ part }) => part),
      },
    });
  }

  return recovered;
}

/** Find visible assistant replies after an image tool, stopping at the next user turn. */
export function getFollowingAssistantsInTurn(
  sourceId: string,
  branchNodes: readonly ApiMessage[] | null,
  exportedMessages: readonly ExportMessage[],
  allMessagesById?: ReadonlyMap<string, ApiMessage>,
): ExportMessage[] {
  const sourceIndex = branchNodes?.findIndex((node) => node.id === sourceId) ?? -1;
  const exportedById = new Map(exportedMessages.map((message) => [message.id, message]));
  if (!branchNodes) {
    if (!allMessagesById) return [];
    return getFollowingAssistantsFromApiFallback(sourceId, allMessagesById)
      .flatMap((node) => {
        const message = node.id ? exportedById.get(node.id) : undefined;
        return message?.role === "assistant" ? [message] : [];
      });
  }
  if (sourceIndex < 0) return [];

  const following: ExportMessage[] = [];
  for (const node of branchNodes.slice(sourceIndex + 1)) {
    if (node.author?.role === "user") break;
    const message = node.id ? exportedById.get(node.id) : undefined;
    if (message?.role === "assistant") following.push(message);
  }
  return following;
}

/** Merge a generated card only when the assistant owns it or names its file. */
export function findGeneratedImageMergeTarget(
  sourceId: string,
  imagePathsByFilename: Readonly<Record<string, string>>,
  exportedMessages: readonly ExportMessage[],
  followingAssistants: readonly ExportMessage[],
  getSandboxFilenames: (content: string) => readonly string[],
  selectedIds: ReadonlySet<string> | null = null,
): ExportMessage | undefined {
  const source = exportedMessages.find((message) =>
    message.id === sourceId && message.role === "assistant" &&
    (!selectedIds || selectedIds.has(message.id))
  );
  if (source) return source;

  const knownFilenames = new Set(Object.keys(imagePathsByFilename));
  if (knownFilenames.size === 0) return undefined;
  return followingAssistants.find((message) =>
    (!selectedIds || selectedIds.has(message.id)) &&
    getSandboxFilenames(message.content).some((filename) =>
      knownFilenames.has(filename.toLocaleLowerCase())
    )
  );
}

/** Include image-only synthetic messages when either side of their Q&A is selected. */
export function isGeneratedImageSelected(
  message: ApiMessage,
  selectedIds: ReadonlySet<string> | null,
  branchNodes: readonly ApiMessage[] | null,
  allMessagesById: ReadonlyMap<string, ApiMessage>,
): boolean {
  if (!selectedIds || (message.id && selectedIds.has(message.id))) return true;

  const messageId = message.id ?? "";
  const sourceId = messageId.startsWith("rendered-generated-image:")
    ? messageId.slice("rendered-generated-image:".length)
    : null;
  if (sourceId && selectedIds.has(sourceId)) return true;

  let currentId = getMessageParentId(message) ?? sourceId;
  const visited = new Set<string>();
  let userId: string | null = null;
  while (currentId && !visited.has(currentId)) {
    if (selectedIds.has(currentId)) return true;
    visited.add(currentId);
    const current = allMessagesById.get(currentId) ??
      branchNodes?.find((node) => node.id === currentId);
    if (current?.author?.role === "user") {
      userId = currentId;
      break;
    }
    currentId = current ? getMessageParentId(current) : null;
  }

  if (!userId) return false;
  if (!branchNodes) {
    return [...allMessagesById.values()].some((candidate) =>
      candidate.author?.role === "assistant" &&
      candidate.id !== undefined &&
      selectedIds.has(candidate.id) &&
      getNearestUserAncestorId(candidate.id, allMessagesById) === userId
    );
  }
  const userIndex = branchNodes.findIndex((node) => node.id === userId);
  if (userIndex < 0) return false;
  for (const node of branchNodes.slice(userIndex + 1)) {
    if (node.author?.role === "user") break;
    if (node.author?.role === "assistant" && node.id && selectedIds.has(node.id)) {
      return true;
    }
  }
  return false;
}
