import { describe, expect, it } from "vitest";
import { formatClipboardMessages } from "../src/clipboard-formatter.ts";
import type { ExportArtifactData, ExportMessage } from "../src/types.ts";

function message(
  id: string,
  role: ExportMessage["role"],
  content: string,
  extra: Partial<ExportMessage> = {},
): ExportMessage {
  return { id, role, content, index: 0, imagePaths: [], ...extra };
}

function artifact(content: string | null, extra: Partial<ExportArtifactData> = {}): ExportArtifactData {
  return {
    title: "Original Artifact title",
    language: "html",
    content,
    failed: content === null,
    finalBlock: "unused by clipboard formatter",
    modifiedLaterBlock: "unused by clipboard formatter",
    ...extra,
  };
}

describe("clipboard formatter", () => {
  it("copies one message body without generated document or role headings", () => {
    const body = "# 2006数学复盘 - Claude\n\n$\\frac{1}{3}$\n\n```ts\nconst x = 1;\n```";
    const result = formatClipboardMessages([
      message("a1", "assistant", body),
    ]);

    expect(result.text).toBe(body);
    expect(result.text).not.toContain("**Assistant:**");
    expect(result.text).not.toContain("Question 1");
  });

  it("keeps every selected message in order and adds only fixed role labels", () => {
    const result = formatClipboardMessages([
      message("u1", "user", "First question"),
      message("a1", "assistant", "First answer"),
      message("u2", "user", "Second question"),
    ]);

    expect(result.text).toBe(
      "**User:**\n\nFirst question\n\n" +
        "**Assistant:**\n\nFirst answer\n\n" +
        "**User:**\n\nSecond question",
    );
  });

  it("preserves source Markdown and does not insert image placeholders", () => {
    const body = [
      "## Original heading",
      "",
      String.raw`$P(A\mid B)=\dfrac{1}{3}$ and \$5`,
      "",
      "| x | y |",
      "|---|---|",
      "| `a*b*c` | [link](https://example.test) |",
    ].join("\n");
    const result = formatClipboardMessages([
      message("a1", "assistant", body, { imageCount: 2 }),
    ]);

    expect(result.text).toBe(body);
    expect(result.text).not.toContain("Image not bundled");
    expect(result.omittedImageCount).toBe(2);
  });

  it("does not produce clipboard text for a pure-image message", () => {
    const result = formatClipboardMessages([
      message("u1", "user", "", { imageCount: 1 }),
    ]);

    expect(result.text).toBe("");
    expect(result.omittedImageCount).toBe(1);
  });

  it("copies final Artifact source once without its generated title", () => {
    const messages = [
      message("a1", "assistant", "", {
        artifactBaseContent: "",
        artifactReferences: ["artifact-1"],
      }),
      message("a2", "assistant", "", {
        artifactBaseContent: "Final explanation",
        artifactReferences: ["artifact-1"],
      }),
    ];

    const result = formatClipboardMessages(messages, {
      "artifact-1": artifact("<h1>final</h1>"),
    });

    expect(result.text).toContain("Final explanation");
    expect(result.text).toContain("```html\n<h1>final</h1>\n```");
    expect(result.text).not.toContain("Artifact: Original Artifact title");
    expect(result.text.match(/<h1>final<\/h1>/g)).toHaveLength(1);
  });

  it("supports empty Artifact source and reports unavailable source", () => {
    const empty = formatClipboardMessages([
      message("a1", "assistant", "", {
        artifactBaseContent: "",
        artifactReferences: ["empty"],
      }),
    ], { empty: artifact("") });
    const unavailable = formatClipboardMessages([
      message("a2", "assistant", "", {
        artifactBaseContent: "",
        artifactReferences: ["missing"],
      }),
    ]);

    expect(empty.text).toBe("```html\n\n```");
    expect(empty.unavailableArtifactCount).toBe(0);
    expect(unavailable.text).toBe("");
    expect(unavailable.unavailableArtifactCount).toBe(1);
  });

  it("chooses a safe fence when Artifact source contains backticks", () => {
    const content = "const nested = ```literal```;";
    const result = formatClipboardMessages([
      message("a1", "assistant", "", {
        artifactBaseContent: "",
        artifactReferences: ["artifact-1"],
      }),
    ], { "artifact-1": artifact(content) });

    expect(result.text).toBe("````html\nconst nested = ```literal```;\n````");
  });
});
