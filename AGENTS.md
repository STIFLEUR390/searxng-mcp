# AGENTS.md

## Project

`searxng-mcp` — an MCP server (SearXNG search) built on `@modelcontextprotocol/sdk`.
Status: implemented. `index.ts` boots a stdio MCP server exposing 7 tools
(`searxng_search`, `searxng_search_news`, `searxng_search_images`,
`searxng_search_videos`, `searxng_autocomplete`, `searxng_config`,
`searxng_extract_content`). Configured via `SEARXNG_URL` env var or `--url`
flag (default `http://localhost:8888`). `dist/index.js` is a committed bundle
used by the `bin` entry for global installs.

## Runtime & commands

Bun only — no Node/npm/yarn/pnpm (`bun.lock` is the only lockfile).

```bash
bun install          # install deps
bun run dev          # run the entrypoint from source
bun run index.ts     # same (no devDependencies required at runtime)
bun test             # tests (bun:test)
bun run build        # bundle to dist/index.js (node target)
bunx tsc --noEmit    # typecheck — no script defined, run this directly
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

## Gotchas

- No `.env` handling beyond Bun's automatic loading — never add `dotenv`.
- Don't add frameworks (express, vite, jest): `CLAUDE.md` explicitly rules them out.
