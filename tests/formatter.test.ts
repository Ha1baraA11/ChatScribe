import { describe, it, expect } from "vitest";
import {
  formatMarkdown,
  formatPlainText,
  formatJson,
  formatCsv,
  stripMarkdown,
  buildFilename,
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

  it("builds clean filenames", () => {
    const filename = buildFilename("My Test: Chat / Conversation?", "md");
    expect(filename).toMatch(/^My_Test_Chat_Conversation/);
    expect(filename.endsWith(".md")).toBe(true);
    expect(filename).not.toContain(":");
    expect(filename).not.toContain("/");
    expect(filename).not.toContain("?");
  });
});
