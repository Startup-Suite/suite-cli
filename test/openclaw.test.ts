import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { emptyConfig, serializeConfig } from "../src/config.ts";
import {
  FIRST_STAMP_PORT,
  LIVE_GATEWAY_PORT,
  MODEL_KEY_ENV,
  OPENCLAW_CHANNEL_REF,
  OPENCLAW_GATEWAY_COMM,
  OPENCLAW_PACKAGE,
  OPENCLAW_VERSION,
  PLUGIN_ID,
  channelCheckoutDir,
  configPathFor,
  gatewayArgv,
  managedOpenclawBin,
  mergedBindings,
  nodeMeetsFloor,
  normalizeAgentId,
  parseConfigGet,
  parseConfigValidate,
  parseOpenclawOptions,
  parseOpenclawVersion,
  parsePluginInspect,
  parsePluginsDoctor,
  probePortInUse,
  relaunchArgv,
  runOpenclaw,
  stampOpenclaw,
  stateDirFor,
  type OpenclawDeps,
} from "../src/commands/openclaw.ts";
import { renderStampResult, StampFailure, type StampResult } from "../src/stamp_result.ts";
import { classify, parseProcesses, type TmuxDeps } from "../src/tmux.ts";
import type { RestoreDeps } from "../src/commands/restore.ts";
import { parseRoster } from "../src/roster.ts";
import { canary, scanEnv, scanText, scanTexts, scanTree } from "./leak-scan.ts";

/**
 * `suite openclaw`, against a stub `openclaw` and a stub `npm` that record
 * every argv and environment they receive. Nothing here runs a real OpenClaw,
 * touches ~/.openclaw, talks to a network, or reaches systemd.
 */
const STUB_DIR = resolve(import.meta.dir, "fixtures", "stub_openclaw");
const STUB_OPENCLAW = join(STUB_DIR, "openclaw");
const STUB_CHANNEL = resolve(import.meta.dir, "fixtures", "stub_openclaw_channel");
const OPENCLAW_FIXTURE = resolve(import.meta.dir, "fixtures", "openclaw-fixture.ts");
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
  shared = mkdtempSync(join(tmpdir(), `suite-openclaw-01a0d8f8-shared-${process.pid}-`));
  channelRepo = join(shared, "channel-repo");
  cpSync(STUB_CHANNEL, channelRepo, { recursive: true });
  sh(["git", "init", "-q", "-b", "main"], channelRepo);
  sh(["git", "add", "."], channelRepo);
  sh(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "stub"], channelRepo);
  channelRef = sh(["git", "rev-parse", "HEAD"], channelRepo);
});
afterAll(() => rmSync(shared, { recursive: true, force: true }));

let dir: string;
let home: string;
let root: string;
let bin: string;
let tokenPath: string;
let token: string;
/** Planted in the PARENT env under names a child must never inherit. */
let parentCanary: string;
let stderr: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), `suite-openclaw-01a0d8f8-${process.pid}-`));
  home = join(dir, "home");
  bin = join(dir, "bin");
  mkdirSync(join(home, "tmux"), { recursive: true });
  mkdirSync(bin);
  root = join(dir, "roots", "openclaw-01a0d8f8");
  tokenPath = join(dir, "runtime.token");
  token = canary("tok");
  parentCanary = canary("parent");
  writeFileSync(tokenPath, token);
  chmodSync(tokenPath, 0o600);
  writeFileSync(join(home, "stub-openclaw-path"), STUB_OPENCLAW);
  stderr = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${bin}:${STUB_DIR}:${BUN_DIR}:/usr/bin:/bin`,
    HOME: home,
    LANG: "C.UTF-8",
    TMUX_TMPDIR: join(home, "tmux"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    // None of these may reach any child.
    SUITE_RUNTIME_TOKEN: parentCanary,
    SUITE_URL: `https://${parentCanary}.example.invalid`,
    OPENCLAW_STATE_DIR: join(home, ".openclaw"),
    OPENCLAW_CONFIG_PATH: join(home, ".openclaw", "openclaw.json"),
    OPENCLAW_GATEWAY_TOKEN: parentCanary,
    OPENCLAW_PROFILE: parentCanary,
    // systemd supervisor hints: OpenClaw's gateway treats these as "a service manager owns me".
    INVOCATION_ID: parentCanary,
    JOURNAL_STREAM: parentCanary,
    ...extra,
  };
}

interface FakeTmux {
  deps: TmuxDeps;
  ran: string[][];
}

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

type Deps = OpenclawDeps & { execs: { argv: string[]; env: Record<string, string> }[]; probed: number[] };

function makeDeps(overrides: Partial<OpenclawDeps> = {}, env: Record<string, string> = baseEnv(), busy: number[] = []): Deps {
  const execs: { argv: string[]; env: Record<string, string> }[] = [];
  const probed: number[] = [];
  return {
    env,
    which: (b) => Bun.which(b, { PATH: env.PATH ?? "" }),
    stderr: (t) => void stderr.push(t),
    channelRepo,
    channelRef,
    portInUse: async (p) => {
      probed.push(p);
      return busy.includes(p);
    },
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
    probed,
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
    "openclaw-01a0d8f8-rt",
    "--token-ref",
    `file:${tokenPath}`,
    "--model-base-url",
    "http://wave.example.invalid:8000/v1",
    "--model",
    "wave-model",
    "--openclaw",
    STUB_OPENCLAW,
    ...extra,
  ];
}

