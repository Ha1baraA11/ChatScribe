import { describe, expect, it } from "vitest";
import { findConversationScroller } from "../src/conversation-scroller.ts";

class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  isConnected = true;
  scrollHeight = 0;
  clientHeight = 0;
  width = 0;
  height = 0;
  overflowY = "visible";
  visibility = "visible";
  contentVisibility = "visible";
  hidden = false;
  ownerDocument?: Document;
  classes = new Set<string>();
  attributes = new Map<string, string>();

  append(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  getBoundingClientRect(): DOMRect {
    return { width: this.width, height: this.height } as DOMRect;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  closest(): FakeElement | null {
    for (let node: FakeElement | null = this; node; node = node.parentElement) {
      if (node.hidden) return node;
    }
    return null;
  }

  contains(other: FakeElement): boolean {
    for (let node: FakeElement | null = other; node; node = node.parentElement) {
      if (node === this) return true;
    }
    return false;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const attributes = [...selector.matchAll(/\[([a-z-]+)\]/g)]
      .map((match) => match[1]);
    const matches = (node: FakeElement) => selector === ".thread-scroll-container"
      ? node.classes.has("thread-scroll-container")
      : attributes.some((attribute) => node.attributes.has(attribute));
    const found: FakeElement[] = [];
    const visit = (parent: FakeElement) => {
      for (const child of parent.children) {
        if (matches(child)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

function page(root: FakeElement): Document {
  const document = {
    documentElement: root,
    scrollingElement: root,
    defaultView: {
      getComputedStyle: (element: FakeElement) => ({
        overflowY: element.overflowY,
        visibility: element.visibility,
        getPropertyValue: (name: string) => name === "content-visibility"
          ? element.contentVisibility
          : "",
      }),
    },
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
  } as unknown as Document;
  const assignDocument = (element: FakeElement) => {
    element.ownerDocument = document;
    element.children.forEach(assignDocument);
  };
  assignDocument(root);
  return document;
}

function scroller(withClass = true): FakeElement {
  const element = new FakeElement();
  if (withClass) element.classes.add("thread-scroll-container");
  element.width = 900;
  element.height = 700;
  element.clientHeight = 700;
  element.scrollHeight = 2_000;
  element.overflowY = "auto";
  return element;
}

function turn(id: string): FakeElement {
  const element = new FakeElement();
  element.width = 800;
  element.height = 350;
  element.attributes.set("data-turn-key", id);
  return element;
}

describe("conversation scroller on a newly opened ChatGPT route", () => {
  it("skips the zero-size scroller from the previous route", () => {
    const root = new FakeElement();
    const stale = root.append(scroller());
    stale.width = 0;
    stale.height = 0;
    stale.clientHeight = 0;
    stale.scrollHeight = 0;
    stale.append(turn("old-message"));
    const current = root.append(scroller());
    current.append(turn("current-message"));

    const selected = findConversationScroller(
      page(root), new Set(["current-message"]), new Set(["current-message"]),
    );
    expect(selected.scroller).toBe(current);
    expect(selected.source).toBe("thread-scroll-container");
    expect(selected.threadScrollerCount).toBe(2);
    expect(selected.readyThreadScrollerCount).toBe(1);
    expect(selected.activeMessageMatches).toBe(1);
  });

  it("finds the active turn's scrollable ancestor when its class scroller is absent", () => {
    const root = new FakeElement();
    const old = root.append(scroller());
    old.append(turn("old-message"));
    const current = root.append(scroller(false));
    current.append(turn("current-message"));

    const selected = findConversationScroller(
      page(root), new Set(["current-message"]), new Set(["current-message"]),
    );
    expect(selected.scroller).toBe(current);
    expect(selected.source).toBe("visible-turn-ancestor");
    expect(selected.activeVisibleTurnCount).toBe(1);
  });

  it("waits when no visible conversation scroller is laid out yet", () => {
    const root = new FakeElement();
    const pending = root.append(scroller());
    pending.width = 0;
    pending.height = 0;
    pending.clientHeight = 0;
    pending.scrollHeight = 0;
    pending.append(turn("current-message"));

    const selected = findConversationScroller(
      page(root), new Set(["current-message"]), new Set(["current-message"]),
    );
    expect(selected.scroller).toBeNull();
    expect(selected.threadScrollerCount).toBe(1);
    expect(selected.readyThreadScrollerCount).toBe(0);
  });

  it("ignores a CSS-hidden scroller even when it retains layout dimensions", () => {
    const root = new FakeElement();
    const stale = root.append(scroller());
    stale.visibility = "hidden";
    stale.append(turn("old-message"));
    const current = root.append(scroller());
    current.append(turn("current-message"));

    const selected = findConversationScroller(
      page(root), new Set(["current-message"]), new Set(["current-message"]),
    );
    expect(selected.scroller).toBe(current);
    expect(selected.visibleThreadScrollerCount).toBe(1);
  });

  it("does not scan a still-visible container from another conversation", () => {
    const root = new FakeElement();
    const stale = root.append(scroller());
    const oldTurn = stale.append(turn("old-turn-key"));
    oldTurn.attributes.set("data-message-id", "old-message");

    const selected = findConversationScroller(
      page(root), new Set(["current-message"]), new Set(["current-message"]),
    );
    expect(selected.scroller).toBeNull();
    expect(selected.readyThreadScrollerCount).toBe(1);
    expect(selected.rejectedForeignThreadScrollerCount).toBe(1);
  });

  it("uses API message IDs from the current conversation when its active branch is incomplete", () => {
    const root = new FakeElement();
    const current = root.append(scroller());
    const currentTurn = current.append(turn("virtual-turn-key"));
    currentTurn.attributes.set("data-message-id", "tool-message");

    const selected = findConversationScroller(
      page(root), new Set(["active-user"]),
      new Set(["active-user", "tool-message"]),
    );
    expect(selected.scroller).toBe(current);
    expect(selected.rejectedForeignThreadScrollerCount).toBe(0);
  });

  it("still accepts a current scroller whose turn key is only a UI identifier", () => {
    const root = new FakeElement();
    const current = root.append(scroller());
    current.append(turn("virtual-turn-key"));

    const selected = findConversationScroller(
      page(root), new Set(["active-user"]), new Set(["active-user"]),
    );
    expect(selected.scroller).toBe(current);
    expect(selected.rejectedForeignThreadScrollerCount).toBe(0);
  });

  it("accepts a transition container once a current message appears alongside old IDs", () => {
    const root = new FakeElement();
    const current = root.append(scroller());
    current.append(turn("old-turn")).attributes.set("data-message-id", "old-message");
    current.append(turn("new-turn")).attributes.set("data-message-id", "current-message");

    const selected = findConversationScroller(
      page(root), new Set(["current-message"]), new Set(["current-message"]),
    );
    expect(selected.scroller).toBe(current);
    expect(selected.rejectedForeignThreadScrollerCount).toBe(0);
  });
});
