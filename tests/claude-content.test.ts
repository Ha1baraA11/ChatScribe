import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHATSCRIBE_BUILD_ID,
  CONTENT_CHECK_REVISION_TYPE,
  CONTENT_LOAD_TYPE,
  CONTENT_PING_TYPE,
} from "../src/content-protocol.ts";
import { formatMarkdown } from "../src/formatter.ts";
import { DEFAULT_SETTINGS } from "../src/types.ts";

type MessageListener = (
  message: { type: string; [key: string]: unknown },
  sender: { id: string },
  respond: (response: unknown) => void,
) => boolean | void;

const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const organizationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const rootParentId = "00000000-0000-4000-8000-000000000000";

function message(
  uuid: string,
  sender: "human" | "assistant",
  parent: string,
  text: string,
): Record<string, unknown> {
  return {
    uuid,
    sender,
    parent_message_uuid: parent,
    content: [{ type: "text", text }],
  };
}

async function installClaudeContentScript(conversation: Record<string, unknown>) {
  vi.resetModules();
  const listeners: MessageListener[] = [];
  const requests: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input), "https://claude.ai");
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/organizations") {
      return new Response(JSON.stringify([{ uuid: organizationId }]), { status: 200 });
    }
    if (url.pathname.endsWith(`/chat_conversations/${conversationId}`)) {
      return new Response(JSON.stringify(conversation), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);

  const windowListeners = new Map<string, Set<EventListener>>();
  const fakeWindow = {
    location: {
      href: `https://claude.ai/chat/${conversationId}`,
      origin: "https://claude.ai",
    },
    __chatScribeClaudeCleanupByBuild: new Map<string, () => void>(),
    addEventListener: (type: string, listener: EventListener) => {
      const bucket = windowListeners.get(type) ?? new Set<EventListener>();
      bucket.add(listener);
      windowListeners.set(type, bucket);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      windowListeners.get(type)?.delete(listener);
    },
    clearTimeout: vi.fn(),
  };
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("chrome", {
    runtime: {
      id: "chatscribe-test",
      onMessage: {
        addListener: (listener: MessageListener) => listeners.push(listener),
        removeListener: (listener: MessageListener) => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      },
      sendMessage: vi.fn(async () => undefined),
    },
  });

  await import("../src/claude-content.ts");
  const listener = listeners[0];
  if (!listener) throw new Error("Claude content listener was not registered.");

  const send = (type: string, details: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    const handled = listener({ type, ...details }, { id: "chatscribe-test" }, resolve);
    if (handled !== true) reject(new Error(`Claude content did not handle ${type}.`));
  });

  return { send, requests, fetchMock, windowListeners };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("Claude content script integration", () => {
  it("loads and formats only the active branch rooted at Claude's sentinel UUID", async () => {
    const { send, requests } = await installClaudeContentScript({
      uuid: conversationId,
      current_leaf_message_uuid: "a2",
      chat_messages: [
        message("u1", "human", rootParentId, "Question"),
        message("a1", "assistant", "u1", "Answer"),
        message("a1-alt", "assistant", "u1", "Inactive alternate"),
        message("u2", "human", "a1", "Follow-up"),
        message("a2", "assistant", "u2", "Final answer"),
      ],
    });

    const ping = await send(CONTENT_PING_TYPE);
    const loaded = await send(CONTENT_LOAD_TYPE);

    expect(ping).toEqual({ ready: true, buildId: CHATSCRIBE_BUILD_ID });
    expect(loaded.success).toBe(true);
    expect(loaded.data.messages.map((item: { id: string }) => item.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
    ]);
    expect(requests[1]).toContain("tree=True");
    expect(requests[1]).toContain("consistency=strong");

    const markdown = formatMarkdown(loaded.data.messages, DEFAULT_SETTINGS);
    expect(markdown.indexOf("Question")).toBeLessThan(markdown.indexOf("Answer"));
    expect(markdown.indexOf("Answer")).toBeLessThan(markdown.indexOf("Follow-up"));
    expect(markdown.indexOf("Follow-up")).toBeLessThan(markdown.indexOf("Final answer"));
    expect(markdown).not.toContain("Inactive alternate");
  });

  it("recovers a page blob only when its thumbnail key matches the selected message", async () => {
    const userMessageId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const raw = {
      uuid: conversationId,
      current_leaf_message_uuid: userMessageId,
      chat_messages: [{
        uuid: userMessageId,
        sender: "human",
        parent_message_uuid: null,
        content: [{ type: "image", id: "upload-1", mime_type: "image/png" }],
      }],
    };
    const { send, fetchMock } = await installClaudeContentScript(raw);
    const image = {
      currentSrc: "blob:https://claude.ai/preview-1",
      getAttribute: () => "blob:https://claude.ai/preview-1",
    };
    const renderedMessage = { id: `_r_bf_${userMessageId}` };
    const row = {
      querySelector: () => renderedMessage,
    };
    const thumbnail = {
      getAttribute: (name: string) => name === "data-item-key" ? `${userMessageId}:t0` : null,
      closest: () => row,
      querySelectorAll: () => [image],
    };
    vi.stubGlobal("document", {
      body: null,
      querySelectorAll: () => [thumbnail],
      querySelector: () => null,
    });
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input), "https://claude.ai");
      if (url.protocol === "blob:") {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.pathname === "/api/organizations") {
        return new Response(JSON.stringify([{ uuid: organizationId }]), { status: 200 });
      }
      return new Response(JSON.stringify(raw), { status: 200 });
    });

    const loaded = await send(CONTENT_LOAD_TYPE, {
      downloadImages: true,
      selectedMessageIds: [userMessageId],
    });

    expect(loaded.success).toBe(true);
    expect(loaded.data.messages[0].imagePaths).toEqual(["images/claude-image-001.png"]);
    expect(loaded.data.images[0].base64).toBe("AQID");
    expect(loaded.data.imageDiagnostics.messages[0].imageResourceKinds)
      .toContain("page-blob-preview");
  });

  it("downloads one image when Claude repeats the same resource in content and attachments", async () => {
    const image = { type: "image", id: "upload-1", url: "/api/images/upload-1" };
    const raw = {
      uuid: conversationId,
      current_leaf_message_uuid: "u1",
      chat_messages: [{
        ...message("u1", "human", rootParentId, [
          { type: "text", text: "What is this?" },
          image,
        ]),
        attachments: [image],
        files: [{ type: "image", id: "upload-1", url: image.url }],
      }],
    };
    const { send, fetchMock } = await installClaudeContentScript(raw);
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input), "https://claude.ai");
      if (url.pathname === "/api/organizations") {
        return new Response(JSON.stringify([{ uuid: organizationId }]), { status: 200 });
      }
      if (url.pathname === "/api/images/upload-1") {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return new Response(JSON.stringify(raw), { status: 200 });
    });

    const loaded = await send(CONTENT_LOAD_TYPE, {
      downloadImages: true,
      selectedMessageIds: ["u1"],
    });

    expect(loaded.success).toBe(true);
    expect(loaded.data.messages[0].imageCount).toBe(1);
    expect(loaded.data.messages[0].imagePaths).toEqual(["images/claude-image-001.png"]);
    expect(loaded.data.images).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input]) =>
      new URL(String(input), "https://claude.ai").pathname === "/api/images/upload-1"
    )).toHaveLength(1);
  });

  it("downloads image resources concurrently in bounded batches and keeps message paths stable", async () => {
    const messageIds = Array.from({ length: 6 }, (_, index) =>
      `${String(index + 1).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
    );
    let parent = rootParentId;
    const messages = messageIds.map((id, index) => {
      const item = message(id, index % 2 === 0 ? "human" : "assistant", parent, `Message ${index + 1}`);
      item.content = [
        { type: "text", text: `Message ${index + 1}` },
        { type: "image", id: `image-${index + 1}`, url: `/api/images/${index + 1}` },
      ];
      parent = id;
      return item;
    });
    const raw = {
      uuid: conversationId,
      current_leaf_message_uuid: messageIds.at(-1),
      chat_messages: messages,
    };
    const { send, fetchMock } = await installClaudeContentScript(raw);
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input), "https://claude.ai");
      if (url.pathname === "/api/organizations") {
        return new Response(JSON.stringify([{ uuid: organizationId }]), { status: 200 });
      }
      if (url.pathname.endsWith(`/chat_conversations/${conversationId}`)) {
        return new Response(JSON.stringify(raw), { status: 200 });
      }
      if (url.pathname.startsWith("/api/images/")) {
        activeRequests++;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeRequests--;
        return new Response(new Uint8Array([Number(url.pathname.split("/").at(-1))]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    const loaded = await send(CONTENT_LOAD_TYPE, {
      downloadImages: true,
      selectedMessageIds: messageIds,
    });

    expect(loaded.success).toBe(true);
    expect(maximumActiveRequests).toBeGreaterThan(1);
    expect(maximumActiveRequests).toBeLessThanOrEqual(4);
    expect(loaded.data.images).toHaveLength(messageIds.length);
    expect(loaded.data.messages.map((item: { imagePaths: string[] }) => item.imagePaths[0]))
      .toEqual(messageIds.map((_, index) => `images/claude-image-${String(index + 1).padStart(3, "0")}.png`));
  });

  it("returns an explicit error instead of partial data when a real parent is missing", async () => {
    const { send } = await installClaudeContentScript({
      uuid: conversationId,
      current_leaf_message_uuid: "a1",
      chat_messages: [
        message("u1", "human", rootParentId, "Question"),
        message("a1", "assistant", "missing-parent", "Answer"),
      ],
    });

    const loaded = await send(CONTENT_LOAD_TYPE);

    expect(loaded.success).toBe(false);
    expect(loaded.error).toMatch(/parent message that Claude did not return/i);
    expect(loaded.data).toBeUndefined();
  });

  it("fetches fresh Claude data after a revision check when forceRefresh is set", async () => {
    const raw = {
      uuid: conversationId,
      current_leaf_message_uuid: "a1",
      chat_messages: [
        message("u1", "human", rootParentId, "Question"),
        message("a1", "assistant", "u1", "Old answer"),
      ],
    };
    const { send, requests, fetchMock } = await installClaudeContentScript(raw);

    await send(CONTENT_CHECK_REVISION_TYPE);
    raw.chat_messages[1] = message("a1", "assistant", "u1", "New answer");
    const loaded = await send(CONTENT_LOAD_TYPE, { forceRefresh: true });

    expect(loaded.success).toBe(true);
    expect(loaded.data.messages.at(-1).content).toBe("New answer");
    expect(requests.filter((path) => path.includes(`/chat_conversations/${conversationId}`)))
      .toHaveLength(2);
    expect(requests.filter((path) => path === "/api/organizations")).toHaveLength(1);
    expect(fetchMock.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
    expect(fetchMock.mock.calls.every(([, init]) => init?.cache === "no-store")).toBe(true);
  });

  it("returns the fresh parsed conversation when a requested revision has changed", async () => {
    const raw = {
      uuid: conversationId,
      current_leaf_message_uuid: "a1",
      chat_messages: [
        message("u1", "human", rootParentId, "Question"),
        message("a1", "assistant", "u1", "Old answer"),
      ],
    };
    const { send } = await installClaudeContentScript(raw);
    const firstLoad = await send(CONTENT_LOAD_TYPE);
    const unchanged = await send(CONTENT_CHECK_REVISION_TYPE, {
      knownRevision: firstLoad.data.revision,
      returnDataIfChanged: true,
    });
    expect(unchanged.revision).toBe(firstLoad.data.revision);
    expect(unchanged.data).toBeUndefined();

    raw.chat_messages[1] = message("a1", "assistant", "u1", "New answer");

    const checked = await send(CONTENT_CHECK_REVISION_TYPE, {
      knownRevision: firstLoad.data.revision,
      returnDataIfChanged: true,
    });

    expect(checked.success).toBe(true);
    expect(checked.revision).not.toBe(firstLoad.data.revision);
    expect(checked.data.revision).toBe(checked.revision);
    expect(checked.data.messages.at(-1).content).toBe("New answer");
  });

  it.each([401, 403, 404])(
  "rediscovers the organization once when the cached organization returns %i",
  async (cachedStatus) => {
    const replacementOrganizationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const raw = {
      uuid: conversationId,
      current_leaf_message_uuid: "a1",
      chat_messages: [
        message("u1", "human", rootParentId, "Question"),
        message("a1", "assistant", "u1", "Answer"),
      ],
    };
    const { send, fetchMock, requests } = await installClaudeContentScript(raw);
    await send(CONTENT_LOAD_TYPE);

    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input), "https://claude.ai");
      requests.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/api/organizations") {
        return new Response(JSON.stringify([{ uuid: replacementOrganizationId }]), { status: 200 });
      }
      if (url.pathname.includes(`/${organizationId}/chat_conversations/`)) {
        return new Response("Organization is no longer available", { status: cachedStatus });
      }
      if (url.pathname.includes(`/${replacementOrganizationId}/chat_conversations/`)) {
        return new Response(JSON.stringify(raw), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const refreshed = await send(CONTENT_CHECK_REVISION_TYPE);
    const checkedAgain = await send(CONTENT_CHECK_REVISION_TYPE);

    expect(refreshed.success).toBe(true);
    expect(checkedAgain.success).toBe(true);
    expect(requests.filter((path) => path === "/api/organizations")).toHaveLength(2);
    expect(requests.filter((path) => path.includes(`/${replacementOrganizationId}/chat_conversations/`)))
      .toHaveLength(2);
    },
  );

  it("clears the organization lookup when the page is unloaded", async () => {
    const raw = {
      uuid: conversationId,
      current_leaf_message_uuid: "a1",
      chat_messages: [
        message("u1", "human", rootParentId, "Question"),
        message("a1", "assistant", "u1", "Answer"),
      ],
    };
    const { send, requests, windowListeners } = await installClaudeContentScript(raw);
    await send(CONTENT_LOAD_TYPE);
    const pageHide = [...(windowListeners.get("pagehide") ?? [])][0];
    if (!pageHide) throw new Error("Claude content did not register a pagehide handler.");
    pageHide(new Event("pagehide"));

    await send(CONTENT_CHECK_REVISION_TYPE);

    expect(requests.filter((path) => path === "/api/organizations")).toHaveLength(2);
  });
});