interface StubCall {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
}

function stubCalls(): StubCall[] {
  const p = join(home, "openclaw-stub.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as StubCall);
}

function npmCalls(): string[][] {
  const p = join(home, "npm-calls");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => Buffer.from(l, "base64").toString("utf8").split("\0").slice(0, -1));
}

/** The calls that WRITE: onboard, config set, plugins install. */
function writes(calls: StubCall[]): StubCall[] {
  return calls.filter(
    (c) => c.argv[0] === "onboard" || (c.argv[0] === "config" && c.argv[1] === "set") || (c.argv[0] === "plugins" && c.argv[1] === "install"),
  );
}

async function stamp(args: string[] = stampArgs(), deps: OpenclawDeps = makeDeps()) {
  return await stampOpenclaw(args, deps, { stdout: () => {}, stderr: (t) => void stderr.push(t) });
}

function config(): Record<string, any> {
  return JSON.parse(readFileSync(configPathFor(root), "utf8"));
}

function outcomes(result: StampResult): Record<string, string> {
  return Object.fromEntries(result.actions.map((a) => [`${a.kind} ${a.target}`, a.outcome]));
}

/* ------------------------------------------------------------------------- */

describe("measured OpenClaw output shapes (2026.9.4)", () => {
  test("--version", () => {
    expect(parseOpenclawVersion("OpenClaw 2026.9.4 (3a9d69d)\n")).toBe("2026.9.4");
    expect(parseOpenclawVersion("")).toBe("unknown");
  });

  test("config get: a value, unset and unknown are absent, invalid throws", () => {
    expect(parseConfigGet("gateway.port", 0, "18801\n", "")).toEqual({ present: true, value: 18801 });
    const unset = JSON.stringify({ ok: false, error: { type: "cli_error", message: "Config path is valid but unset: bindings. The runtime default applies ..." } });
    expect(parseConfigGet("bindings", 1, unset, "")).toEqual({ present: false });
    const unknown = JSON.stringify({ ok: false, error: { type: "cli_error", message: "Unknown config path: channels.startup-suite. Run openclaw config schema ..." } });
    expect(parseConfigGet("channels.startup-suite", 1, unknown, "")).toEqual({ present: false });
    const invalid = JSON.stringify({
      ok: false,
      error: { type: "cli_error", message: "OpenClaw config is invalid: /x/openclaw.json" },
      issues: [{ path: "bindings.0.agentId", message: 'Unknown agent id "x" (not in agents.entries).' }],
    });
    expect(() => parseConfigGet("gateway", 1, invalid, "")).toThrow(StampFailure);
    expect(() => parseConfigGet("gateway", 0, "not json", "")).toThrow(/printed no JSON/);
  });

  test("config validate", () => {
    expect(parseConfigValidate(0, '{"valid":true,"path":"/x","warnings":[]}', "").verdict).toBe("pass");
    const bad = JSON.stringify({ ok: false, error: { message: "OpenClaw config is invalid: /x" }, valid: false, path: "/x", issues: [{ path: "a.b", message: "nope" }] });
    expect(parseConfigValidate(1, bad, "")).toMatchObject({ verdict: "fail", raw: "a.b: nope" });
    expect(parseConfigValidate(0, "Config OK", "")).toMatchObject({ verdict: "unparseable", raw: "Config OK" });
  });

  test("plugins doctor", () => {
    const clean = '{"ok":true,"pluginErrors":[],"diagnostics":[],"sourceShadowing":[],"compatibility":[],"configurationWarnings":[]}';
    expect(parsePluginsDoctor(0, clean, "").verdict).toBe("pass");
    const ours = JSON.stringify({ ok: false, pluginErrors: [{ pluginId: PLUGIN_ID, message: "x" }], diagnostics: [] });
    expect(parsePluginsDoctor(0, ours, "").verdict).toBe("fail");
    // Another plugin's diagnostic is not ours.
    const other = JSON.stringify({ ok: true, pluginErrors: [], diagnostics: [{ pluginId: "telegram", message: "x" }] });
    expect(parsePluginsDoctor(0, other, "").verdict).toBe("pass");
    expect(parsePluginsDoctor(0, "fine", "").verdict).toBe("unparseable");
  });

  test("plugins inspect", () => {
    const notFound = JSON.stringify({ ok: false, error: { message: `Plugin not found: ${PLUGIN_ID}.` } });
    expect(parsePluginInspect(1, notFound, "")).toMatchObject({ verdict: "fail" });
    expect(parsePluginInspect(0, JSON.stringify({ plugin: { id: PLUGIN_ID, status: "loaded", enabled: true } }), "").verdict).toBe("pass");
    expect(parsePluginInspect(0, JSON.stringify({ plugin: { id: PLUGIN_ID, status: "loaded", enabled: false } }), "").verdict).toBe("fail");
    expect(parsePluginInspect(0, JSON.stringify({ plugin: { id: PLUGIN_ID, status: "error", error: "boom" } }), "")).toMatchObject({
      verdict: "fail",
      raw: "status error: boom",
    });
    expect(parsePluginInspect(0, "Status: loaded", "").verdict).toBe("unparseable");
  });

  test("the node floor of openclaw@2026.9.4 (>=24.16.0 <25 || >=26.1.0)", () => {
    expect(nodeMeetsFloor("v24.21.0")).toBe(true);
    expect(nodeMeetsFloor("v24.16.0")).toBe(true);
    expect(nodeMeetsFloor("v24.15.9")).toBe(false);
    expect(nodeMeetsFloor("v25.3.0")).toBe(false);
    expect(nodeMeetsFloor("v26.0.0")).toBe(false);
    expect(nodeMeetsFloor("v26.1.0")).toBe(true);
    expect(nodeMeetsFloor("v27.0.0")).toBe(true);
    expect(nodeMeetsFloor("v22.12.0")).toBe(false);
    expect(nodeMeetsFloor("garbage")).toBe(false);
  });

  test("agent ids normalise the way OpenClaw's do", () => {
    expect(normalizeAgentId("OpenClaw-01a0d8f8")).toBe("openclaw-01a0d8f8");
    expect(normalizeAgentId("my agent.x")).toBe("my-agent-x");
    expect(normalizeAgentId("...")).toBeNull();
  });
});

