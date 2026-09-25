import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { emptyConfig, serializeConfig } from "../src/config.ts";
import {
  HERMES_AGENT_COMM,
  HERMES_AGENT_REF,
  HERMES_CHANNEL_REF,
  LEAN_TOOLSET,
  MCP_SDK_PIN,
  TOOLSET_KEY,
  MODEL_KEY_ENV,
  agentNameForRoot,
  channelCheckoutDir,
  findHermesPython,
  lookupKey,
  gatewayArgv,
  parseConfigCheck,
  parseHermesOptions,
  parseHermesInstallDir,
  parseHermesVersion,
  pythonFromActivation,
  parseMcpTest,
  relaunchArgv,
  runHermes,
  stampHermes,
  tokenFilePath,
  type HermesDeps,
} from "../src/commands/hermes.ts";
import { renderStampResult, type StampResult } from "../src/stamp_result.ts";
import { classify, parseProcesses, type TmuxDeps } from "../src/tmux.ts";
import type { RestoreDeps } from "../src/commands/restore.ts";
import { parseRoster } from "../src/roster.ts";
import { canary, scanEnv, scanText, scanTexts, scanTree } from "./leak-scan.ts";

/**
 * `suite hermes`, against a stub `hermes` and a stub channel installer that
 * record every argv and environment they receive. Nothing here runs a real
 * Hermes, touches ~/.hermes, or talks to a network.
 */
const STUB_HERMES_DIR = resolve(import.meta.dir, "fixtures", "stub_hermes");
const STUB_HERMES = join(STUB_HERMES_DIR, "hermes");
const STUB_CHANNEL = resolve(import.meta.dir, "fixtures", "stub_channel");
const HERMES_FIXTURE = resolve(import.meta.dir, "fixtures", "hermes-fixture.ts");
const BUN_DIR = dirname(process.execPath);

let shared: string;
let channelRepo: string;
let channelRef: string;

function sh(argv: string[], cwd?: string): string {
  const p = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: shared } });
  if (p.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

beforeAll(() => {
  shared = mkdtempSync(join(tmpdir(), `suite-hermes-01a0d8f8-shared-${process.pid}-`));
  channelRepo = join(shared, "channel-repo");
  mkdirSync(channelRepo);
  copyFileSync(join(STUB_CHANNEL, "install.sh"), join(channelRepo, "install.sh"));
  chmodSync(join(channelRepo, "install.sh"), 0o755);
  sh(["git", "init", "-q", "-b", "main"], channelRepo);
  sh(["git", "add", "install.sh"], channelRepo);
  sh(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "stub"], channelRepo);
  channelRef = sh(["git", "rev-parse", "HEAD"], channelRepo);
});
afterAll(() => rmSync(shared, { recursive: true, force: true }));

let dir: string;
let home: string;
let root: string;
let hermesHome: string;
let bin: string;
let tokenPath: string;
let token: string;
/** Planted in the PARENT env under names a child must never inherit. */
let parentCanary: string;
let stderr: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), `suite-hermes-01a0d8f8-${process.pid}-`));
  home = join(dir, "home");
  bin = join(dir, "bin");
  mkdirSync(join(home, "tmux"), { recursive: true });
  mkdirSync(bin);
  root = join(dir, "roots", "hermes-01a0d8f8");
  hermesHome = join(root, ".hermes");
  tokenPath = join(dir, "runtime.token");
  token = canary("tok");
  parentCanary = canary("parent");
  writeFileSync(tokenPath, token);
  chmodSync(tokenPath, 0o600);
  writeFileSync(join(home, "stub-hermes-path"), STUB_HERMES);
  stderr = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A managed-venv python that answers `import mcp` once `pip install` ran. */
function makeManagedPython(options: { pip?: boolean; mcpPresent?: boolean; generation?: string } = {}): string {
  const venvBin = join(hermesHome, "installs", "i1", "environments", options.generation ?? "e1", "venv", "bin");
  mkdirSync(venvBin, { recursive: true });
  const py = join(venvBin, "python");
  const marker = join(home, "mcp-installed");
  if (options.mcpPresent === true) writeFileSync(marker, "");
  writeFileSync(
    py,
    `#!/usr/bin/env bash
printf '%s\\0' "$@" >>"$HOME/python-calls"; printf '\\n' >>"$HOME/python-calls"
if [ "$1" = "-c" ] && [ "$2" = "import mcp" ]; then [ -f ${JSON.stringify(marker)} ]; exit $?; fi
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then
  ${options.pip === false ? 'echo "$0: No module named pip" >&2; exit 1' : `touch ${JSON.stringify(marker)}; exit 0`}
fi
exit 0
`,
  );
  chmodSync(py, 0o755);
  return py;
}

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${bin}:${STUB_HERMES_DIR}:${BUN_DIR}:/usr/bin:/bin`,
    HOME: home,
    LANG: "C.UTF-8",
    TMUX_TMPDIR: join(home, "tmux"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    // None of these may reach any child.
    SUITE_RUNTIME_TOKEN: parentCanary,
    SUITE_URL: `https://${parentCanary}.example.invalid`,
    HERMES_HOME: join(home, ".hermes"),
    HERMES_PROFILE: parentCanary,
    OPENCLAW_STATE_DIR: parentCanary,
    ...extra,
  };
}

interface FakeTmux {
  deps: TmuxDeps;
  ran: string[][];
}

