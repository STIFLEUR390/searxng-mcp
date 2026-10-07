/**
 * MCP server exposing a SearXNG instance to AI agents.
 *
 * Tools:
 *   - searxng_search           general search (any category)
 *   - searxng_search_news      news search (time_range friendly)
 *   - searxng_search_images    image search (image + thumbnail URLs)
 *   - searxng_search_videos    video search
 *   - searxng_autocomplete     search suggestions
 *   - searxng_config           instance categories + enabled engines
 *   - searxng_extract_content  fetch a page and extract filtered text
 *                              (drop headers/footers/nav/sidebars/ads, ...)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { SearXNGClient, SearXNGError } from "./client.ts";
import { ExtractError, fetchAndExtract } from "./extract.ts";
import {
  filterByDomains,
  formatAutocomplete,
  formatConfig,
  formatSearchResponse,
  type ResultKind,
} from "./format.ts";
import type { SearXNGSearchResponse } from "./types.ts";
import { VERSION } from "./version.ts";

export const SERVER_NAME = "searxng-mcp";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(err: unknown): ToolResult {
  let message: string;
  if (err instanceof SearXNGError || err instanceof ExtractError) {
    message = err.message;
  } else if (err instanceof Error) {
    message = `Unexpected error: ${err.message}`;
  } else {
    message = `Unexpected error: ${String(err)}`;
  }
  return { content: [{ type: "text", text: message }], isError: true };
}

const readOnly = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;

const domainFilterShape = {
  include_domains: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Only keep results hosted on these domains, e.g. ["wikipedia.org", "github.com"]. ' +
        "Matches host and subdomains.",
    ),
  exclude_domains: z
    .array(z.string().min(1))
    .optional()
    .describe('Drop results hosted on these domains, e.g. ["pinterest.com"]. Matches host and subdomains.'),
};

const coreSearchShape = {
  q: z.string().min(1).describe("Search query. Supports search-engine syntax."),
  language: z
    .string()
    .optional()
    .describe('Language code for results, e.g. "en", "fr", "de". Default: instance setting.'),
  pageno: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Page number of results to fetch (default 1). Use to paginate."),
  time_range: z
    .enum(["day", "month", "year"])
    .optional()
    .describe("Restrict results to the last day, month or year (engines that support it)."),
  safesearch: z
    .number()
    .int()
    .min(0)
    .max(2)
    .optional()
    .describe("SafeSearch level: 0=off, 1=moderate, 2=strict. Default: instance setting."),
  engines: z
    .array(z.string().min(1))
    .optional()
    .describe('Restrict to specific engines by name or shortcut, e.g. ["duckduckgo", "brave"].'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max number of results to return in the output (default 10, max 50)."),
  ...domainFilterShape,
};

type SearchArgs = z.infer<z.ZodObject<typeof coreSearchShape>>;

interface ServerOptions {
  /** Fetch implementation override (tests). */
  fetchFn?: typeof fetch;
  version?: string;
}

