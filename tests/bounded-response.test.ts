import { describe, expect, it } from "vitest";
import { assertNoRedirect, readResponseBytesLimited } from "../src/bounded-response.ts";

describe("bounded response reads", () => {
  it("enforces byte limits while reading chunked UTF-8 responses", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("我"));
        controller.enqueue(new TextEncoder().encode("好"));
        controller.close();
      },
    }));

    await expect(readResponseBytesLimited(response, 5, "too large"))
      .rejects.toThrow("too large");
  });

  it("keeps the size error when cancelling an oversized stream also fails", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(11));
      },
      cancel() {
        return Promise.reject(new Error("cancel failed"));
      },
    }));

    await expect(readResponseBytesLimited(response, 10, "too large"))
      .rejects.toThrow("too large");
  });

  it("rejects an oversized declared body before consuming it", async () => {
    const response = new Response("small", {
      headers: { "content-length": "100" },
    });

    await expect(readResponseBytesLimited(response, 10, "too large"))
      .rejects.toThrow("too large");
  });

  it("reads a body within the byte limit", async () => {
    const response = new Response("safe");
    const bytes = await readResponseBytesLimited(response, 4, "too large");

    expect(new TextDecoder().decode(bytes)).toBe("safe");
  });

  it("rejects redirects and cross-origin final response URLs", () => {
    expect(() => assertNoRedirect({
      redirected: true,
      url: "https://claude.ai/api/image/1",
    } as Response, "https://claude.ai", "redirect rejected"))
      .toThrow("redirect rejected");

    expect(() => assertNoRedirect({
      redirected: false,
      url: "https://cdn.example.test/image.png",
    } as Response, "https://claude.ai", "redirect rejected"))
      .toThrow("redirect rejected");
  });
});
