import type {
  ConversationData,
  ExportImageFile,
  ExportMessage,
  ImageExportDiagnostics,
} from "./types.ts";

/** Keep downloaded image-only replies that were created after the selector loaded. */
export function selectHydratedExport(
  conversation: ConversationData,
  selectedIds: ReadonlySet<string>,
): {
  messages: ExportMessage[];
  images: ExportImageFile[];
  imageDiagnostics?: ImageExportDiagnostics;
  messageQuestionNumbersById?: Record<string, number>;
} {
  const messages = conversation.messages.filter((message) =>
    selectedIds.has(message.id) ||
    (message.id.startsWith("rendered-generated-image:") &&
      (message.imagePaths.length > 0 ||
        /\[\d+ images? could not be downloaded:/.test(message.content)))
  );
  const imagePaths = new Set(messages.flatMap((message) => message.imagePaths));
  const messageIds = new Set(messages.map((message) => message.id));
  return {
    messages,
    images: conversation.images.filter((image) => imagePaths.has(image.path)),
    ...(conversation.imageDiagnostics
      ? { imageDiagnostics: conversation.imageDiagnostics }
      : {}),
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
