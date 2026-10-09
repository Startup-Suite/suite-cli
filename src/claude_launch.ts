/**
 * The LAUNCH RECORD: what `suite claude` saw while it watched a session it had
 * just created, written next to the session's status file (core task 01a10322
 * stage 7).
 *
 * Why it exists. `suite pane-status` looks at ONE frame. One frame cannot tell
 * "Claude is still drawing" from "Claude never got past a screen nobody here
 * answers": both read `starting`. The behavioural gate found a native agent
 * parked on Claude Code's first-run security notes for ten minutes, reported
 * `starting` the whole time. The launch poll already knows the difference (it
 * gives up after its window, `DIALOG_WINDOW_MS`), so it writes that down, and
 * pane-status reports `stuck` instead of `starting` once the launch has timed
 * out and the pane is still not usable.
 *
 * It also records a BASELINE for the auth-error check: `suite claude` launches
 * with `--continue`, and Claude Code re-renders the previous conversation, so
 * an "Invalid API key" from BEFORE this launch is still on screen after a
 * restart with a fixed key. The baseline is the auth-error signature (if any)
 * on the first frame where Claude's input box was up; only a different one is
 * a new failure (claude_login.ts `authError`).
 *
 * pane-status adds one fact to it: `auth_rejected`, once this launch's startup
 * notice said its credential was rejected.
 *
 * The record holds no secret, no pane text beyond those few signature lines,
 * and is written 0600 in a 0700 directory.
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type LaunchOutcome = "pending" | "ready" | "timeout" | "gone";

export interface LaunchRecord {
  version: 1;
  session: string;
  outcome: LaunchOutcome;
  started_at: string;
  finished_at?: string;
  /** Dialog names answered during the launch window, in order. */
  answered?: string[];
  /** The auth-error signature on screen when the input box first appeared, or null. */
  baseline?: string | null;
  /**
   * Set by pane-status the first time it sees this launch's startup notice
   * that the credential was REJECTED (claude_login.ts AUTH_REJECTED_NOTICE).
   * The notice can scroll away; the launch's credential stays rejected.
   */
  auth_rejected?: boolean;
}

/** `~/.local/state/suite/sessions/<session>.launch.json`. */
export function launchRecordPath(home: string, session: string): string {
  return `${home}/.local/state/suite/sessions/${session}.launch.json`;
}

export function writeLaunchRecord(path: string, record: LaunchRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** The record, or null when there is none or it is not a plain file of the right shape. */
export function readLaunchRecord(path: string): LaunchRecord | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    const doc = JSON.parse(readFileSync(path, "utf8")) as Partial<LaunchRecord>;
    if (doc?.version !== 1 || typeof doc.outcome !== "string") return null;
    return doc as LaunchRecord;
  } catch {
    return null;
  }
}
