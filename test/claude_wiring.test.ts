/**
 * `suite claude` owns Claude Code's wiring to the install: the channel plugin
 * checkout, CLAUDE.md and both MCP entries — done lazily, from what `suite
 * init` saved, registering only what is missing or stale, without asking for
 * credentials again. And on a machine with nothing saved, it asks the init
 * questions itself instead of refusing.
 *
 * Every value here is invented. The repository is public.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runClaude, type ClaudeDeps } from "../src/commands/claude.ts";
import { CHANNEL_SERVER, TOOLS_SERVER, channelWsUrl, defaultCheckout, runInit, toolsHttpUrl } from "../src/commands/init.ts";
import { credentialsPath, readCredentials } from "../src/connection.ts";
import { emptyConfig, readConfig } from "../src/config.ts";
import { createStore, spawnWithSecrets, type Prompter } from "../src/secrets.ts";
import type { RunResult, TmuxDeps } from "../src/tmux.ts";
import { cleanupCleanEnvs, createCleanEnv, stubsFor, type CleanEnv } from "./clean-env/fixture.ts";

const SUITE_URL = "https://suite.example.invalid";
const RUNTIME_ID = "runtime_00000000-0000-0000-0000-000000000000";
const TOKEN = "tok_fixture_0000000000000000000000000000";

afterEach(cleanupCleanEnvs);

/** A prompter that answers from a script, and records every question. */
function scripted(answers: string[]): Prompter & { asked: string[] } {
  const q = [...answers];
  const asked: string[] = [];
  return {
    asked,
    ask: async (question) => (asked.push(question), q.shift() ?? ""),
    askSecret: async (question) => (asked.push(question), q.shift() ?? ""),
    say: () => {},
  };
}

/** A prompter that FAILS the test the moment anything is asked. */
function mute(): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const refuse = async (question: string): Promise<string> => {
    asked.push(question);
    throw new Error(`prompted unexpectedly: ${question}`);
  };
  return { asked, ask: refuse, askSecret: refuse, say: () => {} };
}

function machine(): CleanEnv {
  const fx = createCleanEnv({ label: "wiring", bodies: stubsFor(["git", "bun", "claude", "tmux"]) });
  const list = resolve(fx.root, "mcp-list.txt");
  writeFileSync(
    list,
    `${CHANNEL_SERVER}: bun /x/src/index.ts - ✔ Connected\n${TOOLS_SERVER}: ${SUITE_URL}/mcp (HTTP) - ✔ Connected\n`,
  );
  fx.env.STUB_MCP_LIST = list;
  return fx;
}

/** `suite init`, for real, on the scratch machine — what the user ran first. */
async function init(fx: CleanEnv): Promise<void> {
  const store = createStore();
  await runInit({
    env: fx.env,
    prompter: scripted([SUITE_URL, RUNTIME_ID, TOKEN, ""]),
    store,
    platform: "linux",
    isTTY: false,
    cwd: fx.root,
    out: () => {},
    run: (argv, opts) => spawnWithSecrets(argv, store, { ...opts, env: fx.env }),
  });
}

const noTmux: TmuxDeps = {
  env: {},
  which: (name) => (name === "claude" ? "/fixture/bin/claude" : null),
  run: async (): Promise<RunResult> => ({ exitCode: 0, stdout: "", stderr: "" }),
};

/** `suite claude -p …` deps on the scratch machine: real wiring, faked launch. */
function claudeDeps(fx: CleanEnv, prompter: Prompter, canPrompt = true): ClaudeDeps & { execed: string[][]; errLines: string[] } {
  const store = createStore();
  const execed: string[][] = [];
  const errLines: string[] = [];
  const deps: ClaudeDeps & { execed: string[][]; errLines: string[] } = {
    execed,
    errLines,
    tmux: noTmux,
    env: fx.env,
    cwd: fx.root,
    store,
    config: emptyConfig(),
    statePath: resolve(fx.root, "state.json"),
    color: false,
    platform: "linux",
    prompter,
    sleep: async () => {},
    out: () => {},
    err: (l) => void errLines.push(l),
    exec: async (argv) => {
      execed.push(argv);
      return 0;
    },
    wiring: {
      run: (argv, opts) => spawnWithSecrets(argv, store, { ...opts, env: fx.env }),
      isTTY: false,
      canPrompt,
    },
  };
  return deps;
}

