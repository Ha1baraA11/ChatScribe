/**
 * Convert boxed SVG diagrams embedded in ChatGPT message Markdown into
 * self-contained PNG assets. Unsupported or unsafe diagrams remain intact.
 */
const SVG_PATTERN = /<svg\b[\s\S]*?<\/svg>/gi;
const FENCED_CODE_PATTERN = /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\2[ \t]*(?=\n|$)/gm;
const EACH_OPEN_TOKEN = "{#each";
const EACH_CLOSE_TOKEN = "{/each}";
const IF_OPEN_TOKEN = "{#if";
const IF_CLOSE_TOKEN = "{/if}";
const IF_ELSE_TOKEN = "{:else}";

const MAX_TEMPLATE_LENGTH = 300_000;
const MAX_EXPANDED_TEMPLATE_LENGTH = 1_000_000;
const MAX_LOOP_ITEMS = 2_000;
const MAX_SVG_ELEMENTS = 10_000;
const MAX_PNG_BASE64_LENGTH = 1_500_000;
const MAX_RENDERED_DIMENSION = 4_096;
const MAX_RENDERED_PIXELS = 4_000_000;

const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "marker",
  "symbol",
  "use",
  "title",
  "desc",
  "style",
  "filter",
  "feblend",
  "fecolormatrix",
  "fecomponenttransfer",
  "fecomposite",
  "feflood",
  "fegaussianblur",
  "femerge",
  "femergenode",
  "feoffset",
  "fefunca",
  "fefuncb",
  "fefuncg",
  "fefuncr",
  "pattern",
  "textpath",
  "line",
  "circle",
  "ellipse",
  "rect",
  "polygon",
  "polyline",
  "path",
  "text",
  "tspan",
]);

const SVG_ELEMENT_NAMES: Record<string, string> = {
  feblend: "feBlend",
  fecolormatrix: "feColorMatrix",
  fecomponenttransfer: "feComponentTransfer",
  fecomposite: "feComposite",
  feflood: "feFlood",
  fegaussianblur: "feGaussianBlur",
  femerge: "feMerge",
  femergenode: "feMergeNode",
  feoffset: "feOffset",
  fefunca: "feFuncA",
  fefuncb: "feFuncB",
  fefuncg: "feFuncG",
  fefuncr: "feFuncR",
  lineargradient: "linearGradient",
  radialgradient: "radialGradient",
  clippath: "clipPath",
  textpath: "textPath",
};

const ALLOWED_ATTRIBUTES = new Set([
  "aria-label",
  "alignment-baseline",
  "color",
  "clip-path",
  "clip-rule",
  "cx",
  "cy",
  "d",
  "dx",
  "dy",
  "dominant-baseline",
  "filter",
  "flood-color",
  "flood-opacity",
  "fill",
  "fill-opacity",
  "fill-rule",
  "font-style",
  "font-family",
  "font-size",
  "font-weight",
  "gradientTransform",
  "gradientUnits",
  "href",
  "height",
  "in",
  "in2",
  "id",
  "intercept",
  "k1",
  "k2",
  "k3",
  "k4",
  "letter-spacing",
  "mask",
  "maskContentUnits",
  "maskUnits",
  "marker-end",
  "marker-mid",
  "marker-start",
  "markerHeight",
  "markerUnits",
  "markerWidth",
  "opacity",
  "offset",
  "orient",
  "operator",
  "patternContentUnits",
  "patternTransform",
  "patternUnits",
  "pointsAtX",
  "pointsAtY",
  "pointsAtZ",
  "points",
  "preserveAspectRatio",
  "refX",
  "refY",
  "r",
  "role",
  "rx",
  "ry",
  "spreadMethod",
  "stop-color",
  "stop-opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "stdDeviation",
  "result",
  "scale",
  "slope",
  "amplitude",
  "exponent",
  "divisor",
  "mode",
  "shape-rendering",
  "specularConstant",
  "specularExponent",
  "spreadMethod",
  "surfaceScale",
  "tableValues",
  "textLength",
  "text-anchor",
  "transform",
  "viewBox",
  "width",
  "x",
  "x1",
  "x2",
  "xlink:href",
  "xmlns:xlink",
  "type",
  "values",
  "y",
  "y1",
  "y2",
  "xChannelSelector",
  "yChannelSelector",
  "xmlns",
  "style",
]);

const SVG_ATTRIBUTE_CASE: Record<string, string> = {
  clippathunits: "clipPathUnits",
  gradienttransform: "gradientTransform",
  gradientunits: "gradientUnits",
  maskcontentunits: "maskContentUnits",
  maskunits: "maskUnits",
  markerheight: "markerHeight",
  markerunits: "markerUnits",
  markerwidth: "markerWidth",
  preserveaspectratio: "preserveAspectRatio",
  refx: "refX",
  refy: "refY",
  textlength: "textLength",
  viewbox: "viewBox",
};

const SAFE_STYLE_PROPERTIES = new Set([
  "alignment-baseline",
  "color",
  "clip-path",
  "clip-rule",
  "display",
  "dominant-baseline",
  "fill",
  "fill-opacity",
  "fill-rule",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "height",
  "letter-spacing",
  "max-height",
  "max-width",
  "marker-end",
  "marker-mid",
  "marker-start",
  "opacity",
  "paint-order",
  "shape-rendering",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
  "vector-effect",
  "visibility",
  "width",
  "filter",
  "flood-color",
  "flood-opacity",
]);

const LOCAL_REFERENCE_ATTRIBUTES = new Set([
  "clip-path",
  "filter",
  "fill",
  "marker-end",
  "marker-mid",
  "marker-start",
  "mask",
  "stroke",
]);

const JSX_ATTRIBUTE_NAMES: Record<string, string> = {
  dominantBaseline: "dominant-baseline",
  fillOpacity: "fill-opacity",
  fontFamily: "font-family",
  fontSize: "font-size",
  fontWeight: "font-weight",
  markerEnd: "marker-end",
  markerMid: "marker-mid",
  markerStart: "marker-start",
  preserveAspectRatio: "preserveAspectRatio",
  strokeDasharray: "stroke-dasharray",
  strokeDashoffset: "stroke-dashoffset",
  strokeLinecap: "stroke-linecap",
  strokeLinejoin: "stroke-linejoin",
  strokeMiterlimit: "stroke-miterlimit",
  strokeOpacity: "stroke-opacity",
  strokeWidth: "stroke-width",
  textAnchor: "text-anchor",
};

type TemplateValue = string | number | boolean | null | TemplateValue[] | {
  [key: string]: TemplateValue;
};

interface SvgToken {
  type: "text" | "open" | "close";
  name?: string;
  attributes?: string;
  text?: string;
  selfClosing?: boolean;
}

interface ViewBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

export type SvgDiagramMode = "assets" | "text" | "none";

export interface SvgDiagramAsset {
  path: string;
  mimeType: "image/png";
  base64: string;
  sizeBytes: number;
}

export interface SvgTemplateRenderResult {
  markdown: string;
  assets: SvgDiagramAsset[];
}

/**
 * Replace API-side SVG templates with the matching diagrams serialized from
 * ChatGPT's rendered message DOM. This preserves expressions that cannot be
 * reconstructed from the API's raw template alone.
 */
export function replaceSvgTemplatesWithRenderedImages(
  markdown: string,
  imagePaths: string[],
  mode: Exclude<SvgDiagramMode, "none">,
): string | null {
  const codeBlocks: string[] = [];
  const placeholderPrefix = `\u0000CHATSCRIBE_RENDERED_SVG_${Math.random().toString(36).slice(2)}_`;
  const maskedMarkdown = markdown.replace(FENCED_CODE_PATTERN, (block) => {
    const placeholder = `${placeholderPrefix}${codeBlocks.length}\u0000`;
    codeBlocks.push(block);
    return placeholder;
  });
  const matches = [...maskedMarkdown.matchAll(SVG_PATTERN)];

  if (matches.length === 0 || matches.length !== imagePaths.length) return null;

  let cursor = 0;
  let diagramIndex = 0;
  const output: string[] = [];
  for (const match of matches) {
    const svg = match[0];
    const start = match.index;
    if (!svg || start === undefined) continue;

    const simpleBox = findSimpleBoxWrapper(maskedMarkdown, start, start + svg.length);
    const replacementStart = simpleBox?.start ?? start;
    const replacementEnd = simpleBox?.end ?? start + svg.length;
    output.push(maskedMarkdown.slice(cursor, replacementStart));
    output.push(mode === "assets"
      ? `![Diagram](${imagePaths[diagramIndex]})`
      : "[Diagram]");
    diagramIndex++;
    cursor = replacementEnd;
  }
  output.push(maskedMarkdown.slice(cursor));

  return restoreCodeBlocks(output.join(""), placeholderPrefix, codeBlocks);
}

function getDarkSvgBackgroundColor(value?: string): string {
  if (!value) return "#ffffff";
  const match = value.match(
    /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i,
  );
  if (!match) return "#ffffff";

  const [red, green, blue] = match.slice(1).map(Number);
  if ([red, green, blue].some((channel) => channel > 255)) return "#ffffff";
  const linearize = (channel: number): number => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * linearize(red) +
    0.7152 * linearize(green) +
    0.0722 * linearize(blue);
  return luminance < 0.4 ? `rgb(${red}, ${green}, ${blue})` : "#ffffff";
}

/** Render an image/svg+xml data URI from a ChatGPT message as a safe PNG. */
export async function renderSvgDataUrlToPngBase64(
  dataUrl: string,
  backgroundColor?: string,
): Promise<string | null> {
  const svg = decodeSvgDataUrl(dataUrl);
  if (!svg || svg.length > MAX_TEMPLATE_LENGTH) return null;
  const canvasBackgroundColor = getDarkSvgBackgroundColor(backgroundColor);

  // ChatGPT's already-rendered SVGs can use safe SVG features outside the
  // exporter's sanitizer subset. Load those only as an image (never as
  // document markup), after rejecting active content and external references.
  if (isSafeSvgImageSource(svg)) {
    const imageContextPng = await renderSvgImageDataUrlToPngBase64(
      dataUrl,
      svg,
      canvasBackgroundColor,
    );
    if (imageContextPng) return imageContextPng;
  }

  const safeSvg = sanitizeStaticSvg(svg, canvasBackgroundColor);
  return safeSvg
    ? renderSvgToPngBase64(safeSvg, canvasBackgroundColor)
    : null;
}

/**
 * Turns ChatGPT's boxed, Svelte-style SVG snippets into PNG assets. Visuals
 * that cannot be reconstructed are omitted from Markdown exports.
 */
export async function renderSvgTemplatesAsMarkdown(
  markdown: string,
  mode: SvgDiagramMode,
  firstAssetIndex = 1,
  backgroundColor?: string,
): Promise<SvgTemplateRenderResult> {
  if (mode === "none") {
    return { markdown, assets: [] };
  }

  const codeBlocks: string[] = [];
  const placeholderPrefix = `\u0000CHATSCRIBE_CODE_${Math.random().toString(36).slice(2)}_`;
  const maskedMarkdown = markdown.replace(FENCED_CODE_PATTERN, (block) => {
    const placeholder = `${placeholderPrefix}${codeBlocks.length}\u0000`;
    codeBlocks.push(block);
    return placeholder;
  });

  const matches = [...maskedMarkdown.matchAll(SVG_PATTERN)];

  if (matches.length === 0) {
    return {
      markdown: restoreCodeBlocks(maskedMarkdown, placeholderPrefix, codeBlocks),
      assets: [],
    };
  }

  const output: string[] = [];
  const assets: SvgDiagramAsset[] = [];
  let cursor = 0;
  let nextAssetIndex = firstAssetIndex;

  for (const match of matches) {
    const svgTemplate = match[0];
    const start = match.index;

    if (!svgTemplate || start === undefined) {
      continue;
    }

    const simpleBox = findSimpleBoxWrapper(maskedMarkdown, start, start + svgTemplate.length);
    const replacementStart = simpleBox?.start ?? start;
    const replacementEnd = simpleBox?.end ?? start + svgTemplate.length;
    output.push(maskedMarkdown.slice(cursor, replacementStart));
    cursor = replacementEnd;

    if (mode === "text") {
      // A text placeholder is not a useful substitute for a diagram. Keep
      // the surrounding explanation and omit the visual itself.
      continue;
    }

    try {
      const canvasBackgroundColor = getDarkSvgBackgroundColor(backgroundColor);
      const staticSvg = compileStaticSvg(svgTemplate, canvasBackgroundColor);

      if (!staticSvg) {
        continue;
      }

      const base64 = await renderSvgToPngBase64(staticSvg, canvasBackgroundColor);

      if (!base64) {
        continue;
      }

      const path = `images/diagram-${String(nextAssetIndex++).padStart(3, "0")}.png`;
      assets.push({
        path,
        mimeType: "image/png",
        base64,
        sizeBytes: estimateBase64Size(base64),
      });
      output.push(`![Diagram](${path})`);
    } catch {
      // Do not leak unsupported JSX/Svelte markup or placeholder text into
      // Markdown when the visual cannot be reconstructed.
    }
  }

  output.push(maskedMarkdown.slice(cursor));

  const renderedMarkdown = output.join("").replace(/\n{3,}/g, "\n\n");

  return {
    markdown: restoreCodeBlocks(renderedMarkdown, placeholderPrefix, codeBlocks),
    assets,
  };
}

