import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  CHANNEL_SERVER,
  ENV_INTERPOLATION_SUPPORTED,
  PullFailed,
  TOOLS_SERVER,
  bunInstallPlan,
  channelAddArgs,
  channelWsUrl,
  connectionReport,
  envReference,
  packageCount,
  packageInstall,
  parseServerStatus,
  runInit,
  spinner,
  toolsAddArgs,
  toolsHttpUrl,
  whichBin,
  type InitDeps,
} from "../src/commands/init.ts";
import { createStore, spawnWithSecrets, type Prompter } from "../src/secrets.ts";
import {
  STUBBED_NOT_PROVEN,
  cleanupCleanEnvs,
  createCleanEnv,
  stubsFor,
  type CleanEnv,
} from "./clean-env/fixture.ts";

/**
 * EVERY VALUE HERE IS INVENTED. The repository is public, and a fixture is the
 * easiest place in a codebase for a real credential to end up looking like
 * scaffolding.
 */
const SUITE_URL = "https://suite.example.invalid";
const RUNTIME_ID = "runtime_00000000-0000-0000-0000-000000000000";
const TOKEN = "tok_fixture_0000000000000000000000000000";
const HEADER_NAME = "X-Example-Gateway-Id";
const HEADER_VALUE = "gateway_fixture_0000";

/* ------------------------------------------------------------------------- */
/* Clean-environment fixture                                                  */
/* ------------------------------------------------------------------------- */

/**
 * ON THIS BOX bun, tmux, the plugin checkout and both MCP entries already
 * exist, so an `init` run here would report success without executing a single
 * install path — a test that proves only that init can do nothing. So every
 * behavioural test below runs on a scratch machine from
 * `test/clean-env/fixture.ts`: its own HOME/XDG dirs and a PATH holding NOTHING
 * but the stubs it explicitly asks for.
 *
 * The fixture is SHARED with the doctor suite rather than hand-rolled twice —
 * two copies of "what a machine without bun looks like" drift, and the copy
 * that drifts is the one that stops testing anything.
 *
 * HONEST LIMIT (see {@link STUBBED_NOT_PROVEN}): the stubs stand in for a real
 * network `git clone` and a real `bun install`. These tests prove init TAKES
 * the clone path and invokes bun install with the right cwd and arguments; they
 * CANNOT prove a cold-start install on a machine that never had bun, nor a real
 * clone. That needs a container or a genuinely fresh machine.
 */
type Fixture = CleanEnv;

interface FixtureOptions {
  /** Which stubs exist on PATH. Anything absent is absent for real. */
  tools?: string[];
  /** What the stub `claude mcp list` prints. */
  mcpList?: string;
  /** Make `git pull --ff-only` fail, as a diverged checkout would. */
  pullFails?: boolean;
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  const tools = options.tools ?? ["git", "bun", "claude", "tmux", "brew"];
  const mcpList =
    options.mcpList ??
    `${CHANNEL_SERVER}: bun /somewhere/src/index.ts - ✔ Connected\n` +
      `${TOOLS_SERVER}: https://suite.example.invalid/mcp (HTTP) - ✔ Connected\n`;

  const fx = createCleanEnv({ label: "init", bodies: stubsFor(tools) });
  const listFile = resolve(fx.root, "mcp-list.txt");
  writeFileSync(listFile, mcpList);
  fx.env.STUB_MCP_LIST = listFile;
  if (options.pullFails === true) fx.env.STUB_PULL_FAILS = "1";
  return fx;
}

afterEach(cleanupCleanEnvs);

function scriptedPrompter(answers: string[]): Prompter & { asked: string[]; said: string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  const said: string[] = [];
  return {
    asked,
    said,
    async ask(q) {
      asked.push(q);
      return queue.shift() ?? "";
    },
    async askSecret(q) {
      asked.push(q);
      return queue.shift() ?? "";
    },
    say: (l) => void said.push(l),
  };
}

