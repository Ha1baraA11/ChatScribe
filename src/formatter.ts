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

const MARKDOWN_IMAGE_WIDTH_PX = 860;
const ANSWER_GROUP_SEPARATOR = "\n\n---\n\n---\n\n";
const DATAVIEW_SAFE_CODE_STYLE =
  "font-family: var(--font-monospace, monospace); background-color: rgba(135, 131, 120, 0.15); padding: 0 0.25em; border-radius: 3px;";

function formatMarkdownImage(path: string, index: number): string {
  const safePath = path
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<img src="${safePath}" alt="Image ${index + 1}" width="${MARKDOWN_IMAGE_WIDTH_PX}">`;
}

function formatDataviewSafeCode(encodedContent: string): string {
  return `<span class="chatscribe-inline-code" style="${DATAVIEW_SAFE_CODE_STYLE}">${encodedContent}</span>`;
}

/**
 * Dataview treats code spans beginning with `=` as inline queries. Render
 * standalone equality operators as inline math and other such code spans as
 * HTML spans, neither of which Dataview's inline-query processor evaluates.
 */
function protectDataviewInlineCodeOperators(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let fence: { marker: string; length: number } | null = null;

  for (const line of lines) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      output.push(line);
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.marker &&
        fenceMatch[1].length >= fence.length &&
        line.slice(fenceMatch[0].length).trim() === ""
      ) {
        fence = null;
      }
      continue;
    }

    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      output.push(line);
      continue;
    }

    output.push(protectDataviewTableEqualityCells(protectLine(line)));
  }

  return output.join("\n");

  function protectDataviewTableEqualityCells(line: string): string {
    const pipeCount = line.replace(/\\\|/g, "").match(/\|/g)?.length ?? 0;
    if (pipeCount < 2) return line;

    return line.replace(
      /(^|\|)([ \t]*)(=+)([ \t]*)(?=\||$)/g,
      (_match, boundary: string, before: string, operator: string, after: string) =>
        `${boundary}${before}$\\mathtt{${operator}}$${after}`,
    );
  }

  function protectLine(line: string): string {
    let result = "";
    let cursor = 0;

    while (cursor < line.length) {
      const open = line.indexOf("`", cursor);
      if (open < 0) return result + line.slice(cursor);

      let openEnd = open + 1;
      while (line[openEnd] === "`") openEnd++;
      const delimiterLength = openEnd - open;
      const precedingSlashes = line.slice(0, open).match(/\\*$/)?.[0].length ?? 0;
      if (precedingSlashes % 2 === 1) {
        result += line.slice(cursor, openEnd);
        cursor = openEnd;
        continue;
      }

      let close = openEnd;
      let closeEnd = -1;
      while (close < line.length) {
        close = line.indexOf("`", close);
        if (close < 0) break;
        let runEnd = close + 1;
        while (line[runEnd] === "`") runEnd++;
        if (runEnd - close === delimiterLength) {
          closeEnd = runEnd;
          break;
        }
        close = runEnd;
      }

      if (closeEnd < 0) {
        result += line.slice(cursor, openEnd);
        cursor = openEnd;
        continue;
      }

      const span = line.slice(openEnd, close);
      if (!span.trimStart().startsWith("=")) {
        result += line.slice(cursor, closeEnd);
      } else if (/^=+$/.test(span.trim())) {
        result += line.slice(cursor, open) + `$\\mathtt{${span.trim()}}$`;
      } else {
        const safeCode = span
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/=/g, "&#61;");
        result += line.slice(cursor, open) + formatDataviewSafeCode(safeCode);
      }
      cursor = closeEnd;
    }

    return result;
  }
}

export function getExportMimeType(format: ExportFormat): string {
  return EXPORT_MIME_TYPES[format];
}

// -----------------------------------------------------------------------
// HEADING HELPERS
// -----------------------------------------------------------------------

function makeHeading(role: "user" | "assistant", style: Settings["headingStyle"]): string {
  const label = role === "user" ? "User" : "Assistant";

  switch (style) {
    case "transcript":
    case "bold":
      return `**${label}:**\n\n`;
    case "none":
      return "";
  }
}

/**
 * Keep source headings visible in the answer body. The export adds one clean
 * outline entry per Q&A group instead of promoting the source's mixed heading
 * levels into a noisy outline.
 */
