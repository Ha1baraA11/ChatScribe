import type { ExportMessage } from "./types.ts";
import type { ExportArtifactData } from "./types.ts";

export interface ClaudeImageReference {
  messageId: string;
  /** Stable within this conversation snapshot; never included in diagnostics. */
  resourceId: string;
  url?: string;
  inlineData?: string;
  mimeType?: string;
  source: "conversation-api" | "rendered-image-recovery";
}

export interface ParsedClaudeConversation {
  messages: ExportMessage[];
  imageReferences: ClaudeImageReference[];
  artifacts: Record<string, ExportArtifactData>;
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
  title?: string;
  language: string;
  command: string;
  content?: string;
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
  if (!normalized) return { kind: "invalid" };
  if (normalized.toLowerCase() === CLAUDE_ROOT_PARENT_UUID) return { kind: "sentinel-root" };
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
  const hasExplicitStructure = parentReferences.some((parent) =>
    parent.kind === "parent" || parent.kind === "root" || parent.kind === "sentinel-root"
  );
  const hasInvalidParent = parentReferences.some((parent) => parent.kind === "invalid");
  const legacyLinearFallback = !hasExplicitStructure && !hasInvalidParent;
  const nullRootCount = parentReferences.filter((parent) => parent.kind === "root").length;
  const hasSentinelRoot = parentReferences.some((parent) => parent.kind === "sentinel-root");

  if (!leafId) {
    if (!legacyLinearFallback) {
      throw new Error("Claude did not identify the active conversation branch.");
    }
    leafId = getMessageId(messages.at(-1) ?? {});
  } else if (legacyLinearFallback && leafId !== getMessageId(messages.at(-1) ?? {})) {
    throw new Error("Claude did not return enough structure to verify the active branch.");
  }

  if (!leafId || !byId.has(leafId)) {
    throw new Error("Claude's active branch marker does not match its returned messages.");
  }

  if (legacyLinearFallback) return { messages, leafId };

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
  const activeIds = new Set(active.map(getMessageId));
  const hasUnknownOffBranchParent = messages.some((message, index) =>
    !activeIds.has(getMessageId(message)) &&
    (parentReferences[index].kind === "missing" || parentReferences[index].kind === "invalid")
  );

  // Multiple explicit null roots without ancestry links do not identify one
  // trustworthy path. A virtual-root marker is different: the active leaf can
  // be traced to its own sentinel-rooted branch. Unknown parent fields outside
  // an otherwise valid active path still make the returned roots ambiguous.
  if (
    !hasParentLinks &&
    (nullRootCount > 1 || (nullRootCount > 0 && hasSentinelRoot) ||
      (hasExplicitStructure && hasUnknownOffBranchParent))
  ) {
    throw new Error("Claude returned ambiguous conversation roots.");
  }

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
  if (!block) return null;
  const name = stringValue(block.name).toLowerCase();
  const blockType = stringValue(block.type).toLowerCase();
  const artifactNames = new Set([
    "artifacts",
    "artifact",
    "create_artifact",
    "update_artifact",
    "rewrite_artifact",
  ]);
  if (blockType !== "tool_use" && blockType !== "artifact" && !artifactNames.has(name)) {
    return null;
  }
  if (blockType === "tool_use" && !artifactNames.has(name)) return null;

  const input = asRecord(block.input) ?? block;
  const artifactId = stringValue(input.id || input.artifact_id || input.uuid);
  const commandName = name.replace(/_artifact$/, "");
  const command = stringValue(input.command || input.action || commandName).toLowerCase();
  if (!artifactId || !["create", "update", "rewrite"].includes(command)) return null;

  const titleValue = stringValue(input.title || input.name).trim();
  const source = asRecord(input.source);