function makeDeps(
  fixture: Fixture,
  prompter: Prompter,
  overrides: Partial<InitDeps> = {},
): InitDeps & { lines: string[] } {
  const store = createStore();
  const lines: string[] = [];
  const deps: InitDeps & { lines: string[] } = {
    env: fixture.env,
    prompter,
    store,
    platform: "darwin",
    isTTY: false,
    lines,
    out: (l) => void lines.push(l),
    run: (argv, opts) => spawnWithSecrets(argv, store, { ...opts, env: fixture.env }),
    ...overrides,
  };
  return deps;
}

/** The credential answers, in the order runInit asks for them. */
function credentialAnswers(): string[] {
  return [SUITE_URL, RUNTIME_ID, TOKEN, `${HEADER_NAME}: ${HEADER_VALUE}`, ""];
}

function invocation(fixture: Fixture, prefix: string[]): string[] | null {
  for (const line of fixture.log()) {
    const parts = line.split("\t");
    if (prefix.every((p, i) => parts[i] === p)) return parts;
  }
  return null;
}

/* ------------------------------------------------------------------------- */

describe("init on a machine where nothing is installed", () => {
  /**
   * The marker test. It exists so that a reader who greps for
   * STUBBED_NOT_PROVEN finds a failing-if-removed statement of what the green
   * results below do NOT establish, rather than a comment that can rot.
   */
  test(`${STUBBED_NOT_PROVEN}: git and bun here are shell stubs, so no real clone or install is proven`, async () => {
    const fx = makeFixture();
    for (const tool of ["git", "bun"]) {
      const text = await Bun.file(resolve(fx.bin, tool)).text();
      expect(text.startsWith("#!/bin/sh")).toBe(true);
    }
    // And the scrubbed PATH really is scrubbed: the code under test cannot
    // reach the machine's own git or bun and quietly do the real thing.
    expect(fx.env.PATH).toBe(fx.bin);
  });

  test("takes the clone path, runs bun install, and registers both entries at user scope", async () => {
    const fx = makeFixture();
    const prompter = scriptedPrompter(credentialAnswers());
    const deps = makeDeps(fx, prompter);

    const result = await runInit(deps);

    expect(result.exitCode).toBe(0);
    expect(result.checkout).toBe("cloned");

    // The clone path was TAKEN — not merely available.
    const clone = invocation(fx, ["git", "clone"]);
    expect(clone).not.toBeNull();
    expect(clone?.[3]).toBe(fx.checkout);
    expect(existsSync(resolve(fx.checkout, "src/index.ts"))).toBe(true);
    expect(fx.log().some((l) => l.startsWith("bun\tinstall"))).toBe(true);

    const channel = invocation(fx, ["claude", "mcp", "add", CHANNEL_SERVER]);
    expect(channel).not.toBeNull();
    // Scope is explicit. The `claude mcp add` default is `local`, so omitting
    // this flag would quietly write an entry scoped to one directory.
    expect(channel).toContain("-s");
    expect(channel?.[channel.indexOf("-s") + 1]).toBe("user");
    expect(channel).toContain(`SUITE_URL=wss://suite.example.invalid/runtime/ws`);
    expect(channel).toContain(`SUITE_RUNTIME_ID=${RUNTIME_ID}`);
    expect(channel).toContain("SUITE_ALLOW_PERMISSION_RELAY=0");
    // ABSOLUTE path: a relative one resolves against Claude's cwd and breaks
    // everywhere except the directory init happened to run in.
    const last = channel?.[channel.length - 1] ?? "";
    expect(last.startsWith("/")).toBe(true);
    expect(last).toBe(resolve(fx.checkout, "src/index.ts"));

    const tools = invocation(fx, ["claude", "mcp", "add", TOOLS_SERVER]);
    expect(tools).not.toBeNull();
    expect(tools?.[tools.indexOf("-s") + 1]).toBe("user");
    expect(tools?.[tools.indexOf("-t") + 1]).toBe("http");
    expect(tools).toContain("https://suite.example.invalid/mcp");
    expect(tools).toContain(`${HEADER_NAME}: ${HEADER_VALUE}`);

    // The config file records names, never values.
    const config = readFileSync(result.configPath, "utf8");
    expect(config).toContain(HEADER_NAME);
    expect(config).not.toContain(TOKEN);
    expect(config).not.toContain(HEADER_VALUE);

    // Nothing init printed contains a secret.
    for (const line of [...deps.lines, ...prompter.said]) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(HEADER_VALUE);
    }
  });

  test("offers the bun install rather than performing it unasked", async () => {
    const fx = makeFixture({ tools: ["git", "claude", "tmux", "brew"] });
    const prompter = scriptedPrompter(["y", ...credentialAnswers()]);
    const deps = makeDeps(fx, prompter);

    // bun never appears on PATH, so the re-check after the install still fails
    // — which is the correct outcome, and proves the offer was made first.
    await expect(runInit(deps)).rejects.toThrow(/still not on PATH/);
    expect(prompter.asked.some((q) => /bun is not installed\. install it with brew\?/.test(q))).toBe(true);
    expect(invocation(fx, ["brew", "install", "bun"])).not.toBeNull();
  });

  test("does not install bun when the offer is declined", async () => {
    const fx = makeFixture({ tools: ["git", "claude", "tmux", "brew"] });
    const deps = makeDeps(fx, scriptedPrompter(["n"]));
    await expect(runInit(deps)).rejects.toThrow(/bun is required/);
    expect(invocation(fx, ["brew", "install", "bun"])).toBeNull();
  });

  test("prompts for tmux, and a declined tmux warns loudly without failing init", async () => {
    const fx = makeFixture({ tools: ["git", "bun", "claude", "brew"] });
    const prompter = scriptedPrompter(["n", ...credentialAnswers()]);
    const deps = makeDeps(fx, prompter);

    const result = await runInit(deps);

    expect(prompter.asked.some((q) => /tmux is not installed\. install it with brew\?/.test(q))).toBe(true);
    expect(invocation(fx, ["brew", "install", "tmux"])).toBeNull();
    // Not fatal — but it must SAY what the user has lost. A missing tmux is
    // precisely the condition under which an agent dies with the terminal, so a
    // silent success here would be the tool concealing its own failure mode.
    expect(result.exitCode).toBe(0);
    expect(result.tmuxMissing).toBe(true);
    const text = deps.lines.join("\n");
    expect(text).toContain("tmux");
    expect(text).toMatch(/close the terminal/);
  });

  test("a present tmux is reported and nothing is offered", async () => {
    const fx = makeFixture();
    const prompter = scriptedPrompter(credentialAnswers());
    const deps = makeDeps(fx, prompter);
    const result = await runInit(deps);
    expect(result.tmuxMissing).toBe(false);
    expect(prompter.asked.some((q) => /tmux is not installed/.test(q))).toBe(false);
    expect(deps.lines.join("\n")).toContain("3.5a");
  });
});

