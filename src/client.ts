/**
 * HTTP client for a SearXNG instance.
 *
 * Uses only GET requests against the JSON API:
 *   - {base}/search?q=...&format=json
 *   - {base}/autocompleter?q=...
 *   - {base}/config
 *
 * fetchFn is injectable for tests.
 */

import type {
  SearXNGConfig,
  SearXNGSearchResponse,
} from "./types.ts";

export type TimeRange = "day" | "week" | "month" | "year";

/** Injectable fetch signature (structural subset of the global fetch). */
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SearchParams {
  q: string;
  /** SearXNG categories, e.g. ["general"], ["news"], ["images", "videos"]. */
  categories?: string[];
  /** Language code, e.g. "en", "fr", "de". */
  language?: string;
  pageno?: number;
  timeRange?: TimeRange;
  /** 0 = off, 1 = moderate, 2 = strict. */
  safesearch?: 0 | 1 | 2;
  /** Restrict to specific engines (exact names or shortcuts, case-insensitive; resolved against /config). */
  engines?: string[];
}

export interface SearXNGClientOptions {
  baseUrl: string;
  fetchFn?: FetchFn;
  /** Per-request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  userAgent?: string;
}

/** Outcome of resolving requested engine names/shortcuts against the instance config. */
export interface EngineResolution {
  /** Canonical engine names (shortcuts and casing normalized), deduplicated, in request order. */
  resolved: string[];
  /** Requested names that match neither an engine name nor a shortcut. */
  unknown: string[];
}

export class SearXNGError extends Error {
  override name = "SearXNGError";
  readonly status?: number;
  readonly baseUrl?: string;
  /** "network" | "timeout" for transport-level failures. */
  readonly code?: "network" | "timeout";

  constructor(message: string, status?: number, baseUrl?: string, code?: "network" | "timeout") {
    super(message);
    this.status = status;
    this.baseUrl = baseUrl;
    this.code = code;
  }
}

/**
 * Node resolves `localhost` to ::1 first, while many SearXNG instances listen
 * on IPv4 only. On connection failure, retry once on 127.0.0.1.
 */
export function ipv4Fallback(url: URL): URL | null {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") {
    const alt = new URL(url.toString());
    alt.hostname = "127.0.0.1";
    return alt;
  }
  return null;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT = "searxng-mcp/1.0 (+https://github.com/STIFLEUR390/searxng-mcp)";
const ENGINE_CACHE_TTL_MS = 10 * 60_000;

export class SearXNGClient {
  readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  /** name (lowercase) -> canonical name, plus shortcut (lowercase) -> canonical name. */
  private engineIndex: Map<string, string> | null = null;
  private engineIndexFetchedAt = 0;

