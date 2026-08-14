import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  CLAUDE_VERSION_FLOOR,
  OVERRIDE_ENV_VARS,
  apiKeyOverride,
  authSupported,
  compareVersions,
  describeAuth,
  exitCodeFor,
  liveDoctorDeps,
  mcpEntryHasToken,
  meetsFloor,
  parseAuthStatus,
  parseClaudeVersion,
  parseMcpEntryPath,
  parseMcpHeaderValue,
  parseMcpHttpUrl,
  bearerOf,
  classifyProbe,
  suiteHostOf,
  parseMcpHeaders,
  toolCount,
  tokenFingerprint,
  renderCheck,
  renderReport,
  runChecks,
  runDoctor,
  summaryLine,
  type CheckId,
  type CheckResult,
  type DoctorDeps,
  type ProbeRequest,
  type ProbeResult,
} from "../src/commands/doctor.ts";
import { CHANNEL_SERVER, TOOLS_SERVER } from "../src/commands/init.ts";
import { emptyConfig, type SuiteConfig } from "../src/config.ts";
import { killSessionArgv, liveTmuxDeps, newSessionArgv, sessionNameFor } from "../src/tmux.ts";
import { cleanupCleanEnvs, createCleanEnv } from "./clean-env/fixture.ts";

/**
 * EVERY VALUE HERE IS INVENTED. This repository is public, and a fixture is the
 * easiest place in a codebase for a real credential, hostname, email or org id
 * to end up looking like scaffolding. In particular NOTHING below is copied
 * from this machine's `claude auth status` output or its MCP configuration:
 * the auth payloads carry no email and no org id at all, because the parser
 * deliberately never reads one.
 */
const SUITE_URL = "https://suite.example.invalid";
const RUNTIME_ID = "runtime_00000000-0000-0000-0000-000000000000";
const HEALTHY_VERSION = "2.1.228 (Claude Code)";
const OLD_VERSION = "2.1.79 (Claude Code)";
const HEALTHY_AUTH = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
});
const APIKEY_AUTH = JSON.stringify({
  loggedIn: true,
  authMethod: "apiKey",
  apiProvider: "anthropic",
});

function config(): SuiteConfig {
  return { ...emptyConfig(), suiteUrl: SUITE_URL, runtimeId: RUNTIME_ID };
}

/* ------------------------------------------------------------------------- */
/* A fixture whose every input is broken on purpose                           */
/* ------------------------------------------------------------------------- */

/**
 * ON THIS BOX every check passes. Running doctor here would therefore assert
 * only that a doctor CAN print green — which is exactly what a doctor that is
 * always green also does. So each test below drives a deliberately broken
 * input through injected dependencies and asserts THAT check fires, and the
 * whole set is anchored by one all-healthy run asserting green, so the failing
 * assertions are not vacuously true of a doctor that always fails.
 */
interface FakeOptions {
  tools?: string[];
  version?: string;
  auth?: string;
  /** What `claude mcp get suite-channel` prints. */
  mcpGet?: string;
  mcpGetExit?: number;
  /** What `claude mcp get <the tools server>` prints. */
  toolsGet?: string;
  toolsGetExit?: number;
  /** What the authenticated tools probe answers, or a throw for unreachable. */
  probe?: (request: ProbeRequest) => Promise<ProbeResult>;
  /** What `claude mcp list` prints. */
  mcpList?: string;
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  sessionState?: "live" | "stale" | "none";
  config?: SuiteConfig | null;
  color?: boolean;
  utf8?: boolean;
}

const PLUGIN_PATH = "/opt/example/claude-code-suite-channel/src/index.ts";

function mcpGetOutput(path = PLUGIN_PATH, token = "tok_fixture_0000"): string {
  return [
    `${CHANNEL_SERVER}:`,
    "  Scope: User config",
    "  Type: stdio",
    `  Command: bun`,
    `  Args: ${path}`,
    "  Environment:",
    `    SUITE_URL=wss://suite.example.invalid/runtime/ws`,
    `    SUITE_RUNTIME_ID=${RUNTIME_ID}`,
    `    SUITE_TOKEN=${token}`,
    "",
  ].join("\n");
}

/**
 * The OTHER entry, and a different shape entirely: the tools server is an HTTP
 * entry with a URL and headers, not a stdio entry with a command and an env.
 * The fake used to answer one output for every `mcp get`, which made it
 * impossible for a test to distinguish reading the right entry from reading the
 * wrong one.
 */
const TOOLS_TOKEN = "tok_fixture_alpha";

function toolsGetOutput(url = `${SUITE_URL}/mcp`, token = TOOLS_TOKEN): string {
  return [
    `${TOOLS_SERVER}:`,
    "  Scope: User config",
    "  Type: http",
    `  URL: ${url}`,
    "  Headers:",
    `    Authorization: Bearer ${token}`,
    "    X-Fixture-Gateway-Id: gateway-fixture-1",
    "",
  ].join("\n");
}

/** A healthy `tools/list` reply — three invented tool names. */
function toolsListBody(names = ["suite_reply", "task_get", "memory_view"]): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: names.map((name) => ({ name })) } });
}

const REJECTED_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  error: { code: -32000, message: "unauthorized" },
});

function mcpListOutput(channel = "✔ Connected"): string {
  return [
    `${CHANNEL_SERVER}: bun ${PLUGIN_PATH} - ${channel}`,
    `${TOOLS_SERVER}: ${SUITE_URL}/mcp (HTTP) - ✔ Connected`,
    "",
  ].join("\n");
}

