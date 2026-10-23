import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../src/settings.ts";

function stubStoredSettings(stored: Record<string, unknown>): void {
  vi.stubGlobal("chrome", {
    storage: {
      sync: {
        get: vi.fn(async (defaults: Record<string, unknown> | null) =>
          defaults === null ? stored : { ...defaults, ...stored }
        ),
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("message selector order setting", () => {
  it("defaults to newest-first for installs without a saved preference", async () => {
    stubStoredSettings({});

    const settings = await loadSettings();

    expect(settings.selectorOrder).toBe("newest-first");
  });

  it("keeps a valid saved order and defaults invalid values to newest-first", async () => {
    stubStoredSettings({ selectorOrder: "oldest-first" });
    await expect(loadSettings()).resolves.toMatchObject({
      selectorOrder: "oldest-first",
    });

    stubStoredSettings({ selectorOrder: "invalid" });
    await expect(loadSettings()).resolves.toMatchObject({
      selectorOrder: "newest-first",
    });
  });
});
