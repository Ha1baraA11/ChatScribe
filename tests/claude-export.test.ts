import { describe, expect, it } from "vitest";
import { buildClaudeArtifactArchive } from "../src/claude-export.ts";
import type { ExportArtifactData, ExportMessage } from "../src/types.ts";

function artifactMessage(id: string, artifactId: string): ExportMessage {
  return {
    id,
    role: "assistant",
    content: "Here is the current version.\n\n```html\n<div>final</div>\n```",
    artifactBaseContent: "Here is the current version.",
    artifactReferences: [artifactId],
    index: 0,
    imagePaths: [],
  };
}

describe("Claude Artifact export", () => {
  it("bundles the source file and points the selected final reference to it", async () => {
    const source = "<main><h1>Final</h1><script>document.body.textContent = 'unsafe';</script></main>";
    const artifacts: Record<string, ExportArtifactData> = {
      "artifact-1": {
        title: "index.html",
        language: "html",
        content: source,
        failed: false,
        finalBlock: "",
        modifiedLaterBlock: "",
      },
    };

    const result = await buildClaudeArtifactArchive(
      [artifactMessage("answer-1", "artifact-1")],
      artifacts,
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      path: "artifacts/index.html",
      mimeType: "text/html;charset=utf-8",
    });
    expect(new TextDecoder().decode(Uint8Array.from(atob(result.files[0].base64), (c) => c.charCodeAt(0))))
      .toBe(source);
    expect(result.messages[0].content).toContain("Artifact source file: `artifacts/index.html`");
    expect(result.messages[0].content).not.toContain("javascript:");
    expect(result.unavailableCount).toBe(0);
  });

  it("sanitizes titles into safe paths and reports an unreconstructed Artifact", async () => {
    const result = await buildClaudeArtifactArchive(
      [artifactMessage("answer-1", "present"), artifactMessage("answer-2", "missing")],
      {
        present: {
          title: "../../unsafe\\name.html",
          language: "html",
          content: "",
          failed: false,
          finalBlock: "",
          modifiedLaterBlock: "",
        },
      },
    );

    expect(result.files[0].path.startsWith("artifacts/")).toBe(true);
    expect(result.files[0].path.slice("artifacts/".length)).not.toMatch(/\.\.|[\\/]/);
    expect(result.files[0].sizeBytes).toBe(0);
    expect(result.unavailableCount).toBe(1);
    expect(result.messages[0].content).toContain("Artifact source file:");
    expect(result.messages[1].content).not.toContain("Artifact source file:");
  });
});