function fakeDeps(options: FakeOptions = {}): DoctorDeps & { lines: string[]; argvs: string[][] } {
  const tools = options.tools ?? ["claude", "bun", "tmux"];
  const lines: string[] = [];
  /** Every argv the fake `run` saw — the material of the ps-leak guard. */
  const argvs: string[][] = [];
  const sessionState = options.sessionState ?? "none";
  const has = (name: string) => tools.includes(name);

  const run = async (argv: string[]) => {
    argvs.push([...argv]);
    const [bin, ...args] = argv;
    const name = (bin ?? "").split("/").pop() ?? "";
    const ok = { exitCode: 0, stdout: "", stderr: "" };
    if (name === "claude") {
      if (args[0] === "--version") return { ...ok, stdout: `${options.version ?? HEALTHY_VERSION}\n` };
      if (args[0] === "auth") return { ...ok, stdout: `${options.auth ?? HEALTHY_AUTH}\n` };
      if (args[0] === "mcp" && args[1] === "get") {
        // NAME-AWARE: the two entries have different shapes and different
        // failure modes, so one fixture output for both would let a check that
        // read the wrong entry pass.
        if (args[2] === TOOLS_SERVER) {
          return {
            exitCode: options.toolsGetExit ?? 0,
            stdout: options.toolsGet ?? toolsGetOutput(),
            stderr: "",
          };
        }
        return {
          exitCode: options.mcpGetExit ?? 0,
          stdout: options.mcpGet ?? mcpGetOutput(),
          stderr: "",
        };
      }
      if (args[0] === "mcp" && args[1] === "list") {
        return { ...ok, stdout: options.mcpList ?? mcpListOutput() };
      }
    }
    if (name === "bun" && args[0] === "--version") return { ...ok, stdout: "1.2.4\n" };
    if (name === "tmux" && args[0] === "-V") return { ...ok, stdout: "tmux 3.5a\n" };
    // Stage 4's detector: a pane listing, then a process snapshot.
    if (name === "tmux" && args[0] === "list-panes") {
      if (sessionState === "none") return ok;
      return { ...ok, stdout: `${SESSION_NAME}\t4242\t-sh\n` };
    }
    if (name === "ps") {
      if (sessionState === "live") return { ...ok, stdout: "  4243  4242 claude claude\n" };
      return { ...ok, stdout: "  4242     1 sh -sh\n" };
    }
    return ok;
  };

  return {
    env: options.env ?? {},
    cwd: SESSION_CWD,
    run,
    which: (name) => (has(name) ? `/fixture/bin/${name}` : null),
    exists: options.exists ?? (() => true),
    config: options.config === undefined ? config() : options.config,
    configFile: "/fixture/home/.config/suite/config.json",
    tmux: { env: {}, which: (name) => (has(name) ? `/fixture/bin/${name}` : null), run },
    probe:
      options.probe ??
      (async () => ({ status: 200, body: toolsListBody(), contentType: "application/json" })),
    color: options.color ?? false,
    utf8: options.utf8 ?? true,
    lines,
    argvs,
    out: (line) => void lines.push(line),
  };
}

const SESSION_CWD = "/projects/example-ledger";
const SESSION_NAME = sessionNameFor({ naming: "cwd", cwd: SESSION_CWD });

