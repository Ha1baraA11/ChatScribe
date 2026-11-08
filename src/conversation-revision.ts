import type { ApiConversationPage, ApiMessage } from "./types.ts";
import { getMessageParentId } from "./conversation-branch.ts";

/**
 * Sign the first API page used to verify the active ChatGPT turn. Incomplete
 * streaming bodies are deliberately omitted so token-by-token updates do not
 * trigger a reload; completed bodies are included so edits to an answer with
 * an unchanged message ID cannot pass as the same revision.
 */
export function getConversationRevision(page: ApiConversationPage): string {
  const messages = (page.messages ?? []).map((message: ApiMessage) => [
    message.id ?? "",
    getMessageParentId(message),
    message.author?.role ?? "",
    message.end_turn === true,
    message.end_turn === true ? message.content ?? null : null,
    message.end_turn === true
      ? message.metadata?.is_visually_hidden_from_conversation === true
      : null,
    message.end_turn === true ? message.create_time ?? null : null,
  ]);

  return JSON.stringify([page.current_node ?? null, messages]);
}
