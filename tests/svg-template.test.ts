import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSvgTemplatesAsMarkdown } from "../src/svg-template.ts";

const diagram =
  '<box><svg viewBox="0 0 100 50"><circle cx="25" cy="25" r="10" fill="#00f"/></svg></box>';

describe("SVG diagram export", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("replaces diagrams with a readable placeholder for text exports", async () => {
    const result = await renderSvgTemplatesAsMarkdown(
      `Before ${diagram} after`,
      "text",
    );

    expect(result.markdown).toBe("Before [Diagram] after");
    expect(result.assets).toEqual([]);
  });

  it("leaves diagrams inside fenced code blocks untouched", async () => {
    const source = `\`\`\`xml\n${diagram}\n\`\`\``;
    const result = await renderSvgTemplatesAsMarkdown(source, "text");

    expect(result.markdown).toBe(source);
    expect(result.assets).toEqual([]);
  });

  it("renders safe SVG diagrams as linked PNG assets", async () => {
    const context = {
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toDataURL: vi.fn(() => "data:image/png;base64,cG5n"),
    };
    const mockImage = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    };

    vi.stubGlobal("document", {
      createElement: vi.fn(() => canvas),
    });
    vi.stubGlobal("Image", mockImage);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:svg");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const result = await renderSvgTemplatesAsMarkdown(diagram, "assets");

    expect(result.markdown).toBe("![Diagram](images/diagram-001.png)");
    expect(result.assets).toEqual([
      expect.objectContaining({
        path: "images/diagram-001.png",
        mimeType: "image/png",
        base64: "cG5n",
      }),
    ]);
    expect(context.drawImage).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:svg");
  });

  it("keeps unsafe SVG markup intact instead of exporting it", async () => {
    const unsafeDiagram =
      '<box><svg viewBox="0 0 10 10"><script>alert(1)</script></svg></box>';
    const result = await renderSvgTemplatesAsMarkdown(unsafeDiagram, "assets");

    expect(result.markdown).toBe(unsafeDiagram);
    expect(result.assets).toEqual([]);
  });

  it("does not alter content when diagram export is disabled", async () => {
    const result = await renderSvgTemplatesAsMarkdown(diagram, "none");

    expect(result.markdown).toBe(diagram);
    expect(result.assets).toEqual([]);
  });
});
