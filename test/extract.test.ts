import { describe, expect, test } from "bun:test";

import { ExtractError, extractFromHtml, fetchAndExtract } from "../src/extract.ts";
import type { FetchFn } from "../src/client.ts";

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <title>My Article</title>
  <meta name="description" content="An article about testing">
  <script>console.log("tracking")</script>
  <style>.x { color: red }</style>
</head>
<body>
  <header class="site-header"><a href="/">MySite</a> Logo</header>
  <nav class="navbar"><ul><li><a href="/a">Menu A</a></li><li><a href="/b">Menu B</a></li></ul></nav>
  <div class="cookie-banner">We use cookies. Accept?</div>
  <main>
    <article>
      <h1>My Article</h1>
      <p>First paragraph of the real content.</p>
      <p>Second paragraph with a <a href="https://example.org/ref">reference link</a>.</p>
      <ul><li>Point one</li><li>Point two</li></ul>
      <pre><code>const x = 1;</code></pre>
    </article>
  </main>
  <aside class="sidebar"><h3>Related</h3><ul><li><a href="/r1">Related 1</a></li></ul></aside>
  <footer class="site-footer">Copyright 2026 MySite</footer>
  <div id="comments-section"><p>Nice article!</p></div>
</body>
</html>`;

describe("extractFromHtml", () => {
  test("captures metadata", () => {
    const result = extractFromHtml(PAGE, "https://mysite.org/article");
    expect(result.title).toBe("My Article");
    expect(result.description).toBe("An article about testing");
    expect(result.lang).toBe("en");
    expect(result.url).toBe("https://mysite.org/article");
  });

  test("removes header, nav, sidebar, footer, comments and noise by default", () => {
    const result = extractFromHtml(PAGE, "https://mysite.org/article");
    expect(result.content).toContain("First paragraph of the real content.");
    expect(result.content).not.toContain("MySite Logo");
    expect(result.content).not.toContain("Menu A");
    expect(result.content).not.toContain("Related 1");
    expect(result.content).not.toContain("Copyright 2026");
    expect(result.content).not.toContain("Nice article!");
    expect(result.content).not.toContain("We use cookies");
    expect(result.content).not.toContain("tracking");
    expect(result.removed).toContain("site header");
    expect(result.removed).toContain("navigation / menus");
    expect(result.removed).toContain("sidebars / widgets");
    expect(result.removed).toContain("site footer");
    expect(result.removed).toContain("comment sections");
  });

  test("links are plain text by default", () => {
    const result = extractFromHtml(PAGE, "https://mysite.org/article");
    expect(result.content).toContain("reference link");
    expect(result.content).not.toContain("[reference link]");
  });

  test("include_links renders markdown links", () => {
    const result = extractFromHtml(PAGE, "https://mysite.org/article", { includeLinks: true });
    expect(result.content).toContain("[reference link](https://example.org/ref)");
  });

  test("include options keep the requested sections", () => {
    const result = extractFromHtml(PAGE, "https://mysite.org/article", {
      includeHeader: true,
      includeNavigation: true,
      includeSidebar: true,
      includeFooter: true,
      contentOnly: false,
    });
    expect(result.content).toContain("MySite Logo");
    expect(result.content).toContain("Menu A");
    expect(result.content).toContain("Related 1");
    expect(result.content).toContain("Copyright 2026");
    expect(result.removed).not.toContain("site header");
    expect(result.removed).not.toContain("site footer");
  });

  test("contentOnly=false renders the whole cleaned body", () => {
    const result = extractFromHtml(PAGE, "https://mysite.org/article", { contentOnly: false });
    expect(result.content).toContain("First paragraph");
  });

  test("contentOnly picks the article area", () => {
    const result = extractFromHtml(PAGE, "https://mysite.org/article", { contentOnly: true });
    expect(result.content).toContain("My Article");
    expect(result.content).toContain("Point one");
  });

  test("code blocks keep their content without leaking tags", () => {
    const result = extractFromHtml(PAGE, "https://mysite.org/article");
    expect(result.content).toContain("const x = 1;");
    expect(result.content).not.toContain("<code>");
  });

  test("images are dropped by default and rendered as markdown when requested", () => {
    const html = `<html><body><article><p>Hi</p><img src="https://img.example.org/a.png" alt="A"></article></body></html>`;
    expect(extractFromHtml(html, "https://x.org/").content).not.toContain("img.example.org");
    const withImages = extractFromHtml(html, "https://x.org/", { includeImages: true });
    expect(withImages.content).toContain("![A](https://img.example.org/a.png)");
  });

  test("selector option extracts only matching nodes", () => {
    const html = `<html><body><div class="a"><p>AAA</p></div><div class="b"><p>BBB</p></div></body></html>`;
    const result = extractFromHtml(html, "https://x.org/", { selector: ".a" });
    expect(result.content).toContain("AAA");
    expect(result.content).not.toContain("BBB");
  });

  test("selector with no match throws a helpful error", () => {
    expect(() => extractFromHtml(PAGE, "https://x.org/", { selector: ".does-not-exist" })).toThrow(
      /No element matches selector/,
    );
  });

  test("max_length truncates with a notice", () => {
    const long = `<html><body><article>${"<p>wordy content here.</p>".repeat(50)}</article></body></html>`;
    const result = extractFromHtml(long, "https://x.org/", { maxLength: 500 });
    expect(result.truncated).toBe(true);
    expect(result.content).toContain("[... truncated at 500 characters");
    expect(result.content.length).toBeLessThan(700);
  });

  test("ExtractError for invalid selector is an ExtractError", () => {
    try {
      extractFromHtml(PAGE, "https://x.org/", { selector: ".nope" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractError);
    }
  });

  test("pre preserves entity-encoded text and strips real tags", () => {
    const html = `<html><body><article><pre>&lt;div class="x"&gt;visible&lt;/div&gt; and <b>real</b> tags</pre></article></body></html>`;
    const result = extractFromHtml(html, "https://x.org/");
    expect(result.content).toContain('<div class="x">visible</div>');
    expect(result.content).not.toContain("&lt;div");
    expect(result.content).not.toContain("<b>");
  });

  test("include options apply to sections outside the content scope", () => {
    const result = extractFromHtml(PAGE, "https://mysite.org/article", {
      includeHeader: true,
      includeNavigation: true,
      includeSidebar: true,
      includeFooter: true,
      includeComments: true,
    });
    // default contentOnly still scopes the article first
    expect(result.content).toContain("First paragraph of the real content.");
    // kept sections living outside <main> are appended, not lost
    expect(result.content).toContain("MySite Logo");
    expect(result.content).toContain("Menu A");
    expect(result.content).toContain("Related 1");
    expect(result.content).toContain("Copyright 2026");
    expect(result.content).toContain("Nice article!");
  });

  test("selector mode does not append kept sections outside the matches", () => {
    const result = extractFromHtml(PAGE, "https://mysite.org/article", {
      selector: "article",
      includeNavigation: true,
    });
    expect(result.content).toContain("First paragraph");
    expect(result.content).not.toContain("Menu A");
  });

  test("start_char windows the extracted content", () => {
    const full = extractFromHtml(PAGE, "https://mysite.org/article");
    const idx = full.content.indexOf("Second paragraph");
    expect(idx).toBeGreaterThan(0);
    const windowed = extractFromHtml(PAGE, "https://mysite.org/article", { startChar: idx });
    expect(windowed.content.startsWith("Second paragraph")).toBe(true);
    expect(windowed.content).not.toContain("First paragraph of the real content.");
    expect(windowed.startChar).toBe(idx);
    expect(windowed.originalLength).toBe(full.originalLength);
  });

  test("start_char past the end yields an empty window, not an error", () => {
    const result = extractFromHtml(PAGE, "https://mysite.org/article", { startChar: 10_000_000 });
    expect(result.content).toBe("");
    expect(result.startChar).toBe(result.originalLength);
  });

  test("headings_only returns the outline and skips removed chrome", () => {
    const result = extractFromHtml(PAGE, "https://mysite.org/article", { headingsOnly: true });
    expect(result.content).toContain("# My Article");
    expect(result.content).not.toContain("Related");
    expect(result.content).not.toContain("First paragraph");
  });

  test("headings_only reports no-headings pages gracefully", () => {
    const html = "<html><body><article><p>Text only</p></article></body></html>";
    const result = extractFromHtml(html, "https://x.org/", { headingsOnly: true });
    expect(result.content).toBe("(no headings found)");
  });
});

describe("fetchAndExtract", () => {
  const html = "<html><head><title>T</title></head><body><article><p>Body text</p></article></body></html>";

  function mockFetch(body: string, init: { status?: number; contentType?: string } = {}): FetchFn {
    return async () =>
      new Response(body, {
        status: init.status ?? 200,
        headers: { "Content-Type": init.contentType ?? "text/html; charset=utf-8" },
      });
  }

  test("fetches and extracts", async () => {
    const result = await fetchAndExtract("https://example.org/page", {}, { fetchFn: mockFetch(html) });
    expect(result.title).toBe("T");
    expect(result.content).toContain("Body text");
  });

  test("rejects invalid URLs", async () => {
    await expect(fetchAndExtract("not-a-url", {}, { fetchFn: mockFetch(html) })).rejects.toThrow(
      /Invalid URL/,
    );
  });

  test("rejects non-http protocols", async () => {
    await expect(fetchAndExtract("ftp://example.org/x", {}, { fetchFn: mockFetch(html) })).rejects.toThrow(
      /Unsupported protocol/,
    );
  });

  test("reports HTTP errors", async () => {
    await expect(
      fetchAndExtract("https://example.org/x", {}, { fetchFn: mockFetch("nope", { status: 404 }) }),
    ).rejects.toThrow(/HTTP 404/);
  });

  test("pretty-prints JSON bodies in a fenced block", async () => {
    const result = await fetchAndExtract(
      "https://example.org/api",
      {},
      { fetchFn: mockFetch('{"a":1,"b":[2,3]}', { contentType: "application/json" }) },
    );
    expect(result.content).toContain('```json');
    expect(result.content).toContain('"a": 1');
    expect(result.content).toContain('```');
    expect(result.removed).toEqual([]);
  });

  test("returns non-HTML text bodies as fenced text", async () => {
    const result = await fetchAndExtract(
      "https://example.org/notes.txt",
      {},
      { fetchFn: mockFetch("line one\nline two", { contentType: "text/plain; charset=utf-8" }) },
    );
    expect(result.content).toContain("```");
    expect(result.content).toContain("line one");
  });

  test("invalid JSON bodies fall back to the raw fenced body", async () => {
    const result = await fetchAndExtract(
      "https://example.org/api",
      {},
      { fetchFn: mockFetch("not-json{{", { contentType: "application/json" }) },
    );
    expect(result.content).toContain("not-json{{");
    expect(result.content).not.toContain("```json");
  });

  test("still refuses binary content types", async () => {
    await expect(
      fetchAndExtract(
        "https://example.org/file.pdf",
        {},
        { fetchFn: mockFetch("%PDF-1.7", { contentType: "application/pdf" }) },
      ),
    ).rejects.toThrow(/not supported/);
  });

  test("refuses oversized bodies", async () => {
    await expect(
      fetchAndExtract("https://example.org/big", {}, {
        fetchFn: mockFetch(html),
        maxHtmlBytes: 10,
      }),
    ).rejects.toThrow(/byte limit/);
  });
});
