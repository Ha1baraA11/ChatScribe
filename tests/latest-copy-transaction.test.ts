import { describe, expect, it, vi } from "vitest";
import { runLatestCopyTransaction } from "../src/latest-copy-transaction.ts";

interface Data {
  revision: string;
  answer: string;
}

function options(overrides: Partial<Parameters<typeof runLatestCopyTransaction<Data, string>>[0]> = {}) {
  const events: string[] = [];
  const base: Parameters<typeof runLatestCopyTransaction<Data, string>>[0] = {
    initialData: { revision: "r1", answer: "cached answer" },
    getRevision: (data) => data.revision,
    prepare: vi.fn(async (data) => {
      events.push(`prepare:${data.answer}`);
      return data.answer;
    }),
    check: vi.fn(async (revision) => {
      events.push(`check:${revision}`);
      return { success: true, revision };
    }),
    ensureCurrent: vi.fn(async () => { events.push("current"); }),
    write: vi.fn(async (answer) => { events.push(`write:${answer}`); }),
    onPhase: vi.fn((phase) => { events.push(`phase:${phase}`); }),
  };
  return { events, config: { ...base, ...overrides } };
}

describe("latest answer copy transaction", () => {
  it("prepares cached content, checks once, then writes only after validation", async () => {
    const { events, config } = options();

    await runLatestCopyTransaction(config);

    expect(config.check).toHaveBeenCalledTimes(1);
    expect(config.write).toHaveBeenCalledWith("cached answer");
    expect(events.indexOf("prepare:cached answer")).toBeLessThan(events.indexOf("check:r1"));
    expect(events.indexOf("check:r1")).toBeLessThan(events.indexOf("write:cached answer"));
    expect(events.filter((event) => event.startsWith("phase:"))).toEqual([
      "phase:preparing",
      "phase:checking",
      "phase:writing",
    ]);
  });

  it("uses the conversation returned by the stale revision check and checks it once more", async () => {
    const { events, config } = options({
      check: vi.fn(async (revision) => {
        events.push(`check:${revision}`);
        return revision === "r1"
          ? {
              success: true,
              revision: "r2",
              data: { revision: "r2", answer: "new answer" },
            }
          : { success: true, revision };
      }),
    });

    await runLatestCopyTransaction(config);

    expect(config.check).toHaveBeenCalledTimes(2);
    expect(events.indexOf("prepare:new answer")).toBeLessThan(events.indexOf("check:r2"));
    expect(config.write).toHaveBeenCalledWith("new answer");
  });

  it("revalidates refreshed data even if its revision matches the original snapshot", async () => {
    let checkCount = 0;
    const { events, config } = options({
      check: vi.fn(async (revision) => {
        events.push(`check:${revision}`);
        checkCount++;
        return checkCount === 1
          ? {
              success: true,
              revision: "r1",
              changed: true,
              data: { revision: "r1", answer: "refreshed answer" },
            }
          : { success: true, revision };
      }),
    });

    await runLatestCopyTransaction(config);

    expect(config.check).toHaveBeenCalledTimes(2);
    expect(config.write).toHaveBeenCalledWith("refreshed answer");
  });

  it("does not write when the conversation changes again during the retry", async () => {
    const { config } = options({
      check: vi.fn(async (revision) => revision === "r1"
        ? { success: true, revision: "r2", data: { revision: "r2", answer: "new answer" } }
        : { success: true, revision: "r3", data: { revision: "r3", answer: "newer answer" } }),
    });

    await expect(runLatestCopyTransaction(config)).rejects.toThrow(/changed again/i);
    expect(config.write).not.toHaveBeenCalled();
  });

  it("fails closed if a changed revision has no matching conversation data", async () => {
    const { config } = options({
      check: vi.fn(async () => ({
        success: true,
        revision: "r2",
        data: { revision: "r1", answer: "stale answer" },
      })),
    });

    await expect(runLatestCopyTransaction(config)).rejects.toThrow(/changed/i);
    expect(config.write).not.toHaveBeenCalled();
  });

  it("does not write when the tab or conversation context changes", async () => {
    const { config } = options({
      ensureCurrent: vi.fn(async () => { throw new Error("The conversation changed."); }),
    });

    await expect(runLatestCopyTransaction(config)).rejects.toThrow(/conversation changed/i);
    expect(config.check).not.toHaveBeenCalled();
    expect(config.write).not.toHaveBeenCalled();
  });

  it("propagates clipboard failures instead of reporting success", async () => {
    const { config } = options({
      write: vi.fn(async () => { throw new Error("clipboard denied"); }),
    });

    await expect(runLatestCopyTransaction(config)).rejects.toThrow(/clipboard denied/i);
    expect(config.write).toHaveBeenCalledTimes(1);
  });
});
