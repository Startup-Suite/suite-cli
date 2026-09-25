import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  agentLine,
  agentNameForKind,
  formatAge,
  lastVerdict,
  readFileOrNull,
  recordedState,
  type StatusDeps,
  listSessionsArgv,
  ownSessions,
  parseSessions,
  runStatus,
  sessionLine,
} from "../src/commands/status.ts";
import type { DoctorDeps } from "../src/commands/doctor.ts";
import { CHANNEL_SERVER, TOOLS_SERVER } from "../src/commands/init.ts";
import { emptyConfig, type SuiteConfig } from "../src/config.ts";
import { SESSION_PREFIX, detectState, killSessionArgv, liveTmuxDeps, newSessionArgv } from "../src/tmux.ts";
import { rosterPath, serializeRoster, type RosterEntry } from "../src/roster.ts";
import { STAMP_FILE } from "../src/stamp.ts";
import { HERMES_AGENT_COMM } from "../src/commands/hermes.ts";
import { OPENCLAW_GATEWAY_COMM } from "../src/commands/openclaw.ts";

/** Invented, like every other fixture value in this public repository. */
const SUITE_URL = "https://suite.example.invalid";
const RUNTIME_ID = "runtime_00000000-0000-0000-0000-000000000000";
const TOKEN = "tok_fixture_never_printed_zzq7";
const NOW = 1_800_000_000;

function config(): SuiteConfig {
  return { ...emptyConfig(), suiteUrl: SUITE_URL, runtimeId: RUNTIME_ID };
}

interface FakeOptions {
  config?: SuiteConfig | null;
  tools?: string[];
  channel?: string;
  /** name → [ageSeconds, live?] */
  sessions?: Array<{ name: string; age: number; live: boolean }>;
}

function fakeDeps(options: FakeOptions = {}): DoctorDeps & { lines: string[] } {
  const tools = options.tools ?? ["claude", "tmux"];
  const sessions = options.sessions ?? [];
  const lines: string[] = [];

  const run = async (argv: string[]) => {
    const [bin, ...args] = argv;
    const name = (bin ?? "").split("/").pop() ?? "";
    const ok = { exitCode: 0, stdout: "", stderr: "" };
    if (name === "claude" && args[0] === "mcp" && args[1] === "list") {
      return {
        ...ok,
        stdout:
          `${CHANNEL_SERVER}: bun /opt/example/src/index.ts - ${options.channel ?? "✔ Connected"}\n` +
          `${TOOLS_SERVER}: ${SUITE_URL}/mcp (HTTP) - ✔ Connected\n`,
      };
    }
    if (name === "tmux" && args[0] === "list-sessions") {
      return { ...ok, stdout: sessions.map((s) => `${s.name}\t${NOW - s.age}`).join("\n") };
    }
    if (name === "tmux" && args[0] === "list-panes") {
      return { ...ok, stdout: sessions.map((s, i) => `${s.name}\t${100 + i}\t-sh`).join("\n") };
    }
    if (name === "ps") {
      const rows = sessions
        .map((s, i) => (s.live ? `  ${200 + i}  ${100 + i} claude claude\n` : ""))
        .join("");
      return { ...ok, stdout: `  100     1 sh -sh\n${rows}` };
    }
    return ok;
  };

  const which = (name: string) => (tools.includes(name) ? `/fixture/bin/${name}` : null);
  return {
    env: {},
    cwd: "/projects/example-ledger",
    run,
    which,
    exists: () => true,
    config: options.config === undefined ? config() : options.config,
    configFile: "/fixture/home/.config/suite/config.json",
    tmux: { env: {}, which, run },
    // `suite status` never probes; present because DoctorDeps requires it, and
    // a throw is the honest stand-in for "this surface does not make the call".
    probe: async () => {
      throw new Error("status does not probe the tools endpoint");
    },
    color: false,
    utf8: true,
    lines,
    out: (line) => void lines.push(line),
  };
}

async function status(options: FakeOptions = {}): Promise<{ text: string; code: number }> {
  const deps = fakeDeps(options);
  const code = await runStatus(deps, NOW);
  return { text: deps.lines.join("\n"), code };
}

