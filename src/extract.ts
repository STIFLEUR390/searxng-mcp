/**
 * Content extraction with structural filtering (HTML, JSON, plain text).
 *
 * Fetches a page, strips chrome (headers, footers, navigation, sidebars,
 * cookie banners, ads, ...), detects the main content area with Mozilla
 * Readability and renders it as Markdown with Turndown — the same stack the
 * clipper.js CLI uses. Every removal decision is reported back so the calling
 * agent knows what was filtered out. JSON and plain-text bodies are returned
 * as fenced blocks; binary bodies are refused.
 *
 * Uses linkedom for the DOM (no jsdom, no headless browser).
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

import { ipv4Fallback, type FetchFn } from "./client.ts";

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
  /** Start the output window at this character offset of the cleaned content (default 0). */
  startChar?: number;
  /** Return only the heading outline (h1–h6) instead of the full text. Default false. */
  headingsOnly?: boolean;
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
  /** Character offset the returned window starts at (start_char, default 0). */
  startChar: number;
}

export class ExtractError extends Error {
  override name = "ExtractError";
}

export interface FetchDeps {
  fetchFn?: FetchFn;
  timeoutMs?: number;
  userAgent?: string;
  /** Reject HTML bodies larger than this (default 5 MiB). */
  maxHtmlBytes?: number;
  /** Remote CDP browser endpoint (ws:// or http://) used to render HTML pages. */
  browserUrl?: string;
  /** Renderer override (tests); used instead of the CDP browser when browserUrl is set. */
  renderHtml?: (url: string) => Promise<string>;
}

const DEFAULT_MAX_LENGTH = 20_000;
const MAX_LENGTH_CAP = 200_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_HEADINGS = 200;
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

