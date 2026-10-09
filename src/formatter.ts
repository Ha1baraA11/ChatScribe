/**
 * formatter.ts — ChatScribe
 *
 * Converts a list of ExportMessage objects into the requested
 * export format: Markdown, plain text, JSON, or CSV.
 */

import type { ExportMessage, Settings } from "./types.ts";
import { SEPARATOR_MAP } from "./types.ts";

export type ExportFormat = "md" | "txt" | "json" | "csv";

const EXPORT_MIME_TYPES: Record<ExportFormat, string> = {
  md: "text/markdown;charset=utf-8",
  txt: "text/plain;charset=utf-8",
  json: "application/json;charset=utf-8",
  csv: "text/csv;charset=utf-8",
};

export function getExportMimeType(format: ExportFormat): string {
  return EXPORT_MIME_TYPES[format];
}

// -----------------------------------------------------------------------
// HEADING HELPERS
// -----------------------------------------------------------------------

function makeHeading(role: "user" | "assistant", style: Settings["headingStyle"]): string {
  const label = role === "user" ? "User" : "Assistant";

  switch (style) {
    case "h2":
      return `## ${label}\n\n`;
    case "bold":
      return `**${label}:**\n\n`;
    case "none":
      return "";
  }
}

// -----------------------------------------------------------------------
// TIMESTAMP HEADER
// -----------------------------------------------------------------------

function makeTimestampHeader(): string {
  const now = new Date();
  return `*Exported: ${now.toLocaleString()}*\n\n`;
}

// -----------------------------------------------------------------------
// MARKDOWN
// -----------------------------------------------------------------------

export function formatMarkdown(
  messages: ExportMessage[],
  settings: Settings,
): string {
  const sep = SEPARATOR_MAP[settings.separatorStyle];
  const parts: string[] = [];

  if (settings.includeTimestamp) {
    parts.push(makeTimestampHeader());
  }

  for (const msg of messages) {
    const heading = makeHeading(msg.role, settings.headingStyle);
    let body = msg.content;

    // Append image links
    if (msg.imagePaths.length > 0) {
      const imageLinks = msg.imagePaths
        .map((p, i) => `![Image ${i + 1}](${p})`)
        .join("\n");
      body = body ? `${body}\n\n${imageLinks}` : imageLinks;
    }

    parts.push(`${heading}${body}`);
  }

  return parts.join(sep).trimEnd() + "\n";
}

// -----------------------------------------------------------------------
// PLAIN TEXT
// -----------------------------------------------------------------------

/**
 * Strip Markdown syntax from generated Markdown text.
 * Since the input is our own Markdown (not arbitrary user input),
 * this only handles the subset we produce.
 */
export function stripMarkdown(md: string): string {
  let t = md;

  // Fenced code blocks — remove fences, keep content
  t = t.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code: string) =>
    code.replace(/\n$/, ""),
  );

  // Inline code
  t = t.replace(/`([^`]+)`/g, "$1");

  // Bold then italic (order matters)
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/\*([^*]+)\*/g, "$1");

  // Images: ![alt](url) → alt (url)
  t = t.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_m, alt: string, url: string) => `${alt} (${url})`,
  );

  // Links: [text](url) → text (url)
  t = t.replace(/\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)");

  // ATX headings: drop # markers
  t = t.replace(/^#{1,6}\s+/gm, "");

  // Blockquotes
  t = t.replace(/^>\s?/gm, "");

  // Unordered lists → bullet
  t = t.replace(/^(\s*)-\s+/gm, "$1• ");

  // Ordered lists → plain text
  t = t.replace(/^(\s*)\d+\.\s+/gm, "$1");

  // Horizontal rules
  t = t.replace(/^---+$/gm, "----------");

  // Collapse 3+ blank lines
  t = t.replace(/\n{3,}/g, "\n\n");

  return t.trim();
}

export function formatPlainText(
  messages: ExportMessage[],
  settings: Settings,
): string {
  const md = formatMarkdown(messages, settings);
  return stripMarkdown(md);
}

// -----------------------------------------------------------------------
// JSON
// -----------------------------------------------------------------------

export function formatJson(messages: ExportMessage[]): string {
  const data = messages.map((m) => ({
    role: m.role,
    content: m.content,
    timestamp: m.timestamp ?? null,
    imagePaths: m.imagePaths,
  }));
  return JSON.stringify(data, null, 2);
}

// -----------------------------------------------------------------------
// CSV
// -----------------------------------------------------------------------

function csvCell(value: string): string {
  // Wrap in quotes if the value contains commas, quotes, or newlines
  if (
    value.includes(",") ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function formatCsv(messages: ExportMessage[]): string {
  const header = ["role", "content", "timestamp", "images"].map(csvCell).join(",");
  const rows = messages.map((m) =>
    [
      m.role,
      m.content.replaceAll("\r\n", "\n"),
      m.timestamp !== undefined ? String(m.timestamp) : "",
      m.imagePaths.join("; "),
    ]
      .map(csvCell)
      .join(","),
  );
  return [header, ...rows].join("\r\n") + "\r\n";
}

// -----------------------------------------------------------------------
// FILENAME BUILDER
// -----------------------------------------------------------------------

export function buildFilename(
  title: string,
  ext: string,
): string {
  // Sanitize title: replace disallowed characters, collapse spaces
  const sanitized = title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

  const timestamp = new Date()
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\..+$/, "");

  const base = sanitized || "chatgpt-export";
  return `${base}_${timestamp}.${ext}`;
}
