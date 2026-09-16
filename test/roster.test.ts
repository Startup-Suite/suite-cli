import { describe, expect, test } from "bun:test";
import {
  type RosterEntry,
  adoptEntries,
  forgetEntry,
  parseRoster,
  restorePlan,
  rosterPath,
  serializeRoster,
  upsertEntry,
} from "../src/roster.ts";
import {
  type RestoreDeps,
  loadRoster,
  recordLaunch,
  runRestore,
  runningSessions,
} from "../src/commands/restore.ts";

const entry = (session: string, cwd = "/w"): RosterEntry => ({
  session,
  command: ["tmux", "new-session", "-d", "-s", session, "-c", cwd, "claude"],
  cwd,
  kind: "claude",
  recordedAt: "2026-09-02T00:00:00.000Z",
});

describe("the roster survives being wrong", () => {
  /**
   * The roster is a convenience for recovery. Refusing to work because the
   * convenience is damaged inverts its purpose, so every malformed shape
   * degrades to "no entries" rather than throwing into a launch path.
   */
  test("unparseable JSON yields no entries rather than an exception", () => {
    expect(parseRoster("{not json")).toEqual([]);
    expect(parseRoster("")).toEqual([]);
  });

  test("entries missing a session, cwd or command are dropped individually", () => {
    const text = JSON.stringify({
      agents: [
        { session: "", command: ["tmux"], cwd: "/w" },
        { session: "a", command: [], cwd: "/w" },
        { session: "b", command: ["tmux"], cwd: "" },
        { session: "good", command: ["tmux", "new-session"], cwd: "/w", kind: "claude" },
      ],
    });
    expect(parseRoster(text).map((e) => e.session)).toEqual(["good"]);
  });

  test("a non-string inside command disqualifies the entry", () => {
    const text = JSON.stringify({ agents: [{ session: "x", command: ["tmux", 7], cwd: "/w" }] });
    expect(parseRoster(text)).toEqual([]);
  });

  test("round-trips through serialize", () => {
    expect(parseRoster(serializeRoster([entry("s1")]))).toEqual([entry("s1")]);
  });

  test("the path is under state, not config — it is derived, not authored", () => {
    expect(rosterPath("/home/q")).toBe("/home/q/.local/state/suite/agents.json");
  });
});

describe("bookkeeping", () => {
  test("relaunching the same session replaces rather than duplicates", () => {
    const once = upsertEntry([], entry("s1"));
    const twice = upsertEntry(once, { ...entry("s1", "/moved"), recordedAt: "later" });
    expect(twice).toHaveLength(1);
    expect(twice[0]?.cwd).toBe("/moved");
  });

  test("forget drops one agent and leaves the rest", () => {
    const two = upsertEntry(upsertEntry([], entry("s1")), entry("s2"));
    expect(forgetEntry(two, "s1").map((e) => e.session)).toEqual(["s2"]);
  });
});

describe("restore planning", () => {
  /**
   * THE GUARD. Two agents in one working directory is not a duplicate that
   * resolves itself — they overwrite each other's edits and the damage
   * surfaces later as a compile error nobody can attribute. Restore must be a
   * no-op on a healthy box, which is also what makes it safe to run by hand.
   */
  test("never starts a session that is already live", () => {
    const plan = restorePlan([entry("s1"), entry("s2")], ["s1"]);
    expect(plan.find((p) => p.entry.session === "s1")?.action).toBe("skip");
    expect(plan.find((p) => p.entry.session === "s2")?.action).toBe("start");
  });

  test("on a fully healthy box every decision is skip", () => {
    const plan = restorePlan([entry("s1")], ["s1", "other"]);
    expect(plan.every((p) => p.action === "skip")).toBe(true);
  });
});

function deps(roster: string | null, live: string, codes: number[] = []): {
  d: RestoreDeps;
  calls: string[][];
  written: string[];
} {
  const calls: string[][] = [];
  const written: string[] = [];
  let i = 0;
  return {
    calls,
    written,
    d: {
      tmux: {
        env: {},
        which: () => "/usr/bin/tmux",
        async run(argv) {
          calls.push(argv);
          if (argv.includes("list-panes")) return { exitCode: 0, stdout: live, stderr: "" };
          return { exitCode: codes[i++] ?? 0, stdout: "", stderr: "boom" };
        },
      },
      readRoster: () => roster,
      writeRoster: (_p, c) => written.push(c),
      now: () => new Date("2026-09-02T00:00:00.000Z"),
      log: () => {},
    },
  };
}

