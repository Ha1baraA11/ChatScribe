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
 */

(function installBridge(): void {
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

  // Captured authentication headers from ChatGPT's own requests
  let capturedHeaders: Headers | null = null;

  // Wrap the native fetch to capture auth context
  const nativeFetch = window.fetch;

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

      if (isConvRequest && !capturedHeaders) {
        const rawHeaders =
          input instanceof Request ? new Headers(input.headers)
          : init?.headers ? new Headers(init.headers as HeadersInit)
          : null;

        if (rawHeaders) {
          capturedHeaders = rawHeaders;
          // Notify content.ts that auth context is now available
          window.postMessage({ source: SOURCE, type: "AUTH_READY" }, "*");
        }
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
      const payload = await response.json() as Record<string, unknown>;
      const resolvedUrl = getSafeImageUrl(payload.download_url ?? payload.url);
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

    const blob = await response.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length === 0) throw new Error("ChatGPT returned an empty image.");

    const CHUNK = 8192;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }

    return {
      base64: btoa(binary),
      mimeType: mimeType || "image/png",
      sizeBytes: bytes.length,
    };
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
    const response = await nativeFetch(imageUrl, {
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
    if (msg.type === "BRIDGE_PING") {
      window.postMessage(
        {
          source: SOURCE,
          type: "BRIDGE_PONG",
          authReady: Boolean(capturedHeaders),
        },
        "*",
      );
      return;
    }

    // --- API_REQUEST: fetch a conversation page ---
    if (msg.type === "API_REQUEST") {
      const requestId = msg.requestId as string;
      const conversationId = msg.conversationId as unknown;
      const cursor = typeof msg.cursor === "string" ? msg.cursor : null;

      if (!isValidConvId(conversationId)) {
        window.postMessage(
          {
            source: SOURCE,
            type: "BRIDGE_ERROR",
            requestId,
            error: "Invalid conversation ID.",
          },
          "*",
        );
        return;
      }

      if (!capturedHeaders) {
        window.postMessage(
          {
            source: SOURCE,
            type: "BRIDGE_ERROR",
            requestId,
            error: "CHATGPT_CONNECTION_NOT_READY",
          },
          "*",
        );
        return;
      }

      const headers = new Headers(capturedHeaders);
      const url = buildConvUrl(conversationId, cursor);

      void nativeFetch(url, {
        method: "GET",
        credentials: "include",
        headers,
      })
        .then(async (res) => {
          if (!res.ok) {
            throw new Error(
              `ChatGPT API returned ${res.status} ${res.statusText}`,
            );
          }
          const data = await res.json() as unknown;
          window.postMessage(
            { source: SOURCE, type: "API_RESPONSE", requestId, data },
            "*",
          );
        })
        .catch((err: unknown) => {
          window.postMessage(
            {
              source: SOURCE,
              type: "BRIDGE_ERROR",
              requestId,
              error: err instanceof Error ? err.message : String(err),
            },
            "*",
          );
        });

      return;
    }

    // --- IMAGE_REQUEST: download an image and return base64 ---
    if (msg.type === "IMAGE_REQUEST") {
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
            type: "BRIDGE_ERROR",
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
            type: "BRIDGE_ERROR",
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
              const response = await nativeFetch(safeRoute, {
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
            type: "IMAGE_RESPONSE",
            requestId,
            ...image,
          },
          "*",
        );
      })().catch((err: unknown) => {
        window.postMessage(
          {
            source: SOURCE,
            type: "BRIDGE_ERROR",
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
    { source: SOURCE, type: "BRIDGE_PONG", authReady: false },
    "*",
  );
})();
