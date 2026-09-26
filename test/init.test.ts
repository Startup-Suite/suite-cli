import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  CHANNEL_SERVER,
  ENV_INTERPOLATION_SUPPORTED,
  PullFailed,
  alreadyRegistered,
  classifyPullFailure,
  noGitPrompt,
  pullRemedyLines,
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
  MCP_SCOPE,
  claudeJsonPath,
  registerServers,
  userScopeChannelRuntime,
  userScopeLines,
} from "../src/commands/init.ts";
import { CLAUDE_MD } from "../src/claude_md.ts";
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
    cwd: fixture.root,
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

  /**
   * The watchdog is only installed when an IO is injected, which is what keeps
   * the rest of this suite from writing real unit files. That makes it possible
   * for it to be silently skipped forever, so these two tests exist to prove it
   * actually fires when wired, and only then.
   */
  test("installs the session watchdog by default", async () => {
    const fx = makeFixture();
    const calls: string[] = [];
    const deps = makeDeps(fx, scriptedPrompter(credentialAnswers()), {
      platform: "linux",
      supervisorIo: {
        mkdirp: (d) => calls.push(`mkdirp ${d}`),
        writeFile: (path, contents) => calls.push(`write ${path} :: ${contents.length}B`),
        run: async (argv) => {
          calls.push(argv.join(" "));
          return { exitCode: 0 };
        },
      },
    });

    const result = await runInit(deps);

    expect(result.supervisor?.installed).toBe(true);
    expect(calls.some((c) => c.startsWith("write ") && c.includes("suite-watch.service"))).toBe(true);
    expect(calls).toContain("systemctl --user enable --now suite-watch.service");
    expect(deps.lines.some((l) => l.includes("watchdog:"))).toBe(true);
  });

  /**
   * Restore-on-boot is WRITTEN but never ENABLED. A host that silently starts
   * agents after a reboot would be a worse surprise than the missing agent it
   * fixes, so the operator opts in per machine and init only prints how.
   */
  test("writes the agent restore unit but does not enable it", async () => {
    const fx = makeFixture();
    const calls: string[] = [];
    const deps = makeDeps(fx, scriptedPrompter(credentialAnswers()), {
      platform: "linux",
      supervisorIo: {
        mkdirp: (d) => calls.push(`mkdirp ${d}`),
        writeFile: (path) => calls.push(`write ${path}`),
        run: async (argv) => {
          calls.push(argv.join(" "));
          return { exitCode: 0 };
        },
      },
    });

    await runInit(deps);

    expect(calls.some((c) => c === "write /home/q/.config/systemd/user/suite-agents.service" ||
      c.endsWith("suite-agents.service"))).toBe(true);
    // The watchdog IS enabled; the agent restore is NOT. Assert the absence
    // specifically, or "we enabled everything" would pass this test.
    expect(calls.some((c) => c.includes("enable") && c.includes("suite-agents"))).toBe(false);
    expect(deps.lines.some((l) => l.includes("NOT enabled"))).toBe(true);
  });

  test("--no-supervisor declines it, and nothing is written", async () => {
    const fx = makeFixture();
    const calls: string[] = [];
    const deps = makeDeps(fx, scriptedPrompter(credentialAnswers()), {
      platform: "linux",
      supervisorIo: {
        mkdirp: (d) => calls.push(d),
        writeFile: (p2) => calls.push(p2),
        run: async (argv) => {
          calls.push(argv.join(" "));
          return { exitCode: 0 };
        },
      },
    });

    const result = await runInit(deps, { noSupervisor: true });

    expect(result.supervisor ?? null).toBeNull();
    expect(calls).toEqual([]);
  });

  test("takes the clone path, runs bun install, and registers both entries at LOCAL scope", async () => {
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
    // Scope is explicit and LOCAL: one entry per agent directory. User scope
    // is one entry per machine, so a second agent's init re-pointed the first.
    expect(channel).toContain("-s");
    expect(channel?.[channel.indexOf("-s") + 1]).toBe("local");
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
    expect(tools?.[tools.indexOf("-s") + 1]).toBe("local");
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

  test("writes a starting CLAUDE.md into the working directory", async () => {
    const fx = makeFixture();
    const deps = makeDeps(fx, scriptedPrompter(credentialAnswers()));

    const result = await runInit(deps);

    expect(result.claudeMd).toBe("write");
    const written = await Bun.file(resolve(fx.root, "CLAUDE.md")).text();
    expect(written).toContain("assignment IS the authorization");
    expect(deps.lines.join("\n")).toContain("CLAUDE.md");
  });

  test("an operator's own CLAUDE.md survives a re-run untouched", async () => {
    /*
     * The pairing is the test. Init is re-run routinely, and this file is where
     * an agent accumulates its operating knowledge — overwriting it would
     * destroy exactly the thing the template exists to seed. Asserted on the
     * bytes, not on the log line, because a step can report "left alone" and
     * still have written.
     */
    const fx = makeFixture();
    const mine = resolve(fx.root, "CLAUDE.md");
    await Bun.write(mine, "# mine\n\nhard-won notes\n");

    const result = await runInit(makeDeps(fx, scriptedPrompter(credentialAnswers())));

    expect(result.claudeMd).toBe("skip");
    expect(await Bun.file(mine).text()).toBe("# mine\n\nhard-won notes\n");
  });

  test("a project's own CLAUDE.md still leaves the agent with the conventions", async () => {
    /*
     * The defect this pairing exists for: a repo that ships a codebase guide at
     * this filename used to leave the agent with NOTHING, silently, because
     * `exists` cannot tell that document from an agent's brief. Rule 1 still
     * holds — asserted on the bytes — and the conventions arrive beside it.
     */
    const fx = makeFixture();
    const theirs = "# core\n\n## Common Commands\n\nmix test\n";
    const mine = resolve(fx.root, "CLAUDE.md");
    await Bun.write(mine, theirs);
    const deps = makeDeps(fx, scriptedPrompter(credentialAnswers()));

    const result = await runInit(deps);

    // Rule 1, unchanged: their file is not written to, not appended to.
    expect(result.claudeMd).toBe("skip");
    expect(await Bun.file(mine).text()).toBe(theirs);

    // And yet the agent ends up with the conventions.
    const owned = resolve(fx.root, "SUITE_CONVENTIONS.md");
    expect(existsSync(owned)).toBe(true);
    expect(await Bun.file(owned).text()).toContain("assignment IS the authorization");
    expect(result.conventions).toBe("unlinked");

    // Silence is what let this survive, so the run says it plainly.
    const printed = deps.lines.join("\n");
    expect(printed).toContain("SUITE_CONVENTIONS.md");
    expect(printed).toContain("states no Suite conventions");
    expect(printed).toContain("@SUITE_CONVENTIONS.md");
  });

  test("a CLAUDE.md that already carries the conventions gets no second copy", async () => {
    // The control. Without it, an implementation that writes the owned file
    // unconditionally passes the test above and litters every repo.
    const fx = makeFixture();
    await Bun.write(resolve(fx.root, "CLAUDE.md"), CLAUDE_MD);
    const deps = makeDeps(fx, scriptedPrompter(credentialAnswers()));

    const result = await runInit(deps);

    expect(result.conventions).toBe("carries");
    expect(existsSync(resolve(fx.root, "SUITE_CONVENTIONS.md"))).toBe(false);
    expect(deps.lines.join("\n")).not.toContain("states no Suite conventions");
  });

  test("a freshly seeded CLAUDE.md needs no second file either", async () => {
    const fx = makeFixture();
    const result = await runInit(makeDeps(fx, scriptedPrompter(credentialAnswers())));
    expect(result.conventions).toBe("seeded");
    expect(existsSync(resolve(fx.root, "SUITE_CONVENTIONS.md"))).toBe(false);
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

  /**
   * THE bun.sh FALLBACK NEEDS unzip.
   *
   * `bunInstallPlan` prefers the distro package and only falls back to
   * `curl -fsSL https://bun.sh/install | bash`, which unpacks a ZIP. The
   * launcher already refuses without unzip; these three pin the same
   * precondition on the TypeScript entrypoint, and — critically — pin that it
   * does NOT fire on the package-manager route, which needs no unzip.
   *
   * PATH here is CONSTRUCTED, never inherited: the fixture's PATH holds only
   * the stubs each test names, so "unzip is absent" is a property of the test,
   * not of the box it runs on. `run` is a recorder rather than the real
   * spawner so that a green test never downloads anything.
   */
  function runRecorder(): { calls: string[][]; run: InitDeps["run"] } {
    const calls: string[][] = [];
    return {
      calls,
      run: async (argv) => {
        calls.push(argv);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
  }

  /** No bun, no package manager, and on linux — so the plan is the fallback. */
  function fallbackDeps(tools: string[], recorder: { run: InitDeps["run"] }) {
    const fx = makeFixture({ tools });
    expect(bunInstallPlan({ platform: "linux", env: fx.env })?.manager).toBe("bun.sh");
    return makeDeps(fx, scriptedPrompter(["y", ...credentialAnswers()]), {
      platform: "linux",
      run: recorder.run,
    });
  }

  const BUN_SH_ARGV = ["sh", "-c", "curl -fsSL https://bun.sh/install | bash"];

  test("refuses the bun.sh install when unzip is absent, without running it", async () => {
    const recorder = runRecorder();
    const deps = fallbackDeps(["git", "claude", "tmux", "curl", "bash"], recorder);

    await expect(runInit(deps)).rejects.toThrow(/unzip/);
    // Nothing half-installed: the installer was never started at all.
    expect(recorder.calls.some((argv) => argv.join(" ") === BUN_SH_ARGV.join(" "))).toBe(false);
  });

  test("runs the bun.sh install when unzip is present", async () => {
    const recorder = runRecorder();
    const deps = fallbackDeps(["git", "claude", "tmux", "curl", "bash", "unzip"], recorder);

    // bun never appears on PATH, so the re-check after the install still fails
    // — which proves the installer was reached rather than refused.
    await expect(runInit(deps)).rejects.toThrow(/still not on PATH/);
    expect(recorder.calls.some((argv) => argv.join(" ") === BUN_SH_ARGV.join(" "))).toBe(true);
  });

  test("does not fire on the package-manager route, which needs no unzip", async () => {
    const recorder = runRecorder();
    const fx = makeFixture({ tools: ["git", "claude", "tmux", "apt-get"] });
    expect(whichBin("unzip", fx.env)).toBeNull();
    const deps = makeDeps(fx, scriptedPrompter(["y", ...credentialAnswers()]), {
      platform: "linux",
      run: recorder.run,
    });

    // `apt-get install -y bun` unpacks a distro package; a guard that fired
    // here would refuse an install that works. This is the assertion that an
    // unconditional guard fails.
    await expect(runInit(deps)).rejects.toThrow(/still not on PATH/);
    expect(recorder.calls.some((argv) => argv.join(" ") === "apt-get install -y bun")).toBe(true);
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

/**
 * THE FAILURE THIS EXISTS FOR, observed on a real host.
 *
 * `suite init` on a box whose plugin checkout was clean and exactly level with
 * origin (0 ahead, 0 behind) printed git's own "Authentication failed" and then
 * told the operator the checkout "has local commits or a diverged history".
 * Both halves were in the same message and they contradicted each other. The
 * remedy named was for a state that did not exist.
 */
describe("a failed pull says what actually went wrong", () => {
  const AUTH = [
    "remote: Invalid username or token. Password authentication is not supported for Git operations.",
    "fatal: Authentication failed for 'https://github.com/Startup-Suite/claude-code-suite-channel.git/'",
  ].join("\n");

  const DIVERGED =
    "fatal: Not possible to fast-forward, aborting.";

  test("an auth failure is not reported as a diverged history", () => {
    expect(classifyPullFailure(AUTH)).toBe("auth");
    const msg = new PullFailed("/co", AUTH).message;
    expect(msg).not.toContain("diverged history");
    expect(msg).not.toContain("local commits");
    expect(msg).toContain("could not authenticate");
  });

  test("the auth remedy is a command the operator can run", () => {
    const lines = pullRemedyLines("auth", "/co").join("\n");
    expect(lines).toContain("gh auth setup-git");
    expect(lines).toContain("remote set-url origin git@github.com:");
  });

  test("CONTROL: a real divergence still says diverged, and keeps the no-force promise", () => {
    expect(classifyPullFailure(DIVERGED)).toBe("diverged");
    const msg = new PullFailed("/co", DIVERGED).message;
    expect(msg).toContain("diverged history");
    expect(msg).toContain("will not force, reset or delete");
  });

  test("an unrecognised failure guesses at nothing", () => {
    const msg = new PullFailed("/co", "fatal: the disk caught fire").message;
    expect(classifyPullFailure("fatal: the disk caught fire")).toBe("unknown");
    expect(msg).not.toContain("diverged history");
    expect(msg).not.toContain("could not authenticate");
    expect(msg).toContain("not guessing");
  });

  /**
   * The prompt is disabled by MERGING, not replacing. `spawnWithSecrets` treats
   * `options.env` as the entire environment, so a bare `{GIT_TERMINAL_PROMPT}`
   * would strip PATH and HOME and take git's credential helper and SSH config
   * with them — trading a readable auth error for an inexplicable one.
   */
  test("disabling git's prompt keeps the rest of the environment", () => {
    const merged = noGitPrompt({ PATH: "/usr/bin", HOME: "/home/q" });
    expect(merged.GIT_TERMINAL_PROMPT).toBe("0");
    expect(merged.PATH).toBe("/usr/bin");
    expect(merged.HOME).toBe("/home/q");
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

  test("reads failure and absence as not-green", () => {
    expect(parseServerStatus("suite-channel: x - ✘ Failed to connect", "suite-channel").state).toBe(
      "not-connected",
    );
    expect(parseServerStatus("other: x - ✔ Connected", "suite-channel").state).toBe("missing");
  });

  /**
   * PENDING IS ITS OWN STATE — neither `connected` nor `not-connected`.
   *
   * `⏸ Pending approval` says this project has not approved a user-scope
   * server; it says nothing about whether that server works, and on a real box
   * both Suite servers reported pending while the channel was delivering
   * messages. It used to fall into the not-connected alternation, which made
   * `suite doctor` print a failure for a working channel.
   */
  test("pending approval is its own state, not connected and not a failure", () => {
    expect(
      parseServerStatus("startup-suite: x - ⏸ Pending approval (run `claude` to approve)", "startup-suite")
        .state,
    ).toBe("pending");
    // The word alone is enough; the glyph is Claude Code's to change.
    expect(parseServerStatus("suite-channel: x - Pending approval", "suite-channel").state).toBe("pending");
    // Still not green — the original claim, kept.
    expect(parseServerStatus("suite-channel: x - ⏸ Pending approval", "suite-channel").state).not.toBe(
      "connected",
    );
  });

  test("connectionReport does not call a pending server a hard failure", () => {
    const report = connectionReport([
      { name: "suite-channel", state: "connected", raw: "" },
      { name: "startup-suite", state: "pending", raw: "" },
    ]);
    expect(report.ok).toBe(true);
    const text = report.lines.join("\n");
    expect(text).toContain("pending approval");
    expect(text).toContain("run claude once in this project to approve");
    expect(text).not.toContain("not connected");
    // Anti-vacuity: a real not-connected server on the same shape IS still red,
    // so `ok` did not simply stop being reachable.
    expect(
      connectionReport([{ name: "startup-suite", state: "not-connected", raw: "" }]).ok,
    ).toBe(false);
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

/**
 * A SECOND `suite init` MUST CONVERGE. `claude mcp add` refuses a name that is
 * already registered, so once init had succeeded it could never be run again —
 * which is exactly when it gets run: after fixing a URL, rotating a token, or
 * moving the checkout. Observed on a real host as
 * `claude mcp add suite-channel failed with exit 1`, a number with no cause
 * attached because the argv is deliberately unlogged (it carries the token).
 */
describe("re-running init over entries it already registered", () => {
  test("the discriminator is the message, not the exit code", () => {
    expect(alreadyRegistered("MCP server suite-channel already exists in user config")).toBe(true);
    // Everything else also exits 1, and must NOT be answered by deleting the
    // operator's entry and trying again.
    expect(alreadyRegistered("error: unknown flag --nope")).toBe(false);
    expect(alreadyRegistered("EACCES: permission denied, open '/Users/x/.claude.json'")).toBe(false);
    expect(alreadyRegistered("")).toBe(false);
  });

  test("an already-registered entry is removed and re-added, and init still succeeds", async () => {
    const fx = makeFixture();
    const store = createStore();
    const calls: string[][] = [];
    const failedOnce = new Set<string>();

    const deps = makeDeps(fx, scriptedPrompter(credentialAnswers()), {
      store,
      run: async (argv, opts) => {
        calls.push(argv);
        if (argv[1] === "mcp" && argv[2] === "add") {
          const name = argv[3] as string;
          // Fail only the FIRST attempt for each server, the way a real second
          // run does — the retry after the remove must succeed.
          if (!failedOnce.has(name)) {
            failedOnce.add(name);
            return {
              exitCode: 1,
              stdout: "",
              stderr: `MCP server ${argv[3]} already exists in local config`,
            };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return spawnWithSecrets(argv, store, { ...opts, env: fx.env });
      },
    });

    await runInit(deps);

    const removes = calls.filter((c) => c[1] === "mcp" && c[2] === "remove");
    expect(removes.map((c) => c[3]).sort()).toEqual([CHANNEL_SERVER, TOOLS_SERVER].sort());
    // Removed at LOCAL scope — the scope the entry was registered in, and the
    // only one that cannot reach another agent's entry. Never `-s user`.
    for (const r of removes) expect(r.slice(4)).toEqual(["-s", "local"]);
    expect(calls.filter((c) => c[1] === "mcp" && c[2] === "add")).toHaveLength(4);
  });

  test("a failure that is NOT a name clash deletes nothing and reports the reason", async () => {
    const fx = makeFixture();
    const store = createStore();
    const calls: string[][] = [];

    const deps = makeDeps(fx, scriptedPrompter(credentialAnswers()), {
      store,
      run: async (argv, opts) => {
        calls.push(argv);
        if (argv[1] === "mcp" && argv[2] === "add") {
          return { exitCode: 1, stdout: "", stderr: "EACCES: permission denied" };
        }
        return spawnWithSecrets(argv, store, { ...opts, env: fx.env });
      },
    });

    // The cause travels with the error; an exit code alone is not a next step.
    await expect(runInit(deps)).rejects.toThrow(/permission denied/);
    expect(calls.filter((c) => c[1] === "mcp" && c[2] === "remove")).toHaveLength(0);
  });

  test("the thrown error never carries the token", async () => {
    const fx = makeFixture();
    const store = createStore();
    const deps = makeDeps(fx, scriptedPrompter(credentialAnswers()), {
      store,
      run: async (argv, opts) => {
        if (argv[1] === "mcp" && argv[2] === "add") {
          return { exitCode: 1, stdout: "", stderr: "EACCES: permission denied" };
        }
        return spawnWithSecrets(argv, store, { ...opts, env: fx.env });
      },
    });

    let message = "";
    try {
      await runInit(deps);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(TOKEN);
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

  /**
   * THE FAILURE THIS EXISTS FOR, from a real setup.
   *
   * The operator pasted the runtime URL — a reasonable reading of "the Suite
   * URL", and the value Suite itself shows you. `toolsHttpUrl` left the scheme
   * alone, so `wss://` went into the HTTP MCP slot and the client refused it
   * with `ERR_INVALID_ARG_VALUE: protocol must be http:, https: or s3:`, an
   * error naming neither Suite nor the URL behind it.
   */
  test("a pasted wss:// runtime URL still yields an http(s) tools entry", () => {
    expect(toolsHttpUrl("wss://suite.example.invalid/runtime/ws")).toBe(
      "https://suite.example.invalid/mcp",
    );
    expect(toolsHttpUrl("ws://127.0.0.1:4000/runtime/ws")).toBe("http://127.0.0.1:4000/mcp");
  });

  test("a pasted wss:// runtime URL still yields a ws(s) channel entry", () => {
    expect(channelWsUrl("wss://suite.example.invalid/runtime/ws")).toBe(
      "wss://suite.example.invalid/runtime/ws",
    );
  });

  /**
   * The quieter half of the same bug: the old mapping was "http: → ws:,
   * everything else → wss:", so a deliberate plaintext local runtime URL was
   * silently upgraded to wss: and could not complete a TLS handshake against a
   * plain dev server.
   */
  test("a plaintext ws:// is NOT silently upgraded to wss://", () => {
    expect(channelWsUrl("ws://localhost:4000/runtime/ws")).toBe("ws://localhost:4000/runtime/ws");
  });

  test("either paste of the same Suite produces the same pair", () => {
    const fromBrowser = "https://suite.example.invalid";
    const fromRuntime = "wss://suite.example.invalid/runtime/ws";
    expect(channelWsUrl(fromBrowser)).toBe(channelWsUrl(fromRuntime));
    expect(toolsHttpUrl(fromBrowser)).toBe(toolsHttpUrl(fromRuntime));
  });

  test("a scheme that is not a Suite URL is refused by name, not coerced", () => {
    expect(() => toolsHttpUrl("ftp://suite.example.invalid")).toThrow(/not a Suite URL/);
    expect(() => channelWsUrl("ftp://suite.example.invalid")).toThrow(/not a Suite URL/);
  });
});

describe("mcp add argv", () => {
  const entry = {
    suiteUrl: SUITE_URL,
    runtimeId: RUNTIME_ID,
    tokenLiteral: TOKEN,
    indexPath: "/abs/claude-code-suite-channel/src/index.ts",
  };

  test("the channel entry carries -s local and terminates its flags with --", () => {
    const argv = channelAddArgs(entry);
    expect(argv.slice(0, 6)).toEqual(["claude", "mcp", "add", CHANNEL_SERVER, "-s", "local"]);
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

/* ------------------------------------------------------------------------- */
/* One agent's entries never reach another agent (local scope)                */
/* ------------------------------------------------------------------------- */

describe("MCP entries are per agent directory", () => {
  const OTHER_RUNTIME = "runtime_11111111-1111-1111-1111-111111111111";

  function claudeJson(home: string, userChannelRuntime: string | null): void {
    const body =
      userChannelRuntime === null
        ? { projects: {} }
        : {
            mcpServers: {
              [CHANNEL_SERVER]: {
                type: "stdio",
                command: "bun",
                env: { SUITE_RUNTIME_ID: userChannelRuntime, SUITE_TOKEN: TOKEN },
              },
            },
          };
    writeFileSync(resolve(home, ".claude.json"), JSON.stringify(body));
  }

  function recordingRun(calls: Array<{ argv: string[]; cwd?: string }>): InitDeps["run"] {
    return async (argv, opts) => {
      calls.push({ argv, cwd: opts?.cwd });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
  }

  const invocations = () => [
    channelAddArgs({ suiteUrl: SUITE_URL, runtimeId: RUNTIME_ID, tokenLiteral: TOKEN, indexPath: "/x/src/index.ts" }),
    toolsAddArgs(SUITE_URL, TOKEN, []),
  ];

  test("every claude mcp call runs IN the agent directory, at local scope, never user", async () => {
    const home = mkdtempSync(resolve(tmpdir(), "suite-cli-scope-"));
    const agent = resolve(home, "agents", "one");
    mkdirSync(agent, { recursive: true });
    const calls: Array<{ argv: string[]; cwd?: string }> = [];
    let first = true;
    const run: InitDeps["run"] = async (argv, opts) => {
      calls.push({ argv, cwd: opts?.cwd });
      if (argv[2] === "add" && first) {
        first = false;
        return { exitCode: 1, stdout: "", stderr: `MCP server ${argv[3]} already exists in local config` };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await registerServers({ run, cwd: agent, env: { HOME: home } }, invocations(), RUNTIME_ID);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.cwd).toBe(agent);
      expect(c.argv[c.argv.indexOf("-s") + 1]).toBe(MCP_SCOPE);
      expect(c.argv).not.toContain("user");
    }
    // The clash was resolved by removing THIS directory's local entry only.
    expect(calls.filter((c) => c.argv[2] === "remove").map((c) => c.argv.slice(3))).toEqual([
      [CHANNEL_SERVER, "-s", "local"],
    ]);
    rmSync(home, { recursive: true, force: true });
  });

  test("a user-scope entry naming ANOTHER runtime is left byte-for-byte alone, and warned about", async () => {
    const home = mkdtempSync(resolve(tmpdir(), "suite-cli-scope-"));
    claudeJson(home, OTHER_RUNTIME);
    const before = readFileSync(resolve(home, ".claude.json"), "utf8");
    const calls: Array<{ argv: string[]; cwd?: string }> = [];
    const lines = await registerServers(
      { run: recordingRun(calls), cwd: home, env: { HOME: home } },
      invocations(),
      RUNTIME_ID,
    );
    const said = lines.join("\n");
    expect(said).toContain("warning");
    expect(said).toContain(OTHER_RUNTIME);
    expect(said).toContain("left alone");
    // The token sitting next to it is never echoed.
    expect(said).not.toContain(TOKEN);
    expect(readFileSync(resolve(home, ".claude.json"), "utf8")).toBe(before);
    rmSync(home, { recursive: true, force: true });
  });

  test("CONTROL: the same runtime is noted, not warned; no user entry says nothing", () => {
    expect(userScopeLines({ present: true, runtimeId: RUNTIME_ID }, RUNTIME_ID).join("\n")).not.toContain("warning");
    expect(userScopeLines({ present: false, runtimeId: null }, RUNTIME_ID)).toEqual([]);
    expect(userScopeChannelRuntime("not json")).toEqual({ present: false, runtimeId: null });
    expect(userScopeChannelRuntime(JSON.stringify({ projects: {} }))).toEqual({ present: false, runtimeId: null });
  });

  test("CLAUDE_CONFIG_DIR moves the file claude reads, so it moves ours", () => {
    expect(claudeJsonPath({ HOME: "/h" })).toBe("/h/.claude.json");
    expect(claudeJsonPath({ HOME: "/h", CLAUDE_CONFIG_DIR: "/c" })).toBe("/c/.claude.json");
  });
});
