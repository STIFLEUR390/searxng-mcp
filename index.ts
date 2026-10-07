#!/usr/bin/env node
/**
 * searxng-mcp — MCP server for a SearXNG metasearch instance.
 *
 * Entry point. Reads the instance URL from --url/-u or SEARXNG_URL
 * (default http://localhost:8888), then serves the MCP tools over stdio.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { SearXNGClient } from "./src/client.ts";
import {
  DEFAULT_BASE_URL,
  ENV_URL,
  HELP_TEXT,
  parseArgs,
  resolveBaseUrl,
} from "./src/config.ts";
import { createServer } from "./src/server.ts";
import { VERSION } from "./src/version.ts";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(`searxng-mcp: ${err instanceof Error ? err.message : String(err)}`);
    console.error("Run with --help for usage.");
    process.exit(2);
  }

  if (parsed.help) {
    console.log(HELP_TEXT);
    return;
  }
  if (parsed.version) {
    console.log(VERSION);
    return;
  }

  let baseUrl: string;
  try {
    baseUrl = resolveBaseUrl(argv, process.env);
  } catch (err) {
    console.error(`searxng-mcp: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const client = new SearXNGClient({ baseUrl });
  const server = createServer(client, { version: VERSION });

  // stdout is reserved for the MCP protocol: log to stderr only.
  const source = parsed.baseUrl
    ? "--url flag"
    : process.env[ENV_URL]
      ? `${ENV_URL} env var`
      : `default (${DEFAULT_BASE_URL})`;
  console.error(`[searxng-mcp] v${VERSION} — SearXNG: ${baseUrl} (from ${source})`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[searxng-mcp] ready — waiting for MCP requests on stdio");
}

main().catch((err) => {
  console.error(`searxng-mcp: fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
