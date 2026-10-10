/**
 * settings.ts — ChatScribe
 *
 * Reads and writes user settings from chrome.storage.sync.
 */

import type { Settings } from "./types.ts";
import { DEFAULT_SETTINGS } from "./types.ts";

export { DEFAULT_SETTINGS } from "./types.ts";
export type { Settings } from "./types.ts";

function isSeparatorStyle(value: unknown): value is Settings["separatorStyle"] {
  return value === "single" || value === "double" || value === "rule";
}

function isPanelMode(value: unknown): value is Settings["panelMode"] {
  return value === "popup" || value === "sidebar";
}

export async function loadSettings(): Promise<Settings> {
  const defaults = await chrome.storage.sync.get(
    DEFAULT_SETTINGS as unknown as Record<string, unknown>,
  );
  const stored = await chrome.storage.sync.get(null) as Record<string, unknown>;

  // Migrate the previous ChatScribe preference keys without discarding a
  // user's existing choices when the new controller is installed.
  return {
    ...DEFAULT_SETTINGS,
    ...defaults,
    ...stored,
    separatorStyle: isSeparatorStyle(stored.separatorStyle)
      ? stored.separatorStyle
      : isSeparatorStyle(stored.messageSeparator)
        ? stored.messageSeparator
        : defaults.separatorStyle as Settings["separatorStyle"],
    promptToSave: typeof stored.promptToSave === "boolean"
      ? stored.promptToSave
      : typeof stored.askWhereToSave === "boolean"
        ? stored.askWhereToSave
        : defaults.promptToSave as boolean,
    downloadImages: typeof stored.downloadImages === "boolean"
      ? stored.downloadImages
      : typeof stored.downloadImagesLocally === "boolean"
        ? stored.downloadImagesLocally
        : defaults.downloadImages as boolean,
    includeGeneratedImages: typeof stored.includeGeneratedImages === "boolean"
      ? stored.includeGeneratedImages
      : defaults.includeGeneratedImages as boolean,
    panelMode: isPanelMode(stored.panelMode)
      ? stored.panelMode
      : defaults.panelMode as Settings["panelMode"],
  } as Settings;
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.sync.set(s);
}