describe("a first stamp", () => {
  test("stamps from nothing through onboard --non-interactive, with every child scoped to the root", async () => {
    const { result, exitCode } = await stamp();
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.harness).toBe("openclaw");
    expect(result.harness_version).toBe(OPENCLAW_VERSION);
    expect(result.warnings).toEqual([]);
    expect(result.validation.verdict).toBe("pass");
    expect(result.validation.checks.map((c) => c.command)).toEqual([
      "openclaw config validate --json",
      "openclaw plugins doctor --json",
      `openclaw plugins inspect ${PLUGIN_ID} --json`,
    ]);

    const calls = stubCalls();
    expect(calls.length).toBeGreaterThan(5);
    for (const c of calls) {
      expect(c.env.OPENCLAW_STATE_DIR).toBe(stateDirFor(root));
      expect(c.env.OPENCLAW_CONFIG_PATH).toBe(configPathFor(root));
      expect(c.env.OPENCLAW_HOME).toBe(root);
      // Nothing inherited: not the operator's OpenClaw, not Suite, not systemd's hints.
      expect(Object.keys(c.env).filter((k) => /^OPENCLAW_/.test(k)).sort()).toEqual(["OPENCLAW_CONFIG_PATH", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
      expect(Object.keys(c.env).filter((k) => k.startsWith("SUITE_") || k === "INVOCATION_ID" || k === "JOURNAL_STREAM")).toEqual([]);
      expect(scanEnv("child", c.env, parentCanary)).toEqual([]);
    }
    // Positive control for the scan above: the canary IS in the parent env.
    expect(scanEnv("parent", baseEnv(), parentCanary).length).toBeGreaterThan(0);
  });

  test("onboard runs once, non-interactive, with the verified flags, stdin /dev/null, and no daemon", async () => {
    await stamp();
    const onboards = stubCalls().filter((c) => c.argv[0] === "onboard");
    expect(onboards).toHaveLength(1);
    const o = onboards[0] as StubCall;
    expect(o.stdin).toBe("devnull");
    expect(o.argv).toEqual([
      "onboard",
      "--non-interactive",
      "--accept-risk",
      "--mode",
      "local",
      "--auth-choice",
      "custom-api-key",
      "--custom-base-url",
      "http://wave.example.invalid:8000/v1",
      "--custom-model-id",
      "wave-model",
      "--custom-compatibility",
      "openai",
      "--secret-input-mode",
      "ref",
      "--gateway-bind",
      "loopback",
      "--gateway-port",
      String(FIRST_STAMP_PORT),
      "--workspace",
      join(stateDirFor(root), "workspace"),
      "--agent-name",
      "openclaw-01a0d8f8",
      "--skip-daemon",
      "--skip-health",
      "--skip-channels",
      "--skip-skills",
      "--skip-bootstrap",
      "--json",
    ]);
    expect(o.argv).not.toContain("--install-daemon");
    expect(o.argv).not.toContain("--classic");
  });

  test("no daemon, service or wizard command is ever issued", async () => {
    await stamp();
    await runOpenclaw(stampArgs(), makeDeps());
    const all = [...stubCalls().map((c) => c.argv), ...npmCalls()];
    for (const argv of all) {
      const line = argv.join(" ");
      expect(line).not.toMatch(/\bgateway (install|start|restart|stop|uninstall)\b/);
      expect(line).not.toContain("--install-daemon");
      expect(line).not.toMatch(/systemctl|launchctl/);
      expect(argv[0]).not.toBe("configure");
      expect(argv[0]).not.toBe("setup");
      if (argv[0] === "onboard") expect(argv).toContain("--non-interactive");
    }
  });

  test("the account, binding and plugin entries mirror install.sh's shape, and the token is the REF string", async () => {
    await stamp();
    const c = config();
    const ch = c.channels["startup-suite"];
    expect(ch.enabled).toBe(true);
    expect(ch.dmPolicy).toBe("allowlist");
    expect(ch.allowFrom).toEqual(["*"]);
    expect(ch.accounts["openclaw-01a0d8f8"]).toEqual({
      url: "wss://suite.example.invalid/runtime/ws",
      runtimeId: "openclaw-01a0d8f8-rt",
      token: `file:${tokenPath}`,
      autoJoinSpaces: [],
    });
    expect(c.bindings).toEqual([
      { type: "route", agentId: "openclaw-01a0d8f8", match: { channel: "startup-suite", accountId: "openclaw-01a0d8f8" } },
    ]);
    expect(c.plugins.allow).toEqual([PLUGIN_ID]);
    expect(c.plugins.entries[PLUGIN_ID].enabled).toBe(true);
    expect(c.gateway.port).toBe(FIRST_STAMP_PORT);
  });

  test("the plugin is linked, not copied: a copy of a TS entry with no dist is refused by OpenClaw", async () => {
    await stamp();
    const installs = stubCalls().filter((c) => c.argv[0] === "plugins" && c.argv[1] === "install");
    expect(installs).toHaveLength(1);
    const argv = installs[0]?.argv ?? [];
    expect(argv).toEqual(["plugins", "install", "--link", channelCheckoutDir(baseEnv()), "--force", "--accept-capabilities"]);
    expect(config().plugins.load.paths).toEqual([channelCheckoutDir(baseEnv())]);
    // The plugin's deps came from its lockfile, in the checkout, before the link.
    expect(npmCalls()).toEqual([["ci", "--no-audit", "--no-fund"]]);
    // Positive control for the stub rule the --link choice answers.
    const copy = Bun.spawnSync([STUB_OPENCLAW, "plugins", "install", channelCheckoutDir(baseEnv()), "--force", "--accept-capabilities"], {
      env: { ...baseEnv(), OPENCLAW_CONFIG_PATH: configPathFor(root) },
      stdin: "ignore",
      stderr: "pipe",
    });
    expect(copy.exitCode).toBe(1);
    expect(copy.stderr.toString()).toContain("missing compiled runtime entry");
  });

  test("the checkout is pinned to the channel ref", async () => {
    const { result } = await stamp();
    const head = sh(["git", "-C", channelCheckoutDir(baseEnv()), "rev-parse", "HEAD"]);
    expect(head).toBe(channelRef);
    expect(result.actions.find((a) => a.kind === "plugin_checkout")?.target).toBe(`${channelCheckoutDir(baseEnv())}@${channelRef}`);
  });

  test("a keychain ref is written as the ref plus tokenKeychainService, and the keychain is never read", async () => {
    const security = join(bin, "security");
    writeFileSync(security, `#!/usr/bin/env bash\ntouch ${JSON.stringify(join(home, "security-ran"))}\nprintf '%s\\n' ${JSON.stringify(token)}\n`);
    chmodSync(security, 0o755);
    const args = stampArgs();
    args.splice(args.indexOf("--token-ref"), 2, "--token-ref", "keychain:RUNTIME_TOKEN.openclaw", "--keychain-service", "suite-test");
    const { result, exitCode } = await stamp(args, makeDeps({ resolve: { platform: "darwin", securityBin: security } }));
    expect(exitCode).toBe(0);
    expect(result.token_ref).toBe("keychain:RUNTIME_TOKEN.openclaw");
    const acct = config().channels["startup-suite"].accounts["openclaw-01a0d8f8"];
    expect(acct.token).toBe("keychain:RUNTIME_TOKEN.openclaw");
    expect(acct.tokenKeychainService).toBe("suite-test");
    expect(existsSync(join(home, "security-ran"))).toBe(false);
  });
});

describe("no secret leaks", () => {
  test("the runtime token and the model key appear in no argv, env, JSON, stderr or root file", async () => {
    const key = canary("modelkey");
    const keyPath = join(dir, "model.key");
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o600);
    const args = [...stampArgs(), "--model-api-key-ref", `file:${keyPath}`];
    const { result, exitCode } = await stamp(args);
    expect(exitCode).toBe(0);
    // The key reached onboarding through CUSTOM_API_KEY only.
    const onboard = stubCalls().find((c) => c.argv[0] === "onboard");
    expect(onboard?.env[MODEL_KEY_ENV]).toBe(key);
    expect(result.warnings.filter((w) => w.includes(MODEL_KEY_ENV))).toHaveLength(1);

    const text = renderStampResult(result);
    for (const secret of [token, key]) {
      const hits = [
        ...stubCalls().flatMap((c, i) => [
          ...scanText(`argv ${i}`, c.argv.join("\0"), secret),
          ...(c.argv[0] === "onboard" && secret === key ? [] : scanEnv(`env ${i}`, c.env, secret)),
        ]),
        ...npmCalls().flatMap((a, i) => scanText(`npm ${i}`, a.join("\0"), secret)),
        ...scanTexts({ json: text, stderr: stderr.join("") }, secret),
        ...scanTree(root, secret),
      ];
      expect(hits).toEqual([]);
    }
    // Positive control: the scanner finds a planted copy under the root.
    writeFileSync(join(root, "planted"), `x${token}x`);
    expect(scanTree(root, token).length).toBe(1);
  });
});