/** A tmux that reports `panes`/`ps` and records everything else. */
function fakeTmux(panes = "", ps = ""): FakeTmux {
  const ran: string[][] = [];
  return {
    ran,
    deps: {
      env: {},
      which: () => "/usr/bin/tmux",
      run: async (argv) => {
        ran.push(argv);
        if (argv[1] === "list-panes") return { exitCode: panes === "" ? 1 : 0, stdout: panes, stderr: "" };
        if (argv[0] === "ps") return { exitCode: 0, stdout: ps, stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

function makeDeps(overrides: Partial<HermesDeps> = {}, env: Record<string, string> = baseEnv()): HermesDeps & { execs: { argv: string[]; env: Record<string, string> }[] } {
  const execs: { argv: string[]; env: Record<string, string> }[] = [];
  return {
    env,
    which: (b) => Bun.which(b, { PATH: env.PATH ?? "" }),
    stderr: (t) => void stderr.push(t),
    channelRepo,
    channelRef,
    hermesInstaller: join(STUB_CHANNEL, "upstream-install.sh"),
    stdin: async () => "none",
    session: {
      isTTY: () => false,
      exec: async (argv, opts) => {
        execs.push({ argv, env: opts.env });
        return 0;
      },
      stderr: { write: (t: string) => void stderr.push(t) },
    },
    tmux: fakeTmux().deps,
    self: ["/opt/suite/bun", "/opt/suite/src/cli.ts"],
    execs,
    ...overrides,
  };
}

function stampArgs(extra: string[] = []): string[] {
  return [
    "--root",
    root,
    "--suite-url",
    "https://suite.example.invalid",
    "--runtime-id",
    "hermes-01a0d8f8-rt",
    "--token-ref",
    `file:${tokenPath}`,
    "--model-base-url",
    "http://wave.example.invalid:8000/v1",
    "--model",
    "wave-model",
    "--context-length",
    "65536",
    "--hermes",
    STUB_HERMES,
    ...extra,
  ];
}

interface StubCall {
  argv: string[];
  env: Record<string, string>;
}

function stubCalls(): StubCall[] {
  const p = join(home, "hermes-stub.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as StubCall);
}

interface InstallerCall {
  argv: string[];
  env: Record<string, string>;
  stdin: string | null;
}

function installerCalls(): InstallerCall[] {
  const d = join(home, "installer-calls");
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .sort((a, b) => Number(a) - Number(b))
    .map((n) => {
      const c = join(d, n);
      const env: Record<string, string> = {};
      for (const kv of readFileSync(join(c, "env"), "utf8").split("\0")) {
        const i = kv.indexOf("=");
        if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      return {
        argv: readFileSync(join(c, "argv"), "utf8").split("\0").slice(0, -1),
        env,
        stdin: existsSync(join(c, "stdin")) ? readFileSync(join(c, "stdin"), "utf8") : null,
      };
    });
}

const configSets = (calls: StubCall[]): StubCall[] => calls.filter((c) => c.argv[0] === "config" && c.argv[1] === "set");

async function stamp(args: string[] = stampArgs(), deps: HermesDeps = makeDeps()) {
  return await stampHermes(args, deps, { stdout: () => {}, stderr: (t) => void stderr.push(t) });
}

function outcomes(result: StampResult): Record<string, string> {
  return Object.fromEntries(result.actions.map((a) => [`${a.kind} ${a.target}`, a.outcome]));
}

/* ------------------------------------------------------------------------- */

describe("measured Hermes output shapes (fdec926e)", () => {
  test("--version yields the LOCAL commit, never the `upstream` tip", () => {
    expect(parseHermesVersion("Hermes Agent vgit.fdec926 (2026.9.24) · upstream fdec926e\nInstall directory: /x\n")).toBe(
      HERMES_AGENT_REF.slice(0, 8),
    );
    // MEASURED on the pinned install: upstream names the remote tip, 49 commits ahead.
    expect(parseHermesVersion("Hermes Agent v0.21.5+2164.gfdec926 (2026.9.24) · upstream 346c14a9\nInstall directory: /x\n")).toBe(
      HERMES_AGENT_REF.slice(0, 8),
    );
    expect(parseHermesVersion("Hermes Agent v0.21.5+3.g1234abcd (2026.9.30) · upstream fdec926e\n")).toBe("1234abcd");
    expect(parseHermesVersion("Hermes Agent v2026.10.1\n")).toBe("2026.10.1");
    expect(parseHermesInstallDir("Hermes Agent vgit.fdec926\nInstall directory: /a b/hermes-agent\nPython: 3.14.7\n")).toBe("/a b/hermes-agent");
  });

  test("config check: the measured healthy output passes, update-available still passes", () => {
    const healthy = "\n📋 Configuration Status\n\n  Config version: 46 ✓\n\n  Required:\n\n  Optional:\n    ○ NOUS_BASE_URL\n";
    expect(parseConfigCheck(0, healthy, "").verdict).toBe("pass");
    const update = "\n📋 Configuration Status\n\n  Config version: 0 → 46 (update available)\n\n  Required:\n\n  Optional:\n";
    expect(parseConfigCheck(0, update, "").verdict).toBe("pass");
  });

  test("config check: a missing required variable and a YAML error both fail; no version line is unparseable", () => {
    const missing = "  Config version: 46 ✓\n\n  Required:\n    ✗ SOME_KEY (missing)\n";
    expect(parseConfigCheck(0, missing, "")).toMatchObject({ verdict: "fail", raw: "✗ SOME_KEY (missing)" });
    const yamlError = "Your settings file (/h/config.yaml) has a formatting error at line 2. Hermes is running on your last good settings";
    expect(parseConfigCheck(1, "", yamlError)).toMatchObject({ verdict: "fail", exit_code: 1 });
    expect(parseConfigCheck(0, "hello", "")).toMatchObject({ verdict: "unparseable", raw: "hello" });
  });

  test("mcp test: the measured connected output passes; 0 tools, exit 1 and exit 3 fail; garbage is unparseable", () => {
    const ok = "\n  Testing 'startup-suite'...\n  Transport: stdio → /v/python\n  Auth: none\n  ✓ Connected (1655ms)\n  ✓ Tools discovered: 2\n";
    expect(parseMcpTest(0, ok, "").verdict).toBe("pass");
    expect(parseMcpTest(0, "  ✓ Connected (1ms)\n  ✓ Tools discovered: 0\n", "").verdict).toBe("fail");
    expect(parseMcpTest(1, "  ✗ Connection failed (11.1s): Connection closed\n", "")).toMatchObject({
      verdict: "fail",
      raw: "✗ Connection failed (11.1s): Connection closed",
    });
    expect(parseMcpTest(3, "  ✗ Server 'startup-suite' not found in config.\n", "").verdict).toBe("fail");
    expect(parseMcpTest(0, "  Testing...\n  weird\n", "").verdict).toBe("unparseable");
    // ANSI colour does not change a verdict.
    expect(parseMcpTest(0, "\x1b[32m  ✓ Connected (5ms)\x1b[0m\n\x1b[32m  ✓ Tools discovered: 3\x1b[0m\n", "").verdict).toBe("pass");
  });
});

describe("options", () => {
  test("HERMES_HOME defaults to <root>/.hermes, never ~/.hermes", () => {
    const o = parseHermesOptions(["--root", root, "--model-base-url", "u", "--model", "m"]);
    expect(o.hermesHome).toBe(join(root, ".hermes"));
    expect(o.hermesHome).not.toBe(join(process.env.HOME ?? "", ".hermes"));
  });

  test("parsing stops at --; what follows goes to the gateway untouched", () => {
    const o = parseHermesOptions(["--root", root, "--", "--root", "x", "--verbose"]);
    expect(o.root).toBe(root);
    expect(o.rest).toEqual(["--root", "x", "--verbose"]);
  });

  test("a literal token and an unknown flag are refused; the unknown positional is not repeated", () => {
    expect(() => parseHermesOptions(["--root", root, "--token", "x"])).toThrow(/--token is refused/);
    expect(() => parseHermesOptions(["--root", root, "--frobnicate"])).toThrow(/unknown option --frobnicate/);
    const secretish = canary("pos");
    let message = "";
    try {
      parseHermesOptions(["--root", root, secretish]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/unexpected positional argument/);
    expect(message.includes(secretish)).toBe(false);
  });

  test("the session command is the same command without --stamp-only", () => {
    const o = parseHermesOptions(["--root", root, "--stamp-only", "--model", "m", "--", "--x"]);
    expect(o.sessionArgs).toEqual(["--root", root, "--model", "m", "--", "--x"]);
  });
});

describe("stamping from nothing (file: ref)", () => {
  test("stamps, passes the post-write checks, and records the sanctioned 0600 token file", async () => {
    makeManagedPython();
    const { result, exitCode } = await stamp();
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.harness_version).toBe("fdec926e");
    expect(result.warnings).toEqual([]);
    expect(result.validation.verdict).toBe("pass");
    expect(result.validation.checks.map((c) => c.command)).toEqual(["hermes config check", "hermes mcp test startup-suite"]);

    const o = outcomes(result);
    expect(o[`sanctioned_token_file ${tokenFilePath(hermesHome)}`]).toBe("written");
    expect(o[`plugin_checkout ${join(home, ".local", "share", "suite", "hermes-suite-channel")}@${channelRef}`]).toBe("written");
    expect(o["config_set model.context_length"]).toBe("written");
    expect(statSync(tokenFilePath(hermesHome)).mode & 0o777).toBe(0o600);

    const config = parseYaml(readFileSync(join(hermesHome, "config.yaml"), "utf8")) as Record<string, Record<string, unknown>>;
    expect(config.model).toEqual({
      provider: "custom",
      base_url: "http://wave.example.invalid:8000/v1",
      default: "wave-model",
      context_length: 65536,
    });

    // The installer got the file PATH, never the value, and the allow-all default.
    const [call] = installerCalls();
    expect(call?.argv).toContain("--token-file");
    expect(call?.argv).toContain(tokenPath);
    expect(call?.argv).toContain("--allow-all-users");
    expect(call?.argv.slice(call.argv.indexOf("--url"), call.argv.indexOf("--url") + 2)).toEqual([
      "--url",
      "wss://suite.example.invalid/runtime/ws",
    ]);
    expect(call?.stdin).toBeNull();

    // The one mcp SDK install, pinned.
    expect(readFileSync(join(home, "python-calls"), "utf8")).toContain(`-m\0pip\0install\0--quiet\0${MCP_SDK_PIN}`);

    // The start_agent_session step is this command without --stamp-only.
    expect(result.human_steps).toEqual([{ kind: "start_agent_session", text: expect.stringContaining(`suite hermes --root ${root}`) }]);
  });

  test("no token and no parent SUITE_/HERMES_/OPENCLAW_ value in any argv, env, output or file outside the sanctioned copy", async () => {
    makeManagedPython();
    const { result } = await stamp();
    const calls = stubCalls();
    const inst = installerCalls();
    expect(calls.length).toBeGreaterThan(4);
    expect(inst.length).toBe(1);

    // Positive control first: the scanner finds both canaries where we planted them.
    expect(scanText("control", `x ${token} y`, token)).toHaveLength(1);
    expect(scanEnv("control", baseEnv(), parentCanary).length).toBeGreaterThan(0);
    expect(scanTree(hermesHome, token).map((h) => h.where)).toContain(tokenFilePath(hermesHome));

    for (const secret of [token, parentCanary]) {
      const hits = [
        ...calls.flatMap((c, i) => [...scanText(`stub argv ${i}`, c.argv.join("\0"), secret), ...scanEnv(`stub env ${i}`, c.env, secret)]),
        ...inst.flatMap((c, i) => [...scanText(`installer argv ${i}`, c.argv.join("\0"), secret), ...scanEnv(`installer env ${i}`, c.env, secret)]),
        ...scanTexts({ json: renderStampResult(result), stderr: stderr.join("") }, secret),
        ...scanTree(root, secret, { exclude: [tokenFilePath(hermesHome)] }),
      ];
      expect(hits).toEqual([]);
    }
    // Every child saw the root-scoped HERMES_HOME, not the parent's.
    for (const c of [...calls, ...inst]) expect(c.env.HERMES_HOME).toBe(hermesHome);
    for (const c of [...calls, ...inst]) expect(Object.keys(c.env).filter((k) => k.startsWith("SUITE_"))).toEqual([]);
  });

  test("the channel installer's own gateway-restart advice is not passed on", async () => {
    makeManagedPython();
    await stamp();
    const err = stderr.join("");
    expect(err).not.toContain("restart the gateway to load it");
    expect(err).toContain("never `gateway restart`");
  });

  test("setup is never invoked, and no gateway start/restart/install", async () => {
    makeManagedPython();
    await stamp();
    await stamp();
    const verbs = stubCalls().map((c) => c.argv.slice(0, 2).join(" "));
    expect(verbs.length).toBeGreaterThan(0);
    expect(verbs.filter((v) => v.startsWith("setup"))).toEqual([]);
    expect(verbs.filter((v) => /^gateway (start|restart|install)/.test(v))).toEqual([]);
  });
});

describe("idempotence and repair", () => {
  test("a second identical run is changed:false, every action unchanged, and makes 0 config set calls", async () => {
    makeManagedPython();
    const first = await stamp();
    expect(first.exitCode).toBe(0);
    const setsBefore = configSets(stubCalls()).length;
    expect(setsBefore).toBeGreaterThan(0);
    stderr = [];

    const second = await stamp();
    expect(second.exitCode).toBe(0);
    expect(second.result.changed).toBe(false);
    expect(second.result.actions.filter((a) => a.outcome !== "unchanged")).toEqual([]);
    expect(configSets(stubCalls()).length).toBe(setsBefore);
    expect(stderr.join("")).toMatch(/already installed/);
    expect(stderr.join("")).toMatch(/already enabled/);
    // Only the first run installed the SDK.
    const pipRuns = readFileSync(join(home, "python-calls"), "utf8").split("\n").filter((l) => l.includes("pip\0install"));
    expect(pipRuns).toHaveLength(1);
  });

  test("a deleted MCP entry is repaired by the installer and reported as repaired", async () => {
    makeManagedPython();
    await stamp();
    const cfgPath = join(hermesHome, "config.yaml");
    const cfg = parseYaml(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    delete cfg.mcp_servers;
    writeFileSync(cfgPath, stringifyYaml(cfg));

    const { result, exitCode } = await stamp();
    expect(exitCode).toBe(0);
    expect(result.changed).toBe(true);
    const changed = result.actions.filter((a) => a.outcome !== "unchanged");
    expect(changed.map((a) => [a.kind, a.outcome])).toEqual([["mcp_server", "repaired"]]);
    const after = parseYaml(readFileSync(cfgPath, "utf8")) as { mcp_servers: Record<string, { args: string[] }> };
    const args = after.mcp_servers["startup-suite"]?.args ?? [];
    // The entry references the token only by its 0600 file path.
    expect(args).toContain(tokenFilePath(hermesHome));
    expect(args.join(" ").includes(token)).toBe(false);
  });

  test("a changed model is one config set, reported repaired", async () => {
    makeManagedPython();
    await stamp();
    const before = configSets(stubCalls()).length;
    const args = stampArgs();
    args[args.indexOf("--model") + 1] = "other-model";
    const { result } = await stamp(args);
    const sets = configSets(stubCalls()).slice(before);
    expect(sets.map((c) => c.argv.slice(2))).toEqual([["model.default", "other-model"]]);
    expect(outcomes(result)["config_set model.default"]).toBe("repaired");
  });
});

describe("the Suite platform toolset (product default: lean, --full-toolset opts out)", () => {
  const cfgPath = (): string => join(hermesHome, "config.yaml");
  const toolsetValue = (): unknown => lookupKey(parseYaml(readFileSync(cfgPath(), "utf8")), TOOLSET_KEY);
  /** Every stub call that writes or removes the toolset key. */
  const toolsetWrites = (calls: StubCall[]): string[][] =>
    calls.filter((c) => c.argv[0] === "config" && (c.argv[1] === "set" || c.argv[1] === "unset") && c.argv[2] === TOOLSET_KEY).map((c) => c.argv);
  /** Every config write of any key. */
  const configWrites = (calls: StubCall[]): StubCall[] =>
    calls.filter((c) => c.argv[0] === "config" && (c.argv[1] === "set" || c.argv[1] === "unset"));

  test("the default sets exactly platform_toolsets.startup_suite to [hermes-webhook], and no other toolset key", async () => {
    makeManagedPython();
    const { result, exitCode } = await stamp();
    expect(exitCode).toBe(0);
    expect(toolsetWrites(stubCalls())).toEqual([["config", "set", "platform_toolsets.startup_suite", '["hermes-webhook"]']]);
    // No other platform's toolsets and no global default are touched.
    const others = configWrites(stubCalls()).filter((c) => /toolset/.test(c.argv[2] ?? "") && c.argv[2] !== TOOLSET_KEY);
    expect(others).toEqual([]);
    const pts = lookupKey(parseYaml(readFileSync(cfgPath(), "utf8")), "platform_toolsets");
    expect(pts).toEqual({ startup_suite: ["hermes-webhook"] });
    expect(LEAN_TOOLSET).toEqual(["hermes-webhook"]);
    const a = result.actions.find((x) => x.kind === "config_set" && x.target === TOOLSET_KEY);
    expect(a).toEqual({ kind: "config_set", target: TOOLSET_KEY, outcome: "written", applied: true });
  });

  test("other platforms' toolsets already in config.yaml are left byte-for-byte as they were", async () => {
    makeManagedPython();
    mkdirSync(hermesHome, { recursive: true });
    writeFileSync(cfgPath(), stringifyYaml({ platform_toolsets: { cli: ["hermes-cli"], telegram: ["hermes-telegram"] }, toolsets: ["kanban"] }));
    expect((await stamp()).exitCode).toBe(0);
    const cfg = parseYaml(readFileSync(cfgPath(), "utf8")) as Record<string, unknown>;
    expect(cfg.platform_toolsets).toEqual({ cli: ["hermes-cli"], telegram: ["hermes-telegram"], startup_suite: ["hermes-webhook"] });
    expect(cfg.toolsets).toEqual(["kanban"]);
  });

  test("--full-toolset does not set it, and records the key unchanged", async () => {
    makeManagedPython();
    const { result, exitCode } = await stamp(stampArgs(["--full-toolset"]));
    expect(exitCode).toBe(0);
    expect(toolsetWrites(stubCalls())).toEqual([]);
    expect(toolsetValue()).toBeUndefined();
    expect(outcomes(result)[`config_set ${TOOLSET_KEY}`]).toBe("unchanged");
    // The session command carries the choice, so the relaunch stamps the same way.
    expect(result.human_steps[0]?.text).toContain("--full-toolset");
  });

  test("an operator's own value is preserved in both modes, reported unchanged, with a warning", async () => {
    makeManagedPython();
    mkdirSync(hermesHome, { recursive: true });
    const mine = ["hermes-cli", "startup-suite"];
    writeFileSync(cfgPath(), stringifyYaml({ platform_toolsets: { startup_suite: mine } }));
    for (const extra of [[], ["--full-toolset"]]) {
      const { result, exitCode } = await stamp(stampArgs(extra));
      expect(exitCode).toBe(0);
      expect(toolsetValue()).toEqual(mine);
      expect(outcomes(result)[`config_set ${TOOLSET_KEY}`]).toBe("unchanged");
      expect(result.warnings.some((w) => w.includes(TOOLSET_KEY) && w.includes("operator"))).toBe(true);
    }
    expect(toolsetWrites(stubCalls())).toEqual([]);
  });

  test("a re-run makes 0 config writes of any key, in either mode", async () => {
    for (const extra of [[], ["--full-toolset"]]) {
      rmSync(root, { recursive: true, force: true });
      makeManagedPython();
      expect((await stamp(stampArgs(extra))).exitCode).toBe(0);
      const before = stubCalls().length;
      const again = await stamp(stampArgs(extra));
      expect(again.exitCode).toBe(0);
      expect(again.result.changed).toBe(false);
      expect(configWrites(stubCalls().slice(before))).toEqual([]);
    }
  });

  test("flipping default -> --full-toolset removes the lean list (repaired); flipping back writes it again (repaired)", async () => {
    makeManagedPython();
    expect((await stamp()).exitCode).toBe(0);
    expect(toolsetValue()).toEqual(["hermes-webhook"]);

    let before = stubCalls().length;
    const full = await stamp(stampArgs(["--full-toolset"]));
    expect(full.exitCode).toBe(0);
    expect(full.result.changed).toBe(true);
    expect(toolsetWrites(stubCalls().slice(before))).toEqual([["config", "unset", TOOLSET_KEY]]);
    expect(outcomes(full.result)[`config_set ${TOOLSET_KEY}`]).toBe("repaired");
    expect(toolsetValue()).toBeUndefined();

    before = stubCalls().length;
    const lean = await stamp();
    expect(lean.exitCode).toBe(0);
    expect(toolsetWrites(stubCalls().slice(before))).toEqual([["config", "set", TOOLSET_KEY, '["hermes-webhook"]']]);
    expect(outcomes(lean.result)[`config_set ${TOOLSET_KEY}`]).toBe("repaired");
    expect(toolsetValue()).toEqual(["hermes-webhook"]);
  });

  test("--full-toolset takes no value", () => {
    expect(() => parseHermesOptions(["--root", root, "--full-toolset=yes"])).toThrow(/takes no value/);
    expect(parseHermesOptions(["--root", root, "--full-toolset"]).fullToolset).toBe(true);
    expect(parseHermesOptions(["--root", root]).fullToolset).toBe(false);
  });
});

describe("the keychain path", () => {
  test("the value reaches ONLY the installer's stdin (and the sanctioned file it writes)", async () => {
    makeManagedPython();
    const security = join(bin, "security");
    // An absolute log path: execFile gives security the TEST RUNNER's env, whose HOME is real.
    writeFileSync(security, `#!/usr/bin/env bash\nprintf '%s\\0' "$@" >${JSON.stringify(join(home, "security.argv"))}\nprintf '%s\\n' ${JSON.stringify(token)}\n`);
    chmodSync(security, 0o755);
    const args = stampArgs();
    args.splice(args.indexOf("--token-ref"), 2, "--token-ref", "keychain:RUNTIME_TOKEN.hermes", "--keychain-service", "suite-test");
    const deps = makeDeps({ resolve: { platform: "darwin", securityBin: security } });
    const { result, exitCode } = await stamp(args, deps);
    expect(exitCode).toBe(0);
    expect(result.token_ref).toBe("keychain:RUNTIME_TOKEN.hermes");

    const [call] = installerCalls();
    expect(call?.stdin).toBe(token);
    expect(call?.argv).not.toContain("--token-file");
    expect(readFileSync(tokenFilePath(hermesHome), "utf8").trim()).toBe(token);
    // security's argv carried names only.
    expect(readFileSync(join(home, "security.argv"), "utf8").split("\0").slice(0, -1)).toEqual([
      "find-generic-password",
      "-s",
      "suite-test",
      "-a",
      "RUNTIME_TOKEN.hermes",
      "-w",
    ]);

    const hits = [
      ...stubCalls().flatMap((c, i) => [...scanText(`argv ${i}`, c.argv.join("\0"), token), ...scanEnv(`env ${i}`, c.env, token)]),
      ...installerCalls().flatMap((c, i) => [...scanText(`iargv ${i}`, c.argv.join("\0"), token), ...scanEnv(`ienv ${i}`, c.env, token)]),
      ...scanTexts({ json: renderStampResult(result), stderr: stderr.join("") }, token),
      ...scanTree(root, token, { exclude: [tokenFilePath(hermesHome)] }),
    ];
    expect(hits).toEqual([]);
    expect(result.warnings.some((w) => /materialised into .*0600.*no keychain resolver/.test(w))).toBe(true);
  });
});

describe("refusals and failures", () => {
  test("no hermes and no --install-hermes: exit 2 naming the flag, nothing written", async () => {
    const env = baseEnv({ PATH: `${bin}:${BUN_DIR}:/usr/bin:/bin` });
    const args = stampArgs().filter((a, i, all) => a !== "--hermes" && all[i - 1] !== "--hermes");
    const { result, exitCode } = await stamp(args, makeDeps({}, env));
    expect(exitCode).toBe(2);
    expect(result.error?.code).toBe("harness_absent");
    expect(result.error?.message).toContain("--install-hermes");
    expect(existsSync(root)).toBe(false);
    expect(stubCalls()).toEqual([]);
  });

  test("--install-hermes runs the upstream installer pinned, non-interactive, with HERMES_HOME set, and says what it writes outside it", async () => {
    const env = baseEnv({ PATH: `${bin}:${BUN_DIR}:/usr/bin:/bin` });
    const args = stampArgs().filter((a, i, all) => a !== "--hermes" && all[i - 1] !== "--hermes");
    // The managed python lives under HERMES_HOME, created before the install here.
    makeManagedPython();
    const { result, exitCode } = await stamp([...args, "--install-hermes"], makeDeps({}, env));
    expect(exitCode).toBe(0);
    const argv = readFileSync(join(home, "upstream-installer.argv"), "utf8").split("\0").slice(0, -1);
    expect(argv).toEqual(["--non-interactive", "--commit", HERMES_AGENT_REF, "--hermes-home", hermesHome]);
    expect(readFileSync(join(home, "upstream-installer.hermes_home"), "utf8")).toBe(hermesHome);
    expect(result.actions.map((a) => a.kind)).toContain("harness_install");
    expect(result.actions.map((a) => a.kind)).toContain("upstream_outside_hermes_home");
    expect(result.warnings.some((w) => w.includes("shell rc PATH lines"))).toBe(true);
    expect(stderr.join("")).toContain("writes OUTSIDE");

    // A re-run finds the installed launcher and does not install again.
    rmSync(join(home, "upstream-installer.argv"));
    const again = await stamp([...args, "--install-hermes"], makeDeps({}, env));
    expect(again.exitCode).toBe(0);
    expect(existsSync(join(home, "upstream-installer.argv"))).toBe(false);
    expect(again.result.changed).toBe(false);
  });

  test("operator headers are refused with exit 2 before any harness call", async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "suite.json"), serializeConfig({ ...emptyConfig(), headerNames: ["X-Example-Id"] }));
    const { result, exitCode } = await stamp();
    expect(exitCode).toBe(2);
    expect(result.error?.code).toBe("headers_unsupported");
    expect(stubCalls()).toEqual([]);
  });

  test("an unparseable `mcp test` is exit 1, carrying the raw line", async () => {
    makeManagedPython();
    writeFileSync(join(home, "hermes-stub-knobs.json"), JSON.stringify({ mcp: "garbage" }));
    const { result, exitCode } = await stamp();
    expect(exitCode).toBe(1);
    expect(result.validation.verdict).toBe("unparseable");
    const check = result.validation.checks.find((c) => c.command.startsWith("hermes mcp test"));
    expect(check).toMatchObject({ verdict: "unparseable", exit_code: 0 });
    expect(check?.raw).toBeTruthy();
  });

  test("a server with 0 tools fails the check", async () => {
    makeManagedPython();
    writeFileSync(join(home, "hermes-stub-knobs.json"), JSON.stringify({ mcp: "zero" }));
    const { result, exitCode } = await stamp();
    expect(exitCode).toBe(1);
    expect(result.validation.verdict).toBe("fail");
  });

  test("an unmeasured Hermes version is one warning, not a failure", async () => {
    makeManagedPython();
    writeFileSync(join(home, "hermes-stub-knobs.json"), JSON.stringify({ version: "Hermes Agent vgit.abc1234 (2026.12.1) · upstream abc12345" }));
    const { result, exitCode } = await stamp();
    expect(exitCode).toBe(0);
    expect(result.warnings).toEqual(["config shape unverified for hermes abc1234"]);
  });

  test("the version is the install's own commit read with git, never the `upstream` tip", async () => {
    makeManagedPython();
    const install = join(dir, "hermes-install");
    mkdirSync(install);
    sh(["git", "init", "-q", "-b", "main"], install);
    sh(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "x"], install);
    const head = sh(["git", "rev-parse", "HEAD"], install);
    writeFileSync(
      join(home, "hermes-stub-knobs.json"),
      JSON.stringify({ version: `Hermes Agent v0.21.5+2164.gfdec926 (2026.9.24) · upstream 346c14a9\nInstall directory: ${install}` }),
    );
    const { result, exitCode } = await stamp();
    expect(exitCode).toBe(0);
    expect(result.harness_version).toBe(head.slice(0, 8));
    expect(result.warnings).toEqual([`config shape unverified for hermes ${head.slice(0, 8)}`]);
  });

  test("a failed channel install reports no write it did not make, and records `fail` over an earlier pass", async () => {
    makeManagedPython();
    expect((await stamp()).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(root, ".suite-stamp.json"), "utf8")).verdict).toBe("pass");
    // A changed model is a planned config set; the installer then fails first.
    const installer = join(channelCheckoutDir(makeDeps().env), "install.sh");
    writeFileSync(installer, `#!/usr/bin/env bash\necho "hermes-suite-channel: error: /bin/sh is older than Python 3.8" >&2\nexit 1\n`);
    const before = readFileSync(join(hermesHome, "config.yaml"), "utf8");
    const { result, exitCode } = await stamp(stampArgs().map((a) => (a === "wave-model" ? "other-model" : a)));
    expect(exitCode).toBe(1);
    expect(result.error?.code).toBe("channel_install_failed");
    const model = result.actions.find((a) => a.kind === "config_set" && a.target === "model.default");
    expect(model).toMatchObject({ outcome: "repaired", applied: false });
    expect(readFileSync(join(hermesHome, "config.yaml"), "utf8")).toBe(before);
    for (const a of result.actions) if (a.kind !== "stamp_record" && a.kind !== "identity") expect(a.applied && a.outcome !== "unchanged").toBe(false);
    expect(JSON.parse(readFileSync(join(root, ".suite-stamp.json"), "utf8")).verdict).toBe("fail");
    expect(result.actions.at(-1)).toMatchObject({ kind: "stamp_record", outcome: "repaired", applied: true });
    // --gateway-only now refuses to launch the root.
    const o = parseHermesOptions(stampArgs());
    const relaunch = relaunchArgv(["/opt/suite/bun", "/opt/suite/src/cli.ts"], o, STUB_HERMES);
    expect(await runHermes(relaunch.slice(3), makeDeps())).toBe(2);
  });
});

describe("the interpreter, with a real #!/bin/sh launcher (fdec926e ships only these)", () => {
  /** A launcher of the shape fdec926e installs: POSIX sh exec-ing the real program. */
  function shLauncher(): string {
    const p = join(bin, "hermes");
    writeFileSync(p, `#!/bin/sh\nexec ${STUB_HERMES} "$@"\n`);
    chmodSync(p, 0o755);
    return p;
  }
  const withLauncher = (launcher: string): string[] => stampArgs().map((a) => (a === STUB_HERMES ? launcher : a));

  test("Hermes's own answer (`--run-module pm.environments`) is the interpreter, and the installer is handed it", async () => {
    const py = makeManagedPython();
    const launcher = shLauncher();
    const { result, exitCode } = await stamp(withLauncher(launcher));
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    const call = installerCalls()[0] as InstallerCall;
    expect(call.argv[call.argv.indexOf("--python") + 1]).toBe(py);
    expect(call.argv[call.argv.indexOf("--hermes") + 1]).toBe(launcher);
    expect(stubCalls().some((c) => c.argv[0] === "--run-module" && c.argv[1] === "pm.environments")).toBe(true);
  });

  test("a venv Hermes commits while installing the plugin is the one registered, so the first re-run changes nothing", async () => {
    makeManagedPython({ mcpPresent: true });
    const e2 = makeManagedPython({ mcpPresent: true, generation: "e2" });
    writeFileSync(join(home, "hermes-stub-knobs.json"), JSON.stringify({ activation: "switch" }));
    const first = await stamp(withLauncher(shLauncher()));
    expect(first.exitCode).toBe(0);
    const calls = installerCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.argv[(calls[1]?.argv.indexOf("--python") ?? 0) + 1]).toBe(e2);
    expect(lookupKey(parseYaml(readFileSync(join(hermesHome, "config.yaml"), "utf8")), "mcp_servers.startup-suite.command")).toBe(e2);
    expect(first.result.actions.find((a) => a.kind === "mcp_sdk")?.target).toBe(`${e2} ${MCP_SDK_PIN}`);
    const before = stubCalls().length;
    const again = await stamp(withLauncher(join(bin, "hermes")));
    expect(again.exitCode).toBe(0);
    expect(again.result.changed).toBe(false);
    expect(configSets(stubCalls().slice(before))).toEqual([]);
  });

  test("a shell shebang is never taken for the interpreter", () => {
    const launcher = shLauncher();
    const found = findHermesPython(join(dir, "no-home"), launcher, { which: (b) => (b === "python3" ? "/usr/bin/python3" : null) });
    expect(found).toBe("/usr/bin/python3");
    expect(found).not.toBe("/bin/sh");
  });

  test("the activation JSON's PYTHONPATH names the venv: its bin/python is the interpreter (measured shape)", () => {
    const venv = "/h/.hermes/installs/18b099f9e907f2de/environments/952fde04b2ba442e9e1ead1656b09fa7/venv";
    const out = JSON.stringify({
      HOME: "/h",
      HERMES_HOME: "/h/.hermes",
      PYTHONPATH: `/h/.hermes/hermes-agent:${venv}/lib/python3.14/site-packages`,
      __HERMES_ACTIVATED: "/h/.hermes/installs/18b099f9e907f2de/facts.json",
    });
    expect(pythonFromActivation(out)).toBe(`${venv}/bin/python`);
    expect(pythonFromActivation("not json")).toBeNull();
    expect(pythonFromActivation(JSON.stringify({ PYTHONPATH: "/h/.hermes/hermes-agent" }))).toBeNull();
  });
});

describe("the mcp SDK", () => {
  test("a venv without pip falls back to uv, pinned to the measured version", async () => {
    const py = makeManagedPython({ pip: false });
    writeFileSync(join(bin, "uv"), `#!/usr/bin/env bash\nprintf '%s\\0' "$@" >"$HOME/uv.argv"\ntouch "$HOME/mcp-installed"\n`);
    chmodSync(join(bin, "uv"), 0o755);
    const { exitCode } = await stamp();
    expect(exitCode).toBe(0);
    expect(readFileSync(join(home, "uv.argv"), "utf8").split("\0").slice(0, -1)).toEqual([
      "pip",
      "install",
      "--quiet",
      "--python",
      py,
      MCP_SDK_PIN,
    ]);
  });

  test("an SDK already importable is left alone", async () => {
    makeManagedPython({ mcpPresent: true });
    const { result } = await stamp();
    expect(result.actions.find((a) => a.kind === "mcp_sdk")?.outcome).toBe("unchanged");
    expect(readFileSync(join(home, "python-calls"), "utf8")).not.toContain("pip");
  });
});

describe("the optional model key", () => {
  test("is stored in .env under key_env with one warning, never on any argv or env, and is idempotent", async () => {
    makeManagedPython();
    const key = canary("modelkey");
    const keyPath = join(dir, "model.key");
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o600);
    const args = [...stampArgs(), "--model-api-key-ref", `file:${keyPath}`];
    const { result, exitCode } = await stamp(args);
    expect(exitCode).toBe(0);
    const envText = readFileSync(join(hermesHome, ".env"), "utf8");
    expect(envText).toContain(`${MODEL_KEY_ENV}=${key}\n`);
    expect(statSync(join(hermesHome, ".env")).mode & 0o777).toBe(0o600);
    expect(result.warnings.filter((w) => w.includes("os.environ"))).toHaveLength(1);
    const hits = [
      ...stubCalls().flatMap((c, i) => [...scanText(`argv ${i}`, c.argv.join("\0"), key), ...scanEnv(`env ${i}`, c.env, key)]),
      ...scanTexts({ json: renderStampResult(result), stderr: stderr.join("") }, key),
    ];
    expect(hits).toEqual([]);

    const again = await stamp(args);
    expect(again.result.changed).toBe(false);
  });
});

