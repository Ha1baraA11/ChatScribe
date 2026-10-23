import type { SelectorOrder } from "./types.ts";

export type SelectorScrollPosition = "top" | "bottom";

export function getInitialSelectorScrollPosition(
  order: SelectorOrder,
): SelectorScrollPosition {
  return order === "newest-first" ? "bottom" : "top";
}
