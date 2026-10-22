import { describe, expect, it } from "vitest";
import { selectHydratedExport } from "../src/export-selection.ts";
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
    };

    const selected = selectHydratedExport(conversation, new Set(["user-21"]));
    expect(selected.messages.map((item) => item.id)).toEqual([
      "user-21",
      "rendered-generated-image:card-21",
    ]);
    expect(selected.images.map((image) => image.path)).toEqual(["images/image-001.png"]);

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
});
