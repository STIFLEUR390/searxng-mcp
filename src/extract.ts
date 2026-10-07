/**
 * HTML content extraction with structural filtering.
 *
 * Fetches a page, strips chrome (headers, footers, navigation, sidebars,
 * cookie banners, ads, ...), detects the main content area and renders clean,
 * agent-friendly text. Every removal decision is reported back so the calling
 * agent knows what was filtered out.
 *
 * Uses node-html-parser (small, zero-dependency DOM subset).
 */

import { parse, type HTMLElement, type Node } from "node-html-parser";

export interface ExtractOptions {
  /** Keep the site <header>/[role=banner] blocks. Default: false (removed). */
  includeHeader?: boolean;
  /** Keep the site <footer>/[role=contentinfo] blocks. Default: false (removed). */
  includeFooter?: boolean;
  /** Keep <nav>/menus/breadcrumbs. Default: false (removed). */
  includeNavigation?: boolean;
  /** Keep <aside>/sidebars/widgets. Default: false (removed). */
  includeSidebar?: boolean;
  /** Keep comment sections (disqus, replies, ...). Default: false (removed). */
  includeComments?: boolean;
  /** Render links as markdown [text](url). Default: false (plain text). */
  includeLinks?: boolean;
  /** Render images as markdown ![alt](src). Default: false. */
  includeImages?: boolean;
  /**
   * Extract only the main content area (article/main/[role=main]) when one can
   * be detected. Default: true. Set false to render the whole cleaned body.
   */
  contentOnly?: boolean;
  /** Advanced: extract only nodes matching this CSS selector (CSS3 subset). */
  selector?: string;
  /** Max content length in characters (default 20000, max 200000). */
  maxLength?: number;
}

export interface ExtractResult {
  url: string;
  title: string;
  description?: string;
  lang?: string;
  content: string;
  truncated: boolean;
  /** Human-readable list of section kinds that were removed. */
  removed: string[];
  originalLength: number;
}

export class ExtractError extends Error {
  override name = "ExtractError";
}

export interface FetchDeps {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
  /** Reject HTML bodies larger than this (default 5 MiB). */
  maxHtmlBytes?: number;
}

const DEFAULT_MAX_LENGTH = 20_000;
const MAX_LENGTH_CAP = 200_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_HTML_BYTES = 5 * 1024 * 1024;
const USER_AGENT = "searxng-mcp/1.0 (+https://github.com/STIFLEUR390/searxng-mcp)";

/** Tags dropped unconditionally (never useful as content). */
const ALWAYS_DROP = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "object",
  "embed",
  "form",
  "button",
  "input",
  "select",
  "textarea",
  "canvas",
  "video",
  "audio",
  "dialog",
  "head",
  "meta",
  "link",
]);

/** Class/id tokens of clutter removed regardless of options. */
const NOISE_TOKENS = new Set([
  "cookie",
  "cookies",
  "consent",
  "gdpr",
  "captcha",
  "popup",
  "pop-up",
  "modal",
  "overlay",
  "newsletter",
  "subscribe",
  "subscription",
  "advert",
  "advertisement",
  "ads",
  "ad",
  "adsense",
  "promo",
  "promoted",
  "sponsored",
  "paywall",
  "skiplink",
  "skip-link",
]);

type Section = "header" | "footer" | "navigation" | "sidebar" | "comments";

const SECTION_LABELS: Record<Section, string> = {
  header: "site header",
  footer: "site footer",
  navigation: "navigation / menus",
  sidebar: "sidebars / widgets",
  comments: "comment sections",
};

const SECTION_TOKENS: Record<Section, Set<string>> = {
  header: new Set(["header", "masthead", "topbar", "top-bar", "siteheader", "site-header", "banner"]),
  navigation: new Set([
    "nav",
    "navbar",
    "nav-bar",
    "navigation",
    "menu",
    "menubar",
    "menu-bar",
    "mainmenu",
    "main-menu",
    "topnav",
    "top-nav",
    "breadcrumb",
    "breadcrumbs",
    "toc",
    "tabs",
  ]),
  footer: new Set(["footer", "sitefooter", "site-footer", "colophon", "footerlinks", "footer-links"]),
  sidebar: new Set(["sidebar", "side-bar", "sidenav", "side-nav", "sidepanel", "side-panel", "aside", "widget", "widgets"]),
  comments: new Set(["comments", "comment", "disqus", "replies", "reply-list", "discussion"]),
};

const SECTION_TAGS: Record<string, Section> = {
  header: "header",
  footer: "footer",
  nav: "navigation",
  aside: "sidebar",
};