describe("idempotence and repair", () => {
  test("a second identical run is changed:false with zero writes", async () => {
    await stamp();
    const before = stubCalls().length;
    const npmBefore = npmCalls().length;
    const cfgBefore = readFileSync(configPathFor(root), "utf8");
    const { result, exitCode } = await stamp();
    expect(exitCode).toBe(0);
    expect(result.changed).toBe(false);
    expect(result.actions.filter((a) => a.outcome !== "unchanged")).toEqual([]);
    expect(writes(stubCalls().slice(before))).toEqual([]);
    expect(npmCalls().length).toBe(npmBefore);
    expect(readFileSync(configPathFor(root), "utf8")).toBe(cfgBefore);
  });

  test("a re-run reuses the configured port and probes nothing", async () => {
    await stamp();
    const deps = makeDeps({}, baseEnv(), [FIRST_STAMP_PORT]);
    const { result, exitCode } = await stamp(stampArgs(), deps);
    expect(exitCode).toBe(0);
    expect(deps.probed).toEqual([]);
    expect(config().gateway.port).toBe(FIRST_STAMP_PORT);
    expect(outcomes(result)[`gateway_port gateway.port=${FIRST_STAMP_PORT}`]).toBe("unchanged");
  });

  test("a deleted binding is repaired, and only it", async () => {
    await stamp();
    const c = config();
    c.bindings = [];
    writeFileSync(configPathFor(root), JSON.stringify(c, null, 2));
    const before = stubCalls().length;
    const { result, exitCode } = await stamp();
    expect(exitCode).toBe(0);
    expect(result.changed).toBe(true);
    expect(result.actions.filter((a) => a.outcome !== "unchanged").map((a) => [a.kind, a.target, a.outcome])).toEqual([
      ["config_set", "bindings", "repaired"],
    ]);
    expect(writes(stubCalls().slice(before)).map((w) => w.argv.slice(0, 3))).toEqual([["config", "set", "bindings"]]);
    expect(config().bindings).toHaveLength(1);
  });

  test("an edited runtimeId is repaired, keeping keys this verb does not own", async () => {
    await stamp();
    const c = config();
    c.channels["startup-suite"].accounts["openclaw-01a0d8f8"].runtimeId = "someone-else";
    c.channels["startup-suite"].accounts["openclaw-01a0d8f8"].reconnectIntervalMs = 7000;
    writeFileSync(configPathFor(root), JSON.stringify(c, null, 2));
    const { result } = await stamp();
    expect(outcomes(result)["config_set channels.startup-suite.accounts.openclaw-01a0d8f8"]).toBe("repaired");
    const acct = config().channels["startup-suite"].accounts["openclaw-01a0d8f8"];
    expect(acct.runtimeId).toBe("openclaw-01a0d8f8-rt");
    expect(acct.reconnectIntervalMs).toBe(7000);
  });

  test("duplicate routes collapse to exactly one; other bindings are kept in place", () => {
    const other = { type: "route", agentId: "x", match: { channel: "telegram", accountId: "x" } };
    const ours = { type: "route", agentId: "old", match: { channel: "startup-suite", accountId: "a" } };
    expect(mergedBindings([other, ours, ours], "a")).toEqual([
      other,
      { type: "route", agentId: "a", match: { channel: "startup-suite", accountId: "a" } },
    ]);
  });

  test("a token file whose mode was loosened is refused (exit 2), not chmodded, and nothing is written", async () => {
    await stamp();
    const before = stubCalls().length;
    const cfgBefore = readFileSync(configPathFor(root), "utf8");
    chmodSync(tokenPath, 0o644);
    const { result, exitCode } = await stamp();
    expect(exitCode).toBe(2);
    expect(result.error?.message).toContain(tokenPath);
    expect(result.error?.message).toContain("0644");
    expect((Bun.spawnSync(["stat", "-c", "%a", tokenPath]).stdout.toString() ?? "").trim()).toBe("644");
    expect(stubCalls().slice(before)).toEqual([]);
    expect(readFileSync(configPathFor(root), "utf8")).toBe(cfgBefore);
  });
});

