import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_API_REQUEST_TYPE,
  BRIDGE_API_RESPONSE_TYPE,
  BRIDGE_PING_TYPE,
  BRIDGE_PONG_TYPE,
  CHATSCRIBE_BUILD_ID,
  CONTENT_LOAD_TYPE,
} from "../src/content-protocol.ts";
import type { ApiConversationPage } from "../src/types.ts";

type ContentListener = (
  message: Record<string, unknown>,
  sender: { id: string },
  respond: (response: unknown) => void,
) => boolean | void;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("conversation refresh cache", () => {
  it("keeps cached data for normal loads and bypasses it for a forced refresh", async () => {
    vi.resetModules();

    const listeners = new Set<ContentListener>();
    const windowListeners = new Map<string, Set<(event: unknown) => void>>();
    const conversationId = "6ae70144-c71c-83e8-96ff-becefe0f3be7";
    const fakeWindow = {
      location: {
        pathname: `/c/${conversationId}`,
        origin: "https://chatgpt.com",
      },
      __chatScribeContentCleanupByBuild: new Map<string, () => void>(),
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        const bucket = windowListeners.get(type) ?? new Set();
        bucket.add(listener);
        windowListeners.set(type, bucket);
      },
      removeEventListener: (type: string, listener: (event: unknown) => void) => {
        windowListeners.get(type)?.delete(listener);
      },
      clearTimeout: (timer: number) => globalThis.clearTimeout(timer),
      setTimeout: (callback: TimerHandler, delay?: number) =>
        globalThis.setTimeout(callback, delay),
      postMessage: (message: Record<string, unknown>) => {
        const dispatch = (data: Record<string, unknown>) => {
          const event = { source: fakeWindow, data };
          for (const listener of [...(windowListeners.get("message") ?? [])]) {
            listener(event);
          }
        };

        if (message.type === BRIDGE_PING_TYPE) {
          dispatch({ source: "ChatScribe", type: BRIDGE_PONG_TYPE });
          return;
        }
        if (message.type === BRIDGE_API_REQUEST_TYPE) {
          dispatch({
            source: "ChatScribe",
            type: BRIDGE_API_RESPONSE_TYPE,
            requestId: message.requestId,
            data: structuredClone(apiPage),
          });
        }
      },
    };

    const apiPage: ApiConversationPage = {
      current_node: "assistant-1",
      messages: [
        {
          id: "user-1",
          parent: null,
          author: { role: "user" },
          end_turn: true,
          content: { parts: ["question"] },
        },
        {
          id: "assistant-1",
          parent: "user-1",
          author: { role: "assistant" },
          end_turn: false,
          content: { parts: ["answer is still streaming"] },
        },
      ],
    };
    const apiRequestCount = vi.fn();
    const originalPostMessage = fakeWindow.postMessage;
    fakeWindow.postMessage = (message) => {
      if (message.type === BRIDGE_API_REQUEST_TYPE) apiRequestCount();
      originalPostMessage(message);
    };

    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", {
      querySelectorAll: () => [],
    });
    vi.stubGlobal("chrome", {
      runtime: {
        onMessage: {
          addListener: (listener: ContentListener) => listeners.add(listener),
          removeListener: (listener: ContentListener) => listeners.delete(listener),
        },
        sendMessage: vi.fn(async () => undefined),
      },
      storage: {
        sync: { get: vi.fn(async () => ({ theme: "system" })) },
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    });
    vi.stubGlobal("crypto", { randomUUID: () => "request-id" });

    await import("../src/content.ts");
    expect(listeners.size).toBe(1);
    const contentListener = [...listeners][0];
    const load = (message: Record<string, unknown>) => new Promise<any>((resolve) => {
      contentListener(message, { id: "chatscribe-test" }, resolve);
    });

    const initial = await load({
      type: CONTENT_LOAD_TYPE,
      downloadImages: false,
      includeGeneratedImages: true,
      fetchImages: false,
    });
    expect(initial.data.messages.map((message: { role: string }) => message.role))
      .toEqual(["user"]);
    expect(apiRequestCount).toHaveBeenCalledTimes(1);

    // Use a different load key to exercise the raw API cache independently
    // from the completed ConversationData cache.
    apiPage.messages![1].end_turn = true;
    const cached = await load({
      type: CONTENT_LOAD_TYPE,
      downloadImages: false,
      includeGeneratedImages: true,
      fetchImages: false,
      selectedMessageIds: ["user-1"],
    });
    expect(cached.data.messages.map((message: { role: string }) => message.role))
      .toEqual(["user"]);
    expect(apiRequestCount).toHaveBeenCalledTimes(1);

    const refreshed = await load({
      type: CONTENT_LOAD_TYPE,
      downloadImages: false,
      includeGeneratedImages: true,
      fetchImages: false,
      forceRefresh: true,
    });
    expect(refreshed.data.messages.map((message: { role: string }) => message.role))
      .toEqual(["user", "assistant"]);
    expect(refreshed.data.revision).toBeDefined();
    expect(apiRequestCount).toHaveBeenCalledTimes(2);
    expect(CHATSCRIBE_BUILD_ID).toBeTruthy();
  });
});
