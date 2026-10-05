/**
 * `suite claude --detach` and `suite codex --detach`: ensure the session and
 * leave it running, exit 0, never exec the attach.
 *
 * Recording tmux stub + recording exec. The positive control for each verb is
 * the same call WITHOUT --detach, on a "terminal": there the attach exec IS
 * recorded, so a detach test that passes is not passing because nothing ever
 * attaches.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseClaudeOptions } from "../src/cli.ts";
import { emptyConfig } from "../src/config.ts";
import { createStore } from "../src/secrets.ts";
import type { RunResult, TmuxDeps } from "../src/tmux.ts";
import { DETACH_REFUSED_EXIT, MISSING_AGENT_EXIT, runClaude, type ClaudeDeps } from "../src/commands/claude.ts";
import { runCodex, type CodexDeps } from "../src/commands/codex.ts";

const scratch: string[] = [];
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "suite-detach-01a0d6b9-"));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A tmux with no session until `new-session`, then one whose agent is alive. */
function statefulTmux(agent: string, ran: string[][]): TmuxDeps {
  let session: string | null = null;
  return {
    env: {},
    which: (n) => `/usr/bin/${n}`,
    run: async (argv): Promise<RunResult> => {
      ran.push(argv);
      if (argv.includes("new-session")) {
        const i = argv.indexOf("-s");
        session = argv[i + 1] ?? null;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (argv.includes("list-panes")) return { exitCode: 0, stdout: session === null ? "" : `${session}\t4242\tzsh\n`, stderr: "" };
      if (argv[0] === "ps") {
        return { exitCode: 0, stdout: session === null ? "" : `  4242     1 zsh   -zsh\n  4243  4242 ${agent}   ${agent} --continue\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

function claudeDeps() {
  const ran: string[][] = [];
  const execed: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const json: string[] = [];
  const deps: ClaudeDeps = {
    tmux: statefulTmux("claude", ran),
    platform: "darwin",
    prompter: { ask: async () => "n", askSecret: async () => "", say: () => {} },
    sleep: async () => {},
    env: {},
    cwd: "/projects/ledger-01a0d6b9",
    store: createStore(),
    config: emptyConfig(),
    statePath: resolve(temp(), "state.json"),
    color: false,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    emitJson: (t) => void json.push(t),
    exec: async (argv) => {
      execed.push(argv);
      return 0;
    },
  };
  return { deps, ran, execed, out, err, json };
}

describe("parseClaudeOptions: --detach and --json", () => {
  test("--detach is ours before --; --json only beside --detach", () => {
    expect(parseClaudeOptions(["--detach", "--json"])).toEqual({ detach: true, json: true, rest: [] });
    expect(parseClaudeOptions(["--json"])).toEqual({ rest: ["--json"] });
    expect(parseClaudeOptions(["--", "--detach"])).toEqual({ rest: ["--", "--detach"] });
    expect(parseClaudeOptions(["--detach", "--", "--json"])).toEqual({ detach: true, rest: ["--", "--json"] });
    expect(parseClaudeOptions(["--session", "q", "--detach", "--resume"])).toEqual({ session: "q", detach: true, rest: ["--resume"] });
  });
});

describe("suite claude --detach", () => {
  test("creates the session, exits 0, and NEVER execs the attach", async () => {
    const t = claudeDeps();
    expect(await runClaude(t.deps, { userArgs: [], force: false, detach: true, json: true })).toBe(0);
    expect(t.ran.some((a) => a.includes("new-session"))).toBe(true);
    expect(t.execed).toEqual([]);
    expect(t.ran.some((a) => a.includes("attach-session") || a.includes("attach"))).toBe(false);
    const doc = JSON.parse(t.json.join(""));
    expect(doc).toEqual({ session: expect.stringMatching(/^suite-/), state: "live", created: true, error: null });
    // stdout carries the document alone; human lines went through out/err.
    expect(t.json.length).toBe(1);
  });

  test("POSITIVE CONTROL: the same call without --detach execs the attach", async () => {
    const t = claudeDeps();
    expect(await runClaude(t.deps, { userArgs: [], force: false })).toBe(0);
    expect(t.execed.length).toBe(1);
    expect(t.execed[0]!).toContain("attach-session");
  });

  test("an already-live session: created false, still no attach", async () => {
    const t = claudeDeps();
    await runClaude(t.deps, { userArgs: [], force: false, detach: true });
    const second = claudeDeps();
    second.deps.tmux = t.deps.tmux;
    expect(await runClaude(second.deps, { userArgs: [], force: false, detach: true, json: true })).toBe(0);
    expect(JSON.parse(second.json.join(""))).toMatchObject({ state: "live", created: false, error: null });
    expect(second.execed).toEqual([]);
  });

  test("--detach with -p is refused (exit 2), nothing runs", async () => {
    const t = claudeDeps();
    expect(await runClaude(t.deps, { userArgs: ["-p", "hi"], force: false, detach: true, json: true })).toBe(DETACH_REFUSED_EXIT);
    expect(t.execed).toEqual([]);
    expect(JSON.parse(t.json.join("")).error.code).toBe("detach_with_print");
  });

  test("claude missing: no install prompt in detached mode, exit 4 naming suite harness install", async () => {
    const t = claudeDeps();
    const asked: string[] = [];
    t.deps.prompter = { ask: async (q) => (asked.push(q), "y"), askSecret: async () => "", say: () => {} };
    t.deps.tmux = { ...t.deps.tmux, which: (n) => (n === "claude" ? null : `/usr/bin/${n}`) };
    expect(await runClaude(t.deps, { userArgs: [], force: false, detach: true, json: true })).toBe(MISSING_AGENT_EXIT);
    expect(asked).toEqual([]);
    expect(JSON.parse(t.json.join("")).error.message).toContain("suite harness install claude --yes");
  });

  test("tmux missing: --detach fails (there is no session to leave), never a foreground exec", async () => {
    const t = claudeDeps();
    t.deps.tmux = { ...t.deps.tmux, which: (n) => (n === "tmux" ? null : `/usr/bin/${n}`) };
    expect(await runClaude(t.deps, { userArgs: [], force: false, detach: true, json: true })).toBe(1);
    expect(t.execed).toEqual([]);
    expect(JSON.parse(t.json.join("")).error.code).toBe("tmux_missing");
  });
});

/* ------------------------------------------------------------------------- */
/* codex                                                                      */
/* ------------------------------------------------------------------------- */

async function codexDeps(over: { tty: boolean; loggedIn?: boolean }) {
  const home = temp();
  const cfgDir = join(home, ".config", "suite");
  await Bun.write(join(cfgDir, "config.json"), JSON.stringify({ suiteUrl: "https://suite.example", runtimeId: "quasar-codex", headerNames: [] }));
  await Bun.write(join(cfgDir, "credentials.json"), JSON.stringify({ token: "tok-01a0d6b9", headers: {} }));
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  const ran: string[][] = [];
  const execed: string[][] = [];
  const err: string[] = [];
  const out: string[] = [];
  const tmux = statefulTmux("codex", ran);
  const d: CodexDeps = {
    env: { HOME: home, PATH: "/usr/bin", XDG_CONFIG_HOME: join(home, ".config") },
    cwd: () => join(home, "agent"),
    isTTY: () => over.tty,
    which: (b) => (b === "codex" ? "/usr/bin/codex" : null),
    run: async () => 0,
    capture: async () => ({ exitCode: over.loggedIn === false ? 1 : 0, stdout: "" }),
    stderr: { write: (t) => void err.push(t) },
    stdout: { write: (t) => void out.push(t) },
    session: {
      isTTY: () => over.tty,
      exec: async (argv: string[]) => {
        execed.push(argv);
        return 0;
      },
      stderr: { write: (t: string) => void err.push(t) },
    },
    tmux,
    platform: "linux",
  };
  return { d, ran, execed, err, out };
}

describe("suite codex --detach", () => {
  const saved = process.env.XDG_CONFIG_HOME;
  afterAll(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  });

  test("on a terminal: creates the session, exits 0, never execs the attach; --json prints {session, state, created}", async () => {
    const t = await codexDeps({ tty: true });
    expect(await runCodex(["--detach", "--json"], t.d)).toBe(0);
    expect(t.ran.some((a) => a.includes("new-session"))).toBe(true);
    expect(t.execed).toEqual([]);
    expect(t.out.length).toBe(1);
    expect(JSON.parse(t.out[0]!)).toEqual({ session: "suite-quasar", state: "live", created: true, error: null });
  });

  test("POSITIVE CONTROL: on a terminal WITHOUT --detach the attach is exec'd", async () => {
    const t = await codexDeps({ tty: true });
    expect(await runCodex([], t.d)).toBe(0);
    expect(t.execed.length).toBe(1);
    expect(t.execed[0]!).toContain("attach-session");
  });

  test("MEASURED: off a terminal, plain `suite codex` already returns without attaching (runInSession)", async () => {
    const t = await codexDeps({ tty: false });
    expect(await runCodex([], t.d)).toBe(0);
    expect(t.execed).toEqual([]);
    expect(t.out).toEqual([]);
  });

  test("not logged in: refused (exit 7) with a not_logged_in document, no device login started", async () => {
    const t = await codexDeps({ tty: true, loggedIn: false });
    const runs: string[][] = [];
    t.d.run = async (argv) => (runs.push(argv), 0);
    expect(await runCodex(["--detach", "--json"], t.d)).toBe(7);
    expect(runs).toEqual([]);
    const doc = JSON.parse(t.out[0]!);
    expect(doc.error.code).toBe("not_logged_in");
    expect(doc.error.message).toContain("suite login codex");
  });

  test("the session argv carries no token", async () => {
    const t = await codexDeps({ tty: false });
    await runCodex(["--detach"], t.d);
    const create = t.ran.find((a) => a.includes("new-session"))!;
    expect(create.join(" ")).not.toContain("tok-01a0d6b9");
  });

  test("--detach with --no-session is refused", async () => {
    const t = await codexDeps({ tty: false });
    expect(await runCodex(["--detach", "--no-session"], t.d)).toBe(2);
  });
});