describe("running a restore", () => {
  const roster = serializeRoster([entry("suite-a"), entry("suite-b")]);

  test("starts only the missing session, replaying its argv verbatim", async () => {
    const { d, calls } = deps(roster, "suite-a\t100\tclaude\n");
    const res = await runRestore(d, "/home/q");
    expect(res.started).toEqual(["suite-b"]);
    expect(res.skipped).toEqual(["suite-a"]);
    const create = calls.find((c) => c.includes("new-session"));
    expect(create?.slice(1)).toEqual(entry("suite-b").command.slice(1));
  });

  /** Only the binary is re-resolved: its path can differ from record time. */
  test("re-resolves the tmux binary rather than trusting the stored path", async () => {
    const { d, calls } = deps(serializeRoster([entry("suite-b")]), "");
    await runRestore(d, "/home/q");
    expect(calls.find((c) => c.includes("new-session"))?.[0]).toBe("/usr/bin/tmux");
  });

  test("--dry-run starts nothing", async () => {
    const { d, calls } = deps(roster, "");
    await runRestore(d, "/home/q", { apply: false });
    expect(calls.filter((c) => c.includes("new-session"))).toHaveLength(0);
  });

  test("a failed start is reported, not swallowed", async () => {
    const { d } = deps(serializeRoster([entry("suite-b")]), "", [1]);
    const res = await runRestore(d, "/home/q");
    expect(res.failed).toEqual(["suite-b"]);
    expect(res.started).toEqual([]);
  });

  test("an absent roster is not an error", async () => {
    const { d } = deps(null, "");
    expect((await runRestore(d, "/home/q")).started).toEqual([]);
  });

  test("--forget rewrites the roster and starts nothing", async () => {
    const { d, calls, written } = deps(roster, "");
    await runRestore(d, "/home/q", { apply: true, forget: "suite-a" });
    expect(calls.filter((c) => c.includes("new-session"))).toHaveLength(0);
    expect(parseRoster(written[0] ?? "").map((e) => e.session)).toEqual(["suite-b"]);
  });
});

describe("recording a launch", () => {
  test("writes the entry with a timestamp", () => {
    const { d, written } = deps("", "");
    recordLaunch(d, "/home/q", { session: "s", command: ["tmux", "x"], cwd: "/w", kind: "claude" });
    const got = parseRoster(written[0] ?? "");
    expect(got[0]?.session).toBe("s");
    expect(got[0]?.recordedAt).toBe("2026-09-02T00:00:00.000Z");
  });

  /** Bookkeeping must never be able to stop an agent from starting. */
  test("a write failure is swallowed rather than thrown at the launch path", () => {
    const { d } = deps("", "");
    d.writeRoster = () => {
      throw new Error("read-only fs");
    };
    expect(() =>
      recordLaunch(d, "/home/q", { session: "s", command: ["t"], cwd: "/w", kind: "claude" }),
    ).not.toThrow();
  });

  test("loadRoster tolerates an absent file", () => {
    const { d } = deps(null, "");
    expect(loadRoster(d, "/home/q")).toEqual([]);
  });
});

