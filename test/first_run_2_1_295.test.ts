/**
 * Claude Code 2.1.295 first run, unattended (core task 01a10322 stage 7).
 *
 * The behavioural gate found Suite native agents parked on 2.1.295's
 * first-run "Security notes" screen for ten minutes, read as `starting`. Three
 * fixes, each pinned here:
 *
 *   1. `SUITE_UNATTENDED=1` seeds `hasCompletedOnboarding` before launch, so
 *      the onboarding screens never appear (claude_onboarding.ts);
 *   2. the security notes are recognised and answered (Enter) as a fallback;
 *   3. a launch that timed out with the pane still unusable reads `stuck`,
 *      and a turn that failed on an invalid key reads `needs_login`
 *      (`auth_error`), except for the failure `--continue` re-renders from
 *      before this launch.
 *
 * Fixtures: real `tmux capture-pane -p` output of 2.1.295 on Linux (moon,
 * node:22 container, fresh HOME, a well-formed FAKE ANTHROPIC_API_KEY),
 * under test/fixtures/claude-code-2.1.295-onboarding/. Unedited. The two
 * `agent-host-*` fixtures are panes of real native agents in Suite's agent
 * host image (contained profile, rig 01a10322-s7): one with a well-formed
 * invalid key, one with no key at all.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { answerLaunchDialogs, classifyPane, type DialogIo } from "../src/claude_dialogs.ts";
import { launchRecordPath, readLaunchRecord, writeLaunchRecord, type LaunchRecord } from "../src/claude_launch.ts";
import { authError, authRejected, notLoggedIn, paneStatus } from "../src/claude_login.ts";
import { runPaneStatus, type PaneStatusDeps } from "../src/commands/pane_status.ts";
import { isUnattended, ONBOARDING_KEY, seedOnboarding } from "../src/claude_onboarding.ts";
import type { RunResult } from "../src/tmux.ts";

const DIR = resolve(import.meta.dir, "fixtures/claude-code-2.1.295-onboarding");
const fixture = (name: string): string => readFileSync(resolve(DIR, `${name}.txt`), "utf8");
/**
 * The pane minus 2.1.295's startup 401 notice (and its wrapped tail), so a
 * test of the PER-TURN error does not pass on the notice instead. Without the
 * notice the frame is what a process whose startup fetch did not fail draws.
 */
const withoutNotice = (pane: string): string => {
  const out: string[] = [];
  let skipping = false;
  for (const l of pane.split("\n")) {
    if (l.startsWith("⚠ Remote managed settings failed to load")) skipping = true;
    else if (skipping && /^\s+\S/.test(l)) continue;
    else skipping = false;
    if (!skipping) out.push(l);
  }
  return out.join("\n");
};
const CTX = { cwd: "/tmp/h-s120/work", home: "/tmp/h-s120" };
const NOW = new Date("2026-10-09T23:10:00.000Z");
const launch = (outcome: LaunchRecord["outcome"], baseline: string | null = null): LaunchRecord => ({
  version: 1,
  session: "suite-agent",
  outcome,
  started_at: "2026-10-09T23:00:00.000Z",
  baseline,
});

describe("the security notes are answered with Enter (fallback), and only the exact screen", () => {
  for (const width of ["80", "120"]) {
    test(`security-notes.${width} → Enter`, () => {
      expect(classifyPane(fixture(`security-notes.${width}`), CTX)).toEqual({
        kind: "answer",
        dialog: "security-notes",
        keys: ["Enter"],
      });
    });
  }

  test("one changed word is not answered", () => {
    const pane = fixture("security-notes.120").replace("Claude can make mistakes.", "Claude makes mistakes.");
    expect(classifyPane(pane, CTX).kind).not.toBe("answer");
  });

  test("the notes quoted ABOVE other output (a transcript) are not the screen", () => {
    const pane = `${fixture("security-notes.120")}\n● some later reply\n`;
    expect(classifyPane(pane, CTX).kind).not.toBe("answer");
  });
});

describe("a seeded launch shows no onboarding screen", () => {
  test("its first screen is the trust dialog, which the answerer already knows", () => {
    expect(classifyPane(fixture("seeded-first-screen.120"), CTX)).toEqual({
      kind: "answer",
      dialog: "trust-folder",
      keys: ["Down"],
    });
  });

  test("and it reaches the input box", () => {
    expect(classifyPane(fixture("input-box.120"), CTX)).toEqual({ kind: "ready" });
  });
});

