/** Rendering of SearXNG responses into compact, agent-friendly text. */

import type {
  SearXNGConfig,
  SearXNGResult,
  SearXNGSearchResponse,
} from "./types.ts";

export type ResultKind = "general" | "news" | "images" | "videos";

export interface SearchFormatOptions {
  /** Max number of results to render (default 10). */
  limit?: number;
  kind?: ResultKind;
  /** Number of results before domain filtering (when filtering happened). */
  totalBeforeFilter?: number;
}

const DEFAULT_LIMIT = 10;
const SNIPPET_LENGTH = 300;

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function matchesDomain(url: string, patterns: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return patterns.some((p) => {
    const needle = p.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return needle.length > 0 && (host === needle || host.endsWith(`.${needle}`));
  });
}

export function filterByDomains(
  results: SearXNGResult[],
  include?: string[],
  exclude?: string[],
): SearXNGResult[] {
  let out = results;
  if (include?.length) {
    out = out.filter((r) => matchesDomain(r.url, include));
  }
  if (exclude?.length) {
    out = out.filter((r) => !matchesDomain(r.url, exclude));
  }
  return out;
}

function formatResult(result: SearXNGResult, index: number, kind: ResultKind): string {
  const lines: string[] = [];
  lines.push(`${index}. ${result.title?.trim() || "(untitled)"}`);
  lines.push(`   ${result.url}`);
  const snippet = truncate(result.content ?? "", SNIPPET_LENGTH);
  if (snippet) lines.push(`   ${snippet}`);
  if (kind === "images") {
    if (result.img_src) lines.push(`   image: ${result.img_src}`);
    if (result.thumbnail) lines.push(`   thumbnail: ${result.thumbnail}`);
  } else if (kind === "videos" && result.thumbnail) {
    lines.push(`   thumbnail: ${result.thumbnail}`);
  }
  const meta: string[] = [];
  const engines = result.engines?.length ? result.engines : result.engine ? [result.engine] : [];
  if (engines.length) meta.push(`engines: ${engines.join(", ")}`);
  if (result.category) meta.push(`category: ${result.category}`);
  if (result.publishedDate) meta.push(`published: ${result.publishedDate}`);
  else if (result.metadata) meta.push(result.metadata);
  if (meta.length) lines.push(`   (${meta.join(" | ")})`);
  return lines.join("\n");
}

export function formatSearchResponse(
  resp: SearXNGSearchResponse,
  opts: SearchFormatOptions = {},
): string {
  const kind = opts.kind ?? "general";
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), 50);
  const parts: string[] = [];

  const filters: string[] = [];
  if (kind !== "general") filters.push(kind);
  if (resp.query) filters.unshift(`"${resp.query}"`);
  const scope = filters.length ? ` (${filters.join(", ")})` : "";
  const shown = Math.min(resp.results.length, limit);
  const total = opts.totalBeforeFilter ?? resp.results.length;
  parts.push(`# Search results${scope}`);
  parts.push(
    total > resp.results.length
      ? `${shown} shown of ${resp.results.length} matching results (filtered from ${total})`
      : `${shown} of ${resp.results.length} results`,
  );

  if (resp.answers?.length) {
    parts.push("");
    parts.push("## Answer");
    for (const answer of resp.answers) parts.push(answer);
  }

  if (resp.infoboxes?.length) {
    parts.push("");
    parts.push("## Infoboxes");
    for (const info of resp.infoboxes) {
      if (info.infobox) parts.push(`### ${info.infobox}`);
      if (info.content) parts.push(truncate(info.content, 500));
      for (const attr of info.attributes ?? []) {
        if (attr.key) parts.push(`- ${attr.key}: ${attr.value ?? ""}`);
      }
      for (const u of info.urls ?? []) {
        if (u.url) parts.push(`- ${u.title ? `${u.title}: ` : ""}${u.url}`);
      }
    }
  }

  const visible = resp.results.slice(0, limit);
  if (visible.length > 0) {
    parts.push("");
    parts.push("## Results");
    for (const [i, result] of visible.entries()) {
      parts.push("");
      parts.push(formatResult(result, i + 1, kind));
    }
    if (resp.results.length > visible.length) {
      parts.push("");
      parts.push(`(${resp.results.length - visible.length} more results on this page — raise "limit" or use pageno)`);
    }
  } else {
    parts.push("");
    parts.push(`No results found${resp.query ? ` for "${resp.query}"` : ""}.`);
  }

  if (resp.corrections?.length) {
    parts.push("");
    parts.push("## Corrections");
    for (const c of resp.corrections) parts.push(`- ${c}`);
  }
  if (resp.suggestions?.length) {
    parts.push("");
    parts.push("## Related searches");
    parts.push(resp.suggestions.map((s) => `- ${s}`).join("\n"));
  }
  if (resp.unresponsive_engines?.length) {
    const details = resp.unresponsive_engines
      .map((e) => (Array.isArray(e) ? `${e[0]} (${e[1] ?? "no response"})` : String(e)))
      .join(", ");
    parts.push("");
    parts.push(`Note: some engines did not respond: ${details}`);
  }

  return parts.join("\n");
}

export function formatAutocomplete(q: string, suggestions: string[]): string {
  if (!suggestions.length) return `No suggestions for "${q}".`;
  return [`Suggestions for "${q}":`, ...suggestions.map((s) => `- ${s}`)].join("\n");
}

export function formatConfig(config: SearXNGConfig, baseUrl: string): string {
  const parts: string[] = [];
  parts.push(`# SearXNG instance`);
  parts.push(`URL: ${baseUrl}`);
  if (config.autocomplete) parts.push(`Autocomplete provider: ${config.autocomplete}`);
  if (config.default_locale) parts.push(`Default locale: ${config.default_locale}`);
  if (config.default_theme) parts.push(`Default theme: ${config.default_theme}`);
  if (config.safe_search !== undefined) parts.push(`SafeSearch default: ${config.safe_search}`);

  if (config.categories?.length) {
    parts.push("");
    parts.push(`## Categories (${config.categories.length})`);
    parts.push(config.categories.join(", "));
  }

  const engines = config.engines ?? [];
  const enabled = engines.filter((e) => e.enabled);
  if (engines.length) {
    parts.push("");
    parts.push(`## Engines: ${enabled.length} enabled of ${engines.length} total`);
    const byCategory = new Map<string, string[]>();
    for (const engine of enabled) {
      for (const category of engine.categories ?? ["uncategorized"]) {
        const list = byCategory.get(category) ?? [];
        list.push(engine.name);
        byCategory.set(category, list);
      }
    }
    for (const [category, names] of [...byCategory.entries()].sort()) {
      parts.push("");
      parts.push(`### ${category} (${names.length})`);
      parts.push(names.join(", "));
    }
  }
  return parts.join("\n");
}
