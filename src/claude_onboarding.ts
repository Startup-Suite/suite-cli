/**
 * Seeding Claude Code's own "onboarding finished" mark before an UNATTENDED
 * launch, so an agent nobody can type into does not park on first-run screens
 * (first written for task 01a0d6b9 on Claude Code 2.1.289; ported to the
 * pane-status branch for core task 01a10322 stage 7 on 2.1.295).
 *
 * WHEN: only when the launching process says it is unattended,
 * `SUITE_UNATTENDED=1` in the environment (Suite's agent host sets it in
 * `suite-agent@.service`). A person running `suite claude` at a terminal still
 * sees Claude's own first run.
 *
 * WHY THIS ONE KEY, READ FROM THE PINNED 2.1.295 BINARY (not guessed). Its
 * launch sequence renders the Onboarding component only through
 *
 *     if (config.hasCompletedOnboarding && CLAUDE_CODE_POWERUP_ONBOARDING !== "banner"
 *         && CLAUDE_CODE_POWERUP_ONBOARDING !== "step") return null;   // skip onboarding
 *
 * and inside Onboarding the steps are preflight (if oauth && !h), theme,
 * api-key (if a custom key exists), oauth (if oauth), then `security`, which
 * is pushed UNCONDITIONALLY. So with the key true, none of those screens can
 * appear, the security notes included. Claude's own eval harness seeds the
 * same key (`{hasCompletedOnboarding: true, ...}` into a fresh .claude.json).
 *
 * MEASURED on 2.1.295 (moon, node:22 container, fresh HOME, a well-formed fake
 * ANTHROPIC_API_KEY, 2026-10-09; fixtures in
 * test/fixtures/claude-code-2.1.295-onboarding/):
 *
 *   ~/.claude.json before launch      screens, in order
 *   ---------------------------------  ------------------------------------------------
 *   (none)                             theme -> custom-key -> security notes -> ...
 *   {"hasCompletedOnboarding": true}   trust -> custom-key -> bypass -> input box
 *
 * Trust, custom-key and bypass-permissions are not onboarding: they stay with
 * the dialog answerer, which recognises them word for word.
 *
 * WHAT THIS NEVER DOES: it does not log anyone in. A user with no Claude
 * credentials still has none afterwards; Claude reaches its input box and its
 * first turn fails, which pane-status reports as needs_login. suite never
 * enters, relays or stores a Claude credential.
 *
 * HOW IT WRITES: read, parse, set one key, write a sibling temp file with the
 * existing mode (0600 when new), rename over. A file that is not a JSON object
 * is left untouched. The key is set only when it is not already `true`; no
 * other key is added, removed or reordered (JSON.parse/stringify keeps
 * insertion order). It runs as the launching user, before this launch's
 * Claude starts, and is a no-op once the key is true.
 */
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ONBOARDING_KEY = "hasCompletedOnboarding";

/** The environment variable that marks a launch as unattended. */
export const UNATTENDED_ENV = "SUITE_UNATTENDED";

export function isUnattended(env: Record<string, string | undefined>): boolean {
  return env[UNATTENDED_ENV] === "1";
}

export type SeedOutcome =
  /** The key was absent or not true, and is now true. */
  | "seeded"
  /** Claude (or an earlier seed) already recorded it. Nothing written. */
  | "already_complete"
  /** The file exists but is not a JSON object. Nothing written. */
  | "unreadable"
  /** The write failed. Nothing changed. */
  | "write_failed";

export interface OnboardingIo {
  exists(path: string): boolean;
  read(path: string): string;
  /** Mode bits of an existing file. */
  mode(path: string): number;
  /** Writes `text` to `path` with `mode`, atomically (temp + rename). */
  writeAtomic(path: string, text: string, mode: number): void;
}

export const liveOnboardingIo: OnboardingIo = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, "utf8"),
  mode: (p) => statSync(p).mode & 0o777,
  writeAtomic(path, text, mode) {
    const tmp = join(dirname(path), `.claude.json.suite-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(tmp, text, { mode, flag: "wx" });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  },
};

/** Mark Claude Code's onboarding complete in `claudeJson`. See the module comment. */
export function seedOnboarding(claudeJson: string, io: OnboardingIo = liveOnboardingIo): SeedOutcome {
  let doc: Record<string, unknown> = {};
  let mode = 0o600;
  if (io.exists(claudeJson)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(io.read(claudeJson));
    } catch {
      return "unreadable";
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "unreadable";
    doc = parsed as Record<string, unknown>;
    if (doc[ONBOARDING_KEY] === true) return "already_complete";
    try {
      mode = io.mode(claudeJson);
    } catch {
      return "write_failed";
    }
  }
  doc[ONBOARDING_KEY] = true;
  try {
    io.writeAtomic(claudeJson, `${JSON.stringify(doc, null, 2)}\n`, mode);
  } catch {
    return "write_failed";
  }
  return "seeded";
}

/** The session-log line for an outcome. */
export function seedLogLine(outcome: SeedOutcome, claudeJson: string): string {
  switch (outcome) {
    case "seeded":
      return `onboarding: set ${ONBOARDING_KEY} in ${claudeJson} (suppresses Claude's theme, sign-in method and security-notes screens; logs nobody in)`;
    case "already_complete":
      return `onboarding: ${ONBOARDING_KEY} already set in ${claudeJson}`;
    case "unreadable":
      return `onboarding: ${claudeJson} is not a JSON object; left untouched, so Claude may show its first-run screens`;
    case "write_failed":
      return `onboarding: could not write ${claudeJson}; Claude may show its first-run screens`;
  }
}
