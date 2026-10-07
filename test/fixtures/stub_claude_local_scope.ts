#!/usr/bin/env bun
/**
 * A `claude` stub whose `mcp add -s local` REALLY WRITES `~/.claude.json`.
 *
 * The plain shell stub (test/clean-env DEFAULT_STUBS.claude) logs `mcp add` and
 * writes nothing, so a test built on it can count adds but can never see the
 * NEXT launch read back what the last one wrote. Alternating launches across
 * two folders — what `suite restore` does at boot — is exactly the case where
 * that read-back matters. This stub closes the loop, at local scope only:
 *
 *   claude mcp add NAME -s local [-e K=V ...] -- CMD ARGS...        stdio entry
 *   claude mcp add NAME -s local (-t|--transport) http URL [-H "K: V" ...]
 *   claude mcp remove NAME -s local
 *   claude mcp list                                                 every entry, "✔ Connected"
 *
 * Entries land in `projects[<cwd>].mcpServers` of `$CLAUDE_CONFIG_DIR/.claude.json`
 * (else `$HOME/.claude.json`), mode 0600 — the shape Claude Code 2.1.281
 * writes (measured; see MCP_SCOPE in src/commands/init.ts). An add for a name
 * already present fails with "already exists", exit 1, as the real CLI does.
 * Every invocation's argv is appended, tab-separated, to $STUB_LOG.
 *
 * Named apart from the 01a0d6b9 branch's test/fixtures/stub_claude_mcp.ts so
 * the two never collide as add/add.
 */
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Entry = Record<string, unknown>;
interface ClaudeJson {
  projects?: Record<string, { mcpServers?: Record<string, Entry> }>;
  [k: string]: unknown;
}

const argv = process.argv.slice(2);
if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, `${["claude", ...argv].join("\t")}\n`);

const home = process.env.HOME ?? "";
const dir = process.env.CLAUDE_CONFIG_DIR;
const file = dir !== undefined && dir !== "" ? resolve(dir, ".claude.json") : resolve(home, ".claude.json");
const cwd = process.cwd();

function load(): ClaudeJson {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as ClaudeJson;
}

function save(data: ClaudeJson): void {
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

function servers(data: ClaudeJson): Record<string, Entry> {
  data.projects ??= {};
  data.projects[cwd] ??= {};
  const project = data.projects[cwd] as { mcpServers?: Record<string, Entry> };
  project.mcpServers ??= {};
  return project.mcpServers;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (argv[0] !== "mcp") process.exit(0);

if (argv[1] === "list") {
  const data = load();
  for (const name of Object.keys(data.projects?.[cwd]?.mcpServers ?? {})) {
    process.stdout.write(`${name}: stub - ✔ Connected\n`);
  }
  process.exit(0);
}

if (argv[1] === "remove") {
  const name = argv[2] ?? fail("remove: no name");
  const data = load();
  const map = servers(data);
  if (!(name in map)) fail(`No MCP server found with name: ${name}`);
  delete map[name];
  save(data);
  process.exit(0);
}

if (argv[1] === "add") {
  const rest = argv.slice(2);
  const name = rest.shift() ?? fail("add: no name");
  let scope = "local";
  let transport: string | null = null;
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const positional: string[] = [];
  let command: string[] | null = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--") {
      command = rest.slice(i + 1);
      break;
    }
    const next = rest[i + 1];
    if ((a === "-s" || a === "--scope") && next !== undefined) {
      scope = next;
      i++;
    } else if ((a === "-t" || a === "--transport") && next !== undefined) {
      transport = next;
      i++;
    } else if ((a === "-e" || a === "--env") && next !== undefined) {
      const eq = next.indexOf("=");
      env[next.slice(0, eq)] = next.slice(eq + 1);
      i++;
    } else if ((a === "-H" || a === "--header") && next !== undefined) {
      const colon = next.indexOf(":");
      headers[next.slice(0, colon).trim()] = next.slice(colon + 1).trim();
      i++;
    } else {
      positional.push(a);
    }
  }
  if (scope !== "local") fail(`stub_claude_local_scope: only -s local is modelled, got ${scope}`);
  const data = load();
  const map = servers(data);
  if (name in map) fail(`MCP server ${name} already exists in local config`);
  if (transport === "http") {
    map[name] = { type: "http", url: positional[0] ?? "", headers };
  } else {
    const [cmd, ...args] = command ?? positional;
    map[name] = { type: "stdio", command: cmd ?? "", args, env };
  }
  save(data);
  process.stdout.write(`Added ${transport === "http" ? "HTTP" : "stdio"} MCP server ${name} to local config\n`);
  process.exit(0);
}

process.exit(0);
