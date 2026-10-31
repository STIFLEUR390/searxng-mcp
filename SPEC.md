# SPEC — searxng-mcp

Complete specification of the `searxng-mcp` MCP server: goals, architecture, tool contracts,
extraction/filtering behavior, error handling, packaging and testing.

- **Package**: `searxng-mcp`
- **Version**: 1.0.4
- **Runtime**: Bun (development) / Node.js >= 18 (distribution target)
- **Protocol**: MCP over stdio (`@modelcontextprotocol/sdk` ^1.32)
- **License**: MIT

---

## 1. Vision & goals

Give any MCP-capable AI agent private, configurable web research:

1. **Search through the user's own SearXNG instance** — metasearch over many engines with no
   third-party profiling; the agent never talks to Google/Bing directly.
2. **Single configuration knob** — the SearXNG base URL (env var or CLI flag, default
   `http://localhost:8888`). Nothing else to configure.
3. **Agent-grade output** — compact structured text instead of raw API JSON or HTML pages.
4. **Content extraction with structural filtering** — after finding a page, the agent can fetch
   it and keep only the substance: headers, footers, navigation menus, sidebars, cookie banners,
   ads and comment sections are removed by default; every removal is reported and reversible
   per call via `include_*` options.
5. **Global installability** — `bun install -g`, `npm install -g` or `npx`, straight from GitHub
   or npm, running the committed self-contained `dist/index.js` bundle.

## 2. Non-goals

- No proxying of search *through* the MCP for non-SearXNG engines (the instance is the source).
- No JavaScript rendering (headless browser). Pages that need JS are reported as such.
- No authentication layer of its own: SearXNG has none; instance protection (limiter, network
  position) is the operator's responsibility.
- No persistent caching or rate limiting client-side (v1).
- No MCP resources/prompts — tools only (v1).

## 3. Architecture

```mermaid
flowchart LR
    Agent[AI agent / MCP client]
    subgraph searxng-mcp
        Entry[index.ts - CLI + stdio]
        Server[src/server.ts - tool registration]
        Client[src/client.ts - SearXNG API client]
        Extract[src/extract.ts - HTML fetch + filtering]
        Format[src/format.ts - response formatting]
    end
    SX[(SearXNG instance<br/>/search /autocompleter /config)]
    Web[(Any web page)]

    Agent <-- JSON-RPC stdio --> Entry --> Server
    Server --> Client --> SX
    Server --> Format
    Server --> Extract --> Web
```

| Module | Responsibility |
|--------|----------------|
| `index.ts` | CLI parsing (`--url`, `--help`, `--version`), config resolution, stdio wiring. Logs to **stderr only** (stdout is the MCP channel). |
| `src/config.ts` | Argument/env parsing, base-URL normalization and validation. |
| `src/client.ts` | Typed client for the SearXNG JSON API with injectable `fetch`, timeouts, and actionable error messages. |
| `src/extract.ts` | Page fetch (size/type guards), DOM cleaning (chrome + noise removal), main-content detection (Mozilla Readability), Markdown rendering (Turndown). |
| `src/format.ts` | Rendering of SearXNG responses into markdown-ish text; domain filtering of results. |
| `src/server.ts` | `McpServer` construction and registration of the 7 tools (Zod input schemas, tool annotations). |
| `src/types.ts` | TypeScript types mirroring the SearXNG JSON API. |

Dependencies: `@modelcontextprotocol/sdk`, `zod` (v4, aligned with the SDK), `linkedom`
(lightweight DOM), `@mozilla/readability` and `turndown` (the clipper.js HTML→Markdown stack).
Optional: `puppeteer-core`, loaded on demand when `SEARXNG_BROWSER_URL` points at a CDP
browser. No HTTP framework, no jsdom, no bundled browser.

## 4. Configuration

Resolution order for the instance URL:

1. `--url <url>` / `-u <url>` CLI flag
2. `SEARXNG_URL` environment variable
3. Default `http://localhost:8888`

Normalization rules (`normalizeBaseUrl`):

- trimmed of surrounding whitespace;
- must parse as an absolute URL with `http:`/`https:` protocol (else fatal config error);
- trailing slashes stripped; a trailing `/search` (pasted search URL) stripped;
- sub-paths preserved (`https://host/searxng` stays).

`SEARXNG_BROWSER_URL` (alias `OBSCURA_URL`) is optional: it must be a `ws://`, `wss://`,
`http://` or `https://` endpoint (else fatal config error) and only affects
`searxng_extract_content` rendering.