describe("adopting sessions that predate the roster", () => {
  const now = "2026-09-02T00:00:00.000Z";
  const running = [
    { session: "suite-brosnan-b7a99b1e", cwd: "/Volumes/Dev/agents/brosnan", argv: ["claude", "--continue"] },
    { session: "suite-oddjob", cwd: "/home/q/agents/oddjob", argv: ["node", "x/.bin/dsh", "--profile", "headless"] },
    { session: "my-own-work", cwd: "/home/q", argv: ["vim"] },
  ];

  /**
   * Without adoption the feature helps nobody: every agent on a box today was
   * started before recording existed, so a roster fed only by future launches
   * restores nothing after the next reboot — while appearing to work.
   */
  test("records agents that were started before the roster existed", () => {
    expect(adoptEntries(running, [], now).map((e) => e.session)).toEqual([
      "suite-brosnan-b7a99b1e",
      "suite-oddjob",
    ]);
  });

  test("ignores sessions this CLI did not name", () => {
    expect(adoptEntries(running, [], now).some((e) => e.session === "my-own-work")).toBe(false);
  });

  test("does not re-adopt something already recorded", () => {
    const existing = adoptEntries(running, [], now).slice(0, 1);
    expect(adoptEntries(running, existing, now).map((e) => e.session)).toEqual(["suite-oddjob"]);
  });

  test("classifies a dsh pane as deepseek and a claude pane as claude", () => {
    const got = adoptEntries(running, [], now);
    expect(got.find((e) => e.session === "suite-oddjob")?.kind).toBe("deepseek");
    expect(got.find((e) => e.session.includes("brosnan"))?.kind).toBe("claude");
  });

  test("the reconstructed command re-creates the same session in the same cwd", () => {
    const e = adoptEntries(running, [], now)[0];
    expect(e?.command).toEqual([
      "tmux", "new-session", "-d", "-s", "suite-brosnan-b7a99b1e",
      "-c", "/Volumes/Dev/agents/brosnan", "claude", "--continue",
    ]);
  });

  test("a pane with no discoverable command is skipped, not recorded empty", () => {
    expect(adoptEntries([{ session: "suite-x", cwd: "/w", argv: [] }], [], now)).toEqual([]);
  });
});

/**
 * The seam the pure adoption tests above cannot see.
 *
 * `adoptEntries` was tested with argv handed to it directly, so it has always
 * passed. What was wrong lived one layer out, in the `ps` format string:
 * `runningSessions` asked for THREE columns while `parseProcesses` parses FOUR,
 * and the parser's `(\S+)` group silently consumed argv[0]. Adoption then
 * recorded `tmux new-session … -c <cwd> --dangerously-load-development-channels`
 * — a command with no program in it — and reported success, because
 * `looksLikeAgent` matches on `comm` and `comm` was the piece that got eaten.
 * Replaying it gives `command new-session: invalid flag --`.
 */
describe("reading the running agents off the process table", () => {
  const PANES = "suite-brosnan\t39909\t/Volumes/Dev/agents/brosnan\n";
  const PS = [
    "  685     1 tmux             tmux new-session -d -s suite-brosnan -c /Volumes/Dev/agents/brosnan claude --continue",
    "39909   685 claude           claude --dangerously-load-development-channels server:suite-channel --continue",
    "39934 39909 bun              bun /Users/rock/Dev/sources/claude-code-suite-channel/src/index.ts",
    "",
  ].join("\n");

  function psDeps(): RestoreDeps {
    return {
      tmux: {
        env: {},
        which: () => "/usr/bin/tmux",
        async run(argv) {
          if (argv.includes("list-panes")) return { exitCode: 0, stdout: PANES, stderr: "" };
          if (argv[0] === "ps") {
            // The contract under test: whatever format is requested must be the
            // one `parseProcesses` reads. Anything else is answered emptily so
            // a drifted format fails loudly instead of half-working.
            const fmt = argv[2] ?? "";
            return fmt === "pid=,ppid=,comm=,args="
              ? { exitCode: 0, stdout: PS, stderr: "" }
              : { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      readRoster: () => null,
      writeRoster: () => {},
      now: () => new Date("2026-09-02T00:00:00.000Z"),
      log: () => {},
    };
  }

  test("keeps the program name, so the replayed command can actually run", async () => {
    const found = await runningSessions(psDeps());
    expect(found).toHaveLength(1);
    expect(found[0]?.argv[0]).toBe("claude");
  });

  test("the adopted command starts a program, not a flag", async () => {
    const [e] = adoptEntries(await runningSessions(psDeps()), [], "2026-09-02T00:00:00.000Z");
    const afterCwd = e?.command[e.command.indexOf("/Volumes/Dev/agents/brosnan") + 1];
    expect(afterCwd).toBe("claude");
    expect(afterCwd?.startsWith("-")).toBe(false);
  });
});
