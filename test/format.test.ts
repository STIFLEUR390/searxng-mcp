import { describe, expect, test } from "bun:test";

import {
  filterByDomains,
  formatAutocomplete,
  formatConfig,
  formatSearchResponse,
  matchesDomain,
  truncate,
} from "../src/format.ts";
import type { SearXNGResult, SearXNGSearchResponse } from "../src/types.ts";

function makeResult(overrides: Partial<SearXNGResult> = {}): SearXNGResult {
  return {
    url: "https://example.org/page",
    title: "Example page",
    content: "Some snippet about the page.",
    engine: "duckduckgo",
    engines: ["duckduckgo", "brave"],
    category: "general",
    ...overrides,
  };
}

function makeResponse(overrides: Partial<SearXNGSearchResponse> = {}): SearXNGSearchResponse {
  return { query: "test", results: [makeResult()], ...overrides };
}

describe("truncate", () => {
  test("leaves short text alone", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  test("cuts long text with an ellipsis", () => {
    const out = truncate("x".repeat(50), 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
  });

  test("collapses whitespace", () => {
    expect(truncate("a   b\n\tc", 100)).toBe("a b c");
  });
});

describe("matchesDomain / filterByDomains", () => {
  test("exact host and subdomains match", () => {
    expect(matchesDomain("https://www.wikipedia.org/wiki/X", ["wikipedia.org"])).toBe(true);
    expect(matchesDomain("https://wikipedia.org/x", ["wikipedia.org"])).toBe(true);
    expect(matchesDomain("https://notwikipedia.org/x", ["wikipedia.org"])).toBe(false);
  });

  test("patterns may include protocol and path", () => {
    expect(matchesDomain("https://github.com/foo/bar", ["https://github.com/anything"])).toBe(true);
  });

  test("include filter keeps only matching domains", () => {
    const results = [
      makeResult({ url: "https://a.org/1" }),
      makeResult({ url: "https://b.org/2" }),
    ];
    const out = filterByDomains(results, ["a.org"], undefined);
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBe("https://a.org/1");
  });

  test("exclude filter drops matching domains", () => {
    const results = [
      makeResult({ url: "https://a.org/1" }),
      makeResult({ url: "https://b.org/2" }),
    ];
    const out = filterByDomains(results, undefined, ["b.org"]);
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBe("https://a.org/1");
  });
});

describe("formatSearchResponse", () => {
  test("renders results with title, url, snippet and metadata", () => {
    const text = formatSearchResponse(makeResponse(), { limit: 5 });
    expect(text).toContain('# Search results ("test")');
    expect(text).toContain("1. Example page");
    expect(text).toContain("https://example.org/page");
    expect(text).toContain("Some snippet about the page.");
    expect(text).toContain("engines: duckduckgo, brave");
    expect(text).toContain("category: general");
    expect(text).toContain("1 of 1 results");
  });

  test("respects the limit and mentions remaining results", () => {
    const results = Array.from({ length: 15 }, (_, i) => makeResult({ url: `https://e.org/${i}` }));
    const text = formatSearchResponse(makeResponse({ results }), { limit: 3 });
    expect(text).toContain("3 of 15 results");
    expect(text).toContain("12 more results on this page");
    expect(text).not.toContain("https://e.org/14");
  });

  test("renders answers, corrections, suggestions and unresponsive engines", () => {
    const text = formatSearchResponse(
      makeResponse({
        answers: ["42"],
        corrections: ["did you mean searxng"],
        suggestions: ["searxng docker", "searxng api"],
        unresponsive_engines: [["brave", "too many requests"]],
      }),
    );
    expect(text).toContain("## Answer\n42");
    expect(text).toContain("did you mean searxng");
    expect(text).toContain("- searxng docker");
    expect(text).toContain("brave (too many requests)");
  });

  test("renders infoboxes", () => {
    const text = formatSearchResponse(
      makeResponse({
        infoboxes: [
          {
            infobox: "SearXNG",
            content: "Metasearch engine",
            attributes: [{ key: "Developer", value: "community" }],
            urls: [{ title: "Website", url: "https://searxng.org" }],
          },
        ],
      }),
    );
    expect(text).toContain("### SearXNG");
    expect(text).toContain("- Developer: community");
    expect(text).toContain("Website: https://searxng.org");
  });

  test("empty results message", () => {
    const text = formatSearchResponse(makeResponse({ results: [] }));
    expect(text).toContain('No results found for "test".');
  });

  test("images kind includes image and thumbnail URLs", () => {
    const text = formatSearchResponse(
      makeResponse({
        results: [
          makeResult({
            category: "images",
            img_src: "https://img.example.org/full.jpg",
            thumbnail: "https://img.example.org/thumb.jpg",
          }),
        ],
      }),
      { kind: "images" },
    );
    expect(text).toContain("image: https://img.example.org/full.jpg");
    expect(text).toContain("thumbnail: https://img.example.org/thumb.jpg");
    expect(text).toContain('"test", images');
  });

  test("reports filtered totals", () => {
    const text = formatSearchResponse(makeResponse(), {
      totalBeforeFilter: 20,
    });
    expect(text).toContain("filtered from 20");
  });
});

describe("formatAutocomplete", () => {
  test("lists suggestions", () => {
    expect(formatAutocomplete("sea", ["searxng", "search"])).toBe(
      'Suggestions for "sea":\n- searxng\n- search',
    );
  });

  test("empty suggestions", () => {
    expect(formatAutocomplete("sea", [])).toBe('No suggestions for "sea".');
  });
});

describe("formatConfig", () => {
  test("groups enabled engines by category", () => {
    const text = formatConfig(
      {
        autocomplete: "duckduckgo",
        categories: ["general", "news"],
        engines: [
          { name: "Wikipedia", categories: ["general"], enabled: true },
          { name: "Bing News", categories: ["news"], enabled: true },
          { name: "Disabled Engine", categories: ["general"], enabled: false },
        ],
      },
      "http://localhost:8888",
    );
    expect(text).toContain("URL: http://localhost:8888");
    expect(text).toContain("Autocomplete provider: duckduckgo");
    expect(text).toContain("## Categories (2)");
    expect(text).toContain("Engines: 2 enabled of 3 total");
    expect(text).toContain("### general (1)\nWikipedia");
    expect(text).not.toContain("Disabled Engine");
  });

  test("includeEngines=false keeps counts but drops the engine lists", () => {
    const text = formatConfig(
      {
        autocomplete: "duckduckgo",
        categories: ["general"],
        engines: [{ name: "Wikipedia", categories: ["general"], enabled: true }],
      },
      "http://localhost:8888",
      { includeEngines: false },
    );
    expect(text).toContain("Engines: 1 enabled of 1 total");
    expect(text).not.toContain("### general");
    expect(text).not.toContain("Wikipedia");
  });
});
