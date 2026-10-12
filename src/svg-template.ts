/**
 * Convert boxed SVG diagrams embedded in ChatGPT message Markdown into
 * self-contained PNG assets. Unsupported or unsafe diagrams remain intact.
 */
const SVG_PATTERN = /<svg\b[\s\S]*?<\/svg>/gi;
const FENCED_CODE_PATTERN = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\n|$)/gm;
const EACH_OPEN_TOKEN = "{#each";
const EACH_CLOSE_TOKEN = "{/each}";
const IF_OPEN_TOKEN = "{#if";
const IF_CLOSE_TOKEN = "{/if}";

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
 * Turns ChatGPT's boxed, Svelte-style SVG snippets into PNG assets or short
 * text placeholders. Unsupported snippets become readable text fallbacks.
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
      output.push("[Diagram]");
      continue;
    }

    try {
      const canvasBackgroundColor = getDarkSvgBackgroundColor(backgroundColor);
      const staticSvg = compileStaticSvg(svgTemplate, canvasBackgroundColor);

      if (!staticSvg) {
        output.push(svgToReadableFallback(svgTemplate));
        continue;
      }

      const base64 = await renderSvgToPngBase64(staticSvg, canvasBackgroundColor);

      if (!base64) {
        output.push(svgToReadableFallback(svgTemplate));
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
      // Do not leak unsupported JSX/Svelte markup into the exported Markdown.
      output.push(svgToReadableFallback(svgTemplate));
    }
  }

  output.push(maskedMarkdown.slice(cursor));

  return {
    markdown: restoreCodeBlocks(output.join(""), placeholderPrefix, codeBlocks),
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

function svgToReadableFallback(svg: string): string {
  const labels = [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text\s*>/gi)]
    .map((match) => decodeXmlEntities(match[1]
      .replace(/<tspan\b[^>]*>|<\/tspan\s*>/gi, "")
      .replace(/<[^>]+>/g, "")
      // A failed template expansion must not expose raw bindings such as
      // `{p.t}` in the fallback text shown to the user.
      .replace(/\{\s*[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)+\s*\}/g, "")
      .replace(/\s+/g, " ")
      .trim()))
    .filter(Boolean);

  return labels.length > 0
    ? `[Diagram: ${labels.join(" · ")}]`
    : "[Diagram could not be rendered]";
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

  let expanded = maskedMarkdown;
  try {
    expanded = expandEachBlocks(maskedMarkdown, {}, { loopCount: 0 }, true, false);
  } catch {
    // Preserve unsupported source markup rather than dropping user content.
  }

  // Some numbered grids only become plain text after their ChatGPT component
  // wrappers are removed. Normalize those sequences after both component-grid
  // conversion and tag cleanup so the row structure is still recognizable.
  const normalizedComponents = normalizeComponentTags(
    normalizeGridBlocks(expanded),
  );
  return restoreCodeBlocks(
    normalizeLinearizedPathCards(
      normalizeLinearizedSequenceGrids(normalizedComponents),
    ),
    placeholderPrefix,
    codeBlocks,
  );
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

    output.push(table);
    cursor = end + 1;
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

    if (name === "svg") {
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
    const openIsIf = ifStart >= 0 && (openStart < 0 || ifStart < openStart);
    const nextOpen = openIsIf ? ifStart : openStart;
    const unexpectedClose = [eachClose, ifClose]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? -1;

    if (nextOpen < 0) {
      if (unexpectedClose >= 0) {
        throw new Error("The template has an unmatched block directive.");
      }

      const remaining = template.slice(cursor);
      append(Object.keys(scope).length === 0
        ? remaining
        : expandBindings(remaining, scope, preserveUnsupportedBindings, escapeBindings));
      cursor = template.length;
      break;
    }

    if (unexpectedClose >= 0 && unexpectedClose < nextOpen) {
      throw new Error("The template has an unmatched block directive.");
    }

    const preceding = template.slice(cursor, nextOpen);
    append(Object.keys(scope).length === 0
      ? preceding
      : expandBindings(preceding, scope, preserveUnsupportedBindings, escapeBindings));

    const blockType = openIsIf ? "if" : "each";
    const openEnd = findExpressionEnd(template, nextOpen);

    if (openEnd < 0) {
      throw new Error("The template has an unterminated block directive.");
    }

    const closeStart = findMatchingBlockClose(template, openEnd + 1, blockType);

    if (closeStart < 0) {
      throw new Error("The template has an unterminated block directive.");
    }

    const body = template.slice(openEnd + 1, closeStart);
    state.loopCount++;

    if (state.loopCount > 200) {
      throw new Error("The template has too many block directives.");
    }

    if (blockType === "if") {
      const condition = template.slice(nextOpen + IF_OPEN_TOKEN.length, openEnd);
      const selectedBody = isTruthy(resolveExpression(condition, scope))
        ? body
        : "";
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
        throw new Error("The template has an invalid each block.");
      }

      const source = headerMatch[1].trim();
      const itemName = headerMatch[2];
      const indexName = headerMatch[3];
      const items = resolveLoopItems(source, scope);

      if (items.length > MAX_LOOP_ITEMS) {
        throw new Error("The template loop is too large.");
      }
      if (items.length * body.length > MAX_EXPANDED_TEMPLATE_LENGTH) {
        throw new Error("The expanded template is too large.");
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

    cursor = closeStart + EACH_CLOSE_TOKEN.length;
    if (blockType === "if") {
      cursor = closeStart + IF_CLOSE_TOKEN.length;
    }
  }

  return output.join("");
}

function findMatchingBlockClose(
  template: string,
  bodyStart: number,
  rootType: "each" | "if",
): number {
  const stack: Array<"each" | "if"> = [rootType];
  let cursor = bodyStart;

  while (cursor < template.length) {
    const openStart = template.indexOf(EACH_OPEN_TOKEN, cursor);
    const ifStart = template.indexOf(IF_OPEN_TOKEN, cursor);
    const eachClose = template.indexOf(EACH_CLOSE_TOKEN, cursor);
    const ifClose = template.indexOf(IF_CLOSE_TOKEN, cursor);
    const nextOpen = [openStart, ifStart]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? -1;
    const nextClose = [eachClose, ifClose]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? -1;

    if (nextClose < 0) return -1;

    if (nextOpen >= 0 && nextOpen < nextClose) {
      const nestedType = nextOpen === ifStart ? "if" : "each";
      const openEnd = findExpressionEnd(template, nextOpen);
      if (openEnd < 0) return -1;
      stack.push(nestedType);
      cursor = openEnd + 1;
      continue;
    }

    const closeType = nextClose === ifClose ? "if" : "each";
    if (stack.pop() !== closeType) return -1;

    if (stack.length === 0) return nextClose;
    cursor = nextClose + (closeType === "if" ? IF_CLOSE_TOKEN.length : EACH_CLOSE_TOKEN.length);
  }

  return -1;
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
