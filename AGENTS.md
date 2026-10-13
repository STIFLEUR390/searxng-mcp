# AGENTS.md

## Project

`searxng-mcp` — an MCP server (SearXNG search) built on `@modelcontextprotocol/sdk`.
Status: implemented. `index.ts` boots a stdio MCP server exposing 7 tools
(`searxng_search`, `searxng_search_news`, `searxng_search_images`,
`searxng_search_videos`, `searxng_autocomplete`, `searxng_config`,
`searxng_extract_content`). Configured via `SEARXNG_URL` env var or `--url`
flag (default `http://localhost:8888`); `SEARXNG_TIMEOUT_MS` tunes the
per-request timeout (default 30000). `dist/index.js` is a committed bundle
used by the `bin` entry for global installs — it must be rebuilt (`bun run
build`) when `index.ts` or `src/` changes.

Other instruction sources: `CLAUDE.md` (Bun-only conventions: prefer Bun
built-ins, never Node/Express equivalents) and `SPEC.md` (the spec of record
for tool behavior and output formats).

## Runtime & commands

Bun only — no Node/npm/yarn/pnpm (`bun.lock` is the only lockfile).

```bash
bun install          # install deps
bun run dev          # run the entrypoint from source
bun run index.ts     # same (no devDependencies required at runtime)
bun test             # tests (bun:test)
bun run build        # bundle to dist/index.js (node target)
bunx tsc --noEmit    # typecheck — no script defined, run this directly
npm version patch    # release bump: auto-syncs src/version.ts (scripts/sync-version.mjs),
                     # commits + tags — never bump package.json by hand
```

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

- No `.env` handling beyond Bun's automatic loading — never add `dotenv`.
- Don't add frameworks (express, vite, jest): `CLAUDE.md` explicitly rules them out.
