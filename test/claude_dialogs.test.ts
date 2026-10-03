/**
 * Claude Code's pre-launch dialogs: which screens get which keys, and — the
 * half that matters more — which screens get NONE.
 *
 * The fixtures are real `tmux capture-pane -p` output from Claude Code 2.1.288
 * on Linux, captured at 80 and 120 columns (the folder path was rewritten to
 * /srv/agents/work; nothing else was edited). See src/claude_dialogs.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DIALOG_RESEND_MS,
  DIALOG_WINDOW_MS,
  answerLaunchDialogs,
  answerOnce,
  classifyPane,
  dialogCaptureArgv,
  dialogKeysArgv,
  type DialogIo,
} from "../src/claude_dialogs.ts";
import type { RunResult } from "../src/tmux.ts";
import { runRestore, type RestoreDeps } from "../src/commands/restore.ts";
import { serializeRoster } from "../src/roster.ts";
import { runWatch, type WatchDeps } from "../src/commands/watch.ts";
import { emptyConfig } from "../src/config.ts";

const DIR = resolve(import.meta.dir, "fixtures/claude-code-2.1.288-dialogs");
const fixture = (name: string): string => readFileSync(resolve(DIR, `${name}.txt`), "utf8");
const CTX = { cwd: "/srv/agents/work", home: "/home/agent" };

describe("each recorded dialog produces exactly the expected keys", () => {
  const cases: [string, string, string[]][] = [
    ["trust-folder.120", "trust-folder", ["Down"]],
    ["trust-folder.80", "trust-folder", ["Down"]],
    ["trust-folder.120.cursor-yes", "trust-folder", ["Enter"]],
    ["trust-folder.80.cursor-yes", "trust-folder", ["Enter"]],
    ["dev-channels.120", "dev-channels", ["1"]],
    ["dev-channels.80", "dev-channels", ["1"]],
    ["dev-channels.80.cursor-exit", "dev-channels", ["1"]],
    ["bypass-permissions.120", "bypass-permissions", ["Down"]],
    ["bypass-permissions.80.cursor-yes", "bypass-permissions", ["Enter"]],
    ["mcp-server.120", "mcp-server", ["Enter"]],
  ];
  for (const [file, dialog, keys] of cases) {
    test(`${file} → ${dialog}: ${keys.join(" ")}`, () => {
      expect(classifyPane(fixture(file), CTX)).toEqual({ kind: "answer", dialog: dialog as never, keys });
    });
  }

  test("the input box reads as ready, not as a dialog", () => {
    expect(classifyPane(fixture("ready.120"), CTX)).toEqual({ kind: "ready" });
  });
});

describe("anything not known word for word gets no keys", () => {
  const noKeys = (pane: string, ctx = CTX): void => {
    const step = classifyPane(pane, ctx);
    expect(step.kind).not.toBe("answer");
  };

  test("an empty pane", () => noKeys(""));

  test("a partial redraw: the top half of the trust dialog, footer not drawn yet", () => {
    const lines = fixture("trust-folder.80").split("\n");
    noKeys(lines.slice(0, 6).join("\n"));
  });

  test("a partial redraw: the options drawn but the footer missing", () => {
    noKeys(fixture("trust-folder.80").replace("Enter to confirm · Esc to cancel", ""));
  });

  test("a partial redraw: footer drawn but the top of the block not yet", () => {
    const lines = fixture("dev-channels.80").split("\n").filter((l) => !l.includes("WARNING"));
    noKeys(lines.join("\n"));
  });

  test("one word changed (a reworded dialog in a future release)", () => {
    const step = classifyPane(fixture("trust-folder.80").replace("Quick safety check", "Quick check"), CTX);
    expect(step).toEqual({ kind: "unknown", title: "Accessing workspace:" });
  });

  test("an option added", () => {
    noKeys(fixture("bypass-permissions.120").replace("    Yes, I accept", "    Yes, I accept\n    Yes, and never ask again"));
  });

  test("an unknown dialog with the same footer and a cursor on a yes", () => {
    const pane = [
      "─".repeat(80),
      "  Delete every file in this folder?",
      "",
      "  ❯ Yes",
      "    No",
      "",
      "  Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(classifyPane(pane, CTX)).toEqual({ kind: "unknown", title: "Delete every file in this folder?" });
  });

  test("the trust dialog for a folder other than the one we launched in", () => {
    expect(classifyPane(fixture("trust-folder.80"), { cwd: "/srv/agents/other", home: "/home/agent" })).toMatchObject({
      kind: "hold",
      dialog: "trust-folder",
    });
  });

  test("the trust dialog when the launch folder is not known", () => {
    expect(classifyPane(fixture("trust-folder.80"), {})).toMatchObject({ kind: "hold", dialog: "trust-folder" });
  });

  test("the dev-channels warning naming a channel besides suite's", () => {
    const pane = fixture("dev-channels.80").replace(
      "Channels: server:suite-channel",
      "Channels: server:suite-channel, plugin:other@somewhere",
    );
    expect(classifyPane(pane, CTX)).toMatchObject({ kind: "hold", dialog: "dev-channels" });
  });

  test("the MCP dialog with the cursor moved onto an approval", () => {
    const pane = fixture("mcp-server.120")
      .replace("    Use this MCP server", "  ❯ Use this MCP server")
      .replace("  ❯ Continue without", "    Continue without");
    expect(classifyPane(pane, CTX)).toMatchObject({ kind: "hold", dialog: "mcp-server" });
  });

  test("two cursors on screen (a torn redraw)", () => {
    const pane = fixture("trust-folder.80").replace("   Yes, I trust", " ❯ Yes, I trust");
    expect(classifyPane(pane, CTX)).toMatchObject({ kind: "hold", dialog: "trust-folder" });
  });

  test("dialog text printed by an agent in its transcript, above its live input box", () => {
    const pane = `${fixture("trust-folder.80")}\n\n${fixture("ready.120")}`;
    expect(classifyPane(pane, CTX)).toEqual({ kind: "ready" });
  });
});

describe("tmux targeting", () => {
  test("capture and keys use tmux's exact-match target, never a prefix", () => {
    expect(dialogCaptureArgv("suite-a-1", "tmux")).toEqual(["tmux", "capture-pane", "-p", "-t", "=suite-a-1:"]);
    expect(dialogKeysArgv("suite-a-1", ["Down"], "tmux")).toEqual(["tmux", "send-keys", "-t", "=suite-a-1:", "Down"]);
  });
});

/* ------------------------------------------------------------------------- */
/* The poll, against a scripted pane                                          */
/* ------------------------------------------------------------------------- */

