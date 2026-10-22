import { describe, expect, it } from "vitest";
import {
  findBranchInsertionIndex,
  isMessageLinkedToActiveMessage,
  resolveActiveBranchNodes,
  walkActiveBranchNodes,
} from "../src/conversation-branch.ts";
import type { ApiMessage } from "../src/types.ts";

describe("active conversation branch", () => {
  it("links a generated-image tool node to its active user turn when current_node is incomplete", () => {
    const byId = new Map<string, ApiMessage>([
      ["user-1", { id: "user-1", author: { role: "user" } }],
      [
        "image-tool",
        {
          id: "image-tool",
          parent: "user-1",
          author: { role: "tool" },
          content: {
            content_type: "multimodal_text",
            parts: [{ content_type: "image_asset_pointer" }],
          },
        },
      ],
      ["orphaned-reasoning", { id: "orphaned-reasoning", parent: "missing-node" }],
    ]);

    expect(
      isMessageLinkedToActiveMessage(
        "image-tool",
        byId,
        new Set(["user-1"]),
      ),
    ).toBe(true);
    expect(
      isMessageLinkedToActiveMessage(
        "orphaned-reasoning",
        byId,
        new Set(["user-1"]),
      ),
    ).toBe(false);
  });

  it("keeps non-exportable image-only nodes in the active branch path", () => {
    const byId = new Map<string, ApiMessage>([
      ["root", { id: "root", parent: null }],
      ["user-1", { id: "user-1", parent: "root", author: { role: "user" } }],
      [
        "image-1",
        {
          id: "image-1",
          parent: "user-1",
          author: { role: "assistant" },
          end_turn: false,
          content: { content_type: "multimodal", parts: [] },
        },
      ],
      ["other-branch", { id: "other-branch", parent: "user-1" }],
    ]);

    const branch = walkActiveBranchNodes(byId, "image-1");

    expect(branch?.map((message) => message.id)).toEqual([
      "root",
      "user-1",
      "image-1",
    ]);
  });

  it("accepts a parentless earliest user as the root after full pagination", () => {
    const byId = new Map<string, ApiMessage>([
      ["root-user", {
        id: "root-user",
        author: { role: "user" },
        create_time: 1,
      }],
      ["image-tool", {
        id: "image-tool",
        parent: "root-user",
        author: { role: "tool" },
        content: {
          content_type: "multimodal",
          parts: [{ asset_pointer: "sediment://file_image" }],
        },
        create_time: 2,
      }],
      ["answer", {
        id: "answer",
        parent: "image-tool",
        author: { role: "assistant" },
        end_turn: true,
        create_time: 3,
      }],
      ["later-user", {
        id: "later-user",
        parent: "answer",
        author: { role: "user" },
        create_time: 4,
      }],
    ]);

    const result = resolveActiveBranchNodes(byId, "later-user");

    expect(result.stopReason).toBe("root-found-earliest-user");
    expect(result.messages?.map((message) => message.id)).toEqual([
      "root-user",
      "image-tool",
      "answer",
      "later-user",
    ]);
  });

  it("does not treat a non-earliest parentless user as the conversation root", () => {
    const byId = new Map<string, ApiMessage>([
      ["earlier-user", {
        id: "earlier-user",
        author: { role: "user" },
        create_time: 1,
      }],
      ["unlinked-user", {
        id: "unlinked-user",
        author: { role: "user" },
        create_time: 2,
      }],
    ]);

    const result = resolveActiveBranchNodes(byId, "unlinked-user");

    expect(result.stopReason).toBe("unmarked-terminal-node");
    expect(result.messages).toBeNull();
  });

  it("does not treat a truncated parent chain as a complete active branch", () => {
    const byId = new Map<string, ApiMessage>([
      ["root-user", {
        id: "root-user",
        author: { role: "user" },
        create_time: 1,
      }],
      ["truncated-answer", {
        id: "truncated-answer",
        parent: "missing-parent",
        author: { role: "assistant" },
        create_time: 2,
      }],
    ]);

    const result = resolveActiveBranchNodes(byId, "truncated-answer");

    expect(result.stopReason).toBe("parent-node-missing");
    expect(result.messages).toBeNull();
  });

  it("places an image recovered from a filtered node before the next exportable turn", () => {
    const branch: ApiMessage[] = [
      { id: "root", parent: null },
      { id: "user-1", parent: "root", author: { role: "user" } },
      { id: "image-1", parent: "user-1", author: { role: "assistant" } },
      { id: "user-2", parent: "image-1", author: { role: "user" } },
      { id: "answer-2", parent: "user-2", author: { role: "assistant" } },
    ];
    const exportable: ApiMessage[] = [
      branch[1],
      branch[3],
      branch[4],
    ];

    expect(
      findBranchInsertionIndex(exportable, branch, "image-1"),
    ).toBe(1);
  });

  it("places a recovered image immediately after its exported parent", () => {
    const branch: ApiMessage[] = [
      { id: "root", parent: null },
      { id: "user-1", parent: "root", author: { role: "user" } },
      { id: "answer-1", parent: "user-1", author: { role: "assistant" } },
    ];

    expect(
      findBranchInsertionIndex([branch[1], branch[2]], branch, "user-1"),
    ).toBe(1);
  });
});