describe("seedOnboarding", () => {
  const dir = () => mkdtempSync(resolve(tmpdir(), "suite-onboarding-01a10322-s7-"));

  test("a missing file is created 0600 holding only the key", () => {
    const path = resolve(dir(), ".claude.json");
    expect(seedOnboarding(path)).toBe("seeded");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ [ONBOARDING_KEY]: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("an existing file keeps every other key and its mode; a second seed writes nothing", () => {
    const path = resolve(dir(), ".claude.json");
    writeFileSync(path, JSON.stringify({ projects: { "/w": { hasTrustDialogAccepted: true } }, userID: "u" }), { mode: 0o640 });
    expect(seedOnboarding(path)).toBe("seeded");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      projects: { "/w": { hasTrustDialogAccepted: true } },
      userID: "u",
      [ONBOARDING_KEY]: true,
    });
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(seedOnboarding(path)).toBe("already_complete");
  });

  test("a file that is not a JSON object is left alone", () => {
    const path = resolve(dir(), ".claude.json");
    writeFileSync(path, "[1,2]");
    expect(seedOnboarding(path)).toBe("unreadable");
    expect(readFileSync(path, "utf8")).toBe("[1,2]");
  });

  test("only SUITE_UNATTENDED=1 is unattended", () => {
    expect(isUnattended({ SUITE_UNATTENDED: "1" })).toBe(true);
    expect(isUnattended({ SUITE_UNATTENDED: "true" })).toBe(false);
    expect(isUnattended({})).toBe(false);
  });
});

describe("an invalid key: Claude reaches its input box, the first turn fails, needs_login", () => {
  for (const width of ["80", "120"]) {
    test(`invalid-key-turn.${width} → auth_error`, () => {
      const pane = withoutNotice(fixture(`invalid-key-turn.${width}`));
      expect(pane).not.toContain("authentication rejected");
      expect(authError(pane)?.error).toBe("Invalid API key · Fix external API key");
      expect(paneStatus("s", pane, CTX, NOW)).toMatchObject({ state: "needs_login", login: { step: "auth_error" } });
    });
  }

  test("POSITIVE CONTROL: the same input box with no failed turn is ready", () => {
    expect(authError(fixture("input-box.120"))).toBeNull();
    expect(paneStatus("s", fixture("input-box.120"), CTX, NOW).state).toBe("ready");
  });

  test("a later reply under the error makes it history", () => {
    const pane = withoutNotice(fixture("invalid-key-turn.120")).replace("✻ Crunched", "● PONG\n✻ Crunched");
    expect(authError(pane)).toBeNull();
  });

  test("an error text that is not one of Claude's auth errors is not one", () => {
    const pane = withoutNotice(fixture("invalid-key-turn.120")).replace("Invalid API key · Fix external API key", "Invalid API key (said the user)");
    expect(authError(pane)).toBeNull();
  });
});

describe("--continue re-renders the old failure: the launch baseline keeps it from reading as new", () => {
  const old = withoutNotice(fixture("continue-after-error.120"));
  const baseline = authError(old)!.signature;

  test("with the baseline the restarted agent is ready", () => {
    expect(paneStatus("s", old, CTX, NOW, launch("ready", baseline)).state).toBe("ready");
  });

  test("the notice-stripping helper really removed the notice (guard)", () => {
    expect(authRejected(fixture("continue-after-error.120"))).toBe(true);
    expect(authRejected(old)).toBe(false);
  });

  test("POSITIVE CONTROL: without it, the same frame reads needs_login", () => {
    expect(paneStatus("s", old, CTX, NOW, launch("ready", null)).state).toBe("needs_login");
  });

  test("a NEW failed turn after the restart is needs_login despite the baseline", () => {
    expect(paneStatus("s", withoutNotice(fixture("continue-second-turn.120")), CTX, NOW, launch("ready", baseline))).toMatchObject({
      state: "needs_login",
      login: { step: "auth_error" },
    });
  });
});

describe("a launch that timed out with the pane still unusable is stuck", () => {
  const unknown = "────────────────────\n Something new\n ❯ 1. Go\n Enter to confirm · Esc to cancel\n";

  test("blank pane: starting while the launch is pending, stuck after it timed out", () => {
    expect(paneStatus("s", "\n", CTX, NOW, launch("pending")).state).toBe("starting");
    expect(paneStatus("s", "\n", CTX, NOW, launch("timeout"))).toMatchObject({
      state: "stuck",
      reason: "Claude's input box did not appear",
    });
  });

  test("an unknown dialog after the timeout names its title", () => {
    expect(paneStatus("s", unknown, CTX, NOW).state).toBe("unknown_dialog");
    expect(paneStatus("s", unknown, CTX, NOW, launch("timeout"))).toMatchObject({
      state: "stuck",
      reason: "an unrecognised screen: Something new",
    });
  });

  test("POSITIVE CONTROL: an input box after a timeout is ready, and an answerable screen is a dialog", () => {
    expect(paneStatus("s", fixture("input-box.120"), CTX, NOW, launch("timeout")).state).toBe("ready");
    expect(paneStatus("s", fixture("security-notes.120"), CTX, NOW, launch("timeout"))).toMatchObject({
      state: "dialog",
      dialog: "security-notes",
    });
  });
});

