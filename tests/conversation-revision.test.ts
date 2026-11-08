import { describe, expect, it } from "vitest";
import { getConversationRevision } from "../src/conversation-revision.ts";
import type { ApiConversationPage } from "../src/types.ts";

function makePage(answer: string, complete: boolean): ApiConversationPage {
  return {
    current_node: "assistant-1",
    messages: [
      {
        id: "user-1",
        parent: null,
        author: { role: "user" },
        end_turn: true,
        content: { parts: ["question"] },
      },
      {
        id: "assistant-1",
        parent: "user-1",
        author: { role: "assistant" },
        end_turn: complete,
        content: { parts: [answer] },
      },
    ],
  };
}

describe("conversation revision", () => {
  it("ignores streaming text until the assistant turn is complete", () => {
    expect(getConversationRevision(makePage("partial", false))).toBe(
      getConversationRevision(makePage("partial answer", false)),
    );
  });

  it("changes when the answer becomes exportable", () => {
    expect(getConversationRevision(makePage("partial answer", false))).not.toBe(
      getConversationRevision(makePage("complete answer", true)),
    );
  });

  it("changes when a completed answer is edited without changing its message ID", () => {
    const original = makePage("original answer", true);
    const edited = makePage("edited answer", true);

    expect(getConversationRevision(edited)).not.toBe(getConversationRevision(original));
  });

  it("changes when the active branch moves to a new message", () => {
    const original = makePage("answer", true);
    const next: ApiConversationPage = {
      ...original,
      current_node: "assistant-2",
      messages: [
        ...(original.messages ?? []),
        {
          id: "assistant-2",
          parent: "user-1",
          author: { role: "assistant" },
          end_turn: true,
          content: { parts: ["regenerated answer"] },
        },
      ],
    };

    expect(getConversationRevision(next)).not.toBe(getConversationRevision(original));
  });
});
