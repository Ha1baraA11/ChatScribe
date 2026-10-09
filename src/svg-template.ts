/**
 * Convert boxed SVG diagrams embedded in ChatGPT message Markdown into
 * self-contained PNG assets. Unsupported or unsafe diagrams remain intact.
 */
const BOXED_SVG_PATTERN = /<box\b[^>]*>\s*(<svg\b[\s\S]*?<\/svg>)\s*<\/box>/gi;
const EACH_BLOCK_PATTERN = /\{#each\s+([\s\S]*?)\s+as\s+([A-Za-z_$][\w$]*)(?:\s*,\s*([A-Za-z_$][\w$]*))?\}([\s\S]*?)\{\/each\}/g;
const FENCED_CODE_PATTERN = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\n|$)/gm;

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

const ALLOWED_ATTRIBUTES = new Set([
  "aria-label",
  "color",
  "cx",
  "cy",
  "d",
  "fill",
  "fill-opacity",
  "fill-rule",
  "font-family",
  "font-size",
  "font-weight",
  "height",
  "opacity",
  "points",
  "preserveAspectRatio",
  "r",
  "role",
  "rx",
  "ry",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
  "transform",
  "viewBox",
  "width",
  "x",
  "x1",
  "x2",
  "y",
  "y1",
  "y2",
  "xmlns",
]);

