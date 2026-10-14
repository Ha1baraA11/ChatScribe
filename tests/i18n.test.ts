import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, initI18n, setLocaleFromBrowser } from "../src/i18n.ts";

function stubBrowser(
  chromeLanguage: string,
  browserLanguages: string[],
  savedLanguage = "auto",
): void {
  vi.stubGlobal("chrome", {
    i18n: { getUILanguage: () => chromeLanguage },
    storage: {
      sync: {
        get: vi.fn().mockResolvedValue({ language: savedLanguage }),
      },
    },
  });
  vi.stubGlobal("navigator", {
    language: browserLanguages[0] ?? "",
    languages: browserLanguages,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser language selection", () => {
  it.each([
    ["zh-Hant-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-CN", "zh"],
    ["ja-JP", "ja"],
    ["ko-KR", "ko"],
    ["pt-BR", "pt-BR"],
    ["pt", "pt-BR"],
    ["de-DE", "de"],
  ])("maps %s to the supported %s locale", async (browserTag, expected) => {
    stubBrowser(browserTag, [browserTag]);

    await initI18n();

    expect(getLocale()).toBe(expected);
  });

  it("checks the browser language preferences when the UI language is unsupported", async () => {
    stubBrowser("ar-SA", ["ja-JP", "en-US"]);

    await initI18n();

    expect(getLocale()).toBe("ja");
  });

  it("falls back to English when no browser language is supported", async () => {
    stubBrowser("pt-PT", ["pt-PT"]);

    await initI18n();

    expect(getLocale()).toBe("en");
  });

  it("uses a saved locale instead of the browser language", async () => {
    stubBrowser("en-US", ["en-US"], "zh-TW");

    await initI18n();

    expect(getLocale()).toBe("zh-TW");
  });

  it("switches back to browser detection when auto is selected", async () => {
    stubBrowser("ko-KR", ["ko-KR"], "ja");
    await initI18n();

    setLocaleFromBrowser();

    expect(getLocale()).toBe("ko");
  });
});
