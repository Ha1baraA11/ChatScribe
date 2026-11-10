import type { ExportArtifactData, ExportMessage } from "./types.ts";

export interface ClipboardFormatResult {
  text: string;
  omittedImageCount: number;
  unavailableArtifactCount: number;
}

/**
 * Format message bodies for the system clipboard. Export document settings such
 * as title, timestamps, question numbering, heading style and separators do
 * not apply here.
 */
export function formatClipboardMessages(
  messages: readonly ExportMessage[],
  artifacts: Record<string, ExportArtifactData> = {},
): ClipboardFormatResult {
  const lastArtifactReference = new Map<string, number>();
  messages.forEach((message, index) => {
    for (const artifactId of message.artifactReferences ?? []) {
      lastArtifactReference.set(artifactId, index);
    }
  });

  let omittedImageCount = 0;
  let unavailableArtifactCount = 0;
  const bodies: string[] = [];

  messages.forEach((message, index) => {
    omittedImageCount += Math.max(0, message.imageCount ?? 0);
    const parts = [message.artifactBaseContent ?? message.content];

    for (const artifactId of message.artifactReferences ?? []) {
      if (lastArtifactReference.get(artifactId) !== index) continue;
      const artifact = artifacts[artifactId];
      if (!artifact || artifact.failed || artifact.content === null) {
        unavailableArtifactCount++;
        continue;
      }
      parts.push(formatArtifactSource(artifact.language, artifact.content));
    }

    const body = parts.filter((part) => part.length > 0).join("\n\n");
    if (!body.trim()) return;

    bodies.push(messages.length === 1
      ? body
      : `**${message.role === "user" ? "User" : "Assistant"}:**\n\n${body}`);
  });

  return {
    text: bodies.join("\n\n"),
    omittedImageCount,
    unavailableArtifactCount,
  };
}

function formatArtifactSource(language: string, content: string): string {
  let longestFence = 0;
  let currentFence = 0;
  for (const character of content) {
    if (character === "`") {
      currentFence++;
      longestFence = Math.max(longestFence, currentFence);
    } else {
      currentFence = 0;
    }
  }

  const fence = "`".repeat(Math.max(3, longestFence + 1));
  const safeLanguage = /^[\p{L}\p{N}_+-]+$/u.test(language) ? language : "";
  return `${fence}${safeLanguage}\n${content}\n${fence}`;
}
