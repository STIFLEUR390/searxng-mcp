# AGENTS.md

## Project

`searxng-mcp` — an MCP server (SearXNG search) built on `@modelcontextprotocol/sdk`.
Status: implemented. `index.ts` boots a stdio MCP server exposing 7 tools
(`searxng_search`, `searxng_search_news`, `searxng_search_images`,
`searxng_search_videos`, `searxng_autocomplete`, `searxng_config`,
`searxng_extract_content`). Configured via `SEARXNG_URL` env var or `--url`
flag (default `http://localhost:8888`); `SEARXNG_TIMEOUT_MS` tunes the
per-request timeout (default 30000); `SEARXNG_BROWSER_URL` (alias `OBSCURA_URL`)
optionally points extraction at a CDP browser (Obscura, Chrome). `dist/index.js` is a committed bundle
used by the `bin` entry for global installs — it must be rebuilt (`bun run
build`) when `index.ts` or `src/` changes.

Other instruction sources: `CLAUDE.md` (Bun-only conventions: prefer Bun
built-ins, never Node/Express equivalents) and `SPEC.md` (the spec of record
for tool behavior and output formats).

## Kaneo tracking

This project is tracked in Kaneo — use these IDs instead of searching for it:

- workspace_id: `GAiYlKA3Nr2yEh3Ea40IY0f0tvK4rjQ0`
- project_id: `s3gxqflx3wxc15ktgj6x7xly` (project "Searxng Mcp")

## Runtime & commands

Bun only — no Node/npm/yarn/pnpm (`bun.lock` is the only lockfile).

```bash
bun install          # install deps
bun run dev          # run the entrypoint from source
bun run index.ts     # same (no devDependencies required at runtime)
bun test             # 127 tests, bun:test, offline (no network)
bun run typecheck    # bunx tsc --noEmit
bun run build        # bundle to dist/index.js (node target) — required after any src/index.ts edit
npm version patch    # syncs src/version.ts (scripts/sync-version.mjs), rebuilds dist/, commits + tags
                     # never bump package.json or src/version.ts by hand
```

Per-file test: `bun test test/client.test.ts` or `bun test -t "name"`.
`prepublishOnly` runs typecheck + tests + build — treat that as the pre-commit gate.

There is no linter, formatter, CI workflow, or pre-commit config. Don't invent one
unless asked.

## Conventions

- Follow `CLAUDE.md`: prefer Bun built-ins (`Bun.serve`, `Bun.file`, `bun:sqlite`,
  `Bun.$`) over Node/Express equivalents, and `bunx` over `npx`.
- `tsconfig.json` is strict with `noUncheckedIndexedAccess` and
  `noImplicitOverride`; `verbatimModuleSyntax` + `moduleResolution: bundler`, so
  use `import type` for type-only imports and `.ts` extensions in imports are allowed.
- ESM (`"type": "module"`).
- stdout is reserved for the MCP protocol — log to stderr only (`console.error`).
- Tests inject `fetchFn` into `SearXNGClient` instead of mocking global `fetch`
  (see `test/client.test.ts`); no network in tests.
- `test/version.test.ts` asserts `src/version.ts` matches `package.json`. Never
  bump the version by hand — `npm version patch` runs `scripts/sync-version.mjs`,
  rebuilds `dist/`, commits and tags.
- `dist/` is intentionally committed (global install from GitHub without a build);
  never add it to `.gitignore`.

## Gotchas

- `engines` filtering is not a pass-through: `SearXNGClient.resolveEngines` maps shortcuts/casing
  against `/config` (cached `ENGINE_CACHE_TTL_MS` = 10 min) and the server errors on unknown names.
  Preserve that path when touching search params.
- `index.ts`/`src/` are the only sources; `dist/index.js` is generated but committed.
- HTML extraction is `linkedom` + `@mozilla/readability` + `turndown` (clipper.js stack, no
  jsdom). `tsconfig.json` therefore includes the `DOM` lib. `cleanDom` intentionally
  skips dropping an element that holds >60% of the page's text — Tailwind class strings like
  `--banner-height` otherwise match section tokens and nuke the article.
- Browser rendering is opt-in and must stay out of the bundle: `puppeteer-core` is an
  `optionalDependencies` entry loaded by `await import("puppeteer-core")`, and the build script
  passes `--external puppeteer-core`. Drop that flag and dist jumps by several MB.
  The renderer is `page.goto(waitUntil: "load")` + best-effort `waitForNetworkIdle` — puppeteer's
  `networkidle2` hangs against Obscura. Tests inject `renderHtml`/`browserUrl` into `FetchDeps`
  instead of touching a browser.
- No `.env` handling beyond Bun's automatic loading — never add `dotenv`.
- Don't add frameworks (express, vite, jest): `CLAUDE.md` explicitly rules them out.
