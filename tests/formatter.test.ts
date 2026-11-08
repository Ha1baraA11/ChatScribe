import { describe, it, expect } from "vitest";
import {
  formatMarkdown,
  formatPlainText,
  formatJson,
  formatCsv,
  stripMarkdown,
  buildFilename,
  buildDownloadPath,
  getExportMimeType,
} from "../src/formatter.ts";
import type { ExportMessage, Settings } from "../src/types.ts";
import { DEFAULT_SETTINGS } from "../src/types.ts";

const sampleMessages: ExportMessage[] = [
  {
    id: "msg-1",
    role: "user",
    content: "Hello, write a simple Python function.",
    index: 0,
    imagePaths: [],
    timestamp: 1700000000,
  },
  {
    id: "msg-2",
    role: "assistant",
    content: "Here is your function:\n\n```python\ndef add(a, b):\n    return a + b\n```",
    index: 1,
    imagePaths: [],
    timestamp: 1700000010,
  },
];

describe("formatter", () => {
  it("formats markdown as a clean transcript", () => {
    const output = formatMarkdown(sampleMessages, DEFAULT_SETTINGS);
    expect(output).toContain("**User:**\n\nHello, write a simple Python function.");
    expect(output).toContain("**Assistant:**\n\nHere is your function:");
    expect(output).not.toContain("## User");
  });

  it("formats markdown with bold labels", () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, headingStyle: "bold" };
    const output = formatMarkdown(sampleMessages, settings);
    expect(output).toContain("**User:**\n\nHello");
    expect(output).toContain("**Assistant:**\n\nHere");
  });

  it("constrains exported attachments to ChatGPT-like reading width", () => {
    const messages: ExportMessage[] = [
      {
        ...sampleMessages[0],
        imagePaths: ["images/image-001.png"],
      },
    ];

    const output = formatMarkdown(messages, DEFAULT_SETTINGS);

    expect(output).toContain(
      '<img src="images/image-001.png" alt="Image 1" width="860">',
    );
  });

  it("formats plain text correctly", () => {
    const output = formatPlainText(sampleMessages, DEFAULT_SETTINGS);
    expect(output).toContain(
      "Question 1\n\nUser:\n\nHello, write a simple Python function.",
    );
    expect(output).toContain("def add(a, b):");
    expect(output).not.toContain("```python");
  });

  it("formats json with correct fields", () => {
    const output = formatJson(sampleMessages);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].role).toBe("user");
    expect(parsed[1].role).toBe("assistant");
    expect(parsed[0].timestamp).toBe(1700000000);
  });

  it("formats csv escaping commas and quotes", () => {
    const output = formatCsv(sampleMessages);
    expect(output).toContain("role,content,timestamp,images");
    expect(output).toContain("user");
    expect(output).toContain("assistant");
  });

  it("uses a download MIME type that matches each selected format", () => {
    expect(getExportMimeType("md")).toBe("text/markdown;charset=utf-8");
    expect(getExportMimeType("txt")).toBe("text/plain;charset=utf-8");
    expect(getExportMimeType("json")).toBe("application/json;charset=utf-8");
    expect(getExportMimeType("csv")).toBe("text/csv;charset=utf-8");
  });

  it("strips markdown tags properly", () => {
    const md = "### Header\n\n**bold** and *italic* and `code` and [link](https://example.com)";
    const plain = stripMarkdown(md);
    expect(plain).toBe("Header\n\nbold and italic and code and link (https://example.com)");
  });

  it("preserves shorter backtick runs and Markdown syntax inside longer code fences", () => {
    const shorterFence = String.fromCharCode(96).repeat(3);
    const nestedCode = "const nested = " + shorterFence + "literal" + shorterFence + ";";
    const md = [
      "````typescript",
      nestedCode,
      "# keep this heading literal",
      "- keep this list marker literal",
      "````",
    ].join("\n");

    expect(stripMarkdown(md)).toBe([
      nestedCode,
      "# keep this heading literal",
      "- keep this list marker literal",
    ].join("\n"));
  });

  it("strips tilde fences while keeping fenced content intact", () => {
    expect(stripMarkdown("~~~text\n**literal**\n~~~")).toBe("**literal**");
  });

  it("keeps formula pipes intact unless the line is part of a real Markdown table", () => {
    const formula = String.raw`$|x|=|y|$`;
    const output = formatMarkdown([
      { ...sampleMessages[1], content: formula },
      { ...sampleMessages[1], id: "msg-3", content: "| x | = | y |\n|---|---|---|" },
    ], DEFAULT_SETTINGS);

    expect(output).toContain(formula);
    expect(output).toContain("| x | $\\mathtt{=}$ | y |");

    const plain = formatPlainText([
      { ...sampleMessages[1], content: formula },
      { ...sampleMessages[1], id: "msg-3", content: "| x | = | y |\n|---|---|---|" },
    ], DEFAULT_SETTINGS);
    expect(plain).toContain(formula);
    expect(plain).toContain("| x | = | y |");
  });

  it("preserves multiplication inside formulas and inline code in plain text", () => {
    const code = String.fromCharCode(96);
    const message = {
      ...sampleMessages[1],
      content: `$a*b*c$ and ${code}a*b*c${code} and \\$5 and ${code}\\$5${code}`,
    };
    const output = formatPlainText([message], DEFAULT_SETTINGS);

    expect(output).toContain("$a*b*c$");
    expect(output).toContain("a*b*c");
    expect(output).toContain("$5");
    expect(output).toContain(String.raw`\$5`);
  });

  it("preserves the original fraction expression across all four export formats", () => {
    const formula = String.raw`$P(A\mid A\cup B\cup C)=\dfrac{0.3333333333333333}{0.8888888888888888}=\dfrac{3}{8}$`;
    const message = { ...sampleMessages[1], content: formula };

    expect(formatMarkdown([message], DEFAULT_SETTINGS)).toContain(formula);
    expect(formatPlainText([message], DEFAULT_SETTINGS)).toContain(formula);
    expect(JSON.parse(formatJson([message]))[0].content).toBe(formula);
    expect(formatCsv([message])).toContain(formula);
  });

  it("copies a lone latest answer without a synthetic question heading", () => {
    const output = formatMarkdown(
      [sampleMessages[1]],
      DEFAULT_SETTINGS,
      { includeRoleHeadings: false },
    );
    expect(output).toContain("Here is your function:");
    expect(output).not.toContain("## Question");
    expect(output).not.toContain("**Assistant:**");
  });

  it("reports image-only messages when their image was not bundled", () => {
    const imageMessage: ExportMessage = {
      ...sampleMessages[0],
      content: "",
      imageCount: 1,
      imagePaths: [],
    };

    expect(formatMarkdown([imageMessage], DEFAULT_SETTINGS)).toContain(
      "[Image not bundled: 1 image]",
    );
    expect(formatPlainText([imageMessage], DEFAULT_SETTINGS)).toContain(
      "[Image not bundled: 1 image]",
    );
    expect(JSON.parse(formatJson([imageMessage]))[0].content).toContain(
      "Image attachment: 1 image",
    );
    expect(formatCsv([imageMessage])).toContain("Image attachment: 1 image");
  });

  it("builds clean filenames", () => {
    const filename = buildFilename("My Test: Chat / Conversation?", "md");
    expect(filename).toMatch(/^My_Test_Chat_Conversation/);
    expect(filename.endsWith(".md")).toBe(true);
    expect(filename).not.toContain(":");
    expect(filename).not.toContain("/");
    expect(filename).not.toContain("?");
  });

  it("applies a filename preset and keeps its date after a long title", () => {
    const exportTime = new Date("2026-10-17T01:34:50.000Z");
    const filename = buildFilename(
      "A".repeat(100),
      "md",
      "{title}_{datetime}",
      exportTime,
    );

    expect(filename).toBe(`${"A".repeat(80)}_2026-10-17T01-34-50.md`);
  });

  it("normalizes a configured download subfolder", () => {
    expect(buildDownloadPath("conversation.md", "ChatScribe\\Study")).toBe(
      "ChatScribe/Study/conversation.md",
    );
    expect(() => buildDownloadPath("conversation.md", "../outside")).toThrow();
    expect(() => buildDownloadPath("conversation.md", "/outside")).toThrow();
  });
});