function adds(fx: CleanEnv): string[][] {
  return fx
    .log()
    .map((l) => l.split("\t"))
    .filter((p) => p[0] === "claude" && p[1] === "mcp" && p[2] === "add");
}

/** Claude Code's own record of this folder's entries, as `claude mcp add -s local` writes it. */
function writeClaudeJson(fx: CleanEnv, servers: Record<string, unknown>): void {
  writeFileSync(
    resolve(fx.home, ".claude.json"),
    JSON.stringify({ projects: { [fx.root]: { mcpServers: servers } } }),
    { mode: 0o600 },
  );
}

function currentChannel(fx: CleanEnv): unknown {
  return {
    type: "stdio",
    command: "bun",
    args: [resolve(defaultCheckout(fx.env), "src", "index.ts")],
    env: {
      SUITE_URL: channelWsUrl(SUITE_URL),
      SUITE_RUNTIME_ID: RUNTIME_ID,
      SUITE_TOKEN: TOKEN,
      SUITE_ALLOW_PERMISSION_RELAY: "0",
    },
  };
}

function currentTools(): unknown {
  return { type: "http", url: toolsHttpUrl(SUITE_URL), headers: { Authorization: `Bearer ${TOKEN}` } };
}

describe("init saves the connection where every harness can read it", () => {
  test("the token is in a 0600 credentials file, never in config.json", async () => {
    const fx = machine();
    await init(fx);
    const path = credentialsPath(fx.env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readCredentials(fx.env)?.token).toBe(TOKEN);
    const config = await Bun.file(resolve(fx.home, ".config/suite/config.json")).text();
    expect(config).toContain(RUNTIME_ID);
    expect(config).not.toContain(TOKEN);
  });
});

describe("suite claude wires this folder from the saved connection", () => {
  test("init → claude: registers ONLY the missing entry, with the saved token, asking nothing", async () => {
    const fx = machine();
    await init(fx);
    // The channel entry is already current; the tools entry is missing.
    writeClaudeJson(fx, { [CHANNEL_SERVER]: currentChannel(fx) });
    const prompter = mute();
    const deps = claudeDeps(fx, prompter);

    const code = await runClaude(deps, { userArgs: ["-p", "hello"], force: false });

    expect(prompter.asked).toEqual([]);
    expect(code).toBe(0);
    const added = adds(fx);
    expect(added.map((a) => a[3])).toEqual([TOOLS_SERVER]);
    // From the saved credentials, not a prompt: the bearer is init's token.
    expect(added[0]).toContain(`Authorization: Bearer ${TOKEN}`);
    expect(added[0]?.[added[0].indexOf("-s") + 1]).toBe("local");
    // Then it launched.
    expect(deps.execed).toHaveLength(1);
    expect(deps.execed[0]?.[0]).toBe("claude");
  });

  test("a fully wired folder runs no git, no bun install and no claude mcp at all", async () => {
    const fx = machine();
    await init(fx);
    const checkout = defaultCheckout(fx.env);
    mkdirSync(resolve(checkout, ".git"), { recursive: true });
    mkdirSync(resolve(checkout, "src"), { recursive: true });
    mkdirSync(resolve(checkout, "node_modules"), { recursive: true });
    writeFileSync(resolve(checkout, "src/index.ts"), "");
    writeFileSync(resolve(fx.root, "CLAUDE.md"), "# mine\n@SUITE_CONVENTIONS.md\n");
    writeClaudeJson(fx, { [CHANNEL_SERVER]: currentChannel(fx), [TOOLS_SERVER]: currentTools() });
    const before = fx.log().length;
    const deps = claudeDeps(fx, mute());

    expect(await runClaude(deps, { userArgs: ["-p", "hello"], force: false })).toBe(0);

    const after = fx.log().slice(before);
    expect(after.filter((l) => l.startsWith("git\t") || l.startsWith("bun\t") || l.startsWith("claude\tmcp"))).toEqual(
      [],
    );
    expect(deps.execed).toHaveLength(1);
  });

  test("a rotated token (re-run init) makes both entries stale, and both are rewritten", async () => {
    const fx = machine();
    await init(fx);
    writeClaudeJson(fx, { [CHANNEL_SERVER]: currentChannel(fx), [TOOLS_SERVER]: currentTools() });
    // The operator re-runs init with a new token.
    const rotated = "tok_fixture_rotated_00000000000000000000";
    const store = createStore();
    await runInit({
      env: fx.env,
      prompter: scripted(["", "", rotated, ""]),
      store,
      platform: "linux",
      isTTY: false,
      cwd: fx.root,
      out: () => {},
      run: (argv, opts) => spawnWithSecrets(argv, store, { ...opts, env: fx.env }),
    });
    const deps = claudeDeps(fx, mute());

    expect(await runClaude(deps, { userArgs: ["-p", "x"], force: false })).toBe(0);

    const added = adds(fx);
    expect(added.map((a) => a[3]).sort()).toEqual([CHANNEL_SERVER, TOOLS_SERVER].sort());
    expect(added.find((a) => a[3] === CHANNEL_SERVER)).toContain(`SUITE_TOKEN=${rotated}`);
  });
});

