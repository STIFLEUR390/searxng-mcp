import { describe, expect, test } from "bun:test";

import { SearXNGClient, SearXNGError, ipv4Fallback, type FetchFn } from "../src/client.ts";

interface MockCall {
  url: string;
  accept?: string | null;
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(
  responder: (url: URL) => { status?: number; body?: unknown; rawBody?: string },
): { fetchFn: FetchFn; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const fetchFn: FetchFn = async (input, init) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: url.toString(), accept: headers["Accept"] ?? null });
    const { status = 200, body, rawBody } = responder(url);
    const payload = rawBody ?? JSON.stringify(body ?? {});
    return new Response(payload, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchFn, calls };
}

const sampleResults = {
  query: "test",
  results: [
    {
      url: "https://en.wikipedia.org/wiki/Test",
      title: "Test",
      content: "Topics referred to by the same term",
      engine: "wikipedia",
      category: "general",
      engines: ["wikipedia"],
      publishedDate: null,
    },
  ],
};

describe("SearXNGClient.search", () => {
  test("builds the expected query string", async () => {
    const { fetchFn, calls } = mockFetch(() => ({ body: sampleResults }));
    const client = new SearXNGClient({ baseUrl: "http://localhost:8888", fetchFn });

    await client.search({
      q: "searxng mcp",
      categories: ["news", "videos"],
      language: "fr",
      pageno: 2,
      timeRange: "week",
      safesearch: 2,
      engines: ["duckduckgo", "brave"],
    });

    // time_range (including week) is forwarded verbatim.
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("http://localhost:8888/search");
    expect(url.searchParams.get("q")).toBe("searxng mcp");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("categories")).toBe("news,videos");
    expect(url.searchParams.get("language")).toBe("fr");
    expect(url.searchParams.get("pageno")).toBe("2");
    expect(url.searchParams.get("time_range")).toBe("week");
    expect(url.searchParams.get("safesearch")).toBe("2");
    expect(url.searchParams.get("engines")).toBe("duckduckgo,brave");
    expect(calls[0]!.accept).toBe("application/json");
  });

  test("omits default parameters", async () => {
    const { fetchFn, calls } = mockFetch(() => ({ body: sampleResults }));
    const client = new SearXNGClient({ baseUrl: "http://localhost:8888", fetchFn });
    await client.search({ q: "hello" });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("pageno")).toBeNull();
    expect(url.searchParams.get("categories")).toBeNull();
    expect(url.searchParams.get("time_range")).toBeNull();
    expect(url.searchParams.get("safesearch")).toBeNull();
  });

  test("rejects empty query", async () => {
    const client = new SearXNGClient({ baseUrl: "http://x", fetchFn: mockFetch(() => ({})).fetchFn });
    await expect(client.search({ q: "  " })).rejects.toThrow(SearXNGError);
  });

  test("rejects responses without a results array", async () => {
    const { fetchFn } = mockFetch(() => ({ body: { query: "x" } }));
    const client = new SearXNGClient({ baseUrl: "http://localhost:8888", fetchFn });
    await expect(client.search({ q: "x" })).rejects.toThrow(/missing "results" array/);
  });

  test("403 explains how to enable JSON format", async () => {
    const { fetchFn } = mockFetch(() => ({ status: 403, rawBody: "forbidden" }));
    const client = new SearXNGClient({ baseUrl: "http://localhost:8888", fetchFn });
    await expect(client.search({ q: "x" })).rejects.toThrow(/formats: \[html, json\]/);
  });

  test("429 explains the rate limiter", async () => {
    const { fetchFn } = mockFetch(() => ({ status: 429, rawBody: "slow down" }));
    const client = new SearXNGClient({ baseUrl: "http://localhost:8888", fetchFn });
    await expect(client.search({ q: "x" })).rejects.toThrow(/limiter/);
  });

  test("network errors mention the base URL", async () => {
    const fetchFn: FetchFn = async () => {
      throw new TypeError("fetch failed");
    };
    const client = new SearXNGClient({ baseUrl: "http://localhost:8888", fetchFn });
    await expect(client.search({ q: "x" })).rejects.toThrow(/Could not reach SearXNG at http:\/\/localhost:8888/);
  });

  test("invalid JSON body is reported", async () => {
    const { fetchFn } = mockFetch(() => ({ rawBody: "<html>oops</html>" }));
    const client = new SearXNGClient({ baseUrl: "http://localhost:8888", fetchFn });
    await expect(client.search({ q: "x" })).rejects.toThrow(/invalid JSON/);
  });

  test("normalizes trailing slashes in the base URL", async () => {
    const { fetchFn, calls } = mockFetch(() => ({ body: sampleResults }));
    const client = new SearXNGClient({ baseUrl: "http://localhost:8888///", fetchFn });
    await client.search({ q: "x" });
    expect(calls[0]!.url.startsWith("http://localhost:8888/search?")).toBe(true);
  });
});