interface Scripted {
  io: DialogIo;
  sent: string[][];
  logs: string[];
  clock: { t: number };
}

/**
 * A pane that shows `screens[i]` on the i-th capture (the last one repeats),
 * a clock advanced only by sleep, and a record of every send-keys.
 */
function scripted(screens: (string | null)[]): Scripted {
  const sent: string[][] = [];
  const logs: string[] = [];
  const clock = { t: 0 };
  let i = 0;
  const io: DialogIo = {
    tmux: {
      env: {},
      which: (n) => `/usr/bin/${n}`,
      async run(argv): Promise<RunResult> {
        if (argv[1] === "capture-pane") {
          const s = screens[Math.min(i++, screens.length - 1)] ?? null;
          return s === null ? { exitCode: 1, stdout: "", stderr: "can't find session" } : { exitCode: 0, stdout: s, stderr: "" };
        }
        if (argv[1] === "send-keys") sent.push(argv.slice(4));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    log: (_session, line) => logs.push(line),
  };
  return { io, sent, logs, clock };
}

const OPTS = { session: "suite-x", cwd: CTX.cwd, home: CTX.home, pollMs: 400 };

describe("answerLaunchDialogs", () => {
  test("walks the real first-run sequence and stops at the input box", async () => {
    const s = scripted([
      "",
      fixture("trust-folder.80"),
      fixture("trust-folder.80.cursor-yes"),
      fixture("dev-channels.80"),
      "No conversation found to continue",
      fixture("dev-channels.80"),
      fixture("ready.120"),
    ]);
    const r = await answerLaunchDialogs(s.io, OPTS);
    expect(r.outcome).toBe("ready");
    expect(s.sent).toEqual([["Down"], ["Enter"], ["1"], ["1"]]);
    expect(s.logs).toEqual([
      "launch dialogs: answered trust-folder with Down",
      "launch dialogs: answered trust-folder with Enter",
      "launch dialogs: answered dev-channels with 1",
      "launch dialogs: answered dev-channels with 1",
    ]);
  });

  test("a capture that still shows the old cursor does not earn a second key", async () => {
    // Measured on the real thing: 400 ms after Down, the cursor had not moved yet.
    const s = scripted([fixture("trust-folder.80"), fixture("trust-folder.80"), fixture("trust-folder.80.cursor-yes"), fixture("ready.120")]);
    await answerLaunchDialogs(s.io, OPTS);
    expect(s.sent).toEqual([["Down"], ["Enter"]]);
  });

  test("a screen that never changes is answered again only after the resend wait", async () => {
    const s = scripted([fixture("dev-channels.80")]);
    await answerLaunchDialogs(s.io, { ...OPTS, windowMs: DIALOG_RESEND_MS * 2 + 1000 });
    expect(s.sent.length).toBeGreaterThanOrEqual(2);
    expect(s.sent.length).toBeLessThanOrEqual(3);
  });

  test("an unknown screen for the whole window: no keys, a clean give-up, said once", async () => {
    const unknown = ["─".repeat(80), "  Something new", "  ❯ Yes", "    No", "  Enter to confirm · Esc to cancel"].join("\n");
    const s = scripted([unknown]);
    const r = await answerLaunchDialogs(s.io, OPTS);
    expect(r).toEqual({ outcome: "timeout", answered: [] });
    expect(s.sent).toEqual([]);
    expect(s.clock.t).toBeGreaterThanOrEqual(DIALOG_WINDOW_MS);
    expect(s.clock.t).toBeLessThan(DIALOG_WINDOW_MS + 1000);
    expect(s.logs).toEqual([
      'launch dialogs: NOT answering unrecognised dialog "Something new"',
      "launch dialogs: gave up after 60s without seeing Claude's input box (0 answered); the pane is left as it is",
    ]);
  });

  test("a blank pane for the whole window gives up without sending anything", async () => {
    const s = scripted([""]);
    const r = await answerLaunchDialogs(s.io, { ...OPTS, windowMs: 5000 });
    expect(r.outcome).toBe("timeout");
    expect(s.sent).toEqual([]);
  });

  test("a session that disappears ends the poll as gone, not as an error", async () => {
    const s = scripted([fixture("trust-folder.80"), null]);
    const r = await answerLaunchDialogs(s.io, OPTS);
    expect(r.outcome).toBe("gone");
    expect(s.sent).toEqual([["Down"]]);
  });
});

describe("answerOnce (the watchdog's single look)", () => {
  test("sends one step and logs it", async () => {
    const s = scripted([fixture("bypass-permissions.120")]);
    expect(await answerOnce(s.io, OPTS)).toEqual({ dialog: "bypass-permissions", keys: ["Down"] });
    expect(s.sent).toEqual([["Down"]]);
    expect(s.logs).toEqual(["launch dialogs: answered bypass-permissions with Down (watchdog)"]);
  });

  test("a live agent's input box gets nothing", async () => {
    const s = scripted([fixture("ready.120")]);
    expect(await answerOnce(s.io, OPTS)).toBeNull();
    expect(s.sent).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */
/* The launch paths that call it                                              */
/* ------------------------------------------------------------------------- */


/** A tmux whose capture-pane shows a per-session screen; records every argv. */
function fakeTmux(screens: Record<string, string>) {
  const calls: string[][] = [];
  return {
    calls,
    tmux: {
      env: {},
      which: (n: string) => `/usr/bin/${n}`,
      async run(argv: string[]): Promise<RunResult> {
        calls.push(argv);
        if (argv[1] === "capture-pane") {
          const session = argv[4]!.replace(/^=/, "").replace(/:$/, "");
          return { exitCode: 0, stdout: screens[session] ?? "", stderr: "" };
        }
        if (argv[1] === "list-panes" && argv.includes("#{session_name}\t#{pane_current_path}")) {
          return { exitCode: 0, stdout: Object.keys(screens).map((s) => `${s}\t/srv/agents/work`).join("\n"), stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

describe("suite restore answers the dialogs of the Claude sessions it starts", () => {
  test("claude entries are polled, a hermes entry is not, and both start", async () => {
    const t = fakeTmux({ "suite-c": fixture("ready.120"), "suite-h": fixture("trust-folder.80") });
    const polled: string[] = [];
    const dialogs: DialogIo = {
      tmux: t.tmux,
      now: () => 0,
      sleep: async () => {},
      log: (s, l) => polled.push(`${s} ${l}`),
    };
    const roster = serializeRoster([
      { session: "suite-c", command: ["tmux", "new-session", "-d", "-s", "suite-c"], cwd: "/srv/agents/work", kind: "claude", recordedAt: "" },
      { session: "suite-h", command: ["tmux", "new-session", "-d", "-s", "suite-h"], cwd: "/srv/agents/work", kind: "hermes", recordedAt: "" },
    ]);
    const deps: RestoreDeps = {
      tmux: t.tmux,
      readRoster: () => roster,
      writeRoster: () => {},
      now: () => new Date(0),
      log: () => {},
      dialogs,
    };
    const r = await runRestore(deps, "/home/agent", { apply: true });
    expect(r.started).toEqual(["suite-c", "suite-h"]);
    const captured = t.calls.filter((a) => a[1] === "capture-pane").map((a) => a[4]);
    expect(captured).toEqual(["=suite-c:"]);
    // The hermes pane showed a dialog-shaped screen and still got nothing.
    expect(t.calls.filter((a) => a[1] === "send-keys")).toEqual([]);
  });
});

describe("suite watch answers a dialog left on screen in a session it owns", () => {
  function watchDeps(t: ReturnType<typeof fakeTmux>, log: string[]): WatchDeps {
    return {
      tmux: t.tmux,
      now: () => new Date(0),
      sleep: async () => {},
      post: async () => 200,
      readTail: () => null,
      realpath: (p) => p,
      listProjectDirs: () => [],
      newestTranscript: () => null,
      log: () => {},
      dialogs: { tmux: t.tmux, now: () => 0, sleep: async () => {}, log: (s, l) => log.push(`${s} ${l}`) },
    };
  }
  const opts = (apply: boolean) => ({ apply, config: emptyConfig(), auth: null, host: "h", home: "/home/agent" });

  test("one step per owned session per pass; a live agent gets nothing", async () => {
    const t = fakeTmux({ "suite-a": fixture("trust-folder.80"), "suite-b": fixture("ready.120") });
    const log: string[] = [];
    await runWatch(watchDeps(t, log), opts(true));
    expect(t.calls.filter((a) => a[1] === "send-keys")).toEqual([["/usr/bin/tmux", "send-keys", "-t", "=suite-a:", "Down"]]);
    expect(log).toEqual(["suite-a launch dialogs: answered trust-folder with Down (watchdog)"]);
  });

  test("--dry-run sends nothing", async () => {
    const t = fakeTmux({ "suite-a": fixture("trust-folder.80") });
    await runWatch(watchDeps(t, []), opts(false));
    expect(t.calls.filter((a) => a[1] === "send-keys")).toEqual([]);
  });
});
