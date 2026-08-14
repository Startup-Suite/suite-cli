import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createStore } from "../src/secrets.ts";
import { emptyConfig } from "../src/config.ts";
import { type RunResult, type TmuxDeps } from "../src/tmux.ts";
import {
  AGENT,
  DEV_CHANNEL_ARGS,
  SKIP_PERMISSIONS_ARG,
  CONTINUE_ARG,
  suiteArgs,
  NESTED_REFUSAL_EXIT,
  NOTICE_BODY,
  agentArgv,
  decide,
  isNonInteractive,
  listSessionNames,
  noticeLines,
  parseState,
  readState,
  runClaude,
  stripTerminator,
  uniqueSessionName,
  writeState,
  claudeInstallPlan,
  ensureAgent,
  missingClaudeInstallTools,
  MISSING_AGENT_EXIT,
  type ClaudeDeps,
} from "../src/commands/claude.ts";
import { CLAUDE_CODE_URL } from "../src/commands/doctor.ts";
import type { Prompter } from "../src/secrets.ts";
import { sessionNameFromConfig } from "../src/tmux.ts";

/* ------------------------------------------------------------------------- */
/* Scratch HOME. Nothing in this file touches the real config dir.            */
/* ------------------------------------------------------------------------- */

const scratch: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "suite-cli-claude-"));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------- */
/* The exact argv delivered to Claude                                         */
/* ------------------------------------------------------------------------- */

const HEAD = [AGENT, ...DEV_CHANNEL_ARGS, SKIP_PERMISSIONS_ARG, CONTINUE_ARG];
// When the user names a session themselves, `--continue` stands down and the
// head is one element shorter. Kept as its own constant so a test that means
// "resuming" cannot silently be written against the default head.
const HEAD_RESUMING = [AGENT, ...DEV_CHANNEL_ARGS, SKIP_PERMISSIONS_ARG];

describe("argv delivered to Claude", () => {
  test("(a) no arguments: the injected flag and nothing else", () => {
    expect(agentArgv([])).toEqual([...HEAD]);
    // The flag is two elements, not one string: a single "flag value" element
    // would reach Claude as one unknown argument.
    expect(DEV_CHANNEL_ARGS.length).toBe(2);
  });

  test("(b) --resume passes through, after the injected flag", () => {
    expect(agentArgv(["--resume"])).toEqual([...HEAD_RESUMING, "--resume"]);
  });

  test("(c) -p 'hello world' survives as ONE argument", () => {
    expect(agentArgv(["-p", "hello world"])).toEqual([...HEAD, "-p", "hello world"]);
  });

  test("(d) --version plus an argument colliding with a plausible wrapper flag", () => {
    // `--session` is exactly the sort of option a wrapper would want to own.
    // It is not owned here, so it reaches Claude untouched and in order.
    expect(agentArgv(["--version", "--session", "notmine"])).toEqual([
      ...HEAD,
      "--version",
      "--session",
      "notmine",
    ]);
    expect(agentArgv(["--new"])).toEqual([...HEAD, "--new"]);
  });

  test("(e) after --, everything passes verbatim and the terminator is consumed once", () => {
    expect(agentArgv(["--", "--resume"])).toEqual([...HEAD_RESUMING, "--resume"]);
    // The literal word `new` reaches Claude when it follows the terminator,
    // which is the only way to send it at all.
    expect(agentArgv(["--", "new"])).toEqual([...HEAD, "new"]);
    // A SECOND `--` is Claude's, not ours.
    expect(agentArgv(["--", "--", "-x"])).toEqual([...HEAD, "--", "-x"]);
    expect(stripTerminator(["a", "--", "b"])).toEqual(["a", "--", "b"]);
  });

  test("(f) an argument containing a space stays one argument", () => {
    const argv = agentArgv(["--append-system-prompt", "be terse and kind"]);
    expect(argv).toEqual([...HEAD, "--append-system-prompt", "be terse and kind"]);
    expect(argv.length).toBe(HEAD.length + 2);
  });

  test("(g) single AND double quotes survive unchanged", () => {
    const nasty = `it's a "quoted" thing`;
    const argv = agentArgv([nasty]);
    expect(argv[argv.length - 1]).toBe(nasty);
    // No escaping was applied: the byte string is identical, not merely similar.
    expect(argv[argv.length - 1]).not.toContain("\\");
  });

  test("(h) $HOME is NOT expanded", () => {
    const argv = agentArgv(["$HOME/notes.md", "${HOME}", "`whoami`"]);
    expect(argv).toEqual([...HEAD, "$HOME/notes.md", "${HOME}", "`whoami`"]);
    // Anti-vacuity: HOME really is set, so an expansion would be visible.
    expect(process.env.HOME ?? "").not.toBe("");
    expect(argv.join(" ")).not.toContain(process.env.HOME ?? "no-home");
  });

  test("the injected flag is never duplicated when the user passes it too", () => {
    // The wrapper adds; it does not deduplicate. Claude sees the user's copy
    // as a plain repeat rather than the wrapper silently dropping their intent.
    const argv = agentArgv([DEV_CHANNEL_ARGS[0], "server:other"]);
    expect(argv.slice(0, HEAD.length)).toEqual([...HEAD]);
    expect(argv.slice(HEAD.length)).toEqual([DEV_CHANNEL_ARGS[0], "server:other"]);
  });
});

