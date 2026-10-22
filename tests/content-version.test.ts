import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHATSCRIBE_BUILD_ID,
  CONTENT_LOAD_TYPE,
  CONTENT_PING_TYPE,
} from "../src/content-protocol.ts";

type MessageListener = (
  message: { type: string; tabId?: number },
  sender: { id: string },
  respond: (response: unknown) => void,
) => boolean | void;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("content script build handshake", () => {
  it("replaces a stale content listener before exporting", async () => {
    vi.resetModules();
    const listeners: MessageListener[] = [];
    const injected: string[] = [];
    let currentContentInstalled = false;
    const fakeChrome = {
      runtime: {
        id: "chatscribe-test",
        onMessage: { addListener: (listener: MessageListener) => listeners.push(listener) },
        onStartup: { addListener: vi.fn() },
        onInstalled: { addListener: vi.fn() },
        sendMessage: vi.fn(),
      },
      storage: {
        sync: { get: vi.fn(async () => ({ panelMode: "popup" })) },
        local: { set: vi.fn(async () => undefined) },
        onChanged: { addListener: vi.fn() },
      },
      downloads: { onChanged: { addListener: vi.fn() } },
      tabs: {
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          url: "https://chatgpt.com/c/example",
        })),
        sendMessage: vi.fn(async (_tabId: number, message: { type: string }) => {
          if (message.type !== CONTENT_PING_TYPE) return { ready: true };
          return currentContentInstalled
            ? { ready: true, buildId: CHATSCRIBE_BUILD_ID }
            : { ready: true }; // Stale script answers, but has no build identity.
        }),
      },
      scripting: {
        executeScript: vi.fn(async (details: { files: string[] }) => {
          injected.push(details.files[0]);
          if (details.files[0] === "content.js") currentContentInstalled = true;
          return [];
        }),
      },
    };
    vi.stubGlobal("chrome", fakeChrome);
    await import("../src/background.ts");

    const response = await new Promise<unknown>((resolve, reject) => {
      const matching = listeners.filter((listener) => listener(
        { type: "ENSURE_CONTENT_SCRIPT", tabId: 23 },
        { id: "chatscribe-test" },
        resolve,
      ) === true);
      if (matching.length !== 1) reject(new Error("Expected one ensure handler."));
    });

    expect(response).toEqual({ success: true });
    expect(injected).toEqual(["bridge.js", "content.js"]);
    expect(fakeChrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(fakeChrome.tabs.sendMessage).toHaveBeenCalledWith(23, {
      type: CONTENT_PING_TYPE,
    });
    expect(CONTENT_LOAD_TYPE).not.toBe("LOAD_CONVERSATION");

    const secondResponse = await new Promise<unknown>((resolve) => {
      for (const listener of listeners) listener(
        { type: "ENSURE_CONTENT_SCRIPT", tabId: 23 },
        { id: "chatscribe-test" },
        resolve,
      );
    });
    expect(secondResponse).toEqual({ success: true });
    expect(injected).toEqual(["bridge.js", "content.js", "bridge.js"]);

    fakeChrome.tabs.sendMessage.mockImplementation(async () => ({
      ready: true,
      buildId: "wrong-build",
    }));
    const wrongBuildResponse = await new Promise<unknown>((resolve) => {
      for (const listener of listeners) listener(
        { type: "ENSURE_CONTENT_SCRIPT", tabId: 23 },
        { id: "chatscribe-test" },
        resolve,
      );
    });
    expect(wrongBuildResponse).toMatchObject({ success: false });
    expect(injected.slice(-2)).toEqual(["bridge.js", "content.js"]);
  });

  it("registers only one current-build content listener after reinjection", async () => {
    vi.resetModules();
    const chromeListeners = new Set<MessageListener>();
    const windowListeners = new Set<unknown>();
    const storageListeners = new Set<unknown>();
    const fakeWindow = {
      addEventListener: (_type: string, listener: unknown) => windowListeners.add(listener),
      removeEventListener: (_type: string, listener: unknown) => windowListeners.delete(listener),
      clearTimeout: vi.fn(),
    };
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("chrome", {
      runtime: {
        onMessage: {
          addListener: (listener: MessageListener) => chromeListeners.add(listener),
          removeListener: (listener: MessageListener) => chromeListeners.delete(listener),
        },
      },
      storage: {
        sync: { get: vi.fn(async () => ({ theme: "system" })) },
        onChanged: {
          addListener: (listener: unknown) => storageListeners.add(listener),
          removeListener: (listener: unknown) => storageListeners.delete(listener),
        },
      },
    });

    await import("../src/content.ts");
    vi.resetModules();
    await import("../src/content.ts");

    expect(windowListeners.size).toBe(1);
    expect(chromeListeners.size).toBe(1);
    expect(storageListeners.size).toBe(1);
    const currentListener = [...chromeListeners][0];
    let currentPingResponse: unknown;
    currentListener({ type: CONTENT_PING_TYPE }, { id: "chatscribe-test" },
      (value) => { currentPingResponse = value; });
    expect(currentPingResponse).toEqual({
      ready: true,
      buildId: CHATSCRIBE_BUILD_ID,
    });
    let legacyPingResponded = false;
    currentListener({ type: "CHATSCRIBE_PING" }, { id: "chatscribe-test" },
      () => { legacyPingResponded = true; });
    expect(legacyPingResponded).toBe(false);
    currentListener({ type: "LOAD_CONVERSATION" }, { id: "chatscribe-test" },
      () => { legacyPingResponded = true; });
    expect(legacyPingResponded).toBe(false);
  });
});
