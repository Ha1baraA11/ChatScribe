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

export interface ActiveBranchWalkResult {
  messages: ApiMessage[] | null;
  stopReason:
    | "root-found-explicit"
    | "root-found-earliest-user"
    | "current-node-missing"
    | "parent-node-missing"
    | "unmarked-terminal-node"
    | "parent-cycle";
  visitedNodeCount: number;
}

function isEarliestKnownUserMessage(
  message: ApiMessage,
  byId: ReadonlyMap<string, ApiMessage>,
): boolean {
  const createTime = message.create_time;
  if (message.author?.role !== "user" || !message.id ||
      typeof createTime !== "number") {
    return false;
  }

  return ![...byId.values()].some((candidate) =>
    candidate.id !== message.id &&
    candidate.author?.role === "user" &&
    typeof candidate.create_time === "number" &&
    candidate.create_time < createTime
  );
}

/**
 * Return every API node on the selected branch, including nodes that are not
 * themselves exportable. Image-only assistant turns can be omitted from the
 * API text export but still provide the ID used by the rendered-image fallback.
 */
export function resolveActiveBranchNodes(
  byId: ReadonlyMap<string, ApiMessage>,
  currentNode: string,
): ActiveBranchWalkResult {
  const path: ApiMessage[] = [];
  const visited = new Set<string>();
  let nodeId: string | null = currentNode;

  while (nodeId) {
    if (visited.has(nodeId)) {
      return {
        messages: null,
        stopReason: "parent-cycle",
        visitedNodeCount: visited.size,
      };
    }
    visited.add(nodeId);
    const message = byId.get(nodeId);
    if (!message) {
      return {
        messages: null,
        stopReason: path.length === 0 ? "current-node-missing" : "parent-node-missing",
        visitedNodeCount: visited.size,
      };
    }

    path.push(message);

    const parentId = getMessageParentId(message);
    if (parentId === "client-created-root" ||
        (!parentId && hasExplicitRootParent(message))) {
      return {
        messages: path.reverse(),
        stopReason: "root-found-explicit",
        visitedNodeCount: visited.size,
      };
    }
    if (!parentId && isEarliestKnownUserMessage(message, byId)) {
      return {
        messages: path.reverse(),
        stopReason: "root-found-earliest-user",
        visitedNodeCount: visited.size,
      };
    }
    if (!parentId) {
      return {
        messages: null,
        stopReason: "unmarked-terminal-node",
        visitedNodeCount: visited.size,
      };
    }
    if (!byId.has(parentId)) {
      return {
        messages: null,
        stopReason: "parent-node-missing",
        visitedNodeCount: visited.size,
      };
    }

    nodeId = parentId;
  }

  return {
    messages: null,
    stopReason: "unmarked-terminal-node",
    visitedNodeCount: visited.size,
  };
}

/** Walk the active branch, returning null if the parent chain is incomplete. */
export function walkActiveBranchNodes(
  byId: ReadonlyMap<string, ApiMessage>,
  currentNode: string,
): ApiMessage[] | null {
  return resolveActiveBranchNodes(byId, currentNode).messages;
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
