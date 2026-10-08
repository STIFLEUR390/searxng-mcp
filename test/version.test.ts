import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { VERSION } from "../src/version.ts";

describe("version consistency", () => {
  test("VERSION matches package.json (published --version must equal the npm version)", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
