import type { ExportMessage } from "./types.ts";

export interface ClaudeImageReference {
  messageId: string;
  url: string;
}

export interface ParsedClaudeConversation {
  messages: ExportMessage[];
  imageReferences: ClaudeImageReference[];
  revision: string;
}

interface ClaudeMessageRecord {
  uuid?: unknown;
  sender?: unknown;
  parent_message_uuid?: unknown;
  content?: unknown;
  text?: unknown;
  created_at?: unknown;
  status?: unknown;
  stop_reason?: unknown;
  truncated?: unknown;
  [key: string]: unknown;
}

interface ClaudeArtifactEvent {
  messageId: string;
  artifactId: string;
  title: string;
  language: string;
  command: string;
  content: string;
  oldText?: string;
  newText?: string;
}

interface ClaudeArtifactState {
  title: string;
  language: string;
  content: string | null;
  failed: boolean;
  events: ClaudeArtifactEvent[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAUDE_ROOT_PARENT_UUID = "00000000-0000-4000-8000-000000000000";

type ClaudeParentReference =
  | { kind: "root" }
  | { kind: "sentinel-root" }
  | { kind: "parent"; id: string }
  | { kind: "missing" }
  | { kind: "invalid" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function getMessageId(message: ClaudeMessageRecord): string {
  const id = stringValue(message.uuid);
  return id.trim();
}

function getParentReference(message: ClaudeMessageRecord): ClaudeParentReference {
  const parent = message.parent_message_uuid;
  if (parent === null) return { kind: "root" };
  if (parent === undefined) return { kind: "missing" };
  if (typeof parent !== "string") return { kind: "invalid" };
  const normalized = parent.trim();
  if (!normalized) return { kind: "root" };
  if (normalized === CLAUDE_ROOT_PARENT_UUID) return { kind: "sentinel-root" };
  return { kind: "parent", id: normalized };
}

function getParentId(message: ClaudeMessageRecord): string | null {
  const parent = getParentReference(message);
  return parent.kind === "parent" ? parent.id : null;
}

function getActiveMessages(value: unknown): {
  messages: ClaudeMessageRecord[];
  leafId: string;
} {
  const conversation = asRecord(value);
  const rawMessages = conversation?.chat_messages;
  if (!Array.isArray(rawMessages)) {
    throw new Error("Claude returned an unsupported conversation format.");
  }

  const messages = rawMessages.map((message) => {
    const record = asRecord(message);
    if (!record) throw new Error("Claude returned an invalid message.");
    return record as ClaudeMessageRecord;
  });

  const byId = new Map<string, ClaudeMessageRecord>();
  for (const message of messages) {
    const id = getMessageId(message);
    if (!id) throw new Error("Claude returned a message without an ID.");
    if (byId.has(id)) throw new Error("Claude returned duplicate message IDs.");
    byId.set(id, message);
  }

  const explicitLeaf = stringValue(conversation?.current_leaf_message_uuid);
  let leafId = explicitLeaf;
  const parentReferences = messages.map(getParentReference);
  const hasParentLinks = parentReferences.some((parent) => parent.kind === "parent");
  const hasClaudeRootMarker = parentReferences.some((parent) => parent.kind === "sentinel-root");
  const linearFallback = !hasParentLinks && !hasClaudeRootMarker;

  if (!leafId) {
    if (!linearFallback) {
      throw new Error("Claude did not identify the active conversation branch.");
    }
    leafId = getMessageId(messages.at(-1) ?? {});
  } else if (!hasParentLinks && leafId !== getMessageId(messages.at(-1) ?? {})) {
    throw new Error("Claude did not return enough structure to verify the active branch.");
  }

  if (!leafId || !byId.has(leafId)) {
    throw new Error("Claude's active branch marker does not match its returned messages.");
  }

  if (linearFallback) return { messages, leafId };

  const reversed: ClaudeMessageRecord[] = [];
  const visited = new Set<string>();
  let currentId: string | null = leafId;
  while (currentId !== null) {
    if (visited.has(currentId)) {
      throw new Error("Claude returned a circular conversation branch.");
    }
    visited.add(currentId);
    const current = byId.get(currentId);
    if (!current) {
      throw new Error("Claude returned an incomplete active conversation branch.");
    }
    reversed.push(current);
    const parent = getParentReference(current);
    if (parent.kind === "root" || parent.kind === "sentinel-root") {
      currentId = null;
    } else if (parent.kind === "parent") {
      currentId = parent.id;
      if (!byId.has(currentId)) {
        throw new Error("Claude's active branch refers to a parent message that Claude did not return.");
      }
    } else if (parent.kind === "missing") {
      throw new Error("Claude's active branch is missing a parent reference.");
    } else {
      throw new Error("Claude's active branch contains an invalid parent reference.");
    }
  }

  const active = reversed.reverse();
  const childCounts = new Map<string, number>();
  for (const message of messages) {
    const parent = getParentId(message);
    if (parent) childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
  }

  // A leaf that is not a leaf in the returned tree is not a trustworthy branch
  // marker; this commonly indicates that the site response changed shape.
  if ((childCounts.get(leafId) ?? 0) > 0) {
    throw new Error("Claude returned an invalid active conversation branch.");
  }

  return { messages: active, leafId };
}

function extractText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const blockValue of blocks) {
    const block = asRecord(blockValue);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function extractThinking(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return [];
  const parts: string[] = [];
  for (const blockValue of blocks) {
    const block = asRecord(blockValue);
    if (!block || block.type !== "thinking") continue;
    const text = typeof block.thinking === "string"
      ? block.thinking
      : typeof block.text === "string"
        ? block.text
        : "";
    if (text.trim()) parts.push(text);
  }
  return parts;
}

function artifactEventFromBlock(
  messageId: string,
  blockValue: unknown,
): ClaudeArtifactEvent | null {
  const block = asRecord(blockValue);
  if (!block || block.type !== "tool_use") return null;
  const name = stringValue(block.name).toLowerCase();
  if (name !== "artifacts" && name !== "artifact") return null;

  const input = asRecord(block.input) ?? {};
  const artifactId = stringValue(input.id || input.artifact_id || input.uuid);
  const command = stringValue(input.command || input.action).toLowerCase();
  if (!artifactId || !["create", "update", "rewrite"].includes(command)) return null;

  return {
    messageId,
    artifactId,
    title: stringValue(input.title || input.name) || "Untitled Artifact",
    language: stringValue(input.language || input.type),
    command,
    content: stringValue(input.content),
    ...(typeof input.old_str === "string" ? { oldText: input.old_str } : {}),
    ...(typeof input.new_str === "string" ? { newText: input.new_str } : {}),
  };
}

function safeArtifactTitle(title: string): string {
  return title.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim() ||
    "Untitled Artifact";
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/([\\`*_{}\[\]<>#+.!|])/g, "\\$1");
}

function formatArtifactBlock(state: ClaudeArtifactState): string {
  const title = escapeMarkdownInline(safeArtifactTitle(state.title));
  if (state.failed || state.content === null) {
    return `**Artifact: ${title} (final contents unavailable)**`;
  }

  const longestFence = Math.max(0, ...Array.from(state.content.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  const language = /^[\p{L}\p{N}_+-]+$/u.test(state.language)
    ? state.language
    : "";
  return `**Artifact: ${title} (final version)**\n\n${fence}${language}\n${state.content}\n${fence}`;
}

function buildArtifactContent(
  activeMessages: ClaudeMessageRecord[],
): Map<string, string[]> {
  const states = new Map<string, ClaudeArtifactState>();
  const eventsByMessage = new Map<string, ClaudeArtifactEvent[]>();

  for (const message of activeMessages) {
    const messageId = getMessageId(message);
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const event = artifactEventFromBlock(messageId, block);
      if (!event) continue;
      const events = eventsByMessage.get(messageId) ?? [];
      events.push(event);
      eventsByMessage.set(messageId, events);

      let state = states.get(event.artifactId);
      if (!state) {
        state = {
          title: event.title,
          language: event.language,
          content: null,
          failed: false,
          events: [],
        };
        states.set(event.artifactId, state);
      }
      state.title = event.title || state.title;
      state.language = event.language || state.language;
      state.events.push(event);

      if (event.command === "create" || event.command === "rewrite") {
        state.content = event.content || null;
        state.failed = state.content === null;
        continue;
      }

      if (state.content === null || !event.oldText || event.newText === undefined) {
        state.failed = true;
        state.content = null;
        continue;
      }
      const first = state.content.indexOf(event.oldText);
      if (first < 0 || state.content.indexOf(event.oldText, first + 1) >= 0) {
        state.failed = true;
        state.content = null;
        continue;
      }
      state.content = state.content.slice(0, first) + event.newText +
        state.content.slice(first + event.oldText.length);
    }
  }

  const additions = new Map<string, string[]>();
  for (const state of states.values()) {
    const lastEvent = state.events.at(-1);
    if (!lastEvent) continue;
    for (const event of state.events) {
      const content = event === lastEvent
        ? formatArtifactBlock(state)
        : `**Artifact: ${escapeMarkdownInline(safeArtifactTitle(state.title))} (modified later; final version appears below)**`;
      const list = additions.get(event.messageId) ?? [];
      list.push(content);
      additions.set(event.messageId, list);
    }
  }
  return additions;
}

function findImageUrls(value: unknown, output: Set<string>): void {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number): void => {
    if (depth > 8 || current === null || typeof current !== "object") return;
    if (seen.has(current)) return;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    const record = current as Record<string, unknown>;
    const type = stringValue(record.type).toLowerCase();
    const fileKind = stringValue(record.file_kind).toLowerCase();
    if (type === "image" || fileKind === "image") {
      const source = asRecord(record.source);
      const image = asRecord(record.image);
      const url = stringValue(record.url) || stringValue(source?.url) ||
        stringValue(image?.url) || stringValue(record.image_url);
      if (url) output.add(url);
    }

    for (const [key, child] of Object.entries(record)) {
      if (["content", "attachments", "files", "source", "image", "images"].includes(key)) {
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
}

function findAttachmentNotes(message: ClaudeMessageRecord): string[] {
  const notes: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number): void => {
    if (depth > 7 || current === null || typeof current !== "object") return;
    if (seen.has(current)) return;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }

    const record = current as Record<string, unknown>;
    const type = stringValue(record.type).toLowerCase();
    const fileKind = stringValue(record.file_kind).toLowerCase();
    if (type === "image" || fileKind === "image") return;

    const filename = stringValue(
      record.filename || record.file_name || record.original_filename || record.name,
    ).trim();
    const description = stringValue(
      record.description || record.caption || record.summary,
    ).trim();
    const fileLike = /file|document|attachment/.test(type) ||
      typeof record.file_name === "string" ||
      typeof record.original_filename === "string" ||
      (typeof record.filename === "string" && Boolean(fileKind));
    if (fileLike && (filename || description)) {
      const safeName = filename
        ? escapeMarkdownInline(filename.slice(0, 240))
        : "Unnamed file";
      const safeDescription = description && description !== filename
        ? ` — ${escapeMarkdownInline(description.slice(0, 500))}`
        : "";
      const note = `**Attachment:** ${safeName}${safeDescription}`;
      if (!notes.includes(note)) notes.push(note);
    }

    for (const [key, child] of Object.entries(record)) {
      if (["content", "attachments", "files", "source", "metadata", "document"].includes(key)) {
        visit(child, depth + 1);
      }
    }
  };

  visit(message.attachments, 0);
  visit(message.files, 0);
  visit(message.content, 0);
  return notes;
}

function getTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value / 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed / 1000;
  }
  return undefined;
}

function fingerprint(value: unknown): string {
  // Keep revisions useful for comparison without sending conversation text
  // back to the popup. Walk values incrementally to avoid another huge JSON
  // string for a long conversation.
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  let position = 0;
  const add = (text: string): void => {
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      left = Math.imul(left ^ code, 0x01000193);
      right = Math.imul(right ^ (code + position), 0x85ebca6b);
      position++;
    }
  };
  const visit = (current: unknown): void => {
    if (current === null) {
      add("null;");
    } else if (typeof current === "string") {
      add(`string:${current.length}:`);
      add(current);
    } else if (typeof current === "number" || typeof current === "boolean") {
      add(`${typeof current}:${String(current)};`);
    } else if (Array.isArray(current)) {
      add("array:" + current.length + "[");
      for (const item of current) visit(item);
      add("]");
    } else if (typeof current === "object") {
      const entries = Object.entries(current as Record<string, unknown>)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
      add(`object:${entries.length}{`);
      for (const [key, item] of entries) {
        add(`key:${key.length}:`);
        add(key);
        visit(item);
      }
      add("}");
    } else {
      add(`${typeof current};`);
    }
  };
  visit(value);
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
}

export function parseClaudeConversation(
  value: unknown,
  options: { includeThinking: boolean; expectedConversationId?: string },
): ParsedClaudeConversation {
  const record = asRecord(value);
  if (!record) throw new Error("Claude returned an invalid conversation.");
  const expectedId = options.expectedConversationId;
  const responseId = stringValue(record.uuid || record.conversation_uuid);
  if (expectedId && responseId && responseId.toLowerCase() !== expectedId.toLowerCase()) {
    throw new Error("Claude returned a different conversation than the one open.");
  }

  const { messages: activeMessages, leafId } = getActiveMessages(value);
  const artifactContent = buildArtifactContent(activeMessages);
  const imageReferences: ClaudeImageReference[] = [];
  const exportMessages: ExportMessage[] = [];

  for (const message of activeMessages) {
    const id = getMessageId(message);
    const sender = stringValue(message.sender).toLowerCase();
    const role = sender === "human" || sender === "user"
      ? "user"
      : sender === "assistant"
        ? "assistant"
        : null;
    if (!role) continue;

    const bodyParts: string[] = [];
    const structuredText = extractText(message.content);
    const fallbackText = stringValue(message.text);
    if (structuredText.trim()) bodyParts.push(structuredText);
    else if (fallbackText.trim()) bodyParts.push(fallbackText);

    if (role === "assistant" && options.includeThinking) {
      const thinking = extractThinking(message.content);
      if (thinking.length) {
        bodyParts.unshift(`**Thinking summary**\n\n${thinking.join("\n\n")}`);
      }
    }

    const artifactBlocks = artifactContent.get(id) ?? [];
    const attachmentNotes = findAttachmentNotes(message);
    bodyParts.push(...attachmentNotes);
    bodyParts.push(...artifactBlocks);

    const urls = new Set<string>();
    findImageUrls(message.content, urls);
    findImageUrls(message.attachments, urls);
    findImageUrls(message.files, urls);
    for (const rawUrl of urls) {
      try {
        const imageUrl = new URL(rawUrl, "https://claude.ai");
        if (imageUrl.protocol === "https:") {
          imageReferences.push({ messageId: id, url: imageUrl.href });
        }
      } catch {
        // Invalid image references are omitted and reported by the downloader.
      }
    }

    const isTruncated = message.truncated === true ||
      ["streaming", "in_progress", "pending"].includes(
        stringValue(message.status).toLowerCase(),
      );
    if (isTruncated) {
      bodyParts.push("[This message may be incomplete.] ");
    }

    const content = bodyParts.filter(Boolean).join("\n\n");
    if (!content.trim() && urls.size === 0) continue;
    exportMessages.push({
      id,
      role,
      content,
      index: exportMessages.length,
      imagePaths: [],
      ...(getTimestamp(message.created_at) !== undefined
        ? { timestamp: getTimestamp(message.created_at) }
        : {}),
    });
  }

  if (exportMessages.length === 0) {
    throw new Error("No messages found in this Claude conversation.");
  }

  const revisionSource = [
    responseId || "",
    leafId,
    activeMessages.map((message) => [
      getMessageId(message),
      getParentId(message),
      stringValue(message.sender),
      stringValue(message.status),
      message.truncated === true,
      message.content ?? message.text ?? null,
    ]),
  ];
  const revision = fingerprint(revisionSource);

  return { messages: exportMessages, imageReferences, revision };
}

export function getClaudeConversationId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "claude.ai") return null;
    const match = parsed.pathname.match(/^\/chat\/([0-9a-f-]{36})(?:\/|$)/i);
    return match && UUID_PATTERN.test(match[1]) ? match[1] : null;
  } catch {
    return null;
  }
}