describe("ports", () => {
  test("with no flag, the first free port of 18800 or above is chosen, never 18789", async () => {
    const deps = makeDeps({}, baseEnv(), [FIRST_STAMP_PORT, FIRST_STAMP_PORT + 1]);
    const { exitCode } = await stamp(stampArgs(), deps);
    expect(exitCode).toBe(0);
    expect(config().gateway.port).toBe(FIRST_STAMP_PORT + 2);
    expect(deps.probed).toEqual([FIRST_STAMP_PORT, FIRST_STAMP_PORT + 1, FIRST_STAMP_PORT + 2]);
    expect(deps.probed).not.toContain(LIVE_GATEWAY_PORT);
  });

  test("an explicit port that a listener holds is refused with exit 2, before anything is written", async () => {
    let server: Server | null = null;
    let port = 0;
    for (let p = 19400; p < 19500 && server === null; p++) {
      if (await probePortInUse(p)) continue;
      const s = createServer();
      await new Promise<void>((ok) => s.listen(p, "127.0.0.1", ok));
      server = s;
      port = p;
    }
    try {
      expect(await probePortInUse(port)).toBe(true);
      const deps = makeDeps({ portInUse: probePortInUse });
      const { result, exitCode } = await stamp([...stampArgs(), "--gateway-port", String(port)], deps);
      expect(exitCode).toBe(2);
      expect(result.error?.code).toBe("port_in_use");
      expect(result.error?.message).toContain(String(port));
      expect(writes(stubCalls())).toEqual([]);
      expect(existsSync(stateDirFor(root))).toBe(false);
    } finally {
      await new Promise<void>((ok) => (server as Server).close(() => ok()));
    }
    // Positive control: freed, the same port is accepted.
    expect(await probePortInUse(port)).toBe(false);
    const again = await stamp([...stampArgs(), "--gateway-port", String(port)], makeDeps({ portInUse: probePortInUse }));
    expect(again.exitCode).toBe(0);
    expect(config().gateway.port).toBe(port);
  });

  test("gateway args that would kill a listener or move the port are refused", async () => {
    for (const bad of ["--force", "--port", "--port=18789", "--dev", "--reset", "--token"]) {
      const { exitCode, result } = await stamp([...stampArgs(), "--", bad]);
      expect(exitCode).toBe(2);
      expect(result.error?.code).toBe("gateway_arg_refused");
    }
  });
});

