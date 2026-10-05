/**
 * Ref-mode Claude wiring (task 01a0d6b9 stage 1).
 *
 * When the machine connection holds a token REF, `suite claude` writes both
 * MCP entries with `claude mcp add-json -s local`, and NO argv, file or stream
 * may carry the token:
 *
 *   suite-channel   SUITE_TOKEN=<the ref> + SUITE_TOKEN_KEYCHAIN_SERVICE
 *   startup-suite   a headersHelper running `<suite> mcp-headers --token-ref ...`
 *
 * A recording stub `claude` (fixtures/stub_claude_mcp.ts) logs every argv and
 * writes ~/.claude.json the way Claude Code 2.1.289 does. The token is a
 * random canary in a 0600 file, so the ref resolves on any platform; every
 * leak scan has a planted positive control.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_CHANNEL_REF,
  addJsonArgs,
  ensureClaudeWiring,
  headersHelperCommand,
  planMcp,
  type WiringDeps,
} from "../src/claude_wiring.ts";
import type { SuiteConfig } from "../src/config.ts";
import { CHANNEL_SERVER, TOOLS_SERVER } from "../src/commands/init.ts";
import { createStore, spawnWithSecrets } from "../src/secrets.ts";
import { canary, listFiles, scanText, scanTexts, scanTree } from "./leak-scan.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const STUB = join(import.meta.dir, "fixtures", "stub_claude_mcp.ts");
const SELF = [process.execPath, CLI];

let home: string;
let agent: string;
let checkout: string;
let tokenFile: string;
let token: string;
let argvLog: string;
let env: Record<string, string>;
let lines: string[];
let gitCalls: string[][];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), `suite-refwire-01a0d6b9-${process.pid}-`)));
  agent = join(home, "agents", "quasar-01a0d6b9");
  checkout = join(home, "data", "suite", "claude-code-suite-channel");
  for (const d of [agent, join(checkout, ".git"), join(checkout, "src"), join(checkout, "node_modules"), join(home, "bin")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(checkout, "src", "index.ts"), "// fixture\n");
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "claude-code-suite-channel", suite: { tokenRefs: 1 } }));
  writeFileSync(join(home, "bin", "claude"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(STUB)} "$@"\n`);
  chmodSync(join(home, "bin", "claude"), 0o755);
  token = canary("tok");
  tokenFile = join(home, "runtime-01a0d6b9.token");
  writeFileSync(tokenFile, `${token}\n`);
  chmodSync(tokenFile, 0o600);
  argvLog = join(home, "claude-argv-01a0d6b9.log");
  env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    PATH: `${join(home, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    STUB_CLAUDE_ARGV_LOG: argvLog,
  };
  lines = [];
  gitCalls = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function config(over: Partial<SuiteConfig> = {}): SuiteConfig {
  return {
    suiteUrl: "https://suite.example.invalid",
    runtimeId: "rt-01a0d6b9",
    headerNames: [],
    sessionNaming: "cwd",
    tokenRef: `file:${tokenFile}`,
    ...over,
  };
}

/** git and bun are emulated in process; `claude` is the real stub on PATH. */
function deps(): WiringDeps {
  const store = createStore();
  return {
    env,
    cwd: agent,
    isTTY: false,
    store,
    self: SELF,
    out: (l) => void lines.push(l),
    err: (l) => void lines.push(l),
    run: async (argv, options) => {
      if (argv[0] === "git") {
        gitCalls.push(argv);
        if (argv[1] === "checkout") {
          writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "claude-code-suite-channel", suite: { tokenRefs: 1 } }));
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "bun") return { exitCode: 0, stdout: "1 package installed", stderr: "" };
      return await spawnWithSecrets(argv, store, { ...options, env });
    },
  };
}

