/**
 * Reading where a Claude Code pane stands — ready, at a dialog, or waiting for
 * a login — and writing that down as a machine-readable STATUS FILE.
 *
 * WHO READS IT. Suite's agent host runs native agents with no terminal
 * attached. It cannot look at a pane, and it must not have its own pane
 * classifier: there is ONE, and it is this CLI's (`claude_dialogs.ts` for the
 * dialogs, this module for the login screens). The host runs
 * `suite pane-status --session NAME` as the agent's own user and reads the
 * JSON it prints and writes.
 *
 * LOGIN IS ANTHROPIC'S, NOT OURS. This module only RECOGNISES the login
 * screens. It never chooses a login method, never types into a login screen,
 * and never reads, stores or relays a credential, a login code or a session
 * token. The one value it reports from a login screen is the sign-in URL
 * Claude Code itself prints for a person to open — Anthropic's own flow, which
 * the person completes on Anthropic's site. Whether a login is needed, and
 * that URL, are all a status file may say about a login.
 *
 * Recognition follows the dialog module's first rule: a screen is known only
 * by its exact text. The screens were captured from Claude Code 2.1.295 on
 * Linux at 80 and 120 columns (fixtures under
 * test/fixtures/claude-code-2.1.295-login/, with the URL's `state` and
 * `code_challenge` values overwritten). When Claude Code rewords one, it stops
 * being recognised and reads `unknown`, never a guess.
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { classifyPane, type DialogContext, type DialogName } from "./claude_dialogs.ts";

export type LoginStep = "login_method" | "login_url" | "api_key_confirm";

export interface LoginScreen {
  step: LoginStep;
  /** Only for `login_url`: the sign-in URL Claude Code printed, re-joined across wrapped lines. */
  url?: string;
}

/** The login-method chooser, word for word (the cursor may be on any option). */
export const LOGIN_METHOD_INTRO =
  "Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.";
export const LOGIN_METHOD_HEADING = "Select login method:";
export const LOGIN_METHOD_OPTIONS = [
  "1. Claude account with subscription · Pro, Max, Team, or Enterprise",
  "2. Anthropic Console account · API usage billing",
  "3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, Google Vertex AI",
] as const;

/** The sign-in screen: this line, then the URL, then the paste prompt. */
export const LOGIN_URL_LEAD = "Browser didn't open? Use the url below to sign in (c to copy)";
export const LOGIN_URL_PREFIX = "https://claude.com/cai/oauth/authorize?";
export const LOGIN_PASTE_PROMPT = "Paste code here if prompted >";

/** The API-key confirmation Claude Code shows when ANTHROPIC_API_KEY is set. */
export const API_KEY_HEADING = "Detected a custom API key in your environment";
export const API_KEY_QUESTION = "Do you want to use this API key?";

const CURSOR = "❯";
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

function nonBlank(pane: string): string[] {
  return pane
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "");
}

function loginMethod(lines: string[]): LoginScreen | null {
  const h = lines.findIndex((l) => l.trim() === LOGIN_METHOD_HEADING);
  if (h === -1) return null;
  // The intro wraps at narrow widths: compare it re-joined.
  const intro = squash(lines.slice(Math.max(0, h - 2), h).join(" "));
  if (!intro.endsWith(LOGIN_METHOD_INTRO)) return null;
  const options = lines.slice(h + 1, h + 1 + LOGIN_METHOD_OPTIONS.length);
  if (options.length !== LOGIN_METHOD_OPTIONS.length) return null;
  let cursors = 0;
  for (let i = 0; i < options.length; i++) {
    let text = options[i]!.trim();
    if (text.startsWith(`${CURSOR} `)) {
      cursors++;
      text = text.slice(CURSOR.length).trim();
    }
    if (text !== LOGIN_METHOD_OPTIONS[i]) return null;
  }
  return cursors === 1 ? { step: "login_method" } : null;
}

