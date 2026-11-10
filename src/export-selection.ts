import type {
  ConversationData,
  ExportImageFile,
  ExportArtifactData,
  ExportMessage,
  ImageExportDiagnostics,
  Settings,
} from "./types.ts";
import { materializeClaudeArtifactSelection } from "./claude-conversation.ts";

export type SelectedMessageSnapshots = ReadonlyMap<string, string>;

export function snapshotMessageContent(message: ExportMessage): string {
  return `${message.role}\u0000${(message.artifactBaseContent ?? message.content)
    .replace(/\n\n\[\d+ images? could not be (?:bundled|downloaded)(?::[^\]]*)?\.?\]/gi, "")}`;
}

export function captureSelectedMessageSnapshots(
  messages: readonly ExportMessage[],
): Map<string, string> {
  return new Map(messages.map((message) => [message.id, snapshotMessageContent(message)]));
}

export function assertSelectedMessagesUnchanged(
  snapshots: SelectedMessageSnapshots,
  conversation: ConversationData,
  expectedRevision?: string,
): void {
  if (expectedRevision && conversation.revision !== expectedRevision) {
    throw new Error("The conversation branch changed while the export was being prepared. Select the messages again.");
  }

  const messagesById = new Map(conversation.messages.map((message) => [message.id, message]));
  for (const [id, snapshot] of snapshots) {
    const current = messagesById.get(id);
    if (!current || snapshotMessageContent(current) !== snapshot) {
      throw new Error("A selected message changed while the export was being prepared. Select the messages again.");
    }
  }
}

/** Remove clipboard-only image metadata when preserving legacy export settings. */
export function prepareMessagesForExport(
  messages: readonly ExportMessage[],
  settings: Settings,
): ExportMessage[] {
  return messages.flatMap((message) => {
    const includeImages = settings.downloadImages &&
      (message.role !== "assistant" || settings.includeGeneratedImages);
    const imageCount = includeImages ? message.imageCount : undefined;
    const body = message.artifactBaseContent ?? message.content;
    if (!body.trim() && !imageCount && !message.artifactReferences?.length) return [];

    if (includeImages) return [message];
    return [{
      ...message,
      imageCount: undefined,
      imageMarkdownContent: undefined,
      imagePathsByFilename: undefined,
      renderedDiagramPaths: undefined,
      imagePaths: [],
    }];
  });
}

/** Keep downloaded image-only replies that were created after the selector loaded. */
export function selectHydratedExport(
  conversation: ConversationData,
  selectedIds: ReadonlySet<string>,
  knownMessageIds: ReadonlySet<string> = selectedIds,
): {
  messages: ExportMessage[];
  images: ExportImageFile[];
  imageDiagnostics?: ImageExportDiagnostics;
  artifacts?: Record<string, ExportArtifactData>;
  messageQuestionNumbersById?: Record<string, number>;
  revision?: string;
} {
  const selectedQuestionNumbers = new Set(
    [...selectedIds].flatMap((id) => {
      const question = conversation.messageQuestionNumbersById?.[id];
      return question === undefined ? [] : [question];
    }),
  );
  const messages = conversation.messages.filter((message) => {
    if (selectedIds.has(message.id)) return true;
    if (!message.id.startsWith("rendered-generated-image:")) return false;
    // If this image was visible in the selector, its unchecked state is an
    // explicit user choice. Only newly recovered images can follow a selected
    // Q&A, and only when the source associates them with that same turn.
    if (knownMessageIds.has(message.id)) return false;
    const question = conversation.messageQuestionNumbersById?.[message.id];
    return question !== undefined && selectedQuestionNumbers.has(question);
  });
  const imagePaths = new Set(messages.flatMap((message) => message.imagePaths));
  const messageIds = new Set(messages.map((message) => message.id));
  return {
    messages: materializeClaudeArtifactSelection(messages, conversation.artifacts),
    images: conversation.images.filter((image) => imagePaths.has(image.path)),
    ...(conversation.imageDiagnostics
      ? { imageDiagnostics: conversation.imageDiagnostics }
      : {}),
    ...(conversation.artifacts ? { artifacts: conversation.artifacts } : {}),
    ...(conversation.revision ? { revision: conversation.revision } : {}),
    ...(conversation.messageQuestionNumbersById
      ? {
          messageQuestionNumbersById: Object.fromEntries(
            Object.entries(conversation.messageQuestionNumbersById).filter(([id]) =>
              messageIds.has(id)
            ),
          ),
        }
      : {}),
  };
}