describe("the gateway session", () => {
  test("detectState pins the measured comm: a hermes descendant is live, a bare shell is stale", () => {
    expect(HERMES_AGENT_COMM).toBe("hermes");
    const panes = [{ session: "suite-hermes-01a0d8f8", pid: 100, command: "bash" }];
    const live = parseProcesses(
      "  100     1 bash    bash\n  101   100 bun     /opt/bun /opt/cli.ts hermes --gateway-only\n  102   101 hermes  /v/bin/python /v/bin/hermes gateway run\n",
    );
    expect(classify(panes, live, "suite-hermes-01a0d8f8", HERMES_AGENT_COMM)).toBe("live");
    const dead = parseProcesses("  100     1 bash    bash\n");
    expect(classify(panes, dead, "suite-hermes-01a0d8f8", HERMES_AGENT_COMM)).toBe("stale");
  });

  test("a fresh run creates suite-<name> running the --gateway-only relaunch, with no token anywhere, and records it", async () => {
    makeManagedPython();
    const tmux = fakeTmux();
    const written: Record<string, string> = {};
    const restore: RestoreDeps = {
      tmux: tmux.deps,
      readRoster: (p) => written[p] ?? null,
      writeRoster: (p, c) => void (written[p] = c),
      now: () => new Date("2026-09-25T00:00:00Z"),
      log: () => {},
    };
    const deps = makeDeps({ tmux: tmux.deps, restore });
    const code = await runHermes(stampArgs(), deps);
    expect(code).toBe(0);
    const created = tmux.ran.filter((a) => a[1] === "new-session");
    expect(created).toHaveLength(1);
    const create = created[0] ?? [];
    expect(create.slice(0, 5)).toEqual(["tmux", "new-session", "-d", "-s", `suite-${agentNameForRoot(root)}`]);
    expect(create).toContain("--gateway-only");
    expect(create).toContain("--no-session");
    expect(create.join(" ").includes(token)).toBe(false);
    expect(create.some((a) => /^(start|restart|install)$/.test(a))).toBe(false);

    const roster = parseRoster(Object.values(written)[0] ?? "");
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ kind: "hermes", session: `suite-${agentNameForRoot(root)}`, cwd: root });
  });

  test("a live session is attached to (or left running), never duplicated", async () => {
    makeManagedPython();
    const session = `suite-${agentNameForRoot(root)}`;
    const tmux = fakeTmux(
      `${session}\t100\tbash\n`,
      "  100     1 bash    bash\n  102   100 hermes  /v/bin/python /v/bin/hermes gateway run\n",
    );
    const code = await runHermes(stampArgs(), makeDeps({ tmux: tmux.deps }));
    expect(code).toBe(0);
    expect(tmux.ran.filter((a) => a[1] === "new-session")).toEqual([]);
    expect(stderr.join("")).toContain(`attaching to ${session}`);
  });

  test("a stale session is recycled out loud", async () => {
    makeManagedPython();
    const session = `suite-${agentNameForRoot(root)}`;
    const tmux = fakeTmux(`${session}\t100\tbash\n`, "  100     1 bash    bash\n");
    await runHermes(stampArgs(), makeDeps({ tmux: tmux.deps }));
    expect(tmux.ran.some((a) => a[1] === "kill-session" && a[3] === session)).toBe(true);
    expect(tmux.ran.filter((a) => a[1] === "new-session")).toHaveLength(1);
    expect(stderr.join("")).toContain(`recycling stale session ${session}`);
  });

  test("a recorded session that tmux no longer has is relaunched out loud, not announced as a first start", async () => {
    makeManagedPython();
    const tmux = fakeTmux();
    const written: Record<string, string> = {};
    const restore: RestoreDeps = {
      tmux: tmux.deps,
      readRoster: (p) => written[p] ?? null,
      writeRoster: (p, c) => void (written[p] = c),
      now: () => new Date("2026-09-25T00:00:00Z"),
      log: () => {},
    };
    const session = `suite-${agentNameForRoot(root)}`;
    // First launch: nothing recorded yet, so no stale line.
    await runHermes(stampArgs(), makeDeps({ tmux: tmux.deps, restore }));
    expect(stderr.join("")).not.toContain("was stale");
    // The gateway died and took the tmux server with it: tmux says none, the roster says launched.
    stderr = [];
    await runHermes(stampArgs(), makeDeps({ tmux: tmux.deps, restore }));
    expect(stderr.join("")).toContain(`suite: previous session ${session} was stale (recorded, no longer running); relaunching`);
    expect(tmux.ran.filter((a) => a[1] === "new-session")).toHaveLength(2);
  });

  test("--gateway-only execs `hermes gateway run` with an allowlisted env and no Suite credential", async () => {
    makeManagedPython();
    await stamp();
    const deps = makeDeps();
    const o = parseHermesOptions(stampArgs());
    const relaunch = relaunchArgv(["/opt/suite/bun", "/opt/suite/src/cli.ts"], { ...o, rest: ["--verbose"] }, STUB_HERMES);
    const code = await runHermes(relaunch.slice(3), deps);
    expect(code).toBe(0);
    expect(deps.execs).toHaveLength(1);
    expect(deps.execs[0]?.argv).toEqual(gatewayArgv(STUB_HERMES, ["--verbose"]));
    expect(deps.execs[0]?.argv.slice(1, 3)).toEqual(["gateway", "run"]);
    const env = deps.execs[0]?.env ?? {};
    expect(env.HERMES_HOME).toBe(hermesHome);
    expect(Object.keys(env).filter((k) => k.startsWith("SUITE_") || k.startsWith("OPENCLAW_"))).toEqual([]);
    expect(scanEnv("gateway", env, parentCanary)).toEqual([]);
  });

  test("--gateway-only refuses a root with no passing stamp", async () => {
    const deps = makeDeps();
    const code = await runHermes(["--root", root, "--gateway-only", "--hermes", STUB_HERMES], deps);
    expect(code).toBe(2);
    expect(deps.execs).toEqual([]);
  });

  test("--stamp-only never starts a session: no gateway run, no tmux server under TMUX_TMPDIR", async () => {
    makeManagedPython();
    const r = Bun.spawn(["bun", HERMES_FIXTURE, ...stampArgs(), "--stamp-only"], {
      env: { ...baseEnv(), HERMES_FIXTURE_REPO: channelRepo, HERMES_FIXTURE_REF: channelRef },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await r.exited).toBe(0);
    const verbs = stubCalls().map((c) => c.argv.slice(0, 2).join(" "));
    expect(verbs).toContain("config check");
    expect(verbs).not.toContain("gateway run");
    expect(readdirSync(join(home, "tmux"))).toEqual([]);
  });
});