const JSX_ATTRIBUTE_NAMES: Record<string, string> = {
  fillOpacity: "fill-opacity",
  fontFamily: "font-family",
  fontSize: "font-size",
  fontWeight: "font-weight",
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
 * Turns ChatGPT's boxed, Svelte-style SVG snippets into PNG assets or short
 * text placeholders. Unsupported or unsafe snippets are kept verbatim.
 */
export async function renderSvgTemplatesAsMarkdown(
  markdown: string,
  mode: SvgDiagramMode,
  firstAssetIndex = 1,
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

  const matches = [...maskedMarkdown.matchAll(BOXED_SVG_PATTERN)];

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
    const fullMatch = match[0];
    const svgTemplate = match[1];
    const start = match.index;

    if (!fullMatch || !svgTemplate || start === undefined) {
      continue;
    }

    output.push(maskedMarkdown.slice(cursor, start));
    cursor = start + fullMatch.length;

    if (mode === "text") {
      output.push("[Diagram]");
      continue;
    }

    try {
      const staticSvg = compileStaticSvg(svgTemplate);

      if (!staticSvg) {
        output.push(fullMatch);
        continue;
      }

      const base64 = await renderSvgToPngBase64(staticSvg);

      if (!base64) {
        output.push(fullMatch);
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
      // Keep unsupported templates exactly as the API returned them.
      output.push(fullMatch);
    }
  }

  output.push(maskedMarkdown.slice(cursor));

  return {
    markdown: restoreCodeBlocks(output.join(""), placeholderPrefix, codeBlocks),
    assets,
  };
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

function compileStaticSvg(svgTemplate: string): string | null {
  if (svgTemplate.length > MAX_TEMPLATE_LENGTH) {
    return null;
  }

  const rootMatch = svgTemplate.match(/^(<svg\b[^>]*>)([\s\S]*)(<\/svg>)$/i);

  if (!rootMatch) {
    return null;
  }

  let loopCount = 0;
  let expandedBody = rootMatch[2].replace(
    EACH_BLOCK_PATTERN,
    (_block, source: string, itemName: string, indexName: string | undefined, body: string) => {
      loopCount++;

      if (loopCount > 20) {
        throw new Error("The SVG template has too many loops.");
      }

      const items = parseArrayLiteral(source);

      if (items.length > MAX_LOOP_ITEMS) {
        throw new Error("The SVG template loop is too large.");
      }
      if (items.length * body.length > MAX_EXPANDED_TEMPLATE_LENGTH) {
        throw new Error("The expanded SVG template is too large.");
      }

      return items
        .map((item, index) => {
          const scope: Record<string, TemplateValue> = { [itemName]: item };

          if (indexName) {
            scope[indexName] = index;
          }

          return expandBindings(body, scope);
        })
        .join("");
    },
  );

  if (expandedBody.length > MAX_EXPANDED_TEMPLATE_LENGTH) {
    return null;
  }

  if (/\{#each\b|\{\/each\}|\{[^{}]*\}/.test(expandedBody)) {
    return null;
  }

  const openingTag = rootMatch[1].replace(/\s+key="[^"]*"/g, "");
  return sanitizeStaticSvg(`${openingTag}${expandedBody}${rootMatch[3]}`);
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
): string {
  const withAttributes = template.replace(
    /([A-Za-z_:][\w:.-]*)\s*=\s*\{([^{}]+)\}/g,
    (_match, name: string, expression: string) =>
      `${name}="${escapeXml(formatTemplateValue(resolveExpression(expression, scope)))}"`,
  );

  return withAttributes.replace(/\{([^{}]+)\}/g, (_match, expression: string) =>
    escapeXml(formatTemplateValue(resolveExpression(expression, scope))),
  );
}

function resolveExpression(
  source: string,
  scope: Record<string, TemplateValue>,
): TemplateValue {
  const expression = source.trim();
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

  const rootMatch = expression.match(/^([A-Za-z_$][\w$]*)/);

  if (!rootMatch) {
    throw new Error("The SVG template uses an unsupported expression.");
  }

  let value: TemplateValue | undefined = scope[rootMatch[1]];
  let offset = rootMatch[1].length;

  if (value === undefined) {
    throw new Error("The SVG template references an unknown value.");
  }

  while (offset < expression.length) {
    if (expression[offset] === ".") {
      const propertyMatch = expression.slice(offset + 1).match(/^([A-Za-z_$][\w$]*)/);

      if (!propertyMatch || value === null || typeof value !== "object") {
        throw new Error("The SVG template has an invalid property access.");
      }

      const property = propertyMatch[1];

      if (!Object.prototype.hasOwnProperty.call(value, property)) {
        throw new Error("The SVG template references a missing property.");
      }

      value = (value as Record<string, TemplateValue>)[property];
      offset += property.length + 1;
      continue;
    }

    if (expression[offset] === "[") {
      const indexMatch = expression.slice(offset).match(/^\[(\d+)\]/);

      if (!indexMatch || !Array.isArray(value)) {
        throw new Error("The SVG template has an invalid array access.");
      }

      const item: TemplateValue | undefined = value[Number(indexMatch[1])];

      if (item === undefined) {
        throw new Error("The SVG template references a missing array item.");
      }

      value = item;
      offset += indexMatch[0].length;
      continue;
    }

    throw new Error("The SVG template uses an unsupported property path.");
  }

  if (value === undefined) {
    throw new Error("The SVG template resolved to a missing value.");
  }

  return value;
}

function findTopLevelCharacter(
  expression: string,
  target: string,
  startAt = 0,
): number {
  let quote: '"' | "'" | null = null;
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

    if (character === '"' || character === "'") {
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

function sanitizeStaticSvg(source: string): string | null {
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
        body.push(`</${name}>`);
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

      const name = JSX_ATTRIBUTE_NAMES[rawName] ?? rawName;

      if (!ALLOWED_ATTRIBUTES.has(name)) return null;
      if (/url\s*\(|javascript:|data:/i.test(value)) return null;
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return null;
      if (value.length > MAX_TEMPLATE_LENGTH) return null;

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
    const tag = `<${name}${attributeText ? ` ${attributeText}` : ""}${token.selfClosing ? "/>" : ">"}`;
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
  rootAttributes.set("color", "#222222");

  const rootAttributeText = [...rootAttributes]
    .map(([name, value]) => `${name}="${escapeXml(value)}"`)
    .join(" ");
  const background = `<rect x="${viewBox.minX}" y="${viewBox.minY}" width="${viewBox.width}" height="${viewBox.height}" fill="#ffffff"/>`;

  return `<svg ${rootAttributeText}>${background}${body.join("")}</svg>`;
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

async function renderSvgToPngBase64(svg: string): Promise<string | null> {
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

  context.fillStyle = "#ffffff";
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