IPv4 fallback: Node resolves `localhost` to `::1` first while many instances listen on IPv4
only. On a **network-level** failure (not HTTP errors, not timeouts), the client retries once
with `127.0.0.1` when the host is `localhost` or `::1`. The same fallback applies to page
extraction. Applied only on failure — the original hostname is preferred when it works.

CLI contract:

- `--help` / `-h` → usage text on stdout, exit 0
- `--version` / `-V` → version on stdout, exit 0
- unknown flags or `--url` without a value → error on stderr, exit 2

## 5. SearXNG API mapping

All requests are `GET`, `Accept: application/json`, with a descriptive `User-Agent`
(`searxng-mcp/<version>`), per-request timeout 30 s by default (`SEARXNG_TIMEOUT_MS`,
500–300000 ms).

| MCP tool | SearXNG endpoint | Parameters sent |
|----------|------------------|-----------------|
| `searxng_search` (+ news/images/videos variants) | `GET /search` | `q`, `format=json`, `categories`, `language`, `pageno`, `time_range`, `safesearch`, `engines` |
| `searxng_autocomplete` | `GET /autocompleter` | `q`, `language` (when provided) |
| `searxng_config` | `GET /config` | — |
| `searxng_extract_content` | *(none — direct page fetch)* | — |

Notes:

- `format=json` is always requested; the instance must have it enabled
  (`search.formats: [html, json]`), otherwise SearXNG answers 403 (see §8).
- `pageno` is only sent when > 1; optional params are omitted to keep instance defaults.
- `engines` is resolved against `GET /config` first (shortcuts/casing normalized, unknown names
  rejected or reported — see §6) so the instance never silently falls back to its defaults.
- The autocompleter returns a tuple `[query, suggestions[], ...]`; flat string arrays are also
  accepted; anything else yields an empty list (never an error).

## 6. Tool specifications

Common search input (shared by the four search tools):

| Field | Type | Constraints | Default |
|-------|------|-------------|---------|
| `q` | string | required, min length 1 | — |
| `categories` | string[] | SearXNG category names (`searxng_search` only) | `["general"]` (instance default) |
| `language` | string | language code | instance default |
| `pageno` | int | 1–50 | 1 |
| `time_range` | enum | `day` \| `week` \| `month` \| `year` | unset |
| `safesearch` | int | 0–2 | instance default |
| `engines` | string[] | engine names/shortcuts, case-insensitive | all enabled engines |
| `limit` | int | 1–50, output-side truncation | 10 |
| `include_domains` | string[] | host or subdomain match | unset |
| `exclude_domains` | string[] | host or subdomain match | unset |

All tools are registered with annotations `{ readOnlyHint: true, idempotentHint: true,
openWorldHint: true }`.

**Engine selection (`engines`)**: SearXNG's `engines` search parameter only accepts *exact*
engine names — a wrong case, a shortcut or a typo is silently dropped by the instance, which
falls back to its default engines. The MCP therefore resolves the requested identifiers against
`GET /config` (name + shortcut maps, lowercased; in-memory cache, 10 min TTL) before searching:

- all requested engines unknown → tool error (`isError: true`) naming them and pointing to
  `searxng_config`; the search is not executed;
- some unknown → the valid ones are searched and the output carries a
  `Note: ignored unknown engines: ...` line under the header;
- `/config` unreachable or engine-less → graceful pass-through (current behavior, no validation).

### 6.1 `searxng_search`

General-purpose search over any instance category. Output (markdown-ish text):

```
# Search results ("query"[, <kind>])
<n> of <m> results[ (filtered from <total>)]

## Answer            (when the instance returned answers; engine extras may be plain
                     strings or objects — e.g. DuckDuckGo `{ answer, url }` — and are
                     normalized to text, with the source URL kept when present)
## Infoboxes         (title, content, attributes, links)
## Results
1. <title>
   <url>
   <snippet ≤ 300 chars>
   [image: <url>] [thumbnail: <url>]     (images kind / when available)
   (engines: ... | category: ... | published: ...)
2. ...
(<k> more results on this page — raise "limit" or use pageno)

## Corrections       (did-you-mean)
## Related searches
Note: some engines did not respond: <engine (reason), ...>
```

Empty result set → `No results found for "<query>".` (not an error).

### 6.2 `searxng_search_news` / `searxng_search_images` / `searxng_search_videos`

Identical contract, with `categories` pinned to `news` / `images` / `videos`. Image results
always surface `image:` (full URL) and `thumbnail:` lines; video results surface `thumbnail:`
when available; news surfaces `published:`/metadata.

