import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createStore } from "../src/secrets.ts";
import {
  AGENT_NAME,
  TMUX_MISSING_WARNING,
  attachArgv,
  classify,
  composeNewSession,
  descendants,
  detectState,
  killSessionArgv,
  liveTmuxDeps,
  looksLikeAgent,
  nameDigest,
  newSessionArgv,
  parsePanes,
  parseProcesses,
  planLaunch,
  quoteArgv,
  nestingPlan,
  sanitizeSessionName,
  sessionNameFor,
  sessionNameFromConfig,
  sessionOptionsArgv,
  singleQuote,
  type ProcessRow,
  type TmuxDeps,
} from "../src/tmux.ts";

/* ------------------------------------------------------------------------- */
/* Session naming                                                             */
/* ------------------------------------------------------------------------- */

describe("session naming", () => {
  test("the same directory always yields the same name, twice and after a rename of nothing", () => {
    const a = sessionNameFor({ naming: "cwd", cwd: "/projects/ledger" });
    const b = sessionNameFor({ naming: "cwd", cwd: "/projects/ledger" });
    expect(a).toBe(b);
    // A non-normalised spelling of the SAME directory is the same session: a
    // user who cds through a relative path must not get a second agent.
    expect(sessionNameFor({ naming: "cwd", cwd: "/projects/other/../ledger" })).toBe(a);
  });

  test("two projects sharing a basename do not collide", () => {
    const one = sessionNameFor({ naming: "cwd", cwd: "/a/ledger" });
    const two = sessionNameFor({ naming: "cwd", cwd: "/b/ledger" });
    expect(one).not.toBe(two);
    // Both still READ as the project, which is the point of the basename half.
    expect(one).toContain("ledger");
    expect(two).toContain("ledger");
    expect(nameDigest("/a/ledger")).not.toBe(nameDigest("/b/ledger"));
  });

  test("names are safe for tmux targets: no . or : survives", () => {
    const name = sessionNameFor({ naming: "cwd", cwd: "/srv/my.project:v2" });
    // `.` and `:` are tmux's own separators inside `-t session:window.pane`.
    expect(name).not.toContain(".");
    expect(name).not.toContain(":");
    expect(name).not.toMatch(/\s/);
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    // The sanitiser cannot merge two distinct directories, because the
    // discriminating half is a hash of the unsanitised absolute path.
    expect(name).not.toBe(sessionNameFor({ naming: "cwd", cwd: "/srv/my-project-v2" }));
  });

  test("sanitize collapses runs and trims, and never returns an empty name", () => {
    expect(sanitizeSessionName("a...b")).toBe("a-b");
    expect(sanitizeSessionName("...")).toBe("session");
    expect(sanitizeSessionName("  spaced name ")).toBe("spaced-name");
    expect(sanitizeSessionName("keep_me-1")).toBe("keep_me-1");
  });

  test("the runtime rule is available, and an explicit name beats both rules", () => {
    const rt = sessionNameFor({
      naming: "runtime",
      cwd: "/projects/ledger",
      runtimeId: "runtime_00000000-0000-0000-0000-000000000000",
    });
    expect(rt).toBe("suite-runtime_00000000-0000-0000-0000-000000000000");
    // Same runtime, different directory, SAME session — the collision that
    // makes this rule non-default, asserted rather than asserted away.
    expect(
      sessionNameFor({ naming: "runtime", cwd: "/elsewhere", runtimeId: "runtime_00000000-0000-0000-0000-000000000000" }),
    ).toBe(rt);

    expect(sessionNameFor({ naming: "cwd", cwd: "/projects/ledger", explicit: "my session.2" })).toBe("my-session-2");
  });

  test("the persisted preference is what selects the rule", () => {
    const base = { suiteUrl: "https://suite.example.invalid", runtimeId: "runtime_1", headerNames: [] };
    expect(sessionNameFromConfig({ ...base, sessionNaming: "cwd" }, "/projects/ledger")).toBe(
      sessionNameFor({ naming: "cwd", cwd: "/projects/ledger" }),
    );
    expect(sessionNameFromConfig({ ...base, sessionNaming: "runtime" }, "/projects/ledger")).toBe("suite-runtime_1");
    // A per-invocation override, which is a different request from changing
    // the rule and therefore is not persisted here.
    expect(sessionNameFromConfig({ ...base, sessionNaming: "cwd" }, "/projects/ledger", "scratch")).toBe("scratch");
  });

  test('sessionNaming "runtime" without a runtime id fails loudly', () => {
    expect(() => sessionNameFor({ naming: "runtime", cwd: "/projects/ledger" })).toThrow(/suite init/);
  });
});