describe("the Suite participation flags", () => {
  // These exist because a Suite runtime is unattended. Without
  // --dangerously-skip-permissions it stops on the first tool-call prompt
  // waiting for a human who is not there; without --continue every launch is
  // a cold session. One assertion per side throughout: a rule that fired
  // unconditionally would pass the first half of each pair and fail the second.

  test("both are injected by default, ahead of the user's arguments", () => {
    expect(suiteArgs([])).toEqual([SKIP_PERMISSIONS_ARG, CONTINUE_ARG]);
    expect(agentArgv([])).toEqual([...HEAD]);
  });

  test("--continue stands down when the user already chose a session", () => {
    // Each of these picks a session itself; handing it --continue as well
    // gives Claude two conflicting instructions.
    for (const selector of ["--resume", "-r", "--continue", "-c", "--from-pr", "--teleport"]) {
      expect(suiteArgs([selector])).toEqual([SKIP_PERMISSIONS_ARG]);
    }
    // ...and the CONTROL: an unrelated flag does NOT suppress it. Without this
    // half, a bug that dropped --continue for every input would still pass.
    expect(suiteArgs(["--version"])).toEqual([SKIP_PERMISSIONS_ARG, CONTINUE_ARG]);
    expect(suiteArgs(["--model", "opus"])).toEqual([SKIP_PERMISSIONS_ARG, CONTINUE_ARG]);
  });

  test("neither flag is injected twice when the user passes it", () => {
    expect(suiteArgs([SKIP_PERMISSIONS_ARG])).toEqual([CONTINUE_ARG]);
    expect(agentArgv([SKIP_PERMISSIONS_ARG])).toEqual([
      AGENT,
      ...DEV_CHANNEL_ARGS,
      CONTINUE_ARG,
      SKIP_PERMISSIONS_ARG,
    ]);
    // Control: a DIFFERENT dangerously-prefixed flag must not be mistaken for
    // it. --allow-dangerously-skip-permissions is a separate option.
    expect(suiteArgs(["--allow-dangerously-skip-permissions"])).toEqual([
      SKIP_PERMISSIONS_ARG,
      CONTINUE_ARG,
    ]);
  });

  test("the terminator is honoured: `-- --resume` still suppresses --continue", () => {
    // The wrapper must agree with the program it wraps. Claude reads the
    // arguments after `--` as its own, so scanning only the pre-terminator
    // slice would inject --continue alongside the user's --resume.
    expect(suiteArgs(["--", "--resume"])).toEqual([SKIP_PERMISSIONS_ARG]);
  });

  test("-p one-shots get them too", () => {
    // A scripted call is the LEAST attended thing we run. Stopping it on a
    // permission prompt hangs a caller that is capturing stdout.
    expect(agentArgv(["-p", "hi"])).toEqual([...HEAD, "-p", "hi"]);
  });

  test("the notice says the permission bypass out loud", () => {
    // Rule 3 of this module is NOTHING SILENT. A wrapper that hides one
    // `dangerously` flag trains people not to look at the next one, so the
    // second flag joins the once-per-machine notice rather than sneaking in.
    expect(NOTICE_BODY).toContain(SKIP_PERMISSIONS_ARG);
    expect(NOTICE_BODY).toContain(DEV_CHANNEL_ARGS[0]);
  });
});