describe("suite status", () => {
  test("names the runtime this box is federated as, and never the token", async () => {
    const deps = fakeDeps();
    deps.env = { SUITE_TOKEN: TOKEN };
    const code = await runStatus(deps, NOW);
    const text = deps.lines.join("\n");
    expect(code).toBe(0);
    expect(text).toContain(RUNTIME_ID);
    expect(text).toContain(SUITE_URL);
    expect(text).not.toContain(TOKEN);
    // Not even a prefix of it: a partial echo is still an echo.
    for (let n = 4; n <= TOKEN.length; n++) expect(text).not.toContain(TOKEN.slice(0, n));
  });

  test("an unfederated box says so and exits non-zero", async () => {
    const { text, code } = await status({ config: null });
    expect(code).toBe(1);
    expect(text).toContain("not federated");
    expect(text).toContain("suite init");
  });

  test("the channel is health-checked, not merely assumed from config", async () => {
    const connected = await status();
    expect(connected.text).toContain("connected");
    expect(connected.code).toBe(0);

    const broken = await status({ channel: "✘ Failed to connect" });
    expect(broken.text).toContain("not connected");
    expect(broken.code).toBe(1);

    // The established trap: `⏸ Pending approval` must not read as connected.
    const pending = await status({ channel: "⏸ Pending approval" });
    expect(pending.code).toBe(1);
    expect(pending.text).not.toContain("channel           connected");
  });

  test("sessions are listed with their three-way state and age, never as bare names", async () => {
    const { text, code } = await status({
      sessions: [
        { name: `${SESSION_PREFIX}-ledger-aaaaaaaa`, age: 7_200, live: true },
        { name: `${SESSION_PREFIX}-books-bbbbbbbb`, age: 45, live: false },
      ],
    });
    expect(text).toContain(`${SESSION_PREFIX}-ledger-aaaaaaaa`);
    expect(text).toContain("agent running");
    expect(text).toContain("2h");
    // A dead agent in a live shell is reported as such — the whole reason the
    // detection is three-way rather than has-session.
    expect(text).toContain("stale — shell alive, Claude dead");
    expect(text).toContain("45s");
    expect(code).toBe(1);
  });

  test("a stale session alone makes status exit non-zero", async () => {
    const live = await status({ sessions: [{ name: `${SESSION_PREFIX}-a-11111111`, age: 10, live: true }] });
    expect(live.code).toBe(0);
    const stale = await status({ sessions: [{ name: `${SESSION_PREFIX}-a-11111111`, age: 10, live: false }] });
    expect(stale.code).toBe(1);
  });

  test("other people's tmux sessions are none of our business", async () => {
    const { text } = await status({
      sessions: [
        { name: "someone-elses-work", age: 60, live: true },
        { name: `${SESSION_PREFIX}-mine-cccccccc`, age: 60, live: true },
      ],
    });
    expect(text).not.toContain("someone-elses-work");
    expect(text).toContain(`${SESSION_PREFIX}-mine-cccccccc`);
  });

  test("no tmux is stated rather than rendered as zero sessions", async () => {
    const { text } = await status({ tools: ["claude"] });
    expect(text).toContain("tmux is not installed");
    expect(text).not.toContain("sessions          none");
  });

  test("no sessions at all names the command that starts one", async () => {
    const { text } = await status();
    expect(text).toContain("suite claude starts one");
  });
});

describe("session listing primitives", () => {
  test("the listing asks tmux for the name and the creation time", () => {
    expect(listSessionsArgv()).toEqual(["tmux", "list-sessions", "-F", "#{session_name}\t#{session_created}"]);
  });

  test("malformed rows are dropped, not guessed at", () => {
    const rows = parseSessions(`suite-a-1\t1700000000\ngarbage\nsuite-b-2\tnot-a-number\n\n`);
    expect(rows).toEqual([{ name: "suite-a-1", created: 1_700_000_000 }]);
  });

  test("only our own prefix is ours", () => {
    const rows = [
      { name: `${SESSION_PREFIX}-x-1`, created: 1 },
      { name: "suitcase", created: 1 },
      { name: "work", created: 1 },
    ];
    expect(ownSessions(rows).map((r) => r.name)).toEqual([`${SESSION_PREFIX}-x-1`]);
  });

  test("age is coarse, because that is the question a reader has", () => {
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(59)).toBe("59s");
    expect(formatAge(60)).toBe("1m");
    expect(formatAge(3_599)).toBe("59m");
    expect(formatAge(3_600)).toBe("1h");
    expect(formatAge(86_400)).toBe("1d");
    expect(formatAge(-5)).toBe("0s");
  });

  test("a session line leads with a glyph, so colour is never the only signal", () => {
    const row = { name: "suite-a-1", created: NOW - 10 };
    const live = sessionLine(row, "live", NOW, { color: false, utf8: true });
    const stale = sessionLine(row, "stale", NOW, { color: false, utf8: true });
    expect(live).toContain("✔");
    expect(stale).toContain("✘");
    expect(sessionLine(row, "stale", NOW, { color: false, utf8: false })).toContain("X");
    // Off-TTY / NO_COLOR: not one escape byte.
    expect(stale).not.toMatch(/\[\d+m/);
  });
});

