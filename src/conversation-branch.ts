import type { ApiMessage } from "./types.ts";

/** Resolve the parent pointer used by the different ChatGPT API shapes. */
export function getMessageParentId(message: ApiMessage): string | null {
  const candidates = [
    message.parent,
    message.parent_message_id,
    message.parent_id,
    message.metadata?.parent_message_id,
    message.metadata?.parent_id,
  ];

  return (
    candidates.find(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.length > 0,
    ) ?? null
  );
}

/**
 * Recover whether an API node belongs to a visible/exportable turn when
 * ChatGPT's current_node chain is incomplete in the returned page.
 *
 * This is deliberately only a parent-chain fallback. Callers should use the
 * fully resolved current branch whenever it is available.
 */
export function isMessageLinkedToActiveMessage(
  messageId: string,
  messagesById: ReadonlyMap<string, ApiMessage>,
  activeMessageIds: ReadonlySet<string>,
): boolean {
  const visited = new Set<string>();
  let currentId: string | null = messageId;

  while (currentId && !visited.has(currentId)) {
    if (activeMessageIds.has(currentId)) return true;
    visited.add(currentId);

    const message = messagesById.get(currentId);
    if (!message) return false;
    currentId = getMessageParentId(message);
  }

  return false;
}

function hasExplicitRootParent(message: ApiMessage): boolean {
  return [
    message.parent,
    message.parent_message_id,
    message.parent_id,
    message.metadata?.parent_message_id,
    message.metadata?.parent_id,
  ].some((parentId) => parentId === null);
}

/**
 * Return every API node on the selected branch, including nodes that are not
 * themselves exportable. Image-only assistant turns can be omitted from the
 * API text export but still provide the ID used by the rendered-image fallback.
 */
export function walkActiveBranchNodes(
  byId: ReadonlyMap<string, ApiMessage>,
  currentNode: string,
): ApiMessage[] | null {
  const path: ApiMessage[] = [];
  const visited = new Set<string>();
  let nodeId: string | null = currentNode;

  while (nodeId && !visited.has(nodeId)) {
    visited.add(nodeId);
    const message = byId.get(nodeId);
    if (!message) break;

    path.push(message);

    const parentId = getMessageParentId(message);
    const reachedRoot =
      parentId === "client-created-root" ||
      (!parentId && hasExplicitRootParent(message));
    if (reachedRoot) return path.reverse();
    if (!parentId) return null;

    nodeId = parentId;
  }

  return null;
}

/**
 * Insert a recovered rendered image beside its API node. If that node was
 * filtered out of the export, place the image before the next exportable node
 * on the same branch rather than appending an older image to the end.
 */
export function findBranchInsertionIndex(
  exportableMessages: readonly ApiMessage[],
  branchNodes: readonly ApiMessage[] | null,
  associatedMessageId: string,
): number {
  const directIndex = exportableMessages.findIndex(
    (message) => message.id === associatedMessageId,
  );

  if (!branchNodes) {
    return directIndex >= 0 ? directIndex + 1 : exportableMessages.length;
  }

  const associatedBranchIndex = branchNodes.findIndex(
    (message) => message.id === associatedMessageId,
  );
  if (associatedBranchIndex < 0) {
    return directIndex >= 0 ? directIndex + 1 : exportableMessages.length;
  }

  const branchIndexById = new Map(
    branchNodes.flatMap((message, index) =>
      message.id ? [[message.id, index] as const] : [],
    ),
  );
  const nextExportableIndex = exportableMessages.findIndex((message) => {
    const branchIndex = message.id ? branchIndexById.get(message.id) : undefined;
    return branchIndex !== undefined && branchIndex > associatedBranchIndex;
  });

  return nextExportableIndex >= 0
    ? nextExportableIndex
    : exportableMessages.length;
}
