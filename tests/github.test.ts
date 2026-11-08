import { afterEach, describe, expect, it, vi } from "vitest";
import { saveFileToRepo } from "../src/github.ts";
import { MAX_GITHUB_CONTENT_BASE64_LENGTH } from "../src/export-limits.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function installToken(): void {
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async () => ({ githubAccessToken: "test-token" })),
        set: vi.fn(),
        remove: vi.fn(),
      },
    },
  });
}

function getDecodedFilePath(input: RequestInfo | URL): string {
  const pathname = new URL(String(input)).pathname;
  return decodeURIComponent(pathname.slice(pathname.indexOf("/contents/") + "/contents/".length));
}

describe("GitHub create-only export saving", () => {
  it("automatically chooses a new filename after an existing and concurrently-created path", async () => {
    installToken();
    const existing = new Set(["exports/report.md"]);
    const putPaths: string[] = [];
    const putBodies: Array<Record<string, unknown>> = [];
    let raced = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = getDecodedFilePath(input);
      if (init?.method === "PUT") {
        putPaths.push(path);
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        putBodies.push(body);
        if (path === "exports/report-2.md" && !raced) {
          raced = true;
          existing.add(path);
          return new Response(JSON.stringify({ message: "already exists" }), { status: 409 });
        }
        if (existing.has(path)) {
          return new Response(JSON.stringify({ message: "already exists" }), { status: 409 });
        }
        existing.add(path);
        return new Response(JSON.stringify({
          content: {
            path,
            html_url: `https://github.com/example/repo/blob/main/${path}`,
          },
        }), { status: 201 });
      }
      return existing.has(path)
        ? new Response(JSON.stringify({ sha: "existing-sha" }), { status: 200 })
        : new Response("Not Found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await saveFileToRepo("example/repo", "report.md", "hello");

    expect(putPaths).toEqual(["exports/report-2.md", "exports/report-3.md"]);
    expect(putBodies.every((body) => !("sha" in body))).toBe(true);
    expect(result.filename).toBe("report-3.md");
    expect(result.path).toBe("exports/report-3.md");
    expect(result.htmlUrl).toContain("report-3.md");
  });

  it("fails on the content-size cap before any GitHub request", async () => {
    installToken();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(saveFileToRepo(
      "example/repo",
      "large.zip",
      "A".repeat(MAX_GITHUB_CONTENT_BASE64_LENGTH + 1),
      true,
    )).rejects.toThrow("GITHUB_PAYLOAD_TOO_LARGE");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