  return {
    messageId,
    artifactId,
    ...(titleValue ? { title: titleValue } : {}),
    language: stringValue(input.language || input.mime_type || input.type),
    command,
    ...(typeof input.content === "string"
      ? { content: input.content }
      : typeof input.code === "string"
        ? { content: input.code }
        : typeof input.html === "string"
          ? { content: input.html }
          : typeof input.svg === "string"
            ? { content: input.svg }
            : typeof source?.text === "string"
              ? { content: source.text }
              : {}),
    ...(typeof input.old_str === "string"
      ? { oldText: input.old_str }
      : typeof input.old_text === "string"
        ? { oldText: input.old_text }
        : {}),
    ...(typeof input.new_str === "string"
      ? { newText: input.new_str }
      : typeof input.new_text === "string"
        ? { newText: input.new_text }
        : {}),
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

  let longestFence = 0;
  let currentFence = 0;
  for (const character of state.content) {
    if (character === "`") {
      currentFence++;
      longestFence = Math.max(longestFence, currentFence);
    } else {
      currentFence = 0;
    }
  }
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  const language = /^[\p{L}\p{N}_+-]+$/u.test(state.language)
    ? state.language
    : "";
  return `**Artifact: ${title} (final version)**\n\n${fence}${language}\n${state.content}\n${fence}`;
}

function buildArtifactContent(
  activeMessages: ClaudeMessageRecord[],
): {
  referencesByMessage: Map<string, string[]>;
  artifacts: Record<string, ExportArtifactData>;
} {
  const states = new Map<string, ClaudeArtifactState>();
  const referencesByMessage = new Map<string, string[]>();

  for (const message of activeMessages) {
    const messageId = getMessageId(message);
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const event = artifactEventFromBlock(messageId, block);
      if (!event) continue;
      const references = referencesByMessage.get(messageId) ?? [];
      if (!references.includes(event.artifactId)) references.push(event.artifactId);
      referencesByMessage.set(messageId, references);

      let state = states.get(event.artifactId);
      if (!state) {
        state = {
          title: event.title ?? "Untitled Artifact",
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
        state.content = event.content ?? null;
        state.failed = state.content === null;
        continue;
      }

      if (state.content === null || event.oldText === undefined || event.newText === undefined) {
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

  const artifacts: Record<string, ExportArtifactData> = {};
  for (const state of states.values()) {
    artifacts[state.events[0].artifactId] = {
      title: safeArtifactTitle(state.title),
      language: state.language,
      content: state.content,
      failed: state.failed,
      finalBlock: formatArtifactBlock(state),
      modifiedLaterBlock: `**Artifact: ${escapeMarkdownInline(safeArtifactTitle(state.title))} (modified later; final version appears below)**`,
    };
  }
  return { referencesByMessage, artifacts };
}

function collectImageResources(
  messageId: string,
  ...values: unknown[]
): ClaudeImageReference[] {
  const seen = new WeakSet<object>();
  const byAlias = new Map<string, ClaudeImageReference>();
  const output: ClaudeImageReference[] = [];
  let anonymousOrdinal = 0;

  const register = (record: Record<string, unknown>): void => {
    const source = asRecord(record.source);
    const image = asRecord(record.image);
    const rawMimeType = stringValue(
      record.mime_type || record.media_type || record.mimeType ||
        source?.media_type || source?.mime_type || image?.mime_type,
    ).trim().toLowerCase();
    const urlValue = record.url || record.preview_url || record.download_url ||
      record.file_url || record.image_url || source?.url || image?.url;
    const rawUrl = typeof urlValue === "string"
      ? urlValue.trim()
      : stringValue(asRecord(urlValue)?.url).trim();
    const rawInline = record.data || record.base64 || source?.data || image?.data;
    let inlineData: string | undefined;
    let mimeType = rawMimeType.startsWith("image/")
      ? rawMimeType.split(";")[0]
      : undefined;
    let url: string | undefined;

    if (rawUrl.startsWith("data:")) {
      const match = rawUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i);
      if (match) {
        mimeType ??= match[1].toLowerCase();
        inlineData = match[2];
      }
    } else if (rawUrl) {
      try {
        const parsed = new URL(rawUrl, "https://claude.ai");
        if (parsed.protocol === "https:") url = parsed.href;
      } catch {
        // A page-owned blob preview is recovered from the matching message DOM.
      }
    }

    const inlineValue = typeof rawInline === "string" ? rawInline.trim() : "";
    if (!inlineData && inlineValue) {
      const dataUrl = inlineValue.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i);
      if (dataUrl) {
        mimeType ??= dataUrl[1].toLowerCase();
        inlineData = dataUrl[2];
      } else if (mimeType && /^[a-z0-9+/]*={0,2}$/i.test(inlineValue)) {
        inlineData = inlineValue;
      }
    }

    const type = stringValue(record.type).toLowerCase();
    const fileKind = stringValue(record.file_kind || record.fileKind).toLowerCase();
    const imageLike = type === "image" || fileKind === "image" ||
      mimeType !== undefined ||
      rawUrl.toLowerCase().startsWith("data:image/");
    if (!imageLike) return;

    const explicitId = stringValue(
      record.uuid || record.file_uuid || record.file_id || record.asset_id ||
        record.image_id || record.attachment_id || record.id,
    ).trim();
    const aliases = [
      ...(explicitId ? [`id:${explicitId}`] : []),
      ...(url ? [`url:${url}`] : []),
      ...(inlineData ? [`data:${fingerprint([mimeType ?? "", inlineData])}`] : []),
    ];
    const existing = aliases.map((alias) => byAlias.get(alias)).find(Boolean);
    if (existing) {
      existing.url ??= url;
      existing.inlineData ??= inlineData;
      existing.mimeType ??= mimeType;
      existing.source = existing.url || existing.inlineData
        ? "conversation-api"
        : "rendered-image-recovery";
      for (const alias of aliases) byAlias.set(alias, existing);
      return;
    }

    const reference: ClaudeImageReference = {
      messageId,
      resourceId: explicitId
        ? `id:${explicitId}`
        : aliases[0] ?? `anonymous:${++anonymousOrdinal}`,
      ...(url ? { url } : {}),
      ...(inlineData ? { inlineData } : {}),
      ...(mimeType ? { mimeType } : {}),
      source: url || inlineData ? "conversation-api" : "rendered-image-recovery",
    };
    output.push(reference);
    for (const alias of aliases) byAlias.set(alias, reference);
  };

  const visit = (current: unknown, depth: number): void => {
    if (depth > 8 || current === null || typeof current !== "object") return;
    if (seen.has(current)) return;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    const record = current as Record<string, unknown>;
    register(record);

    for (const [key, child] of Object.entries(record)) {
      if (["content", "attachments", "files", "source", "image", "images"].includes(key)) {
        visit(child, depth + 1);
      }
    }
  };
  values.forEach((value) => visit(value, 0));
  return output;
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
  const { referencesByMessage: artifactReferencesByMessage, artifacts } =
    buildArtifactContent(activeMessages);
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

    const artifactReferences = artifactReferencesByMessage.get(id) ?? [];
    const attachmentNotes = findAttachmentNotes(message);
    bodyParts.push(...attachmentNotes);

    const imageResources = collectImageResources(
      id,
      message.content,
      message.attachments,
      message.files,
    );
    imageReferences.push(...imageResources);
    const imageCount = imageResources.length;

    const isTruncated = message.truncated === true ||
      ["streaming", "in_progress", "pending"].includes(
        stringValue(message.status).toLowerCase(),
      );
    if (isTruncated) {
      bodyParts.push("[This message may be incomplete.] ");
    }

    const content = bodyParts.filter(Boolean).join("\n\n");
    if (!content.trim() && imageCount === 0 && artifactReferences.length === 0) continue;
    exportMessages.push({
      id,
      role,
      content,
      ...(artifactReferences.length > 0
        ? { artifactBaseContent: content, artifactReferences }
        : {}),
      ...(imageCount > 0 ? { imageCount } : {}),
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

  const materializedMessages = materializeClaudeArtifactSelection(
    exportMessages,
    artifacts,
  );

  const revisionSource = [
    responseId || "",
    leafId,
    activeMessages.map((message) => {
      const imageResources = collectImageResources(
        getMessageId(message),
        message.content,
        message.attachments,
        message.files,
      );
      return [
        getMessageId(message),
        getParentReference(message),
        stringValue(message.sender),
        stringValue(message.status),
        stringValue(message.stop_reason),
        message.truncated === true,
        // Keep both fields: Claude may return an empty structured body while
        // the exported text is available in the fallback field.
        message.content ?? null,
        message.text ?? null,
        message.attachments ?? null,
        message.files ?? null,
        findAttachmentNotes(message),
        imageResources.map((resource) => [
          resource.resourceId,
          resource.url ?? "",
          resource.mimeType ?? "",
          resource.inlineData ? fingerprint(resource.inlineData) : "",
        ]).sort(([left], [right]) => left.localeCompare(right)),
        getTimestamp(message.created_at) ?? null,
      ];
    }),
  ];
  const revision = fingerprint(revisionSource);

  return { messages: materializedMessages, imageReferences, artifacts, revision };
}

/** Rebuild Artifact blocks for only the messages included in one export. */
export function materializeClaudeArtifactSelection(
  messages: ExportMessage[],
  artifacts: Record<string, ExportArtifactData> = {},
): ExportMessage[] {
  const lastReferenceIndex = new Map<string, number>();
  messages.forEach((message, index) => {
    for (const artifactId of message.artifactReferences ?? []) {
      lastReferenceIndex.set(artifactId, index);
    }
  });

  return messages.map((message, index) => {
    if (!message.artifactReferences?.length || message.artifactBaseContent === undefined) {
      return message;
    }
    const blocks = message.artifactReferences.flatMap((artifactId) => {
      const artifact = artifacts[artifactId];
      if (!artifact) return [];
      return [lastReferenceIndex.get(artifactId) === index
        ? artifact.finalBlock
        : artifact.modifiedLaterBlock];
    });
    return {
      ...message,
      content: [message.artifactBaseContent, ...blocks].filter(Boolean).join("\n\n"),
    };
  });
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