/* ------------------------------------------------------------------------- */
/* Stamped agents: hermes and openclaw (01a0d8f8 stage 5)                     */
/* ------------------------------------------------------------------------- */

describe("stamped-agent primitives", () => {
  test("each kind is looked for under its MEASURED process name", () => {
    expect(agentNameForKind("hermes")).toBe(HERMES_AGENT_COMM);
    expect(agentNameForKind("openclaw")).toBe(OPENCLAW_GATEWAY_COMM);
    expect(agentNameForKind("claude")).toBe("claude");
    expect(agentNameForKind("deepseek")).toBe("dsh");
  });

  /** A recorded agent with no session died; it did not never exist. */
  test("a recorded agent with no session is stale, never none", () => {
    expect(recordedState("none")).toBe("stale");
    expect(recordedState("stale")).toBe("stale");
    expect(recordedState("live")).toBe("live");
  });

  test("the verdict is the only thing read out of the stamp record", () => {
    const record = JSON.stringify({ harness: "hermes", tokenRef: "file:/srv/secret/tok", verdict: "fail" });
    expect(lastVerdict(record)).toBe("fail");
    expect(lastVerdict(null)).toBe("none");
    expect(lastVerdict("{nope")).toBe("unreadable");
    expect(lastVerdict(JSON.stringify({ verdict: "maybe" }))).toBe("unreadable");
  });

  test("an agent line names session, kind, state, verdict and root", () => {
    const line = agentLine(
      { session: "suite-scribe", kind: "hermes", root: "/srv/agents/scribe", state: "stale", verdict: "pass" },
      { color: false, utf8: true },
    );
    expect(line).toContain("✘");
    for (const part of ["suite-scribe", "hermes", "stale", "stamp pass", "/srv/agents/scribe"]) expect(line).toContain(part);
    expect(line).not.toMatch(/\[\d+m/);
  });
});

/**
 * Against a REAL tmux on a private socket ($TMUX_TMPDIR), as in tmux.test.ts:
 * nothing here can list, create or kill anyone else's session.
 *
 * The gateway is a stub: `/bin/sleep` copied to a file named `hermes`, so `ps`
 * reports comm=hermes exactly as the measured gateway does. The pane runs a
 * shell that starts the stub and WAITS on it — the shape of the real session,
 * whose pane process is the gateway relaunch awaiting its gateway child.
 * Killing the stub by pid is the real kill; the test does not construct a
 * state and hand it to status.
 */
const SOCKET_DIR = mkdtempSync(resolve(tmpdir(), "suite-status-tmux-"));
const WORK_DIR = mkdtempSync(resolve(tmpdir(), "suite-status-work-"));
const TMUX_ENV = { ...process.env, TMUX_TMPDIR: SOCKET_DIR, TMUX: "" };
const realTmux = liveTmuxDeps(TMUX_ENV);
const HAVE_TMUX = realTmux.which("tmux") !== null;
const createdSessions = new Set<string>();

afterAll(async () => {
  for (const name of createdSessions) await realTmux.run(killSessionArgv(name));
  rmSync(SOCKET_DIR, { recursive: true, force: true });
  rmSync(WORK_DIR, { recursive: true, force: true });
});

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > deadline) return v;
    await Bun.sleep(100);
  }
}

