import { describe, it, expect } from "vitest";
import { buildZipBlob } from "../src/zip.ts";
import type { ExportImageFile } from "../src/types.ts";

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
});