export function createServer(client: SearXNGClient, options: ServerOptions = {}): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: options.version ?? VERSION,
  });

  const runSearch = async (
    args: SearchArgs & { categories?: string[] },
    kind: ResultKind,
  ): Promise<ToolResult> => {
    try {
      const response: SearXNGSearchResponse = await client.search({
        q: args.q,
        categories: args.categories,
        language: args.language,
        pageno: args.pageno,
        timeRange: args.time_range,
        safesearch: args.safesearch as 0 | 1 | 2 | undefined,
        engines: args.engines,
      });
      const totalBeforeFilter = response.results.length;
      const filtered = filterByDomains(response.results, args.include_domains, args.exclude_domains);
      const text = formatSearchResponse(
        { ...response, results: filtered },
        {
          limit: args.limit,
          kind,
          totalBeforeFilter: totalBeforeFilter > filtered.length ? totalBeforeFilter : undefined,
        },
      );
      return ok(text);
    } catch (err) {
      return fail(err);
    }
  };

  server.registerTool(
    "searxng_search",
    {
      title: "SearXNG web search",
      description:
        "Search the web (or any SearXNG category) through the user's SearXNG metasearch instance. " +
        'Aggregates many engines while protecting privacy. Use categories to target the default "general" web results; ' +
        "use searxng_search_news/images/videos for dedicated searches.",
      inputSchema: {
        ...coreSearchShape,
        categories: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'SearXNG categories, e.g. ["general"], ["it", "science"], ["software wikis"]. ' +
              'Default: ["general"]. Call searxng_config to list all categories of the instance.',
          ),
      },
      annotations: readOnly,
    },
    async (args) => runSearch(args, "general"),
  );

  server.registerTool(
    "searxng_search_news",
    {
      title: "SearXNG news search",
      description:
        "Search news articles through the user's SearXNG instance (category: news). " +
        'Use time_range ("day" | "month" | "year") to get recent articles.',
      inputSchema: coreSearchShape,
      annotations: readOnly,
    },
    async (args) => runSearch({ ...args, categories: ["news"] }, "news"),
  );

  server.registerTool(
    "searxng_search_images",
    {
      title: "SearXNG image search",
      description:
        "Search images through the user's SearXNG instance (category: images). " +
        "Results include the full image URL and a thumbnail URL when available.",
      inputSchema: coreSearchShape,
      annotations: readOnly,
    },
    async (args) => runSearch({ ...args, categories: ["images"] }, "images"),
  );

  server.registerTool(
    "searxng_search_videos",
    {
      title: "SearXNG video search",
      description:
        "Search videos through the user's SearXNG instance (category: videos). " +
        "Results include the video page URL and a thumbnail URL when available.",
      inputSchema: coreSearchShape,
      annotations: readOnly,
    },
    async (args) => runSearch({ ...args, categories: ["videos"] }, "videos"),
  );

  server.registerTool(
    "searxng_autocomplete",
    {
      title: "SearXNG autocomplete",
      description:
        "Get search query suggestions from the user's SearXNG instance. " +
        "Useful to refine or expand a query before searching.",
      inputSchema: {
        q: z.string().min(1).describe("Partial search query to get suggestions for."),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        const suggestions = await client.autocomplete(args.q);
        return ok(formatAutocomplete(args.q, suggestions));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "searxng_config",
    {
      title: "SearXNG instance configuration",
      description:
        "Describe the user's SearXNG instance: available categories and enabled engines grouped by category. " +
        "Call this first when you need to know what can be searched on this instance.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      try {
        const config = await client.config();
        return ok(formatConfig(config, client.baseUrl));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "searxng_extract_content",
    {
      title: "Extract page content",
      description:
        "Fetch a web page (typically a URL found with the search tools) and extract clean, readable text. " +
        "Structural filtering removes site chrome by default: headers, footers, navigation menus, sidebars, " +
        "cookie banners, ads and comment sections. The agent can re-include any of these sections, keep links/images, " +
        "limit the output length, or target a CSS selector. Reports which sections were removed.",
      inputSchema: {
        url: z.url().describe("Absolute http(s) URL of the page to fetch and extract."),
        include_header: z.boolean().optional().describe("Keep site header/banner blocks (default: false, removed)."),
        include_footer: z.boolean().optional().describe("Keep site footer blocks (default: false, removed)."),
        include_navigation: z
          .boolean()
          .optional()
          .describe("Keep navigation menus, topbars and breadcrumbs (default: false, removed)."),
        include_sidebar: z
          .boolean()
          .optional()
          .describe("Keep sidebars and widget columns (default: false, removed)."),
        include_comments: z.boolean().optional().describe("Keep comment sections (default: false, removed)."),
        include_links: z
          .boolean()
          .optional()
          .describe('Render links as markdown [text](url) instead of plain text (default: false).'),
        include_images: z
          .boolean()
          .optional()
          .describe('Render images as markdown ![alt](src) (default: false).'),
        content_only: z
          .boolean()
          .optional()
          .describe(
            "Extract only the main content area (article/main) when detectable " +
              "(default: true). Set false to render the whole cleaned body.",
          ),
        selector: z
          .string()
          .optional()
          .describe(
            'Advanced: extract only elements matching this CSS selector, e.g. "article" or ".post-content". ' +
              "Overrides content_only.",
          ),
        max_length: z
          .number()
          .int()
          .min(500)
          .max(200000)
          .optional()
          .describe("Truncate the extracted content to this many characters (default 20000)."),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        const result = await fetchAndExtract(
          args.url,
          {
            includeHeader: args.include_header,
            includeFooter: args.include_footer,
            includeNavigation: args.include_navigation,
            includeSidebar: args.include_sidebar,
            includeComments: args.include_comments,
            includeLinks: args.include_links,
            includeImages: args.include_images,
            contentOnly: args.content_only,
            selector: args.selector,
            maxLength: args.max_length,
          },
          { fetchFn: options.fetchFn },
        );
        const parts: string[] = [];
        parts.push(`# ${result.title || "(no title)"}`);
        parts.push(`URL: ${result.url}`);
        if (result.lang) parts.push(`Language: ${result.lang}`);
        if (result.description) parts.push(`Description: ${result.description}`);
        parts.push(
          `Content: ${result.originalLength} chars extracted` +
            (result.truncated ? ` — truncated to ${result.content.length}` : ""),
        );
        if (result.removed.length) {
          parts.push(`Removed sections: ${result.removed.join(", ")} (use include_* options to keep them)`);
        }
        parts.push("");
        parts.push(result.content || "(no text content extracted)");
        return ok(parts.join("\n"));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
