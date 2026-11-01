import type { ApiConversationPage, ApiMessage } from "./types.ts";
import { getMessageParentId } from "./conversation-branch.ts";

/**
 * Make a small signature for the first API page. Streaming text is deliberately
 * omitted while a turn is incomplete, so typing tokens do not trigger a full
 * conversation reload. The active node and end-turn state still change when a
 * response becomes exportable.
 */
export function getConversationRevision(page: ApiConversationPage): string {
  const messages = (page.messages ?? []).map((message: ApiMessage) => [
    message.id ?? "",
    getMessageParentId(message),
    message.author?.role ?? "",
    message.end_turn === true,
  ]);

  return JSON.stringify([page.current_node ?? null, messages]);
}