describe("--stamp-only as a subprocess: the machine contract", () => {
  async function run(args: string[]) {
    const proc = Bun.spawn(["bun", HERMES_FIXTURE, ...args], {
      env: { ...baseEnv(), HERMES_FIXTURE_REPO: channelRepo, HERMES_FIXTURE_REF: channelRef },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr: err, code, doc: JSON.parse(stdout) as StampResult };
  }

  test("stdout is exactly one JSON document; the human lines went to stderr", async () => {
    makeManagedPython();
    const r = await run([...stampArgs(), "--stamp-only"]);
    expect(r.code).toBe(0);
    expect(r.doc.contract_version).toBe(1);
    expect(r.doc.ok).toBe(true);
    expect(r.doc.harness).toBe("hermes");
    expect(r.doc.token_ref).toBe(`file:${tokenPath}`);
    expect(r.stdout.trimEnd().endsWith("}")).toBe(true);
    expect(r.stderr).toContain("suite: ");
    const step = r.doc.human_steps.find((s) => s.kind === "start_agent_session");
    expect(step?.text).not.toContain("--stamp-only");
    expect(r.doc.actions.find((a) => a.kind === "plugin_checkout")?.target.endsWith(`@${channelRef}`)).toBe(true);
    expect(scanTexts({ stdout: r.stdout, stderr: r.stderr }, token)).toEqual([]);
  });

  test("a literal --token is refused with exit 2 and a JSON error, and is echoed nowhere", async () => {
    const literal = canary("literal");
    const r = await run(["--root", root, "--stamp-only", "--token", literal]);
    expect(r.code).toBe(2);
    expect(r.doc.error?.code).toBe("literal_token_refused");
    expect(scanTexts({ stdout: r.stdout, stderr: r.stderr }, literal)).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });
});

describe("pins", () => {
  test("the channel is pinned to the stage-6 launcher-fix commit, pending the deployer's bump to the squash sha", () => {
    expect(HERMES_CHANNEL_REF).toBe("61e8b603c379cf18e3f7b83562fb51d13c26a979");
  });

  test("the pin's DEPLOYER comment is present, so the bump is not forgotten at merge", () => {
    const src = readFileSync(resolve(import.meta.dir, "..", "src", "commands", "hermes.ts"), "utf8");
    const at = src.indexOf("export const HERMES_CHANNEL_REF");
    expect(src.slice(Math.max(0, at - 1200), at)).toContain("DEPLOYER: BUMP THIS BEFORE suite-cli MERGES.");
  });
});