/** A stamped hermes root with a roster entry, on disk. */
function stampedHermes(label: string, verdict: string): { session: string; home: string; root: string; stub: string } {
  const session = `${SESSION_PREFIX}-s5-${label}-${Math.random().toString(36).slice(2, 8)}`;
  createdSessions.add(session);
  const home = join(WORK_DIR, session, "home");
  const root = join(WORK_DIR, session, "scribe");
  const bin = join(WORK_DIR, session, "bin");
  for (const d of [home, root, bin]) mkdirSync(d, { recursive: true });
  const stub = join(bin, HERMES_AGENT_COMM);
  Bun.spawnSync(["cp", "/bin/sleep", stub]);
  chmodSync(stub, 0o755);
  writeFileSync(
    join(root, STAMP_FILE),
    `${JSON.stringify({ harness: "hermes", writerVersion: 1, tokenRef: `file:${join(root, "token")}`, verdict }, null, 2)}\n`,
  );
  const entry: RosterEntry = {
    session,
    command: ["tmux", "new-session", "-d", "-s", session, "-c", root, "suite", "hermes"],
    cwd: root,
    kind: "hermes",
    recordedAt: "2026-09-25T00:00:00.000Z",
  };
  mkdirSync(join(home, ".local", "state", "suite"), { recursive: true });
  writeFileSync(rosterPath(home), serializeRoster([entry]));
  return { session, home, root, stub };
}

function realStatusDeps(home: string): StatusDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    env: {},
    cwd: WORK_DIR,
    run: realTmux.run,
    // claude is deliberately absent: this test is about the agents section,
    // and must not call a real `claude mcp list`.
    which: (name) => (name === "tmux" ? realTmux.which(name) : null),
    exists: () => true,
    config: config(),
    configFile: join(home, "config.json"),
    tmux: realTmux,
    probe: async () => {
      throw new Error("status does not probe the tools endpoint");
    },
    color: false,
    utf8: true,
    lines,
    out: (line) => void lines.push(line),
    home,
    readFile: readFileOrNull,
  };
}

test("the real-tmux status tests below are not silently skipped", () => {
  expect(HAVE_TMUX || process.env.SUITE_CLI_ALLOW_NO_TMUX === "1").toBe(true);
});

describe.if(HAVE_TMUX)("status of a stamped agent, against a real tmux", () => {
  test(
    "a killed gateway reports stale, not healthy — and tmux alone would have said none",
    async () => {
      const { session, home, root, stub } = stampedHermes("kill", "pass");
      const pidFile = join(root, "gateway.pid");
      const script = `${JSON.stringify(stub)} 900 & echo $! > ${JSON.stringify(pidFile)}; wait $!`;
      const start = await realTmux.run(newSessionArgv({ session, command: ["/bin/sh", "-c", script], cwd: root }));
      expect(start.exitCode).toBe(0);

      expect(await until(() => detectState(session, realTmux, HERMES_AGENT_COMM), (s) => s === "live")).toBe("live");
      const before = realStatusDeps(home);
      await runStatus(before, NOW);
      const liveLine = before.lines.find((l) => l.includes(session)) ?? "";
      expect(liveLine).toContain("live");
      expect(liveLine).toContain("hermes");
      expect(liveLine).toContain("stamp pass");
      expect(liveLine).toContain(root);
      // Listed once, under agents, not again as a Claude session.
      expect(before.lines.filter((l) => l.includes(session))).toHaveLength(1);
      expect(before.lines.join("\n")).not.toContain("Claude dead");

      // The real kill: the stub, by the pid it recorded. Not a pattern.
      const pid = (await Bun.file(pidFile).text()).trim();
      expect(pid).toMatch(/^\d+$/);
      expect(Bun.spawnSync(["kill", pid]).exitCode).toBe(0);

      // MEASURED: with the gateway gone, the pane's process exits and the
      // session vanishes, so tmux-only detection says `none`.
      expect(await until(() => detectState(session, realTmux, HERMES_AGENT_COMM), (s) => s === "none")).toBe("none");

      const after = realStatusDeps(home);
      const code = await runStatus(after, NOW);
      const line = after.lines.find((l) => l.includes(session)) ?? "";
      expect(line).toContain("stale");
      expect(line).not.toContain("live");
      expect(line).toContain("✘");
      expect(line).toContain("stamp pass");
      expect(code).toBe(1);
      createdSessions.delete(session);
    },
    60_000,
  );

  test(
    "a dead gateway in a surviving shell is stale too",
    async () => {
      const { session, home, root, stub } = stampedHermes("shell", "fail");
      const pidFile = join(root, "gateway.pid");
      // The script lives in a FILE, so the shell's own args do not name the
      // stub (a `sh -c '<...>/hermes ...'` would itself look like the agent),
      // and the shell is NOT exec'd into sleep: it must stay the parent that
      // reaps the killed stub, or a zombie `hermes` stays in the table.
      const scriptFile = join(root, "pane.sh");
      writeFileSync(scriptFile, `${JSON.stringify(stub)} 900 &\necho $! > ${JSON.stringify(pidFile)}\nsleep 900\n`);
      const start = await realTmux.run(newSessionArgv({ session, command: ["/bin/sh", scriptFile], cwd: root }));
      expect(start.exitCode).toBe(0);
      expect(await until(() => detectState(session, realTmux, HERMES_AGENT_COMM), (s) => s === "live")).toBe("live");

      const pid = (await until(async () => ((await Bun.file(pidFile).exists()) ? (await Bun.file(pidFile).text()).trim() : ""), (p) => p !== "")) as string;
      expect(Bun.spawnSync(["kill", pid]).exitCode).toBe(0);
      expect(await until(() => detectState(session, realTmux, HERMES_AGENT_COMM), (s) => s === "stale")).toBe("stale");

      const deps = realStatusDeps(home);
      const code = await runStatus(deps, NOW);
      const line = deps.lines.find((l) => l.includes(session)) ?? "";
      expect(line).toContain("stale");
      expect(line).toContain("stamp fail");
      expect(code).toBe(1);

      await realTmux.run(killSessionArgv(session));
      createdSessions.delete(session);
    },
    60_000,
  );
});