function formatMessageHeadingsAsText(content: string): string {
  const lines = content.split("\n");
  const output: string[] = [];
  let fence: { marker: string; length: number } | null = null;

  for (const line of lines) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      output.push(line);
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
      output.push(line);
      continue;
    }

    const atxHeading = line.match(
      /^( {0,3}(?:(?:> ?)*))(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/,
    );
    if (atxHeading) {
      output.push(formatHeadingLine(atxHeading[1], atxHeading[3]));
      continue;
    }

    // Setext headings have an underline on the next line. Leave table rows
    // and their separators untouched, especially pipe based Markdown tables.
    if (/^ {0,3}(?:=+|-+)\s*$/.test(line)) {
      const previous = output.at(-1);
      if (
        previous?.trim() &&
        !/^ {0,3}(?:[-*_]\s*){3,}$/.test(previous) &&
        !previous.includes("|") &&
        !line.includes("|")
      ) {
        output[output.length - 1] = formatHeadingLine("", previous.trim());
        continue;
      }
    }

    output.push(line);
  }

  return output.join("\n");
}

function formatHeadingLine(prefix: string, title: string): string {
  const trimmed = title.trim();
  const alreadyBold = /^\*\*.*\*\*$/.test(trimmed) || /^__.*__$/.test(trimmed);
  return `${prefix}${alreadyBold ? trimmed : `**${trimmed}**`}`;
}

function formatQuestionGroup(messages: string[], number: number, separator: string): string {
  return `## Question ${number}\n\n${messages.join(separator)}`;
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

// -----------------------------------------------------------------------
// TIMESTAMP HEADER
// -----------------------------------------------------------------------

function makeTimestampHeader(): string {
  const now = new Date();
  return `*Exported: ${now.toLocaleString()}*\n\n`;
}

function makeDocumentTitle(title?: string): string {
  const normalized = title?.replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  const escaped = normalized
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]<>#+.!|])/g, "\\$1");
  return `# ${escaped}\n\n`;
}

// -----------------------------------------------------------------------
// MARKDOWN
// -----------------------------------------------------------------------

export function formatMarkdown(
  messages: ExportMessage[],
  settings: Settings,
  options: { includeRoleHeadings?: boolean; title?: string } = {},
): string {
  const includeRoleHeadings = options.includeRoleHeadings ?? true;
  const sep = SEPARATOR_MAP[settings.separatorStyle];
  const parts: string[] = [];
  const groups: string[] = [];
  let currentGroup: string[] = [];

  const documentTitle = makeDocumentTitle(options.title);
  if (documentTitle) parts.push(documentTitle);

  if (settings.includeTimestamp) {
    parts.push(makeTimestampHeader());
  }

  for (const msg of messages) {
    if (msg.role === "user" && currentGroup.length > 0) {
      groups.push(formatQuestionGroup(currentGroup, groups.length + 1, sep));
      currentGroup = [];
    }

    let body = msg.content;
    let heading = includeRoleHeadings
      ? makeHeading(msg.role, settings.headingStyle)
      : "";

    if (msg.role === "user") body = formatQuotedRequestLabels(body);

    body = formatMessageHeadingsAsText(body);

    // Append image links
    if (msg.imagePaths.length > 0) {
      const imageLinks = msg.imagePaths
        .filter((path) => !body.includes(`](${path})`))
        .map(formatMarkdownImage)
        .join("\n\n");
      if (imageLinks) body = body ? `${body}\n\n${imageLinks}` : imageLinks;
    }

    currentGroup.push(`${heading}${body}`);
  }

  if (currentGroup.length > 0) {
    groups.push(formatQuestionGroup(currentGroup, groups.length + 1, sep));
  }
  if (groups.length > 0) parts.push(groups.join(ANSWER_GROUP_SEPARATOR));

  const markdown = parts.join(sep).trimEnd() + "\n";
  return protectDataviewInlineCodeOperators(markdown);
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
  t = t.replace(
    /<span class="chatscribe-inline-code"[^>]*>([\s\S]*?)<\/span>/g,
    (_match, code: string) => code
      .replace(/&#61;/g, "=")
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&"),
  );
  t = t.replace(/\$\\mathtt\{(=+)\}\$/g, "$1");

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