  constructor(options: SearXNGClientOptions) {
    const trimmed = options.baseUrl.trim().replace(/\/+$/, "");
    if (!trimmed) {
      throw new SearXNGError("SearXNG base URL must not be empty.");
    }
    this.baseUrl = trimmed;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  async search(params: SearchParams): Promise<SearXNGSearchResponse> {
    if (!params.q.trim()) {
      throw new SearXNGError("Search query must not be empty.");
    }
    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.set("q", params.q);
    url.searchParams.set("format", "json");
    if (params.categories?.length) {
      url.searchParams.set("categories", params.categories.join(","));
    }
    if (params.language) url.searchParams.set("language", params.language);
    if (params.pageno && params.pageno > 1) {
      url.searchParams.set("pageno", String(params.pageno));
    }
    if (params.timeRange) url.searchParams.set("time_range", params.timeRange);
    if (params.safesearch !== undefined) {
      url.searchParams.set("safesearch", String(params.safesearch));
    }
    if (params.engines?.length) {
      url.searchParams.set("engines", params.engines.join(","));
    }

    const json = await this.getJson(url);
    if (
      !json ||
      typeof json !== "object" ||
      !Array.isArray((json as { results?: unknown }).results)
    ) {
      throw new SearXNGError(
        `Unexpected response from ${this.baseUrl}/search (missing "results" array).`,
        undefined,
        this.baseUrl,
      );
    }
    return json as SearXNGSearchResponse;
  }

  /**
   * SearXNG autocompleter returns a JSON tuple:
   *   [query, suggestions[], corrections[], engines[], metadata{}]
   * Some instances may return a flat string array instead.
   */
  async autocomplete(q: string, language?: string): Promise<string[]> {
    if (!q.trim()) {
      throw new SearXNGError("Autocomplete query must not be empty.");
    }
    const url = new URL(`${this.baseUrl}/autocompleter`);
    url.searchParams.set("q", q);
    if (language?.trim()) url.searchParams.set("language", language.trim());
    const json = await this.getJson(url);
    if (!Array.isArray(json)) return [];
    if (json.every((item) => typeof item === "string")) {
      return json as string[];
    }
    const suggestions = json[1];
    if (Array.isArray(suggestions)) {
      return suggestions.filter((s): s is string => typeof s === "string");
    }
    return [];
  }

  /** Instance configuration: categories, engines, autocomplete provider, ... */
  async config(): Promise<SearXNGConfig> {
    const url = new URL(`${this.baseUrl}/config`);
    const json = await this.getJson(url);
    if (!json || typeof json !== "object") {
      throw new SearXNGError(
        `Unexpected response from ${this.baseUrl}/config.`,
        undefined,
        this.baseUrl,
      );
    }
    return json as SearXNGConfig;
  }

  /**
   * Resolve requested engine identifiers against the instance `/config`.
   *
   * SearXNG's `engines` search parameter only accepts exact engine names (case
   * sensitive); unknown names are silently dropped and an all-unknown list makes
   * the instance fall back to its default engines. So shortcuts and wrong casing
   * are normalized here against the instance's engine list (name + shortcut),
   * cached for ENGINE_CACHE_TTL_MS.
   *
   * If `/config` cannot be fetched, the request is passed through unchanged
   * (resolved = requested, unknown = []) to never block a search.
   */
  async resolveEngines(requested: string[]): Promise<EngineResolution> {
    const index = await this.getEngineIndex();
    if (!index) {
      return { resolved: [...requested], unknown: [] };
    }
    const resolved: string[] = [];
    const unknown: string[] = [];
    for (const raw of requested) {
      const canonical = index.get(raw.trim().toLowerCase());
      if (!canonical) {
        if (!unknown.includes(raw)) unknown.push(raw);
        continue;
      }
      if (!resolved.includes(canonical)) resolved.push(canonical);
    }
    return { resolved, unknown };
  }

  /** Lowercased name/shortcut → canonical engine name. Null when /config is unavailable. */
  private async getEngineIndex(): Promise<Map<string, string> | null> {
    if (this.engineIndex && Date.now() - this.engineIndexFetchedAt < ENGINE_CACHE_TTL_MS) {
      return this.engineIndex;
    }
    let config: SearXNGConfig;
    try {
      config = await this.config();
    } catch {
      // Graceful degradation: no validation rather than a failed search.
      return null;
    }
    const index = new Map<string, string>();
    for (const engine of config.engines ?? []) {
      if (!engine?.name) continue;
      index.set(engine.name.toLowerCase(), engine.name);
      if (engine.shortcut) index.set(engine.shortcut.toLowerCase(), engine.name);
    }
    if (index.size === 0) return null;
    this.engineIndex = index;
    this.engineIndexFetchedAt = Date.now();
    return index;
  }

  private async getJson(url: URL): Promise<unknown> {
    try {
      return await this.requestJson(url);
    } catch (err) {
      if (err instanceof SearXNGError && err.code === "network") {
        const alt = ipv4Fallback(url);
        if (alt) {
          try {
            return await this.requestJson(alt);
          } catch {
            // Report the original (localhost) error below.
          }
        }
      }
      throw err;
    }
  }

  private async requestJson(url: URL): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": this.userAgent,
        },
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new SearXNGError(
          `Request to ${this.baseUrl} timed out after ${this.timeoutMs}ms.`,
          undefined,
          this.baseUrl,
          "timeout",
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new SearXNGError(
        `Could not reach SearXNG at ${this.baseUrl}: ${message}. ` +
          `Check that the instance is running and that SEARXNG_URL is correct.`,
        undefined,
        this.baseUrl,
        "network",
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 403) {
      throw new SearXNGError(
        `SearXNG at ${this.baseUrl} returned 403 Forbidden. ` +
          `The JSON format is probably disabled on this instance. ` +
          `Enable it in settings.yml:\n` +
          `    search:\n      formats: [html, json]`,
        403,
        this.baseUrl,
      );
    }
    if (res.status === 429) {
      throw new SearXNGError(
        `SearXNG at ${this.baseUrl} returned 429 Too Many Requests. ` +
          `The instance rate limiter may be blocking automated requests. ` +
          `Check the "limiter" setting in settings.yml or retry later.`,
        429,
        this.baseUrl,
      );
    }
    if (!res.ok) {
      throw new SearXNGError(
        `SearXNG request failed: HTTP ${res.status} ${res.statusText} (${url})`,
        res.status,
        this.baseUrl,
      );
    }
    try {
      return await res.json();
    } catch {
      throw new SearXNGError(
        `SearXNG at ${this.baseUrl} returned invalid JSON (${url}).`,
        res.status,
        this.baseUrl,
      );
    }
  }
}