describe("refusals and failures", () => {
  test("operator headers are refused with exit 2 before any harness call", async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "suite.json"), serializeConfig({ ...emptyConfig(), headerNames: ["X-Example-Id"] }));
    const { result, exitCode } = await stamp();
    expect(exitCode).toBe(2);
    expect(result.error?.code).toBe("headers_unsupported");
    expect(stubCalls()).toEqual([]);
  });

  test("no openclaw and no --install-openclaw: exit 2 naming the flag, nothing written", async () => {
    const env = baseEnv({ PATH: `${bin}:${BUN_DIR}:/usr/bin:/bin`.replace(/:\/usr\/bin/, "") });
    const args = stampArgs().filter((a, i, all) => a !== "--openclaw" && all[i - 1] !== "--openclaw");
    const deps = makeDeps({ which: (b) => (b === "openclaw" ? null : Bun.which(b, { PATH: env.PATH ?? "" })) }, env);
    const { result, exitCode } = await stamp(args, deps);
    expect(exitCode).toBe(2);
    expect(result.error?.code).toBe("harness_absent");
    expect(result.error?.message).toContain("--install-openclaw");
    expect(existsSync(root)).toBe(false);
  });

  test("--install-openclaw installs the pinned package into the data dir, and a re-run does not install again", async () => {
    const args = stampArgs().filter((a, i, all) => a !== "--openclaw" && all[i - 1] !== "--openclaw");
    const which = (b: string) => (b === "openclaw" ? null : Bun.which(b, { PATH: baseEnv().PATH ?? "" }));
    const { result, exitCode } = await stamp([...args, "--install-openclaw"], makeDeps({ which }));
    expect(exitCode).toBe(0);
    const installs = npmCalls().filter((a) => a[0] === "install");
    expect(installs).toHaveLength(1);
    expect(installs[0]?.slice(-1)).toEqual([OPENCLAW_PACKAGE]);
    expect(installs[0]).toContain("--prefix");
    expect(existsSync(managedOpenclawBin(baseEnv()))).toBe(true);
    expect(result.actions.map((a) => a.kind)).toContain("harness_install");

    const again = await stamp([...args, "--install-openclaw"], makeDeps({ which }));
    expect(again.exitCode).toBe(0);
    expect(again.result.changed).toBe(false);
    expect(npmCalls().filter((a) => a[0] === "install")).toHaveLength(1);
  });

  test("--install-openclaw refuses a node below the floor, naming it", async () => {
    writeFileSync(join(bin, "node"), "#!/usr/bin/env bash\necho v22.12.0\n");
    chmodSync(join(bin, "node"), 0o755);
    const args = stampArgs().filter((a, i, all) => a !== "--openclaw" && all[i - 1] !== "--openclaw");
    const which = (b: string) => (b === "openclaw" ? null : Bun.which(b, { PATH: baseEnv().PATH ?? "" }));
    const { result, exitCode } = await stamp([...args, "--install-openclaw"], makeDeps({ which }));
    expect(exitCode).toBe(2);
    expect(result.error?.code).toBe("node_too_old");
    expect(result.error?.message).toContain(">=24.16.0 <25 || >=26.1.0");
    expect(npmCalls()).toEqual([]);
  });

  test("an unparseable `config validate` is exit 1, carrying the raw line", async () => {
    writeFileSync(join(home, "openclaw-stub-knobs.json"), JSON.stringify({ validate: "garbage" }));
    const { result, exitCode } = await stamp();
    expect(exitCode).toBe(1);
    expect(result.validation.verdict).toBe("unparseable");
    expect(result.validation.checks[0]).toMatchObject({ verdict: "unparseable", raw: "Config looks fine I guess" });
  });

  test("a plugin that fails to load fails the check (exit 1)", async () => {
    writeFileSync(join(home, "openclaw-stub-knobs.json"), JSON.stringify({ inspect: "error" }));
    const { result, exitCode } = await stamp();
    expect(exitCode).toBe(1);
    expect(result.validation.verdict).toBe("fail");
    expect(result.human_steps).toEqual([]);
  });

  test("a failed onboard is exit 1 and leaves no account", async () => {
    writeFileSync(join(home, "openclaw-stub-knobs.json"), JSON.stringify({ onboard: "fail" }));
    const { result, exitCode } = await stamp();
    expect(exitCode).toBe(1);
    expect(result.error?.code).toBe("onboard_failed");
    expect(stubCalls().some((c) => c.argv[0] === "config" && c.argv[1] === "set")).toBe(false);
  });

  test("an unmeasured OpenClaw version is one warning, not a failure", async () => {
    writeFileSync(join(home, "openclaw-stub-knobs.json"), JSON.stringify({ version: "OpenClaw 2026.12.1 (abcdef0)" }));
    const { result, exitCode } = await stamp();
    expect(exitCode).toBe(0);
    expect(result.warnings).toEqual(["config shape unverified for openclaw 2026.12.1"]);
  });
});