function decodeSvgDataUrl(dataUrl: string): string | null {
  if (dataUrl.length > MAX_TEMPLATE_LENGTH * 3) return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;

  const header = dataUrl.slice(0, comma);
  if (!/^data:image\/svg\+xml(?:;charset=[\w-]+)?(?:;base64)?$/i.test(header)) {
    return null;
  }

  const payload = dataUrl.slice(comma + 1);
  try {
    if (/;base64$/i.test(header)) {
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

function findSimpleBoxWrapper(
  markdown: string,
  svgStart: number,
  svgEnd: number,
): { start: number; end: number } | null {
  const openStart = markdown.lastIndexOf("<box", svgStart);
  if (openStart < 0 || markdown.lastIndexOf("</box>", svgStart) > openStart) {
    return null;
  }

  const openEnd = markdown.indexOf(">", openStart);
  if (openEnd < 0 || openEnd >= svgStart) return null;
  if (markdown.slice(openEnd + 1, svgStart).trim() !== "") return null;

  const closeStart = markdown.indexOf("</box>", svgEnd);
  if (closeStart < 0 || markdown.slice(svgEnd, closeStart).trim() !== "") {
    return null;
  }

  return { start: openStart, end: closeStart + "</box>".length };
}

const COMPONENT_WRAPPERS = new Set([
  "box",
  "grid",
  "grid-item",
  "row",
  "col",
  "text",
  "title",
  "caption",
  "radio-group",
  "list",
]);

/**
 * Convert ChatGPT's presentation-only component markup into readable
 * Markdown. Fenced code is left untouched so examples remain literal.
 */
export function normalizeChatGptComponents(markdown: string): string {
  const codeBlocks: string[] = [];
  const placeholderPrefix = `\u0000CHATSCRIBE_COMPONENT_CODE_${Math.random().toString(36).slice(2)}_`;
  const maskedMarkdown = markdown.replace(FENCED_CODE_PATTERN, (block) => {
    const placeholder = `${placeholderPrefix}${codeBlocks.length}\u0000`;
    codeBlocks.push(block);
    return placeholder;
  });

  const templateSource = { markdown: maskedMarkdown, scope: {} };
  let expanded = normalizeStaticGridTemplateLoops(
    templateSource.markdown,
    templateSource.scope,
  );
  try {
    expanded = expandEachBlocks(
      expanded,
      templateSource.scope,
      { loopCount: 0 },
      true,
      false,
    );
  } catch {
    // Preserve unsupported source markup rather than dropping user content.
  }
  expanded = normalizeStaticSemaphoreStepper(expanded, templateSource.scope);
  expanded = normalizeUnsafeMarkdownIndentation(
    stripUnresolvedTemplateExpressions(expanded),
  );

  // Some numbered grids only become plain text after their ChatGPT component
  // wrappers are removed. Normalize those sequences after both component-grid
  // conversion and tag cleanup so the row structure is still recognizable.
  const normalizedComponents = normalizeMarkdownMathDelimiters(
    normalizeComponentTags(normalizeGridBlocks(expanded)),
  );
  return restoreCodeBlocks(
    normalizeLinearizedFloatFieldTables(
      normalizeLinearizedPipelineMatrices(
        normalizeLinearizedLinkedListSequences(
          normalizeLinearizedAddressGroupDiagrams(
            normalizeLinearizedPppFrameGrid(
              normalizeLinearizedPageTableGrid(
                normalizeLinearizedTcpWindowGrid(
                  normalizeLinearizedPathCards(
                    normalizeLinearizedSortRows(
                      normalizeLinearizedQuickSortPartitions(
                        normalizeLinearizedSequenceGrids(normalizedComponents),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
    placeholderPrefix,
    codeBlocks,
  );
}

/** Use dollar delimiters supported by Obsidian and Typora for ChatGPT math. */
function normalizeMarkdownMathDelimiters(markdown: string): string {
  const codeSpans: string[] = [];
  const placeholderPrefix = `\u0000CHATSCRIBE_MATH_CODE_${Math.random().toString(36).slice(2)}_`;
  const maskedMarkdown = markdown.replace(/(`+)([\s\S]*?)\1/g, (codeSpan) => {
    const placeholder = `${placeholderPrefix}${codeSpans.length}\u0000`;
    codeSpans.push(codeSpan);
    return placeholder;
  });

  const normalized = maskedMarkdown
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_match, expression: string) =>
      `\n\n$$\n${expression.trim()}\n$$\n\n`,
    )
    .replace(/\\\(([^\n]*?)\\\)/g, (_match, expression: string) =>
      `$${expression}$`,
    )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

  return restoreCodeBlocks(normalized, placeholderPrefix, codeSpans);
}

function stripUnresolvedTemplateExpressions(markdown: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < markdown.length) {
    const eachStart = markdown.indexOf(EACH_OPEN_TOKEN, cursor);
    const ifStart = markdown.indexOf(IF_OPEN_TOKEN, cursor);
    const blockStart = [eachStart, ifStart]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? -1;

    if (blockStart < 0) {
      output += markdown.slice(cursor);
      break;
    }

    output += markdown.slice(cursor, blockStart);
    const blockType = blockStart === ifStart ? "if" : "each";
    const openEnd = findExpressionEnd(markdown, blockStart);
    const bounds = openEnd < 0
      ? null
      : findMatchingBlockBounds(markdown, openEnd + 1, blockType);

    if (bounds) {
      cursor = bounds.closeStart + (blockType === "if"
        ? IF_CLOSE_TOKEN.length
        : EACH_CLOSE_TOKEN.length);
    } else if (openEnd >= 0) {
      cursor = openEnd + 1;
    } else {
      cursor = blockStart + (blockType === "if"
        ? IF_OPEN_TOKEN.length
        : EACH_OPEN_TOKEN.length);
    }
  }

  return output
    .replace(/\{@body[\s\S]*?\}/g, "")
    .replace(/\{:else\}/g, "")
    .replace(/\{\/(?:each|if)\}/g, "")
    .replace(/^.*(?:已完成|已答对|答对)\s*\{[^{}\n]*(?:\.filter|Object\.keys)[^{}\n]*\}.*$/gm, "")
    .replace(/\{\s*(?:h|cell|opt|q\.q|q\.why|item\.q|item\.why|state\.act|state\.note|seq\[step\]\.act|seq\[step\]\.s|seq\[step\]\.note|step\s*\+\s*1|i\s*\+\s*1|j|String(?:\.fromCharCode)?\([^{}]*\)|Math\.(?:max|min)\([^{}]*\)|Object\.keys\([^{}]*\)[^{}]*|[^{}\n]*(?:items|qs)\.filter\([^{}\n]*\)[^{}\n]*|answers\[[^\]]+\][^{}]*|responses\[[^\]]+\][^{}]*|selected\[[^\]]+\][^{}]*|ans\[[^\]]+\][^{}]*)\s*\}/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function normalizeStaticSemaphoreStepper(
  markdown: string,
  scope: Record<string, TemplateValue>,
): string {
  const sequence = scope.seq;
  if (!Array.isArray(sequence) || sequence.length === 0) return markdown;

  const states = sequence.filter((state): state is Record<string, TemplateValue> =>
    typeof state === "object" && state !== null &&
    typeof (state as Record<string, TemplateValue>).s === "number" &&
    typeof (state as Record<string, TemplateValue>).act === "string" &&
    typeof (state as Record<string, TemplateValue>).note === "string");
  if (states.length !== sequence.length) return markdown;

  const title = "逐步观察信号量变化";
  const titleIndex = markdown.indexOf(title);
  if (titleIndex < 0) return markdown;
  const start = markdown.lastIndexOf("\n", titleIndex) + 1;
  const end = markdown.indexOf("这里特别注意", titleIndex);
  if (end < 0) return markdown;

  const table = [
    `| 步骤 | 操作 | S | 可用资源 | 等待进程 | 说明 |`,
    `| --- | --- | ---: | ---: | ---: | --- |`,
    ...states.map((state, index) => {
      const value = state.s as number;
      const note = String(state.note).replace(/\|/g, "\\|");
      return `| ${index + 1} | ${String(state.act)} | ${value} | ${Math.max(value, 0)} | ${Math.max(-value, 0)} | ${note} |`;
    }),
  ].join("\n");

  return `${markdown.slice(0, start)}${title}\n\n${table}\n\n${markdown.slice(end)}`;
}

function normalizeUnsafeMarkdownIndentation(markdown: string): string {
  return markdown.replace(/^( {4,})(.*)$/gm, (_line, _indent: string, content: string) => {
    if (/^(?:[-*+]\s|\d+[.)]\s|>)/.test(content)) return _line;
    return content;
  });
}

function normalizeStaticGridTemplateLoops(
  markdown: string,
  scope: Record<string, TemplateValue>,
): string {
  let output = "";
  let cursor = 0;

  while (cursor < markdown.length) {
    const headerStart = markdown.indexOf(EACH_OPEN_TOKEN, cursor);
    if (headerStart < 0) {
      output += markdown.slice(cursor);
      break;
    }

    output += markdown.slice(cursor, headerStart);
    const headerEnd = findExpressionEnd(markdown, headerStart);
    if (headerEnd < 0) {
      output += markdown.slice(headerStart);
      break;
    }

    const header = parseEachHeader(
      markdown.slice(headerStart + EACH_OPEN_TOKEN.length, headerEnd),
      scope,
    );
    const headerBounds = findMatchingBlockBounds(
      markdown,
      headerEnd + 1,
      "each",
    );
    if (!headerBounds) {
      output += markdown.slice(headerStart, headerEnd + 1);
      cursor = headerEnd + 1;
      continue;
    }

    if (!header) {
      const blockEnd = headerBounds.closeStart + EACH_CLOSE_TOKEN.length;
      output += markdown.slice(headerStart, blockEnd);
      cursor = blockEnd;
      continue;
    }

    const headerBody = markdown.slice(headerEnd + 1, headerBounds.closeStart);
    if (headerBody.trim() !== `{${header.itemName}}`) {
      output += markdown.slice(headerStart, headerBounds.closeStart + EACH_CLOSE_TOKEN.length);
      cursor = headerBounds.closeStart + EACH_CLOSE_TOKEN.length;
      continue;
    }

    const headerBlockEnd = headerBounds.closeStart + EACH_CLOSE_TOKEN.length;
    const separatorMatch = markdown.slice(headerBlockEnd).match(/^\s*/);
    const rowStart = headerBlockEnd + (separatorMatch?.[0].length ?? 0);
    if (!markdown.startsWith(EACH_OPEN_TOKEN, rowStart)) {
      output += markdown.slice(headerStart, headerBlockEnd);
      cursor = headerBlockEnd;
      continue;
    }

    const rowEnd = findExpressionEnd(markdown, rowStart);
    if (rowEnd < 0) {
      output += markdown.slice(headerStart, headerBlockEnd);
      cursor = headerBlockEnd;
      continue;
    }

    const rowLoop = parseEachHeader(
      markdown.slice(rowStart + EACH_OPEN_TOKEN.length, rowEnd),
      scope,
    );
    const rowBounds = findMatchingBlockBounds(markdown, rowEnd + 1, "each");
    if (!rowLoop || !rowBounds) {
      output += markdown.slice(headerStart, headerBlockEnd);
      cursor = headerBlockEnd;
      continue;
    }

    const rowBody = markdown.slice(rowEnd + 1, rowBounds.closeStart);
    const nestedStart = rowBody.indexOf(EACH_OPEN_TOKEN);
    const nestedEnd = nestedStart < 0
      ? -1
      : findExpressionEnd(rowBody, nestedStart);
    const nestedBounds = nestedEnd < 0
      ? null
      : findMatchingBlockBounds(rowBody, nestedEnd + 1, "each");
    if (!nestedBounds) {
      output += markdown.slice(headerStart, headerBlockEnd);
      cursor = headerBlockEnd;
      continue;
    }

    const nestedHeader = rowBody.slice(
      nestedStart + EACH_OPEN_TOKEN.length,
      nestedEnd,
    ).match(/^\s*([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)(?:\s*,\s*[A-Za-z_$][\w$]*)?\s*$/);
    const nestedBody = rowBody.slice(nestedEnd + 1, nestedBounds.closeStart);
    if (
      !nestedHeader ||
      nestedHeader[1] !== rowLoop.itemName ||
      nestedBody.trim() !== `{${nestedHeader[2]}}` ||
      rowBody.slice(0, nestedStart).trim() ||
      rowBody.slice(nestedBounds.closeStart + EACH_CLOSE_TOKEN.length).trim()
    ) {
      output += markdown.slice(headerStart, headerBlockEnd);
      cursor = headerBlockEnd;
      continue;
    }

    const headers = header.items.map(formatTemplateValue);
    const rows = rowLoop.items;
    if (
      headers.length < 2 ||
      rows.length === 0 ||
      rows.some((row) => !Array.isArray(row) || row.length !== headers.length)
    ) {
      output += markdown.slice(headerStart, headerBlockEnd);
      cursor = headerBlockEnd;
      continue;
    }

    const escapeCell = (value: TemplateValue): string =>
      formatTemplateValue(value).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
    const table = [
      `| ${headers.map((value) => value.replace(/\|/g, "\\|")).join(" | ")} |`,
      `| ${headers.map(() => "---").join(" | ")} |`,
      ...rows.map((row) => `| ${(row as TemplateValue[]).map(escapeCell).join(" | ")} |`),
    ].join("\n");
    const tableEnd = rowBounds.closeStart + EACH_CLOSE_TOKEN.length;
    output += `${table}\n`;
    cursor = tableEnd;
  }

  return output;
}

function parseEachHeader(
  source: string,
  scope: Record<string, TemplateValue>,
): { items: TemplateValue[]; itemName: string } | null {
  const header = source.match(
    /^\s*([\s\S]+)\s+as\s+([A-Za-z_$][\w$]*)(?:\s*,\s*[A-Za-z_$][\w$]*)?\s*$/,
  );
  if (!header) return null;

  try {
    return {
      items: resolveLoopItems(header[1].trim(), scope),
      itemName: header[2],
    };
  } catch {
    return null;
  }
}

/**
 * Some ChatGPT layouts arrive through the conversation API as one short text
 * value per visual grid cell. Rebuild numbered, equal-width sequence rows as
 * a Markdown table so the row and column relationships survive export.
 */
function normalizeLinearizedSequenceGrids(markdown: string): string {
  type Row = {
    start: number;
    end: number;
    nextStart: number | null;
    cells: string[];
  };

  const lines = markdown.split("\n");
  const output: string[] = [];

  function parseRow(start: number, number: number): Row | null {
    if (lines[start]?.trim() !== String(number)) return null;

    const cells: string[] = [];
    let end = start;
    for (let index = start + 1; index < lines.length; index++) {
      const value = lines[index].trim();
      if (!value) continue;

      if (value === String(number + 1) && cells.length >= 3) {
        return { start, end, nextStart: index, cells };
      }
      if (!/^[\p{L}\p{N}]{1,4}$/u.test(value)) {
        return cells.length >= 3
          ? { start, end, nextStart: null, cells }
          : null;
      }

      cells.push(value);
      end = index;
    }

    return cells.length >= 3
      ? { start, end, nextStart: null, cells }
      : null;
  }

  function isSequenceContext(start: number, end: number): boolean {
    const context = [
      ...lines.slice(Math.max(0, start - 3), start),
      ...lines.slice(end + 1, Math.min(lines.length, end + 5)),
    ].join(" ");
    return /位置|序列|排序|排列|sequence|position|ordering/i.test(context);
  }

  function getHighlightedValue(end: number, rows: Row[]): string | null {
    const note = lines
      .slice(end + 1, Math.min(lines.length, end + 5))
      .find((line) => line.trim());
    const value = note?.match(
      /(?:标出|标记|highlight(?:ed)?|mark(?:ed)?)\s*[「『“'`]?([^\s」』”'`,，。；:：]+)/i,
    )?.[1]?.replace(/[」』”'`]+$/, "");
    return value && rows.some((row) => row.cells.includes(value)) ? value : null;
  }

  for (let cursor = 0; cursor < lines.length;) {
    const first = parseRow(cursor, 1);
    if (!first) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    const rows = [first];
    let nextStart = first.nextStart;
    while (nextStart !== null) {
      const next = parseRow(nextStart, rows.length + 1);
      if (!next || next.cells.length !== first.cells.length) break;
      rows.push(next);
      nextStart = next.nextStart;
    }

    const end = rows[rows.length - 1].end;
    if (rows.length < 2 || !isSequenceContext(first.start, end)) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    const highlightedValue = getHighlightedValue(end, rows);
    const headers = [
      "序号",
      ...first.cells.map((_cell, index) => `第 ${index + 1} 项`),
    ];
    const tableRows = rows.map((row) => [
      String(rows.indexOf(row) + 1),
      ...row.cells.map((cell) =>
        cell === highlightedValue ? `**${cell}**` : cell,
      ),
    ]);
    const table = [
      `| ${headers.join(" | ")} |`,
      `| ${headers.map(() => "---").join(" | ")} |`,
      ...tableRows.map((row) => `| ${row.join(" | ")} |`),
    ].join("\n");

    output.push(table, "");
    cursor = end + 1;
  }

  return output.join("\n");
}

/**
 * ChatGPT's sorting visualizations can be serialized as one number per
 * paragraph instead of as a table. Rebuild repeated passes as a compact
 * Markdown table and keep isolated sequences on one line.
 */
function normalizeLinearizedSortRows(markdown: string): string {
  if (!/(?:排序|sort|趟|插入)/i.test(markdown)) return markdown;

  const lines = markdown.split("\n");
  const output: string[] = [];
  const isNumber = (value: string): boolean =>
    /^[+\-−]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value.trim());
  const isDivider = (value: string): boolean => /^---+$/.test(value.trim());
  const cleanLabel = (value: string): string => value
    .trim()
    .replace(/^\*\*(.*?)\*\*$/u, "$1")
    .replace(/[:：]\s*$/u, "")
    .replace(/\s+/g, " ");
  const isStageLabel = (value: string): boolean =>
    /^(?:初始(?:序列)?|第\s*\d+\s*(?:趟|轮|步)|(?:pass|round)\s*\d+|initial(?: state)?|划分前|划分后|按基准\s*.+\s*划分)$/iu.test(value);
  const isStageNote = (value: string): boolean =>
    /^(?:插入|移(?:动|到)|交换|比较|先把|已排序|有序部分|本趟|本轮|已经?确定|sorted\b|insert\b|move\b|swap\b|compare\b)/iu.test(value.trim());
  const isLegendNote = (value: string): boolean =>
    /^(?:已排序部分|本趟插入元素|有序前缀|本轮插入元素)$/u.test(value.trim());

  function parseRow(start: number): {
    start: number;
    end: number;
    label: string;
    values: string[];
  } | null {
    const label = cleanLabel(lines[start] ?? "");
    if (!isStageLabel(label)) return null;

    const values: string[] = [];
    let index = start + 1;
    while (index < lines.length) {
      const value = lines[index].trim();
      if (!value || isDivider(value)) {
        index++;
        continue;
      }
      if (!isNumber(value)) break;
      values.push(value.replace(/−/g, "-"));
      index++;
    }

    return values.length >= 2
      ? { start, end: index - 1, label, values }
      : null;
  }

  function skipSeparators(start: number): number {
    let index = start;
    while (
      index < lines.length &&
      (!lines[index].trim() || isDivider(lines[index]))
    ) index++;
    return index;
  }

  function renderRows(rows: Array<{
    label: string;
    values: string[];
    notes: string[];
  }>): string {
    return [
      "| 阶段 | 序列 | 操作说明 |",
      "| --- | --- | --- |",
      ...rows.map(({ label, values, notes }) => {
        const sequence = `\`${values.join(", ")}\``;
        const note = notes.length > 0
          ? notes.map((item) => item.replace(/\|/g, "\\|")).join("<br>")
          : "—";
        return `| ${label} | ${sequence} | ${note} |`;
      }),
    ].join("\n");
  }

  for (let cursor = 0; cursor < lines.length;) {
    const first = parseRow(cursor);
    if (!first) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    const rows = [{ ...first, notes: [] as string[] }];
    const legends: string[] = [];
    let scan = first.end + 1;
    let consumedEnd = first.end;
    while (scan < lines.length) {
      scan = skipSeparators(scan);
      const next = parseRow(scan);
      if (next) {
        if (next.values.length !== first.values.length) break;
        rows.push({ ...next, notes: [] });
        consumedEnd = next.end;
        scan = next.end + 1;
        continue;
      }

      const note = lines[scan]?.trim() ?? "";
      if (isLegendNote(note)) {
        legends.push(note);
        consumedEnd = scan;
        scan++;
        continue;
      }
      if (!note || !isStageNote(note)) break;
      rows[rows.length - 1].notes.push(note);
      consumedEnd = scan;
      scan++;
    }

    if (rows.length >= 2) {
      output.push(renderRows(rows), "");
      if (legends.length > 0) output.push(`图例：${legends.join("；")}`);
      cursor = consumedEnd + 1;
      continue;
    }

    output.push(`${first.label}：\`[${first.values.join(", ")}]\``);
    cursor = first.end + 1;
  }

  return output.join("\n");
}

/**
 * Restore the three groups in ChatGPT's text-only quick-sort partition view.
 * The labels follow each group of cells in the API transcript, so parse the
 * category labels as delimiters before the general sorting-row normalizer.
 */
function normalizeLinearizedQuickSortPartitions(markdown: string): string {
  if (!/(?:快速排序|quick\s*sort)/i.test(markdown)) return markdown;

  const lines = markdown.split("\n");
  const output: string[] = [];
  const isNumber = (value: string): boolean =>
    /^[+\-−]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value.trim());
  const isDivider = (value: string): boolean => /^---+$/.test(value.trim());
  const cleanLabel = (value: string): string => value
    .trim()
    .replace(/^\*\*(.*?)\*\*$/u, "$1")
    .replace(/[:：]\s*$/u, "")
    .replace(/\s+/g, " ");

  function readValues(start: number): { values: string[]; end: number } | null {
    const values: string[] = [];
    let index = start;
    while (index < lines.length) {
      const value = lines[index].trim();
      if (!value || isDivider(value)) {
        index++;
        continue;
      }
      if (!isNumber(value)) break;
      values.push(value.replace(/−/g, "-"));
      index++;
    }
    return values.length > 0 ? { values, end: index - 1 } : null;
  }

  for (let cursor = 0; cursor < lines.length;) {
    if (cleanLabel(lines[cursor] ?? "") !== "划分前") {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    const before = readValues(cursor + 1);
    if (!before || before.values.length < 3) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    let partitionIndex = before.end + 1;
    while (
      partitionIndex < lines.length &&
      (!lines[partitionIndex].trim() || isDivider(lines[partitionIndex]))
    ) partitionIndex++;
    const partitionLabel = cleanLabel(lines[partitionIndex] ?? "");
    const pivot = partitionLabel.match(/^按基准\s*([+\-]?\d+(?:\.\d+)?)\s*划分$/u)?.[1];
    if (!pivot) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    const groups: Array<{ label: string; kind: string; values: string[] }> = [];
    let scan = partitionIndex + 1;
    for (let groupIndex = 0; groupIndex < 3; groupIndex++) {
      const values: string[] = [];
      while (scan < lines.length) {
        const value = lines[scan].trim();
        if (!value || isDivider(value)) {
          scan++;
          continue;
        }
        if (isNumber(value)) {
          values.push(value.replace(/−/g, "-"));
          scan++;
          continue;
        }

        const label = cleanLabel(value);
        const category = label.match(/^(小于\s*\S+|基准|大于\s*\S+)$/u)?.[1];
        if (!category) break;
        const kind = category.startsWith("小于")
          ? "less"
          : category === "基准"
            ? "pivot"
            : "greater";
        if (kind === "pivot" ? values.length !== 1 : false) break;
        groups.push({ label: category.replace(/\s+/g, " "), kind, values });
        scan++;
        break;
      }
      if (groups.length !== groupIndex + 1) break;
    }

    const kinds = new Set(groups.map((group) => group.kind));
    const pivotGroup = groups.find((group) => group.kind === "pivot");
    if (
      groups.length !== 3 ||
      kinds.size !== 3 ||
      pivotGroup?.values[0] !== pivot
    ) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    output.push(
      `划分前：\`[${before.values.join(", ")}]\``,
      "",
      `按基准 ${pivot} 划分：`,
      "",
      "| 分区 | 元素 |",
      "| --- | --- |",
      ...groups.map((group) =>
        `| ${group.label} | ${group.values.length > 0 ? `\`${group.values.join(", ")}\`` : "—"} |`,
      ),
      "",
    );
    cursor = scan;
  }

  return output.join("\n");
}

/**
 * ChatGPT sometimes serializes a visual path card as a sequence of plain text
 * cells (path label, total, vertex, edge weight, vertex, ...). Rebuild that
 * structured content as a Markdown table instead of letting each cell become
 * a separate paragraph or an indented code block.
 */
function normalizeLinearizedPathCards(markdown: string): string {
  type PathCard = {
    end: number;
    number: string;
    total: string;
    nodes: string[];
    weights: string[];
  };

  const lines = markdown.split("\n");
  const output: string[] = [];

  const cleanCell = (line: string): string => line
    .trim()
    .replace(/^\$\$?\s*|\s*\$\$?$/g, "")
    .replace(/^\\\(|\\\)$/g, "")
    .replace(/\*{1,2}/g, "")
    .replace(/`/g, "")
    .trim();

  const isVertex = (value: string): boolean =>
    /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,7}$/u.test(value);

  const isWeight = (value: string): boolean =>
    /^[+−-]?\d+(?:\.\d+)?$/u.test(value);

  const getTotal = (line: string): string | null => {
    const value = cleanCell(line);
    return value.match(/^(?:总长度|总长|length)\s*[:：]\s*([\d.]+)$/i)?.[1] ?? null;
  };

  const isFormula = (line: string): boolean => {
    const value = cleanCell(line)
      .replace(/\\(?:left|right|times|cdot|mathrm)\b/g, "")
      .replace(/[{}]/g, "")
      .replace(/\\,/g, " ");
    return /^[\d\s.+−\-×*÷/()]+\s*=\s*[\d.]+$/u.test(value);
  };

  function parseCard(start: number): PathCard | null {
    const heading = lines[start]?.trim().match(/^路径\s*(\d+)\s*$/u);
    if (!heading) return null;

    let totalIndex = start + 1;
    while (totalIndex < lines.length && !lines[totalIndex].trim()) totalIndex++;
    if (totalIndex >= lines.length) return null;

    const total = getTotal(lines[totalIndex]);
    if (!total) return null;

    const cells: string[] = [];
    let end = totalIndex;
    let foundFormula = false;
    for (let index = totalIndex + 1; index < lines.length; index++) {
      const raw = lines[index].trim();
      if (!raw) continue;
      if (/^---+$/.test(raw) || /^路径\s*\d+\s*$/u.test(raw)) return null;

      const value = cleanCell(raw);
      if (isFormula(raw)) {
        end = index;
        foundFormula = true;
        break;
      }
      if (!isVertex(value) && !isWeight(value)) return null;
      cells.push(value);
      end = index;
    }

    if (!foundFormula || cells.length < 5 || cells.length % 2 === 0) return null;
    const nodes = cells.filter((_cell, index) => index % 2 === 0);
    const weights = cells.filter((_cell, index) => index % 2 === 1);
    if (
      nodes.length < 3 ||
      weights.length !== nodes.length - 1 ||
      !nodes.every(isVertex) ||
      !weights.every(isWeight)
    ) return null;

    return { end, number: heading[1], total, nodes, weights };
  }

  for (let cursor = 0; cursor < lines.length;) {
    const first = parseCard(cursor);
    if (!first) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    const cards = [first];
    let next = first.end + 1;
    while (next < lines.length) {
      while (
        next < lines.length &&
        (!lines[next].trim() || /^---+$/.test(lines[next].trim()))
      ) {
        next++;
      }
      const card = parseCard(next);
      if (!card) break;
      cards.push(card);
      next = card.end + 1;
    }

    if (cards.length < 2) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    output.push(
      "",
      "| 路径 | 顶点与边权 | 总长度 |",
      "| --- | --- | ---: |",
      ...cards.map((card) => {
        const route = card.nodes.map((node, index) => index === 0
          ? node
          : `\\xrightarrow{${card.weights[index - 1]}} ${node}`)
          .join(" ");
        return `| 路径 ${card.number} | \\( ${route} \\) | ${card.total} |`;
      }),
      "",
    );
    cursor = cards[cards.length - 1].end + 1;
  }

  return output.join("\n");
}

/** Rebuild the memory-chip address diagrams that ChatGPT linearizes as text. */
function normalizeLinearizedAddressGroupDiagrams(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  const groupPattern = /^第\s*([1-4])\s*组$/u;
  const rangePattern = /^[\da-f]+H\s*[～~–-]\s*[\da-f]+H$/iu;
  const clean = (line: string): string => line
    .trim()
    .replace(/^\*\*(.*?)\*\*$/u, "$1")
    .replace(/\s+/g, " ");

  for (let cursor = 0; cursor < lines.length;) {
    const title = clean(lines[cursor]);
    if (!/(?:地址分布|CPU\s*访问地址)/u.test(title)) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    const isCpuAccess = /CPU\s*访问地址/u.test(title);
    const rows: Array<{ group: string; range: string; status: string }> = [];
    let scan = cursor + 1;
    let valid = true;

    for (let expectedGroup = 1; expectedGroup <= 4; expectedGroup++) {
      while (scan < lines.length && !lines[scan].trim()) scan++;
      const group = clean(lines[scan] ?? "").match(groupPattern);
      if (!group || Number(group[1]) !== expectedGroup) {
        valid = false;
        break;
      }
      scan++;

      while (scan < lines.length && !lines[scan].trim()) scan++;
      const range = clean(lines[scan] ?? "");
      if (!rangePattern.test(range)) {
        valid = false;
        break;
      }
      scan++;

      const details: string[] = [];
      while (scan < lines.length) {
        const value = clean(lines[scan]);
        if (!value) {
          scan++;
          continue;
        }
        if (groupPattern.test(value)) break;
        if (/^(?:2K\s*[×x]\s*8\s*位?|0B1FH\s*在这里|CS\s*有效|未选中)$/iu.test(value)) {
          details.push(value);
          scan++;
          continue;
        }
        break;
      }

      const selected = details.find((value) => /0B1FH\s*在这里|CS\s*有效/iu.test(value));
      const capacity = details.find((value) => /2K\s*[×x]\s*8/iu.test(value));
      const unselected = details.find((value) => /未选中/u.test(value));
      rows.push({
        group: `第 ${expectedGroup} 组`,
        range,
        status: selected ?? unselected ?? capacity ?? (isCpuAccess ? "未选中" : "2K×8 位"),
      });
    }

    if (!valid || rows.length !== 4) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    output.push(
      lines[cursor],
      "",
      "| 芯片组 | 地址范围 | 状态 |",
      "| --- | --- | --- |",
      ...rows.map(({ group, range, status }) => `| ${group} | ${range} | ${status} |`),
      "",
    );
    cursor = scan;
  }

  return output.join("\n");
}

/** Rebuild a five-stage pipeline diagram serialized as vertical table cells. */
function normalizeLinearizedPipelineMatrices(markdown: string): string {
  if (!/五级流水线/u.test(markdown)) return markdown;

  const lines = markdown.split("\n");
  const output: string[] = [];
  const clean = (line: string): string => line
    .trim()
    .replace(/^#{1,6}\s*/u, "")
    .replace(/^\*\*(.*?)\*\*$/u, "$1")
    .replace(/^`(.*?)`$/u, "$1")
    .replace(/[:：]\s*$/u, "");
  const skipEmpty = (from: number): number => {
    let index = from;
    while (index < lines.length && !lines[index].trim()) index++;
    return index;
  };
  const stages = ["IF", "ID", "EX", "MEM", "WB"];
  const stageSet = new Set(stages);
  const pauseValues = new Set(["暂停", "停顿", "气泡", "PAUSE", "STALL", "BUBBLE"]);
  const emptyValues = new Set(["—", "–", "-"]);
  const isCell = (value: string): boolean =>
    stageSet.has(value.toUpperCase()) ||
    pauseValues.has(value.toUpperCase()) ||
    emptyValues.has(value);
  const isInstructionLabel = (value: string): boolean =>
    !isCell(value) && /^(?:I\d+|[A-Z][A-Z0-9]{1,9})$/iu.test(value);
  const normalizeCell = (value: string): string => {
    const upper = value.toUpperCase();
    if (stageSet.has(upper)) return upper;
    if (pauseValues.has(upper)) return "暂停";
    return "—";
  };

  for (let cursor = 0; cursor < lines.length;) {
    const title = clean(lines[cursor] ?? "");
    if (!/(?:无阻塞的五级流水线|流水线.*时序|时序.*流水线)/u.test(title)) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    let scan = skipEmpty(cursor + 1);
    if (clean(lines[scan] ?? "") !== "指令") {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }
    scan++;

    const cycles: string[] = [];
    for (let expected = 1; expected <= 16; expected++) {
      const index = skipEmpty(scan);
      if (clean(lines[index] ?? "") !== String(expected)) break;
      cycles.push(String(expected));
      scan = index + 1;
    }

    const rows: Array<{ label: string; offset: number; cells: string[] }> = [];
    let valid = cycles.length >= stages.length;
    let pausesBeforeRow = 0;
    while (valid) {
      const rowStart = skipEmpty(scan);
      const label = clean(lines[rowStart] ?? "");
      if (!isInstructionLabel(label)) break;

      scan = rowStart + 1;
      const rowCells: string[] = [];
      while (true) {
        const stageIndex = skipEmpty(scan);
        const cell = clean(lines[stageIndex] ?? "");
        if (!isCell(cell)) break;
        rowCells.push(normalizeCell(cell));
        scan = stageIndex + 1;
      }
      if (rowCells.filter((cell) => stageSet.has(cell)).length < 3) {
        valid = false;
        break;
      }

      const offset = rows.length + pausesBeforeRow;
      if (offset + rowCells.length > cycles.length) {
        valid = false;
        break;
      }
      rows.push({ label, offset, cells: rowCells });
      pausesBeforeRow += rowCells.filter((cell) => cell === "暂停").length;
    }

    if (!valid || rows.length < 2) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    const header = ["指令", ...cycles.map((cycle) => `周期 ${cycle}`)];
    const tableRows = rows.map(({ label, offset, cells }) => {
      const row = Array.from({ length: cycles.length }, () => "—");
      cells.forEach((cell, cellIndex) => {
        row[offset + cellIndex] = cell;
      });
      return [label, ...row];
    });
    const separator = header.map(() => "---");
    output.push(
      lines[cursor],
      "",
      `| ${header.join(" | ")} |`,
      `| ${separator.join(" | ")} |`,
      ...tableRows.map((row) => `| ${row.join(" | ")} |`),
      "",
    );
    cursor = skipEmpty(scan);
  }

  return output.join("\n");
}

/** Keep linked-list nodes on one connected line when a diagram is flattened. */
function normalizeLinearizedLinkedListSequences(markdown: string): string {
  if (!/假设有一个双向链表/u.test(markdown)) return markdown;

  const lines = markdown.split("\n");
  const output: string[] = [];
  const numberPattern = /^[+\-−]?(?:\d+(?:\.\d+)?|\.\d+)$/u;
  const clean = (line: string): string => line
    .trim()
    .replace(/^\*\*(.*?)\*\*$/u, "$1")
    .replace(/^`(.*?)`$/u, "$1")
    .replace(/[:：]\s*$/u, "");
  const skipEmpty = (from: number): number => {
    let index = from;
    while (index < lines.length && !lines[index].trim()) index++;
    return index;
  };

  for (let cursor = 0; cursor < lines.length;) {
    const label = clean(lines[cursor] ?? "");
    if (label !== "假设有一个双向链表") {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    const values: string[] = [];
    let scan = cursor + 1;
    while (scan < lines.length) {
      const valueIndex = skipEmpty(scan);
      const value = clean(lines[valueIndex] ?? "");
      if (!numberPattern.test(value)) {
        scan = valueIndex;
        break;
      }
      values.push(value.replace(/−/g, "-"));
      scan = valueIndex + 1;
    }

    const next = clean(lines[skipEmpty(scan)] ?? "");
    if (values.length < 3 || !/^每个结点具有前驱指针/u.test(next)) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    output.push(
      lines[cursor],
      "",
      `\`${values.join(" ↔ ")}\``,
      "",
    );
    cursor = skipEmpty(scan);
  }

  return output.join("\n");
}

/** Restore the field-width and encoded-bit layouts of IEEE 754 examples. */
function normalizeLinearizedFloatFieldTables(markdown: string): string {
  if (!/IEEE 754 单精度浮点数共 32 位|最终 IEEE 754 编码/u.test(markdown)) {
    return markdown;
  }

  const lines = markdown.split("\n");
  const output: string[] = [];
  const clean = (line: string): string => line
    .trim()
    .replace(/^\*\*(.*?)\*\*$/u, "$1")
    .replace(/^`(.*?)`$/u, "$1")
    .replace(/[:：]\s*$/u, "");
  const skipEmpty = (from: number): number => {
    let index = from;
    while (index < lines.length && !lines[index].trim()) index++;
    return index;
  };

  for (let cursor = 0; cursor < lines.length;) {
    const title = clean(lines[cursor] ?? "");
    const kind = title === "IEEE 754 单精度浮点数共 32 位"
      ? "width"
      : title === "最终 IEEE 754 编码"
        ? "encoding"
        : null;
    if (!kind) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    const expectedFields = ["符号", "阶码", "尾数字段"];
    const fieldAliases = [
      new Set(["符号", "符号位"]),
      new Set(["阶码"]),
      new Set(["尾数字段", "尾数小数部分"]),
    ];
    const values: string[] = [];
    let scan = cursor + 1;
    let valid = true;
    const firstContent = clean(lines[skipEmpty(scan)] ?? "");
    const labelsFirst = fieldAliases[0].has(firstContent);

    if (kind === "width" && !labelsFirst) {
      for (let index = 0; index < expectedFields.length; index++) {
        const valueIndex = skipEmpty(scan);
        const value = clean(lines[valueIndex] ?? "");
        if (!/^\d+(?:\s*位)?$/u.test(value)) {
          valid = false;
          break;
        }
        values.push(value);
        scan = valueIndex + 1;
      }
      for (let index = 0; valid && index < expectedFields.length; index++) {
        const fieldIndex = skipEmpty(scan);
        if (!fieldAliases[index].has(clean(lines[fieldIndex] ?? ""))) {
          valid = false;
          break;
        }
        scan = fieldIndex + 1;
      }
    } else {
      for (let fieldIndex = 0; fieldIndex < expectedFields.length; fieldIndex++) {
        const fieldIndexInLines = skipEmpty(scan);
        if (!fieldAliases[fieldIndex].has(clean(lines[fieldIndexInLines] ?? ""))) {
          valid = false;
          break;
        }
        const valueIndex = skipEmpty(fieldIndexInLines + 1);
        const value = clean(lines[valueIndex] ?? "");
        const isValidValue = kind === "width"
          ? /^\d+(?:\s*位)?$/u.test(value)
          : /^[01]+$/u.test(value);
        if (!isValidValue) {
          valid = false;
          break;
        }
        values.push(value);
        scan = valueIndex + 1;
      }
    }

    if (!valid || values.length !== expectedFields.length) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    const header = kind === "width" ? ["字段", "位数"] : ["字段", "编码"];
    const rows = expectedFields.map((field, index) => [
      field === "符号" ? "符号位" : field,
      kind === "width" && !/位$/u.test(values[index])
        ? `${values[index]} 位`
        : values[index],
    ]);
    output.push(
      lines[cursor],
      "",
      `| ${header.join(" | ")} |`,
      `| ${header.map(() => "---").join(" | ")} |`,
      ...rows.map((row) => `| ${row.join(" | ")} |`),
      "",
    );
    cursor = skipEmpty(scan);
  }

  return output.join("\n");
}

function normalizeLinearizedPageTableGrid(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  const groupPattern = /^二级页表\s+(\d+)$/u;
  const itemPattern = /^页表项\s+(\d+)$/u;
  const logicalPagePattern = /^逻辑页\s+(\d+)$/u;
  const skipEmpty = (from: number): number => {
    let index = from;
    while (index < lines.length && !lines[index].trim()) index++;
    return index;
  };

  for (let cursor = 0; cursor < lines.length;) {
    const firstGroup = lines[cursor].trim().match(groupPattern);
    if (!firstGroup) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    const rows: Array<{ group: string; item: string; logicalPage: string }> = [];
    let scan = cursor;
    let groups = 0;
    let valid = true;
    while (scan < lines.length) {
      scan = skipEmpty(scan);
      const group = lines[scan]?.trim().match(groupPattern);
      if (!group) break;
      groups++;
      scan++;

      while (scan < lines.length) {
        scan = skipEmpty(scan);
        const item = lines[scan]?.trim().match(itemPattern);
        if (!item) break;
        scan = skipEmpty(scan + 1);
        const logicalPage = lines[scan]?.trim().match(logicalPagePattern);
        if (!logicalPage) {
          valid = false;
          break;
        }
        rows.push({ group: group[1], item: item[1], logicalPage: logicalPage[1] });
        scan++;
      }
      if (!valid) break;
    }

    if (!valid || groups < 2 || rows.length < 4) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    output.push(
      "| 二级页表 | 页表项 | 逻辑页 |",
      "| --- | --- | --- |",
      ...rows.map((row) => `| ${row.group} | ${row.item} | ${row.logicalPage} |`),
      "",
    );
    cursor = scan;
  }

  return output.join("\n");
}

function normalizeLinearizedPppFrameGrid(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  const titlePattern = /^PPP 标准帧结构（未启用字段压缩）$/u;
  const skipEmpty = (from: number): number => {
    let index = from;
    while (index < lines.length && !lines[index].trim()) index++;
    return index;
  };

  for (let cursor = 0; cursor < lines.length;) {
    if (!titlePattern.test(lines[cursor].trim())) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    const fields: string[] = [];
    const sizes: string[] = [];
    let scan = cursor + 1;
    let valid = true;
    for (let index = 0; index < 7; index++) {
      scan = skipEmpty(scan);
      const field = lines[scan]?.trim();
      if (!field || !/^(?:F|A|C|协议|信息|FCS)$/u.test(field)) {
        valid = false;
        break;
      }
      fields.push(field);
      scan = skipEmpty(scan + 1);
      const size = lines[scan]?.trim();
      if (!size || !/^(?:\d+B|可变)$/u.test(size)) {
        valid = false;
        break;
      }
      sizes.push(size);
      scan++;
    }

    if (!valid) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    output.push(
      lines[cursor],
      "",
      `| ${fields.join(" | ")} |`,
      `| ${fields.map(() => "---").join(" | ")} |`,
      `| ${sizes.join(" | ")} |`,
      "",
    );
    cursor = scan;
  }

  return output.join("\n");
}

function normalizeLinearizedTcpWindowGrid(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  const firstTitle = /^初始：发送窗口\s+4000B$/u;
  const secondTitle = /^收到第一个\s+1000B\s+的确认后$/u;
  const statuses = new Set(["已发未确认", "可以发送"]);
  const skipSeparators = (from: number): number => {
    let index = from;
    while (index < lines.length && (!lines[index].trim() || /^---+$/.test(lines[index].trim()))) index++;
    return index;
  };
  const readCells = (from: number): { cells: string[]; end: number } | null => {
    const cells: string[] = [];
    let scan = from;
    while (cells.length < 4) {
      scan = skipSeparators(scan);
      const status = lines[scan]?.trim();
      if (!status || !statuses.has(status)) return null;
      scan = skipSeparators(scan + 1);
      if (lines[scan]?.trim() !== "1000B") return null;
      cells.push(status);
      scan++;
    }
    return { cells, end: scan };
  };

  for (let cursor = 0; cursor < lines.length;) {
    if (!firstTitle.test(lines[cursor].trim())) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    const first = readCells(cursor + 1);
    const secondIndex = first
      ? lines.findIndex((line, index) => index >= first.end && secondTitle.test(line.trim()))
      : -1;
    const second = secondIndex >= 0 ? readCells(secondIndex + 1) : null;
    if (!first || !second) {
      output.push(lines[cursor]);
      cursor++;
      continue;
    }

    const intervening = lines.slice(first.end, secondIndex)
      .filter((line) => line.trim() && !/^---+$/.test(line.trim()));
    output.push(
      lines[cursor],
      "",
      "| 阶段 | 区块 1（1000B） | 区块 2（1000B） | 区块 3（1000B） | 区块 4（1000B） |",
      "| --- | --- | --- | --- | --- |",
      `| 初始 | ${first.cells.join(" | ")} |`,
      `| 收到第一个 1000B 的确认后 | ${second.cells.join(" | ")} |`,
      ...(intervening.length ? ["", ...intervening] : []),
      "",
    );
    cursor = second.end;
  }

  return output.join("\n");
}

/**
 * Turn ChatGPT card grids into a compact Markdown representation instead of
 * flattening every card into a separate paragraph. Two-line cards become a
 * table (label row + value row); other grids remain readable as a list.
 */
function normalizeGridBlocks(markdown: string): string {
  const output: string[] = [];
  let cursor = 0;

  while (cursor < markdown.length) {
    const opening = findNextComponentTag(markdown, "grid", cursor, false);
    if (!opening) {
      output.push(markdown.slice(cursor));
      break;
    }

    const closingStart = findMatchingComponentClose(
      markdown,
      "grid",
      opening.end,
    );
    if (closingStart < 0) {
      output.push(markdown.slice(cursor));
      break;
    }

    const closingEnd = findMarkupTagEnd(markdown, closingStart);
    if (closingEnd < 0) {
      output.push(markdown.slice(cursor));
      break;
    }

    output.push(markdown.slice(cursor, opening.start));
    const gridBody = markdown.slice(opening.end, closingStart);
    const itemContents = getGridItemContents(gridBody);
    const renderedGrid = itemContents && renderMarkdownGrid(itemContents);
    output.push(renderedGrid ?? markdown.slice(opening.start, closingEnd + 1));
    cursor = closingEnd + 1;
  }

  return output.join("");
}

function findNextComponentTag(
  source: string,
  name: string,
  from: number,
  closing: boolean,
): { start: number; end: number } | null {
  const marker = closing ? `</${name}` : `<${name}`;
  let cursor = from;

  while (cursor < source.length) {
    const start = source.indexOf(marker, cursor);
    if (start < 0) return null;
    const boundary = source[start + marker.length];
    if (boundary && !/[\s/>]/.test(boundary)) {
      cursor = start + marker.length;
      continue;
    }

    const end = findMarkupTagEnd(source, start);
    if (end < 0) return null;
    return { start, end: end + 1 };
  }

  return null;
}

function findMatchingComponentClose(
  source: string,
  name: string,
  from: number,
): number {
  let depth = 1;
  let cursor = from;

  while (cursor < source.length) {
    const open = findNextComponentTag(source, name, cursor, false);
    const close = findNextComponentTag(source, name, cursor, true);
    if (!close) return -1;

    if (open && open.start < close.start) {
      const raw = source.slice(open.start + 1, open.end - 1).trim();
      if (!/\/\s*$/.test(raw)) depth++;
      cursor = open.end;
      continue;
    }

    depth--;
    if (depth === 0) return close.start;
    cursor = close.end;
  }

  return -1;
}

function findMatchingComponentCloseCaseInsensitive(
  source: string,
  name: string,
  from: number,
): number {
  const marker = new RegExp(`<\\/?${escapeRegExp(name)}(?=[\\s/>])`, "ig");
  let depth = 1;
  let cursor = from;

  while (cursor < source.length) {
    marker.lastIndex = cursor;
    const match = marker.exec(source);
    if (!match) return -1;

    const tagEnd = findMarkupTagEnd(source, match.index);
    if (tagEnd < 0) return -1;
    const fullTag = source.slice(match.index, tagEnd + 1);
    const closing = /^<\//.test(fullTag);
    const selfClosing = !closing && /\/\s*>$/.test(fullTag);

    if (closing) {
      depth--;
      if (depth === 0) return match.index;
    } else if (!selfClosing) {
      depth++;
    }
    cursor = tagEnd + 1;
  }

  return -1;
}

function getGridItemContents(gridBody: string): string[] | null {
  const contents: string[] = [];
  let cursor = 0;

  while (cursor < gridBody.length) {
    const opening = findNextComponentTag(gridBody, "grid-item", cursor, false);
    if (!opening) {
      return gridBody.slice(cursor).trim() ? null : contents;
    }
    if (gridBody.slice(cursor, opening.start).trim()) return null;

    const closingStart = findMatchingComponentClose(
      gridBody,
      "grid-item",
      opening.end,
    );
    if (closingStart < 0) return null;
    const closingEnd = findMarkupTagEnd(gridBody, closingStart);
    if (closingEnd < 0) return null;

    contents.push(gridBody.slice(opening.end, closingStart));
    cursor = closingEnd + 1;
  }

  return contents;
}

function renderMarkdownGrid(items: string[]): string | null {
  if (items.length < 2 || items.some((item) => /<(?:svg|math)\b/i.test(item))) {
    return null;
  }

  const cells = items.map((item) => normalizeComponentTags(item)
    .replace(/<br\s*\/?>/gi, "\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean));

  if (cells.some((lines) => lines.length === 0)) return null;

  const escapeCell = (value: string): string => value.replace(/\|/g, "\\|");
  if (cells.every((lines) => lines.length >= 2)) {
    const labels = cells.map((lines) => escapeCell(lines[0]));
    const values = cells.map((lines) => escapeCell(lines.slice(1).join("<br>")));
    const separator = labels.map(() => "---");
    return `\n\n| ${labels.join(" | ")} |\n| ${separator.join(" | ")} |\n| ${values.join(" | ")} |\n\n`;
  }

  return `\n\n${cells.map((lines) => {
    const [label, ...details] = lines;
    return details.length > 0
      ? `- **${label}**: ${escapeCell(details.join("<br>"))}`
      : `- ${escapeCell(label)}`;
  }).join("\n")}\n\n`;
}

function normalizeComponentTags(markdown: string): string {
  let output = "";
  let cursor = 0;
  let svgDepth = 0;

  while (cursor < markdown.length) {
    const tagStart = markdown.indexOf("<", cursor);
    if (tagStart < 0) {
      output += markdown.slice(cursor);
      break;
    }

    output += markdown.slice(cursor, tagStart);
    const candidate = markdown.slice(tagStart).match(/^<\/?([A-Za-z][\w:-]*)/);
    if (!candidate) {
      output += "<";
      cursor = tagStart + 1;
      continue;
    }

    const candidateName = candidate[1].toLowerCase();
    if (
      candidateName !== "svg" &&
      candidateName !== "math" &&
      candidateName !== "divider" &&
      candidateName !== "icon" &&
      candidateName !== "learningviz" &&
      candidateName !== "badge" &&
      candidateName !== "radio" &&
      candidateName !== "list-item" &&
      candidateName !== "button" &&
      candidateName !== "chart" &&
      candidateName !== "asyncimage" &&
      candidateName !== "cite" &&
      !COMPONENT_WRAPPERS.has(candidateName)
    ) {
      output += "<";
      cursor = tagStart + 1;
      continue;
    }

    const tagEnd = findMarkupTagEnd(markdown, tagStart);
    if (tagEnd < 0) {
      output += markdown.slice(tagStart);
      break;
    }

    const fullTag = markdown.slice(tagStart, tagEnd + 1);
    const rawTag = markdown.slice(tagStart + 1, tagEnd).trim();
    const closing = rawTag.startsWith("/");
    const body = closing ? rawTag.slice(1).trim() : rawTag;
    const nameMatch = body.match(/^([A-Za-z][\w:-]*)/);

    if (!nameMatch) {
      output += fullTag;
      cursor = tagEnd + 1;
      continue;
    }

    const name = nameMatch[1].toLowerCase();
    const attributes = body.slice(nameMatch[0].length);
    const selfClosing = !closing && /\/\s*$/.test(attributes);

    if (name === "chart") {
      const renderedChart = renderStaticChart(attributes);
      if (renderedChart) {
        output += renderedChart;
        if (!closing && !selfClosing) {
          const closeStart = findMatchingComponentCloseCaseInsensitive(
            markdown,
            name,
            tagEnd + 1,
          );
          if (closeStart >= 0) {
            const closeEnd = findMarkupTagEnd(markdown, closeStart);
            cursor = closeEnd >= 0 ? closeEnd + 1 : closeStart;
            continue;
          }
        }
        cursor = tagEnd + 1;
        continue;
      }
    }

    if (name === "button") {
      if (!closing && !selfClosing) {
        const closeStart = findMatchingComponentCloseCaseInsensitive(
          markdown,
          name,
          tagEnd + 1,
        );
        if (closeStart >= 0) {
          const closeEnd = findMarkupTagEnd(markdown, closeStart);
          const label = markdown.slice(tagEnd + 1, closeStart)
            .replace(/\s+/g, " ")
            .trim();
          if (/^(?:正确|错误)$/u.test(label)) output += `- ${label}\n`;
          cursor = closeEnd >= 0 ? closeEnd + 1 : closeStart;
          continue;
        }
      }
      cursor = tagEnd + 1;
      continue;
    }

    if (["learningviz", "chart", "asyncimage", "cite"].includes(name)) {
      // These elements are interactive controls, citation metadata, or visual
      // payloads that the export cannot reproduce. Keep adjacent prose and
      // omit the serialized component properties and fallback markup.
      if (!closing && !selfClosing) {
        const closeStart = findMatchingComponentCloseCaseInsensitive(
          markdown,
          name,
          tagEnd + 1,
        );
        if (closeStart >= 0) {
          const closeEnd = findMarkupTagEnd(markdown, closeStart);
          cursor = closeEnd >= 0 ? closeEnd + 1 : closeStart;
          continue;
        }
      }
    } else if (name === "svg") {
      output += fullTag;
      if (closing) svgDepth = Math.max(0, svgDepth - 1);
      else if (!selfClosing) svgDepth++;
    } else if (svgDepth > 0) {
      output += fullTag;
    } else if (name === "math" && selfClosing) {
      const rawValue = attributes.match(/\bvalue\s*=\s*\{\s*String\.raw`([\s\S]*?)`\s*\}/);
      if (!rawValue) {
        output += fullTag;
      } else if (/\bblock\b/.test(attributes)) {
        output += `\n\n$$\n${rawValue[1].trim()}\n$$\n\n`;
      } else {
        output += `$${rawValue[1]}$`;
      }
    } else if (name === "divider") {
      output += closing ? "\n\n" : "\n\n---\n\n";
    } else if (name === "icon") {
      // Icons are decorative; omit the tag while preserving surrounding text.
    } else if (name === "badge") {
      if (!closing && !selfClosing) output += "**";
      if (closing) output += "**";
    } else if (name === "radio") {
      if (!closing && !selfClosing) output += "- ";
      if (closing) output += "\n";
    } else if (name === "list-item") {
      if (!closing && !selfClosing) output += "- ";
      if (closing) output += "\n";
    } else if (COMPONENT_WRAPPERS.has(name)) {
      output += "\n\n";
    } else {
      output += fullTag;
    }

    cursor = tagEnd + 1;
  }

  return output
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function findMarkupTagEnd(source: string, start: number): number {
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  let braceDepth = 0;

  for (let index = start + 1; index < source.length; index++) {
    const character = source[index];

    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "{") {
      braceDepth++;
    } else if (character === "}") {
      braceDepth--;
    } else if (character === ">" && braceDepth === 0) {
      return index;
    }
  }

  return -1;
}

function restoreCodeBlocks(
  markdown: string,
  placeholderPrefix: string,
  codeBlocks: string[],
): string {
  return markdown.replace(
    new RegExp(`${escapeRegExp(placeholderPrefix)}(\\d+)\\u0000`, "g"),
    (_match, index: string) => codeBlocks[Number(index)] ?? "",
  );
}

function estimateBase64Size(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileStaticSvg(
  svgTemplate: string,
  backgroundColor = "#ffffff",
): string | null {
  if (svgTemplate.length > MAX_TEMPLATE_LENGTH) {
    return null;
  }

  const rootMatch = svgTemplate.match(/^(<svg\b[^>]*>)([\s\S]*)(<\/svg>)$/i);

  if (!rootMatch) {
    return null;
  }

  const expansionState = { loopCount: 0 };
  const expandedBody = expandEachBlocks(rootMatch[2], {}, expansionState);

  if (expandedBody.length > MAX_EXPANDED_TEMPLATE_LENGTH) {
    return null;
  }

  // ChatGPT often emits static JSX values such as strokeWidth={2.5}. Resolve
  // these after loop expansion so otherwise-safe diagrams are not left as
  // broken raw HTML in the exported Markdown.
  const resolvedBody = expandBindings(expandedBody, {});
  const resolvedOpeningTag = expandBindings(rootMatch[1], {});

  if (/\{#(?:each|if)\b|\{\/(?:each|if)\}|\{[^{}]*\}/.test(resolvedBody)) {
    return null;
  }

  const openingTag = resolvedOpeningTag.replace(/\s+key="[^"]*"/g, "");
  return sanitizeStaticSvg(
    `${openingTag}${resolvedBody}${rootMatch[3]}`,
    backgroundColor,
  );
}

/** Finds the closing brace for a Svelte-style expression, ignoring braces in strings. */
function findExpressionEnd(source: string, start: number): number {
  if (source[start] !== "{") return -1;

  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;

  for (let index = start; index < source.length; index++) {
    const character = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }

      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "{") {
      depth++;
    } else if (character === "}") {
      depth--;

      if (depth === 0) return index;
    }
  }

  return -1;
}

function expandEachBlocks(
  template: string,
  scope: Record<string, TemplateValue>,
  state: { loopCount: number },
  preserveUnsupportedBindings = false,
  escapeBindings = true,
): string {
  const output: string[] = [];
  let outputLength = 0;
  let cursor = 0;

  const append = (part: string): void => {
    outputLength += part.length;

    if (outputLength > MAX_EXPANDED_TEMPLATE_LENGTH) {
      throw new Error("The expanded SVG template is too large.");
    }

    output.push(part);
  };

  while (cursor < template.length) {
    const openStart = template.indexOf(EACH_OPEN_TOKEN, cursor);
    const ifStart = template.indexOf(IF_OPEN_TOKEN, cursor);
    const eachClose = template.indexOf(EACH_CLOSE_TOKEN, cursor);
    const ifClose = template.indexOf(IF_CLOSE_TOKEN, cursor);
    const bodyStart = template.indexOf("{@body", cursor);
    const openIsIf = ifStart >= 0 && (openStart < 0 || ifStart < openStart);
    const nextOpen = openIsIf ? ifStart : openStart;
    const unexpectedClose = [eachClose, ifClose]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? -1;

    if (
      bodyStart >= 0 &&
      (nextOpen < 0 || bodyStart < nextOpen) &&
      (unexpectedClose < 0 || bodyStart < unexpectedClose)
    ) {
      append(expandBindings(
        template.slice(cursor, bodyStart),
        scope,
        preserveUnsupportedBindings,
        escapeBindings,
      ));
      const bodyEnd = findExpressionEnd(template, bodyStart);
      if (bodyEnd < 0) {
        if (!preserveUnsupportedBindings) {
          throw new Error("The template has an unterminated body declaration.");
        }
        cursor = bodyStart + "{@body".length;
        continue;
      }
      applyTemplateBodyBinding(
        template.slice(bodyStart + "{@body".length, bodyEnd),
        scope,
      );
      cursor = bodyEnd + 1;
      continue;
    }

    if (nextOpen < 0) {
      if (unexpectedClose >= 0) {
        throw new Error("The template has an unmatched block directive.");
      }

      const remaining = template.slice(cursor);
      append(expandBindings(
        remaining,
        scope,
        preserveUnsupportedBindings,
        escapeBindings,
      ));
      cursor = template.length;
      break;
    }

    if (unexpectedClose >= 0 && unexpectedClose < nextOpen) {
      throw new Error("The template has an unmatched block directive.");
    }

    const preceding = template.slice(cursor, nextOpen);
    append(expandBindings(
      preceding,
      scope,
      preserveUnsupportedBindings,
      escapeBindings,
    ));

    const blockType = openIsIf ? "if" : "each";
    const openEnd = findExpressionEnd(template, nextOpen);

    if (openEnd < 0) {
      throw new Error("The template has an unterminated block directive.");
    }

    const bounds = findMatchingBlockBounds(template, openEnd + 1, blockType);
    if (!bounds) {
      throw new Error("The template has an unterminated block directive.");
    }

    const bodyEnd = bounds.elseStart ?? bounds.closeStart;
    const body = template.slice(openEnd + 1, bodyEnd);
    state.loopCount++;

    if (state.loopCount > 200) {
      throw new Error("The template has too many block directives.");
    }

    if (blockType === "if") {
      const condition = template.slice(nextOpen + IF_OPEN_TOKEN.length, openEnd);
      let conditionIsTrue = false;
      try {
        conditionIsTrue = isTruthy(resolveExpression(condition, scope));
      } catch (error) {
        if (!preserveUnsupportedBindings) throw error;
      }
      const alternateBody = bounds.elseStart === undefined
        ? ""
        : template.slice(bounds.elseEnd!, bounds.closeStart);
      const selectedBody = conditionIsTrue ? body : alternateBody;
      append(expandEachBlocks(
        selectedBody,
        scope,
        state,
        preserveUnsupportedBindings,
        escapeBindings,
      ));
    } else {
      const header = template.slice(nextOpen + EACH_OPEN_TOKEN.length, openEnd);
      const headerMatch = header.match(
        /^\s*([\s\S]+)\s+as\s+([A-Za-z_$][\w$]*)(?:\s*,\s*([A-Za-z_$][\w$]*))?\s*$/,
      );

      if (!headerMatch) {
        if (preserveUnsupportedBindings) {
          cursor = bounds.closeStart + EACH_CLOSE_TOKEN.length;
          continue;
        }
        throw new Error("The template has an invalid each block.");
      }

      const source = headerMatch[1].trim();
      const itemName = headerMatch[2];
      const indexName = headerMatch[3];
      let items: TemplateValue[];
      try {
        items = resolveLoopItems(source, scope);
      } catch (error) {
        if (!preserveUnsupportedBindings) throw error;
        cursor = bounds.closeStart + EACH_CLOSE_TOKEN.length;
        continue;
      }

      if (items.length > MAX_LOOP_ITEMS) {
        throw new Error("The template loop is too large.");
      }
      if (items.length * body.length > MAX_EXPANDED_TEMPLATE_LENGTH) {
        throw new Error("The expanded template is too large.");
      }

      if (items.length === 0 && bounds.elseEnd !== undefined) {
        append(expandEachBlocks(
          template.slice(bounds.elseEnd, bounds.closeStart),
          scope,
          state,
          preserveUnsupportedBindings,
          escapeBindings,
        ));
      }

      for (let index = 0; index < items.length; index++) {
        const childScope: Record<string, TemplateValue> = { ...scope };
        childScope[itemName] = items[index];

        if (indexName) {
          childScope[indexName] = index;
        }

        append(expandEachBlocks(
          body,
          childScope,
          state,
          preserveUnsupportedBindings,
          escapeBindings,
        ));
      }
    }

    cursor = bounds.closeStart + (blockType === "if"
      ? IF_CLOSE_TOKEN.length
      : EACH_CLOSE_TOKEN.length);
  }

  return output.join("");
}

function applyTemplateBodyBinding(
  source: string,
  scope: Record<string, TemplateValue>,
): void {
  const declaration = source.trim().match(
    /^const\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+?)\s*;?$/,
  );
  if (!declaration) return;

  const expression = declaration[2].trim().replace(/;\s*$/, "");
  if (!expression.startsWith("[")) return;

  try {
    const arrayEnd = findMatchingDelimiter(expression, 0, "[", "]");
    if (arrayEnd === expression.length - 1) {
      scope[declaration[1]] = parseArrayLiteral(expression);
    }
  } catch {
    // Dynamic or unsupported declarations are omitted from static exports.
  }
}

function findMatchingBlockBounds(
  template: string,
  bodyStart: number,
  rootType: "each" | "if",
): { closeStart: number; elseStart?: number; elseEnd?: number } | null {
  const stack: Array<"each" | "if"> = [rootType];
  let elseStart: number | undefined;
  let elseEnd: number | undefined;
  let cursor = bodyStart;

  while (cursor < template.length) {
    const openStart = template.indexOf(EACH_OPEN_TOKEN, cursor);
    const ifStart = template.indexOf(IF_OPEN_TOKEN, cursor);
    const eachClose = template.indexOf(EACH_CLOSE_TOKEN, cursor);
    const ifClose = template.indexOf(IF_CLOSE_TOKEN, cursor);
    const elseToken = template.indexOf(IF_ELSE_TOKEN, cursor);
    const nextOpen = [openStart, ifStart]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? -1;
    const nextClose = [eachClose, ifClose]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? -1;

    if (nextClose < 0) return null;

    if (
      elseToken >= 0 &&
      elseToken < nextClose &&
      (nextOpen < 0 || elseToken < nextOpen)
    ) {
      if (stack.length === 1) {
        if (elseStart !== undefined) return null;
        elseStart = elseToken;
        elseEnd = elseToken + IF_ELSE_TOKEN.length;
      }
      cursor = elseToken + IF_ELSE_TOKEN.length;
      continue;
    }

    if (nextOpen >= 0 && nextOpen < nextClose) {
      const nestedType = nextOpen === ifStart ? "if" : "each";
      const openEnd = findExpressionEnd(template, nextOpen);
      if (openEnd < 0) return null;
      stack.push(nestedType);
      cursor = openEnd + 1;
      continue;
    }

    const closeType = nextClose === ifClose ? "if" : "each";
    if (stack.pop() !== closeType) return null;

    if (stack.length === 0) {
      return { closeStart: nextClose, elseStart, elseEnd };
    }
    cursor = nextClose + (closeType === "if" ? IF_CLOSE_TOKEN.length : EACH_CLOSE_TOKEN.length);
  }

  return null;
}

function resolveLoopItems(
  source: string,
  scope: Record<string, TemplateValue>,
): TemplateValue[] {
  const expression = source.trim();
  const value = expression.startsWith("[")
    ? parseArrayLiteral(expression)
    : resolveExpression(expression, scope);

  if (!Array.isArray(value)) {
    throw new Error("The SVG loop source must be an array.");
  }

  return value;
}

function parseArrayLiteral(source: string): TemplateValue[] {
  const normalized = quoteUnquotedObjectKeys(source);
  const value: unknown = JSON.parse(normalized);

  if (!Array.isArray(value)) {
    throw new Error("The SVG loop source must be an array.");
  }

  return value as TemplateValue[];
}

function parseObjectLiteral(source: string): Record<string, TemplateValue> {
  const value: unknown = JSON.parse(quoteUnquotedObjectKeys(source));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The template value must be an object.");
  }
  return value as Record<string, TemplateValue>;
}

function renderStaticChart(attributes: string): string | null {
  const content = attributes.match(
    /\bcontent\s*=\s*\{\s*(\{[\s\S]*\})\s*\}/i,
  )?.[1];
  if (!content) return null;

  try {
    const chart = parseObjectLiteral(content);
    const data = chart.data;
    const xKey = chart.xKey;
    const series = chart.series;
    if (typeof xKey !== "string" || !Array.isArray(data) || !Array.isArray(series)) {
      return null;
    }

    const dataSeries = series.filter((entry): entry is Record<string, TemplateValue> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry) &&
      typeof (entry as Record<string, TemplateValue>).dataKey === "string");
    if (dataSeries.length === 0 || dataSeries.length !== series.length) return null;

    const headers = [
      xKey,
      ...dataSeries.map((entry) => typeof entry.label === "string"
        ? entry.label
        : String(entry.dataKey)),
    ];
    const rows = data.filter((entry): entry is Record<string, TemplateValue> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry));
    if (rows.length === 0 || rows.length !== data.length) return null;

    const cell = (value: TemplateValue | undefined): string => {
      if (value === undefined || value === null || value === "") return "—";
      return formatTemplateValue(value).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
    };
    const footer = typeof chart.meta === "object" && chart.meta !== null &&
      !Array.isArray(chart.meta) && typeof chart.meta.footer === "string"
      ? `\n\n说明：${chart.meta.footer}`
      : "";
    const table = [
      `| ${headers.map((header) => header.replace(/\|/g, "\\|")).join(" | ")} |`,
      `| --- | ${dataSeries.map(() => "---:").join(" | ")} |`,
      ...rows.map((row) => `| ${[
        cell(row[xKey]),
        ...dataSeries.map((entry) => cell(row[String(entry.dataKey)])),
      ].join(" | ")} |`),
    ].join("\n");
    return `\n\n${table}${footer}\n\n`;
  } catch {
    return null;
  }
}

function quoteUnquotedObjectKeys(source: string): string {
  let result = "";
  let quote: '"' | null = null;
  let escaped = false;

  for (let index = 0; index < source.length; index++) {
    const character = source[index];

    if (quote) {
      result += character;

      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }

      continue;
    }

    if (character === '"') {
      quote = '"';
      result += character;
      continue;
    }

    if (/[A-Za-z_$]/.test(character)) {
      let end = index + 1;

      while (end < source.length && /[\w$]/.test(source[end])) {
        end++;
      }

      const previous = lastNonWhitespace(result);
      let lookahead = end;

      while (lookahead < source.length && /\s/.test(source[lookahead])) {
        lookahead++;
      }

      const identifier = source.slice(index, end);

      if ((previous === "{" || previous === ",") && source[lookahead] === ":") {
        result += `"${identifier}"`;
      } else {
        result += identifier;
      }

      index = end - 1;
      continue;
    }

    result += character;
  }

  return result;
}

function lastNonWhitespace(value: string): string | null {
  for (let index = value.length - 1; index >= 0; index--) {
    if (!/\s/.test(value[index])) {
      return value[index];
    }
  }

  return null;
}

function expandBindings(
  template: string,
  scope: Record<string, TemplateValue>,
  preserveUnsupported = false,
  escapeValues = true,
): string {
  let output = "";
  let cursor = 0;

  while (cursor < template.length) {
    const expressionStart = template.indexOf("{", cursor);

    if (expressionStart < 0) {
      output += template.slice(cursor);
      break;
    }

    output += template.slice(cursor, expressionStart);
    const expressionEnd = findExpressionEnd(template, expressionStart);

    if (expressionEnd < 0) {
      throw new Error("The SVG template has an unterminated expression.");
    }

    const expression = template.slice(expressionStart + 1, expressionEnd);
    let renderedValue: string;

    try {
      const value = resolveExpression(expression, scope);
      const formatted = formatTemplateValue(value);
      renderedValue = escapeValues ? escapeXml(formatted) : formatted;
    } catch (error) {
      if (!preserveUnsupported) throw error;
      output += template.slice(expressionStart, expressionEnd + 1);
      cursor = expressionEnd + 1;
      continue;
    }

    const openingTagStart = template.lastIndexOf("<", expressionStart);
    const previousTagEnd = template.lastIndexOf(">", expressionStart);
    const isAttributeBinding =
      openingTagStart > previousTagEnd &&
      /(?:^|\s)[A-Za-z_:][\w:.-]*\s*=\s*$/.test(
        template.slice(openingTagStart + 1, expressionStart),
      );

    output += isAttributeBinding ? `"${renderedValue}"` : renderedValue;
    cursor = expressionEnd + 1;
  }

  return output;
}

function resolveExpression(
  source: string,
  scope: Record<string, TemplateValue>,
): TemplateValue {
  let expression = source.trim();

  if (hasWrappingParentheses(expression)) {
    expression = expression.slice(1, -1).trim();
  }

  if (expression.startsWith("`") && expression.endsWith("`")) {
    return expandTemplateLiteral(expression.slice(1, -1), scope);
  }

  const fromCharCode = expression.match(
    /^String\.fromCharCode\(([^,()]*)\)$/,
  );
  if (fromCharCode) {
    const code = resolveExpression(fromCharCode[1], scope);
    if (typeof code !== "number" || !Number.isInteger(code)) {
      throw new Error("String.fromCharCode only supports a static integer.");
    }
    return String.fromCharCode(code);
  }

  const stringCall = expression.match(/^String\(([^()]*)\)$/);
  if (stringCall) {
    return formatTemplateValue(resolveExpression(stringCall[1], scope));
  }

  const questionIndex = findTopLevelCharacter(expression, "?");

  if (questionIndex >= 0) {
    const colonIndex = findTopLevelCharacter(expression, ":", questionIndex + 1);

    if (colonIndex < 0) {
      throw new Error("The SVG template has an invalid conditional.");
    }

    const condition = resolveExpression(expression.slice(0, questionIndex), scope);
    const branch = isTruthy(condition)
      ? expression.slice(questionIndex + 1, colonIndex)
      : expression.slice(colonIndex + 1);

    return resolveExpression(branch, scope);
  }

  const logicalOr = findTopLevelOperator(expression, ["||"]);

  if (logicalOr) {
    const left = resolveExpression(expression.slice(0, logicalOr.index), scope);
    return isTruthy(left)
      ? true
      : isTruthy(resolveExpression(
        expression.slice(logicalOr.index + logicalOr.operator.length),
        scope,
      ));
  }

  const logicalAnd = findTopLevelOperator(expression, ["&&"]);

  if (logicalAnd) {
    const left = resolveExpression(expression.slice(0, logicalAnd.index), scope);
    return isTruthy(left)
      ? isTruthy(resolveExpression(
        expression.slice(logicalAnd.index + logicalAnd.operator.length),
        scope,
      ))
      : false;
  }

  const equalityOperator = findTopLevelOperator(expression, ["===", "!=="]);

  if (equalityOperator) {
    const left = resolveExpression(
      expression.slice(0, equalityOperator.index),
      scope,
    );
    const right = resolveExpression(
      expression.slice(equalityOperator.index + equalityOperator.operator.length),
      scope,
    );

    if (
      (typeof left === "object" && left !== null) ||
      (typeof right === "object" && right !== null)
    ) {
      throw new Error("The SVG template only supports scalar equality.");
    }

    const equal = left === right;
    return equalityOperator.operator === "===" ? equal : !equal;
  }

  const relationalOperator = findTopLevelOperator(expression, [">=", "<=", ">", "<"]);

  if (relationalOperator) {
    const left = resolveExpression(
      expression.slice(0, relationalOperator.index),
      scope,
    );
    const right = resolveExpression(
      expression.slice(relationalOperator.index + relationalOperator.operator.length),
      scope,
    );
    let comparison: number;

    if (typeof left === "number" && typeof right === "number") {
      comparison = left - right;
    } else if (typeof left === "string" && typeof right === "string") {
      comparison = left < right ? -1 : left > right ? 1 : 0;
    } else {
      throw new Error("The template only supports comparisons between like scalars.");
    }

    switch (relationalOperator.operator) {
      case ">=": return comparison >= 0;
      case "<=": return comparison <= 0;
      case ">": return comparison > 0;
      case "<": return comparison < 0;
    }
  }

  if (expression.startsWith('"') && expression.endsWith('"')) {
    return JSON.parse(expression) as string;
  }

  if (expression === "true") return true;
  if (expression === "false") return false;
  if (expression === "null") return null;

  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(expression)) {
    const number = Number(expression);

    if (!Number.isFinite(number)) {
      throw new Error("The SVG template has a non-finite number.");
    }

    return number;
  }

  const additionIndex = findTopLevelCharacter(expression, "+");

  if (additionIndex >= 0) {
    const left = resolveExpression(expression.slice(0, additionIndex), scope);
    const right = resolveExpression(expression.slice(additionIndex + 1), scope);

    if (typeof left !== "number" || typeof right !== "number") {
      throw new Error("The SVG template only supports numeric addition.");
    }

    return left + right;
  }

  const subtractionIndex = findTopLevelCharacter(expression, "-", 1);

  if (subtractionIndex >= 0) {
    const left = resolveExpression(expression.slice(0, subtractionIndex), scope);
    const right = resolveExpression(expression.slice(subtractionIndex + 1), scope);

    if (typeof left !== "number" || typeof right !== "number") {
      throw new Error("The SVG template only supports numeric subtraction.");
    }

    return left - right;
  }

  const multiplicationIndex = findTopLevelCharacter(expression, "*");

  if (multiplicationIndex >= 0) {
    const left = resolveExpression(expression.slice(0, multiplicationIndex), scope);
    const right = resolveExpression(expression.slice(multiplicationIndex + 1), scope);

    if (typeof left !== "number" || typeof right !== "number") {
      throw new Error("The SVG template only supports numeric multiplication.");
    }

    return left * right;
  }

  const divisionIndex = findTopLevelCharacter(expression, "/");

  if (divisionIndex >= 0) {
    const left = resolveExpression(expression.slice(0, divisionIndex), scope);
    const right = resolveExpression(expression.slice(divisionIndex + 1), scope);

    if (typeof left !== "number" || typeof right !== "number" || right === 0) {
      throw new Error("The SVG template only supports valid numeric division.");
    }

    return left / right;
  }

  const rootMatch = expression.match(/^([A-Za-z_$][\w$]*)/);
  let value: TemplateValue | undefined;
  let offset: number;

  if (expression.startsWith("[")) {
    const arrayEnd = findMatchingDelimiter(expression, 0, "[", "]");
    if (arrayEnd < 0) throw new Error("The template has an invalid array literal.");
    value = parseArrayLiteral(expression.slice(0, arrayEnd + 1));
    offset = arrayEnd + 1;
  } else if (rootMatch) {
    value = scope[rootMatch[1]];
    offset = rootMatch[1].length;
  } else {
    throw new Error("The template uses an unsupported expression.");
  }

  if (value === undefined) {
    throw new Error("The template references an unknown value.");
  }

  while (offset < expression.length) {
    if (expression[offset] === ".") {
      const propertyMatch = expression.slice(offset + 1).match(/^([A-Za-z_$][\w$]*)/);

      if (!propertyMatch || value === null) {
        throw new Error("The template has an invalid property access.");
      }

      const property = propertyMatch[1];

      if (property === "length" && (Array.isArray(value) || typeof value === "string")) {
        value = value.length;
        offset += property.length + 1;
        continue;
      }

      if (typeof value !== "object") {
        throw new Error("The template has an invalid property access.");
      }

      if (property === "join" && Array.isArray(value)) {
        const callStart = offset + property.length + 1;
        if (expression[callStart] !== "(") {
          throw new Error("The template has an invalid join call.");
        }
        const callEnd = findMatchingDelimiter(expression, callStart, "(", ")");
        if (callEnd < 0) throw new Error("The template has an unterminated join call.");
        const separatorSource = expression.slice(callStart + 1, callEnd).trim();
        const separator = separatorSource
          ? resolveExpression(separatorSource, scope)
          : ",";
        if (typeof separator !== "string") {
          throw new Error("The template join separator must be a string.");
        }
        value = value.map(formatTemplateValue).join(separator);
        offset = callEnd + 1;
        continue;
      }

      if (!Object.prototype.hasOwnProperty.call(value, property)) {
        throw new Error("The template references a missing property.");
      }

      value = (value as Record<string, TemplateValue>)[property];
      offset += property.length + 1;
      continue;
    }

    if (expression[offset] === "[") {
      const accessEnd = findMatchingDelimiter(expression, offset, "[", "]");
      if (accessEnd < 0 || !Array.isArray(value)) {
        throw new Error("The template has an invalid array access.");
      }

      const index = resolveExpression(expression.slice(offset + 1, accessEnd), scope);
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
        throw new Error("The template array index must be a nonnegative integer.");
      }
      const item: TemplateValue | undefined = value[index];

      if (item === undefined) {
        throw new Error("The template references a missing array item.");
      }

      value = item;
      offset = accessEnd + 1;
      continue;
    }

    throw new Error("The template uses an unsupported property path.");
  }

  if (value === undefined) {
    throw new Error("The SVG template resolved to a missing value.");
  }

  return value;
}

function hasWrappingParentheses(expression: string): boolean {
  if (!expression.startsWith("(")) return false;
  return findMatchingDelimiter(expression, 0, "(", ")") === expression.length - 1;
}

function findMatchingDelimiter(
  source: string,
  start: number,
  open: string,
  close: string,
): number {
  if (source[start] !== open) return -1;

  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;

  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === open) {
      depth++;
    } else if (character === close) {
      depth--;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function expandTemplateLiteral(
  template: string,
  scope: Record<string, TemplateValue>,
): string {
  let output = "";
  let cursor = 0;

  while (cursor < template.length) {
    if (template[cursor] === "\\" && cursor + 1 < template.length) {
      const escaped = template[cursor + 1];
      const decoded = escaped === "n"
        ? "\n"
        : escaped === "r"
          ? "\r"
          : escaped === "t"
            ? "\t"
            : escaped;
      output += decoded;
      cursor += 2;
      continue;
    }

    if (template[cursor] === "$" && template[cursor + 1] === "{") {
      const expressionStart = cursor + 1;
      const expressionEnd = findExpressionEnd(template, expressionStart);

      if (expressionEnd < 0) {
        throw new Error("The SVG template has an unterminated interpolation.");
      }

      const expression = template.slice(expressionStart + 1, expressionEnd);
      output += formatTemplateValue(resolveExpression(expression, scope));
      cursor = expressionEnd + 1;
      continue;
    }

    output += template[cursor];
    cursor++;
  }

  return output;
}

function findTopLevelCharacter(
  expression: string,
  target: string,
  startAt = 0,
): number {
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  let depth = 0;

  for (let index = startAt; index < expression.length; index++) {
    const character = expression[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }

      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "[" || character === "(" || character === "{") {
      depth++;
    } else if (character === "]" || character === ")" || character === "}") {
      depth--;
    } else if (character === target && depth === 0) {
      return index;
    }
  }

  return -1;
}

function findTopLevelOperator(
  expression: string,
  operators: string[],
): { operator: string; index: number } | null {
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  let depth = 0;

  for (let index = 0; index < expression.length; index++) {
    const character = expression[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }

      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }

    if (character === "[" || character === "(" || character === "{") {
      depth++;
      continue;
    }

    if (character === "]" || character === ")" || character === "}") {
      depth--;
      continue;
    }

    if (depth === 0) {
      const operator = operators.find((candidate) =>
        expression.startsWith(candidate, index),
      );

      if (operator) return { operator, index };
    }
  }

  return null;
}

function isTruthy(value: TemplateValue): boolean {
  if (value === null || value === false || value === 0 || value === "") {
    return false;
  }

  return true;
}

function formatTemplateValue(value: TemplateValue): string {
  if (value === null) return "";

  if (typeof value === "object") {
    throw new Error("The SVG template cannot render a non-scalar value.");
  }

  return String(value);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function tokenizeSvg(source: string): SvgToken[] | null {
  const tokens: SvgToken[] = [];
  let offset = 0;

  while (offset < source.length) {
    if (source.startsWith("<!--", offset)) {
      const commentEnd = source.indexOf("-->", offset + 4);

      if (commentEnd < 0) return null;
      offset = commentEnd + 3;
      continue;
    }

    if (source[offset] !== "<") {
      const nextTag = source.indexOf("<", offset);
      const end = nextTag < 0 ? source.length : nextTag;
      tokens.push({ type: "text", text: source.slice(offset, end) });
      offset = end;
      continue;
    }

    let end = offset + 1;
    let quote: '"' | "'" | null = null;

    while (end < source.length) {
      const character = source[end];

      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }

      end++;
    }

    if (end >= source.length || quote) return null;

    const rawTag = source.slice(offset + 1, end).trim();
    const closing = rawTag.startsWith("/");
    const tagBody = closing ? rawTag.slice(1).trim() : rawTag;
    const nameMatch = tagBody.match(/^([A-Za-z][\w:-]*)/);

    if (!nameMatch) return null;

    const name = nameMatch[1].toLowerCase();
    let attributes = tagBody.slice(nameMatch[0].length);
    const selfClosing = !closing && /\/\s*$/.test(attributes);

    if (selfClosing) {
      attributes = attributes.replace(/\/\s*$/, "");
    }

    if (closing && attributes.trim() !== "") return null;

    tokens.push({
      type: closing ? "close" : "open",
      name,
      attributes,
      selfClosing,
    });
    offset = end + 1;
  }

  return tokens;
}

function parseSvgAttributes(source: string): Array<[string, string]> | null {
  const attributes: Array<[string, string]> = [];
  let offset = 0;

  while (offset < source.length) {
    while (offset < source.length && /\s/.test(source[offset])) offset++;
    if (offset >= source.length) break;

    const nameMatch = source.slice(offset).match(/^([A-Za-z_:][\w:.-]*)/);

    if (!nameMatch) return null;

    const name = nameMatch[1];
    offset += name.length;

    while (offset < source.length && /\s/.test(source[offset])) offset++;
    if (source[offset] !== "=") return null;
    offset++;

    while (offset < source.length && /\s/.test(source[offset])) offset++;
    const quote = source[offset];

    if (quote !== '"' && quote !== "'") return null;

    const valueStart = ++offset;

    while (offset < source.length && source[offset] !== quote) offset++;
    if (offset >= source.length) return null;

    attributes.push([name, decodeXmlEntities(source.slice(valueStart, offset))]);
    offset++;
  }

  return attributes;
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (_entity, name: string) => {
      const normalized = name.toLowerCase();

      if (normalized === "amp") return "&";
      if (normalized === "lt") return "<";
      if (normalized === "gt") return ">";
      if (normalized === "quot") return '"';
      if (normalized === "apos") return "'";
      if (normalized.startsWith("#x")) {
        return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
      }
      return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
    },
  );
}

function sanitizeStaticSvg(source: string, backgroundColor = "#ffffff"): string | null {
  const tokens = tokenizeSvg(source);

  if (!tokens) return null;

  const stack: string[] = [];
  const body: string[] = [];
  let rootAttributes: Map<string, string> | null = null;
  let rootClosed = false;
  let elementCount = 0;

  for (const token of tokens) {
    if (token.type === "text") {
      const text = decodeXmlEntities(token.text ?? "");

      if (stack.length === 0) {
        if (text.trim() !== "") return null;
      } else if (stack.at(-1) === "style") {
        if (!isSafeSvgStyleSheet(text)) return null;
        body.push(escapeXml(text));
      } else {
        body.push(escapeXml(text));
      }

      continue;
    }

    const name = token.name;

    if (!name || !ALLOWED_ELEMENTS.has(name)) return null;

    if (token.type === "close") {
      if (stack.pop() !== name) return null;

      if (stack.length === 0) {
        if (name !== "svg") return null;
        rootClosed = true;
      } else {
        body.push(`</${SVG_ELEMENT_NAMES[name] ?? name}>`);
      }

      continue;
    }

    if (rootClosed) return null;
    elementCount++;
    if (elementCount > MAX_SVG_ELEMENTS) return null;

    const parsedAttributes = parseSvgAttributes(token.attributes ?? "");

    if (!parsedAttributes) return null;

    const cleanAttributes = new Map<string, string>();

    for (const [rawName, value] of parsedAttributes) {
      if (rawName.toLowerCase() === "key") continue;

      const jsxName = JSX_ATTRIBUTE_NAMES[rawName] ?? rawName;
      const name = SVG_ATTRIBUTE_CASE[jsxName.toLowerCase()] ?? jsxName;

      if (!ALLOWED_ATTRIBUTES.has(name)) return null;
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return null;
      if (value.length > MAX_TEMPLATE_LENGTH) return null;

      if (name === "style") {
        const safeStyle = sanitizeSvgStyle(value);
        if (safeStyle) cleanAttributes.set(name, safeStyle);
        continue;
      }

      if (!isSafeSvgAttributeValue(name, value)) return null;
      cleanAttributes.set(name, value);
    }

    if (stack.length === 0) {
      if (name !== "svg" || rootAttributes) return null;
      rootAttributes = cleanAttributes;

      if (token.selfClosing) return null;
      stack.push(name);
      continue;
    }

    const attributeText = [...cleanAttributes]
      .map(([attributeName, value]) => `${attributeName}="${escapeXml(value)}"`)
      .join(" ");
    const elementName = SVG_ELEMENT_NAMES[name] ?? name;
    const tag = `<${elementName}${attributeText ? ` ${attributeText}` : ""}${token.selfClosing ? "/>" : ">"}`;
    body.push(tag);

    if (!token.selfClosing) {
      stack.push(name);
    }
  }

  if (stack.length !== 0 || !rootClosed || !rootAttributes) return null;

  const viewBoxText = rootAttributes.get("viewBox");

  if (!viewBoxText) return null;

  const viewBox = parseViewBox(viewBoxText);

  if (!viewBox) return null;

  rootAttributes.set("xmlns", "http://www.w3.org/2000/svg");
  rootAttributes.set("width", String(viewBox.width));
  rootAttributes.set("height", String(viewBox.height));
  rootAttributes.set("color", backgroundColor === "#ffffff" ? "#222222" : "#f5f5f5");

  const rootAttributeText = [...rootAttributes]
    .map(([name, value]) => `${name}="${escapeXml(value)}"`)
    .join(" ");
  const background = `<rect x="${viewBox.minX}" y="${viewBox.minY}" width="${viewBox.width}" height="${viewBox.height}" fill="${escapeXml(backgroundColor)}"/>`;

  return `<svg ${rootAttributeText}>${background}${body.join("")}</svg>`;
}

function isSafeSvgAttributeValue(name: string, value: string): boolean {
  if (name === "xmlns") {
    return value === "http://www.w3.org/2000/svg";
  }
  if (name === "xmlns:xlink") {
    return value === "http://www.w3.org/1999/xlink";
  }
  if (name === "href" || name === "xlink:href") {
    return /^#[A-Za-z_][\w:.-]*$/.test(value.trim());
  }

  const urlReferences = [...value.matchAll(/url\s*\(([^)]*)\)/gi)];
  if (urlReferences.length > 0) {
    if (!LOCAL_REFERENCE_ATTRIBUTES.has(name)) return false;
    for (const reference of urlReferences) {
      const target = reference[1].trim().replace(/^(['"])(.*)\1$/, "$2");
      if (!/^#[A-Za-z_][\w:.-]*$/.test(target)) return false;
    }
    if (/url\s*\(/i.test(value.replace(/url\s*\([^)]*\)/gi, ""))) return false;
  }

  return !/javascript:|data:|https?:\/\/|@import|expression\s*\(|var\s*\(/i.test(value);
}

function sanitizeSvgStyle(style: string): string | null {
  const declarations: string[] = [];

  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;

    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (!SAFE_STYLE_PROPERTIES.has(property) || !value) continue;
    if (!isSafeSvgAttributeValue(property, value)) continue;

    declarations.push(`${property}:${value}`);
  }

  return declarations.length > 0 ? declarations.join(";") : null;
}

function isSafeSvgStyleSheet(source: string): boolean {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/\/\*/.test(css) || /@import|@font-face|expression\s*\(|var\s*\(/i.test(css)) {
    return false;
  }

  let cursor = 0;
  while (cursor < css.length) {
    while (cursor < css.length && /\s/.test(css[cursor])) cursor++;
    if (cursor >= css.length) break;

    const open = css.indexOf("{", cursor);
    const close = css.indexOf("}", cursor);
    if (open < 0 || close < 0 || close < open) return false;

    const selector = css.slice(cursor, open).trim();
    if (!selector || !/^[\w#.*:\s>+~(),\[\]="'-]+$/.test(selector)) return false;

    const declarations = css.slice(open + 1, close).split(";");
    for (const declaration of declarations) {
      if (!declaration.trim()) continue;
      const separator = declaration.indexOf(":");
      if (separator < 0) return false;
      const property = declaration.slice(0, separator).trim().toLowerCase();
      const value = declaration.slice(separator + 1).trim();
      if (!SAFE_STYLE_PROPERTIES.has(property) || !value) return false;
      if (!isSafeSvgAttributeValue(property, value)) return false;
    }

    cursor = close + 1;
  }

  return true;
}

function isSafeSvgImageSource(source: string): boolean {
  const tokens = tokenizeSvg(source);
  if (!tokens) return false;

  const blockedElements = new Set([
    "animate",
    "animatedraw",
    "animatemotion",
    "animatetransform",
    "discard",
    "embed",
    "feimage",
    "foreignobject",
    "iframe",
    "image",
    "object",
    "script",
    "set",
    "video",
  ]);
  const stack: string[] = [];
  let rootSeen = false;
  let rootClosed = false;
  let elementCount = 0;

  for (const token of tokens) {
    if (token.type === "text") {
      const text = token.text ?? "";
      if (stack.length === 0 && text.trim()) return false;
      if (stack.at(-1) === "style" && !isSafeSvgStyleSheet(text)) return false;
      continue;
    }

    const name = token.name;
    if (!name || !ALLOWED_ELEMENTS.has(name) || blockedElements.has(name)) return false;

    if (token.type === "close") {
      if (stack.pop() !== name) return false;
      if (stack.length === 0) {
        if (name !== "svg") return false;
        rootClosed = true;
      }
      continue;
    }

    if (rootClosed || ++elementCount > MAX_SVG_ELEMENTS) return false;
    if (!rootSeen) {
      if (name !== "svg") return false;
      rootSeen = true;
    }

    const attributes = parseSvgAttributes(token.attributes ?? "");
    if (!attributes) return false;

    for (const [attributeName, value] of attributes) {
      const normalizedName = attributeName.toLowerCase();
      if (normalizedName.startsWith("on")) return false;
      if (normalizedName === "style") {
        if (!isSafeInlineSvgStyle(value)) return false;
      } else if (!isSafeSvgAttributeValue(normalizedName, value)) {
        return false;
      }
    }

    if (token.selfClosing) {
      if (stack.length === 0) {
        if (name !== "svg") return false;
        rootClosed = true;
      }
    } else {
      stack.push(name);
    }
  }

  return rootSeen && rootClosed && stack.length === 0;
}

function isSafeInlineSvgStyle(style: string): boolean {
  const declarations = style.split(";").filter((declaration) => declaration.trim());
  for (const declaration of declarations) {
    const separator = declaration.indexOf(":");
    if (separator < 0) return false;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (!SAFE_STYLE_PROPERTIES.has(property) || !value) return false;
    if (!isSafeSvgAttributeValue(property, value)) return false;
  }
  return true;
}

function renderSvgImageDataUrlToPngBase64(
  dataUrl: string,
  source: string,
  backgroundColor: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const image = new Image();
    let timeoutId = 0;
    const finish = (result: string | null): void => {
      clearTimeout(timeoutId);
      image.onload = null;
      image.onerror = null;
      resolve(result);
    };

    image.onload = () => {
      try {
        const viewBoxText = source.match(/\bviewBox\s*=\s*(['"])([^'"]+)\1/i)?.[2];
        const viewBox = viewBoxText ? parseViewBox(viewBoxText) : null;
        const width = viewBox?.width ?? image.naturalWidth;
        const height = viewBox?.height ?? image.naturalHeight;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          finish(null);
          return;
        }

        const scale = Math.min(
          2,
          MAX_RENDERED_DIMENSION / width,
          MAX_RENDERED_DIMENSION / height,
          Math.sqrt(MAX_RENDERED_PIXELS / (width * height)),
        );
        if (!Number.isFinite(scale) || scale < 0.05) {
          finish(null);
          return;
        }

        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext("2d");
        if (!context) {
          finish(null);
          return;
        }

        context.fillStyle = backgroundColor;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL("image/png");
        const prefix = "data:image/png;base64,";
        if (!data.startsWith(prefix)) {
          finish(null);
          return;
        }

        const base64 = data.slice(prefix.length);
        finish(base64.length <= MAX_PNG_BASE64_LENGTH ? base64 : null);
      } catch {
        finish(null);
      }
    };
    image.onerror = () => finish(null);
    timeoutId = window.setTimeout(() => finish(null), 5_000);
    image.src = dataUrl;
  });
}

function parseViewBox(value: string): ViewBox | null {
  const parts = value
    .trim()
    .split(/[\s,]+/)
    .map((part) => Number(part));

  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isFinite(part)) ||
    parts[2] <= 0 ||
    parts[3] <= 0
  ) {
    return null;
  }

  return { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] };
}

async function renderSvgToPngBase64(
  svg: string,
  backgroundColor = "#ffffff",
): Promise<string | null> {
  const viewBoxMatch = svg.match(/\bviewBox="([^"]+)"/);
  const viewBox = viewBoxMatch ? parseViewBox(viewBoxMatch[1]) : null;

  if (!viewBox) return null;

  const scale = Math.min(
    2,
    MAX_RENDERED_DIMENSION / viewBox.width,
    MAX_RENDERED_DIMENSION / viewBox.height,
    Math.sqrt(MAX_RENDERED_PIXELS / (viewBox.width * viewBox.height)),
  );

  if (!Number.isFinite(scale) || scale < 0.05) return null;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewBox.width * scale));
  canvas.height = Math.max(1, Math.round(viewBox.height * scale));

  const context = canvas.getContext("2d");

  if (!context) return null;

  context.fillStyle = backgroundColor;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const objectUrl = URL.createObjectURL(
    new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
  );

  try {
    const image = new Image();
    const loaded = new Promise<boolean>((resolve) => {
      image.onload = () => resolve(true);
      image.onerror = () => resolve(false);
    });
    image.src = objectUrl;

    if (!(await loaded)) return null;

    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/png");

    const prefix = "data:image/png;base64,";

    if (!dataUrl.startsWith(prefix)) return null;

    const base64 = dataUrl.slice(prefix.length);
    return base64.length <= MAX_PNG_BASE64_LENGTH ? base64 : null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
