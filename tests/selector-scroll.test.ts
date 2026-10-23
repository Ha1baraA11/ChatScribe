import { describe, expect, it } from "vitest";
import { getInitialSelectorScrollPosition } from "../src/selector-scroll.ts";

describe("getInitialSelectorScrollPosition", () => {
  it("opens at the bottom when newest messages are selected", () => {
    expect(getInitialSelectorScrollPosition("newest-first")).toBe("bottom");
  });

  it("opens at the top when oldest messages are selected", () => {
    expect(getInitialSelectorScrollPosition("oldest-first")).toBe("top");
  });
});
