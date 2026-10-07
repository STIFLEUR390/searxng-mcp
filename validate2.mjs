import { spawn } from "node:child_process";
const proc = spawn("node", ["dist/index.js"], { cwd: process.cwd() });
let buf = ""; const pending = new Map();
proc.stdout.on("data", (d) => { buf += d.toString(); let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; const m = JSON.parse(l); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
proc.stderr.on("data", () => {});
let id = 0;
const rpc = (method, params) => new Promise((res) => { const my = ++id; pending.set(my, res); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n"); });
const call = (name, args) => rpc("tools/call", { name, arguments: args }).then((r) => ({ isError: r.result?.isError ?? false, text: r.result?.content?.[0]?.text ?? "" }));
await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "v", version: "0" } });
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

let r = await call("searxng_search", { q: "metasearch engine", limit: 10 });
console.log("=== baseline (no filter) ===");
console.log(r.text.split("\n").filter((l) => /^\d+\.|https?:\/\//.test(l.trim())).slice(0, 14).join("\n"));

r = await call("searxng_search", { q: "metasearch engine", limit: 10, include_domains: ["wikipedia.org"] });
console.log("=== include wikipedia.org ===");
console.log(r.text.split("\n").slice(0, 4).join("\n"));
console.log(r.text.split("\n").filter((l) => l.includes("http")).join("\n"));

r = await call("searxng_search", { q: "metasearch engine", limit: 10, exclude_domains: ["wikipedia.org"] });
console.log("=== exclude wikipedia.org ===");
console.log(r.text.split("\n").filter((l) => l.includes("http")).slice(0, 10).join("\n"));
proc.kill();
