import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_API_REQUEST_TYPE,
  BRIDGE_API_RESPONSE_TYPE,
  BRIDGE_PING_TYPE,
  BRIDGE_PONG_TYPE,
} from "../src/content-protocol.ts";

const conversationId = "123e4567-e89b-12d3-a456-426614174000";

type PostedMessage = Record<string, unknown>;
type MessageListener = (event: { source: unknown; data: unknown }) => void;

interface BridgeHarness {
  window: Record<string, unknown>;
  nativeFetch: ReturnType<typeof vi.fn>;
  posted: PostedMessage[];
  dispatch(message: PostedMessage, responseType?: string): Promise<PostedMessage>;
  listenerCount(): number;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function createBridgeHarness(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  withLegacyBridge = false,
): Promise<BridgeHarness> {
  vi.resetModules();

  const posted: PostedMessage[] = [];
  const waiters = new Map<string, Array<(message: PostedMessage) => void>>();
  const messageListeners: MessageListener[] = [];

  const fakeWindow: Record<string, unknown> = {
    location: { origin: "https://chatgpt.com" },
    fetch: vi.fn(fetchImpl),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: (type: string, listener: unknown) => {
      if (type === "message") messageListeners.push(listener as MessageListener);
    },
    postMessage: (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const message = value as PostedMessage;
      posted.push(message);
      const type = String(message.type ?? "");
      for (const resolve of waiters.get(type) ?? []) resolve(message);
      waiters.delete(type);
    },
  };

  if (withLegacyBridge) {
    fakeWindow.__chatScribeBridgeInstalled = true;
    messageListeners.push((event) => {
      const message = event.data as PostedMessage;
      if (message.type === "BRIDGE_PING") {
        (fakeWindow.postMessage as (value: PostedMessage) => void)({
          source: "ChatScribe",
          type: "BRIDGE_PONG",
        });
      }
    });
  }

  vi.stubGlobal("window", fakeWindow);
  await import("../src/bridge.ts");

  return {
    window: fakeWindow,
    nativeFetch: fakeWindow.fetch as ReturnType<typeof vi.fn>,
    posted,
    listenerCount: () => messageListeners.length,
    dispatch(message, responseType = BRIDGE_API_RESPONSE_TYPE) {
      return new Promise((resolve, reject) => {
        if (messageListeners.length === 0) {
          reject(new Error("Bridge message listener was not installed."));
          return;
        }
        const type = responseType;
        const listeners = waiters.get(type) ?? [];
        listeners.push(resolve);
        waiters.set(type, listeners);
        for (const listener of [...messageListeners]) {
          listener({ source: fakeWindow, data: message });
        }
      });
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("MAIN-world bridge conversation requests", () => {
  it("installs beside an older bridge and handles only current-build requests", async () => {
    const nativeFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "https://chatgpt.com/api/auth/session") {
        return jsonResponse({ accessToken: "current-token" });
      }
      return jsonResponse({ conversation_id: conversationId, messages: ["current-build"] });
    });
    const harness = await createBridgeHarness(nativeFetch, true);

    expect(harness.listenerCount()).toBe(2);
    expect(harness.posted.some((message) => message.type === BRIDGE_PONG_TYPE)).toBe(true);
    expect(harness.posted.some((message) => message.type === "BRIDGE_PONG")).toBe(false);
    const pong = await harness.dispatch({
      source: "ChatScribe",
      type: BRIDGE_PING_TYPE,
    }, BRIDGE_PONG_TYPE);
    expect(pong.type).toBe(BRIDGE_PONG_TYPE);

    const response = await harness.dispatch({
      source: "ChatScribe",
      type: BRIDGE_API_REQUEST_TYPE,
      requestId: "current-request",
      conversationId,
    });
    expect(response.data).toEqual({
      conversation_id: conversationId,
      messages: ["current-build"],
    });
    expect(harness.posted.some((message) => message.type === "API_RESPONSE")).toBe(false);

    const installedFetch = harness.window.fetch;
    vi.resetModules();
    await import("../src/bridge.ts");
    expect(harness.listenerCount()).toBe(2);
    expect(harness.window.fetch).toBe(installedFetch);
  });

  it("recovers an auth token from the session endpoint when no request was captured", async () => {
    const nativeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://chatgpt.com/api/auth/session") {
        return jsonResponse({ accessToken: "fixture-token" });
      }
      expect(String(input)).toBe(`/backend-api/conversations/${conversationId}?include_has_versions=true&num_turns=50`);
      expect(init?.method).toBe("GET");
      expect(init?.credentials).toBe("include");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
      return jsonResponse({ conversation_id: conversationId, messages: [] });
    });
    const harness = await createBridgeHarness(nativeFetch);

    const response = await harness.dispatch({
      source: "ChatScribe",
      type: BRIDGE_API_REQUEST_TYPE,
      requestId: "request-1",
      conversationId,
    });

    expect(response.type).toBe(BRIDGE_API_RESPONSE_TYPE);
    expect(response.requestId).toBe("request-1");
    expect(response.data).toEqual({ conversation_id: conversationId, messages: [] });
    expect(nativeFetch).toHaveBeenCalledTimes(2);
  });

  it("refreshes a stale bearer token once after an unauthorized response", async () => {
    const conversationAuthorization: Array<string | null> = [];
    let conversationCall = 0;
    const nativeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://chatgpt.com/api/auth/session") {
        return jsonResponse({ accessToken: "fresh-fixture-token" });
      }
      if (url.startsWith("/backend-api/conversations/")) {
        conversationAuthorization.push(new Headers(init?.headers).get("authorization"));
        conversationCall += 1;
        if (conversationCall === 2) return new Response(null, { status: 401 });
        return jsonResponse({ conversation_id: conversationId, messages: [] });
      }
      throw new Error(`Unexpected bridge fetch: ${url}`);
    });
    const harness = await createBridgeHarness(nativeFetch);
    const pageFetch = harness.window.fetch as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;

    await pageFetch(`/backend-api/conversations/${conversationId}`, {
      headers: { Authorization: "Bearer stale-fixture-token" },
    });

    const response = await harness.dispatch({
      source: "ChatScribe",
      type: BRIDGE_API_REQUEST_TYPE,
      requestId: "request-2",
      conversationId,
    });

    expect(response.type).toBe(BRIDGE_API_RESPONSE_TYPE);
    expect(conversationAuthorization).toEqual([
      "Bearer stale-fixture-token",
      "Bearer stale-fixture-token",
      "Bearer fresh-fixture-token",
    ]);
    expect(nativeFetch).toHaveBeenCalledTimes(4);
  });
});
