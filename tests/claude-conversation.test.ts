import { describe, expect, it } from "vitest";
import {
  getClaudeConversationId,
  parseClaudeConversation,
} from "../src/claude-conversation.ts";

function conversation(
  messages: Array<Record<string, unknown>>,
  currentLeaf: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    current_leaf_message_uuid: currentLeaf,
    chat_messages: messages,
    ...extra,
  };
}

function message(
  uuid: string,
  sender: string,
  parent: string | null,
  content: unknown[],
): Record<string, unknown> {
  return {
    uuid,
    sender,
    parent_message_uuid: parent,
    content,
  };
}

const parserOptions = {
  includeThinking: false,
  expectedConversationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
};

describe("Claude conversation parser", () => {
  it("exports only the branch ending at Claude's active leaf", () => {
    const raw = conversation([
      message("u1", "human", "00000000-0000-4000-8000-000000000000", [{ type: "text", text: "Question" }]),
      message("a1", "assistant", "u1", [{ type: "text", text: "Answer" }]),
      message("a1-alt", "assistant", "u1", [{ type: "text", text: "Alternate" }]),
      message("u2", "human", "a1", [{ type: "text", text: "Follow-up" }]),
      message("a2", "assistant", "u2", [{ type: "text", text: "Final answer" }]),
    ], "a2");

    const parsed = parseClaudeConversation(raw, parserOptions);

    expect(parsed.messages.map(({ id, content }) => [id, content])).toEqual([
      ["u1", "Question"],
      ["a1", "Answer"],
      ["u2", "Follow-up"],
      ["a2", "Final answer"],
    ]);
  });

  it("stops at Claude's virtual root and keeps that marker from triggering linear fallback", () => {
    const root = "00000000-0000-4000-8000-000000000000";
    const raw = conversation([
      message("a2", "assistant", "u2", [{ type: "text", text: "Final answer" }]),
      message("u1", "human", root, [{ type: "text", text: "Edited question" }]),
      message("a1", "assistant", "u1", [{ type: "text", text: "First answer" }]),
      message("a2-alt", "assistant", "u2", [{ type: "text", text: "Inactive alternate" }]),
      message("u2", "human", "a1", [{ type: "text", text: "Follow-up" }]),
    ], "a2");

    const parsed = parseClaudeConversation(raw, parserOptions);

    expect(parsed.messages.map(({ id }) => id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("selects the active branch when multiple messages share Claude's virtual root", () => {
    const root = "00000000-0000-4000-8000-000000000000";
    const raw = conversation([
      message("u1", "human", root, [{ type: "text", text: "Earlier prompt" }]),
      message("a1", "assistant", "u1", [{ type: "text", text: "Earlier answer" }]),
      message("u2", "human", root, [{ type: "text", text: "Selected prompt" }]),
      message("a2", "assistant", "u2", [{ type: "text", text: "Selected answer" }]),
    ], "a2");

    const parsed = parseClaudeConversation(raw, parserOptions);

    expect(parsed.messages.map(({ id }) => id)).toEqual(["u2", "a2"]);
  });

  it("does not flatten sibling root messages when they are the only tree links", () => {
    const root = "00000000-0000-4000-8000-000000000000";
    const raw = conversation([
      message("u1", "human", root, [{ type: "text", text: "Earlier prompt" }]),
      message("u2", "human", root, [{ type: "text", text: "Selected prompt" }]),
    ], "u2");

    const parsed = parseClaudeConversation(raw, parserOptions);

    expect(parsed.messages.map(({ id }) => id)).toEqual(["u2"]);
  });

  it("fails instead of exporting a parent chain that Claude returned incompletely", () => {
    const raw = conversation([
      message("a1", "assistant", "missing-parent", [{ type: "text", text: "Partial" }]),
    ], "a1");

    expect(() => parseClaudeConversation(raw, parserOptions))
      .toThrow(/parent message that Claude did not return/i);
  });

  it.each(["null", "none", "undefined"])(
    "does not treat the literal %s string as a root marker",
    (parent) => {
      const raw = conversation([
        message("u1", "human", "00000000-0000-4000-8000-000000000000", [{ type: "text", text: "Question" }]),
        message("a1", "assistant", parent, [{ type: "text", text: "Answer" }]),
      ], "a1");

      expect(() => parseClaudeConversation(raw, parserOptions))
        .toThrow(/parent message that Claude did not return/i);
    },
  );

  it("fails when a linked tree message omits its parent field", () => {
    const raw = conversation([
      message("u1", "human", "00000000-0000-4000-8000-000000000000", [{ type: "text", text: "Question" }]),
      { ...message("a1", "assistant", "u1", [{ type: "text", text: "Answer" }]), parent_message_uuid: undefined },
    ], "a1");

    expect(() => parseClaudeConversation(raw, parserOptions))
      .toThrow(/missing a parent reference/i);
  });

  it("rejects cycles in a linked conversation tree", () => {
    const raw = conversation([
      message("u1", "human", "a1", [{ type: "text", text: "Question" }]),
      message("a1", "assistant", "u1", [{ type: "text", text: "Answer" }]),
    ], "a1");

    expect(() => parseClaudeConversation(raw, parserOptions))
      .toThrow(/circular conversation branch/i);
  });

  it("keeps all messages in order when the API returns a linear list without parent links", () => {
    const raw = conversation([
      { ...message("u1", "human", null, [{ type: "text", text: "First" }]), parent_message_uuid: undefined },
      { ...message("a1", "assistant", null, [{ type: "text", text: "Second" }]), parent_message_uuid: undefined },
    ], "");
    delete raw.current_leaf_message_uuid;

    expect(parseClaudeConversation(raw, parserOptions).messages.map((item) => item.content))
      .toEqual(["First", "Second"]);
  });

  it("includes thinking blocks only when the preference is enabled", () => {
    const raw = conversation([
      message("a1", "assistant", null, [
        { type: "thinking", thinking: "Private reasoning summary" },
        { type: "text", text: "Public answer" },
      ]),
    ], "a1");

    const defaultExport = parseClaudeConversation(raw, { ...parserOptions, includeThinking: false });
    const optedInExport = parseClaudeConversation(raw, { ...parserOptions, includeThinking: true });

    expect(defaultExport.messages[0].content).toBe("Public answer");
    expect(optedInExport.messages[0].content).toContain("Private reasoning summary");
    expect(optedInExport.messages[0].content).toContain("Public answer");
  });

  it("places the final Artifact version in the last answer and marks its earlier mention", () => {
    const raw = conversation([
      message("a1", "assistant", null, [
        { type: "text", text: "Here is a draft." },
        {
          type: "tool_use",
          name: "artifacts",
          input: {
            id: "artifact-1",
            title: "Example",
            language: "ts",
            command: "create",
            content: "const value = 1;",
          },
        },
      ]),
      message("a2", "assistant", "a1", [
        { type: "text", text: "I updated the Artifact." },
        {
          type: "tool_use",
          name: "artifacts",
          input: {
            id: "artifact-1",
            title: "Example",
            language: "ts",
            command: "update",
            old_str: "const value = 1;",
            new_str: "const value = 2;",
          },
        },
      ]),
    ], "a2");

    const parsed = parseClaudeConversation(raw, parserOptions);

    expect(parsed.messages[0].content).toContain("modified later; final version appears below");
    expect(parsed.messages[0].content).not.toContain("const value = 1;");
    expect(parsed.messages[1].content).toContain("const value = 2;");
    expect(parsed.messages[1].content).toContain("(final version)");
  });

  it("marks an Artifact unavailable when an update is ambiguous", () => {
    const raw = conversation([
      message("a1", "assistant", null, [{
        type: "tool_use",
        name: "artifacts",
        input: { id: "artifact-1", command: "create", content: "value" },
      }]),
      message("a2", "assistant", "a1", [{
        type: "tool_use",
        name: "artifacts",
        input: { id: "artifact-1", command: "update", old_str: "missing", new_str: "changed" },
      }]),
    ], "a2");

    const parsed = parseClaudeConversation(raw, parserOptions);

    expect(parsed.messages[1].content).toContain("final contents unavailable");
    expect(parsed.messages[1].content).not.toContain("changed");
  });

  it("uses a safe code fence longer than any fence in the Artifact", () => {
    const raw = conversation([
      message("a1", "assistant", null, [{
        type: "tool_use",
        name: "artifacts",
        input: { id: "artifact-1", command: "create", content: "before\n```\nafter" },
      }]),
    ], "a1");

    const content = parseClaudeConversation(raw, parserOptions).messages[0].content;
    expect(content).toContain("````\n");
    expect(content).toContain("\n````");
  });

  it("extracts image URLs and returns a non-sensitive revision fingerprint", () => {
    const raw = conversation([
      message("u1", "human", null, [
        { type: "text", text: "What is this?" },
        { type: "image", source: { url: "/api/image/1" } },
      ]),
    ], "u1");

    const parsed = parseClaudeConversation(raw, parserOptions);

    expect(parsed.imageReferences).toEqual([{
      messageId: "u1",
      url: "https://claude.ai/api/image/1",
    }]);
    expect(parsed.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(parsed.revision).not.toContain("What is this?");
  });

  it("preserves non-image attachment names and descriptions without bundling their files", () => {
    const raw = conversation([
      {
        ...message("u1", "human", null, [
          { type: "text", text: "Please review this file." },
          {
            type: "document",
            file_name: "proposal.pdf",
            description: "Draft project proposal",
            url: "https://claude.ai/api/files/proposal",
          },
        ]),
      },
    ], "u1");

    const parsed = parseClaudeConversation(raw, parserOptions);

    expect(parsed.messages[0].content).toContain("proposal\\.pdf");
    expect(parsed.messages[0].content).toContain("Draft project proposal");
    expect(parsed.messages[0].content).not.toContain("https://claude.ai");
    expect(parsed.imageReferences).toEqual([]);
  });

  it("accepts only Claude conversation routes on the exact HTTPS host", () => {
    expect(getClaudeConversationId(
      "https://claude.ai/chat/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    )).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(getClaudeConversationId(
      "https://claude.ai/share/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    )).toBeNull();
    expect(getClaudeConversationId(
      "https://not-claude.ai/chat/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    )).toBeNull();
  });
});