function tokenize(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function classify(el: Element): Section | null {
  const tag = (el.tagName ?? "").toLowerCase();
  const byTag = SECTION_TAGS[tag];
  if (byTag) return byTag;

  const role = (el.getAttribute("role") ?? "").toLowerCase();
  const byRole = SECTION_ROLES[role];
  if (byRole) return byRole;

  const tokens = new Set([...tokenize(el.getAttribute("id")), ...tokenize(el.getAttribute("class"))]);
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
function cleanDom(root: Element, opts: ExtractOptions, removed: Set<Section>): void {
  // 1. Always-drop tags and hidden nodes.
  for (const el of root.querySelectorAll([...ALWAYS_DROP].join(","))) {
    el.remove();
  }
  for (const el of root.querySelectorAll("[aria-hidden='true']")) {
    el.remove();
  }

  // 2. Structural sections + noise, unless the caller opted in.
  const bodyLen = (root.textContent ?? "").length;
  const candidates = root.querySelectorAll("header, footer, nav, aside, div, section, ul, ol, form, span, [role]");
  for (const el of candidates) {
    const tokens = new Set([...tokenize(el.getAttribute("id")), ...tokenize(el.getAttribute("class"))]);
    let drop = false;

    const section = classify(el);
    if (section && opts[SECTION_OPTIONS[section]] !== true) {
      // A class token can land on a layout wrapper by accident (e.g. a CSS var
      // named --banner-height): never drop an element holding most of the page.
      const tag = (el.tagName ?? "").toLowerCase();
      const strong = SECTION_TAGS[tag] !== undefined || SECTION_ROLES[(el.getAttribute("role") ?? "").toLowerCase()] !== undefined;
      if (strong || (el.textContent ?? "").length <= bodyLen * 0.6) {
        drop = true;
        removed.add(section);
      }
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

/** Turndown instance matching the requested link/image handling. */
function createTurndown(opts: ExtractOptions): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
  });
  if (!opts.includeLinks) {
    td.addRule("plainLinks", {
      filter: (node) => node.nodeName === "A",
      replacement: (content) => content,
    });
  }
  td.addRule("images", {
    filter: "img",
    replacement: (_content, node) => {
      if (!opts.includeImages) return "";
      const el = node as Element;
      const src = el.getAttribute("src") ?? "";
      if (!src) return "";
      return `![${el.getAttribute("alt") ?? ""}](${src})`;
    },
  });
  return td;
}

/** Render an HTML fragment as normalized Markdown. */
function toMarkdown(html: string, opts: ExtractOptions): string {
  return normalizeText(createTurndown(opts).turndown(html));
}

function findContentRoot(body: Element): Element {
  let best: Element | null = null;
  let bestLen = 0;
  for (const el of body.querySelectorAll("article, main, [role='main']")) {
    const len = (el.textContent ?? "").length;
    if (len > bestLen) {
      best = el;
      bestLen = len;
    }
  }
  return best ?? body;
}

/** Main-content HTML via Readability, or null when it finds nothing usable. */
function readArticle(document: Document): string | null {
  try {
    const article = new Readability(document.cloneNode(true) as Document).parse();
    const content = typeof article?.content === "string" ? article.content : "";
    return content.trim() ? content : null;
  } catch {
    // Readability is best-effort: fall back to the article/main heuristic.
    return null;
  }
}

/** Whether `el` is `ancestor` or lives inside it. */
function isWithin(el: Element, ancestor: Element): boolean {
  let cur: Element | null = el;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parentElement;
  }
  return false;
}

/**
 * Sections kept via include_* that sit outside the extraction scope (typical:
 * nav/header/footer live outside <main>) are rendered and appended, so the
 * opt-in is honored even with the default content_only scope.
 */
function renderKeptOutsideScope(root: Element, scope: Element, opts: ExtractOptions): string[] {
  const wanted = (Object.keys(SECTION_OPTIONS) as Section[]).filter((s) => opts[SECTION_OPTIONS[s]] === true);
  if (wanted.length === 0) return [];
  const candidates = root.querySelectorAll("header, footer, nav, aside, div, section, ul, ol, form, span, [role]");
  const appended: Element[] = [];
  const parts: string[] = [];
  for (const el of candidates) {
    const section = classify(el);
    if (!section || !wanted.includes(section)) continue;
    // Skip sections inside the scope (already rendered) and ancestors of it
    // (would duplicate the scope content).
    if (isWithin(el, scope) || isWithin(scope, el)) continue;
    if (appended.some((a) => isWithin(el, a))) continue;
    appended.push(el);
    const md = toMarkdown(el.outerHTML, opts);
    if (md) parts.push(md);
  }
  return parts;
}

interface Heading {
  level: number;
  text: string;
}

/** Collect h1–h6 in document order (removed chrome is already detached). */
function collectHeadings(node: Element, out: Heading[]): void {
  for (const child of node.children) {
    const tag = (child.tagName ?? "").toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      const text = normalizeText(child.textContent ?? "");
      if (text) out.push({ level: Number(tag.slice(1)), text });
      continue;
    }
    collectHeadings(child, out);
  }
}

/**
 * Pure extraction from an HTML string. Fetch separately with fetchAndExtract.
 */
export function extractFromHtml(html: string, url: string, opts: ExtractOptions = {}): ExtractResult {
  const { document } = parseHTML(html);

  const title = (document.querySelector("title")?.textContent ?? "").trim();
  const description =
    document.querySelector("meta[name='description']")?.getAttribute("content")?.trim() ||
    document.querySelector("meta[property='og:description']")?.getAttribute("content")?.trim() ||
    undefined;
  const lang = document.querySelector("html")?.getAttribute("lang")?.trim() || undefined;

  const body = document.body;
  const removed = new Set<Section>();
  if (!body) {
    return finish(url, title, description, lang, "", removed, opts);
  }
  cleanDom(body, opts, removed);

  if (opts.headingsOnly) {
    const headings: Heading[] = [];
    collectHeadings(body, headings);
    const shown = headings.slice(0, MAX_HEADINGS);
    let outline = shown.map((h) => `${"#".repeat(h.level)} ${h.text}`).join("\n");
    if (headings.length > shown.length) {
      outline += `\n\n[… ${headings.length - shown.length} more headings omitted]`;
    }
    return finish(url, title, description, lang, outline || "(no headings found)", removed, opts);
  }

  if (opts.selector) {
    const matches = body.querySelectorAll(opts.selector);
    if (matches.length === 0) {
      throw new ExtractError(
        `No element matches selector "${opts.selector}" on ${url}. ` +
          `Try a simpler selector (e.g. "article", ".post-content") or remove the selector option.`,
      );
    }
    const content = Array.from(matches)
      .map((m) => toMarkdown(m.outerHTML, opts))
      .filter(Boolean)
      .join("\n\n");
    return finish(url, title, description, lang, content, removed, opts);
  }

  let content: string;
  if (opts.contentOnly !== false) {
    const scope = findContentRoot(body);
    const articleHtml = readArticle(document);
    content = toMarkdown(articleHtml ?? scope.outerHTML, opts);
    for (const kept of renderKeptOutsideScope(body, scope, opts)) {
      // Readability sometimes returns chrome the scope check cannot see.
      if (!content.includes(kept)) content = `${content}\n\n${kept}`;
    }
  } else {
    content = toMarkdown(body.outerHTML, opts);
  }
  return finish(url, title, description, lang, content, removed, opts);
}

