/**
 * bridge.ts — ChatScribe
 *
 * Injected into chatgpt.com's MAIN world at document_start.
 * Intercepts ChatGPT's own fetch calls to capture authentication
 * headers, then makes authenticated API requests on behalf of
 * content.ts via postMessage.
 *
 * Communication protocol (all messages tagged source: "ChatScribe"):
 *   BRIDGE_PING          → content asks if bridge is ready
 *   BRIDGE_PONG          → bridge answers with readiness state
 *   API_REQUEST          → content requests a conversation page
 *   API_RESPONSE         → bridge returns conversation JSON
 *   IMAGE_REQUEST        → content requests an image download
 *   IMAGE_RESPONSE       → bridge returns base64 image data
 *   BRIDGE_ERROR         → bridge reports an error for a request
 * Message types are scoped to the build so an old bridge in an already-open
 * ChatGPT tab cannot answer requests from a newly loaded extension.
 */

import {
  BRIDGE_API_REQUEST_TYPE,
  BRIDGE_API_RESPONSE_TYPE,
  BRIDGE_ERROR_TYPE,
  BRIDGE_IMAGE_REQUEST_TYPE,
  BRIDGE_IMAGE_RESPONSE_TYPE,
  BRIDGE_PING_TYPE,
  BRIDGE_PONG_TYPE,
  CHATSCRIBE_BUILD_ID,
} from "./content-protocol.ts";

