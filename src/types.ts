/** Types mirroring the SearXNG JSON API (/search, /autocompleter, /config). */

/**
 * Instant answer. Older engines return a plain string; current SearXNG returns
 * an object (e.g. the DuckDuckGo `answer/legacy.html` template) with the text
 * under `answer` and an optional source `url`.
 */
export interface SearXNGAnswer {
  answer?: string;
  url?: string;
  engine?: string;
  template?: string;
}

/** Spelling correction: a plain string, or an object carrying a `correction` field. */
export interface SearXNGCorrection {
  correction?: string;
  url?: string;
}

export interface SearXNGResult {
  url: string;
  title: string;
  content: string;
  engine: string;
  engines?: string[];
  category: string;
  /** ISO 8601 date when the engine provides one (news). */
  publishedDate?: string | null;
  /** Engine-specific extra line, e.g. "30/05/2011 | verizon" for news. */
  metadata?: string | null;
  img_src?: string;
  thumbnail?: string | null;
  score?: number;
  template?: string;
  iframe_src?: string | null;
}

export interface SearXNGInfobox {
  infobox?: string;
  id?: string;
  content?: string;
  img_src?: string;
  urls?: Array<{ title?: string; url: string }>;
  attributes?: Array<{ key?: string; value?: string | number }>;
}

export interface SearXNGSearchResponse {
  query: string;
  number_of_results?: number;
  results: SearXNGResult[];
  answers?: Array<string | SearXNGAnswer>;
  corrections?: Array<string | SearXNGCorrection>;
  infoboxes?: SearXNGInfobox[];
  suggestions?: string[];
  /** [engineName, reason] pairs for engines that failed during the search. */
  unresponsive_engines?: Array<[string, string] | string[]>;
}

export interface SearXNGEngineInfo {
  name: string;
  categories?: string[];
  enabled?: boolean;
  shortcut?: string;
  paging?: boolean;
  language_support?: boolean;
  safesearch?: boolean;
  time_range_support?: boolean;
}

export interface SearXNGConfig {
  autocomplete?: string;
  categories?: string[];
  engines?: SearXNGEngineInfo[];
  default_locale?: string;
  default_theme?: string;
  safe_search?: number;
}
