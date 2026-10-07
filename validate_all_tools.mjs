import { spawn } from "node:child_process";

const proc = spawn("node", ["dist/index.js"], { cwd: process.cwd() });
let buf = "";
const pending = new Map();
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
proc.stderr.on("data", () => {});
let id = 0;
function rpc(method, params) {
  return new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
}
function call(name, args) {
  return rpc("tools/call", { name, arguments: args }).then((r) => ({
    isError: r.result?.isError ?? false,
    text: r.result?.content?.[0]?.text ?? "",
  }));
}
function check(label, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} — ${label}${cond ? "" : " | " + extra.slice(0, 300)}`);
  if (!cond) process.exitCode = 1;
}

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "v", version: "0" } });
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

// 1. general search with domain include filter (structural assertion)
let r = await call("searxng_search", { q: "metasearch engine", limit: 10, include_domains: ["wikipedia.org"] });
const resultUrls = r.text.split("## Results")[1]?.match(/https?:\/\/[^\s]+/g) ?? [];
const onlyAllowed = resultUrls.every((u) => u.includes("wikipedia.org"));
check("search include_domains filters (only allowed hosts + filtered note)",
  !r.isError && resultUrls.length > 0 && onlyAllowed && r.text.includes("filtered from"), r.text);

// 2. news + time_range + safesearch forwarded
r = await call("searxng_search_news", { q: "searxng", time_range: "month", safesearch: 1, limit: 3 });
check("news search returns results/valid", !r.isError && (r.text.includes("## Results") || r.text.includes("No results found")), r.text);

// 3. images
r = await call("searxng_search_images", { q: "mountains", limit: 3 });
check("images include image/thumbnail lines", !r.isError && (r.text.includes("image:") || r.text.includes("No results found")), r.text);

// 4. videos
r = await call("searxng_search_videos", { q: "bun runtime", limit: 3 });
check("videos search valid", !r.isError && (r.text.includes("## Results") || r.text.includes("No results found")), r.text);

// 5. autocomplete
r = await call("searxng_autocomplete", { q: "searxng do" });
check("autocomplete suggestions", !r.isError && r.text.includes("Suggestions for"), r.text);

// 6. config
r = await call("searxng_config", {});
check("config categories+engines", !r.isError && r.text.includes("Categories (") && r.text.includes("Engines:"), r.text);

// 7. extraction with defaults (chrome removed)
r = await call("searxng_extract_content", { url: "https://docs.searxng.org/admin/settings/settings_search.html", max_length: 3000 });
check("extract removes chrome + reports", !r.isError && r.text.includes("Removed sections:") && r.text.includes("URL:"), r.text);

// 8. extraction include_footer + include_links
r = await call("searxng_extract_content", { url: "https://docs.searxng.org/admin/settings/settings_search.html", include_footer: true, include_links: true, max_length: 3000 });
check("extract include_footer/links options accepted", !r.isError, r.text);

// 9. extraction selector
r = await call("searxng_extract_content", { url: "https://docs.searxng.org/admin/settings/settings_search.html", selector: "article", max_length: 2000 });
check("extract selector=article", !r.isError && !r.text.includes("No element matches"), r.text);

// 10. extraction error path (404)
r = await call("searxng_extract_content", { url: "https://docs.searxng.org/this-page-does-not-exist-xyz" });
check("extract 404 -> isError", r.isError && r.text.includes("HTTP 404"), r.text);

// 11. engine restriction
r = await call("searxng_search", { q: "wikipedia metasearch", engines: ["wikipedia"], limit: 3 });
check("engines restriction", !r.isError && (r.text.includes("wikipedia") || r.text.includes("No results found")), r.text);

// 12. pagination
r = await call("searxng_search", { q: "test", pageno: 2, limit: 2 });
check("pageno=2 works", !r.isError, r.text);

// 13. language
r = await call("searxng_search", { q: "bonjour", language: "fr", limit: 2 });
check("language=fr works", !r.isError, r.text);

// 14. invalid tool args rejected by schema
const bad = await rpc("tools/call", { name: "searxng_search", arguments: { q: "" } });
check("empty q rejected by zod schema", JSON.stringify(bad.result ?? bad.error).includes("invalid") || bad.result?.isError === true, JSON.stringify(bad).slice(0, 300));

proc.kill();
console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL LIVE CHECKS PASSED");