### 6.3 `searxng_autocomplete`

Input: `q` (string, required), `language` (string, optional — forwarded to `/autocompleter` when
provided). Output: `Suggestions for "<q>":` + bullet list, or `No suggestions for "<q>".`

### 6.4 `searxng_config`

Input: `include_engines` (bool, default true — set false for a compact view: counts only, no
engine lists). Output: instance URL, autocomplete provider, default locale/theme/SafeSearch,
category list, and enabled engines grouped by category with counts (`Engines: <n> enabled of
<m> total`).

### 6.5 `searxng_extract_content`

Fetches one page and returns filtered, readable text. Input:

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `url` | string (valid URL) | required | http(s) page to fetch |
| `include_header` | bool | `false` | keep header/banner blocks |
| `include_footer` | bool | `false` | keep footer blocks |
| `include_navigation` | bool | `false` | keep nav menus/topbars/breadcrumbs |
| `include_sidebar` | bool | `false` | keep sidebars/widgets |
| `include_comments` | bool | `false` | keep comment sections |
| `include_links` | bool | `false` | render links as `[text](url)` |
| `include_images` | bool | `false` | render images as `![alt](src)` |
| `content_only` | bool | `true` | restrict to main content area when detectable |
| `selector` | string | — | CSS selector (subset); overrides `content_only` |
| `max_length` | int | `20000` (500–200000) | truncation limit |
| `start_char` | int ≥ 0 | `0` | start the output window at this character offset |
| `headings_only` | bool | `false` | return only the h1–h6 outline instead of the full text |

Output header + body:

```
# <title or "(no title)">
URL: <url>
[Language: <lang>]
[Description: <meta description>]
Content: <n> chars extracted[ — truncated to <m>]
[Window: starting at character <k> of <n>]
[Removed sections: <...> (use include_* options to keep them)]

<extracted content>
```

Behavioral guarantees:

- fetch guards: absolute http(s) only; HTTP errors surfaced with status; bodies > 5 MiB refused;
  30 s timeout by default (`SEARXNG_TIMEOUT_MS`); IPv4 fallback for `localhost`; with a browser
  configured, HTTP errors fall back to the rendered page and rendered HTML > 5 MiB is refused.