describe("an existing checkout", () => {
  test("is fast-forwarded, not re-cloned", async () => {
    const fx = makeFixture();
    mkdirSync(resolve(fx.checkout, ".git"), { recursive: true });
    const deps = makeDeps(fx, scriptedPrompter(credentialAnswers()));
    const result = await runInit(deps);
    expect(result.checkout).toBe("updated");
    expect(invocation(fx, ["git", "pull", "--ff-only"])).not.toBeNull();
    expect(invocation(fx, ["git", "clone"])).toBeNull();
  });

  test("a failed fast-forward stops; it is never forced", async () => {
    const fx = makeFixture({ pullFails: true });
    mkdirSync(resolve(fx.checkout, ".git"), { recursive: true });
    const deps = makeDeps(fx, scriptedPrompter(credentialAnswers()));

    await expect(runInit(deps)).rejects.toThrow(PullFailed);

    for (const line of fx.log()) {
      expect(line).not.toMatch(/\treset\b/);
      expect(line).not.toMatch(/--force|-f\b/);
      expect(line).not.toMatch(/\tclean\b/);
    }
    expect(invocation(fx, ["claude", "mcp", "add", CHANNEL_SERVER])).toBeNull();
  });
});

describe("verification is of connection, not of writing", () => {
  test("a not-connected server fails the run even though both entries were written", async () => {
    const fx = makeFixture({
      mcpList:
        `${CHANNEL_SERVER}: bun /x/src/index.ts - ✔ Connected\n` +
        `${TOOLS_SERVER}: https://suite.example.invalid/mcp (HTTP) - ✘ Failed to connect\n`,
    });
    const deps = makeDeps(fx, scriptedPrompter(credentialAnswers()));
    const result = await runInit(deps);
    expect(invocation(fx, ["claude", "mcp", "add", TOOLS_SERVER])).not.toBeNull();
    expect(result.exitCode).toBe(1);
    expect(deps.lines.join("\n")).toContain("not connected");
  });

  test("an unreadable status line is a failure that shows the raw line", async () => {
    const fx = makeFixture({
      mcpList: `${CHANNEL_SERVER}: something we have never seen\n${TOOLS_SERVER}: x - ✔ Connected\n`,
    });
    const deps = makeDeps(fx, scriptedPrompter(credentialAnswers()));
    const result = await runInit(deps);
    expect(result.exitCode).toBe(1);
    expect(deps.lines.join("\n")).toContain("something we have never seen");
  });

  test("a server missing from the listing is a failure, not an omission", async () => {
    const fx = makeFixture({ mcpList: `${CHANNEL_SERVER}: x - ✔ Connected\n` });
    const deps = makeDeps(fx, scriptedPrompter(credentialAnswers()));
    expect((await runInit(deps)).exitCode).toBe(1);
  });
});