describe("the gateway session", () => {
  test("detectState pins the gateway's process name: an openclaw-gateway descendant is live, a bare shell or a CLI call is stale", () => {
    expect(OPENCLAW_GATEWAY_COMM).toBe("openclaw-gateway");
    const panes = [{ session: "suite-openclaw-01a0d8f8", pid: 100, command: "bash" }];
    // After process.title = "openclaw-gateway": args overwritten, comm truncated to 15 bytes.
    const live = parseProcesses(
      "  100     1 bash    bash\n  101   100 bun     /opt/bun /opt/cli.ts openclaw --gateway-only\n  102   101 openclaw-gatewa openclaw-gateway\n",
    );
    expect(classify(panes, live, "suite-openclaw-01a0d8f8", OPENCLAW_GATEWAY_COMM)).toBe("live");
    const cli = parseProcesses("  100     1 bash    bash\n  102   100 openclaw openclaw\n");
    expect(classify(panes, cli, "suite-openclaw-01a0d8f8", OPENCLAW_GATEWAY_COMM)).toBe("stale");
    const dead = parseProcesses("  100     1 bash    bash\n");
    expect(classify(panes, dead, "suite-openclaw-01a0d8f8", OPENCLAW_GATEWAY_COMM)).toBe("stale");
  });

  test("a fresh run creates suite-<name> running the --gateway-only relaunch, with no token anywhere, and records it", async () => {
    const tmux = fakeTmux();
    const written: Record<string, string> = {};
    const restore: RestoreDeps = {
      tmux: tmux.deps,
      readRoster: (p) => written[p] ?? null,
      writeRoster: (p, c) => void (written[p] = c),
      now: () => new Date("2026-09-25T00:00:00Z"),
      log: () => {},
    };
    const code = await runOpenclaw(stampArgs(), makeDeps({ tmux: tmux.deps, restore }));
    expect(code).toBe(0);
    const created = tmux.ran.filter((a) => a[1] === "new-session");
    expect(created).toHaveLength(1);
    const create = created[0] ?? [];
    expect(create.slice(0, 5)).toEqual(["tmux", "new-session", "-d", "-s", "suite-openclaw-01a0d8f8"]);
    expect(create).toContain("--gateway-only");
    expect(create).toContain("--no-session");
    expect(create).toContain(String(FIRST_STAMP_PORT));
    expect(create.join(" ").includes(token)).toBe(false);
    expect(create.some((a) => /^(start|restart|install)$/.test(a))).toBe(false);
    const roster = parseRoster(Object.values(written)[0] ?? "");
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ kind: "openclaw", session: "suite-openclaw-01a0d8f8", cwd: root });
  });

  test("a live session is attached to, never duplicated", async () => {
    const session = "suite-openclaw-01a0d8f8";
    const tmux = fakeTmux(`${session}\t100\tbash\n`, "  100     1 bash    bash\n  102   100 openclaw-gatewa openclaw-gateway\n");
    const code = await runOpenclaw(stampArgs(), makeDeps({ tmux: tmux.deps }));
    expect(code).toBe(0);
    expect(tmux.ran.filter((a) => a[1] === "new-session")).toEqual([]);
    expect(stderr.join("")).toContain(`attaching to ${session}`);
  });

  test("--gateway-only execs `gateway run --port N` with the root-scoped allowlisted env and no Suite credential", async () => {
    await stamp();
    const deps = makeDeps();
    const o = parseOpenclawOptions(stampArgs());
    const relaunch = relaunchArgv(["/opt/suite/bun", "/opt/suite/src/cli.ts"], { ...o, rest: ["--verbose"] }, STUB_OPENCLAW, FIRST_STAMP_PORT);
    const code = await runOpenclaw(relaunch.slice(3), deps);
    expect(code).toBe(0);
    expect(deps.execs).toHaveLength(1);
    expect(deps.execs[0]?.argv).toEqual(gatewayArgv(STUB_OPENCLAW, FIRST_STAMP_PORT, ["--verbose"]));
    expect(deps.execs[0]?.argv.slice(1, 3)).toEqual(["gateway", "run"]);
    const env = deps.execs[0]?.env ?? {};
    expect(env.OPENCLAW_STATE_DIR).toBe(stateDirFor(root));
    expect(env.OPENCLAW_CONFIG_PATH).toBe(configPathFor(root));
    expect(Object.keys(env).filter((k) => k.startsWith("SUITE_") || k === "INVOCATION_ID" || k === "JOURNAL_STREAM" || k === "OPENCLAW_GATEWAY_TOKEN")).toEqual([]);
    expect(scanEnv("gateway", env, parentCanary)).toEqual([]);
  });

  test("--gateway-only refuses to start a second gateway on a port already held", async () => {
    await stamp();
    const deps = makeDeps({}, baseEnv(), [FIRST_STAMP_PORT]);
    const o = parseOpenclawOptions(stampArgs());
    const code = await runOpenclaw(relaunchArgv([], o, STUB_OPENCLAW, FIRST_STAMP_PORT).slice(1), deps);
    expect(code).toBe(2);
    expect(deps.execs).toEqual([]);
  });

  test("--gateway-only refuses a root with no passing stamp", async () => {
    const deps = makeDeps();
    const code = await runOpenclaw(["--root", root, "--gateway-only", "--openclaw", STUB_OPENCLAW, "--gateway-port", "18800"], deps);
    expect(code).toBe(2);
    expect(deps.execs).toEqual([]);
  });

  test("with a model key, the gateway env carries CUSTOM_API_KEY and its argv does not", async () => {
    const key = canary("modelkey");
    const keyPath = join(dir, "model.key");
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o600);
    const deps = makeDeps();
    const code = await runOpenclaw([...stampArgs(), "--model-api-key-ref", `file:${keyPath}`, "--no-session"], deps);
    expect(code).toBe(0);
    expect(deps.execs[0]?.env[MODEL_KEY_ENV]).toBe(key);
    expect(scanText("argv", (deps.execs[0]?.argv ?? []).join("\0"), key)).toEqual([]);
  });
});

