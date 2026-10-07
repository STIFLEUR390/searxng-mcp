# AGENTS.md

## Project

`searxng-mcp` — an MCP server (SearXNG search) built on `@modelcontextprotocol/sdk`.
Status: fresh `bun init` scaffold. `index.ts` (the `module` entrypoint) is still
`console.log("Hello via Bun!")` — the server is not implemented yet.

## Runtime & commands

Bun only — no Node/npm/yarn/pnpm (`bun.lock` is the only lockfile).

```bash
bun install          # install deps
bun run index.ts     # run the entrypoint (there are no package.json scripts)
bun test             # tests (none exist yet; use bun:test, not jest/vitest)
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