function loginUrl(lines: string[]): LoginScreen | null {
  const lead = lines.findIndex((l) => l.trim() === LOGIN_URL_LEAD);
  if (lead === -1) return null;
  const prompt = lines.findIndex((l, i) => i > lead && l.trim() === LOGIN_PASTE_PROMPT);
  if (prompt === -1) return null;
  // The URL is hard-wrapped by Claude Code itself at the pane width, so it is
  // re-joined from every line between the lead and the prompt. A URL has no
  // whitespace; a segment that has some is not part of one.
  const segments = lines.slice(lead + 1, prompt).map((l) => l.trim());
  if (segments.length === 0 || segments.some((s) => /\s/.test(s))) return null;
  const url = segments.join("");
  if (!url.startsWith(LOGIN_URL_PREFIX)) return null;
  return { step: "login_url", url };
}

function apiKeyConfirm(lines: string[]): LoginScreen | null {
  const h = lines.findIndex((l) => l.trim() === API_KEY_HEADING);
  if (h === -1) return null;
  const rest = lines.slice(h + 1).map((l) => l.trim().replace(new RegExp(`^${CURSOR}\\s*`), ""));
  // Heading, the key line (masked by Claude Code), the question, Yes, No.
  if (!/^ANTHROPIC_API_KEY: \S+$/.test(rest[0] ?? "")) return null;
  if (rest[1] !== API_KEY_QUESTION) return null;
  if (rest[2] !== "Yes" || rest[3] !== "No (recommended)") return null;
  return { step: "api_key_confirm" };
}

/** (captured pane) → the login screen it shows, or null. Pure. */
export function classifyLogin(pane: string): LoginScreen | null {
  const lines = nonBlank(pane);
  return loginMethod(lines) ?? loginUrl(lines) ?? apiKeyConfirm(lines);
}

/* ------------------------------------------------------------------------- */
/* The status document                                                        */
/* ------------------------------------------------------------------------- */

export type PaneState =
  /** Claude's input box is up. */
  | "ready"
  /** A launch dialog this CLI knows (and answers when asked to). */
  | "dialog"
  /** A login screen: a person has to log in through Anthropic's flow. */
  | "needs_login"
  /** Something with a dialog footer this CLI does not know. Nobody answers it. */
  | "unknown_dialog"
  /** Still drawing, or a screen nothing here recognises. */
  | "starting"
  /** No such tmux session. */
  | "gone";

export interface PaneStatus {
  version: 1;
  session: string;
  state: PaneState;
  /** For `dialog`: which one. */
  dialog?: DialogName;
  /** For `unknown_dialog`: its first line, so an operator can see why the agent waits. */
  title?: string;
  /** For `needs_login`. */
  login?: LoginScreen;
  observed_at: string;
}

/** (captured pane, or null when the session is gone) → status. Pure. */
export function paneStatus(session: string, pane: string | null, ctx: DialogContext, now: Date): PaneStatus {
  const base = { version: 1 as const, session, observed_at: now.toISOString() };
  if (pane === null) return { ...base, state: "gone" };
  const login = classifyLogin(pane);
  if (login !== null) return { ...base, state: "needs_login", login };
  const step = classifyPane(pane, ctx);
  switch (step.kind) {
    case "ready":
      return { ...base, state: "ready" };
    case "answer":
    case "hold":
      return { ...base, state: "dialog", dialog: step.dialog };
    case "unknown":
      return { ...base, state: "unknown_dialog", title: step.title };
    default:
      return { ...base, state: "starting" };
  }
}

/** Next to the session log: `~/.local/state/suite/sessions/<session>.status.json`. */
export function sessionStatusPath(home: string, session: string): string {
  return `${home}/.local/state/suite/sessions/${session}.status.json`;
}

/**
 * Write the status atomically (temp file, then rename), mode 0600, so a reader
 * never sees half a document.
 */
export function writePaneStatus(path: string, status: PaneStatus): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