/* ------------------------------------------------------------------------- */
/* Argv composition — pure                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Every shape that breaks a naive implementation, in one array. It is reused
 * by the pure test AND by the round trip through a real tmux below, so the
 * composition claim and the delivery claim are made about the same input.
 */
const HAZARD_ARGS = [
  "--continue",
  "-p",
  "two words",
  "it's quoted",
  'say "hi"',
  "$VAR ${OTHER} `cmd`",
  "-",
  "line one\nline two",
  "back\\slash",
  "semi; rm -rf /",
];

describe("argv composition", () => {
  test("the user's arguments appear as separate argv elements, byte for byte", () => {
    const argv = newSessionArgv({ session: "suite-test", command: ["claude", ...HAZARD_ARGS] });
    expect(argv.slice(0, 5)).toEqual(["tmux", "new-session", "-d", "-s", "suite-test"]);
    expect(argv[5]).toBe("claude");
    // The whole point: reconstructing the user's args from the composed argv
    // returns EXACTLY what was passed. No escaping, no splitting, no loss.
    expect(argv.slice(6)).toEqual(HAZARD_ARGS);
    expect(argv.join(" ")).toContain("line one\nline two");
  });

  test("the command is placed after every tmux option, so a leading - is never a tmux flag", () => {
    const argv = newSessionArgv({ session: "s", command: ["claude", "-p"], cwd: "/w" });
    expect(argv).toEqual(["tmux", "new-session", "-d", "-s", "s", "-c", "/w", "claude", "-p"]);
    // tmux stops option parsing at the first operand; `-p` sits after `claude`.
    expect(argv.indexOf("-p")).toBeGreaterThan(argv.indexOf("claude"));
  });

  test("-d is always present: creation is detached, attaching is a separate decision", () => {
    expect(newSessionArgv({ session: "s", command: ["claude"] })).toContain("-d");
  });

  test("an empty command is refused rather than composed into a bare tmux call", () => {
    expect(() => newSessionArgv({ session: "s", command: [] })).toThrow();
  });

  test("the audited shell quoter survives everything the pure argv path avoids", () => {
    expect(singleQuote("it's")).toBe("'it'\\''s'");
    expect(singleQuote("$VAR")).toBe("'$VAR'");
    for (const arg of HAZARD_ARGS) {
      // Round trip through a real shell: `printf %s` of the quoted form must
      // return the original bytes, otherwise the escaping is wrong.
      const p = Bun.spawnSync(["/bin/sh", "-c", `printf %s ${singleQuote(arg)}`], { stdout: "pipe" });
      expect(new TextDecoder().decode(p.stdout)).toBe(arg);
    }
    expect(quoteArgv(["a b", "c"])).toBe("'a b' 'c'");
  });
});

describe("no secret ever reaches a tmux command line", () => {
  const TOKEN = "invented-token-value-not-a-real-credential";
  const HEADER = "invented-header-value";

  test("a composed argv carrying a stored secret is refused", () => {
    const store = createStore({ token: TOKEN, headers: { "X-Example-Header": HEADER } });
    expect(() =>
      composeNewSession({ session: "s", command: ["claude", "--auth", TOKEN] }, store),
    ).toThrow(/world-readable/);
    expect(() =>
      composeNewSession({ session: "s", command: ["claude", `--header=X-Example-Header: ${HEADER}`] }, store),
    ).toThrow();
  });

  test("a clean argv passes, and contains no value from the credential store", () => {
    const store = createStore({ token: TOKEN, headers: { "X-Example-Header": HEADER } });
    const argv = composeNewSession({ session: "suite-x", command: ["claude", "--continue"] }, store);
    for (const secret of store.values()) {
      expect(argv.some((a) => a.includes(secret))).toBe(false);
    }
    expect(argv).toEqual(["tmux", "new-session", "-d", "-s", "suite-x", "claude", "--continue"]);
    // Nothing in this module composes a send-keys argv at all: typing a secret
    // into a live shell would put it in the shell's history as well as ps.
    expect(argv).not.toContain("send-keys");
  });
});

/* ------------------------------------------------------------------------- */
/* Three-way classification — pure                                            */
/* ------------------------------------------------------------------------- */

function proc(pid: number, ppid: number, comm: string, args = comm): ProcessRow {
  return { pid, ppid, comm, args };
}