interface WindowedText {
  windowed: string;
  truncated: boolean;
  startChar: number;
  originalLength: number;
}

/** Apply start_char + max_length to a text block. */
function applyWindow(text: string, opts: ExtractOptions, inlineNotice: boolean): WindowedText {
  const maxLength = Math.min(opts.maxLength ?? DEFAULT_MAX_LENGTH, MAX_LENGTH_CAP);
  const originalLength = text.length;
  const startChar = Math.min(Math.max(Math.trunc(opts.startChar ?? 0), 0), originalLength);
  const rest = text.slice(startChar);
  if (rest.length > maxLength) {
    return {
      windowed: inlineNotice
        ? `${rest.slice(0, maxLength).trimEnd()}\n\n[... truncated at ${maxLength} characters — raise max_length to get more]`
        : rest.slice(0, maxLength).trimEnd(),
      truncated: true,
      startChar,
      originalLength,
    };
  }
  return { windowed: rest, truncated: false, startChar, originalLength };
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
  const { windowed, truncated, startChar, originalLength } = applyWindow(content, opts, true);
  return {
    url,
    title,
    description,
    lang,
    content: windowed,
    truncated,
    removed: [...removed].map((s) => SECTION_LABELS[s]),
    originalLength,
    startChar,
  };
}

/** Render non-HTML bodies (JSON, plain text, ...) as fenced blocks. */
function renderPlainBody(body: string, url: string, opts: ExtractOptions, kind: "json" | "text"): ExtractResult {
  let pretty = body;
  if (kind === "json") {
    try {
      pretty = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      // keep the raw body when it is not valid JSON
    }
  }
  const { windowed, truncated, startChar, originalLength } = applyWindow(pretty, opts, false);
  const fenceLang = kind === "json" && pretty !== body ? "json" : "";
  let content = "```" + fenceLang + "\n" + windowed + "\n```";
  if (truncated) {
    const end = startChar + windowed.length;
    content += `\n\n[... truncated: showing characters ${startChar}–${end} of ${originalLength} — raise max_length to get more]`;
  }
  return {
    url,
    title: "",
    content,
    truncated,
    removed: [],
    originalLength,
    startChar,
  };
}