- content types: HTML (and XHTML/XML) go through the filtering pipeline; JSON bodies are returned
  pretty-printed in a fenced ```json block (raw fenced body when parsing fails); other `text/*`
  bodies are returned as fenced text; binary content types (PDF, images, archives, octet-stream)
  are refused with the supported types listed; an empty content-type is treated as HTML.
- `headings_only`: heading outline collected in document order after chrome removal (max 200,
  omitted count reported); `(no headings found)` when the page has none.
- `start_char`/`max_length` window the (cleaned) content; the header reports the window offset.
- extraction pipeline: parse DOM → capture metadata → remove chrome/noise → Mozilla Readability
  main-content detection → Turndown Markdown → window/truncate.
- `selector` with zero matches → recoverable tool error suggesting simpler selectors.

## 7. Extraction & filtering specification

Implemented in `src/extract.ts` on top of `linkedom` (DOM), `@mozilla/readability` (main-content
selection) and `turndown` (HTML → Markdown) — the same stack the clipper.js CLI uses.

**Rendered pages (optional).** With `SEARXNG_BROWSER_URL` (alias `OBSCURA_URL`) set, an HTML
page is still fetched once with the plain HTTP request (to learn its content type) and then
re-fetched as a rendered DOM through that CDP browser: lazy `import("puppeteer-core")`,
`page.goto(url, { waitUntil: "load" })`, a best-effort `waitForNetworkIdle` (5 s cap, ignored on
timeout), then `page.content()` into the pipeline below. The browser is also tried when the
plain fetch fails (network error or non-2xx, e.g. bot walls). JSON, `text/*` and binary bodies
never use it. `ws://`/`wss://` endpoints connect as a CDP socket, `http://`/`https://` through
the devtools HTTP endpoint. Without `puppeteer-core` installed the tool returns an explicit
error telling the user to install it or unset the variable.

### 7.1 Removal tiers

**Tier 1 — always removed** (never controllable): `script`, `style`, `noscript`, `template`,
`svg`, `iframe`, `object`, `embed`, `form`, `button`, `input`, `select`, `textarea`, `canvas`,
`video`, `audio`, `dialog`, `head`, `meta`, `link`, plus any `[aria-hidden="true"]`.

**Tier 2 — noise removed regardless of options** (matched on `id`/`class` tokens):
`cookie(s)`, `consent`, `gdpr`, `captcha`, `popup`, `modal`, `overlay`, `newsletter`,
`subscribe(d)`, `advert`, `advertisement`, `ads`, `ad`, `adsense`, `promo(moted)`,
`sponsored`, `paywall`, `skip-link`.

**Tier 3 — structural sections, removed unless opted in** (`include_*`):

| Section | Detection |
|---------|-----------|
| header | `<header>`, `[role=banner]`, id/class tokens: `header`, `masthead`, `topbar`, `siteheader`, `banner` |
| navigation | `<nav>`, `[role=navigation\|menu\|menubar]`, tokens: `nav`, `navbar`, `navigation`, `menu(s)`, `breadcrumb(s)`, `toc`, `tabs`, `topnav` |
| footer | `<footer>`, `[role=contentinfo]`, tokens: `footer`, `sitefooter`, `colophon` |
| sidebar | `<aside>`, `[role=complementary]`, tokens: `sidebar`, `sidenav`, `sidepanel`, `aside`, `widget(s)` |
| comments | tokens: `comments?`, `disqus`, `replies`, `discussion` |

Token classification applies to layout-ish tags only (`div`, `section`, `ul`, `ol`, `form`,
`span`) to limit false positives inside articles. Removed sections are recorded and reported.

### 7.2 Content root detection

With `content_only` (default), Mozilla Readability selects the article body from the cleaned DOM.
When Readability finds nothing usable (short pages, non-article layouts), the element among
`article`, `main`, `[role=main]` with the most text becomes the scope; otherwise the cleaned
`<body>`.
Sections kept via `include_*` that sit outside the extraction scope (typical: `nav`, `header`,
`footer` outside `<main>`) are rendered and appended after the scope content, so the opt-in is
honored even with the default scope. `selector` mode never appends (exact extraction).

### 7.3 Rendering rules (Turndown)

- Markdown: ATX headings, `-` bullets, fenced code blocks, blockquotes, emphasis, rules;
- links: text only by default, `[text](href)` when `include_links`;
- images: dropped by default, `![alt](src)` when `include_images`;
- whitespace normalized: line trailing spaces trimmed, runs of spaces collapsed, blank-line
  runs collapsed to one;
- truncation appends `[... truncated at <n> characters — raise max_length to get more]`.
- Readability may drop an `<h1>` that duplicates the page title; the title is still reported
  in the tool header.

## 8. Error handling

Errors are **tool-level results** (`isError: true`) with actionable text — the agent can read
and recover. Matrix:

| Condition | Detection | Message includes |
|-----------|-----------|------------------|
| Invalid `--url` / empty / bad protocol | `normalizeBaseUrl` at startup | example of a valid URL; process exits 2 |
| Instance unreachable | fetch throws | base URL + "check that the instance is running and that SEARXNG_URL is correct"; IPv4 retry applied first for `localhost` |
| HTTP 403 | `!res.ok` | JSON format disabled + `settings.yml` snippet (`formats: [html, json]`) |
| HTTP 429 | `!res.ok` | rate limiter hint (`server.limiter`) |
| Other HTTP errors | `!res.ok` | status + statusText + URL |
| Invalid JSON body | `res.json()` throws | "returned invalid JSON" + URL |
| Unexpected response shape | missing `results[]` | missing-field message |
| All requested `engines` unknown | resolve against `/config` before search | unknown names + "Call searxng_config to list valid engine names" |
| Extract: invalid/non-http URL | `new URL()` / protocol check | expected URL form |
| Extract: fetch HTTP error | `!res.ok` | status + bot-protection/JS hint |
| Extract: unsupported content-type (binary) | header check | actual content-type + supported types (HTML, JSON, plain text) |
| Extract: oversized body | content-length / text length > 5 MiB | byte limit |
| Extract: timeout | `AbortError` | duration |
| Extract: selector no match | `querySelectorAll` empty | suggestion to simplify the selector |

Fatal (non-tool) errors at startup: config problems → stderr + exit 2; unexpected fatal errors
→ stderr + exit 1.

## 9. Packaging & distribution

- `bin`: `searxng-mcp` → `dist/index.js` (bundled, `#!/usr/bin/env node`, executable bit set,
  `--target=node` so Node >= 18 runs it; `bun dist/index.js` also works).
- Build: `bun build ./index.ts --target=node --outdir=dist --external puppeteer-core` — single
  self-contained file (SDK + zod + linkedom + Readability + Turndown bundled, ~1.8 MB).
  `puppeteer-core` stays external (optional dependency) so the bundle carries no browser client.
- `dist/` is **committed** so installs from GitHub work without a build step. Validated flows:
  `bun install -g github:...` (binary on PATH, MCP handshake OK),
  `npm pack github:... && npm install -g <tgz>` (direct `npm install -g github:...` is broken
  on npm 10 — the global tree keeps a symlink to an ephemeral cache clone),
  `npx --yes github:...`. The packed tarball itself (registry artifact) is fully validated:
  `npm publish --dry-run` + install from the tgz both pass.
- `files`: `dist`, `README.md`, `SPEC.md`, `LICENSE`.
- npm name: scoped **`@aplix39/searxng-mcp`** (scope = maintainer's npm username) — the
  unscoped `searxng-mcp` is already registered on npm by an unrelated maintainer, so a scoped
  name is required to publish. The CLI binary and MCP server name remain `searxng-mcp`.
- `prepublishOnly`: `typecheck && test && build` — npm publication is always verified.
- `engines.node: >=18` (global `fetch`).

## 10. Testing strategy

Runner: `bun:test`. Suites (127 tests):

| Suite | Coverage |
|-------|----------|
| `test/config.test.ts` | URL normalization (slashes, `/search`, protocols), CLI parsing, precedence CLI > env > default, `SEARXNG_TIMEOUT_MS` parsing (default/valid/out-of-range), `SEARXNG_BROWSER_URL`/`OBSCURA_URL` precedence and scheme validation |
| `test/client.test.ts` | Query-string construction, param omission, empty-query rejection, 403/429/network/invalid-JSON messages, `time_range=week` + autocomplete `language` forwarding, autocompleter tuple parsing, IPv4 fallback behavior, `resolveEngines` (shortcut/case resolution, unknown reporting, dedup, `/config` caching, pass-through when `/config` fails or has no engines) |
| `test/format.test.ts` | Truncation, domain matching (subdomains, protocol-prefixed patterns), result rendering per kind, limit/overflow notes, answers (string AND object forms — no `[object Object]`)/infoboxes/corrections/suggestions/unresponsive engines, ignored-unknown-engines note, config grouping + compact `includeEngines: false` mode |
| `test/extract.test.ts` | Metadata capture, default chrome/noise removal + reporting, `include_*` re-inclusion (including sections outside the content scope), `<pre>` entity preservation + real-tag stripping, content-root detection, link/image modes, selector success/failure (no append in selector mode), `start_char` windowing, `headings_only` outline, truncation, fetch guards (URL/protocol/HTTP/content-type/size) incl. JSON/text fenced rendering and binary refusal, browser rendering (`browserConnectOptions` endpoint mapping, render path, bot-wall fallback, JSON stays on plain fetch) |
| `test/server.test.ts` | End-to-end MCP via `InMemoryTransport` + SDK `Client`: tool listing, search call + parameter forwarding (incl. `time_range=week`), engine resolution (shortcut → name), all-unknown-engines error, partially-unknown-engines note, domain filtering, category pinning, error propagation (`isError`), config/autocomplete (`language`)/extract (`start_char`, `headings_only`) tools |
| `test/version.test.ts` | `VERSION` ↔ `package.json` consistency (the published `--version` must equal the npm version; enforced by the `version` lifecycle script + this guard) |

All HTTP I/O is injectable (`FetchFn`), so tests are hermetic; a manual smoke test against a
real instance validates the shipped `dist` bundle over stdio.

## 11. Security & privacy

- The server never sends data anywhere except the configured SearXNG instance and pages the
  agent explicitly asks to extract.
- No secrets handling: SearXNG needs no credentials; the MCP keeps none.
- Extraction refuses non-HTTP(S) protocols (`file:`, `ftp:`, ...) and caps response sizes.
- Operators should keep instances off the public internet or enable the SearXNG limiter;
  this MCP adds no auth of its own.

## 12. Roadmap (post-1.0)

- `output=raw` option returning raw JSON for programmatic post-processing.
- MCP resources (`searxng://config`, saved searches) and prompt templates.
- Optional result caching (TTL) and client-side concurrency control.
- Per-engine health summary tool (based on `unresponsive_engines` history).
- HTML output mode of the extractor (readability-style) for multimodal agents.
- npm publication + CI workflow (typecheck/test/build matrix on Node + Bun).