describe("classification", () => {
  test("an absent session is NONE even when an agent is running elsewhere", () => {
    const panes = [{ session: "suite-other", pid: 10, command: "bash" }];
    const ps = [proc(10, 1, "bash"), proc(11, 10, "claude")];
    expect(classify(panes, ps, "suite-mine")).toBe("none");
  });

  test("an agent nested below the pane shell is LIVE — the pane command alone says bash", () => {
    const panes = [{ session: "s", pid: 10, command: "bash" }];
    const ps = [proc(10, 1, "bash"), proc(11, 10, "node", "node /opt/agent/node_modules/.bin/claude --continue")];
    // Matching only pane_current_command would call this stale and send the
    // user to start a second agent on top of a running one.
    expect(classify(panes, ps, "s")).toBe("live");
  });

  test("a session whose shell outlived its agent is STALE, not LIVE", () => {
    const panes = [{ session: "s", pid: 10, command: "bash" }];
    const ps = [proc(10, 1, "bash"), proc(12, 10, "sleep")];
    expect(classify(panes, ps, "s")).toBe("stale");
  });

  test("the walk reaches a grandchild, and stops at the tree it was given", () => {
    const ps = [proc(10, 1, "bash"), proc(11, 10, "sh"), proc(12, 11, "claude"), proc(20, 1, "claude")];
    expect(descendants(ps, [10]).map((p) => p.pid)).toEqual([10, 11, 12]);
    expect(classify([{ session: "s", pid: 10, command: "bash" }], ps, "s")).toBe("live");
    // pid 20 is an agent, but not in this session's tree; a session with only
    // an unrelated agent on the box is stale.
    expect(classify([{ session: "s", pid: 30, command: "bash" }], ps, "s")).toBe("stale");
  });

  test("looksLikeAgent matches a native binary and a JS entrypoint, and nothing else", () => {
    expect(looksLikeAgent(proc(1, 0, "claude", "claude --continue"))).toBe(true);
    expect(looksLikeAgent(proc(1, 0, "node", "node /usr/local/lib/node_modules/.bin/claude --continue"))).toBe(true);
    expect(looksLikeAgent(proc(1, 0, "bash", "bash -l"))).toBe(false);
    expect(looksLikeAgent(proc(1, 0, "claudette", "claudette"))).toBe(false);
    expect(AGENT_NAME).toBe("claude");
  });

  test("the pane and process parsers survive real-shaped output", () => {
    const panes = parsePanes("s\t101\tbash\nother\t202\tnode\n\nmalformed line\n");
    expect(panes).toEqual([
      { session: "s", pid: 101, command: "bash" },
      { session: "other", pid: 202, command: "node" },
    ]);
    const ps = parseProcesses("  101   1 bash bash -l\n 102 101 claude claude --continue\nheader junk\n");
    expect(ps).toEqual([
      { pid: 101, ppid: 1, comm: "bash", args: "bash -l" },
      { pid: 102, ppid: 101, comm: "claude", args: "claude --continue" },
    ]);
  });
});

/* ------------------------------------------------------------------------- */
/* $TMUX nesting, and a missing tmux                                          */
/* ------------------------------------------------------------------------- */

function fakeDeps(over: Partial<TmuxDeps> = {}): TmuxDeps {
  return {
    env: {},
    which: () => "/usr/bin/tmux",
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    ...over,
  };
}

describe("$TMUX nesting", () => {
  test("outside tmux we attach", () => {
    const plan = nestingPlan("suite-x", {});
    expect(plan.kind).toBe("attach");
    expect(plan.kind === "attach" && plan.argv).toEqual(attachArgv("suite-x"));
  });

  test("inside tmux we switch-client, and never compose an attach", () => {
    const plan = nestingPlan("suite-x", { TMUX: "/private/tmp/tmux-501/default,123,0" });
    expect(plan.kind).toBe("switch");
    const argv = plan.kind === "switch" ? plan.argv : [];
    expect(argv).toEqual(["tmux", "switch-client", "-t", "suite-x"]);
    expect(argv).not.toContain("attach-session");
    expect(argv).not.toContain("new-session");
  });

  test("when switching is not allowed we refuse with the command to run, never nesting", () => {
    const plan = nestingPlan("suite-x", { TMUX: "/private/tmp/tmux-501/default,123,0" }, false);
    expect(plan.kind).toBe("refuse");
    const message = plan.kind === "refuse" ? plan.message : "";
    expect(message).toContain("refusing to nest");
    expect(message).toContain("tmux switch-client -t suite-x");
  });

  test("an empty TMUX is not inside tmux", () => {
    expect(nestingPlan("s", { TMUX: "" }).kind).toBe("attach");
  });
});

