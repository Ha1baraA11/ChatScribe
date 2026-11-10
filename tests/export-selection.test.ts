import { describe, expect, it } from "vitest";
import {
  assertSelectedMessagesUnchanged,
  captureSelectedMessageSnapshots,
  prepareMessagesForExport,
  selectHydratedExport,
} from "../src/export-selection.ts";
import { formatMarkdown } from "../src/formatter.ts";
import { DEFAULT_SETTINGS } from "../src/types.ts";
import { buildZipBlob } from "../src/zip.ts";
import type { ConversationData, ExportMessage } from "../src/types.ts";

function message(
  id: string,
  role: ExportMessage["role"],
  content: string,
  index: number,
  imagePaths: string[] = [],
): ExportMessage {
  return { id, role, content, index, imagePaths };
}

describe("selected export with generated images", () => {
  it("keeps image metadata out of exports when image bundling is disabled", () => {
    const messages = [
      { ...message("user-text", "user", "Question with a picture", 0), imageCount: 1 },
      { ...message("user-image", "user", "", 1), imageCount: 1 },
      { ...message("assistant-text", "assistant", "Answer", 2), imageCount: 2 },
    ];

    const prepared = prepareMessagesForExport(messages, DEFAULT_SETTINGS);

    expect(prepared.map((item) => item.id)).toEqual(["user-text", "assistant-text"]);
    expect(prepared.every((item) => item.imageCount === undefined)).toBe(true);
    expect(prepared[0].content).toBe("Question with a picture");
    expect(formatMarkdown(prepared, DEFAULT_SETTINGS)).not.toContain("Image not bundled");
  });

  it("retains exportable image-only messages when image bundling is enabled", () => {
    const prepared = prepareMessagesForExport([
      { ...message("user-image", "user", "", 0), imageCount: 1 },
      { ...message("assistant-image", "assistant", "", 1), imageCount: 1 },
    ], { ...DEFAULT_SETTINGS, downloadImages: true, includeGeneratedImages: false });

    expect(prepared.map((item) => item.id)).toEqual(["user-image"]);
    expect(prepared[0].imageCount).toBe(1);
  });

  it("keeps a newly recovered image-only answer and bundles only its file", async () => {
    const conversation: ConversationData = {
      messages: [
        message("user-21", "user", "你给我画一个图片吧", 0),
        message("rendered-generated-image:card-21", "assistant", "", 1, ["images/image-001.png"]),
        message("user-22", "user", "another question", 2),
        message("rendered-generated-image:card-22", "assistant", "", 3),
      ],
      images: [
        { path: "images/image-001.png", mimeType: "image/png", base64: "AA==", sizeBytes: 1 },
        { path: "images/image-002.png", mimeType: "image/png", base64: "AA==", sizeBytes: 1 },
      ],
      revision: "revision-21",
      messageQuestionNumbersById: {
        "user-21": 21,
        "rendered-generated-image:card-21": 21,
        "user-22": 22,
        "rendered-generated-image:card-22": 22,
      },
    };

    const selected = selectHydratedExport(conversation, new Set(["user-21"]));
    expect(selected.messages.map((item) => item.id)).toEqual([
      "user-21",
      "rendered-generated-image:card-21",
    ]);
    expect(selected.images.map((image) => image.path)).toEqual(["images/image-001.png"]);
    expect(selected.revision).toBe("revision-21");

    const markdown = formatMarkdown(selected.messages, DEFAULT_SETTINGS);
    expect(markdown).toContain("images/image-001.png");
    expect(markdown).not.toContain("another question");

    const archive = new DataView(await buildZipBlob(
      markdown,
      "chat.md",
      selected.images,
    ).arrayBuffer());
    const entryNames: string[] = [];
    let offset = 0;
    while (archive.getUint32(offset, true) === 0x04034b50) {
      const size = archive.getUint32(offset + 18, true);
      const nameLength = archive.getUint16(offset + 26, true);
      const extraLength = archive.getUint16(offset + 28, true);
      const nameStart = offset + 30;
      entryNames.push(new TextDecoder().decode(
        new Uint8Array(archive.buffer, nameStart, nameLength),
      ));
      offset = nameStart + nameLength + extraLength + size;
    }
    expect(entryNames).toEqual(["chat.md", "images/image-001.png"]);
  });

  it("does not include a recovered image from an unrelated question", () => {
    const conversation: ConversationData = {
      messages: [
        message("user-1", "user", "first question", 0),
        message("user-2", "user", "second question", 1),
        message("rendered-generated-image:card-2", "assistant", "", 2, ["images/image-002.png"]),
      ],
      images: [
        { path: "images/image-002.png", mimeType: "image/png", base64: "AA==", sizeBytes: 1 },
      ],
      messageQuestionNumbersById: {
        "user-1": 1,
        "user-2": 2,
        "rendered-generated-image:card-2": 2,
      },
    };

    const selected = selectHydratedExport(conversation, new Set(["user-1"]));
    expect(selected.messages.map((item) => item.id)).toEqual(["user-1"]);
    expect(selected.images).toEqual([]);
  });

  it("respects an image message that was already unchecked in the selector", () => {
    const conversation: ConversationData = {
      messages: [
        message("user-1", "user", "draw a picture", 0),
        message("rendered-generated-image:card-1", "assistant", "", 1, ["images/image-001.png"]),
      ],
      images: [
        { path: "images/image-001.png", mimeType: "image/png", base64: "AA==", sizeBytes: 1 },
      ],
      messageQuestionNumbersById: {
        "user-1": 1,
        "rendered-generated-image:card-1": 1,
      },
    };

    const selected = selectHydratedExport(
      conversation,
      new Set(["user-1"]),
      new Set(["user-1", "rendered-generated-image:card-1"]),
    );
    expect(selected.messages.map((item) => item.id)).toEqual(["user-1"]);
    expect(selected.images).toEqual([]);
  });

  it("rejects a hydration result if the active revision or selected text changed", () => {
    const selected = message("user-1", "user", "original text", 0);
    const snapshots = captureSelectedMessageSnapshots([selected]);
    const unchanged: ConversationData = {
      messages: [{ ...selected, imagePaths: ["images/image-001.png"] }],
      images: [],
      revision: "revision-1",
    };
    expect(() => assertSelectedMessagesUnchanged(snapshots, unchanged, "revision-1"))
      .not.toThrow();

    expect(() => assertSelectedMessagesUnchanged(snapshots, {
      ...unchanged,
      revision: "revision-2",
    }, "revision-1")).toThrow(/branch changed/i);
    expect(() => assertSelectedMessagesUnchanged(snapshots, {
      ...unchanged,
      revision: undefined,
    }, "revision-1")).toThrow(/branch changed/i);
    expect(() => assertSelectedMessagesUnchanged(snapshots, {
      ...unchanged,
      messages: [{
        ...selected,
        content: "original text\n\n[1 image could not be downloaded: 403]",
      }],
    }, "revision-1")).not.toThrow();
    expect(() => assertSelectedMessagesUnchanged(snapshots, {
      ...unchanged,
      messages: [{ ...selected, content: "changed text" }],
    }, "revision-1")).toThrow(/selected message changed/i);
    expect(() => assertSelectedMessagesUnchanged(snapshots, {
      ...unchanged,
      messages: [],
    }, "revision-1")).toThrow(/selected message changed/i);
  });
});