describe("the launch record", () => {
  test("is written 0600 and read back; anything else reads as none", () => {
    const home = mkdtempSync(resolve(tmpdir(), "suite-launch-01a10322-s7-"));
    const path = launchRecordPath(home, "suite-agent");
    writeLaunchRecord(path, launch("timeout"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readLaunchRecord(path)).toEqual(launch("timeout"));
    writeFileSync(path, "{}");
    expect(readLaunchRecord(path)).toBeNull();
    expect(readLaunchRecord(resolve(home, "nope.json"))).toBeNull();
  });
});

describe("answerLaunchDialogs walks the unseeded 2.1.295 first run when the seed did not take", () => {
  test("security notes → Enter, then ready, and the ready frame is returned for the baseline", async () => {
    const frames = [fixture("security-notes.120"), fixture("input-box.120")];
    let i = 0;
    const sent: string[][] = [];
    let clock = 0;
    const run = async (argv: string[]): Promise<RunResult> => {
      if (argv[1] === "capture-pane") return { exitCode: 0, stdout: frames[Math.min(i, frames.length - 1)]!, stderr: "" };
      sent.push(argv);
      i++;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const io: DialogIo = {
      tmux: { run, which: () => "tmux" } as unknown as DialogIo["tmux"],
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      log: () => {},
    };
    const result = await answerLaunchDialogs(io, { session: "suite-agent", cwd: CTX.cwd, home: CTX.home });
    expect(result.outcome).toBe("ready");
    expect(result.answered).toEqual([{ dialog: "security-notes", keys: ["Enter"] }]);
    expect(result.pane).toBe(fixture("input-box.120"));
    expect(sent).toEqual([["tmux", "send-keys", "-t", "=suite-agent:", "Enter"]]);
  });
});

describe("in the agent host, an invalid key is rejected at STARTUP, before any turn", () => {
  // Measured: Claude reaches its input box, but its managed-settings fetch gets
  // a 401 and the development channel then drops every inbound message, so no
  // turn ever runs. The startup notice is the only sign.
  const pane = fixture("agent-host-invalid-key.80");

  test("the 401 notice (wrapped at 80 columns) reads needs_login / auth_error", () => {
    expect(authRejected(pane)).toBe(true);
    expect(paneStatus("s", pane, CTX, NOW, launch("ready"))).toMatchObject({ state: "needs_login", login: { step: "auth_error" } });
  });

  test("POSITIVE CONTROL: an input box without the notice is ready", () => {
    expect(authRejected(fixture("input-box.120"))).toBe(false);
  });

  test("another startup warning is not it", () => {
    const other = pane.replace("authentication rejected (401)", "request timed out");
    expect(authRejected(other)).toBe(false);
    expect(paneStatus("s", other, CTX, NOW).state).toBe("ready");
  });

  test("once seen, the launch stays rejected after the notice scrolls away", () => {
    const scrolled = fixture("input-box.120");
    expect(paneStatus("s", scrolled, CTX, NOW, { ...launch("ready"), auth_rejected: true }).state).toBe("needs_login");
    expect(paneStatus("s", scrolled, CTX, NOW, launch("ready")).state).toBe("ready");
  });

  test("suite pane-status records auth_rejected on the launch record, once", async () => {
    const written: LaunchRecord[] = [];
    const run = async (argv: string[]): Promise<RunResult> =>
      argv[1] === "capture-pane" ? { exitCode: 0, stdout: pane, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" };
    const tmux = { run, which: () => "tmux" } as unknown as PaneStatusDeps["tmux"];
    let stored: LaunchRecord | null = launch("ready");
    const out: string[] = [];
    const deps: PaneStatusDeps = {
      tmux,
      env: { HOME: "/home/agent" },
      cwd: "/home/agent/work",
      now: () => NOW,
      out: (l) => void out.push(l),
      err: () => {},
      write: () => {},
      readLaunch: () => stored,
      writeLaunch: (_p, r) => {
        written.push(r);
        stored = r;
      },
      dialogs: { tmux, now: () => 0, sleep: async () => {}, log: () => {} },
    };
    await runPaneStatus(deps, ["--session", "suite-agent"]);
    await runPaneStatus(deps, ["--session", "suite-agent"]);
    expect(written).toEqual([{ ...launch("ready"), auth_rejected: true }]);
    expect(JSON.parse(out[1]!)).toMatchObject({ state: "needs_login", login: { step: "auth_error" } });
  });
});

describe("in the agent host, no credential at all", () => {
  // With onboarding seeded, Claude skips its login-method step and shows its
  // input box marked "Not logged in"; that must not read as ready.
  test("agent-host-no-key.80 → needs_login / not_logged_in", () => {
    const pane = fixture("agent-host-no-key.80");
    expect(notLoggedIn(pane)).toBe(true);
    expect(paneStatus("s", pane, CTX, NOW, launch("ready"))).toMatchObject({ state: "needs_login", login: { step: "not_logged_in" } });
  });

  test("POSITIVE CONTROL: the mark quoted ABOVE the input box is not the status line", () => {
    const lines = fixture("input-box.120").split("\n");
    const box = lines.findIndex((l) => l.startsWith("❯"));
    lines.splice(box - 1, 0, "  Not logged in · Run /login");
    const pane = lines.join("\n");
    expect(pane).toContain("Not logged in · Run /login");
    expect(notLoggedIn(pane)).toBe(false);
    // ...and the same line BELOW the box is.
    lines.splice(box - 1, 1);
    lines.splice(box + 2, 0, "  Not logged in · Run /login");
    expect(notLoggedIn(lines.join("\n"))).toBe(true);
  });
});
