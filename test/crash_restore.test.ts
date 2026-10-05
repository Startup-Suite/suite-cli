/**
 * The watchdog's crash-restore pass and its crash-loop guard.
 *
 * A fake tmux world (sessions + whether each one's agent is alive) and a fake
 * clock. Nothing here touches a real tmux, a real roster, or any service
 * manager: every argv the pass emits is recorded, and the last test asserts
 * none of them ever named launchctl, systemctl or the watchdog's launchd label
 * — on rock that label is a LIVE watchdog belonging to another user of the box.
 */
import { describe, expect, test } from "bun:test";
import { decideRestart, emptyGuard, parseGuard, restartsPath, serializeGuard, clearGuard } from "../src/crash_guard.ts";
import { crashRestorePass, type CrashRestoreDeps } from "../src/commands/crash_restore.ts";
import { runRestore } from "../src/commands/restore.ts";
import { runWatch, type WatchDeps } from "../src/commands/watch.ts";
import { statusDocument } from "../src/commands/status_json.ts";
import { emptyConfig } from "../src/config.ts";
import { rosterPath, serializeRoster, type RosterEntry } from "../src/roster.ts";
import type { RunResult } from "../src/tmux.ts";
import { CRASH_LOOP_MAX_RESTARTS, CRASH_LOOP_WINDOW_MS } from "../src/tuning.ts";
import { launchdPlist, systemdUnit } from "../src/supervisor.ts";

const HOME = "/fixture/home-01a0d6b9";
const T0 = Date.parse("2026-10-05T06:00:00Z");
const minutes = (n: number) => new Date(T0 + n * 60_000);

const QUASAR: RosterEntry = {
  session: "suite-quasar",
  command: ["/usr/bin/tmux", "new-session", "-d", "-s", "suite-quasar", "-c", "/agents/quasar", "claude", "--continue"],
  cwd: "/agents/quasar",
  kind: "claude",
  recordedAt: "2026-10-05T05:00:00Z",
};

/** sessions → agent alive? Plus every argv seen, across every world. */
const EVERY_ARGV: string[][] = [];