(function installBridge(): void {
  const bridgeWindow = window as Window & {
    __chatScribeBridgeBuildIds?: Set<string>;
    __chatScribeBridgeFetchBase?: typeof window.fetch;
  };
  const installedBuildIds = bridgeWindow.__chatScribeBridgeBuildIds ??= new Set();
  if (installedBuildIds.has(CHATSCRIBE_BUILD_ID)) return;
  installedBuildIds.add(CHATSCRIBE_BUILD_ID);

  const SOURCE = "ChatScribe";

  // ChatGPT conversation API endpoints
  // ChatGPT uses both singular and plural conversation routes. Match the
  // initial conversation request as well as paginated /messages requests.
  const CONV_API_RE =
    /\/backend-api\/conversations?\/[0-9a-f-]{36}(?:\/messages)?(?:[/?#]|$)/i;

  // Allowed image hosts for security
  const SAFE_IMAGE_HOSTS = new Set([
    "oaiusercontent.com",
    "oaistatic.com",
  ]);
  const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
  const MAX_RESOLVER_RESPONSE_BYTES = 64 * 1024;

  // Captured authentication headers from ChatGPT's own requests
  let capturedHeaders: Headers | null = null;
  let authRefreshInFlight: Promise<Headers> | null = null;

  async function refreshAuthHeaders(): Promise<Headers> {
    if (authRefreshInFlight) return authRefreshInFlight;

    const refresh = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 6_000);
        try {
          // The page can be open before the extension is installed or reloaded,
          // so the bridge may miss ChatGPT's initial conversation request. The
          // same-origin session endpoint lets it recover the current bearer
          // token without asking the user to reload the page.
          const response = await nativeFetch(
            new URL("/api/auth/session", window.location.origin),
            {
              method: "GET",
              credentials: "include",
              headers: { Accept: "application/json" },
              signal: controller.signal,
            },
          );
          if (!response.ok) {
            throw new Error(`ChatGPT session check returned ${response.status}.`);
          }

          const session = await response.json() as unknown;
          if (!session || typeof session !== "object" || Array.isArray(session)) {
            throw new Error("CHATGPT_CONNECTION_NOT_READY");
          }
          const data = session as Record<string, unknown>;
          const accessToken = data.accessToken ?? data.access_token;
          if (typeof accessToken !== "string" || accessToken.length === 0) {
            throw new Error("CHATGPT_CONNECTION_NOT_READY");
          }

          const headers = new Headers(capturedHeaders ?? undefined);
          headers.set("Authorization", `Bearer ${accessToken}`);
          capturedHeaders = headers;
          return headers;
        } catch (error) {
          if (attempt > 0 || !(error instanceof TypeError)) throw error;
          await new Promise((resolve) => window.setTimeout(resolve, 350));
        } finally {
          window.clearTimeout(timeout);
        }
      }
      throw new Error("CHATGPT_CONNECTION_NOT_READY");
    })();

    authRefreshInFlight = refresh;
    try {
      return await refresh;
    } finally {
      if (authRefreshInFlight === refresh) authRefreshInFlight = null;
    }
  }

  function isTransientFetchError(error: unknown): boolean {
    return error instanceof TypeError;
  }

  async function fetchConversationData(url: string): Promise<unknown> {
    let headers = capturedHeaders ?? await refreshAuthHeaders();
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await nativeFetch(url, {
          method: "GET",
          credentials: "include",
          headers: new Headers(headers),
          signal: controller.signal,
        });

        if ((response.status === 401 || response.status === 403) && attempt === 0) {
          try {
            await response.body?.cancel();
          } catch {
            // A failed body cleanup should not block the auth refresh.
          }
          headers = await refreshAuthHeaders();
          continue;
        }

        const retryableStatus =
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;
        if (retryableStatus && attempt === 0) {
          try {
            await response.body?.cancel();
          } catch {
            // Keep the bounded retry even if the body cannot be cancelled.
          }
          await new Promise((resolve) => window.setTimeout(resolve, 350));
          continue;
        }

        if (!response.ok) {
          throw new Error(`ChatGPT API returned ${response.status} ${response.statusText}`);
        }
        return await response.json() as unknown;
      } catch (error) {
        lastError = error;
        if (attempt > 0 || !isTransientFetchError(error)) throw error;
        await new Promise((resolve) => window.setTimeout(resolve, 350));
      } finally {
        window.clearTimeout(timeout);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("ChatGPT conversation request failed after retry.");
  }

  // Wrap the native fetch to capture auth context
  // Reuse the first available fetch across later builds. An older unversioned
  // bridge may already wrap it, but reloading this build cannot stack another
  // wrapper on top of every bridge version installed in the same tab.
  const nativeFetch = bridgeWindow.__chatScribeBridgeFetchBase ??= window.fetch;

  window.fetch = function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    try {
      const url =
        input instanceof Request ? input.url
        : input instanceof URL ? input.toString()
        : String(input);

      const isConvRequest = CONV_API_RE.test(url);

      if (isConvRequest && (input instanceof Request || init?.headers !== undefined)) {
        const requestHeaders = input instanceof Request
          ? new Headers(input.headers)
          : new Headers();
        if (init?.headers !== undefined) {
          new Headers(init.headers as HeadersInit).forEach((value, name) => {
            requestHeaders.set(name, value);
          });
        }

        // ChatGPT can rotate authentication headers while a tab remains open.
        // Refresh observed values on every conversation request, while keeping
        // headers that the current request omitted but the bridge still needs.
        const refreshedHeaders = new Headers(capturedHeaders ?? undefined);
        requestHeaders.forEach((value, name) => refreshedHeaders.set(name, value));
        capturedHeaders = refreshedHeaders;
      }
    } catch {
      // Never break the real fetch
    }

    // Always forward original arguments unchanged
    return Reflect.apply(nativeFetch, this, [input, init]) as Promise<Response>;
  };

  // Helper: build the paginated conversation URL
  function buildConvUrl(
    conversationId: string,
    cursor: string | null,
  ): string {
    if (!cursor) {
      return (
        `/backend-api/conversations/${conversationId}` +
        `?include_has_versions=true&num_turns=50`
      );
    }
    return (
      `/backend-api/conversations/${conversationId}/messages` +
      `?before=${encodeURIComponent(cursor)}&include_has_versions=true&num_turns=50`
    );
  }

  // Helper: validate conversation ID format
  function isValidConvId(id: unknown): id is string {
    return (
      typeof id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    );
  }

  // Helper: allow only OpenAI image hosts, approved ChatGPT backend paths,
  // and blob URLs created by this ChatGPT page.
  function getSafeImageUrl(value: unknown): string | null {
    if (typeof value !== "string" || value.length === 0) return null;
    try {
      const u = new URL(value, window.location.origin);
      if (u.username || u.password) return null;

      if (u.protocol === "blob:") {
        return u.origin === window.location.origin ? u.toString() : null;
      }
      if (u.protocol !== "https:") return null;

      const host = u.hostname.toLowerCase();
      // Allow oaiusercontent.com and subdomains; oaistatic.com and subdomains
      for (const safe of SAFE_IMAGE_HOSTS) {
        if (host === safe || host.endsWith("." + safe)) return u.toString();
      }
      // Also allow relative ChatGPT backend paths on the same origin
      if (u.origin === window.location.origin) {
        const path = u.pathname;
        if (
          /^\/backend-api\/estuary\/content/i.test(path) ||
          /^\/backend-api\/files\/(?:download\/)?file[-_][a-z0-9_-]+(?:\/download)?$/i.test(path) ||
          /^\/backend-api\/conversation\/[0-9a-f-]{36}\/attachment\/file[-_][a-z0-9_-]+\/download$/i.test(path)
        ) {
          return u.toString();
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  function isSafeImageUrl(value: unknown): value is string {
    return getSafeImageUrl(value) !== null;
  }

  function isValidFileId(value: unknown): value is string {
    return typeof value === "string" && /^file[-_][A-Za-z0-9_-]{1,255}$/i.test(value);
  }

  function buildFileDownloadUrls(
    conversationId: string,
    fileId: string,
    scheme: "file-service" | "sediment",
  ): string[] {
    const encodedFileId = encodeURIComponent(fileId);
    const encodedConversationId = encodeURIComponent(conversationId);
    const resolver = new URLSearchParams({
      conversation_id: conversationId,
      download_intent: "false",
      inline: "true",
    });
    const byResolver =
      `/backend-api/files/download/${encodedFileId}?${resolver.toString()}`;
    const byFileId = `/backend-api/files/${encodedFileId}/download`;
    const byConversation =
      `/backend-api/conversation/${encodedConversationId}/attachment/${encodedFileId}/download`;

    return scheme === "file-service"
      ? [byFileId, byResolver, byConversation]
      : [byResolver, byConversation, byFileId];
  }

  function imageRetryDelay(response: Response, attempt: number): number {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return Math.min(5_000, Math.max(0, seconds * 1_000));

      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) return Math.min(5_000, Math.max(0, date - Date.now()));
    }

    return Math.min(2_000, 300 * 2 ** attempt);
  }

  async function fetchImageResponse(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await nativeFetch(url, init);
        const retryable =
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;
        if (!retryable || attempt === maxAttempts - 1) return response;

        try {
          await response.body?.cancel();
        } catch {
          // A failed body cleanup should not prevent the bounded retry.
        }
        await new Promise((resolve) =>
          window.setTimeout(resolve, imageRetryDelay(response, attempt)),
        );
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts - 1) throw error;
        await new Promise((resolve) =>
          window.setTimeout(resolve, Math.min(2_000, 300 * 2 ** attempt)),
        );
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Image download failed after retries.");
  }

  async function readImageResponse(
    response: Response,
    resolverDepth = 0,
  ): Promise<{
    base64: string;
    mimeType: string;
    sizeBytes: number;
  }> {
    if (!response.ok) {
      throw new Error(`Image download failed: ${response.status}`);
    }

    const mimeType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();

    if (mimeType.includes("json")) {
      if (resolverDepth >= 2) {
        throw new Error("Image resolver returned too many redirects.");
      }
      const resolverBytes = await readBoundedResponseBytes(
        response,
        MAX_RESOLVER_RESPONSE_BYTES,
        "Image resolver response exceeds the size limit.",
      );
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(resolverBytes));
      } catch {
        throw new Error("Image resolver returned invalid JSON.");
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Image resolver returned invalid data.");
      }
      const resolverData = payload as Record<string, unknown>;
      const resolvedUrl = getSafeImageUrl(
        resolverData.download_url ?? resolverData.url,
      );
      if (!resolvedUrl) throw new Error("Image resolver returned an unsafe URL.");
      return fetchImageUrl(resolvedUrl, resolverDepth + 1);
    }

    if (
      mimeType &&
      !mimeType.startsWith("image/") &&
      mimeType !== "application/octet-stream" &&
      mimeType !== "application/binary"
    ) {
      throw new Error("ChatGPT returned a non-image attachment.");
    }

    const bytes = await readBoundedResponseBytes(
      response,
      MAX_IMAGE_BYTES,
      "Image exceeds the 20 MB export limit.",
    );
    if (bytes.length === 0) throw new Error("ChatGPT returned an empty image.");

    return {
      base64: bytesToBase64(bytes),
      mimeType: mimeType || "image/png",
      sizeBytes: bytes.length,
    };
  }

  function bytesToBase64(bytes: Uint8Array): string {
    // Keep the temporary binary string small. Chunk sizes are multiples of 3
    // so concatenating the Base64 segments does not introduce mid-stream padding.
    const chunkSize = 3 * 8192;
    let base64 = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      let binary = "";
      for (let index = 0; index < chunk.length; index += 8192) {
        binary += String.fromCharCode(...chunk.subarray(index, index + 8192));
      }
      base64 += btoa(binary);
    }
    return base64;
  }

  async function readBoundedResponseBytes(
    response: Response,
    maxBytes: number,
    limitError: string,
  ): Promise<Uint8Array> {
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const declaredSize = Number(contentLength);
      if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(limitError);
      }
    }

    const reader = response.body?.getReader();
    if (!reader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > maxBytes) throw new Error(limitError);
      return bytes;
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(limitError);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    chunks.length = 0;
    return bytes;
  }

  async function fetchImageUrl(value: string, resolverDepth = 0): Promise<{
    base64: string;
    mimeType: string;
    sizeBytes: number;
  }> {
    const imageUrl = getSafeImageUrl(value);
    if (!imageUrl) throw new Error("Image URL is not from an allowed host.");

    const url = new URL(imageUrl);
    const sameOrigin = url.protocol === "https:" && url.origin === window.location.origin;
    const response = await fetchImageResponse(imageUrl, {
      method: "GET",
      credentials: sameOrigin ? "include" : "omit",
      headers: sameOrigin && capturedHeaders
        ? new Headers(capturedHeaders)
        : new Headers(),
    });
    return readImageResponse(response, resolverDepth);
  }

  // Message handler: respond to requests from content.ts
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const msg = event.data as Record<string, unknown> | null;
    if (!msg || msg.source !== SOURCE) return;

    // --- Ping: report bridge readiness ---
    if (msg.type === BRIDGE_PING_TYPE) {
      window.postMessage(
        {
          source: SOURCE,
          type: BRIDGE_PONG_TYPE,
          authReady: Boolean(capturedHeaders),
        },
        "*",
      );
      return;
    }

    // --- API_REQUEST: fetch a conversation page ---
    if (msg.type === BRIDGE_API_REQUEST_TYPE) {
      const requestId = msg.requestId as string;
      const conversationId = msg.conversationId as unknown;
      const cursor = typeof msg.cursor === "string" ? msg.cursor : null;

      if (!isValidConvId(conversationId)) {
        window.postMessage(
          {
            source: SOURCE,
            type: BRIDGE_ERROR_TYPE,
            requestId,
            error: "Invalid conversation ID.",
          },
          "*",
        );
        return;
      }

      const url = buildConvUrl(conversationId, cursor);

      void fetchConversationData(url)
        .then((data) => {
          window.postMessage(
            { source: SOURCE, type: BRIDGE_API_RESPONSE_TYPE, requestId, data },
            "*",
          );
        })
        .catch((err: unknown) => {
          window.postMessage(
            {
              source: SOURCE,
              type: BRIDGE_ERROR_TYPE,
              requestId,
              error: err instanceof Error ? err.message : String(err),
            },
            "*",
          );
        });

      return;
    }

    // --- IMAGE_REQUEST: download an image and return base64 ---
    if (msg.type === BRIDGE_IMAGE_REQUEST_TYPE) {
      const requestId = msg.requestId as string;
      const imageUrl = msg.imageUrl as unknown;
      const fileId = msg.fileId as unknown;
      const scheme = msg.scheme as unknown;
      const conversationId = msg.conversationId as unknown;
      const hasImageUrl = isSafeImageUrl(imageUrl);
      const hasFileReference =
        isValidFileId(fileId) &&
        (scheme === "file-service" || scheme === "sediment") &&
        isValidConvId(conversationId);

      if (!hasImageUrl && !hasFileReference) {
        window.postMessage(
          {
            source: SOURCE,
            type: BRIDGE_ERROR_TYPE,
            requestId,
            error: "Image URL or file reference is invalid.",
          },
          "*",
        );
        return;
      }

      if (!capturedHeaders) {
        window.postMessage(
          {
            source: SOURCE,
            type: BRIDGE_ERROR_TYPE,
            requestId,
            error: "Auth context not ready for image download.",
          },
          "*",
        );
        return;
      }

      void (async () => {
        let image: { base64: string; mimeType: string; sizeBytes: number } | null = null;
        let lastError: unknown;

        if (hasImageUrl) {
          try {
            image = await fetchImageUrl(imageUrl);
          } catch (err) {
            lastError = err;
          }
        }

        if (!image && hasFileReference) {
          const routes = buildFileDownloadUrls(
            conversationId,
            fileId,
            scheme,
          );

          for (const route of routes) {
            const safeRoute = getSafeImageUrl(route);
            if (!safeRoute) continue;

            try {
              const response = await fetchImageResponse(safeRoute, {
                method: "GET",
                credentials: "include",
                headers: new Headers(capturedHeaders),
              });
              if (!response.ok) {
                lastError = new Error(`Image download failed: ${response.status}`);
                continue;
              }
              image = await readImageResponse(response);
              break;
            } catch (err) {
              lastError = err;
            }
          }
        }

        if (!image) {
          throw lastError instanceof Error
            ? lastError
            : new Error("ChatGPT did not return a usable image file.");
        }

        window.postMessage(
          {
            source: SOURCE,
            type: BRIDGE_IMAGE_RESPONSE_TYPE,
            requestId,
            ...image,
          },
          "*",
        );
      })().catch((err: unknown) => {
        window.postMessage(
          {
            source: SOURCE,
            type: BRIDGE_ERROR_TYPE,
            requestId,
            error: err instanceof Error ? err.message : String(err),
          },
          "*",
        );
      });

      return;
    }
  });

  // Announce the bridge is installed (auth not yet ready until first fetch observed)
  window.postMessage(
    { source: SOURCE, type: BRIDGE_PONG_TYPE, authReady: false },
    "*",
  );
})();
