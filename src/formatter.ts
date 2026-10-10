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

/**
 * Nest headings from a message below its question-and-answer heading.
 * Fenced code examples are left untouched, and the relative heading levels are
 * preserved while ensuring message headings start at level 3 or deeper.
 */
function nestMessageHeadings(content: string): string {
  const lines = content.split("\n");
  const headingLevels: number[] = [];
  let fence: { marker: string; length: number } | null = null;

  for (const line of lines) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.marker &&
        fenceMatch[1].length >= fence.length &&
        fenceMatch[2].trim() === ""
      ) {
        fence = null;
      }
      continue;
    }

    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }

    const headingMatch = line.match(/^( {0,3})(#{1,6})(?:[ \t]+.*)?[ \t]*$/);
    if (headingMatch) headingLevels.push(headingMatch[2].length);
  }

  if (headingLevels.length === 0) return content;

  const minimumLevel = Math.min(...headingLevels);
  const levelOffset = Math.max(0, 3 - minimumLevel);
  if (levelOffset === 0) return content;

  fence = null;
  return lines
    .map((line) => {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (
          fenceMatch &&
          fenceMatch[1][0] === fence.marker &&
          fenceMatch[1].length >= fence.length &&
          fenceMatch[2].trim() === ""
        ) {
          fence = null;
        }
        return line;
      }

      if (fenceMatch) {
        fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
        return line;
      }

      return line.replace(
        /^( {0,3})(#{1,6})(?=[ \t]|$)/,
        (_match, indentation: string, hashes: string) =>
          `${indentation}${"#".repeat(Math.min(6, hashes.length + levelOffset))}`,
      );
    })
    .join("\n");
}

/**
 * ChatGPT can wrap a quoted selection and the actual request in labeled
 * Markdown headings. Keep those labels visible without promoting them into
 * the exported document outline.
 */
function formatQuotedRequestLabels(content: string): string {
  const hasSelectedText = /^ {0,3}#{1,6}[ \t]+selected text[ \t]*:?[ \t]*$/im.test(
    content,
  ) || /^ {0,3}\*\*selected text:\*\*[ \t]*$/im.test(content);
  const hasRequest = /^ {0,3}#{1,6}[ \t]+my request[ \t]*:?[ \t]*$/im.test(
    content,
  ) || /^ {0,3}\*\*my request:\*\*[ \t]*$/im.test(content);
  if (!hasSelectedText || !hasRequest) return content;

  const normalized = content
    .replace(
      /^ {0,3}#{1,6}[ \t]+(selected text|my request|files mentioned by the user)[ \t]*:?[ \t]*$/gim,
      (_match, label: string) => `**${label}:**`,
    )
    .replace(
      /^ {0,3}#{1,6}[ \t]+(selection\s+\d+)[ \t]*$/gim,
      (_match, label: string) => `**${label}**`,
    );

  const lines = normalized.split("\n");
  const normalizeLabel = (line: string): string =>
    line.replace(/^ {0,3}#{1,6}[ \t]+/, "")
      .replace(/\*/g, "")
      .replace(/:$/, "")
      .trim()
      .toLocaleLowerCase();
  const selectedIndex = lines.findIndex((line) => normalizeLabel(line) === "selected text");
  const requestIndex = lines.findIndex(
    (line, index) => index > selectedIndex && normalizeLabel(line) === "my request",
  );
  if (selectedIndex < 0 || requestIndex < 0) return normalized;

  let fence: { marker: string; length: number } | null = null;
  const quotedContext = lines.slice(selectedIndex, requestIndex).map((line) => {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      if (!fence) {
        fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      } else if (
        fenceMatch[1][0] === fence.marker &&
        fenceMatch[1].length >= fence.length &&
        fenceMatch[2].trim() === ""
      ) {
        fence = null;
      }
      return line ? `> ${line}` : ">";
    }

    if (!fence) {
      const headingMatch = line.match(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/);
      if (headingMatch) line = `**${headingMatch[1].trim()}**`;
    }
    return line ? `> ${line}` : ">";
  });

  return [
    ...lines.slice(0, selectedIndex),
    ...quotedContext,
    ...lines.slice(requestIndex),
  ].join("\n");
}

function makeExchangeHeading(): string {
  return "## User\n\n";
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
  options: { includeRoleHeadings?: boolean } = {},
): string {
  const includeRoleHeadings = options.includeRoleHeadings ?? true;
  const sep = SEPARATOR_MAP[settings.separatorStyle];
  const parts: string[] = [];

  if (settings.includeTimestamp) {
    parts.push(makeTimestampHeader());
  }

  let exchangeOpen = false;
  let assistantHasStarted = false;

  for (const msg of messages) {
    let body = msg.content;
    let heading = includeRoleHeadings
      ? makeHeading(msg.role, settings.headingStyle)
      : "";

    if (msg.role === "user") body = formatQuotedRequestLabels(body);

    if (settings.headingStyle === "h2" && includeRoleHeadings) {
      body = nestMessageHeadings(body);

      if (msg.role === "user") {
        if (!exchangeOpen || assistantHasStarted) {
          heading = makeExchangeHeading();
          exchangeOpen = true;
          assistantHasStarted = false;
        } else {
          heading = "**User:**\n\n";
        }
      } else if (exchangeOpen) {
        heading = "**Assistant:**\n\n";
        assistantHasStarted = true;
      } else {
        heading = "## Assistant\n\n";
        exchangeOpen = true;
        assistantHasStarted = true;
      }
    }

    // Append image links
    if (msg.imagePaths.length > 0) {
      const imageLinks = msg.imagePaths
        .filter((path) => !body.includes(`](${path})`))
        .map((p, i) => `![Image ${i + 1}](${p})`)
        .join("\n");
      if (imageLinks) body = body ? `${body}\n\n${imageLinks}` : imageLinks;
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