function world(initial: Record<string, boolean>, entries: RosterEntry[] = [QUASAR]) {
  const sessions = new Map<string, boolean>(Object.entries(initial));
  const ran: string[][] = [];
  const files = new Map<string, string>([[rosterPath(HOME), serializeRoster(entries)]]);
  const logs: string[] = [];
  const sessionLogs: { session: string; line: string }[] = [];
  let now = minutes(0);
  const pids = new Map<string, number>();
  const pidOf = (s: string) => {
    if (!pids.has(s)) pids.set(s, 1000 + pids.size * 10);
    return pids.get(s)!;
  };
  const run = async (argv: string[]): Promise<RunResult> => {
    ran.push(argv);
    EVERY_ARGV.push(argv);
    if (argv.includes("new-session")) {
      const s = argv[argv.indexOf("-s") + 1]!;
      if (sessions.has(s)) return { exitCode: 1, stdout: "", stderr: `duplicate session: ${s}` };
      sessions.set(s, true);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (argv.includes("kill-session")) {
      sessions.delete(argv[argv.indexOf("-t") + 1]!.replace(/^=/, ""));
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (argv.includes("list-panes")) {
      return { exitCode: 0, stdout: [...sessions.keys()].map((s) => `${s}\t${pidOf(s)}\tzsh\t/agents`).join("\n"), stderr: "" };
    }
    if (argv[0] === "ps") {
      const rows: string[] = [];
      for (const [s, alive] of sessions) {
        const pid = pidOf(s);
        rows.push(`${pid} 1 zsh -zsh`);
        if (alive) rows.push(`${pid + 1} ${pid} claude claude --continue`);
      }
      return { exitCode: 0, stdout: rows.join("\n"), stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const deps: CrashRestoreDeps = {
    tmux: { env: {}, which: (n) => `/usr/bin/${n}`, run },
    readRoster: (p) => files.get(p) ?? null,
    writeRoster: (p, c) => void files.set(p, c),
    now: () => now,
    log: (l) => void logs.push(l),
    readGuard: (p) => files.get(p) ?? null,
    writeGuard: (p, c) => void files.set(p, c),
    sessionLog: (session, line) => void sessionLogs.push({ session, line }),
  };
  return {
    deps,
    ran,
    files,
    logs,
    sessionLogs,
    sessions,
    setNow: (d: Date) => (now = d),
    kill: (s: string) => void sessions.delete(s),
    creates: () => ran.filter((a) => a.includes("new-session")).length,
    guard: () => parseGuard(files.get(restartsPath(HOME)) ?? null),
  };
}

describe("crash_guard (pure)", () => {
  test("3 restarts allowed in the window; the 4th death is crash_looping", () => {
    let g = emptyGuard();
    for (let i = 0; i < CRASH_LOOP_MAX_RESTARTS; i++) {
      const d = decideRestart(g, "s", minutes(i));
      expect(d.allow).toBe(true);
      g = d.next;
    }
    const fourth = decideRestart(g, "s", minutes(3));
    expect(fourth).toMatchObject({ allow: false, becameLooping: true, recent: 3 });
    expect(fourth.next.agents.s?.crash_looping).toBe(true);
  });

  test("restarts older than the window do not count", () => {
    let g = emptyGuard();
    for (let i = 0; i < 3; i++) g = decideRestart(g, "s", minutes(i)).next;
    const later = decideRestart(g, "s", new Date(T0 + 2 * 60_000 + CRASH_LOOP_WINDOW_MS + 1));
    expect(later.allow).toBe(true);
  });

  test("crash_looping stays until cleared, even after the window", () => {
    let g = emptyGuard();
    for (let i = 0; i < 4; i++) g = decideRestart(g, "s", minutes(i)).next;
    expect(decideRestart(g, "s", minutes(60)).allow).toBe(false);
    const { next, cleared } = clearGuard(g);
    expect(cleared).toEqual(["s"]);
    expect(decideRestart(next, "s", minutes(61)).allow).toBe(true);
  });

  test("an unreadable guard file is an empty guard", () => {
    expect(parseGuard("{nope")).toEqual(emptyGuard());
    expect(parseGuard(serializeGuard(emptyGuard()))).toEqual(emptyGuard());
  });
});

describe("crashRestorePass", () => {
  test("a killed session is restored ONCE, through the restore code path, and logged to its session log", async () => {
    const w = world({});
    const r = await crashRestorePass(w.deps, HOME, { apply: true });
    expect(r.restored).toEqual(["suite-quasar"]);
    expect(w.creates()).toBe(1);
    // Replayed verbatim with the tmux binary re-resolved — the `suite restore` path.
    expect(w.ran.find((a) => a.includes("new-session"))).toEqual(["/usr/bin/tmux", ...QUASAR.command.slice(1)]);
    expect(w.sessionLogs).toEqual([
      { session: "suite-quasar", line: expect.stringContaining("restored by suite watch (session was gone; restart 1 of at most 3") },
    ]);
    // Next tick: it is live, nothing happens.
    w.setNow(minutes(1));
    const again = await crashRestorePass(w.deps, HOME, { apply: true });
    expect(again.restored).toEqual([]);
    expect(w.creates()).toBe(1);
    expect(w.guard().agents["suite-quasar"]?.restarts.length).toBe(1);
  });

  test("the 4th death in 10 minutes gives crash_looping and NO restart", async () => {
    const w = world({});
    for (let i = 0; i < 3; i++) {
      w.setNow(minutes(i * 2));
      const r = await crashRestorePass(w.deps, HOME, { apply: true });
      expect(r.restored).toEqual(["suite-quasar"]);
      w.kill("suite-quasar");
    }
    expect(w.creates()).toBe(3);
    w.setNow(minutes(7));
    const fourth = await crashRestorePass(w.deps, HOME, { apply: true });
    expect(fourth.restored).toEqual([]);
    expect(fourth.crashLooping).toEqual(["suite-quasar"]);
    expect(w.creates()).toBe(3);
    expect(w.guard().agents["suite-quasar"]).toMatchObject({ crash_looping: true });
    expect(w.sessionLogs.at(-1)!.line).toContain("crash_looping");

    // And it stays down on later ticks, past the window, without re-logging.
    const logged = w.sessionLogs.length;
    w.setNow(minutes(30));
    await crashRestorePass(w.deps, HOME, { apply: true });
    expect(w.creates()).toBe(3);
    expect(w.sessionLogs.length).toBe(logged);

    // status --json reports it.
    const doc = await statusDocument({
      env: { HOME },
      platform: "linux",
      home: HOME,
      config: null,
      tmux: w.deps.tmux,
      readFile: (p) => w.files.get(p) ?? null,
      watchdogLoaded: async () => true,
      pidAlive: () => false,
    });
    expect(doc.agents[0]).toMatchObject({ session: "suite-quasar", state: "crash_looping" });
  });

  test("a manual `suite restore` clears crash_looping and starts it; the watchdog then looks after it again", async () => {
    const w = world({});
    for (let i = 0; i < 4; i++) {
      w.setNow(minutes(i));
      await crashRestorePass(w.deps, HOME, { apply: true });
      w.kill("suite-quasar");
    }
    expect(w.guard().agents["suite-quasar"]?.crash_looping).toBe(true);
    w.setNow(minutes(5));
    const manual = await runRestore(w.deps, HOME, { apply: true });
    expect(manual.started).toEqual(["suite-quasar"]);
    expect(w.guard().agents["suite-quasar"]).toBeUndefined();
    expect(w.logs.some((l) => l.includes("crash_looping cleared"))).toBe(true);
    w.kill("suite-quasar");
    w.setNow(minutes(6));
    expect((await crashRestorePass(w.deps, HOME, { apply: true })).restored).toEqual(["suite-quasar"]);
  });

  test("a STALE session (pane alive, agent dead) is killed by exact name, then replayed", async () => {
    const w = world({ "suite-quasar": false });
    const r = await crashRestorePass(w.deps, HOME, { apply: true });
    expect(r.restored).toEqual(["suite-quasar"]);
    const kill = w.ran.find((a) => a.includes("kill-session"))!;
    expect(kill).toEqual(["/usr/bin/tmux", "kill-session", "-t", "=suite-quasar"]);
    expect(w.ran.indexOf(kill)).toBeLessThan(w.ran.findIndex((a) => a.includes("new-session")));
  });

  test("a live agent is left alone; a dry run restores nothing and records nothing", async () => {
    const live = world({ "suite-quasar": true });
    expect((await crashRestorePass(live.deps, HOME, { apply: true })).restored).toEqual([]);
    expect(live.creates()).toBe(0);
    const dry = world({});
    await crashRestorePass(dry.deps, HOME, { apply: false });
    expect(dry.creates()).toBe(0);
    expect(dry.files.has(restartsPath(HOME))).toBe(false);
    expect(dry.logs.join("\n")).toContain("would restore");
  });

  test("an empty roster does nothing at all", async () => {
    const w = world({}, []);
    await crashRestorePass(w.deps, HOME, { apply: true });
    expect(w.ran).toEqual([]);
  });

  test("runWatch runs the pass each tick when given crash-restore deps", async () => {
    const w = world({});
    const watch: WatchDeps = {
      tmux: w.deps.tmux,
      now: () => minutes(0),
      sleep: async () => {},
      post: async () => 200,
      readTail: () => null,
      realpath: (p) => p,
      listProjectDirs: () => [],
      newestTranscript: () => null,
      log: () => {},
      crashRestore: w.deps,
    };
    await runWatch(watch, { apply: true, config: emptyConfig(), auth: null, host: "h", home: HOME });
    expect(w.creates()).toBe(1);
  });

  test("NEVER a service manager: no argv named launchctl, systemctl, or the watchdog label", () => {
    expect(EVERY_ARGV.length).toBeGreaterThan(10);
    const joined = EVERY_ARGV.map((a) => a.join(" "));
    expect(joined.filter((a) => /launchctl|systemctl|technology\.milvenan/.test(a))).toEqual([]);
  });
});

describe("the watchdog that runs this pass starts at login", () => {
  const input = { platform: "darwin" as const, home: HOME, binary: `${HOME}/.local/bin/suite`, intervalSeconds: 60 };
  test("macOS: the LaunchAgent plist has RunAtLoad true (and KeepAlive)", () => {
    const plist = launchdPlist(input);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });
  test("Linux: the user unit is WantedBy=default.target", () => {
    expect(systemdUnit({ ...input, platform: "linux" })).toContain("WantedBy=default.target");
  });
});