describe("--stamp-only as a subprocess: the machine contract", () => {
  async function run(args: string[]) {
    const proc = Bun.spawn(["bun", OPENCLAW_FIXTURE, ...args], {
      env: { ...baseEnv(), OPENCLAW_FIXTURE_REPO: channelRepo, OPENCLAW_FIXTURE_REF: channelRef },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr: err, code, doc: JSON.parse(stdout) as StampResult };
  }

  test("stdout is exactly one JSON document, no session starts, and the human step is the session command", async () => {
    const r = await run([...stampArgs(), "--stamp-only"]);
    expect(r.code).toBe(0);
    expect(r.doc.contract_version).toBe(1);
    expect(r.doc.ok).toBe(true);
    expect(r.doc.harness).toBe("openclaw");
    expect(r.doc.token_ref).toBe(`file:${tokenPath}`);
    expect(r.stdout.trimEnd().endsWith("}")).toBe(true);
    const step = r.doc.human_steps.find((s) => s.kind === "start_agent_session");
    expect(step?.text.startsWith("suite openclaw ")).toBe(true);
    expect(step?.text).not.toContain("--stamp-only");
    expect(stubCalls().some((c) => c.argv[0] === "gateway")).toBe(false);
    expect(readdirSync(join(home, "tmux"))).toEqual([]);
    const port = config().gateway.port as number;
    expect(port).toBeGreaterThanOrEqual(FIRST_STAMP_PORT);
    expect(scanTexts({ stdout: r.stdout, stderr: r.stderr }, token)).toEqual([]);
  });

  test("a literal --token is refused with exit 2 and a JSON error, and is echoed nowhere", async () => {
    const literal = canary("literal");
    for (const args of [
      ["--root", root, "--stamp-only", "--token", literal],
      ["--root", root, "--stamp-only", `--token=${literal}`],
    ]) {
      const r = await run(args);
      expect(r.code).toBe(2);
      expect(r.doc.error?.code).toBe("literal_token_refused");
      expect(scanTexts({ stdout: r.stdout, stderr: r.stderr }, literal)).toEqual([]);
    }
    expect(existsSync(root)).toBe(false);
  });
});

describe("pins", () => {
  test("the channel is pinned to the stage-2 resolver commit, pending the deployer's bump to the squash sha", () => {
    expect(OPENCLAW_CHANNEL_REF).toBe("b84cb6d976f567f412bbe9f6007ce5c864668f30");
    expect(readFileSync(resolve(import.meta.dir, "..", "src", "commands", "openclaw.ts"), "utf8")).toContain("DEPLOYER: BUMP THIS BEFORE suite-cli MERGES");
  });
  test("the OpenClaw pin", () => {
    expect(OPENCLAW_PACKAGE).toBe("openclaw@2026.9.4");
  });
});
