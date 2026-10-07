# searxng-mcp

MCP (Model Context Protocol) server that plugs a [SearXNG](https://searxng.org) metasearch
instance into AI agents: privacy-friendly **web, news, image and video search**, plus **clean
page content extraction with structural filtering** (no headers, footers, navbars or sidebars
unless the agent asks for them).

[![MCP](https://img.shields.io/badge/MCP-server-blue)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun%20%7C%20Node%20%3E%3D18-black)](#installation)

## Why

- **Metasearch** — one query fans out to many engines (Google, Bing, Brave, DuckDuckGo,
  Wikipedia, news outlets, ...) while your identity stays with *your* instance.
- **Bring your own instance** — works with any SearXNG deployment (local Docker, LAN server,
  public instance). The only configuration is the instance URL.
- **Agent-friendly output** — results are rendered as compact structured text, not raw HTML.
- **Content extraction with filtering** — the agent can fetch any page and decide it does *not*
  need the site chrome: headers, footers, navigation menus, sidebars, cookie banners, ads and
  comment sections are stripped by default and can be re-included per call.

## Tools

| Tool | What it does |
|------|--------------|
| `searxng_search` | General search on any SearXNG category, with language, pagination, time range, SafeSearch, engine selection and domain filters |
| `searxng_search_news` | News search (`categories=news`), friendly with `time_range` |
| `searxng_search_images` | Image search — includes full image URL + thumbnail |
| `searxng_search_videos` | Video search — includes page URL + thumbnail |
| `searxng_autocomplete` | Query suggestions from the instance's autocomplete provider |
| `searxng_config` | Instance overview: categories + enabled engines grouped by category |
| `searxng_extract_content` | Fetch a page and extract readable text with structural filtering |

## Requirements

- **Node.js >= 18** (or **Bun >= 1.x**) on the machine running the MCP server
- A running **SearXNG** instance with the **JSON format enabled**

### Enable JSON output on your SearXNG instance

The API returns 403 unless `json` is in `search.formats`:

```yaml
# settings.yml
search:
  formats:
    - html
    - json
```

Restart SearXNG after editing. Verify with:

```bash
curl 'http://localhost:8888/search?q=test&format=json' | head -c 200
```

## Installation

### Bun (global)

```bash
bun install -g github:STIFLEUR390/searxng-mcp
searxng-mcp --url http://localhost:8888
```

### npm (global)

npm does not reliably link global binaries from git dependencies (npm 10 keeps the package as
a symlink to an ephemeral cache clone), so pack the repo first, then install the tarball:

```bash
npm pack github:STIFLEUR390/searxng-mcp
npm install -g ./aplix39-searxng-mcp-*.tgz
searxng-mcp --url http://localhost:8888
```

Once the package is published to the registry (see [Publishing to npm](#publishing-to-npm)),
plain `npm install -g @aplix39/searxng-mcp` works too.

### npx (zero install, run on demand)

```bash
npx --yes github:STIFLEUR390/searxng-mcp --url http://localhost:8888
```

### From source

```bash
git clone https://github.com/STIFLEUR390/searxng-mcp.git
cd searxng-mcp
bun install
bun run build       # produces the self-contained dist/index.js
node dist/index.js --url http://localhost:8888
```

> The `dist/` bundle is committed to the repo so the install flows above work straight from
> GitHub without a build step. All three flows (bun global, npm pack+install, npx) are
> validated against the released commit.

## Configuration

The SearXNG URL is resolved in this order:

| Precedence | Source | Example |
|-----------|--------|---------|
| 1 | `--url` / `-u` CLI flag | `searxng-mcp --url https://searx.example.org` |
| 2 | `SEARXNG_URL` environment variable | `SEARXNG_URL=https://searx.example.org searxng-mcp` |
| 3 | Built-in default | `http://localhost:8888` |

Trailing slashes and a pasted `/search` suffix are normalized automatically. If the host is
`localhost` and the connection fails (Node resolves it to IPv6 `::1` first), the server retries
once on `127.0.0.1`.

CLI flags: `--help`, `--version`.

## Client setup

### Claude Code

```bash
claude mcp add searxng --env SEARXNG_URL=http://localhost:8888 -- npx --yes github:STIFLEUR390/searxng-mcp
```

### Claude Desktop / Cursor / generic MCP client

```json
{
  "mcpServers": {
    "searxng": {
      "command": "npx",
      "args": ["--yes", "github:STIFLEUR390/searxng-mcp"],
      "env": { "SEARXNG_URL": "http://localhost:8888" }
    }
  }
}
```

With a global install, `command` can simply be `searxng-mcp` with no args (the default URL is
`http://localhost:8888`), or pass `--url` in `args`.

## Tools reference

### `searxng_search`

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string (required) | Search query, engine syntax supported |
| `categories` | string[] | e.g. `["general"]`, `["it", "science"]`. Default `["general"]` |
| `language` | string | Language code: `en`, `fr`, `de`, ... |
| `pageno` | int 1–50 | Results page |
| `time_range` | `day` \| `month` \| `year` | Restrict to recent results |
| `safesearch` | int 0–2 | 0=off, 1=moderate, 2=strict |
| `engines` | string[] | Restrict to engines by name/shortcut, e.g. `["duckduckgo", "brave"]` |
| `limit` | int 1–50 | Max results rendered (default 10) |
| `include_domains` | string[] | Keep only results on these domains |
| `exclude_domains` | string[] | Drop results on these domains |

Output: numbered results (title, URL, snippet, engines, category, publication date), plus
answers, infoboxes, corrections, related searches and unresponsive-engine notes when present.

`searxng_search_news`, `searxng_search_images` and `searxng_search_videos` are the same tool
pinned to their category (images/videos also surface image + thumbnail URLs).

### `searxng_autocomplete`

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string (required) | Partial query |

### `searxng_config`

No parameters. Returns categories and enabled engines grouped by category — useful to discover
what the instance can search before picking categories/engines.

### `searxng_extract_content`

Fetches a page (typically a URL found with the search tools) and returns clean, readable text.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string (required) | — | Absolute http(s) URL |
| `include_header` | bool | `false` | Keep site header/banner blocks |
| `include_footer` | bool | `false` | Keep site footer blocks |
| `include_navigation` | bool | `false` | Keep menus, topbars, breadcrumbs |
| `include_sidebar` | bool | `false` | Keep sidebars / widgets |
| `include_comments` | bool | `false` | Keep comment sections |
| `include_links` | bool | `false` | Render links as markdown `[text](url)` |
| `include_images` | bool | `false` | Render images as markdown `![alt](src)` |
| `content_only` | bool | `true` | Extract only the main content area (`article`/`main`) when detectable |
| `selector` | string | — | Advanced: extract only nodes matching this CSS selector |
| `max_length` | int 500–200000 | `20000` | Truncate the content to this many characters |

Always removed regardless of options: `script`, `style`, `noscript`, `iframe`, forms, and noise
banners (cookies, consent, popups, ads, newsletter boxes). The response reports which sections
were removed so the agent can re-include them on the next call.

Sections kept via `include_*` that live outside the main content area (nav/header/footer usually
sit outside `<main>`) are appended to the output, so the opt-in is honored with the default
`content_only` too. With `selector`, extraction stays exact (nothing is appended).

Example: the agent found a page but only wants the article body:

```json
{ "name": "searxng_extract_content", "arguments": { "url": "https://example.org/post/1" } }
```

It needs the footer legal notice too:

```json
{
  "name": "searxng_extract_content",
  "arguments": { "url": "https://example.org/post/1", "include_footer": true }
}
```

## Example session

> **User:** what are the latest news about SearXNG?
>
> **Agent** → `searxng_search_news { "q": "searxng", "time_range": "month", "limit": 5 }`
>
> **User:** open the first result and summarize it
>
> **Agent** → `searxng_extract_content { "url": "…" }` (header/footer/nav already filtered out)

## Troubleshooting

| Symptom | Cause & fix |
|---------|-------------|
| `403 Forbidden` in tool errors | JSON format disabled → add `json` to `search.formats` in `settings.yml` |
| `429 Too Many Requests` | Instance rate limiter (`server.limiter`) blocking automated calls → adjust `limiter` or retry later |
| `Could not reach SearXNG ... fetch failed` | Instance not running, wrong URL, or IPv6/IPv4 mismatch — the server already retries `localhost` on `127.0.0.1`; otherwise use `http://127.0.0.1:8888` explicitly |
| `content-type ... is not HTML` | The extractor only processes HTML pages |
| Empty results | Some engines may be down on the instance — check `searxng_config` and the `unresponsive_engines` note in results |

## Development

```bash
bun install          # install dependencies
bun run dev          # run the server from source (TypeScript)
bun test             # 84 unit + integration tests (bun:test)
bunx tsc --noEmit    # strict typecheck
bun run build        # bundle to dist/index.js (node target)
```

Project layout:

```
index.ts            # CLI entry point (stdio MCP server)
src/config.ts       # CLI/env parsing, URL normalization
src/client.ts       # SearXNG HTTP client (/search, /autocompleter, /config)
src/extract.ts      # HTML fetch + structural filtering + text rendering
src/format.ts       # SearXNG response → agent-friendly text
src/server.ts       # MCP tool registration
src/types.ts        # SearXNG API types
test/               # bun:test suites
```

## Publishing to npm

> **Note:** the unscoped name `searxng-mcp` is already taken on npm by an unrelated project
> (maintained by someone else), so this package uses the scoped name
> **`@aplix39/searxng-mcp`** (scope = the maintainer's npm username). Nothing changes for
> GitHub installs, and the CLI binary stays `searxng-mcp`.

The package is npm-ready (scoped `name`, `bin`, `files`, `prepublishOnly` runs typecheck +
tests + build):

```bash
npm login                       # authenticate as the npm user owning the scope
npm publish --access public    # publishes @aplix39/searxng-mcp
```

> The scope matches the maintainer's npm username (`aplix39`); adjust it in `package.json` if
> publishing from another account.

Then users can install globally without the GitHub prefix:

```bash
npm install -g @aplix39/searxng-mcp
npx @aplix39/searxng-mcp --url http://localhost:8888
```

## License

[MIT](LICENSE) © STIFLEUR390
