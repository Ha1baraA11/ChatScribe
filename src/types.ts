/**
 * types.ts — ChatScribe
 *
 * Shared type definitions used across content.ts, popup.ts, etc.
 */

// -----------------------------------------------------------------------
// EXPORT TYPES
// -----------------------------------------------------------------------

/** A single message ready for export. */
export interface ExportMessage {
  id: string;
  role: "user" | "assistant";
  /** Markdown text content. */
  content: string;
  /** Dark page background used to preserve contrast when exporting SVG diagrams. */
  svgBackgroundColor?: string;
  /** Markdown-only content with temporary ChatGPT image links rewritten to bundled paths. */
  imageMarkdownContent?: string;
  /** Rendered page images without filenames, kept for sandbox-link matching. */
  renderedImageFallbackPaths?: string[];
  /** Resource filenames mapped to their bundled relative image paths. */
  imagePathsByFilename?: Record<string, string>;
  /** Sequential position (0-based). */
  index: number;
  /** Paths to bundled image files (relative, e.g. "images/image-001.png"). */
  imagePaths: string[];
  /** Image paths corresponding to SVG diagrams already rendered by ChatGPT. */
  renderedDiagramPaths?: string[];
  /** Unix timestamp in seconds, if available. */
  timestamp?: number;
}

/** A downloaded image file for bundling. */
export interface ExportImageFile {
  /** Relative path used in Markdown links, e.g. "images/image-001.png". */
  path: string;
  mimeType: string;
  /** Base-64 encoded file bytes. */
  base64: string;
  sizeBytes: number;
}

/** The full result of loading a conversation. */
export interface ConversationData {
  messages: ExportMessage[];
  images: ExportImageFile[];
}

// -----------------------------------------------------------------------
// CHATGPT INTERNAL API TYPES
// -----------------------------------------------------------------------

export interface ApiAuthor {
  role?: string;
}

export interface ApiContentPart {
  content_type?: string;
  /** File-service or sediment pointer for uploaded images. */
  asset_pointer?: string;
  /** Direct image URL (various shapes). */
  image_url?: string | { url?: string };
  url?: string;
}

export interface ApiMessageMetadata {
  is_visually_hidden_from_conversation?: boolean;
  parent_id?: string | null;
  parent_message_id?: string | null;
  [key: string]: unknown;
}

export interface ApiMessage {
  id?: string;
  parent?: string | null;
  parent_message_id?: string | null;
  parent_id?: string | null;
  children?: string[];
  author?: ApiAuthor;
  create_time?: number | null;
  end_turn?: boolean | null;
  recipient?: string | null;
  status?: string;
  content?: {
    content_type?: string;
    parts?: unknown[];
  };
  metadata?: ApiMessageMetadata;
  /** Nested message (tree-node format). */
  message?: ApiMessage | null;
}

export interface ApiMappingNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: ApiMessage | null;
}

export interface ApiPageInfo {
  start_cursor?: string | null;
  end_cursor?: string | null;
  has_previous_page?: boolean;
  has_next_page?: boolean;
}

export interface ApiConversationPage {
  /** Linear message list format. */
  messages?: ApiMessage[];
  /** Tree mapping format (keyed by message ID). */
  mapping?: Record<string, ApiMappingNode>;
  current_node?: string | null;
  page_info?: ApiPageInfo;
}

// -----------------------------------------------------------------------
// SETTINGS
// -----------------------------------------------------------------------

export type HeadingStyle = "transcript" | "bold" | "none";
export type SeparatorStyle = "single" | "double" | "rule";
export type ThemeStyle = "system" | "light" | "dark";
export type PanelMode = "popup" | "sidebar";
export type LanguageCode =
  | "auto"
  | "en"
  | "zh"
  | "zh-TW"
  | "es"
  | "fr"
  | "de"
  | "ru"
  | "ja"
  | "ko"
  | "pt-BR";

export interface Settings {
  headingStyle: HeadingStyle;
  separatorStyle: SeparatorStyle;
  includeTimestamp: boolean;
  promptToSave: boolean;
  filenameTemplate: string;
  downloadSubfolder: string;
  downloadImages: boolean;
  includeGeneratedImages: boolean;
  keepCopyOptionsOpen: boolean;
  theme: ThemeStyle;
  panelMode: PanelMode;
  language: LanguageCode;
}

export const DEFAULT_SETTINGS: Settings = {
  headingStyle: "transcript",
  separatorStyle: "double",
  includeTimestamp: false,
  promptToSave: true,
  filenameTemplate: "{title}_{datetime}",
  downloadSubfolder: "",
  downloadImages: false,
  includeGeneratedImages: true,
  keepCopyOptionsOpen: false,
  theme: "system",
  panelMode: "popup",
  language: "auto",
};

export const SEPARATOR_MAP: Record<SeparatorStyle, string> = {
  single: "\n",
  double: "\n\n",
  rule: "\n\n---\n\n",
};

// -----------------------------------------------------------------------
// CHROME MESSAGES
// -----------------------------------------------------------------------

export type ChromeMessage =
  | {
      type: "LOAD_CONVERSATION";
      downloadImages: boolean;
      includeGeneratedImages: boolean;
      fetchImages?: boolean;
      forceRefresh?: boolean;
      selectedMessageIds?: string[];
    }
  | { type: "COPY_TO_CLIPBOARD"; text: string; tabId?: number }
  | { type: "SHOW_EXPORT_SUCCESS"; message: string }
  | { type: "EXPORT_PROGRESS"; collected: number }
  | { type: "DOWNLOAD_COMPLETE" }
  | { type: "GITHUB_START_AUTH" }
  | { type: "GITHUB_GET_STATUS" }
  | { type: "GITHUB_DISCONNECT" }
  | { type: "GITHUB_LIST_REPOS" }
  | {
      type: "GITHUB_SAVE_FILE";
      fullName: string;
      filename: string;
      content: string;
      isBinary: boolean;
    };