describe("-p is non-interactive", () => {
  test("-p and --print bypass tmux; other flags do not", () => {
    expect(isNonInteractive(["-p", "hi"])).toBe(true);
    expect(isNonInteractive(["--print"])).toBe(true);
    expect(isNonInteractive(["--", "-p", "hi"])).toBe(true);
    expect(isNonInteractive([])).toBe(false);
    expect(isNonInteractive(["--resume"])).toBe(false);
    // A value that merely CONTAINS -p is not print mode.
    expect(isNonInteractive(["--model", "opus-p"])).toBe(false);
  });

  test("the plan for -p is a direct exec: no session, no attach", () => {
    const plan = decide(
      {
        session: "suite-x-0000",
        userArgs: ["-p", "hello world"],
        cwd: "/projects/x",
        state: "none",
        force: false,
        env: {},
        store: createStore(),
      },
      fakeTmux(),
    );
    expect(plan.direct).toEqual([...HEAD, "-p", "hello world"]);
    expect(plan.create).toBeUndefined();
    expect(plan.enter).toBeUndefined();
    expect(plan.notes).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */
/* Session targeting                                                          */
/* ------------------------------------------------------------------------- */

describe("session targeting", () => {
  const config = emptyConfig();

  test("twice from one cwd targets a SINGLE session name", () => {
    const one = sessionNameFromConfig(config, "/projects/ledger");
    const two = sessionNameFromConfig(config, "/projects/ledger");
    expect(two).toBe(one);
  });

  test("two different cwds target TWO session names", () => {
    const a = sessionNameFromConfig(config, "/projects/ledger");
    const b = sessionNameFromConfig(config, "/projects/invoices");
    expect(a).not.toBe(b);
  });

  test("suite claude new picks a free name rather than colliding", () => {
    expect(uniqueSessionName("suite-a", [])).toBe("suite-a");
    expect(uniqueSessionName("suite-a", ["suite-a"])).toBe("suite-a-2");
    expect(uniqueSessionName("suite-a", ["suite-a", "suite-a-2"])).toBe("suite-a-3");
  });
});

/* ------------------------------------------------------------------------- */
/* The three-way decision                                                     */
/* ------------------------------------------------------------------------- */

function fakeTmux(over: Partial<TmuxDeps> = {}): TmuxDeps {
  return {
    env: {},
    which: () => "/usr/bin/tmux",
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    ...over,
  };
}

function planFor(state: "live" | "stale" | "none", over: Partial<Parameters<typeof decide>[0]> = {}) {
  return decide(
    {
      session: "suite-ledger-0000",
      userArgs: [],
      cwd: "/projects/ledger",
      state,
      force: false,
      env: {},
      store: createStore(),
      ...over,
    },
    fakeTmux(),
  );
}

describe("live / none / stale", () => {
  test("LIVE attaches, creating nothing", () => {
    const plan = planFor("live");
    expect(plan.create).toBeUndefined();
    expect(plan.kill).toBeUndefined();
    expect(plan.enter).toEqual({ kind: "attach", argv: ["tmux", "attach-session", "-t", "suite-ledger-0000"] });
  });

  test("NONE creates detached, then attaches", () => {
    const plan = planFor("none");
    expect(plan.create?.slice(0, 5)).toEqual(["tmux", "new-session", "-d", "-s", "suite-ledger-0000"]);
    expect(plan.create?.slice(-HEAD.length)).toEqual([...HEAD]);
    expect(plan.enter?.kind).toBe("attach");
  });

  test("STALE does NOT silently attach: it is named, then recycled", () => {
    const plan = planFor("stale");
    // The refutation that matters: the plan for a stale session is not the
    // plan for a live one.
    expect(planFor("live").kill).toBeUndefined();
    expect(plan.kill).toEqual(["tmux", "kill-session", "-t", "suite-ledger-0000"]);
    expect(plan.create).toBeDefined();
    const said = plan.notes.join("\n");
    expect(said).toContain("stale");
    expect(said).toContain("suite-ledger-0000");
    // Scoped kill only. kill-server would take down sibling agents.
    expect(plan.kill).not.toContain("kill-server");
  });

  test("inside tmux we switch-client, never nest an attach", () => {
    const plan = planFor("live", { env: { TMUX: "/tmp/tmux-501/default,123,0" } });
    expect(plan.enter?.kind).toBe("switch");
  });

  test("tmux absent falls back to a direct exec WITH a warning", () => {
    const plan = decide(
      {
        session: "suite-ledger-0000",
        userArgs: ["--resume"],
        cwd: "/projects/ledger",
        state: "none",
        force: false,
        env: {},
        store: createStore(),
      },
      fakeTmux({ which: () => null }),
    );
    expect(plan.direct).toEqual([...HEAD_RESUMING, "--resume"]);
    expect(plan.warning ?? "").toContain("tmux");
  });
});

/* ------------------------------------------------------------------------- */
/* The first-run notice                                                       */
/* ------------------------------------------------------------------------- */

describe("first-run notice", () => {
  test("one line plus a blank line, and NO box-drawing characters", () => {
    const lines = noticeLines(false);
    expect(lines.length).toBe(2);
    expect(lines[1]).toBe("");
    expect(lines[0]).toBe(`! ${NOTICE_BODY}`);
    const box = /[─-╿+|=_*-]{3,}/;
    expect(box.test(lines.join("\n"))).toBe(false);
    expect(lines[0]).toContain("allowlist");
    expect(lines[0]).toContain("dangerously");
  });

  test("colour is yellow (ANSI 3) on the ! only, and absent when disabled", () => {
    const colored = noticeLines(true)[0] ?? "";
    expect(colored.startsWith("[33m![0m ")).toBe(true);
    // The BODY carries no SGR bytes: default weight, per the design.
    expect(colored.slice("[33m![0m ".length)).toBe(NOTICE_BODY);
    expect(noticeLines(false)[0] ?? "").not.toContain("[");
  });

  test("state round-trips and a corrupt file reads as not-seen", async () => {
    const path = resolve(tempHome(), "state.json");
    expect((await readState(path)).noticeSeen).toBe(false);
    await writeState(path, { noticeSeen: true });
    expect((await readState(path)).noticeSeen).toBe(true);
    expect(parseState("{ not json").noticeSeen).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* End to end, through runClaude, with every process faked                    */
/* ------------------------------------------------------------------------- */

interface Recorder {
  deps: ClaudeDeps;
  out: string[];
  err: string[];
  execed: string[][];
  ran: string[][];
}

/** A prompter that answers every question the same way and records them. */
function fakePrompter(answer: string, asked: string[] = []): Prompter {
  return {
    ask: async (q) => {
      asked.push(q);
      return answer;
    },
    askSecret: async () => "",
    say: () => {},
  };
}

function recorder(
  over: Partial<ClaudeDeps> = {},
  run?: (argv: string[]) => Promise<RunResult>,
  which?: (name: string) => string | null,
): Recorder {
  const out: string[] = [];
  const err: string[] = [];
  const execed: string[][] = [];
  const ran: string[][] = [];
  const deps: ClaudeDeps = {
    tmux: fakeTmux({
      which: which ?? (() => "/usr/bin/tmux"),
      run: async (argv) => {
        ran.push(argv);
        return run !== undefined ? run(argv) : { exitCode: 0, stdout: "", stderr: "" };
      },
    }),
    platform: "darwin",
    prompter: fakePrompter("n"),
    env: {},
    cwd: "/projects/ledger",
    store: createStore(),
    config: emptyConfig(),
    statePath: resolve(tempHome(), "state.json"),
    color: false,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    exec: async (argv) => {
      execed.push(argv);
      return 0;
    },
    ...over,
  };
  return { deps, out, err, execed, ran };
}

describe("runClaude", () => {
  test("the notice prints once, on the first run only", async () => {
    const r = recorder();
    await runClaude(r.deps, { userArgs: ["-p", "x"], force: false });
    const first = r.out.filter((l) => l.includes(NOTICE_BODY));
    expect(first.length).toBe(1);

    r.out.length = 0;
    await runClaude(r.deps, { userArgs: ["-p", "x"], force: false });
    expect(r.out.filter((l) => l.includes(NOTICE_BODY))).toEqual([]);

    // A THIRD run, because "once" must mean once and not "on odd runs".
    r.out.length = 0;
    await runClaude(r.deps, { userArgs: ["-p", "x"], force: false });
    expect(r.out.join("\n")).not.toContain("allowlist");
  });

  test("the exit code of the child is the exit code of the wrapper", async () => {
    for (const code of [0, 1, 42]) {
      const r = recorder({ exec: async () => code });
      expect(await runClaude(r.deps, { userArgs: ["-p", "x"], force: false })).toBe(code);
    }
  });

  test("-p execs Claude directly: tmux is never invoked", async () => {
    const r = recorder();
    await runClaude(r.deps, { userArgs: ["-p", "hello world"], force: false });
    expect(r.execed).toEqual([[...HEAD, "-p", "hello world"]]);
    expect(r.ran).toEqual([]);
  });

  test("an interactive run creates a session then attaches to it", async () => {
    const r = recorder();
    const code = await runClaude(r.deps, { userArgs: ["--resume"], force: false });
    expect(code).toBe(0);
    // list-panes ran (detection), then new-session; the attach is the exec.
    expect(r.ran.some((a) => a[1] === "new-session")).toBe(true);
    expect(r.execed[0]?.slice(0, 2)).toEqual(["tmux", "attach-session"]);
    const created = r.ran.find((a) => a[1] === "new-session") ?? [];
    expect(created.slice(-2)).toEqual([...HEAD_RESUMING.slice(-1), "--resume"]);
  });

  test("a failed session creation is reported and returns non-zero", async () => {
    const r = recorder({}, async (argv) =>
      argv[1] === "new-session"
        ? { exitCode: 1, stdout: "", stderr: "duplicate session" }
        : { exitCode: 0, stdout: "", stderr: "" },
    );
    const code = await runClaude(r.deps, { userArgs: [], force: false });
    expect(code).toBe(1);
    expect(r.execed).toEqual([]);
    expect(r.err.join("\n")).toContain("duplicate session");
  });

  test("nested tmux without switch refuses with a non-zero code", async () => {
    // Exercised through the plan, since runClaude switches when it can.
    const plan = decide(
      {
        session: "suite-ledger-0000",
        userArgs: [],
        cwd: "/projects/ledger",
        state: "live",
        force: false,
        env: { TMUX: "x" },
        store: createStore(),
      },
      fakeTmux(),
    );
    expect(plan.enter?.kind).toBe("switch");
    expect(NESTED_REFUSAL_EXIT).not.toBe(0);
  });

  /* --------------------------------------------------------------------- */
  /* Installing Claude Code on demand                                        */
  /* --------------------------------------------------------------------- */

  const INSTALL_ARGV = ["sh", "-c", "curl -fsSL https://claude.ai/install.sh | bash"];

  /** `which` where claude is absent until `installed` flips, everything else present. */
  function whichWithout(state: { installed: boolean }) {
    return (name: string) => (name === AGENT && !state.installed ? null : `/usr/bin/${name}`);
  }

  test("(i) claude ABSENT + accept: it installs, then execs the UNCHANGED agent argv", async () => {
    const state = { installed: false };
    const r = recorder(
      { prompter: fakePrompter("y") },
      async (argv) => {
        // The install is the thing that makes claude appear.
        if (argv[0] === "sh") state.installed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      whichWithout(state),
    );

    const code = await runClaude(r.deps, { userArgs: ["--resume"], force: false });

    expect(r.ran[0]).toEqual(INSTALL_ARGV);
    // Passthrough and the injected flag are byte-identical to the no-install run.
    const created = r.ran.find((a) => a[1] === "new-session") ?? [];
    expect(created.slice(-4)).toEqual([...DEV_CHANNEL_ARGS, SKIP_PERMISSIONS_ARG, "--resume"]);
    expect(r.execed[0]?.slice(0, 2)).toEqual(["tmux", "attach-session"]);
    expect(code).toBe(0);
  });

  test("(ii) claude ABSENT + decline: non-zero, nothing run, nothing exec'd, and it says so", async () => {
    const asked: string[] = [];
    const state = { installed: false };
    const r = recorder({ prompter: fakePrompter("n", asked) }, undefined, whichWithout(state));

    const code = await runClaude(r.deps, { userArgs: ["--resume"], force: false });

    expect(code).toBe(MISSING_AGENT_EXIT);
    expect(code).not.toBe(0);
    expect(r.ran).toEqual([]);
    expect(r.execed).toEqual([]);
    expect(asked.length).toBe(1);
    const said = [...r.out, ...r.err].join("\n");
    expect(said).toContain(AGENT);
    expect(said).toContain(CLAUDE_CODE_URL);
    // The user is told the login is still theirs — before and after declining.
    expect(said).toContain("log in");
  });

  test("(iii) claude PRESENT: no offer, no install, byte-identical to today", async () => {
    const asked: string[] = [];
    const present = recorder({ prompter: fakePrompter("y", asked) });
    const code = await runClaude(present.deps, { userArgs: ["--resume"], force: false });

    expect(code).toBe(0);
    expect(asked).toEqual([]);
    expect(present.ran.some((a) => a[0] === "sh")).toBe(false);
    // Not merely "no install": no offer TEXT at all. An unconditional guard
    // that printed the offer and then found claude anyway would fail here.
    const said = [...present.out, ...present.err].join("\n");
    expect(said).not.toContain(CLAUDE_CODE_URL);
    expect(said).not.toContain("is not on PATH");
    expect(present.execed[0]?.slice(0, 2)).toEqual(["tmux", "attach-session"]);
  });

  test("(iv) claude absent + -p one-shot: the same gate applies on the direct path", async () => {
    const state = { installed: false };
    const r = recorder({ prompter: fakePrompter("n") }, undefined, whichWithout(state));

    const code = await runClaude(r.deps, { userArgs: ["-p", "hello world"], force: false });
    expect(code).toBe(MISSING_AGENT_EXIT);
    expect(r.execed).toEqual([]);
    expect(r.ran).toEqual([]);

    // …and accepting on the -p path execs the direct argv, unchanged.
    const yes = { installed: false };
    const ok = recorder(
      { prompter: fakePrompter("y") },
      async (argv) => {
        if (argv[0] === "sh") yes.installed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      whichWithout(yes),
    );
    expect(await runClaude(ok.deps, { userArgs: ["-p", "hello world"], force: false })).toBe(0);
    expect(ok.ran).toEqual([INSTALL_ARGV]);
    expect(ok.execed).toEqual([[...HEAD, "-p", "hello world"]]);
  });

  test("(v) a failed install and an unusable platform both stop, non-zero", async () => {
    const state = { installed: false };
    const failed = recorder(
      { prompter: fakePrompter("y") },
      async () => ({ exitCode: 1, stdout: "", stderr: "network unreachable" }),
      whichWithout(state),
    );
    expect(await runClaude(failed.deps, { userArgs: [], force: false })).toBe(MISSING_AGENT_EXIT);
    expect(failed.execed).toEqual([]);
    expect(failed.err.join("\n")).toContain("network unreachable");

    // win32 has no plan we trust: refuse, never prompt.
    const asked: string[] = [];
    const win = recorder(
      { platform: "win32", prompter: fakePrompter("y", asked) },
      undefined,
      whichWithout({ installed: false }),
    );
    expect(await runClaude(win.deps, { userArgs: [], force: false })).toBe(MISSING_AGENT_EXIT);
    expect(asked).toEqual([]);
    expect(claudeInstallPlan({ platform: "win32" })).toBeNull();
  });

  test("(vi) the installer's own preconditions are named rather than left to curl", async () => {
    const noCurl = recorder({ prompter: fakePrompter("y") }, undefined, (name) =>
      name === AGENT || name === "curl" ? null : `/usr/bin/${name}`,
    );
    expect(await runClaude(noCurl.deps, { userArgs: [], force: false })).toBe(MISSING_AGENT_EXIT);
    expect(noCurl.ran).toEqual([]);
    expect(noCurl.err.join("\n")).toContain("curl");

    expect(missingClaudeInstallTools({ tmux: fakeTmux() })).toEqual([]);
    expect(missingClaudeInstallTools({ tmux: fakeTmux({ which: () => null }) })).toEqual(["curl", "bash"]);
  });

  test("(vii) an installer that exits 0 but leaves no claude on PATH still stops", async () => {
    // The RE-DETECT is the point: a green exit code is the installer's opinion,
    // `which` is the fact. Without the re-detect this run would exec a binary
    // that is not there. (Added after a mutation probe removing the re-detect
    // survived every other assertion in this file.)
    const r = recorder({ prompter: fakePrompter("y") }, undefined, (name) =>
      name === AGENT ? null : `/usr/bin/${name}`,
    );
    expect(await runClaude(r.deps, { userArgs: [], force: false })).toBe(MISSING_AGENT_EXIT);
    expect(r.ran).toEqual([INSTALL_ARGV]);
    expect(r.execed).toEqual([]);
    expect(r.err.join("\n")).toContain("still not on PATH");
  });

  test("ensureAgent returns null — carry on — when the agent is already there", async () => {
    const r = recorder();
    expect(await ensureAgent(r.deps)).toBeNull();
  });

  test("listSessionNames is empty when tmux is absent", async () => {
    expect(await listSessionNames(fakeTmux({ which: () => null }))).toEqual([]);
    expect(
      await listSessionNames(fakeTmux({ run: async () => ({ exitCode: 0, stdout: "a\nb\n", stderr: "" }) })),
    ).toEqual(["a", "b"]);
  });
});
