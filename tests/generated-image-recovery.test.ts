import { describe, expect, it } from "vitest";
import {
  createRenderedGeneratedImageMessage,
  deduplicateNamedImageResources,
  findActiveTurnUserId,
  findGeneratedImageMergeTarget,
  getFollowingAssistantsInTurn,
  getFollowingSandboxImageFilenames,
  getUnrecoveredImageFailureDetails,
  hasEarlierRenderedTurns,
  isGeneratedImageScanComplete,
  isRenderedConversationScrollerReady,
  getGeneratedImageScanStep,
  getRelatedMessageIdsInTurn,
  isGeneratedImageSelected,
  isMatchingFilePreviewPanel,
  isRenderedGeneratedImageCandidate,
  mapImageFilenamesToKeys,
  mergeRecoveredGeneratedImageMessages,
  nudgeOlderMessagesLoader,
  recoverApiGeneratedImages,
  selectBlobResourcesForPrefetch,
} from "../src/generated-image-recovery.ts";
import type { ApiMessage, ExportMessage } from "../src/types.ts";

function imageParts(message: ApiMessage) {
  return (message.content?.parts ?? []).flatMap((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const pointer = (part as Record<string, unknown>).asset_pointer;
    if (typeof pointer !== "string") return [];
    return [{ key: pointer, part: { asset_pointer: pointer } }];
  });
}

function recoveredImageParts(message: ApiMessage) {
  return (message.content?.parts ?? []).flatMap((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const image = part as Record<string, string | number>;
    const key = image.asset_pointer ?? image.image_url;
    return typeof key === "string" ? [{ key, part: image }] : [];
  });
}

