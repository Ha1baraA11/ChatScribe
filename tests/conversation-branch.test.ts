import { describe, expect, it } from "vitest";
import {
  findBranchInsertionIndex,
  walkActiveBranchNodes,
} from "../src/conversation-branch.ts";
import type { ApiMessage } from "../src/types.ts";

describe("active conversation branch", () => {
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
