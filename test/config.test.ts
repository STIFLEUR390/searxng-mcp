import { describe, expect, test } from "bun:test";

import {
  ConfigError,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  ENV_TIMEOUT_MS,
  normalizeBaseUrl,
  parseArgs,
  resolveBaseUrl,
  resolveTimeoutMs,
} from "../src/config.ts";

describe("normalizeBaseUrl", () => {
  test("keeps a clean base URL", () => {
    expect(normalizeBaseUrl("http://localhost:8888")).toBe("http://localhost:8888");
    expect(normalizeBaseUrl("https://searx.example.org")).toBe("https://searx.example.org");
  });

  test("strips trailing slashes", () => {
    expect(normalizeBaseUrl("http://localhost:8888/")).toBe("http://localhost:8888");
    expect(normalizeBaseUrl("http://localhost:8888///")).toBe("http://localhost:8888");
  });

  test("strips a trailing /search (pasted search URL)", () => {
    expect(normalizeBaseUrl("http://localhost:8888/search")).toBe("http://localhost:8888");
    expect(normalizeBaseUrl("https://searx.example.org/search/")).toBe("https://searx.example.org");
  });

  test("preserves sub-paths", () => {
    expect(normalizeBaseUrl("https://example.org/searxng/")).toBe("https://example.org/searxng");
  });

  test("trims whitespace", () => {
    expect(normalizeBaseUrl("  http://localhost:8888  ")).toBe("http://localhost:8888");
  });

  test("rejects invalid URLs", () => {
    expect(() => normalizeBaseUrl("not a url")).toThrow(ConfigError);
    expect(() => normalizeBaseUrl("")).toThrow(ConfigError);
    expect(() => normalizeBaseUrl("   ")).toThrow(ConfigError);
  });

  test("rejects non-http(s) protocols", () => {
    expect(() => normalizeBaseUrl("ftp://localhost:8888")).toThrow(ConfigError);
    expect(() => normalizeBaseUrl("file:///tmp/x")).toThrow(ConfigError);
  });
});

describe("parseArgs", () => {
  test("defaults", () => {
    expect(parseArgs([])).toEqual({ help: false, version: false });
  });

  test("--url with separate value", () => {
    expect(parseArgs(["--url", "http://localhost:8888"])).toEqual({
      help: false,
      version: false,
      baseUrl: "http://localhost:8888",
    });
  });

  test("--url=value form", () => {
    expect(parseArgs(["--url=https://searx.example.org"]).baseUrl).toBe("https://searx.example.org");
  });

  test("-u short flag", () => {
    expect(parseArgs(["-u", "http://localhost:9999"]).baseUrl).toBe("http://localhost:9999");
  });

  test("help and version flags", () => {
    expect(parseArgs(["--help"])).toEqual({ help: true, version: false });
    expect(parseArgs(["-V"])).toEqual({ help: false, version: true });
  });

  test("rejects missing --url value", () => {
    expect(() => parseArgs(["--url"])).toThrow(ConfigError);
    expect(() => parseArgs(["--url", "--help"])).toThrow(ConfigError);
    expect(() => parseArgs(["--url="])).toThrow(ConfigError);
  });

  test("rejects unknown arguments", () => {
    expect(() => parseArgs(["--verbose"])).toThrow(ConfigError);
    expect(() => parseArgs(["extra"])).toThrow(ConfigError);
  });
});

describe("resolveBaseUrl", () => {
  test("CLI flag wins over env and default", () => {
    const env = { SEARXNG_URL: "http://env:1111" };
    expect(resolveBaseUrl(["--url", "http://cli:2222"], env)).toBe("http://cli:2222");
  });

  test("env var used when no flag", () => {
    const env = { SEARXNG_URL: "http://env:1111" };
    expect(resolveBaseUrl([], env)).toBe("http://env:1111");
  });

  test("default used when nothing set", () => {
    expect(resolveBaseUrl([], {})).toBe(DEFAULT_BASE_URL);
    expect(DEFAULT_BASE_URL).toBe("http://localhost:8888");
  });
});

describe("resolveTimeoutMs", () => {
  test("defaults when unset or empty", () => {
    expect(resolveTimeoutMs({})).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs({ [ENV_TIMEOUT_MS]: "" })).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs({ [ENV_TIMEOUT_MS]: "  " })).toBe(DEFAULT_TIMEOUT_MS);
  });

  test("parses a valid integer", () => {
    expect(resolveTimeoutMs({ [ENV_TIMEOUT_MS]: "60000" })).toBe(60000);
    expect(resolveTimeoutMs({ [ENV_TIMEOUT_MS]: " 500 " })).toBe(500);
  });

  test("rejects out-of-range and non-integer values", () => {
    expect(() => resolveTimeoutMs({ [ENV_TIMEOUT_MS]: "499" })).toThrow(ConfigError);
    expect(() => resolveTimeoutMs({ [ENV_TIMEOUT_MS]: "300001" })).toThrow(ConfigError);
    expect(() => resolveTimeoutMs({ [ENV_TIMEOUT_MS]: "abc" })).toThrow(ConfigError);
    expect(() => resolveTimeoutMs({ [ENV_TIMEOUT_MS]: "1.5" })).toThrow(ConfigError);
    expect(() => resolveTimeoutMs({ [ENV_TIMEOUT_MS]: "-1000" })).toThrow(ConfigError);
  });
});