describe("generated images from API tool messages", () => {
  it("nudges the top loader and returns to the oldest visible turn", async () => {
    const positions: number[] = [];
    let position = 0;
    const scroller = {
      clientHeight: 980,
      scrollHeight: 63_830,
      get scrollTop() { return position; },
      set scrollTop(value: number) { position = value; positions.push(value); },
    };
    const movedTo = await nudgeOlderMessagesLoader(
      scroller,
      scroller.scrollHeight,
      async (ms) => {
        expect(ms).toBe(150);
        expect(scroller.scrollTop).toBe(981);
      },
    );
    expect(movedTo).toBe(981);
    expect(positions).toEqual([981, 0]);
  });

  it("keeps the new viewport when older turns load during the nudge", async () => {
    const scroller = { clientHeight: 980, scrollHeight: 63_830, scrollTop: 0 };
    await nudgeOlderMessagesLoader(scroller, scroller.scrollHeight, async () => {
      scroller.scrollHeight += 2_000;
    });
    expect(scroller.scrollTop).toBe(981);
  });

  it("waits until ChatGPT's conversation scroller has measurable layout", () => {
    expect(isRenderedConversationScrollerReady(0, 0, 6)).toBe(false);
    expect(isRenderedConversationScrollerReady(10_000, 0, 6)).toBe(false);
    expect(isRenderedConversationScrollerReady(10_000, 900, 0)).toBe(false);
    expect(isRenderedConversationScrollerReady(10_000, 900, 6)).toBe(true);
    expect(isRenderedConversationScrollerReady(100, 900, 1)).toBe(true);
  });

  it("accepts only the file viewer opened for the expected assistant and filename", () => {
    const panel = "chatgpt-file:conversation-1:assistant-71:1:corrected.png";
    expect(isMatchingFilePreviewPanel(
      panel, "corrected.png", "assistant-71", "corrected.png",
    )).toBe(true);
    expect(isMatchingFilePreviewPanel(
      panel, "corrected.png", "assistant-70", "corrected.png",
    )).toBe(false);
    expect(isMatchingFilePreviewPanel(
      panel, "other.png", "assistant-71", "corrected.png",
    )).toBe(false);
  });

  it("does not report a missing image when a browser preview recovered the same file", () => {
    expect(getUnrecoveredImageFailureDetails(
      [
        { filename: "diagram.png", detail: "API file failed" },
        { filename: "other.png", detail: "other image failed" },
      ],
      ["DIAGRAM.PNG"],
    )).toEqual(["other image failed"]);
  });

  it("keeps blob and inline previews when an API pointer has the same filename", () => {
    const api = { filename: "diagram.png", renderedFromDom: false };
    const blob = {
      filename: "diagram.png",
      imageUrl: "blob:https://chatgpt.com/diagram",
      renderedFromDom: true,
    };
    const duplicateHostedPreview = {
      filename: "diagram.png",
      imageUrl: "https://chatgpt.com/diagram.png",
      renderedFromDom: true,
    };
    const filePreview = {
      filename: "diagram.png",
      inlineImageDataUrl: "data:image/png;base64,AA==",
      renderedFromDom: true,
    };
    expect(deduplicateNamedImageResources([
      api,
      blob,
      filePreview,
      duplicateHostedPreview,
    ])).toEqual([api, blob, filePreview]);
  });

  it("keeps images from earlier scan windows when a later API-only window has the same source", () => {
    const first = createRenderedGeneratedImageMessage(
      "image-tool",
      { id: "image-tool", create_time: 123 },
      "selected-user",
      [
        { asset_pointer: "sediment://file-first", image_filename: "first.png" },
        { image_url: "blob:https://chatgpt.com/first", rendered_from_dom: 1 },
      ],
    );
    const later = createRenderedGeneratedImageMessage(
      "image-tool",
      { id: "image-tool", create_time: 123 },
      null,
      [{ asset_pointer: "sediment://file-first" }],
    );

    const merged = mergeRecoveredGeneratedImageMessages(
      first,
      later,
      recoveredImageParts,
      "selected-user",
    );

    expect(merged.parent).toBe("selected-user");
    expect(merged.content?.parts).toEqual([
      { asset_pointer: "sediment://file-first", image_filename: "first.png" },
      { image_url: "blob:https://chatgpt.com/first", rendered_from_dom: 1 },
    ]);
    expect(first.content?.parts).toHaveLength(2);
    expect(later.content?.parts).toHaveLength(1);

    const third = createRenderedGeneratedImageMessage(
      "image-tool",
      { id: "image-tool" },
      "selected-user",
      [{ image_url: "blob:https://chatgpt.com/second", rendered_from_dom: 1 }],
    );
    expect(mergeRecoveredGeneratedImageMessages(
      merged,
      third,
      recoveredImageParts,
      "selected-user",
    ).content?.parts).toHaveLength(3);
  });

  it("does not copy a source user's uploaded attachment into a generated-image message", () => {
    const source: ApiMessage = {
      id: "user-turn",
      author: { role: "user" },
      create_time: 123,
      metadata: { attachments: [{ id: "file-user-upload.png" }] },
      content: { parts: [{ asset_pointer: "file-service://file-user-upload" }] },
    };
    const recovered = createRenderedGeneratedImageMessage(
      "user-turn",
      source,
      "user-turn",
      [{ image_url: "blob:https://chatgpt.com/generated" }],
    );

    expect(recovered.author?.role).toBe("assistant");
    expect(recovered.parent).toBe("user-turn");
    expect(recovered.metadata).toBeUndefined();
    expect(recovered.content?.parts).toEqual([
      { image_url: "blob:https://chatgpt.com/generated" },
    ]);
  });

  it("maps an assistant card ID back to the nearest selected user turn", () => {
    const branch: ApiMessage[] = [
      { id: "user-1", author: { role: "user" } },
      { id: "assistant-1", parent: "user-1", author: { role: "assistant" } },
      { id: "user-2", author: { role: "user" } },
      { id: "tool-2", parent: "user-2", author: { role: "tool" } },
      { id: "assistant-2", parent: "tool-2", author: { role: "assistant" } },
    ];
    const byId = new Map(branch.map((message) => [message.id!, message]));
    const selectedMessages = new Set([
      "user-1",
      "assistant-1",
      "user-2",
      "assistant-2",
    ]);

    expect(findActiveTurnUserId(
      ["assistant-2"],
      branch,
      byId,
      selectedMessages,
    )).toBe("user-2");
  });

  it("resolves a rendered turn key through its message anchors when no branch tree exists", () => {
    const messages: ApiMessage[] = [
      { id: "oldest-user", author: { role: "user" } },
      { id: "oldest-answer", parent: "oldest-user", author: { role: "assistant" } },
      { id: "newer-user", parent: "oldest-answer", author: { role: "user" } },
    ];
    const byId = new Map(messages.map((message) => [message.id!, message]));
    const activeIds = new Set(messages.map((message) => message.id!));
    const resolvedUserId = findActiveTurnUserId(
      ["ui-turn-key", "oldest-answer"],
      null,
      byId,
      activeIds,
    );

    expect(resolvedUserId).toBe("oldest-user");
    expect(hasEarlierRenderedTurns(resolvedUserId, "oldest-user", true)).toBe(false);
  });

  it("does not associate a generated image with the previous question", () => {
    const messages: ApiMessage[] = [
      { id: "old-answer", author: { role: "assistant" } },
      { id: "current-user", parent: "old-answer", author: { role: "user" } },
      { id: "image-tool", parent: "current-user", author: { role: "tool" } },
      { id: "image-card", parent: "image-tool", author: { role: "assistant" } },
    ];
    const byId = new Map(messages.map((message) => [message.id!, message]));
    expect([...getRelatedMessageIdsInTurn(["image-card"], byId)])
      .toEqual(["image-card", "image-tool", "current-user"]);
    expect([...getRelatedMessageIdsInTurn(["current-user"], byId)])
      .toEqual(["current-user"]);
  });

  it("prefetches an image already attached to an API message before pagination", () => {
    const mounted = { key: "url:blob:mounted", imageUrl: "blob:https://chatgpt.com/mounted" };
    const recovered = { key: "url:blob:recovered", imageUrl: "blob:https://chatgpt.com/recovered" };
    expect(selectBlobResourcesForPrefetch(
      [recovered, mounted],
      [mounted, { key: "file:stored", imageUrl: "https://example.com/stored.png" }],
      new Set([recovered.key]),
    )).toEqual([mounted]);
  });

  it("captures a roleless ChatGPT image card with a descriptive alt", () => {
    expect(isRenderedGeneratedImageCandidate(
      null,
      null,
      "4阶B树关键字结构图",
      true,
    )).toBe(true);
    expect(isRenderedGeneratedImageCandidate(
      null,
      "assistant",
      "4阶B树关键字结构图",
      false,
    )).toBe(true);
    expect(isRenderedGeneratedImageCandidate(
      null,
      "user",
      "4阶B树关键字结构图",
      true,
      true,
    )).toBe(true);
  });

  it("uses active branch turns instead of relying only on the pagination spinner", () => {
    expect(hasEarlierRenderedTurns("recent-user", "oldest-user", false)).toBe(true);
    expect(hasEarlierRenderedTurns("oldest-user", "oldest-user", false)).toBe(false);
    expect(hasEarlierRenderedTurns(null, "oldest-user", false)).toBe(true);
    expect(hasEarlierRenderedTurns(null, null, true)).toBe(true);
    expect(hasEarlierRenderedTurns(null, null, false)).toBe(false);
  });

  it("keeps scanning until the oldest turn is actually visible at the top", () => {
    expect(isGeneratedImageScanComplete("oldest-user", "oldest-user", false, 2574)).toBe(false);
    expect(isGeneratedImageScanComplete("oldest-user", "oldest-user", true, 0)).toBe(false);
    expect(isGeneratedImageScanComplete("recent-user", "oldest-user", false, 0)).toBe(false);
    expect(isGeneratedImageScanComplete("oldest-user", "oldest-user", false, 0)).toBe(true);
  });

  it("overlaps image scan viewports even when many turns are mounted", () => {
    expect(getGeneratedImageScanStep(980, 10_000)).toBe(735);
    expect(getGeneratedImageScanStep(980, 500)).toBe(250);
    expect(getGeneratedImageScanStep(0, 0)).toBe(1);
  });

  it("does not classify a user attachment as a generated image", () => {
    expect(isRenderedGeneratedImageCandidate(
      "user",
      null,
      "Generated image 1",
      true,
    )).toBe(false);
    expect(isRenderedGeneratedImageCandidate(
      null,
      "user",
      "用户上传的图",
      true,
    )).toBe(false);
  });

  it("finds generated filenames only in assistant replies from the same user turn", () => {
    const branch: ApiMessage[] = [
      { id: "user-1", author: { role: "user" } },
      { id: "image-tool", parent: "user-1", author: { role: "tool" } },
      {
        id: "answer-1",
        parent: "image-tool",
        author: { role: "assistant" },
        content: {
          parts: [
            "旧图：[预览](sandbox:/mnt/data/preview.png)",
            "修正版：[准确结构图](sandbox:/mnt/data/4%E9%98%B6%E6%A0%91.png)",
          ],
        },
      },
      { id: "user-2", parent: "answer-1", author: { role: "user" } },
      {
        id: "answer-2",
        parent: "user-2",
        author: { role: "assistant" },
        content: { parts: ["sandbox:/mnt/data/next-turn.png"] },
      },
    ];

    expect(getFollowingSandboxImageFilenames("image-tool", branch)).toEqual([
      "preview.png",
      "4阶树.png",
    ]);
    expect(getFollowingSandboxImageFilenames("missing-tool", branch)).toEqual([]);
  });

  it("maps sandbox names only when unnamed image resources match the same-turn count", () => {
    expect(mapImageFilenamesToKeys(
      [{ key: "image-1" }],
      ["4阶树.png"],
    )).toEqual(new Map([["image-1", "4阶树.png"]]));
    expect(mapImageFilenamesToKeys(
      [{ key: "known", filename: "preview.png" }, { key: "image-2" }],
      ["preview.png", "corrected.png"],
    )).toEqual(new Map([["image-2", "corrected.png"]]));
    expect(mapImageFilenamesToKeys(
      [{ key: "image-1" }, { key: "image-2" }],
      ["only-one.png"],
    )).toEqual(new Map());
  });

  it("matches a sandbox filename to its rendered image label when a turn has other images", () => {
    expect(mapImageFilenamesToKeys(
      [
        { key: "preview", filenameHint: "Generated image 1" },
        { key: "corrected", filenameHint: "4阶B树10、15、20个关键字的准确结构图" },
      ],
      ["4阶B树_10_15_20个关键字_准确结构图.png"],
    )).toEqual(new Map([
      ["corrected", "4阶B树_10_15_20个关键字_准确结构图.png"],
    ]));
  });

  it("recovers an older image-only answer from the active branch without rendered DOM", () => {
    const branch: ApiMessage[] = [
      { id: "root", parent: null },
      { id: "user-1", parent: "root", author: { role: "user" } },
      {
        id: "image-tool",
        parent: "user-1",
        author: { role: "tool" },
        create_time: 123,
        content: {
          parts: [
            { asset_pointer: "sediment://file-first" },
            { asset_pointer: "sediment://file-second" },
          ],
        },
      },
      { id: "user-2", parent: "image-tool", author: { role: "user" } },
    ];
    const byId = new Map(branch.map((message) => [message.id!, message]));
    const recoveredKeys = new Set<string>();

    const recovered = recoverApiGeneratedImages(
      new Set(["user-1", "user-2"]),
      branch,
      byId,
      recoveredKeys,
      imageParts,
    );

    expect(recovered).toEqual([{
      id: "rendered-generated-image:image-tool",
      parent: "image-tool",
      author: { role: "assistant" },
      create_time: 123,
      end_turn: true,
      content: {
        content_type: "multimodal",
        parts: [
          { asset_pointer: "sediment://file-first" },
          { asset_pointer: "sediment://file-second" },
        ],
      },
    }]);
    expect(recoveredKeys).toEqual(new Set([
      "sediment://file-first",
      "sediment://file-second",
    ]));
  });

  it("excludes unrelated branches and image pointers already exported", () => {
    const messages: ApiMessage[] = [
      { id: "active-user", author: { role: "user" } },
      {
        id: "active-tool",
        parent: "active-user",
        author: { role: "tool" },
        content: { parts: [{ asset_pointer: "sediment://file-existing" }] },
      },
      {
        id: "other-tool",
        parent: "other-user",
        author: { role: "tool" },
        content: { parts: [{ asset_pointer: "sediment://file-other" }] },
      },
    ];
    const byId = new Map(messages.map((message) => [message.id!, message]));

    const recovered = recoverApiGeneratedImages(
      new Set(["active-user"]),
      null,
      byId,
      new Set(["sediment://file-existing"]),
      imageParts,
    );

    expect(recovered).toEqual([]);
  });

  it("associates an image tool with the following answer in the same user turn", () => {
    const branch: ApiMessage[] = [
      { id: "user-1", author: { role: "user" } },
      { id: "image-tool", parent: "user-1", author: { role: "tool" } },
      { id: "answer-1", parent: "image-tool", author: { role: "assistant" } },
      { id: "user-2", parent: "answer-1", author: { role: "user" } },
      { id: "answer-2", parent: "user-2", author: { role: "assistant" } },
    ];
    const answers: ExportMessage[] = [
      { id: "answer-1", role: "assistant", content: "[diagram](sandbox:/mnt/data/diagram.png)", index: 0, imagePaths: [] },
      { id: "answer-2", role: "assistant", content: "unrelated", index: 1, imagePaths: [] },
    ];

    expect(getFollowingAssistantsInTurn("image-tool", branch, answers))
      .toEqual([answers[0]]);
  });

  it("does not attach a preview image to a different corrected file link", () => {
    const answer: ExportMessage = {
      id: "corrected-answer",
      role: "assistant",
      content: "请以这张为准：[修正版](sandbox:/mnt/data/corrected.png)",
      index: 1,
      imagePaths: [],
    };
    const filenames = (content: string) =>
      [...content.matchAll(/sandbox:\/mnt\/data\/([^\s)]+)/g)].map((match) => match[1]);

    expect(findGeneratedImageMergeTarget(
      "preview-card",
      { "preview.png": "images/image-001.png" },
      [answer],
      [answer],
      filenames,
    )).toBeUndefined();
    expect(findGeneratedImageMergeTarget(
      "preview-card",
      {},
      [answer],
      [answer],
      filenames,
    )).toBeUndefined();
    expect(findGeneratedImageMergeTarget(
      "preview-card",
      { "corrected.png": "images/image-002.png" },
      [answer],
      [answer],
      filenames,
    )).toBe(answer);
    expect(findGeneratedImageMergeTarget(
      "preview-card",
      { "corrected.png": "images/image-002.png" },
      [answer],
      [answer],
      filenames,
      new Set(["selected-user"]),
    )).toBeUndefined();
  });

  it("downloads a rendered image when its user or assistant turn is selected", () => {
    const branch: ApiMessage[] = [
      { id: "user-1", author: { role: "user" } },
      { id: "answer-1", parent: "user-1", author: { role: "assistant" } },
      { id: "user-2", parent: "answer-1", author: { role: "user" } },
    ];
    const byId = new Map(branch.map((message) => [message.id!, message]));
    const generated: ApiMessage = {
      id: "rendered-generated-image:dom-card-1",
      parent: "user-1",
      author: { role: "assistant" },
    };

    expect(isGeneratedImageSelected(
      generated,
      new Set(["answer-1"]),
      branch,
      byId,
    )).toBe(true);
    expect(isGeneratedImageSelected(
      generated,
      new Set(["user-1"]),
      branch,
      byId,
    )).toBe(true);
    expect(isGeneratedImageSelected(
      generated,
      new Set(["user-2"]),
      branch,
      byId,
    )).toBe(false);
  });
});