describe("no saved connection: suite claude asks the init questions itself", () => {
  test("claude straight away: prompts url, runtime id, token; saves them; wires; launches", async () => {
    const fx = machine();
    expect(await readConfig({ env: fx.env })).toBeNull();
    const prompter = scripted([SUITE_URL, RUNTIME_ID, TOKEN, ""]);
    const deps = claudeDeps(fx, prompter);

    const code = await runClaude(deps, { userArgs: ["-p", "hello"], force: false });

    expect(code).toBe(0);
    expect(prompter.asked.some((q) => q.startsWith("suite url"))).toBe(true);
    expect(prompter.asked.some((q) => q.startsWith("runtime id"))).toBe(true);
    expect(prompter.asked.some((q) => q.startsWith("token"))).toBe(true);
    // Never the old refusal.
    expect(deps.errLines.join("\n")).not.toContain("run suite init first");
    // Saved, so the next harness (or the next launch) asks nothing.
    expect((await readConfig({ env: fx.env }))?.runtimeId).toBe(RUNTIME_ID);
    expect(readCredentials(fx.env)?.token).toBe(TOKEN);
    // Wired: plugin cloned, CLAUDE.md written, both entries registered.
    expect(fx.log().some((l) => l.startsWith("git\tclone"))).toBe(true);
    expect(existsSync(resolve(fx.root, "CLAUDE.md"))).toBe(true);
    expect(adds(fx).map((a) => a[3]).sort()).toEqual([CHANNEL_SERVER, TOOLS_SERVER].sort());
    expect(deps.execed).toHaveLength(1);
  });

  test("off a terminal there is nobody to ask: it says so and launches Claude unwired, as before", async () => {
    const fx = machine();
    const prompter = mute();
    const deps = claudeDeps(fx, prompter, false);

    expect(await runClaude(deps, { userArgs: ["-p", "x"], force: false })).toBe(0);

    expect(prompter.asked).toEqual([]);
    expect(adds(fx)).toEqual([]);
    expect(deps.errLines.join("\n")).toContain("not connected to a Suite install");
    expect(deps.execed).toHaveLength(1);
  });

  test("a machine connected by an older CLI (no saved token) is asked for the token only, once", async () => {
    const fx = machine();
    // config.json without credentials.json: what 0.5.x left behind.
    mkdirSync(resolve(fx.home, ".config/suite"), { recursive: true });
    writeFileSync(
      resolve(fx.home, ".config/suite/config.json"),
      JSON.stringify({ suiteUrl: SUITE_URL, runtimeId: RUNTIME_ID, headerNames: [], sessionNaming: "cwd" }),
    );
    const prompter = scripted([TOKEN, ""]);
    const deps = claudeDeps(fx, prompter);

    expect(await runClaude(deps, { userArgs: ["-p", "x"], force: false })).toBe(0);

    expect(prompter.asked.some((q) => q.startsWith("suite url"))).toBe(false);
    expect(prompter.asked.some((q) => q.startsWith("runtime id"))).toBe(false);
    expect(prompter.asked.some((q) => q.startsWith("token"))).toBe(true);
    expect(readCredentials(fx.env)?.token).toBe(TOKEN);
  });
});

describe("re-running init", () => {
  test("a blank token answer keeps the saved token instead of erasing it", async () => {
    const fx = machine();
    await init(fx);
    const store = createStore();
    await runInit({
      env: fx.env,
      prompter: scripted(["", "", "", ""]),
      store,
      platform: "linux",
      isTTY: false,
      cwd: fx.root,
      out: () => {},
      run: (argv, opts) => spawnWithSecrets(argv, store, { ...opts, env: fx.env }),
    });
    expect(readCredentials(fx.env)?.token).toBe(TOKEN);
    expect((await readConfig({ env: fx.env }))?.suiteUrl).toBe(SUITE_URL);
  });
});