/** Connection options for a remote browser endpoint (ws:// = CDP socket, http:// = devtools HTTP). */
export function browserConnectOptions(endpoint: string): { browserWSEndpoint: string } | { browserURL: string } {
  const url = endpoint.trim();
  if (/^wss?:\/\//i.test(url)) return { browserWSEndpoint: url };
  if (/^https?:\/\//i.test(url)) return { browserURL: url };
  throw new ExtractError(`Invalid browser URL "${endpoint}". Use ws://host:port (CDP) or http://host:port.`);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Render a page in a remote CDP browser (Obscura, Chrome --remote-debugging-port) and return its HTML. */
async function renderWithBrowser(url: string, endpoint: string, timeoutMs: number, maxBytes: number): Promise<string> {
  const connectOptions = browserConnectOptions(endpoint);
  let puppeteer: typeof import("puppeteer-core");
  try {
    puppeteer = await import("puppeteer-core");
  } catch {
    throw new ExtractError(
      `Browser rendering is configured (${endpoint}) but "puppeteer-core" is not installed. ` +
        `Install it (bun add puppeteer-core) or unset the browser URL.`,
    );
  }
  let browser: Awaited<ReturnType<typeof puppeteer.connect>>;
  try {
    browser = await puppeteer.connect(connectOptions);
  } catch (err) {
    throw new ExtractError(`Could not connect to the browser at ${endpoint}: ${describeError(err)}`);
  }
  try {
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
      // Let late XHR/fetch content settle, without failing when the page keeps a socket open.
      await page.waitForNetworkIdle({ idleTime: 300, timeout: Math.min(timeoutMs, 5000) }).catch(() => {});
    } catch (err) {
      throw new ExtractError(`Rendering ${url} in the browser failed: ${describeError(err)}`);
    }
    const html = await page.content();
    if (html.length > maxBytes) {
      throw new ExtractError(`Refusing to extract from ${url}: rendered HTML exceeds the ${maxBytes} byte limit.`);
    }
    return html;
  } finally {
    await browser.disconnect().catch(() => {});
  }
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
  const browserUrl = deps.browserUrl?.trim() || undefined;
  const viaBrowser = browserUrl
    ? async (): Promise<ExtractResult> => {
        const html = deps.renderHtml
          ? await deps.renderHtml(url)
          : await renderWithBrowser(url, browserUrl, timeoutMs, maxBytes);
        return extractFromHtml(html, url, opts);
      }
    : null;

  // localhost may resolve to ::1 while the target listens on IPv4: retry once.
  const targets = [parsed, ipv4Fallback(parsed)].filter((u): u is URL => u !== null);
  let res: Response | null = null;
  let lastNetworkError: unknown = null;
  for (const target of targets) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await fetchFn(target, {
        method: "GET",
        headers: {
          Accept:
            "text/html,application/xhtml+xml,application/json,text/plain,application/xml;q=0.9,text/*;q=0.8,*/*;q=0.5",
          "User-Agent": deps.userAgent ?? USER_AGENT,
        },
        signal: controller.signal,
      });
      break;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new ExtractError(`Fetching ${url} timed out after ${timeoutMs}ms.`);
      }
      lastNetworkError = err;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!res) {
    if (viaBrowser) return viaBrowser();
    const message = lastNetworkError instanceof Error ? lastNetworkError.message : String(lastNetworkError);
    throw new ExtractError(`Could not fetch ${url}: ${message}`);
  }

  if (!res.ok) {
    // A rendered page often gets through where the plain fetch is blocked.
    if (viaBrowser) return viaBrowser();
    throw new ExtractError(
      `Fetching ${url} failed: HTTP ${res.status} ${res.statusText}. ` +
        `The page may block bots, require JavaScript, or be behind authentication.`,
    );
  }

  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

  if (viaBrowser && (!contentType || /html|xml/.test(contentType))) return viaBrowser();

  const contentLength = Number(res.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) {
    throw new ExtractError(
      `Refusing to extract from ${url}: content-length ${contentLength} exceeds the ${maxBytes} byte limit.`,
    );
  }

  const body = await res.text();
  if (body.length > maxBytes) {
    throw new ExtractError(`Refusing to extract from ${url}: body is larger than the ${maxBytes} byte limit.`);
  }

  if (contentType.includes("json")) {
    return renderPlainBody(body, url, opts, "json");
  }
  if (contentType && !/html|xml/.test(contentType)) {
    if (contentType.startsWith("text/")) {
      return renderPlainBody(body, url, opts, "text");
    }
    throw new ExtractError(
      `Refusing to extract from ${url}: content-type "${contentType}" is not supported. ` +
        `HTML, JSON and plain-text bodies are supported; binary files (PDF, images, archives) are not.`,
    );
  }
  return extractFromHtml(body, url, opts);
}
