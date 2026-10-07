/**
 * `suite deepseek` end to end through `runDeepseek`, with the harness, tmux
 * and exec faked.
 *
 * Pins the three things that broke reaching a running agent from its folder:
 *
 *   A. the cwd was ignored: `cd ~/agents/oddjob && suite deepseek` fell back
 *      to the machine config and said "Run `suite init` first", although the
 *      folder carried its own suite.json and credentials
 *   B. the agent root's `.suite-state.json` `env` block was never read, so
 *      OPENROUTER_API_KEY (and DSH_MODEL, DSH_PERMISSION_MODE, ...) never
 *      reached dsh, and every turn failed with MISSING_CREDENTIAL
 *   C. from the folder, a LIVE session must be attached to and a STALE one
 *      recycled, the same three-way handling `suite claude` does
 *
 * Every value below is fake.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DeepseekDeps, runDeepseek } from "../src/commands/deepseek.ts";
import type { RunResult, TmuxDeps } from "../src/tmux.ts";
import type { Prompter } from "../src/secrets.ts";

const FAKE_TOKEN = "fake-runtime-token-0001";
const FAKE_OR_KEY = "fake-openrouter-key-0002";
const FAKE_GW_KEY = "fake-gateway-key-0003";
const SECRETS = [FAKE_TOKEN, FAKE_OR_KEY, FAKE_GW_KEY];

const SAVED = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TMUX", "DSH_PERMISSION_MODE", "OPENROUTER_API_KEY", "DSH_MODEL"];
let saved: Record<string, string | undefined> = {};
let base = "";
let root = "";

function writeAgent(dir: string, runtimeId: string, env: Record<string, string> | undefined): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "suite.json"),
    JSON.stringify({ suiteUrl: "https://suite.example.invalid", runtimeId, headerNames: [] }),
  );
  writeFileSync(
    join(dir, ".suite-state.json"),
    JSON.stringify({ token: FAKE_TOKEN, headers: {}, ...(env === undefined ? {} : { env }) }),
    { mode: 0o600 },
  );
}

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  base = mkdtempSync(join(tmpdir(), "suite-deepseek-run-"));
  // No machine config anywhere: the only way to succeed is the agent root.
  process.env.HOME = join(base, "home");
  process.env.XDG_CONFIG_HOME = join(base, "config");
  process.env.XDG_DATA_HOME = join(base, "data");
  for (const k of ["TMUX", "DSH_PERMISSION_MODE", "OPENROUTER_API_KEY", "DSH_MODEL"]) delete process.env[k];
  // A harness that "is installed" — runDeepseek only checks the bin exists.
  const bin = join(base, "data", "suite", "deepseek", "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "dsh"), "#!/bin/sh\n");
  root = join(base, "home", "agents", "oddjob");
  writeAgent(root, "oddjob-dsh", {
    OPENROUTER_API_KEY: FAKE_OR_KEY,
    KOBO_GATEWAY_KEY: FAKE_GW_KEY,
    DSH_PROVIDER: "openrouter",
    DSH_MODEL: "z-ai/fake-model",
    DSH_CONTEXT_WINDOW: "4096",
    DSH_PERMISSION_MODE: "danger-full-access",
  });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
});

interface Captured {
  stderr: string;
  execs: Array<{ argv: string[]; cwd: string; env: Record<string, string> }>;
  tmuxCalls: string[][];
}

function fakeTmux(state: "live" | "stale" | "none", calls: string[][]): TmuxDeps {
  return {
    env: {},
    which: (name) => (name === "tmux" ? "/usr/bin/tmux" : null),
    run: async (argv): Promise<RunResult> => {
      calls.push(argv);
      if (argv[1] === "list-panes") {
        if (state === "none") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 0, stdout: "suite-oddjob\t100\tbun\n", stderr: "" };
      }
      if (argv[0] === "ps") {
        const rows = ["100 1 bun bun cli.ts deepseek --root /x --no-session"];
        if (state === "live") rows.push("101 100 node node /h/node_modules/.bin/dsh --profile headless");
        return { exitCode: 0, stdout: `${rows.join("\n")}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

function deps(opts: { cwd: string; tty?: boolean; tmux?: "live" | "stale" | "none" }): { d: DeepseekDeps; c: Captured } {
  const c: Captured = { stderr: "", execs: [], tmuxCalls: [] };
  const d: DeepseekDeps = {
    which: () => null,
    isTTY: () => opts.tty ?? false,
    run: async () => 0,
    exec: async (argv, o) => {
      c.execs.push({ argv, cwd: o.cwd, env: o.env });
      return 0;
    },
    stderr: { write: (t) => void (c.stderr += t) },
    cwd: () => opts.cwd,
    ...(opts.tmux === undefined ? {} : { tmux: fakeTmux(opts.tmux, c.tmuxCalls) }),
  };
  return { d, c };
}

describe("A: the cwd is the agent root when it carries suite.json", () => {
  test("run from the agent folder with no --root and no machine config, it starts as that agent", async () => {
    const { d, c } = deps({ cwd: root });
    const code = await runDeepseek(["--no-session"], d);
    expect(c.stderr).not.toContain("suite init");
    expect(code).toBe(0);
    expect(c.execs).toHaveLength(1);
    expect(c.execs[0]?.cwd).toBe(root);
    expect(c.execs[0]?.env.SUITE_RUNTIME_ID).toBe("oddjob-dsh");
    expect(c.execs[0]?.env.DSH_HOME).toBe(join(root, ".dsh"));
  });

  test("--root still wins over a cwd that is a different agent", async () => {
    const other = join(base, "home", "agents", "other");
    writeAgent(other, "other-dsh", undefined);
    const { d, c } = deps({ cwd: other });
    expect(await runDeepseek(["--root", root, "--no-session"], d)).toBe(0);
    expect(c.execs[0]?.env.SUITE_RUNTIME_ID).toBe("oddjob-dsh");
  });

  test("an ancestor of an agent root is not that agent: machine-config fallback, named", async () => {
    const { d, c } = deps({ cwd: join(base, "home", "agents") });
    expect(await runDeepseek(["--no-session"], d)).toBe(1);
    expect(c.stderr).toContain("suite init");
    expect(c.execs).toHaveLength(0);
  });
});

describe("D: no saved connection — the init prompts run inline, never 'run suite init first'", () => {
  function scripted(answers: string[], asked: string[]): Prompter {
    const q = [...answers];
    return {
      ask: async (question) => (asked.push(question), q.shift() ?? ""),
      askSecret: async (question) => (asked.push(question), q.shift() ?? ""),
      say: () => {},
    };
  }

  test("from a terminal, it asks for url, runtime id and token, saves them, and starts", async () => {
    const asked: string[] = [];
    const { d, c } = deps({ cwd: join(base, "home", "agents"), tty: true });
    d.prompter = scripted(["https://suite.example.invalid", "inline-dsh", FAKE_TOKEN, ""], asked);

    const code = await runDeepseek(["--no-session"], d);

    expect(asked.some((q) => q.startsWith("suite url"))).toBe(true);
    expect(asked.some((q) => q.startsWith("runtime id"))).toBe(true);
    expect(asked.some((q) => q.startsWith("token"))).toBe(true);
    expect(code).toBe(0);
    expect(c.execs).toHaveLength(1);
    expect(c.execs[0]?.env.SUITE_RUNTIME_ID).toBe("inline-dsh");
    expect(c.execs[0]?.env.SUITE_RUNTIME_TOKEN).toBe(FAKE_TOKEN);
    // Saved for next time: a second run asks nothing.
    const again: string[] = [];
    const second = deps({ cwd: join(base, "home", "agents"), tty: true });
    second.d.prompter = scripted([], again);
    expect(await runDeepseek(["--no-session"], second.d)).toBe(0);
    expect(again).toEqual([]);
  });

  test("CONTROL: off a terminal there is nobody to ask, so it refuses and names the way out", async () => {
    const asked: string[] = [];
    const { d, c } = deps({ cwd: join(base, "home", "agents"), tty: false });
    d.prompter = scripted(["https://suite.example.invalid", "inline-dsh", FAKE_TOKEN, ""], asked);
    expect(await runDeepseek(["--no-session"], d)).toBe(1);
    expect(asked).toEqual([]);
    expect(c.stderr).toContain("suite init");
    // Names the folder that is not connected, not "this machine": the
    // connection is per agent folder.
    expect(c.stderr).toContain(`${join(base, "home", "agents")} is not connected to Suite yet`);
    expect(c.stderr).toContain(`suite init --dir ${join(base, "home", "agents")}`);
    expect(c.stderr).not.toContain("this machine");
    expect(c.execs).toHaveLength(0);
  });
});

describe("B: the agent root's env block reaches the harness", () => {
  test("the model key and DSH_ settings are in the child env; no secret is in argv", async () => {
    const { d, c } = deps({ cwd: base });
    expect(await runDeepseek(["--root", root, "--no-session"], d)).toBe(0);
    const run = c.execs[0];
    expect(run?.env.OPENROUTER_API_KEY).toBe(FAKE_OR_KEY);
    expect(run?.env.KOBO_GATEWAY_KEY).toBe(FAKE_GW_KEY);
    expect(run?.env.DSH_MODEL).toBe("z-ai/fake-model");
    expect(run?.env.DSH_CONTEXT_WINDOW).toBe("4096");
    expect(run?.env.SUITE_RUNTIME_TOKEN).toBe(FAKE_TOKEN);
    const argv = (run?.argv ?? []).join(" ");
    for (const s of SECRETS) expect(argv).not.toContain(s);
    expect(c.stderr).not.toContain("MISSING_CREDENTIAL");
  });

  test("the agent's DSH_PERMISSION_MODE beats the workspace-write default and the inherited env", async () => {
    process.env.DSH_PERMISSION_MODE = "read-only";
    const { d, c } = deps({ cwd: base });
    expect(await runDeepseek(["--root", root, "--no-session"], d)).toBe(0);
    expect(c.execs[0]?.env.DSH_PERMISSION_MODE).toBe("danger-full-access");
  });

  test("without a declared key the run says so instead of failing every turn silently", async () => {
    writeAgent(root, "oddjob-dsh", undefined);
    const { d, c } = deps({ cwd: base });
    expect(await runDeepseek(["--root", root, "--no-session"], d)).toBe(0);
    expect(c.stderr).toContain("OPENROUTER_API_KEY is not set");
    expect(c.execs[0]?.env.DSH_PERMISSION_MODE).toBe("workspace-write");
  });

  test("the generated patch declares the model DSH_MODEL selects, by expression", async () => {
    const { d } = deps({ cwd: base });
    expect(await runDeepseek(["--root", root, "--no-session"], d)).toBe(0);
    const patch = await Bun.file(join(root, ".dsh", "suite.patch.yml")).text();
    expect(patch).toContain("- id: !!js process.env.DSH_MODEL || 'moonshotai/kimi-k3'");
    for (const s of SECRETS) expect(patch).not.toContain(s);
  });
});

describe("C: from the agent folder, a live session is attached and a stale one recycled", () => {
  test("LIVE: attaches, creates nothing", async () => {
    const { d, c } = deps({ cwd: root, tty: true, tmux: "live" });
    expect(await runDeepseek([], d)).toBe(0);
    expect(c.stderr).toContain("attaching to suite-oddjob");
    expect(c.tmuxCalls.some((a) => a[1] === "new-session" || a[1] === "kill-session")).toBe(false);
    expect(c.execs.map((e) => e.argv)).toEqual([["tmux", "attach-session", "-t", "suite-oddjob"]]);
  });

  test("STALE: kills that one session, relaunches the CLI with --root and no secret in argv", async () => {
    const { d, c } = deps({ cwd: root, tty: false, tmux: "stale" });
    expect(await runDeepseek([], d)).toBe(0);
    expect(c.stderr).toContain("recycling stale session suite-oddjob");
    expect(c.tmuxCalls).toContainEqual(["tmux", "kill-session", "-t", "suite-oddjob"]);
    const created = c.tmuxCalls.find((a) => a[1] === "new-session") ?? [];
    expect(created.join(" ")).toContain(`deepseek --root ${root} --no-session`);
    for (const s of SECRETS) expect(created.join(" ")).not.toContain(s);
  });
});
