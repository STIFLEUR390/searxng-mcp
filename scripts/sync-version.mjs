#!/usr/bin/env node
/**
 * Keep src/version.ts in sync with package.json.
 *
 * Runs automatically from the npm "version" lifecycle script (wired in
 * package.json), so `npm version patch|minor|major` bumps both files in the
 * same commit. Can also be run manually: `node scripts/sync-version.mjs`.
 */
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = String(pkg.version);
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`sync-version: invalid version "${version}" in package.json`);
  process.exit(1);
}

const next = `/** Single source of truth for the server version. Keep in sync with package.json. */\nexport const VERSION = "${version}";\n`;
writeFileSync(new URL("../src/version.ts", import.meta.url), next);
console.log(`sync-version: src/version.ts → ${version}`);