describe("SearXNGClient.autocomplete", () => {
  test("parses the SearXNG tuple format", async () => {
    const { fetchFn } = mockFetch(() => ({
      body: ["sear", ["searxng", "search engine"], [], [], {}],
    }));
    const client = new SearXNGClient({ baseUrl: "http://localhost:8888", fetchFn });
    expect(await client.autocomplete("sear")).toEqual(["searxng", "search engine"]);
  });

  test("parses a flat string array", async () => {
    const { fetchFn } = mockFetch(() => ({ body: ["alpha", "beta"] }));
    const client = new SearXNGClient({ baseUrl: "http://localhost:8888", fetchFn });
    expect(await client.autocomplete("a")).toEqual(["alpha", "beta"]);
  });

  test("returns empty list for unexpected shapes", async () => {
    const { fetchFn } = mockFetch(() => ({ body: { not: "an array" } }));
    const client = new SearXNGClient({ baseUrl: "http://localhost:8888", fetchFn });
    expect(await client.autocomplete("a")).toEqual([]);
  });

  test("forwards the language parameter when provided", async () => {
    const { fetchFn, calls } = mockFetch(() => ({ body: ["bonj", ["bonjour"]] }));
    const client = new SearXNGClient({ baseUrl: "http://localhost:8888", fetchFn });
    await client.autocomplete("bonj", "fr");
    expect(new URL(calls[0]!.url).searchParams.get("language")).toBe("fr");
  });

  test("omits the language parameter when not provided", async () => {
    const { fetchFn, calls } = mockFetch(() => ({ body: [] }));
    const client = new SearXNGClient({ baseUrl: "http://localhost:8888", fetchFn });
    await client.autocomplete("bonj");
    expect(new URL(calls[0]!.url).searchParams.get("language")).toBeNull();
  });
});

describe("ipv4Fallback", () => {
  test("rewrites localhost and ::1 to 127.0.0.1", () => {
    expect(ipv4Fallback(new URL("http://localhost:8888/search"))?.toString()).toBe(
      "http://127.0.0.1:8888/search",
    );
    expect(ipv4Fallback(new URL("http://[::1]:8888/"))?.toString()).toBe("http://127.0.0.1:8888/");
  });

  test("leaves other hosts alone", () => {
    expect(ipv4Fallback(new URL("https://searx.example.org/"))).toBeNull();
    expect(ipv4Fallback(new URL("http://127.0.0.1:8888/"))).toBeNull();
  });
});

describe("SearXNGClient IPv4 fallback", () => {
  test("retries on 127.0.0.1 when localhost connection fails", async () => {
    const tried: string[] = [];
    const fetchFn: FetchFn = async (input) => {
      const url = new URL(String(input));
      tried.push(url.hostname);
      if (url.hostname === "localhost") throw new TypeError("fetch failed");
      return jsonResponse({ query: "x", results: [] });
    };
    const client = new SearXNGClient({ baseUrl: "http://localhost:8888", fetchFn });
    const resp = await client.search({ q: "x" });
    expect(resp.results).toEqual([]);
    expect(tried).toEqual(["localhost", "127.0.0.1"]);
  });

  test("does not retry when the first attempt succeeds", async () => {
    const tried: string[] = [];
    const fetchFn: FetchFn = async (input) => {
      tried.push(new URL(String(input)).hostname);
      return jsonResponse({ query: "x", results: [] });
    };
    const client = new SearXNGClient({ baseUrl: "http://localhost:8888", fetchFn });
    await client.search({ q: "x" });
    expect(tried).toEqual(["localhost"]);
  });

  test("non-localhost network errors do not trigger a fallback", async () => {
    const fetchFn: FetchFn = async () => {
      throw new TypeError("fetch failed");
    };
    const client = new SearXNGClient({ baseUrl: "https://searx.example.org", fetchFn });
    await expect(client.search({ q: "x" })).rejects.toThrow(/searx\.example\.org/);
  });
});

describe("SearXNGClient.config", () => {
  test("returns the instance config", async () => {
    const { fetchFn, calls } = mockFetch(() => ({
      body: { categories: ["general", "news"], engines: [], autocomplete: "duckduckgo" },
    }));
    const client = new SearXNGClient({ baseUrl: "http://localhost:8888", fetchFn });
    const config = await client.config();
    expect(config.categories).toEqual(["general", "news"]);
    expect(calls[0]!.url).toBe("http://localhost:8888/config");
  });
});
