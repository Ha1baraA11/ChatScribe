import { isRenderedConversationScrollerReady } from "./generated-image-recovery.ts";

export interface ConversationScrollerSelection {
  scroller: HTMLElement | null;
  source: "thread-scroll-container" | "visible-turn-ancestor" | "document" | null;
  threadScrollerCount: number;
  visibleThreadScrollerCount: number;
  readyThreadScrollerCount: number;
  rejectedForeignThreadScrollerCount: number;
  visibleTurnCount: number;
  activeVisibleTurnCount: number;
  activeMessageMatches: number;
}

const MESSAGE_ID_ATTRIBUTES = [
  "data-turn-key",
  "data-dil-message-id",
  "data-message-id",
  "data-chatgpt-search-message-ids",
] as const;
const MESSAGE_ID_SELECTOR = MESSAGE_ID_ATTRIBUTES.map((attribute) =>
  "[" + attribute + "]"
).join(", ");
const EXPLICIT_MESSAGE_ID_ATTRIBUTES = [
  "data-dil-message-id",
  "data-message-id",
  "data-chatgpt-search-message-ids",
] as const;
const EXPLICIT_MESSAGE_ID_SELECTOR = EXPLICIT_MESSAGE_ID_ATTRIBUTES.map((attribute) =>
  "[" + attribute + "]"
).join(", ");

function hasVisibleLayout(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) {
    return false;
  }
  const style = element.ownerDocument?.defaultView?.getComputedStyle(element);
  if (
    style?.visibility === "hidden" || style?.visibility === "collapse" ||
    style?.getPropertyValue("content-visibility") === "hidden"
  ) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function activeMessageMatches(
  element: HTMLElement,
  activeMessageIds: ReadonlySet<string>,
): number {
  if (activeMessageIds.size === 0) return 0;
  let matches = 0;
  for (const node of [
    element,
    ...element.querySelectorAll<HTMLElement>(MESSAGE_ID_SELECTOR),
  ]) {
    if (MESSAGE_ID_ATTRIBUTES.some((attribute) =>
      node.getAttribute(attribute)?.split(/[\s,]+/).some((id) => activeMessageIds.has(id))
    )) {
      matches++;
    }
  }
  return matches;
}

function hasForeignExplicitMessageIds(
  element: HTMLElement,
  conversationMessageIds: ReadonlySet<string>,
): boolean {
  let hasExplicitId = false;
  for (const node of [
    element,
    ...element.querySelectorAll<HTMLElement>(EXPLICIT_MESSAGE_ID_SELECTOR),
  ]) {
    for (const attribute of EXPLICIT_MESSAGE_ID_ATTRIBUTES) {
      const value = node.getAttribute(attribute);
      if (!value) continue;
      hasExplicitId = true;
      if (value.split(/[\s,]+/).some((id) => conversationMessageIds.has(id))) {
        return false;
      }
    }
  }
  // A turn key can be a UI-only identifier. Reject a scroller only when its
  // explicit message IDs prove it belongs to a different conversation.
  return hasExplicitId;
}

function isReadyScroller(element: HTMLElement): boolean {
  return hasVisibleLayout(element) && isRenderedConversationScrollerReady(
    element.scrollHeight,
    element.clientHeight,
    element.querySelectorAll("[data-turn-key]").length,
  );
}

function findScrollableAncestor(
  document: Document,
  turn: HTMLElement,
): HTMLElement | null {
  for (
    let ancestor = turn.parentElement;
    ancestor && ancestor !== document.documentElement;
    ancestor = ancestor.parentElement
  ) {
    if (!isReadyScroller(ancestor)) continue;
    const overflowY = document.defaultView?.getComputedStyle(ancestor).overflowY;
    if (
      overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay" ||
      (overflowY === "hidden" && ancestor.scrollHeight > ancestor.clientHeight + 1)
    ) {
      return ancestor;
    }
  }
  return null;
}

/** Ignore stale hidden scrollers left behind during ChatGPT route changes. */
export function findConversationScroller(
  document: Document,
  activeMessageIds: ReadonlySet<string>,
  conversationMessageIds: ReadonlySet<string>,
): ConversationScrollerSelection {
  const threadScrollers = Array.from(document.querySelectorAll<HTMLElement>(
    ".thread-scroll-container",
  ));
  const visibleThreadScrollers = threadScrollers.filter(hasVisibleLayout);
  const readyThreadScrollers = visibleThreadScrollers.filter(isReadyScroller);
  const currentThreadScrollers = readyThreadScrollers.filter((scroller) =>
    !hasForeignExplicitMessageIds(scroller, conversationMessageIds)
  );
  const visibleTurns = Array.from(document.querySelectorAll<HTMLElement>(
    "[data-turn-key]",
  )).filter(hasVisibleLayout);
  const activeTurns = visibleTurns.filter((turn) =>
    activeMessageMatches(turn, activeMessageIds) > 0
  );

  const result = (
    scroller: HTMLElement | null,
    source: ConversationScrollerSelection["source"],
  ): ConversationScrollerSelection => ({
    scroller,
    source,
    threadScrollerCount: threadScrollers.length,
    visibleThreadScrollerCount: visibleThreadScrollers.length,
    readyThreadScrollerCount: readyThreadScrollers.length,
    rejectedForeignThreadScrollerCount:
      readyThreadScrollers.length - currentThreadScrollers.length,
    visibleTurnCount: visibleTurns.length,
    activeVisibleTurnCount: activeTurns.length,
    activeMessageMatches: scroller
      ? activeMessageMatches(scroller, activeMessageIds)
      : 0,
  });

  // Prefer the current conversation when an outgoing route remains laid out.
  const activeScroller = currentThreadScrollers
    .map((scroller) => ({ scroller, matches: activeMessageMatches(scroller, activeMessageIds) }))
    .filter(({ matches }) => matches > 0)
    .sort((left, right) => right.matches - left.matches)[0]?.scroller;
  if (activeScroller) return result(activeScroller, "thread-scroll-container");

  for (const turn of [...activeTurns].reverse()) {
    const ancestor = findScrollableAncestor(document, turn);
    if (ancestor && !hasForeignExplicitMessageIds(ancestor, conversationMessageIds)) {
      return result(ancestor, "visible-turn-ancestor");
    }
  }

  // A rendered turn may not expose an API ID. Prefer the newest usable class
  // scroller in that case, then locate a scrollable parent from the turn.
  const readyClassScroller = currentThreadScrollers.at(-1);
  if (readyClassScroller) return result(readyClassScroller, "thread-scroll-container");

  for (const turn of [...visibleTurns].reverse()) {
    const ancestor = findScrollableAncestor(document, turn);
    if (ancestor && !hasForeignExplicitMessageIds(ancestor, conversationMessageIds)) {
      return result(ancestor, "visible-turn-ancestor");
    }
  }

  const pageScroller = document.scrollingElement as HTMLElement | null;
  const turn = activeTurns.at(-1) ?? visibleTurns.at(-1);
  if (
    pageScroller && turn && pageScroller.contains(turn) &&
    isReadyScroller(pageScroller) &&
    !hasForeignExplicitMessageIds(pageScroller, conversationMessageIds) &&
    pageScroller.scrollHeight > pageScroller.clientHeight + 1
  ) {
    return result(pageScroller, "document");
  }

  return result(null, null);
}
