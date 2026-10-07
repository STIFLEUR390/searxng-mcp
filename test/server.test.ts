import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SearXNGClient } from "../src/client.ts";
import { createServer } from "../src/server.ts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const searchBody = {
  query: "bun",
  results: [
    {
      url: "https://bun.com/",
      title: "Bun",
      content: "A fast all-in-one JavaScript runtime",
      engine: "duckduckgo",
      engines: ["duckduckgo"],
      category: "general",
    },
    {
      url: "https://pinterest.com/pin/1",
      title: "Pinned thing",
      content: "Unrelated result",
      engine: "brave",
      engines: ["brave"],
      category: "general",
    },
  ],
};

const pageHtml = `<!doctype html><html><head><title>Doc</title></head>
<body><header>Site header</header><article><h1>Doc</h1><p>Useful content here.</p></article>
<footer>Site footer</footer></body></html>`;

async function connect(fetchFn: typeof fetch) {
  const client = new SearXNGClient({ baseUrl: "http://searx.test", fetchFn });
  const server = createServer(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content.map((c) => c.text).join("\n");
}

describe("MCP server integration", () => {
  test("lists all 7 tools", async () => {
    const mcp = await connect(async () => jsonResponse({}));
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "searxng_autocomplete",
      "searxng_config",
      "searxng_extract_content",
      "searxng_search",
      "searxng_search_images",
      "searxng_search_news",
      "searxng_search_videos",
    ]);
    const search = tools.find((t) => t.name === "searxng_search");
    expect(search?.description).toMatch(/SearXNG/);
  });

  test("searxng_search returns formatted results", async () => {
    const mcp = await connect(async () => jsonResponse(searchBody));
    const result = await mcp.callTool({ name: "searxng_search", arguments: { q: "bun" } });
    const text = textOf(result);
    expect(text).toContain('"bun"');
    expect(text).toContain("https://bun.com/");
    expect(text).toContain("A fast all-in-one JavaScript runtime");
  });

  test("searxng_search forwards SearXNG parameters", async () => {
    let captured = "";
    const mcp = await connect(async (input) => {
      captured = String(input);
      return jsonResponse(searchBody);
    });
    await mcp.callTool({
      name: "searxng_search",
      arguments: {
        q: "bun",
        categories: ["it"],
        language: "fr",
        pageno: 3,
        time_range: "month",
        safesearch: 1,
        engines: ["duckduckgo"],
      },
    });
    const url = new URL(captured);
    expect(url.searchParams.get("categories")).toBe("it");
    expect(url.searchParams.get("language")).toBe("fr");
    expect(url.searchParams.get("pageno")).toBe("3");
    expect(url.searchParams.get("time_range")).toBe("month");
    expect(url.searchParams.get("safesearch")).toBe("1");
    expect(url.searchParams.get("engines")).toBe("duckduckgo");
    expect(url.searchParams.get("format")).toBe("json");
  });

  test("searxng_search applies exclude_domains filtering", async () => {
    const mcp = await connect(async () => jsonResponse(searchBody));
    const result = await mcp.callTool({
      name: "searxng_search",
      arguments: { q: "bun", exclude_domains: ["pinterest.com"] },
    });
    const text = textOf(result);
    expect(text).toContain("https://bun.com/");
    expect(text).not.toContain("pinterest.com");
    expect(text).toContain("filtered from 2");
  });

  test("searxng_search_news pins the news category", async () => {
    let captured = "";
    const mcp = await connect(async (input) => {
      captured = String(input);
      return jsonResponse({ query: "x", results: [] });
    });
    await mcp.callTool({ name: "searxng_search_news", arguments: { q: "x" } });
    expect(new URL(captured).searchParams.get("categories")).toBe("news");
  });

  test("tool errors are returned as isError results", async () => {
    const mcp = await connect(async () => jsonResponse({ error: "nope" }, 500));
    const result = await mcp.callTool({ name: "searxng_search", arguments: { q: "x" } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("HTTP 500");
  });

  test("searxng_config lists categories", async () => {
    const mcp = await connect(async () =>
      jsonResponse({
        categories: ["general", "news"],
        engines: [{ name: "Wikipedia", categories: ["general"], enabled: true }],
        autocomplete: "duckduckgo",
      }),
    );
    const text = textOf(await mcp.callTool({ name: "searxng_config", arguments: {} }));
    expect(text).toContain("Categories (2)");
    expect(text).toContain("Wikipedia");
  });

  test("searxng_autocomplete returns suggestions", async () => {
    const mcp = await connect(async () => jsonResponse(["sea", ["searxng", "search"]]));
    const text = textOf(await mcp.callTool({ name: "searxng_autocomplete", arguments: { q: "sea" } }));
    expect(text).toContain("- searxng");
  });

  test("searxng_extract_content filters chrome and reports removals", async () => {
    const mcp = await connect(async () =>
      new Response(pageHtml, { headers: { "Content-Type": "text/html" } }),
    );
    const text = textOf(
      await mcp.callTool({
        name: "searxng_extract_content",
        arguments: { url: "https://example.org/doc" },
      }),
    );
    expect(text).toContain("# Doc");
    expect(text).toContain("Useful content here.");
    expect(text).not.toContain("Site header");
    expect(text).not.toContain("Site footer");
    expect(text).toContain("Removed sections:");
  });

  test("searxng_extract_content validates the URL argument", async () => {
    const mcp = await connect(async () => new Response(pageHtml));
    const result = await mcp.callTool({
      name: "searxng_extract_content",
      arguments: { url: "definitely not a url" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});
