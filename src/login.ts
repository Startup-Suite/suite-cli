/**
 * Harness login state and login output: the ONE classifier.
 *
 * SHARED MODULE. Everything in suite-cli that asks "is this harness logged
 * in?" or reads a harness's own login output goes through this file:
 * `suite harness --json`, `suite login`, and — when task 01a10322 lands its
 * agent-host status file — that writer too. A second classifier would be a
 * second answer to the same question, and the two would drift the first time
 * a vendor changed a word. Extend this module; do not add another.
 *
 * Pure: every function takes text and exit codes and returns a value. Nothing
 * here spawns, reads a file or holds a credential. The inputs are a harness's
 * own status and login output, which carry NO credential: Claude Code's
 * `auth status --json` names a method, Codex's `login status` prints a
 * sentence, and the login URLs carry an OAuth `state` and a PKCE challenge
 * (public by design), never a token.
 *
 * MEASURED (rock, macOS 26.3, isolated HOME, 2026-10-05; fixtures under
 * test/fixtures/harness-login/):
 *
 *   claude 2.1.289  `claude auth status --json` prints a JSON document on
 *                   stdout in BOTH states; exit 0 logged in, 1 logged out
 *                   ({"loggedIn": false, "authMethod": "none", ...}).
 *   claude 2.1.289  `claude auth login --claudeai` listens on 127.0.0.1:<port>
 *                   and opens `$BROWSER` with redirect_uri
 *                   http://localhost:<port>/callback (a LOCALHOST CALLBACK),
 *                   and ALSO prints a fallback URL whose redirect_uri is
 *                   https://platform.claude.com/oauth/code/callback, followed
 *                   by "Paste code here if prompted >". The fallback is a
 *                   pasted code; suite never uses it (see commands/login.ts).
 *   codex 0.157.0   `codex login status` exits 1 and prints "Not logged in"
 *                   on stderr when logged out; exit 0 when logged in.
 *   codex 0.157.0   `codex login --device-auth` prints a URL
 *                   (https://auth.openai.com/codex/device) and a one-time
 *                   code `XXXX-XXXXX` "(expires in 15 minutes)", in ANSI colour.
 */

/** true / false, or `unknown` when the harness gave an answer we cannot read. */
export type LoggedIn = true | false | "unknown";

/** Strip ANSI CSI sequences (colour) from terminal output. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

export interface ClaudeAuthStatus {
  logged_in: LoggedIn;
  /** `claude.ai`, `console`, `none`, ... as Claude reports it; null when unreadable. */
  method: string | null;
}

/**
 * `claude auth status --json`. The JSON wins over the exit code: 2.1.289 exits
 * 1 when logged out but still prints the document, and a future version that
 * exits 0 either way is read correctly too. No JSON at all is `unknown`, never
 * `false` — "could not tell" must not read as "go log in".
 */
export function classifyClaudeAuthStatus(stdout: string, exitCode: number): ClaudeAuthStatus {
  const text = stdout.trim();
  const start = text.indexOf("{");
  if (start !== -1) {
    try {
      const raw = JSON.parse(text.slice(start)) as { loggedIn?: unknown; authMethod?: unknown };
      const method = typeof raw.authMethod === "string" ? raw.authMethod : null;
      if (raw.loggedIn === true) return { logged_in: true, method };
      if (raw.loggedIn === false) return { logged_in: false, method };
    } catch {
      /* fall through */
    }
  }
  void exitCode;
  return { logged_in: "unknown", method: null };
}

/**
 * `codex login status`. Exit 0 is logged in; exit non-zero WITH the "Not
 * logged in" sentence is logged out; anything else (a config error, a missing
 * CODEX_HOME, a crash) is `unknown`.
 */
export function classifyCodexLoginStatus(exitCode: number, stdout: string, stderr: string): LoggedIn {
  if (exitCode === 0) return true;
  const text = stripAnsi(`${stdout}\n${stderr}`);
  if (/^\s*Not logged in\s*$/m.test(text)) return false;
  return "unknown";
}

/** True when an OAuth authorize URL's redirect_uri is a loopback callback. */
export function isLocalhostCallback(url: string): boolean {
  try {
    const redirect = new URL(url).searchParams.get("redirect_uri");
    if (redirect === null) return false;
    const host = new URL(redirect).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * The URL Claude Code handed `$BROWSER`, from the shim's record (one argv word
 * per line). Only an https URL with a LOOPBACK redirect is accepted: that is
 * the flow in which the user's own browser talks to Anthropic and back to
 * Claude Code, and nothing passes through suite.
 */
export function browserUrlFromShim(text: string): string | null {
  for (const line of text.split("\n")) {
    const candidate = line.trim();
    if (!candidate.startsWith("https://")) continue;
    if (isLocalhostCallback(candidate)) return candidate;
  }
  return null;
}

export interface ClaudeLoginOutput {
  /** Claude printed its paste-code fallback ("Paste code here if prompted"). */
  pasteFallbackOffered: boolean;
  /** Claude said it is opening a browser. */
  openingBrowser: boolean;
}

/**
 * What `claude auth login` printed on stdout. Only SHAPE is read: the fallback
 * URL in that output leads to a pasted code, which suite never relays, so it
 * is deliberately not extracted.
 */
export function classifyClaudeLoginOutput(stdout: string): ClaudeLoginOutput {
  const text = stripAnsi(stdout);
  return {
    pasteFallbackOffered: /Paste code here if prompted/i.test(text),
    openingBrowser: /Opening browser/i.test(text),
  };
}

export interface CodexDeviceCode {
  url: string;
  code: string;
  /** Minutes until the code expires, as Codex printed it; null when absent. */
  expiresInMinutes: number | null;
}

/**
 * The device-code screen of `codex login --device-auth`, or null until both
 * the URL and the code have been printed (the output arrives in pieces).
 */
export function parseCodexDeviceAuth(output: string): CodexDeviceCode | null {
  const text = stripAnsi(output);
  const url = /https:\/\/auth\.openai\.com\/[^\s]*/.exec(text)?.[0] ?? /https:\/\/[^\s]*device[^\s]*/.exec(text)?.[0];
  const codeAt = text.search(/one-time code/i);
  if (url === undefined || codeAt === -1) return null;
  const after = text.slice(codeAt);
  const code = /\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/.exec(after)?.[1];
  if (code === undefined) return null;
  const mins = /expires in (\d+) minutes?/i.exec(after)?.[1];
  return { url, code, expiresInMinutes: mins === undefined ? null : Number(mins) };
}
