/** CLI/env parsing and base-URL resolution for the searxng-mcp server. */

export const ENV_URL = "SEARXNG_URL";
export const DEFAULT_BASE_URL = "http://localhost:8888";
export const ENV_TIMEOUT_MS = "SEARXNG_TIMEOUT_MS";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 500;
export const MAX_TIMEOUT_MS = 300_000;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface ParsedArgs {
  /** Explicit --url value, if provided. */
  baseUrl?: string;
  help: boolean;
  version: boolean;
}

export const HELP_TEXT = `searxng-mcp — MCP server for a SearXNG metasearch instance

Usage: searxng-mcp [options]

Options:
  -u, --url <url>   Base URL of your SearXNG instance
                    (overrides the ${ENV_URL} environment variable)
  -h, --help        Show this help message
  -V, --version     Show the version number

Configuration:
  The SearXNG instance URL is taken from, in order of precedence:
    1. --url / -u command-line flag
    2. ${ENV_URL} environment variable
    3. default: ${DEFAULT_BASE_URL}

  ${ENV_TIMEOUT_MS} sets the per-request timeout in milliseconds
  (default ${DEFAULT_TIMEOUT_MS}, min ${MIN_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).

Examples:
  searxng-mcp --url http://localhost:8888
  SEARXNG_URL=https://searx.example.org searxng-mcp
  ${ENV_TIMEOUT_MS}=60000 searxng-mcp

The server communicates over stdio and is meant to be launched by an MCP
client (Claude Desktop, Claude Code, Cursor, ...).`;

/** Parse CLI arguments. Throws ConfigError on invalid usage. */
export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "-h" || arg === "--help") {
      result.help = true;
    } else if (arg === "-V" || arg === "--version") {
      result.version = true;
    } else if (arg === "--url" || arg === "-u") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        throw new ConfigError(`Missing value for ${arg}. Example: ${arg} http://localhost:8888`);
      }
      result.baseUrl = next;
      i++;
    } else if (arg.startsWith("--url=")) {
      const value = arg.slice("--url=".length);
      if (!value) {
        throw new ConfigError(`Missing value for --url. Example: --url http://localhost:8888`);
      }
      result.baseUrl = value;
    } else {
      throw new ConfigError(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

/**
 * Normalize a SearXNG base URL: validate protocol, strip trailing slashes
 * and a trailing /search (users often paste the search URL).
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ConfigError("SearXNG URL must not be empty.");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError(
      `Invalid SearXNG URL: "${raw}". Expected something like http://localhost:8888`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(
      `Invalid SearXNG URL protocol "${url.protocol}" in "${raw}". Only http and https are supported.`,
    );
  }
  let base = url.toString();
  base = base.replace(/\/+$/, "");
  base = base.replace(/\/search$/, "");
  return base;
}

/**
 * Resolve the SearXNG base URL with precedence:
 *   1. --url / -u flag   2. SEARXNG_URL env var   3. default localhost:8888
 */
export function resolveBaseUrl(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): string {
  const fromCli = parseArgs(argv).baseUrl;
  const raw = fromCli ?? env[ENV_URL] ?? DEFAULT_BASE_URL;
  return normalizeBaseUrl(raw);
}

/**
 * Resolve the per-request timeout from SEARXNG_TIMEOUT_MS.
 * Unset/empty → default; must be an integer in [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS].
 */
export function resolveTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[ENV_TIMEOUT_MS];
  if (raw === undefined || raw.trim() === "") return DEFAULT_TIMEOUT_MS;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new ConfigError(
      `Invalid ${ENV_TIMEOUT_MS}: "${raw}". Expected an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}.`,
    );
  }
  return value;
}