const SECTION_ROLES: Record<string, Section> = {
  banner: "header",
  navigation: "navigation",
  menu: "navigation",
  menubar: "navigation",
  contentinfo: "footer",
  complementary: "sidebar",
};

const SECTION_OPTIONS: Record<Section, keyof ExtractOptions> = {
  header: "includeHeader",
  footer: "includeFooter",
  navigation: "includeNavigation",
  sidebar: "includeSidebar",
  comments: "includeComments",
};

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "html",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "ul",
]);

function tokenize(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function classify(el: HTMLElement): Section | null {
  const tag = (el.tagName ?? "").toLowerCase();
  const byTag = SECTION_TAGS[tag];
  if (byTag) return byTag;

  const role = (el.getAttribute("role") ?? "").toLowerCase();
  const byRole = SECTION_ROLES[role];
  if (byRole) return byRole;

  const tokens = new Set([
    ...tokenize(el.getAttribute("id")),
    ...tokenize(el.getAttribute("class")),
  ]);
  // Section match only for layout-ish containers to limit false positives.
  if (tag === "div" || tag === "section" || tag === "ul" || tag === "ol" || tag === "form" || tag === "span") {
    for (const [section, sectionTokens] of Object.entries(SECTION_TOKENS)) {
      for (const token of tokens) {
        if (sectionTokens.has(token)) return section as Section;
      }
    }
  }
  return null;
}

/** Remove chrome from the DOM in place. Records what was removed. */
function cleanDom(root: HTMLElement, opts: ExtractOptions, removed: Set<Section>): void {
  // 1. Always-drop tags and hidden nodes.
  for (const el of root.querySelectorAll([...ALWAYS_DROP].join(","))) {
    el.remove();
  }
  for (const el of root.querySelectorAll("[aria-hidden='true']")) {
    el.remove();
  }

  // 2. Structural sections + noise, unless the caller opted in.
  const candidates = root.querySelectorAll("header, footer, nav, aside, div, section, ul, ol, form, span, [role]");
  for (const el of candidates) {
    const tokens = new Set([...tokenize(el.getAttribute("id")), ...tokenize(el.getAttribute("class"))]);
    let drop = false;

    const section = classify(el);
    if (section && opts[SECTION_OPTIONS[section]] !== true) {
      drop = true;
      removed.add(section);
    }
    if (!drop && tokens.size > 0) {
      for (const token of tokens) {
        if (NOISE_TOKENS.has(token)) {
          drop = true;
          break;
        }
      }
    }
    if (drop) el.remove();
  }
}

function renderChildren(el: HTMLElement, opts: ExtractOptions): string {
  let out = "";
  for (const child of el.childNodes) {
    out += renderNode(child, opts);
  }
  return out;
}

function renderNode(node: Node, opts: ExtractOptions): string {
  const maybeEl = node as Partial<HTMLElement> & { text?: string };
  const tag = maybeEl.tagName;

  // Text node.
  if (typeof tag !== "string" || tag === "") {
    return typeof maybeEl.text === "string" ? maybeEl.text : "";
  }
  // Comments and processing instructions.
  if (node.nodeType !== 1) return "";

  const el = node as HTMLElement;
  const upper = tag.toUpperCase();
  if (ALWAYS_DROP.has(upper.toLowerCase()) || upper === "TITLE") return "";

  if (upper === "IMG") {
    if (!opts.includeImages) return "";
    const src = el.getAttribute("src") ?? "";
    if (!src) return "";
    return `\n![${el.getAttribute("alt") ?? ""}](${src})\n`;
  }
  if (upper === "BR") return "\n";
  if (upper === "HR") return "\n---\n";

  if (upper === "PRE") {
    return `\n\`\`\`\n${(el.textContent ?? "").trim()}\n\`\`\`\n`;
  }

  const inner = renderChildren(el, opts);

  if (upper === "A") {
    const href = el.getAttribute("href") ?? "";
    const text = inner.trim();
    if (!text) return "";
    if (opts.includeLinks && href && !href.startsWith("javascript:") && !href.startsWith("#")) {
      return `[${text}](${href})`;
    }
    return text;
  }
  if (/^H[1-6]$/.test(upper)) {
    const level = Number(upper[1] ?? "1");
    return `\n\n${"#".repeat(level)} ${inner.trim()}\n\n`;
  }
  if (upper === "LI") return `\n- ${inner.trim()}`;
  if (upper === "TD" || upper === "TH") return ` ${inner.trim()} |`;
  if (upper === "TR") return `\n|${inner.trim()}`;
  if (BLOCK_TAGS.has(upper.toLowerCase())) return `\n${inner}\n`;
  return inner;
}

function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findContentRoot(root: HTMLElement): HTMLElement {
  const body = root.querySelector("body") ?? root;
  let best: HTMLElement | null = null;
  let bestLen = 0;
  for (const el of body.querySelectorAll("article, main, [role='main']")) {
    const len = (el.textContent ?? "").length;
    if (len > bestLen) {
      best = el;
      bestLen = len;
    }
  }
  if (best && bestLen > 200) return best;
  return body;
}

/**
 * Pure extraction from an HTML string. Fetch separately with fetchAndExtract.
 */
export function extractFromHtml(html: string, url: string, opts: ExtractOptions = {}): ExtractResult {
  const root = parse(html, {
    lowerCaseTagName: true,
    comment: false,
    // pre:false -> parse code blocks as DOM so markup inside does not leak as text.
    blockTextElements: { script: false, noscript: false, style: false, pre: false },
  });

  const title = (root.querySelector("title")?.text ?? "").trim();
  const description =
    root.querySelector("meta[name='description']")?.getAttribute("content")?.trim() ||
    root.querySelector("meta[property='og:description']")?.getAttribute("content")?.trim() ||
    undefined;
  const lang = root.querySelector("html")?.getAttribute("lang")?.trim() || undefined;

  const removed = new Set<Section>();
  cleanDom(root, opts, removed);

  let scope: HTMLElement;
  if (opts.selector) {
    const matches = root.querySelectorAll(opts.selector);
    if (matches.length === 0) {
      throw new ExtractError(
        `No element matches selector "${opts.selector}" on ${url}. ` +
          `Try a simpler selector (e.g. "article", ".post-content") or remove the selector option.`,
      );
    }
    const parts = matches.map((m) => renderNode(m, opts));
    const content = normalizeText(parts.join("\n\n"));
    return finish(url, title, description, lang, content, removed, opts);
  }

  if (opts.contentOnly !== false) {
    scope = findContentRoot(root);
  } else {
    scope = root.querySelector("body") ?? root;
  }
  const content = normalizeText(renderNode(scope, opts));
  return finish(url, title, description, lang, content, removed, opts);
}

function finish(
  url: string,
  title: string,
  description: string | undefined,
  lang: string | undefined,
  content: string,
  removed: Set<Section>,
  opts: ExtractOptions,
): ExtractResult {
  const maxLength = Math.min(opts.maxLength ?? DEFAULT_MAX_LENGTH, MAX_LENGTH_CAP);
  const originalLength = content.length;
  let truncated = false;
  let finalContent = content;
  if (content.length > maxLength) {
    truncated = true;
    finalContent = `${content.slice(0, maxLength).trimEnd()}\n\n[... truncated at ${maxLength} characters — raise max_length to get more]`;
  }
  return {
    url,
    title,
    description,
    lang,
    content: finalContent,
    truncated,
    removed: [...removed].map((s) => SECTION_LABELS[s]),
    originalLength,
  };
}

/** Fetch a page and extract filtered content from it. */
export async function fetchAndExtract(
  url: string,
  opts: ExtractOptions = {},
  deps: FetchDeps = {},
): Promise<ExtractResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ExtractError(`Invalid URL: "${url}". Expected an absolute http(s) URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ExtractError(`Unsupported protocol "${parsed.protocol}" in ${url}. Only http(s) is supported.`);
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = deps.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchFn(parsed, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": deps.userAgent ?? USER_AGENT,
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new ExtractError(`Fetching ${url} timed out after ${timeoutMs}ms.`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ExtractError(`Could not fetch ${url}: ${message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new ExtractError(
      `Fetching ${url} failed: HTTP ${res.status} ${res.statusText}. ` +
        `The page may block bots, require JavaScript, or be behind authentication.`,
    );
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType && !/html|xml/i.test(contentType) && !/text\//i.test(contentType)) {
    throw new ExtractError(
      `Refusing to extract from ${url}: content-type "${contentType}" is not HTML.`,
    );
  }

  const contentLength = Number(res.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) {
    throw new ExtractError(
      `Refusing to extract from ${url}: content-length ${contentLength} exceeds the ${maxBytes} byte limit.`,
    );
  }

  const html = await res.text();
  if (html.length > maxBytes) {
    throw new ExtractError(
      `Refusing to extract from ${url}: body is larger than the ${maxBytes} byte limit.`,
    );
  }

  return extractFromHtml(html, url, opts);
}
