import type {
  ExportArchiveFile,
  ExportArtifactData,
  ExportMessage,
} from "./types.ts";
import { renderSvgDataUrlToPngBase64 } from "./svg-template.ts";

const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 200 * 1024 * 1024;

export interface ClaudeArtifactArchiveResult {
  messages: ExportMessage[];
  files: ExportArchiveFile[];
  unavailableCount: number;
  previewFailureCount: number;
}

function utf8ToBase64(value: string): { base64: string; sizeBytes: number } {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return { base64: btoa(binary), sizeBytes: bytes.length };
}

function safeBasename(title: string): string {
  const withoutExtension = title.replace(/\.[a-z\d]{1,10}$/i, "");
  const safe = withoutExtension
    .normalize("NFKC")
    .replace(/[\\/<>:"|?*\u0000-\u001f]/g, " ")
    .replace(/\.\.+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}._-]/gu, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 72);
  return safe || "artifact";
}

function getArtifactExtension(artifact: ExportArtifactData): string {
  const titleExtension = artifact.title.match(/\.([a-z\d]{1,10})$/i)?.[1]?.toLowerCase();
  const language = artifact.language.trim().toLowerCase().replace(/^\./, "");
  const normalizedLanguage = language.startsWith("text/") || language.startsWith("image/")
    ? language.split("/").at(-1) ?? language
    : language;
  const supported = new Set([
    "html", "htm", "svg", "xml", "css", "js", "mjs", "ts", "tsx", "jsx",
    "json", "md", "txt", "py", "rb", "go", "rs", "java", "c", "h", "cpp",
    "sh", "yaml", "yml", "sql", "csv",
  ]);
  if (supported.has(normalizedLanguage)) return normalizedLanguage === "htm" ? "html" : normalizedLanguage;
  if (titleExtension && supported.has(titleExtension)) return titleExtension;
  return "txt";
}

function mimeTypeForExtension(extension: string): string {
  switch (extension) {
    case "html": return "text/html;charset=utf-8";
    case "svg": return "image/svg+xml;charset=utf-8";
    case "xml": return "application/xml;charset=utf-8";
    case "css": return "text/css;charset=utf-8";
    case "js":
    case "mjs": return "text/javascript;charset=utf-8";
    case "json": return "application/json;charset=utf-8";
    case "md": return "text/markdown;charset=utf-8";
    case "csv": return "text/csv;charset=utf-8";
    default: return "text/plain;charset=utf-8";
  }
}

function uniquePath(path: string, used: Set<string>): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const base = dot > slash ? path.slice(0, dot) : path;
  const extension = dot > slash ? path.slice(dot) : "";
  let suffix = 2;
  while (used.has(`${base}-${suffix}${extension}`)) suffix++;
  const result = `${base}-${suffix}${extension}`;
  used.add(result);
  return result;
}

/**
 * Add only selected Claude Artifact sources to the archive. Artifact text is
 * retained in the message's existing fenced block; optional SVG previews are
 * rasterized by the same static SVG sanitizer used for ChatGPT diagrams.
 */
export async function buildClaudeArtifactArchive(
  messages: readonly ExportMessage[],
  artifacts: Record<string, ExportArtifactData> = {},
): Promise<ClaudeArtifactArchiveResult> {
  const selectedArtifactIds = new Set(messages.flatMap((message) =>
    message.artifactReferences ?? []
  ));
  const lastReferenceIndex = new Map<string, number>();
  messages.forEach((message, index) => {
    for (const artifactId of message.artifactReferences ?? []) {
      lastReferenceIndex.set(artifactId, index);
    }
  });

  const usedPaths = new Set<string>();
  const sourcePathById = new Map<string, string>();
  const previewPathById = new Map<string, string>();
  const files: ExportArchiveFile[] = [];
  let unavailableCount = 0;
  let previewFailureCount = 0;
  let totalArtifactBytes = 0;

  for (const artifactId of selectedArtifactIds) {
    const artifact = artifacts[artifactId];
    if (!artifact || artifact.failed || artifact.content === null) {
      unavailableCount++;
      continue;
    }

    const extension = getArtifactExtension(artifact);
    const encoded = utf8ToBase64(artifact.content);
    if (
      encoded.sizeBytes > MAX_ARTIFACT_BYTES ||
      totalArtifactBytes + encoded.sizeBytes > MAX_TOTAL_ARTIFACT_BYTES
    ) {
      unavailableCount++;
      continue;
    }
    totalArtifactBytes += encoded.sizeBytes;

    const basename = safeBasename(artifact.title);
    const sourcePath = uniquePath(`artifacts/${basename}.${extension}`, usedPaths);
    sourcePathById.set(artifactId, sourcePath);
    files.push({
      path: sourcePath,
      mimeType: mimeTypeForExtension(extension),
      base64: encoded.base64,
      sizeBytes: encoded.sizeBytes,
    });

    if (extension === "svg") {
      try {
        const dataUrl = `data:image/svg+xml;base64,${encoded.base64}`;
        const pngBase64 = await renderSvgDataUrlToPngBase64(dataUrl);
        if (pngBase64) {
          const path = uniquePath(`images/${basename}-preview.png`, usedPaths);
          const padding = pngBase64.endsWith("==") ? 2 : pngBase64.endsWith("=") ? 1 : 0;
          const sizeBytes = Math.floor(pngBase64.length * 3 / 4) - padding;
          previewPathById.set(artifactId, path);
          files.push({ path, mimeType: "image/png", base64: pngBase64, sizeBytes });
        } else {
          previewFailureCount++;
        }
      } catch {
        previewFailureCount++;
      }
    }
  }

  const outputMessages = messages.map((message, index) => {
    const references = (message.artifactReferences ?? [])
      .filter((artifactId) => lastReferenceIndex.get(artifactId) === index);
    const sourceLines: string[] = [];
    for (const artifactId of references) {
      const sourcePath = sourcePathById.get(artifactId);
      if (sourcePath) sourceLines.push(`Artifact source file: \`${sourcePath}\``);
      const previewPath = previewPathById.get(artifactId);
      if (previewPath) sourceLines.push(`![Artifact preview](${previewPath})`);
    }
    return sourceLines.length
      ? {
          ...message,
          content: `${message.content}\n\n${sourceLines.join("\n\n")}`,
        }
      : message;
  });

  return { messages: outputMessages, files, unavailableCount, previewFailureCount };
}