describe("tmux absent", () => {
  const store = createStore();

  test("the fallback emits the warning — it is asserted, not assumed", () => {
    const warned: string[] = [];
    const plan = planLaunch(
      { session: "s", command: ["claude", "--continue"], warn: (l) => warned.push(l), store },
      fakeDeps({ which: () => null }),
    );
    expect(plan.kind).toBe("direct");
    expect(warned.length).toBe(1);
    const text = warned.join("\n");
    expect(text).toBe(TMUX_MISSING_WARNING);
    // The warning must name the CONSEQUENCE and the REMEDY, not merely exist.
    expect(text).toContain("KILLED when this terminal closes");
    expect(text).toContain("install tmux");
    expect(plan.kind === "direct" && plan.argv).toEqual(["claude", "--continue"]);
  });

  test("with tmux present nothing is warned and the tmux path is taken", () => {
    const warned: string[] = [];
    const plan = planLaunch(
      { session: "suite-s", command: ["claude"], warn: (l) => warned.push(l), store },
      fakeDeps(),
    );
    expect(warned).toEqual([]);
    expect(plan.kind).toBe("tmux");
  });

  test("a scrubbed PATH finds no tmux, the same way a box that never had it would not", () => {
    expect(liveTmuxDeps({ PATH: "" }).which("tmux")).toBeNull();
  });

  test("detection on a box without tmux is NONE, and asks tmux nothing at all", async () => {
    let called = 0;
    const state = await detectState(
      "s",
      fakeDeps({
        which: () => null,
        run: async () => {
          called++;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    );
    expect(state).toBe("none");
    expect(called).toBe(0);
  });
});

/* ------------------------------------------------------------------------- */
/* Against a REAL tmux                                                        */
/* ------------------------------------------------------------------------- */

/**
 * The integration tests run against a tmux server on a PRIVATE socket
 * directory ($TMUX_TMPDIR). Nothing they list, create or kill can touch a
 * session belonging to anyone else on this machine — which is why cleanup can
 * be `kill-session -t <name>` for names we created, and never `kill-server`
 * and never a pattern kill.
 */
const SOCKET_DIR = mkdtempSync(resolve(tmpdir(), "suite-cli-tmux-"));
const STUB_DIR = mkdtempSync(resolve(tmpdir(), "suite-cli-stub-"));
const TMUX_ENV = { ...process.env, TMUX_TMPDIR: SOCKET_DIR, TMUX: "" };
const deps = liveTmuxDeps(TMUX_ENV);
const HAVE_TMUX = deps.which("tmux") !== null;
const created = new Set<string>();

function uniqueSession(label: string): string {
  const name = `suitecli-test-${label}-${Math.random().toString(36).slice(2, 10)}`;
  created.add(name);
  return name;
}

/** An executable literally named `claude`, so ps reports comm=claude. */
function agentStub(): string {
  const path = resolve(STUB_DIR, "claude");
  Bun.spawnSync(["cp", "/bin/sleep", path]);
  chmodSync(path, 0o755);
  return path;
}

/** A bun script that records its own argv as JSON, then stays alive. */
function recordingStub(outFile: string): string {
  const path = resolve(STUB_DIR, "record.ts");
  Bun.write(
    path,
    [
      "#!/usr/bin/env bun",
      `await Bun.write(${JSON.stringify(outFile)}, JSON.stringify(Bun.argv.slice(2)));`,
      "await new Promise(() => {});",
      "",
    ].join("\n"),
  );
  return path;
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > deadline) return v;
    await Bun.sleep(100);
  }
}

afterAll(async () => {
  for (const name of created) await deps.run(killSessionArgv(name));
  rmSync(SOCKET_DIR, { recursive: true, force: true });
  rmSync(STUB_DIR, { recursive: true, force: true });
});

/**
 * A skipped integration suite is a green run that proves nothing about the one
 * claim this stage makes. `describe.if` would hide that, so absence of tmux is
 * a FAILURE here unless a reader deliberately opts out.
 */
test("the real-tmux tests below are not silently skipped", () => {
  expect(HAVE_TMUX || process.env.SUITE_CLI_ALLOW_NO_TMUX === "1").toBe(true);
});

describe.if(HAVE_TMUX)("against a real tmux", () => {
  test(
    "arguments reach the process inside the pane byte for byte",
    async () => {
      const out = resolve(STUB_DIR, "argv.bin");
      rmSync(out, { force: true });
      const session = uniqueSession("argv");
      const argv = newSessionArgv({
        session,
        command: [deps.which("bun") ?? "bun", recordingStub(out), ...HAZARD_ARGS],
      });
      const r = await deps.run(argv);
      expect(r.stderr + r.stdout).not.toContain("usage:");
      expect(r.exitCode).toBe(0);

      const text = await until(
        async () => (await Bun.file(out).exists()) ? await Bun.file(out).text() : null,
        (t) => t !== null,
      );
      expect(text).not.toBeNull();
      // The claim: what tmux handed the process is EXACTLY what we composed.
      // No word splitting on the spaces, no shell eating the quotes or `$VAR`,
      // no flag parsing of the leading `-`, no truncation at the newline.
      expect(JSON.parse(text as string)).toEqual(HAZARD_ARGS);
    },
    30_000,
  );

  test(
    "LIVE, then STALE after the agent dies but the shell does not, then NONE",
    async () => {
      const session = uniqueSession("state");
      const pidFile = resolve(STUB_DIR, `${session}.pid`);
      const stub = agentStub();

      // NONE before it exists — and the name is absent, not merely idle.
      expect(await detectState(session, deps)).toBe("none");

      // The pane runs a plain shell that backgrounds the agent stub and then
      // sleeps. That shape is built DELIBERATELY so the shell can outlive the
      // agent: it is the only way to reach STALE on purpose rather than hoping
      // the scheduler produces it.
      const script = `${JSON.stringify(stub)} 900 & echo $! > ${JSON.stringify(pidFile)}; sleep 900`;
      const start = await deps.run(newSessionArgv({ session, command: ["/bin/sh", "-c", script] }));
      expect(start.exitCode).toBe(0);

      expect(await until(() => detectState(session, deps), (s) => s === "live")).toBe("live");

      // Kill ONLY the stub, by the pid it recorded. Not a pattern, not a name.
      const pid = (await Bun.file(pidFile).text()).trim();
      expect(pid).toMatch(/^\d+$/);
      expect(Bun.spawnSync(["kill", pid]).exitCode).toBe(0);

      const stale = await until(() => detectState(session, deps), (s) => s === "stale");
      expect(stale).toBe("stale");

      // The corpse still answers yes to the question we deliberately do not
      // ask. This is the whole reason detection walks the process tree.
      const has = await deps.run(["tmux", "has-session", "-t", session]);
      expect(has.exitCode).toBe(0);

      await deps.run(killSessionArgv(session));
      created.delete(session);
      expect(await until(() => detectState(session, deps), (s) => s === "none")).toBe("none");
    },
    60_000,
  );

  test(
    "a session name with tmux metacharacters in the source path is addressable",
    async () => {
      const dir = resolve(STUB_DIR, "my.project:v2");
      mkdirSync(dir, { recursive: true });
      const name = sessionNameFor({ naming: "cwd", cwd: dir });
      created.add(name);
      const start = await deps.run(newSessionArgv({ session: name, command: ["/bin/sh", "-c", "sleep 900"], cwd: dir }));
      expect(start.exitCode).toBe(0);
      // `-t name` resolves to the session, not to a window inside a shorter one.
      expect(await detectState(name, deps)).toBe("stale");
      const kill = await deps.run(killSessionArgv(name));
      expect(kill.exitCode).toBe(0);
      created.delete(name);
    },
    30_000,
  );
});

/* ------------------------------------------------------------------------- */
/* Session options                                                            */
/* ------------------------------------------------------------------------- */

describe("session options", () => {
  test("mouse mode is set ON, scoped to the named session", () => {
    expect(sessionOptionsArgv("suite-ledger")).toEqual([
      ["tmux", "set-option", "-t", "suite-ledger", "mouse", "on"],
    ]);
  });

  test("no option is ever set globally", () => {
    /*
     * The whole point of the session scope: a `-g` here would reach tmux
     * sessions this CLI never created. Asserted on the argv rather than on the
     * comment, because a comment cannot be told from a described bug.
     */
    for (const argv of sessionOptionsArgv("suite-ledger")) {
      expect(argv).not.toContain("-g");
      expect(argv[2]).toBe("-t");
    }
  });
});