function byId(checks: CheckResult[], id: CheckId): CheckResult {
  const found = checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no check with id ${id}`);
  return found;
}

async function report(options: FakeOptions = {}): Promise<{ text: string; code: number; checks: CheckResult[] }> {
  const deps = fakeDeps(options);
  const checks = await runChecks(deps);
  const code = await runDoctor(deps);
  return { text: deps.lines.join("\n"), code, checks };
}

/* ------------------------------------------------------------------------- */
/* The green anchor — without it every failing assertion below is vacuous     */
/* ------------------------------------------------------------------------- */

describe("an all-healthy machine", () => {
  test("passes all nine checks and exits 0", async () => {
    const { text, code, checks } = await report();
    expect(checks).toHaveLength(9);
    expect(checks.filter((c) => c.status === "pass")).toHaveLength(9);
    expect(code).toBe(0);
    expect(text).toContain("9 checks passed.");
    expect(text).not.toContain("✘");
    expect(text).not.toContain("⋯");
  });

  test("the nine checks are listed in dependency order", async () => {
    const { checks } = await report();
    expect(checks.map((c) => c.id)).toEqual([
      "claude",
      "auth",
      "bun",
      "tmux",
      "plugin",
      "credentials",
      "channel",
      "tools",
      "session",
    ]);
  });
});

/* ------------------------------------------------------------------------- */
/* One deliberately broken input per check                                    */
/* ------------------------------------------------------------------------- */

describe("each check fires on a broken input", () => {
  test("1. a claude below the version floor", async () => {
    const { text, code, checks } = await report({ version: OLD_VERSION });
    const check = byId(checks, "claude");
    expect(check.status).toBe("fail");
    expect(code).toBe(1);
    expect(text).toContain(`needs ≥ ${CLAUDE_VERSION_FLOOR}`);
    expect(text).toContain("→ claude update");
  });

  test("2. auth by API key, which is the silent one", async () => {
    const { text, code, checks } = await report({ auth: APIKEY_AUTH });
    expect(byId(checks, "auth").status).toBe("fail");
    expect(code).toBe(1);
    expect(text).toContain("API key");
    // The consequence, not the error text: connects, then delivers nothing.
    expect(text).toContain("delivers nothing");
    expect(text).toContain("→ claude /login");
  });

  test("2b. a HEALTHY login is still a failure when ANTHROPIC_API_KEY is set", async () => {
    for (const name of OVERRIDE_ENV_VARS) {
      const { text, code, checks } = await report({
        auth: HEALTHY_AUTH,
        env: { [name]: "sk-fixture-0000" },
      });
      const check = byId(checks, "auth");
      expect(check.status).toBe("fail");
      expect(code).toBe(1);
      expect(text).toContain(`${name} is set`);
      expect(text).toContain(`→ unset ${name}`);
      // Anti-vacuity for THIS assertion: the same stored login with the
      // variable absent is green, so the failure is the variable's doing.
      const clean = await report({ auth: HEALTHY_AUTH });
      expect(byId(clean.checks, "auth").status).toBe("pass");
    }
  });

  test("3. bun absent from a scrubbed PATH", async () => {
    const { text, code, checks } = await report({ tools: ["claude", "tmux"] });
    expect(byId(checks, "bun").status).toBe("fail");
    expect(code).toBe(1);
    expect(text).toContain("bun");
    expect(text).toContain("offline");
    expect(text).toContain("→ curl -fsSL https://bun.sh/install | bash");
  });

  test("4. tmux absent", async () => {
    const { text, code, checks } = await report({ tools: ["claude", "bun"] });
    expect(byId(checks, "tmux").status).toBe("fail");
    expect(code).toBe(1);
    expect(text).toContain("die with the terminal");
    expect(text).toContain("→ brew install tmux");
    // And the session check could not run, so it is skipped rather than red.
    expect(byId(checks, "session").status).toBe("skip");
  });

  test("5. an MCP entry pointing at a moved checkout", async () => {
    const moved = "/opt/example/old-name/src/index.ts";
    const { text, code, checks } = await report({
      mcpGet: mcpGetOutput(moved),
      exists: (p) => p !== moved,
    });
    const check = byId(checks, "plugin");
    expect(check.status).toBe("fail");
    expect(code).toBe(1);
    expect(text).toContain("path does not resolve");
    expect(text).toContain(moved);
    // The canvas's `suite init --repair` is NOT shipped: rule (b) requires a
    // runnable command, and that flag does not exist.
    expect(text).not.toContain("--repair");
    expect(text).toContain("→ suite init");
  });

  test("5b. an unreadable MCP entry is a loud failure printing the raw line", async () => {
    const weird = `${CHANNEL_SERVER}:\n  Launcher: <opaque handle 91>\n`;
    const { text, checks } = await report({ mcpGet: weird });
    expect(byId(checks, "plugin").status).toBe("fail");
    expect(text).toContain("entry unreadable");
    expect(text).toContain("Launcher: <opaque handle 91>");
  });

  test("6. no token in the entry", async () => {
    const { text, code, checks } = await report({ mcpGet: mcpGetOutput(PLUGIN_PATH, "") });
    expect(byId(checks, "credentials").status).toBe("fail");
    expect(code).toBe(1);
    expect(text).toContain("no token in the entry");
    expect(text).toContain("→ suite init");
  });

  test("6b. a present token is confirmed without any part of its value", async () => {
    const secret = "tok_fixture_do_not_print_me_zzq7";
    const { text, checks } = await report({ mcpGet: mcpGetOutput(PLUGIN_PATH, secret) });
    expect(byId(checks, "credentials").status).toBe("pass");
    expect(text).toContain("set");
    expect(text).not.toContain(secret);
    for (let n = 4; n <= secret.length; n++) expect(text).not.toContain(secret.slice(0, n));
    expect(text).not.toContain(secret.slice(-4));
  });

  test("7. the channel reports not connected", async () => {
    const { text, code, checks } = await report({ mcpList: mcpListOutput("✘ Failed to connect") });
    expect(byId(checks, "channel").status).toBe("fail");
    expect(code).toBe(1);
    expect(text).toContain("not connected");
    expect(text).toContain("keeps waiting");
    expect(text).toContain("→ claude mcp list");
  });

  test("7b. `⏸ Pending approval` is NOT read as connected", async () => {
    // The established trap: a parser looking only for `✘` calls this green.
    const { code, checks } = await report({ mcpList: mcpListOutput("⏸ Pending approval") });
    expect(byId(checks, "channel").status).toBe("fail");
    expect(code).toBe(1);
  });

  test("7c. a status we cannot read at all is a failure, never a pass", async () => {
    const { text, checks } = await report({ mcpList: `${CHANNEL_SERVER}: ◆ quiescent\n` });
    expect(byId(checks, "channel").status).toBe("fail");
    expect(text).toContain("status unreadable");
    expect(text).toContain("◆ quiescent");
  });

  test("8. a STALE session is ✘ with a consequence, never ⋯ and never green", async () => {
    const { text, code, checks } = await report({ sessionState: "stale" });
    const check = byId(checks, "session");
    expect(check.status).toBe("fail");
    expect(code).toBe(1);
    expect(text).toContain("stale");
    expect(text).toContain("Claude inside it is not");
    expect(text).toContain("→ suite claude");
    // A live agent in the same shape of session is green, so "stale" is what
    // is being detected — not merely "a session exists".
    const live = await report({ sessionState: "live" });
    expect(byId(live.checks, "session").status).toBe("pass");
  });
});

/* ------------------------------------------------------------------------- */
/* The skipped tier: rule (c)                                                 */
/* ------------------------------------------------------------------------- */

describe("a broken upstream check skips its dependants rather than reddening them", () => {
  test("an unresolvable plugin path leaves credentials and channel skipped", async () => {
    const { text, checks } = await report({ exists: () => false });
    expect(byId(checks, "plugin").status).toBe("fail");
    expect(byId(checks, "credentials").status).toBe("skip");
    expect(byId(checks, "channel").status).toBe("skip");
    expect(text).toContain("skipped — needs a working plugin path");
    // Exactly one failure, not a wall of red pointing at one real cause.
    expect(checks.filter((c) => c.status === "fail")).toHaveLength(1);
    expect(text).toContain("1 of 9 failed.");
  });

  test("no claude at all skips everything that needs it, and still exits 1", async () => {
    const { text, code, checks } = await report({ tools: ["bun", "tmux"] });
    expect(byId(checks, "claude").status).toBe("fail");
    expect(
      ["auth", "plugin", "credentials", "channel", "tools"].map((id) => byId(checks, id as CheckId).status),
    ).toEqual(["skip", "skip", "skip", "skip", "skip"]);
    expect(code).toBe(1);
    expect(text).toContain("1 of 9 failed.");
  });
});

/* ------------------------------------------------------------------------- */
/* The four design rules, asserted as rules                                   */
/* ------------------------------------------------------------------------- */

describe("the report obeys the design rules", () => {
  test("(a) failures keep their position — nothing is sorted to the top", async () => {
    const { checks } = await report({ auth: APIKEY_AUTH, exists: () => false });
    const ids = checks.map((c) => c.id);
    expect(ids.indexOf("auth")).toBeLessThan(ids.indexOf("bun"));
    expect(ids.indexOf("bun")).toBeLessThan(ids.indexOf("plugin"));
    expect(ids[0]).toBe("claude");
  });

  test("(b) every failure carries a consequence and exactly one runnable →", async () => {
    // Sweep every failing configuration this suite knows how to produce.
    const configs: FakeOptions[] = [
      { version: OLD_VERSION },
      { version: "no version here" },
      { auth: APIKEY_AUTH },
      { auth: "{ not json" },
      { auth: JSON.stringify({ loggedIn: false }) },
      { env: { ANTHROPIC_API_KEY: "sk-fixture-0000" } },
      { tools: ["bun", "tmux"] },
      { tools: ["claude", "tmux"] },
      { tools: ["claude", "bun"] },
      { exists: () => false },
      { mcpGetExit: 1, mcpGet: "" },
      { mcpGet: mcpGetOutput(PLUGIN_PATH, "") },
      { mcpList: mcpListOutput("✘ Failed to connect") },
      { mcpList: "" },
      { sessionState: "stale" },
      { toolsGetExit: 1, toolsGet: "" },
      { toolsGet: "Type: http\nno url here\n" },
      { probe: async () => ({ status: 401, body: REJECTED_BODY, contentType: "application/json" }) },
      { probe: async () => ({ status: 200, body: "<html></html>", contentType: "text/html" }) },
      { probe: async () => ({ status: 200, body: "{}", contentType: "application/json" }) },
      {
        probe: async () => {
          throw new Error("fixture: unreachable");
        },
      },
    ];
    let failures = 0;
    for (const options of configs) {
      const { text, checks } = await report(options);
      for (const check of checks) {
        if (check.status !== "fail") continue;
        failures++;
        expect(check.consequence.length).toBeGreaterThan(0);
        expect(check.consequence.length).toBeLessThanOrEqual(2);
        expect(check.remedy.trim()).not.toBe("");
        // Rule (b) is about ONE arrow per failure, and it must be a command a
        // reader can actually run — not a sentence, not an unimplemented flag.
        expect(text).toContain(`→ ${check.remedy}`);
        expect(check.remedy).not.toContain("--repair");
      }
      const arrows = text.split("\n").filter((l) => l.includes("→"));
      expect(arrows).toHaveLength(checks.filter((c) => c.status === "fail").length);
    }
    // Anti-vacuity: the sweep really did produce failures to check.
    expect(failures).toBeGreaterThanOrEqual(configs.length);
  });

  test("(c) a skipped check is neither green nor red, and names its reason", () => {
    const lines = renderCheck(
      { id: "channel", label: "channel", status: "skip", reason: "needs credentials" },
      { color: true, utf8: true },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("⋯");
    expect(lines[0]).toContain("skipped — needs credentials");
    expect(lines[0]).not.toContain("[31m");
    expect(lines[0]).not.toContain("[32m");
  });

  test("(d) the closing line is a count and an instruction, not a paragraph", async () => {
    const { text } = await report({ auth: APIKEY_AUTH, exists: () => false });
    const last = text.trimEnd().split("\n").pop() ?? "";
    expect(last).toContain("2 of 9 failed.");
    expect(last).toContain("Fix the first one, run suite doctor again.");
    expect(last.split(".").filter((s) => s.trim() !== "")).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------------- */
/* Colour, glyphs and the pipe                                                */
/* ------------------------------------------------------------------------- */

describe("colour and glyphs", () => {
  test("colour is never the sole carrier of meaning: every state has a glyph", async () => {
    const { text } = await report({ exists: () => false, utf8: true });
    expect(text).toContain("✘");
    expect(text).toContain("⋯");
    expect(text).toContain("✔");
  });

  test("glyphs degrade to ASCII at the same column width", async () => {
    const wide = await report({ exists: () => false, utf8: true });
    const ascii = await report({ exists: () => false, utf8: false });
    expect(ascii.text).not.toContain("✘");
    expect(ascii.text).toContain("X ");
    expect(ascii.text).toContain("ok");
    // The arrow and the em dash are not ASCII either, and degrade with them.
    expect(ascii.text).not.toContain("→");
    expect(ascii.text).toContain("-> suite init");
    expect(ascii.text).toContain("skipped -- needs a working plugin path");
    const column = (text: string) =>
      text
        .split("\n")
        .filter((l) => l.includes("claude code"))
        .map((l) => l.indexOf("claude code"));
    expect(column(ascii.text)).toEqual(column(wide.text));
  });

  test("status colour uses the terminal's semantic slots, never brand hex", async () => {
    const deps = fakeDeps({ exists: () => false, color: true });
    await runDoctor(deps);
    const text = deps.lines.join("\n");
    expect(text).toContain("[31m"); // red
    expect(text).toContain("[32m"); // green
    expect(text).toContain("[2m"); // faint, for the consequence lines
    expect(text).not.toContain("06D5ED");
    expect(text).not.toContain("38;2;"); // no truecolor status
  });

  test("no emoji anywhere in the report", async () => {
    const { text } = await report({ exists: () => false });
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2705}\u{274C}]/u);
  });
});

/* ------------------------------------------------------------------------- */
/* End to end through the real binary, off a TTY                              */
/* ------------------------------------------------------------------------- */

/**
 * The SAME clean-environment fixture the init suite uses
 * (`test/clean-env/fixture.ts`): scratch HOME/XDG dirs and a PATH of stubs
 * only. `doctor` must report a machine where the plugin is NOT installed, and
 * on this box it is — so a run against the real environment would exercise
 * none of the failure rendering this stage exists for.
 */
afterEach(cleanupCleanEnvs);

describe("piped to a file", () => {
  test("`suite doctor > report.txt` contains zero escape bytes", async () => {
    // A whole-binary run: stdout is a pipe, which is what makes the assertion
    // about the SHIPPED entry point rather than about a hand-built option map.
    const fx = createCleanEnv({
      label: "doctor",
      bodies: { claude: `if [ "$1" = "--version" ]; then echo "${OLD_VERSION}"; exit 0; fi\nexit 1` },
      env: { LANG: "en_US.UTF-8" },
    });
    // The CLI's own PATH stays scrubbed to the stubs; the interpreter is named
    // by absolute path so finding it is not itself a PATH lookup.
    const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, "..", "src", "cli.ts"), "doctor"], {
      env: fx.env as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(1);
    expect(text).toContain("failed.");
    // The claim: not one SGR byte reached the file.
    expect(text.includes("")).toBe(false);
    expect(text).not.toMatch(/\[\d+m/);
  });
});

/* ------------------------------------------------------------------------- */
/* Pure parsers                                                               */
/* ------------------------------------------------------------------------- */

describe("parsers", () => {
  test("the leading semver is taken and the suffix tolerated", () => {
    expect(parseClaudeVersion("2.1.228 (Claude Code)")).toBe("2.1.228");
    expect(parseClaudeVersion("  2.1.80\n")).toBe("2.1.80");
    expect(parseClaudeVersion("claude: command not found")).toBeNull();
  });

  test("version comparison is numeric, not lexical", () => {
    // The whole point: "2.1.228" < "2.1.80" as strings, and must not be here.
    expect(compareVersions("2.1.228", "2.1.80")).toBe(1);
    expect(meetsFloor("2.1.228")).toBe(true);
    expect(meetsFloor("2.1.80")).toBe(true);
    expect(meetsFloor("2.1.79")).toBe(false);
    expect(meetsFloor("3.0.0")).toBe(true);
    expect(meetsFloor("1.9.999")).toBe(false);
  });

  test("auth parsing reads the verdict fields and nothing identifying", () => {
    const status = parseAuthStatus(HEALTHY_AUTH);
    expect(status).toEqual({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" });
    expect(authSupported(status!)).toBe(true);
    expect(Object.keys(status!)).not.toContain("email");
    expect(Object.keys(status!)).not.toContain("orgId");
    expect(authSupported(parseAuthStatus(APIKEY_AUTH)!)).toBe(false);
    expect(describeAuth(parseAuthStatus(APIKEY_AUTH)!)).toBe("API key");
    expect(parseAuthStatus("not json at all")).toBeNull();
  });

  test("an env override is detected independently of the stored login", () => {
    expect(apiKeyOverride({})).toBeNull();
    expect(apiKeyOverride({ ANTHROPIC_API_KEY: "" })).toBeNull();
    expect(apiKeyOverride({ ANTHROPIC_API_KEY: "sk-fixture" })).toBe("ANTHROPIC_API_KEY");
    expect(apiKeyOverride({ ANTHROPIC_AUTH_TOKEN: "fixture" })).toBe("ANTHROPIC_AUTH_TOKEN");
  });

  test("the MCP entry path is read from the command, not from an env URL", () => {
    expect(parseMcpEntryPath(mcpGetOutput())).toBe(PLUGIN_PATH);
    expect(parseMcpEntryPath("  Environment:\n    SUITE_URL=file:///not/the/entrypoint\n")).toBeNull();
    expect(parseMcpEntryPath("nothing readable here")).toBeNull();
  });

  test("token presence is a boolean and the value never leaves the parser", () => {
    expect(mcpEntryHasToken(mcpGetOutput(PLUGIN_PATH, "tok_fixture"))).toBe(true);
    expect(mcpEntryHasToken(mcpGetOutput(PLUGIN_PATH, ""))).toBe(false);
    expect(mcpEntryHasToken("no token line here")).toBe(false);
    expect(typeof mcpEntryHasToken(mcpGetOutput())).toBe("boolean");
  });

  test("the http entry's URL is read from a URL line, never from a command line", () => {
    const entry = [
      "startup-suite:",
      "  Type: http",
      "  URL: https://example-suite.invalid/mcp",
      "  Headers:",
      "    Authorization: Bearer tok_fixture_alpha",
    ].join("\n");
    expect(parseMcpHttpUrl(entry)).toBe("https://example-suite.invalid/mcp");
    // A stdio entry has no URL, and its Command line must not be mined for one.
    expect(parseMcpHttpUrl("  Command: /opt/example/bin/bun\n  Args: /opt/example/src/index.ts")).toBeNull();
    expect(parseMcpHttpUrl("Endpoint = http://example-suite.invalid:4000/mcp")).toBe(
      "http://example-suite.invalid:4000/mcp",
    );
    // Never guessed: a relative or schemeless value is null, i.e. a failure.
    expect(parseMcpHttpUrl("  URL: /mcp")).toBeNull();
    expect(parseMcpHttpUrl("nothing readable here")).toBeNull();
  });

  test("one header's value is lifted, case-insensitively, and Bearer stripped", () => {
    const entry = [
      "  Type: http",
      "  URL: https://example-suite.invalid/mcp",
      "  Headers:",
      "    Authorization: Bearer tok_fixture_alpha",
      "    X-Fixture-Trace: trace-fixture-1",
    ].join("\n");
    expect(parseMcpHeaderValue(entry, "authorization")).toBe("Bearer tok_fixture_alpha");
    expect(parseMcpHeaderValue(entry, "X-Fixture-Trace")).toBe("trace-fixture-1");
    expect(parseMcpHeaderValue(entry, "X-Absent")).toBeNull();
    expect(parseMcpHeaderValue("  Authorization:   \n", "Authorization")).toBeNull();
    expect(parseMcpHeaderValue(`-H 'Authorization: Bearer tok_fixture_beta'`, "Authorization")).toBe(
      "Bearer tok_fixture_beta",
    );

    expect(bearerOf("Bearer tok_fixture_alpha")).toBe("tok_fixture_alpha");
    expect(bearerOf("bearer tok_fixture_alpha")).toBe("tok_fixture_alpha");
    expect(bearerOf("tok_fixture_alpha")).toBeNull();
    expect(bearerOf("Bearer   ")).toBeNull();
  });

  test("the fingerprint compares secrets without carrying any of one", () => {
    const alpha = "tok_fixture_alpha";
    const beta = "tok_fixture_beta";

    expect(tokenFingerprint(alpha)).toBe(tokenFingerprint(alpha));
    expect(tokenFingerprint(alpha)).not.toBe(tokenFingerprint(beta));
    expect(tokenFingerprint(alpha)).toHaveLength(8);
    expect(tokenFingerprint(alpha)).toMatch(/^[0-9a-f]{8}$/);

    // ANTI-LEAK: no 4-character run of the input survives into the output, so a
    // future "just truncate the token" regression fails here instead of
    // shipping a printed prefix of a live credential.
    const fp = tokenFingerprint(alpha);
    for (let i = 0; i + 4 <= alpha.length; i++) {
      expect(fp.includes(alpha.slice(i, i + 4))).toBe(false);
    }
  });

  test("the websocket entry and the https entry resolve to the same host", () => {
    expect(suiteHostOf("wss://example-suite.invalid/socket")).toBe("example-suite.invalid");
    expect(suiteHostOf("https://example-suite.invalid/mcp")).toBe("example-suite.invalid");
    expect(suiteHostOf("wss://example-suite.invalid/socket")).toBe(
      suiteHostOf("https://example-suite.invalid/mcp"),
    );
    expect(suiteHostOf("HTTPS://EXAMPLE-SUITE.INVALID/mcp")).toBe("example-suite.invalid");
    // `URL` semantics for the port, and nothing beyond them.
    expect(suiteHostOf("http://example-suite.invalid:4000/mcp")).toBe("example-suite.invalid:4000");
    expect(suiteHostOf("not a url")).toBeNull();
    expect(suiteHostOf("")).toBeNull();
  });

  test("a 401 from the application and a 401 from the gateway are different verdicts", () => {
    // THE SAME-STATUS PAIR. A classifier tested only on distinct status codes
    // proves nothing about the distinction this tool exists for.
    const rpcError = {
      status: 401,
      body: JSON.stringify({ code: -32000, message: "unauthorized" }),
      contentType: "application/json",
    };
    const htmlChallenge = {
      status: 401,
      body: "<!DOCTYPE html><html><body>sign in</body></html>",
      contentType: "text/html; charset=utf-8",
    };
    expect(classifyProbe(rpcError)).toBe("rejected");
    expect(classifyProbe(htmlChallenge)).toBe("gateway-challenge");
    expect(classifyProbe(rpcError)).not.toBe(classifyProbe(htmlChallenge));
  });

  test("each probe verdict has a case, including an HTML 200 and a toolless 200", () => {
    expect(
      classifyProbe({
        status: 200,
        body: JSON.stringify({ result: { tools: [{ name: "task_get" }] } }),
        contentType: "application/json",
      }),
    ).toBe("ok");

    // An access proxy answers a credential-less request with a login PAGE, and
    // it may do so with a 200. HTML is the signal, not the status.
    expect(
      classifyProbe({ status: 200, body: "<html><body>sign in</body></html>", contentType: "" }),
    ).toBe("gateway-challenge");

    // A 200 with no tools is the incident's invisible symptom: healthy-looking
    // and exposing nothing. It is NOT ok.
    expect(
      classifyProbe({
        status: 200,
        body: JSON.stringify({ result: { tools: [] } }),
        contentType: "application/json",
      }),
    ).toBe("unreadable");
    expect(classifyProbe({ status: 200, body: "not json", contentType: "text/plain" })).toBe("unreadable");
    expect(classifyProbe({ status: 403, body: "opaque denial", contentType: "text/plain" })).toBe("unreadable");
    expect(classifyProbe({ status: 500, body: "", contentType: "" })).toBe("unreadable");

    // A 403 carrying the JSON-RPC error shape is still an application refusal.
    expect(
      classifyProbe({
        status: 403,
        body: JSON.stringify({ error: { code: -32000, message: "unauthorized" } }),
        contentType: "application/json",
      }),
    ).toBe("rejected");
  });

  test("the exit code is 1 if and only if something failed", () => {
    const pass: CheckResult = { id: "bun", label: "bun", status: "pass", value: "1.2.4" };
    const skip: CheckResult = { id: "channel", label: "channel", status: "skip", reason: "x" };
    const fail: CheckResult = {
      id: "tmux",
      label: "tmux",
      status: "fail",
      value: "missing",
      consequence: ["agents die with the terminal"],
      remedy: "brew install tmux",
    };
    expect(exitCodeFor([pass, skip])).toBe(0);
    expect(exitCodeFor([pass, fail])).toBe(1);
    expect(summaryLine([pass, skip], { color: false, utf8: true })).toContain("2 checks passed.");
  });

  test("renderReport never reorders what it is given", () => {
    const checks: CheckResult[] = [
      {
        id: "claude",
        label: "claude code",
        status: "fail",
        value: "old",
        consequence: ["c"],
        remedy: "claude update",
      },
      { id: "bun", label: "bun", status: "pass", value: "1.2.4" },
    ];
    const text = renderReport(checks, { color: false, utf8: true }).join("\n");
    expect(text.indexOf("claude code")).toBeLessThan(text.indexOf("bun"));
  });
});

/* ------------------------------------------------------------------------- */
/* Against a REAL tmux: a session that ran and died                           */
/* ------------------------------------------------------------------------- */

/**
 * Private $TMUX_TMPDIR, exactly as stage 4 does: nothing listed, created or
 * killed here can touch another agent's session on this machine. Cleanup kills
 * only names we created — never `kill-server`, never a pattern kill.
 */
const SOCKET_DIR = mkdtempSync(resolve(tmpdir(), "suite-doctor-tmux-"));
const STUB_DIR = mkdtempSync(resolve(tmpdir(), "suite-doctor-stub-"));
const TMUX_ENV = { ...process.env, TMUX_TMPDIR: SOCKET_DIR, TMUX: "" };
const tmuxDeps = liveTmuxDeps(TMUX_ENV);
const HAVE_TMUX = tmuxDeps.which("tmux") !== null;
const createdSessions = new Set<string>();

afterAll(async () => {
  for (const name of createdSessions) await tmuxDeps.run(killSessionArgv(name));
  rmSync(SOCKET_DIR, { recursive: true, force: true });
  rmSync(STUB_DIR, { recursive: true, force: true });
});

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > deadline) return v;
    await Bun.sleep(100);
  }
}

test("the real-tmux test below is not silently skipped", () => {
  expect(HAVE_TMUX || process.env.SUITE_CLI_ALLOW_NO_TMUX === "1").toBe(true);
});

describe.if(HAVE_TMUX)("against a real tmux", () => {
  test(
    "doctor reports a genuinely stale session as ✘, not as green and not as ⋯",
    async () => {
      const dir = resolve(STUB_DIR, "ledger");
      mkdirSync(dir, { recursive: true });
      const session = sessionNameFor({ naming: "cwd", cwd: dir });
      createdSessions.add(session);

      // An executable literally named `claude`, so ps reports comm=claude.
      const agent = resolve(STUB_DIR, "claude");
      Bun.spawnSync(["cp", "/bin/sleep", agent]);
      chmodSync(agent, 0o755);
      const pidFile = resolve(STUB_DIR, `${session}.pid`);

      // The shell outlives the agent on purpose: that shape is the only way to
      // reach STALE deliberately rather than by hoping for a race.
      const script = `${JSON.stringify(agent)} 900 & echo $! > ${JSON.stringify(pidFile)}; sleep 900`;
      const start = await tmuxDeps.run(newSessionArgv({ session, command: ["/bin/sh", "-c", script] }));
      expect(start.exitCode).toBe(0);

      const deps = fakeDeps();
      const real: DoctorDeps & { lines: string[] } = { ...deps, cwd: dir, tmux: tmuxDeps };
      // LIVE first, so the ✘ below is the death being detected.
      await until(async () => {
        const checks = await runChecks(real);
        return checks.find((c) => c.id === "session")?.status;
      }, (s) => s === "pass");

      const pid = (await Bun.file(pidFile).text()).trim();
      expect(pid).toMatch(/^\d+$/);
      // Kill ONLY the pid the stub recorded. Not a pattern, not a name.
      expect(Bun.spawnSync(["kill", pid]).exitCode).toBe(0);

      const status = await until(async () => {
        const checks = await runChecks(real);
        return checks.find((c) => c.id === "session")?.status;
      }, (s) => s === "fail");
      expect(status).toBe("fail");

      real.lines.length = 0;
      const code = await runDoctor(real);
      const text = real.lines.join("\n");
      expect(code).toBe(1);
      expect(text).toContain("stale");
      expect(text).toContain("→ suite claude");
      // ⋯ means could-not-run; this session ran and died.
      expect(text.split("\n").filter((l) => l.includes("stale")).some((l) => l.includes("⋯"))).toBe(false);

      await tmuxDeps.run(killSessionArgv(session));
      createdSessions.delete(session);
    },
    90_000,
  );
});

/* ------------------------------------------------------------------------- */
/* The tools endpoint: an AUTHENTICATED call, which is the whole point         */
/* ------------------------------------------------------------------------- */

describe("the tools api check", () => {
  /**
   * THE POSITIVE CONTROL. Every assertion below is about the check firing; a
   * check that fires on every input is indistinguishable from one that always
   * fires, so the SAME fixture machine must also go green.
   */
  test("goes green on a healthy tools list, on the same fixture machine", async () => {
    const { text, code, checks } = await report();
    const check = byId(checks, "tools");
    expect(check.status).toBe("pass");
    expect(code).toBe(0);
    expect(text).toContain("authenticated");
    // The count is the proof the call succeeded, and it is not a secret.
    expect(text).toContain("3 tools");
  });

  test("a 401 with a JSON-RPC error body is the credential being rejected", async () => {
    const { text, code, checks } = await report({
      probe: async () => ({ status: 401, body: REJECTED_BODY, contentType: "application/json" }),
    });
    const check = byId(checks, "tools");
    expect(check.status).toBe("fail");
    expect(code).toBe(1);
    expect(text).toContain("credential rejected");
    // The consequence names the invisible symptom, not the status code.
    expect(text).toContain("exposes no Suite tools");
    expect(text).toContain("nothing anywhere prints an error");
    // It reached the application, so nothing in front of Suite is implicated.
    expect(text).toContain("The request reached Suite");
    // Expired and never-valid look identical from here: re-enter, do not mint.
    expect(text).toContain("rather than minting a new one");
    expect(text).toContain("→ suite init");
    // Exactly one runnable line, so the reader has one thing to do.
    expect(text.split("\n").filter((l) => l.includes("→")).length).toBe(1);
    // The secret is nowhere in the report.
    expect(text).not.toContain(TOOLS_TOKEN);
  });

  /**
   * THE TEXT DIFFERENCE IS THE TICKET. `rejected` and `unreachable` need
   * OPPOSITE fixes — one is a wrong credential Suite refused, the other is
   * nothing answering at all — so a test asserting only "it failed" would pass
   * on a doctor that printed the same paragraph for both.
   */
  test("rejected and unreachable print different text", async () => {
    const rejected = await report({
      probe: async () => ({ status: 401, body: REJECTED_BODY, contentType: "application/json" }),
    });
    const unreachable = await report({
      probe: async () => {
        throw new Error("fixture: getaddrinfo ENOTFOUND");
      },
    });
    const line = (r: { text: string }) =>
      r.text.split("\n").find((l) => l.includes("tools api")) ?? "";

    expect(byId(unreachable.checks, "tools").status).toBe("fail");
    expect(unreachable.text).toContain("unreachable");
    expect(unreachable.text).toContain(`→ claude mcp get ${TOOLS_SERVER}`);
    expect(line(rejected)).not.toBe(line(unreachable));
    expect(rejected.text).not.toBe(unreachable.text);
    // And the remedies differ, which is the part that actually costs an evening.
    const remedy = (r: { checks: CheckResult[] }) => {
      const c = byId(r.checks, "tools");
      return c.status === "fail" ? c.remedy : "";
    };
    expect(remedy(rejected)).not.toBe(remedy(unreachable));
  });

  test("an HTML answer is the gateway, and says the bearer was not evaluated", async () => {
    const { text, checks } = await report({
      probe: async () => ({ status: 200, body: "<!DOCTYPE html><html><body>sign in</body></html>", contentType: "text/html; charset=utf-8" }),
    });
    expect(byId(checks, "tools").status).toBe("fail");
    expect(text).toContain("blocked before Suite");
    expect(text).toContain("never");
    expect(text).toContain("not even evaluated");
    expect(text).toContain("→ suite init");
  });

  test("a 200 carrying no tools is NEVER green", async () => {
    const { text, code, checks } = await report({
      probe: async () => ({
        status: 200,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
        contentType: "application/json",
      }),
    });
    expect(byId(checks, "tools").status).toBe("fail");
    expect(code).toBe(1);
    expect(text).toContain("response unreadable");
  });

  test("a missing or unreadable entry fails, mirroring the plugin check", async () => {
    const missing = await report({ toolsGetExit: 1, toolsGet: "" });
    expect(byId(missing.checks, "tools").status).toBe("fail");
    expect(missing.text).toContain("not registered");

    const weird = await report({ toolsGet: "Type: http\nno url on any line\n" });
    expect(byId(weird.checks, "tools").status).toBe("fail");
    expect(weird.text).toContain("entry unreadable");
    expect(weird.text).toContain("→ suite init");
  });

  test("without the claude cli it is ⋯ skipped, not red", async () => {
    const { checks } = await report({ tools: ["bun", "tmux"] });
    const check = byId(checks, "tools");
    expect(check.status).toBe("skip");
    expect(check.status === "skip" && check.reason).toBe("needs the claude cli");
  });

  /**
   * THE ps-LEAK GUARD, in code rather than in a reviewer's head.
   *
   * `run` puts argv on a command line and a command line is world-readable
   * through `ps`, so the probe must be an in-process fetch. Recording every argv
   * the fake sees and asserting none of them carries the token is the only way
   * this stays true after someone "simplifies" the probe into a spawned command.
   */
  test("the bearer never reaches an argv", async () => {
    const deps = fakeDeps();
    await runChecks(deps);
    expect(deps.argvs.length).toBeGreaterThan(3);
    for (const argv of deps.argvs) {
      for (const word of argv) {
        expect(word).not.toContain(TOOLS_TOKEN);
        expect(word.toLowerCase()).not.toContain("bearer");
      }
    }
    // Anti-vacuity: the recorder DOES capture argv, so an empty sweep would not
    // be what made this green.
    expect(deps.argvs.flat()).toContain("--version");
  });

  test("the probe carries the entry's headers verbatim, not a hardcoded set", async () => {
    const seen: ProbeRequest[] = [];
    await report({
      probe: async (request) => {
        seen.push(request);
        return { status: 200, body: toolsListBody(), contentType: "application/json" };
      },
    });
    const request = seen[0];
    expect(request).toBeDefined();
    expect(request!.url).toBe(`${SUITE_URL}/mcp`);
    expect(request!.headers.Authorization).toBe(`Bearer ${TOOLS_TOKEN}`);
    // Whatever the operator registered rides along; the check knows no names.
    expect(request!.headers["X-Fixture-Gateway-Id"]).toBe("gateway-fixture-1");
  });

  test("headers are lifted from the headers block only", () => {
    const headers = parseMcpHeaders(toolsGetOutput());
    expect(headers.Authorization).toBe(`Bearer ${TOOLS_TOKEN}`);
    expect(headers["X-Fixture-Gateway-Id"]).toBe("gateway-fixture-1");
    // A URL line and a Type line are not headers, however much they look it.
    expect(Object.keys(headers)).not.toContain("URL");
    expect(Object.keys(headers)).not.toContain("Type");
    expect(Object.keys(headers)).not.toContain("Scope");
    // The argv echo shape too.
    expect(parseMcpHeaders(`-H 'X-Fixture-Two: two'`)["X-Fixture-Two"]).toBe("two");
    expect(parseMcpHeaders(mcpGetOutput())).toEqual({});
  });

  test("the tool count reads the list length, and null when there is none", () => {
    expect(toolCount(toolsListBody(["a", "b"]))).toBe(2);
    expect(toolCount(REJECTED_BODY)).toBeNull();
    expect(toolCount("not json")).toBeNull();
  });
});

/* ------------------------------------------------------------------------- */
/* Live dependencies                                                          */
/* ------------------------------------------------------------------------- */

test("liveDoctorDeps honours NO_COLOR and a non-UTF-8 locale", async () => {
  const deps = await liveDoctorDeps({ NO_COLOR: "1", LANG: "C", HOME: "/nonexistent-fixture-home" });
  expect(deps.color).toBe(false);
  expect(deps.utf8).toBe(false);
  const utf8 = await liveDoctorDeps({ LANG: "en_US.UTF-8", HOME: "/nonexistent-fixture-home" });
  expect(utf8.utf8).toBe(true);
});
