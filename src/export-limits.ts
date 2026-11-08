/** Existing background message safety cap for GitHub content, measured after base64 encoding. */
export const MAX_GITHUB_CONTENT_BASE64_LENGTH = 10_000_000;

export function base64LengthForByteCount(byteCount: number): number {
  return Math.ceil(byteCount / 3) * 4;
}

export function base64LengthForText(text: string): number {
  return base64LengthForByteCount(new TextEncoder().encode(text).byteLength);
}

export function assertGitHubPayloadSize(base64Length: number): void {
  if (base64Length > MAX_GITHUB_CONTENT_BASE64_LENGTH) {
    throw new Error("GITHUB_PAYLOAD_TOO_LARGE");
  }
}
