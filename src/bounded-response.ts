/** Read a response stream while enforcing a byte limit, including chunked bodies. */
export async function readResponseBytesLimited(
  response: Response,
  maximumBytes: number,
  errorMessage: string,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(errorMessage);
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // Keep reporting the size-limit error even if the stream source
          // also fails while being cancelled.
        }
        throw new Error(errorMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Reject a redirect chain even if the final URL is still on the same host. */
export function assertNoRedirect(
  response: Response,
  expectedOrigin: string,
  errorMessage: string,
): void {
  if (response.redirected) throw new Error(errorMessage);
  if (!response.url) return;
  let finalUrl: URL;
  try {
    finalUrl = new URL(response.url);
  } catch {
    throw new Error(errorMessage);
  }
  if (finalUrl.origin !== expectedOrigin || finalUrl.protocol !== "https:") {
    throw new Error(errorMessage);
  }
}
