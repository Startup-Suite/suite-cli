/**
 * Seeding Claude Code's own "onboarding finished" mark before an UNATTENDED
 * launch, so a fresh user's agent does not park on first-run screens nobody is
 * there to see (task 01a0d6b9, review round 2).
 *
 * MEASURED on Claude Code 2.1.289 (rock, macOS 26.3, 2026-10-05), each on a
 * fresh HOME with a fresh ~/.claude.json, launched exactly as `suite claude`
 * launches it:
 *
 *   ~/.claude.json before launch      credentials   screens, in order
 *   ---------------------------------  -----------  ---------------------------------------------
 *   (none)                             none         theme -> "Select login method" (stops there)
 *   (none)                             API-key env  theme -> custom-key -> security notes -> ...
 *   {"hasCompletedOnboarding": true}   none         trust -> bypass -> input box "Not logged in"
 *   {"hasCompletedOnboarding": true}   API-key env  trust -> custom-key -> bypass -> input box
 *
 * So ONE key suppresses all three onboarding screens (theme, the login-method
 * picker, security notes), and `theme` is NOT needed (seeding only
 * hasCompletedOnboarding skipped the theme screen too). That is the only key
 * written. Trust, bypass-permissions and dev-channels are not onboarding: they
 * stay with the dialog answerer, which recognises them word for word.
 *
 * WHAT THIS NEVER DOES: it does not log anyone in. A user with no Claude
 * credentials still has none afterwards; Claude then reaches its input box
 * marked "Not logged in", the answerer reports `login_required`, and a person
 * signs in with Claude Code's own `claude auth login`. suite never enters,
 * relays or stores a Claude credential (Anthropic's terms forbid
 * intermediating Claude.ai credentials).
 *
 * HOW IT WRITES: read, parse, set one key, write a sibling temp file with the
 * existing mode (0600 when new), rename over. A file that is not a JSON object
 * is left untouched. The key is set only when it is not already `true`; no
 * other key is added, removed or reordered by us (JSON.parse/stringify keeps
 * insertion order). The read-modify-write is not locked against a Claude
 * process writing the same file at the same instant; it runs before this
 * launch's Claude starts, and is a no-op once the key is true.
 */
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ONBOARDING_KEY = "hasCompletedOnboarding";

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