/* ------------------------------------------------------------------------- */
/* Pure units                                                                 */
/* ------------------------------------------------------------------------- */

describe("parseServerStatus", () => {
  test("reads the connected form", () => {
    const line = "suite-channel: bun /a/b/src/index.ts - ✔ Connected";
    expect(parseServerStatus(line, "suite-channel").state).toBe("connected");
  });

  test("reads failure, pending approval and absence as not-green", () => {
    expect(parseServerStatus("suite-channel: x - ✘ Failed to connect", "suite-channel").state).toBe(
      "not-connected",
    );
    expect(
      parseServerStatus("startup-suite: x - ⏸ Pending approval (run `claude` to approve)", "startup-suite")
        .state,
    ).toBe("not-connected");
    expect(parseServerStatus("other: x - ✔ Connected", "suite-channel").state).toBe("missing");
  });

  test("an unrecognised status is unparseable, never assumed connected", () => {
    const s = parseServerStatus("suite-channel: a brand new phrasing", "suite-channel");
    expect(s.state).toBe("unparseable");
    expect(s.raw).toContain("a brand new phrasing");
    // Anti-vacuity for the whole parser: the same input under the connected
    // rule must NOT come out green, or "unparseable" would be untestable.
    expect(connectionReport([s]).ok).toBe(false);
  });

  test("connectionReport is green only when every server is connected", () => {
    const ok = connectionReport([
      { name: "a", state: "connected", raw: "" },
      { name: "b", state: "connected", raw: "" },
    ]);
    expect(ok.ok).toBe(true);
    expect(
      connectionReport([
        { name: "a", state: "connected", raw: "" },
        { name: "b", state: "not-connected", raw: "" },
      ]).ok,
    ).toBe(false);
  });
});

describe("url derivation", () => {
  test("the channel speaks websocket to the runtime endpoint", () => {
    expect(channelWsUrl("https://suite.example.invalid")).toBe("wss://suite.example.invalid/runtime/ws");
    expect(channelWsUrl("http://127.0.0.1:4000")).toBe("ws://127.0.0.1:4000/runtime/ws");
  });

  test("the tools entry is /mcp on the same host", () => {
    expect(toolsHttpUrl("https://suite.example.invalid/anything")).toBe("https://suite.example.invalid/mcp");
  });
});