const argvLines = (): string[][] => (existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const claudeJson = () => JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
const entries = () => claudeJson().projects[agent].mcpServers;

describe("ref-mode wiring", () => {
  test("both entries go through `claude mcp add-json -s local`, carrying the ref and a headersHelper", async () => {
    const r = await ensureClaudeWiring(deps(), config(), { checkout });
    expect(r.registered).toEqual([CHANNEL_SERVER, TOOLS_SERVER]);
    const adds = argvLines().filter((a) => a[1] === "add-json");
    expect(adds.map((a) => a.slice(0, 5))).toEqual([
      ["mcp", "add-json", "-s", "local", CHANNEL_SERVER],
      ["mcp", "add-json", "-s", "local", TOOLS_SERVER],
    ]);
    const e = entries();
    expect(e[CHANNEL_SERVER]).toEqual({
      type: "stdio",
      command: "bun",
      args: [join(checkout, "src", "index.ts")],
      env: {
        SUITE_URL: "wss://suite.example.invalid/runtime/ws",
        SUITE_RUNTIME_ID: "rt-01a0d6b9",
        SUITE_TOKEN: `file:${tokenFile}`,
        SUITE_ALLOW_PERMISSION_RELAY: "0",
      },
    });
    expect(e[TOOLS_SERVER]).toEqual({
      type: "http",
      url: "https://suite.example.invalid/mcp",
      headersHelper: headersHelperCommand(SELF, `file:${tokenFile}`, null),
    });
    expect(e[TOOLS_SERVER].headers).toBeUndefined();
    // The plugin already declared tokenRefs: no re-checkout.
    expect(gitCalls).toEqual([]);
  });

  test("a keychain ref carries SUITE_TOKEN_KEYCHAIN_SERVICE and --keychain-service in the helper", async () => {
    const c = config({ tokenRef: "keychain:RUNTIME_TOKEN.rt-01a0d6b9", keychainService: "suite-cli" });
    await ensureClaudeWiring(deps(), c, { checkout });
    const e = entries();
    expect(e[CHANNEL_SERVER].env.SUITE_TOKEN).toBe("keychain:RUNTIME_TOKEN.rt-01a0d6b9");
    expect(e[CHANNEL_SERVER].env.SUITE_TOKEN_KEYCHAIN_SERVICE).toBe("suite-cli");
    expect(e[TOOLS_SERVER].headersHelper).toEndWith("'mcp-headers' '--token-ref' 'keychain:RUNTIME_TOKEN.rt-01a0d6b9' '--keychain-service' 'suite-cli'");
  });

  test("LEAK: the token is in no argv, not in .claude.json, not in any output line", async () => {
    await ensureClaudeWiring(deps(), config(), { checkout });
    const argvText = argvLines().map((a) => a.join(" ")).join("\n");
    expect(argvLines().length).toBeGreaterThanOrEqual(3); // anti-vacuity: add, add, list were recorded
    const hits = [
      ...scanTexts({ argv: argvText, output: lines.join("\n") }, token),
      ...scanTree(home, token, { exclude: [tokenFile] }),
    ];
    expect(hits).toEqual([]);
    expect(readFileSync(join(home, ".claude.json"), "utf8")).not.toMatch(/Authorization|Bearer/i);
    // Positive controls: the argv scan and the tree scan both see a planted copy.
    expect(scanText("argv", `${argvText} ${token}`, token).length).toBeGreaterThan(0);
    writeFileSync(join(home, "planted-01a0d6b9.json"), JSON.stringify({ t: token }));
    expect(scanTree(home, token, { exclude: [tokenFile] }).map((h) => h.where)).toContain(join(home, "planted-01a0d6b9.json"));
  });

  test("a second launch on a wired folder writes nothing; a literal entry is rewritten to the ref", async () => {
    await ensureClaudeWiring(deps(), config(), { checkout });
    const before = argvLines().length;
    const again = await ensureClaudeWiring(deps(), config(), { checkout });
    expect(again.registered).toEqual([]);
    expect(argvLines().length).toBe(before);
    // Simulate a folder wired in LITERAL mode by 0.7.0: inline bearer on the tools entry.
    const doc = claudeJson();
    doc.projects[agent].mcpServers[TOOLS_SERVER] = { type: "http", url: "https://suite.example.invalid/mcp", headers: { Authorization: "Bearer old-literal" } };
    writeFileSync(join(home, ".claude.json"), JSON.stringify(doc));
    expect(planMcp({ env, cwd: agent, store: createStore(), self: SELF }, config(), checkout).tools).toBe("stale");
    const fixed = await ensureClaudeWiring(deps(), config(), { checkout });
    expect(fixed.registered).toEqual([TOOLS_SERVER]);
    expect(readFileSync(join(home, ".claude.json"), "utf8")).not.toContain("old-literal");
  });

  test("a checkout without suite.tokenRefs is moved to CLAUDE_CHANNEL_REF, and says so", async () => {
    writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "claude-code-suite-channel" }));
    await ensureClaudeWiring(deps(), config(), { checkout });
    expect(gitCalls).toEqual([
      ["git", "fetch", "--quiet", "origin", CLAUDE_CHANNEL_REF],
      ["git", "checkout", "--quiet", "--detach", CLAUDE_CHANNEL_REF],
    ]);
    expect(lines.join("\n")).toContain("no token-ref support");
    expect(CLAUDE_CHANNEL_REF).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("suite mcp-headers", () => {
  function runHelper(args: string[]) {
    // bun's transpiler cache is bun's, not this CLI's: switched off, so "writes
    // no file" can be checked over the WHOLE of HOME (~/.bun on Linux,
    // ~/Library/Caches/bun on macOS would otherwise appear).
    const p = Bun.spawnSync([process.execPath, CLI, "mcp-headers", ...args], {
      env: { ...env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  }

  const ownFiles = () => listFiles(home);

  test("prints ONLY the headers object on stdout; nothing on stderr; writes no file", () => {
    const before = ownFiles();
    const r = runHelper(["--token-ref", `file:${tokenFile}`]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`);
    expect(r.stderr).toBe("");
    expect(ownFiles()).toEqual(before);
    // And no file anywhere under HOME (bun's cache included) carries the token.
    expect(scanTree(home, token, { exclude: [tokenFile] })).toEqual([]);
  });

  test("the helper command, run through a shell as Claude Code runs it, yields the same object", () => {
    const helper = headersHelperCommand(SELF, `file:${tokenFile}`, null);
    const p = Bun.spawnSync(["/bin/sh", "-c", helper], { env, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    expect(JSON.parse(p.stdout.toString())).toEqual({ Authorization: `Bearer ${token}` });
  });

  test("an unresolvable ref fails with one line naming the ref, never a value", () => {
    chmodSync(tokenFile, 0o644);
    const r = runHelper(["--token-ref", `file:${tokenFile}`]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(tokenFile);
    expect(r.stderr).toContain("0644");
    expect(scanTexts({ out: r.stdout, err: r.stderr }, token)).toEqual([]);
  });

  test("operator headers saved beside the config ride along; with no flag it uses the machine ref", () => {
    mkdirSync(join(home, "config", "suite"), { recursive: true });
    writeFileSync(join(home, "config", "suite", "config.json"), JSON.stringify({ ...config(), headerNames: ["X-Gate"] }));
    const gate = canary("gate");
    writeFileSync(join(home, "config", "suite", "credentials.json"), JSON.stringify({ token: "", headers: { "X-Gate": gate } }), { mode: 0o600 });
    const r = runHelper([]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ "X-Gate": gate, Authorization: `Bearer ${token}` });
  });
});

describe("argv shape", () => {
  test("addJsonArgs is names, a scope and a JSON document; nothing else", () => {
    expect(addJsonArgs("startup-suite", "{}")).toEqual(["claude", "mcp", "add-json", "-s", "local", "startup-suite", "{}"]);
  });
});