describe("stamped agents in the fake-tmux status", () => {
  /** A roster with one openclaw agent and its stamp record, on disk. Self-contained per test. */
  function fakeStampedHome(label: string): { home: string; root: string; ref: string } {
    const home = join(WORK_DIR, `fake-home-${label}`);
    const root = join(WORK_DIR, `fake-root-${label}`);
    mkdirSync(join(home, ".local", "state", "suite"), { recursive: true });
    mkdirSync(root, { recursive: true });
    const ref = `file:${join(root, "runtime-token")}`;
    writeFileSync(join(root, STAMP_FILE), JSON.stringify({ harness: "openclaw", tokenRef: ref, verdict: "pass" }));
    writeFileSync(
      rosterPath(home),
      serializeRoster([
        { session: "suite-lobster", command: ["tmux", "new-session"], cwd: root, kind: "openclaw", recordedAt: "" },
      ]),
    );
    return { home, root, ref };
  }

  test("status prints no secret: not the token ref, not a token value", async () => {
    const { home, ref } = fakeStampedHome("secret");
    const deps = fakeDeps() as StatusDeps & { lines: string[] };
    deps.env = { SUITE_TOKEN: TOKEN };
    deps.home = home;
    deps.readFile = readFileOrNull;
    const code = await runStatus(deps, NOW);
    const text = deps.lines.join("\n");
    expect(text).toContain("suite-lobster");
    expect(text).toContain("openclaw");
    expect(text).toContain("stale");
    expect(text).not.toContain(ref);
    expect(text).not.toContain("runtime-token");
    expect(text).not.toContain(TOKEN);
    expect(code).toBe(1);
  });

  test("an unfederated box still lists its stamped agents", async () => {
    const { home } = fakeStampedHome("unfederated");
    const deps = fakeDeps({ config: null }) as StatusDeps & { lines: string[] };
    deps.home = home;
    deps.readFile = readFileOrNull;
    const code = await runStatus(deps, NOW);
    expect(deps.lines.join("\n")).toContain("not federated");
    expect(deps.lines.join("\n")).toContain("suite-lobster");
    expect(code).toBe(1);
  });

  test("with no roster, status reads exactly as before", async () => {
    const deps = fakeDeps() as StatusDeps & { lines: string[] };
    deps.home = join(WORK_DIR, "no-such-home");
    deps.readFile = readFileOrNull;
    const code = await runStatus(deps, NOW);
    expect(deps.lines.join("\n")).not.toContain("agents");
    expect(code).toBe(0);
  });
});
