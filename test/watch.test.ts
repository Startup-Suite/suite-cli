import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  type WatchDeps,
  parseTargets,
  parseWatchArgs,
  recentAsks,
  recoverSession,
  forceRecover,
  liveReadTail,
  overCeiling,
  rssBySession,
  sessionsBySlug,
  shouldSelfInstall,
} from "../src/commands/watch.ts";
import { resolveSelfBinary } from "../src/supervisor.ts";

function recordingDeps(): { deps: WatchDeps; calls: string[] } {
  const calls: string[] = [];
  const deps = {
    tmux: {
      env: {},
      which: () => "/usr/bin/tmux",
      async run(argv: string[]) {
        calls.push(argv.join(" "));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    now: () => new Date("2026-09-02T00:00:00Z"),
    async sleep(ms: number) {
      calls.push(`sleep ${ms}`);
    },
    async post() {
      return 200;
    },
    readTail: () => null,
    newestTranscript: () => null,
    log: () => {},
  } as unknown as WatchDeps;
  return { deps, calls };
}

describe("target selection", () => {
  /**
   * A shared box carries other people's tmux sessions. Typing into one would be
   * indistinguishable from the user's own keystrokes, so only sessions this CLI
   * named are ever eligible.
   */
  test("ignores sessions this CLI did not create", () => {
    const rows = ["suite-app-1a2b\t/home/a", "my-own-work\t/home/b", "scratch\t/home/c"].join("\n");
    expect(parseTargets(rows).map((t) => t.session)).toEqual(["suite-app-1a2b"]);
  });

  test("a session with several panes is still one target", () => {
    const rows = ["suite-x\t/home/a", "suite-x\t/home/a"].join("\n");
    expect(parseTargets(rows)).toHaveLength(1);
  });

  test("rows missing a path are skipped rather than defaulted", () => {
    expect(parseTargets("suite-x\n")).toEqual([]);
  });
});

describe("reconstructing the recent asks", () => {
  /**
   * A federated agent's instructions arrive wrapped in a <channel> envelope
   * that also quotes prior turns. Handing the whole envelope back would feed
   * the fresh session its own history as though it were an instruction.
   */
  test("takes only the Current message tail out of a channel envelope", () => {
    const quoted =
      "<channel source=\\\"suite\\\">Recent context: earlier chatter that must not be replayed\\n---\\nCurrent message:\\nrestart the deploy</channel>";
    const line = `{"type":"user","message":{"content":"${quoted}"}}`;
    expect(recentAsks(line)).toEqual(["restart the deploy"]);
  });

  test("drops harness noise that was never a human ask", () => {
    const lines = [
      '{"type":"user","message":{"content":"<task-notification>agent finished</task-notification>"}}',
      '{"type":"user","message":{"content":"a system-reminder about memory"}}',
      '{"type":"user","message":{"content":"actually do the thing"}}',
    ].join("\n");
    expect(recentAsks(lines)).toEqual(["actually do the thing"]);
  });

  test("keeps the most recent asks, oldest first", () => {
    const lines = [1, 2, 3, 4, 5, 6, 7]
      .map((n) => `{"type":"user","message":{"content":"ask ${n}"}}`)
      .join("\n");
    expect(recentAsks(lines, 3)).toEqual(["ask 5", "ask 6", "ask 7"]);
  });

  test("a malformed line does not abort the scan", () => {
    const lines = ['{"type":"user","message":{"content":"good"}}', "{not json"].join("\n");
    expect(recentAsks(lines)).toEqual(["good"]);
  });
});

describe("recovery ordering", () => {
  /**
   * The pause is load-bearing. `/clear` must be accepted and the TUI redrawn
   * before the reorientation is typed; sent too early it lands in a prompt that
   * is tearing down and is lost silently — which is worse than sending nothing,
   * because the session then looks handled.
   */
  test("clears, waits, then reorients", async () => {
    const { deps, calls } = recordingDeps();
    await recoverSession(deps, "suite-x", "REORIENT");
    // Absolute path, not bare "tmux": see resolveTmux — a watcher under
    // launchd or cron has a PATH without Homebrew, and a bare name there
    // fails silently and totally.
    expect(calls).toEqual([
      "/usr/bin/tmux send-keys -t suite-x -l /clear",
      "/usr/bin/tmux send-keys -t suite-x Enter",
      "sleep 1500",
      "/usr/bin/tmux send-keys -t suite-x -l REORIENT",
      "/usr/bin/tmux send-keys -t suite-x Enter",
    ]);
  });

  test("the prompt is sent literally, so its slashes are not read as keys", async () => {
    const { deps, calls } = recordingDeps();
    await recoverSession(deps, "s", "/not-a-command");
    expect(calls.some((c) => c.endsWith("send-keys -t s -l /not-a-command"))).toBe(true);
  });
});

describe("arguments", () => {
  test("acts by default; a watcher that must be asked twice is one nobody runs", () => {
    expect(parseWatchArgs([]).apply).toBe(true);
    expect(parseWatchArgs(["--dry-run"]).apply).toBe(false);
  });

  test("a nonsense or too-small interval falls back rather than busy-looping", () => {
    expect(parseWatchArgs(["--interval", "abc"]).intervalSeconds).toBe(60);
    expect(parseWatchArgs(["--interval", "1"]).intervalSeconds).toBe(60);
    expect(parseWatchArgs(["--interval", "300"]).intervalSeconds).toBe(300);
  });
});

describe("discovery is transcript-first", () => {
  /**
   * The host where this failure is most frequent runs its agent OUTSIDE any
   * suite-cli tmux session — a tmux-first sweep saw nothing there while its
   * transcripts showed 9 of 12 sessions halted. Observation must not depend on
   * owning the session; only the recovery keystrokes do.
   */
  test("a transcript with no owned session still maps to no session", () => {
    const map = sessionsBySlug([], (p) => p);
    expect(map.get("-Volumes-Dev-agents-brosnan")).toBeUndefined();
  });

  test("an owned pane maps its resolved directory to its session", () => {
    const map = sessionsBySlug(
      [{ session: "suite-b", cwd: "/Users/rock/Dev/agents/brosnan" }],
      (p) => p.replace("/Users/rock/Dev", "/Volumes/Dev"),
    );
    expect(map.get("-Volumes-Dev-agents-brosnan")).toBe("suite-b");
  });
});

describe("self-installation", () => {
  const on = { once: false, apply: true, install: true };

  /**
   * The reason this exists: a watchdog you have to discover and start by hand
   * is not running on the morning it was needed.
   */
  test("a plain `suite watch` installs its own service", () => {
    expect(shouldSelfInstall(on, {})).toBe(true);
  });

  /**
   * THE RECURSION GUARD. The service runs `suite watch`, which would install
   * the service, on every restart, forever. The unit marks its own child so the
   * daemon knows to sweep rather than reinstall itself.
   */
  test("the daemon itself does not reinstall the daemon", () => {
    expect(shouldSelfInstall(on, { SUITE_WATCH_SUPERVISED: "1" })).toBe(false);
  });

  test("--once leaves scheduling to the operator's own timer", () => {
    expect(shouldSelfInstall({ ...on, once: true }, {})).toBe(false);
  });

  /** An inspection mode must never change the machine it is inspecting. */
  test("--dry-run installs nothing", () => {
    expect(shouldSelfInstall({ ...on, apply: false }, {})).toBe(false);
  });

  test("--no-install opts out explicitly", () => {
    expect(shouldSelfInstall({ ...on, install: false }, {})).toBe(false);
    expect(parseWatchArgs(["--no-install"]).install).toBe(false);
    expect(parseWatchArgs([]).install).toBe(true);
  });
});

describe("locating the binary to bake into the unit", () => {
  test("prefers an absolute argv path over the assumed install location", () => {
    expect(resolveSelfBinary({ HOME: "/h" }, ["bun", "/opt/x/suite"])).toBe("/opt/x/suite");
  });

  /**
   * A relative or interpreted argv (a source checkout run as `bun src/cli.ts`)
   * would be meaningless inside a unit file, so fall back to where the
   * installer puts it. Never a bare name: a service's PATH would not find it.
   */
  test("falls back to the install path, absolute, for a source-run invocation", () => {
    const b = resolveSelfBinary({ HOME: "/h" }, ["bun", "src/cli.ts"]);
    expect(b).toBe("/h/.local/bin/suite");
    expect(b.startsWith("/")).toBe(true);
  });
});

describe("reading the tail does not read the file", () => {
  /**
   * The regression this exists for: liveReadTail once did `readFileSync` on the
   * whole file and then took a subarray. Behaviourally correct, so no
   * correctness test caught it — and fatal on a host whose transcripts run to
   * gigabytes, which is where it was about to be deployed. Assert the RESOURCE
   * cost, because the returned value cannot tell you the difference.
   */
  const dir = mkdtempSync(`${tmpdir()}/suite-tail-`);
  const big = `${dir}/big.jsonl`;

  test("returns exactly the final bytes of a file much larger than the window", () => {
    const filler = Buffer.alloc(48 * 1024 * 1024, 0x61); // 48MB of "a"
    writeFileSync(big, Buffer.concat([filler, Buffer.from("TAIL_SENTINEL")]));
    const out = liveReadTail(big, 1024);
    expect(out?.endsWith("TAIL_SENTINEL")).toBe(true);
    expect(out?.length).toBe(1024);
  });

  test("peak memory stays far below the file size", () => {
    Bun.gc(true);
    const before = process.memoryUsage().rss;
    for (let i = 0; i < 5; i++) liveReadTail(big, 65536);
    Bun.gc(true);
    const grew = process.memoryUsage().rss - before;
    // Five reads of a 48MB file. Loading it whole would move RSS by tens of MB
    // at least; seeking moves it by well under one.
    expect(grew).toBeLessThan(8 * 1024 * 1024);
  });

  test("a file shorter than the window returns all of it", () => {
    const small = `${dir}/small.jsonl`;
    writeFileSync(small, "hello");
    expect(liveReadTail(small, 65536)).toBe("hello");
  });

  test("a missing file is null, not a throw", () => {
    expect(liveReadTail(`${dir}/nope.jsonl`, 1024)).toBeNull();
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});

describe("self-imposed memory ceiling", () => {
  test("stays quiet at a healthy sweep size", () => {
    expect(overCeiling(110 * 1024 * 1024)).toBeNull();
  });

  test("names the numbers when exceeded, so the log explains the exit", () => {
    const r = overCeiling(700 * 1024 * 1024);
    expect(r).toContain("700MB");
    expect(r).toContain("512MB");
  });

  test("the boundary itself is not over", () => {
    expect(overCeiling(512 * 1024 * 1024, 512 * 1024 * 1024)).toBeNull();
  });
});

describe("resident memory per session", () => {
  /**
   * The gap this closes: occupancy comes from Claude Code transcripts, so an
   * agent on a different harness contributes nothing and is invisible. RSS is
   * harness-agnostic. An earlier host incident could not be attributed to
   * anything precisely because no such figure had ever been recorded.
   */
  const panes = ["suite-a\t100\t/w", "suite-b\t200\t/x"].join("\n");
  // pid ppid rss(kB) args — 100 has a child 101; 200 stands alone.
  const ps = [
    "  100     1   1024 -zsh",
    "  101   100   4096 claude",
    "  200     1   2048 bun dsh",
    "  999     1  99999 unrelated",
  ].join("\n");

  test("sums the whole descendant tree, not just the pane process", () => {
    // The agent is a CHILD of the pane shell, so the pane's own RSS understates.
    expect(rssBySession(panes, ps).get("suite-a")).toBe((1024 + 4096) * 1024);
  });

  test("a session with no children reports its own memory", () => {
    expect(rssBySession(panes, ps).get("suite-b")).toBe(2048 * 1024);
  });

  test("processes outside any session are not attributed to one", () => {
    const total = [...rssBySession(panes, ps).values()].reduce((a, b) => a + b, 0);
    expect(total).toBe((1024 + 4096 + 2048) * 1024);
  });

  test("a pane whose pid is gone reports zero rather than throwing", () => {
    expect(rssBySession("suite-z\t555\t/w", ps).get("suite-z")).toBe(0);
  });

  test("a cycle in the process table terminates", () => {
    const cyclic = ["  300   301   512 a", "  301   300   512 b"].join("\n");
    expect(rssBySession("suite-c\t300\t/w", cyclic).get("suite-c")).toBe(1024 * 1024);
  });
});

describe("the two pane formats are not interchangeable", () => {
  /**
   * Regression guard for a real mistake: the targets query yields
   * session<TAB>path and the RSS query yields session<TAB>pid. Feeding the
   * former to rssBySession parses a filesystem path as a pid, which is NaN,
   * which silently reports zero — every session showing rss=null with no error
   * anywhere. Only a probe against a live box revealed it.
   */
  test("a path in the pid position yields zero rather than an error", () => {
    const wrong = "suite-a\t/home/queen/agents/dalton";
    const ps = "  100     1   4096 claude";
    expect(rssBySession(wrong, ps).get("suite-a")).toBe(0);
  });

  test("the correct format resolves the tree", () => {
    const right = "suite-a\t100";
    const ps = "  100     1   4096 claude";
    expect(rssBySession(right, ps).get("suite-a")).toBe(4096 * 1024);
  });
});

describe("forced recovery", () => {
  test("--force takes an explicit session name, never a wildcard", () => {
    expect(parseWatchArgs(["--force", "suite-x"]).force).toBe("suite-x");
    expect(parseWatchArgs([]).force).toBeUndefined();
    expect(parseWatchArgs(["--force"]).force).toBeUndefined();
  });

  /**
   * The live gate holds for a forced run too. Typing into a pane whose agent
   * has exited runs a shell command rather than clearing anything, and that is
   * true whether recovery was triggered by a halt or by hand.
   */
  test("refuses a session that is not live, and types nothing", async () => {
    const calls: string[] = [];
    const deps = {
      tmux: {
        env: {},
        which: () => "/usr/bin/tmux",
        async run(argv: string[]) {
          calls.push(argv.join(" "));
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      now: () => new Date(),
      sleep: async () => {},
      post: async () => 200,
      readTail: () => null,
      newestTranscript: () => null,
      realpath: (p: string) => p,
      listProjectDirs: () => [],
      log: () => {},
    } as unknown as WatchDeps;

    const res = await forceRecover(
      deps,
      { apply: true, config: {} as never, auth: null, host: "h", home: "/home/q" },
      "suite-gone",
    );
    expect(res.recovered).toBe(false);
    expect(res.reason).toContain("refusing");
    expect(calls.some((c) => c.includes("send-keys"))).toBe(false);
  });
});
