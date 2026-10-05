#!/usr/bin/env bun
/**
 * A recording stand-in for `claude mcp` (task 01a0d6b9). Run as
 * `bun stub_claude_mcp.ts <args>` by a wrapper named `claude`.
 *
 *  - every argv is appended, as one JSON line, to $STUB_CLAUDE_ARGV_LOG;
 *  - `mcp add-json -s local NAME JSON` writes JSON under
 *    projects[<cwd>].mcpServers[NAME] in $HOME/.claude.json, the way Claude
 *    Code 2.1.289 does (measured 2026-10-05), refusing an existing name;
 *  - `mcp remove NAME -s local` deletes it; `mcp list` reports both connected;
 *  - `mcp get NAME` prints the entry the way 2.1.289 does (no headersHelper line).
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const log = process.env.STUB_CLAUDE_ARGV_LOG;
if (log) appendFileSync(log, `${JSON.stringify(args)}\n`);
const file = join(process.env.HOME ?? "/nonexistent", ".claude.json");
const cwd = process.env.PWD && existsSync(process.env.PWD) ? process.cwd() : process.cwd();
const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { projects: {} });
const servers = (doc: any) => ((doc.projects[cwd] ??= {}).mcpServers ??= {});

if (args[0] === "mcp" && args[1] === "add-json") {
  const [, , flag, scope, name, json] = args;
  if (flag !== "-s" || scope !== "local" || !name || !json) process.exit(2);
  const doc = read();
  if (servers(doc)[name] !== undefined) {
    console.error(`MCP server ${name} already exists in local config`);
    process.exit(1);
  }
  servers(doc)[name] = JSON.parse(json);
  writeFileSync(file, JSON.stringify(doc, null, 2), { mode: 0o600 });
  process.exit(0);
}
if (args[0] === "mcp" && args[1] === "remove") {
  const doc = read();
  delete servers(doc)[args[2] as string];
  writeFileSync(file, JSON.stringify(doc, null, 2), { mode: 0o600 });
  process.exit(0);
}
if (args[0] === "mcp" && args[1] === "list") {
  console.log("suite-channel: bun /x/src/index.ts - ✔ Connected\nstartup-suite: https://x/mcp (HTTP) - ✔ Connected");
  process.exit(0);
}
if (args[0] === "mcp" && args[1] === "get") {
  const e = servers(read())[args[2] as string];
  if (e === undefined) process.exit(1);
  const lines = [`${args[2]}:`, "  Scope: Local config", `  Type: ${e.type}`];
  if (e.url) lines.push(`  URL: ${e.url}`);
  if (e.command) lines.push(`  Command: ${e.command}`, `  Args: ${(e.args ?? []).join(" ")}`);
  if (e.env) lines.push("  Environment:", ...Object.entries(e.env).map(([k, v]) => `    ${k}=${v}`));
  if (e.headers) lines.push("  Headers:", ...Object.entries(e.headers).map(([k, v]) => `    ${k}: ${v}`));
  console.log(lines.join("\n"));
  process.exit(0);
}
process.exit(0);
