import { spawn } from "node:child_process";
const proc = spawn("node", ["dist/index.js"], { cwd: process.cwd() });
let buf = ""; const pending = new Map();
proc.stdout.on("data", (d) => { buf += d.toString(); let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; const m = JSON.parse(l); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
proc.stderr.on("data", () => {});
let id = 0;
const rpc = (method, params) => new Promise((res) => { const my = ++id; pending.set(my, res); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n"); });
await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "v", version: "0" } });
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const { tools } = (await rpc("tools/list", {})).result;

// Expected contract from README/SPEC
const expected = {
  searxng_search: ["q","categories","language","pageno","time_range","safesearch","engines","limit","include_domains","exclude_domains"],
  searxng_search_news: ["q","language","pageno","time_range","safesearch","engines","limit","include_domains","exclude_domains"],
  searxng_search_images: ["q","language","pageno","time_range","safesearch","engines","limit","include_domains","exclude_domains"],
  searxng_search_videos: ["q","language","pageno","time_range","safesearch","engines","limit","include_domains","exclude_domains"],
  searxng_autocomplete: ["q"],
  searxng_config: [],
  searxng_extract_content: ["url","include_header","include_footer","include_navigation","include_sidebar","include_comments","include_links","include_images","content_only","selector","max_length"],
};
let ok = true;
for (const [name, params] of Object.entries(expected)) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) { console.log(`FAIL — tool missing: ${name}`); ok = false; continue; }
  const actual = Object.keys(tool.inputSchema?.properties ?? {}).sort();
  const want = [...params].sort();
  const match = JSON.stringify(actual) === JSON.stringify(want);
  if (!match) ok = false;
  console.log(`${match ? "PASS" : "FAIL"} — ${name} params${match ? "" : `\n  actual:   ${actual.join(",")}\n  expected: ${want.join(",")}`}`);
}
// validate enum + ranges documented in README
const search = tools.find((t) => t.name === "searxng_search");
const tr = search.inputSchema.properties.time_range;
const ss = search.inputSchema.properties.safesearch;
const lim = search.inputSchema.properties.limit;
const trOk = JSON.stringify(tr.enum ?? tr.anyOf?.flatMap((x) => x.enum ?? [])) === JSON.stringify(["day","month","year"]);
const ssOk = ss.minimum === 0 && ss.maximum === 2;
const limOk = lim.minimum === 1 && lim.maximum === 50;
console.log(`${trOk ? "PASS" : "FAIL"} — time_range enum [day,month,year]`);
console.log(`${ssOk ? "PASS" : "FAIL"} — safesearch 0..2`);
console.log(`${limOk ? "PASS" : "FAIL"} — limit 1..50`);
const ex = tools.find((t) => t.name === "searxng_extract_content");
const ml = ex.inputSchema.properties.max_length;
console.log(`${ml.minimum === 500 && ml.maximum === 200000 ? "PASS" : "FAIL"} — max_length 500..200000`);
// annotations
const annOk = tools.every((t) => t.annotations?.readOnlyHint === true);
console.log(`${annOk ? "PASS" : "FAIL"} — all tools readOnlyHint=true`);
proc.kill();
process.exit(ok && trOk && ssOk && limOk && annOk ? 0 : 1);
