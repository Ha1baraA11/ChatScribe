import { describe, it, expect } from "vitest";
import { buildZipBlob } from "../src/zip.ts";
import type { ExportArchiveFile, ExportImageFile } from "../src/types.ts";

describe("zip builder", () => {
  it("builds a valid zip blob with text and images", async () => {
    const text = "# Conversation\n\nHello!";
    const textFilename = "chat.md";
    // 1x1 transparent PNG base64
    const samplePngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

    const images: ExportImageFile[] = [
      {
        path: "images/image-001.png",
        mimeType: "image/png",
        base64: samplePngBase64,
        sizeBytes: 68,
      },
    ];

    const zipBlob = buildZipBlob(text, textFilename, images);
    expect(zipBlob).toBeInstanceOf(Blob);
    expect(zipBlob.type).toBe("application/zip");
    expect(zipBlob.size).toBeGreaterThan(0);

    const arrayBuffer = await zipBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Verify ZIP magic number (PK\x03\x04) = [0x50, 0x4B, 0x03, 0x04]
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);
  });

  it("includes Artifact source files beside the root Markdown without flattening their paths", async () => {
    const files: ExportArchiveFile[] = [
      { path: "images/preview.png", mimeType: "image/png", base64: "AQID", sizeBytes: 3 },
      { path: "artifacts/example.html", mimeType: "text/html", base64: "PGgxPk9LPC9oMT4=", sizeBytes: 10 },
    ];
    const bytes = new Uint8Array(await buildZipBlob("# Export", "chat.md", files).arrayBuffer());
    const names: string[] = [];
    let offset = 0;
    while (new DataView(bytes.buffer).getUint32(offset, true) === 0x04034b50) {
      const view = new DataView(bytes.buffer);
      const nameLength = view.getUint16(offset + 26, true);
      const extraLength = view.getUint16(offset + 28, true);
      const compressedSize = view.getUint32(offset + 18, true);
      const nameStart = offset + 30;
      names.push(new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength)));
      offset = nameStart + nameLength + extraLength + compressedSize;
    }

    expect(names).toEqual(["chat.md", "images/preview.png", "artifacts/example.html"]);
  });

  it("rejects duplicate and traversal paths in an archive", () => {
    expect(() => buildZipBlob("md", "chat.md", [
      { path: "../escape.svg", mimeType: "image/svg+xml", base64: "", sizeBytes: 0 },
    ])).toThrow(/unsafe file path/i);
    expect(() => buildZipBlob("md", "chat.md", [
      { path: "images/a.png", mimeType: "image/png", base64: "", sizeBytes: 0 },
      { path: "images/a.png", mimeType: "image/png", base64: "", sizeBytes: 0 },
    ])).toThrow(/duplicate file paths/i);
  });
});