describe("mcp add argv", () => {
  const entry = {
    suiteUrl: SUITE_URL,
    runtimeId: RUNTIME_ID,
    tokenLiteral: TOKEN,
    indexPath: "/abs/claude-code-suite-channel/src/index.ts",
  };

  test("the channel entry carries -s user and terminates its flags with --", () => {
    const argv = channelAddArgs(entry);
    expect(argv.slice(0, 6)).toEqual(["claude", "mcp", "add", CHANNEL_SERVER, "-s", "user"]);
    expect(argv.slice(-3)).toEqual(["--", "bun", entry.indexPath]);
  });

  test("a relative entrypoint is refused outright", () => {
    expect(() => channelAddArgs({ ...entry, indexPath: "src/index.ts" })).toThrow(/absolute/);
  });

  test("one -H per solicited header, and the transport is explicit", () => {
    const argv = toolsAddArgs(SUITE_URL, TOKEN, [
      { name: "X-A", value: "1" },
      { name: "X-B", value: "2" },
    ]);
    expect(argv.filter((a) => a === "-H").length).toBe(3);
    expect(argv).toContain("X-A: 1");
    expect(argv).toContain("X-B: 2");
    expect(argv[argv.indexOf("-t") + 1]).toBe("http");
  });
});

describe("environment probing", () => {
  test("whichBin finds an executable and misses a scrubbed PATH", () => {
    const fx = makeFixture({ tools: ["bun"] });
    expect(whichBin("bun", fx.env)).toBe(resolve(fx.bin, "bun"));
    expect(whichBin("tmux", fx.env)).toBeNull();
    expect(whichBin("bun", { PATH: "" })).toBeNull();
  });

  test("the package manager follows the platform, and admits when it has none", () => {
    const fx = makeFixture({ tools: ["brew"] });
    expect(packageInstall("tmux", { platform: "darwin", env: fx.env })?.argv).toEqual([
      "brew",
      "install",
      "tmux",
    ]);
    expect(packageInstall("tmux", { platform: "darwin", env: { PATH: "" } })).toBeNull();
    const apt = makeFixture({ tools: ["apt-get"] });
    expect(packageInstall("tmux", { platform: "linux", env: apt.env })?.manager).toBe("apt");
    expect(packageInstall("tmux", { platform: "win32", env: apt.env })).toBeNull();
    expect(bunInstallPlan({ platform: "linux", env: { PATH: "" } })?.manager).toBe("bun.sh");
  });

  test("packageCount reads bun's own summary and shrugs when it is absent", () => {
    expect(packageCount("4 packages installed [12.00ms]")).toBe("4 packages");
    expect(packageCount("Checked 4 installs across 5 packages (no changes)")).toBe("");
  });
});

describe("spinners", () => {
  test("emit nothing off a TTY", () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      written.push(s);
      return true;
    };
    try {
      spinner("plugin", { isTTY: false }).stop();
    } finally {
      (process.stdout as unknown as { write: typeof original }).write = original;
    }
    expect(written).toEqual([]);
  });
});

describe("${ENV_VAR} interpolation, settled empirically", () => {
  /**
   * Recorded here so the answer travels with the code. Measured against Claude
   * Code 2.1.228 with a stub stdio server that printed its own environment:
   * a set variable arrives EXPANDED; an unset one arrives as the LITERAL
   * `${VAR}` text rather than empty. The second half is why an inline value is
   * still the default — see the note in init.ts.
   */
  test("the finding is recorded, and the reference form is exact", () => {
    expect(ENV_INTERPOLATION_SUPPORTED).toBe(true);
    expect(envReference("SUITE_TOKEN")).toBe("${SUITE_TOKEN}");
  });

  test("the reference form is what lands in argv when the operator asks for it", () => {
    const argv = channelAddArgs({
      suiteUrl: SUITE_URL,
      runtimeId: RUNTIME_ID,
      tokenLiteral: envReference("SUITE_TOKEN"),
      indexPath: "/abs/src/index.ts",
    });
    expect(argv).toContain("SUITE_TOKEN=${SUITE_TOKEN}");
    expect(argv.join(" ")).not.toContain(TOKEN);
  });
});
