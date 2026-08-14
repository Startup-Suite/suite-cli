import { describe, expect, test } from "bun:test";
import {
  formatAge,
  listSessionsArgv,
  ownSessions,
  parseSessions,
  runStatus,
  sessionLine,
} from "../src/commands/status.ts";
import type { DoctorDeps } from "../src/commands/doctor.ts";
import { CHANNEL_SERVER, TOOLS_SERVER } from "../src/commands/init.ts";
import { emptyConfig, type SuiteConfig } from "../src/config.ts";
import { SESSION_PREFIX } from "../src/tmux.ts";

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
