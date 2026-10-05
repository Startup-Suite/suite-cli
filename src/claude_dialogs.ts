/**
 * Answering Claude Code's pre-launch dialogs, so an agent comes back after a
 * restart or a reboot without anybody ssh-ing in to press Enter.
 *
 * `suite claude` launches with `--dangerously-load-development-channels`, and
 * Claude Code then shows a full-screen warning on EVERY launch. In a folder it
 * has not seen it first asks whether the folder is trusted, and on a machine
 * that has not accepted bypass-permissions mode it asks about that too. Until
 * someone answers, the process is alive and doing nothing: Suite sees an agent
 * that never replies.
 *
 * THREE RULES CARRY THIS MODULE.
 *
 *  1. ONLY A SCREEN WE KNOW, WORD FOR WORD. A dialog is recognised by its whole
 *     text, not by a keyword: the block between the last horizontal rule and
 *     the "Enter to confirm · Esc to cancel" footer, whitespace-collapsed (the
 *     pane re-wraps it to its width), must equal a template below exactly,
 *     with a placeholder only where the text names this launch (the folder,
 *     the channel, the MCP server) — and those placeholders are checked too.
 *     The footer must be the LAST line on the screen, so an agent that merely
 *     prints a dialog's text in its transcript is not a dialog. Anything else —
 *     a new dialog, a reworded one, half a redraw — gets no keys at all, and an
 *     unrecognised dialog is logged once so the operator can see why the agent
 *     is waiting.
 *  2. THE KEY DEPENDS ON WHERE THE CURSOR IS. Two of these dialogs default to
 *     "No, exit", so a blind Enter would quit Claude. Each step reads the
 *     cursor and sends one move or one confirm, then waits for the screen to
 *     change before deciding again. A stale capture never earns a second key.
 *  3. ONE SESSION, BY EXACT NAME. Every tmux call targets `=NAME:` — tmux's
 *     exact-match form. A bare `-t NAME` falls back to a PREFIX match, which
 *     would type into `NAME-2` (another agent) if NAME were gone.
 *
 * The screens were captured from Claude Code 2.1.288 on Linux, and are kept as
 * fixtures under test/fixtures/claude-code-2.1.288-dialogs/. When Claude Code
 * rewords one, it stops being answered (rule 1) and the fixture test says
 * which.
 */
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { TMUX, type TmuxDeps } from "./tmux.ts";
import { resolveTmux } from "./halt.ts";

/** The last line of every dialog this module answers. */
export const DIALOG_FOOTER = "Enter to confirm · Esc to cancel";

/** The channel `suite claude` loads. The dev-channels warning must name only it. */
export const SUITE_CHANNEL = "server:suite-channel";

/** What the cursor glyph looks like in Claude Code's select lists. */
const CURSOR = "❯";

export type DialogName =
  | "trust-folder"
  | "trust-folder-headers-helper"
  | "dev-channels"
  | "bypass-permissions"
  | "mcp-server"
  | "fullscreen-upsell";

export interface DialogContext {
  /** The folder the agent was launched in. The trust dialog must name it. */
  cwd?: string;
  /** `$HOME`, so a `~/…` rendering of the folder also matches. */
  home?: string;
  /**
   * The Claude config file (`~/.claude.json`, or under CLAUDE_CONFIG_DIR).
   * The headersHelper trust variant must name exactly this file as the place
   * the helper is declared.
   */
  claudeJson?: string;
  /**
   * True only when every headersHelper declared for this folder in
   * `claudeJson` is suite's own `startup-suite` entry running `mcp-headers`
   * (see {@link localHeadersHelpersAreSuites}). Absent or false: the
   * headersHelper trust variant is held, never answered.
   */
  headersHelpersAreSuites?: boolean;
}

interface DialogSpec {
  name: DialogName;
  /** The whole block, whitespace-collapsed, with `{x}` placeholders. */
  template: string;
  /** Every option label, in screen order. The cursor must sit on one of them. */
  options: string[];
  /** Placeholder values that must hold, or the dialog is not ours to answer. */
  check(fields: Record<string, string>, ctx: DialogContext): boolean;
  /** Keys for this cursor position, or null to send nothing. */
  keys(cursor: string): string[] | null;
}

const squash = (s: string): string => s.replace(/\s+/g, "");

/**
 * The folder in the trust dialog is the folder we launched in, or we do not
 * vouch for it. Compared with all whitespace removed, because a long path is
 * hard-wrapped across lines.
 */
function folderMatches(shown: string, ctx: DialogContext): boolean {
  if (ctx.cwd === undefined) return false;
  const want = [squash(ctx.cwd)];
  if (ctx.home && (ctx.cwd === ctx.home || ctx.cwd.startsWith(`${ctx.home}/`))) {
    want.push(squash(`~${ctx.cwd.slice(ctx.home.length)}`));
  }
  return want.includes(squash(shown));
}

/**
 * The known dialogs, exactly as Claude Code 2.1.288 draws them.
 *
 * Keys, and why each is the safe continue:
 *
 *  - trust-folder: the cursor starts on "No, exit". Down moves it to
 *    "Yes, I trust this folder"; Enter confirms only once it is there. The
 *    folder must be the one we launched in.
 *  - dev-channels: "1" selects "I am using this for local development"
 *    wherever the cursor is (verified: pressing 1 with the cursor on "2. Exit"
 *    continues). The channel list must be exactly suite's own channel — a
 *    second development channel is a decision for a human.
 *  - bypass-permissions: as trust-folder. `suite claude` already chose
 *    `--dangerously-skip-permissions` and says so once per machine; this
 *    accepts the consequence of that choice, it does not make it.
 *  - mcp-server: "Continue without using this MCP server", the default, and
 *    only when the cursor is on it. Approving an unknown project MCP server is
 *    a grant, so it is never sent; continuing without it grants nothing.
 *    (suite registers its own MCP entries in local scope, which does not raise
 *    this dialog, and with `--dangerously-skip-permissions` 2.1.288 did not
 *    show it at all — it is here so a project `.mcp.json` cannot park an
 *    agent.)
 */
export const DIALOGS: readonly DialogSpec[] = [
  {
    name: "trust-folder",
    template:
      "Accessing workspace: {folder} Quick safety check: Is this a project you created or one you trust? " +
      "(Like your own code, a well-known open source project, or work from your team). If not, take a moment " +
      "to review what's in this folder first. Claude Code'll be able to read, edit, and execute files here. " +
      `Security guide No, exit Yes, I trust this folder ${DIALOG_FOOTER}`,
    options: ["No, exit", "Yes, I trust this folder"],
    check: (f, ctx) => folderMatches(f.folder ?? "", ctx),
    keys: (cursor) => (cursor === "No, exit" ? ["Down"] : ["Enter"]),
  },
  {
    // Claude Code 2.1.289, when this folder's local-scope MCP entries carry a
    // headersHelper — which ref mode's `startup-suite` entry always does. The
    // dialog does not print the command, so the check reads it: the declaring
    // file must be THE Claude config, and every helper declared there for this
    // folder must be suite's own `mcp-headers` (ctx.headersHelpersAreSuites).
    // A helper anyone else added makes this a decision for a person.
    name: "trust-folder-headers-helper",
    template:
      "Accessing workspace: {folder} Quick safety check: Is this a project you created or one you trust? " +
      "(Like your own code, a well-known open source project, or work from your team). If not, take a moment " +
      "to review what's in this folder first. Claude Code'll be able to read, edit, and execute files here. " +
      "⚠ This folder runs commands to mint HTTP headers (headersHelper), declared in {source} " +
      "These will apply without asking. Only proceed if you trust this configuration. " +
      `Security guide No, exit Yes, I trust this folder ${DIALOG_FOOTER}`,
    options: ["No, exit", "Yes, I trust this folder"],
    check: (f, ctx) =>
      folderMatches(f.folder ?? "", ctx) &&
      ctx.claudeJson !== undefined &&
      squash(f.source ?? "") === squash(`${ctx.claudeJson} (local-scope MCP servers for this project)`) &&
      ctx.headersHelpersAreSuites === true,
    keys: (cursor) => (cursor === "No, exit" ? ["Down"] : ["Enter"]),
  },
  {
    name: "dev-channels",
    template:
      "WARNING: Loading development channels --dangerously-load-development-channels is for local channel " +
      "development only. Do not use this option to run channels you have downloaded off the internet. " +
      "Please use --channels to run a list of approved channels. Channels: {channels} " +
      `1. I am using this for local development 2. Exit ${DIALOG_FOOTER}`,
    options: ["1. I am using this for local development", "2. Exit"],
    check: (f) => f.channels === SUITE_CHANNEL,
    keys: () => ["1"],
  },
  {
    name: "bypass-permissions",
    template:
      "WARNING: Claude Code running in Bypass Permissions mode In Bypass Permissions mode, Claude Code will " +
      "not ask for your approval before running potentially dangerous commands. This mode should only be used " +
      "in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged. " +
      "By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode. " +
      `https://code.claude.com/docs/en/security No, exit Yes, I accept ${DIALOG_FOOTER}`,
    options: ["No, exit", "Yes, I accept"],
    check: () => true,
    keys: (cursor) => (cursor === "No, exit" ? ["Down"] : ["Enter"]),
  },
  {
    name: "mcp-server",
    template:
      "New MCP server found in this project: {server} MCP servers may execute code or access system resources. " +
      "All tool calls require approval. Learn more in the MCP documentation. Use this MCP server " +
      `Use this and all future MCP servers in this project Continue without using this MCP server ${DIALOG_FOOTER}`,
    options: ["Use this MCP server", "Use this and all future MCP servers in this project", "Continue without using this MCP server"],
    check: (f) => /^\S+$/.test(f.server ?? ""),
    keys: (cursor) => (cursor === "Continue without using this MCP server" ? ["Enter"] : null),
  },
  {
    // Claude Code 2.1.289's renderer upsell. It replaces the input box, so an
    // agent showing it is parked. The answer is "Not now": it changes nothing
    // (Claude then records the upsell as seen and stops asking). The cursor
    // starts on "Yes, try it", so Down first, then Enter only on "Not now".
    name: "fullscreen-upsell",
    template:
      "Try the new fullscreen renderer? · Flicker-free output · Mouse support — click to move your cursor or " +
      `expand results · Selected text auto-copies to your clipboard 1. Yes, try it 2. Not now ${DIALOG_FOOTER}`,
    options: ["1. Yes, try it", "2. Not now"],
    check: () => true,
    keys: (cursor) => (cursor === "2. Not now" ? ["Enter"] : ["Down"]),
  },
];

/* ------------------------------------------------------------------------- */
/* Sign-in and first-run screens: recognised, NEVER answered                  */
/* ------------------------------------------------------------------------- */

/**
 * Screens that mean Claude Code wants a person, not a key.
 *
 * SIGN-IN IS NEVER ANSWERED, BY DESIGN. Anthropic's terms do not let a third
 * party collect, relay or intermediate Claude.ai credentials, so suite never
 * picks a login method, never types or forwards a code, and never drives a
 * browser for one. When Claude asks for a sign-in the only right outcome is a
 * human step: the person signs in with Claude Code's own `claude auth login`.
 *
 * The first-run onboarding screens (theme, security notes) are suppressed
 * BEFORE launch by seeding `hasCompletedOnboarding` (claude_onboarding.ts).
 * If one is on screen anyway, the seed did not take, and blindly pressing
 * Enter through Claude's onboarding is exactly what rule 1 forbids — so it is
 * named in the log and left alone.
 */
export type PersonScreen = "login-method" | "not-logged-in" | "onboarding-theme" | "onboarding-security-notes";

/** Measured on Claude Code 2.1.289 (fixtures under claude-code-2.1.289-dialogs). */
export function personScreen(lines: string[]): PersonScreen | null {
  const trimmed = lines.map((l) => l.trim());
  if (trimmed.includes("Select login method:") && trimmed.some((l) => l.includes("Claude account with subscription"))) {
    return "login-method";
  }
  if (trimmed.includes("Choose the text style that looks best with your terminal")) return "onboarding-theme";
  if (trimmed.includes("Security notes:") && trimmed.some((l) => l.startsWith("Press Enter to continue"))) {
    return "onboarding-security-notes";
  }
  return null;
}

/** The status line of a 2.1.289 input box whose Claude has no credentials. */
export const NOT_LOGGED_IN_MARK = "Not logged in · Run /login";

/* ------------------------------------------------------------------------- */
/* Whose headersHelper is it                                                  */
/* ------------------------------------------------------------------------- */

/** The shape of suite's own ref-mode helper: `'<self…>' 'mcp-headers' '--token-ref' '<ref>' ['--keychain-service' '<svc>']`. */
const SUITE_HELPER = /^(?:'[^']*' )+'mcp-headers' '--token-ref' '(?:keychain|file):[^']+'(?: '--keychain-service' '[^']*')?$/;

/**
 * True when this folder's local-scope MCP entries in the Claude config declare
 * at least one headersHelper and EVERY one is suite's `startup-suite` entry
 * running `mcp-headers`. Anything unreadable, or any other helper, is false.
 */
export function localHeadersHelpersAreSuites(claudeJsonText: string | null, cwds: string[]): boolean {
  if (claudeJsonText === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(claudeJsonText);
  } catch {
    return false;
  }
  const projects = (parsed as { projects?: Record<string, { mcpServers?: Record<string, { headersHelper?: unknown }> }> })?.projects;
  if (projects === undefined || projects === null || typeof projects !== "object") return false;
  let seen = 0;
  for (const cwd of new Set(cwds)) {
    const servers = projects[cwd]?.mcpServers;
    if (servers === undefined || servers === null || typeof servers !== "object") continue;
    for (const [name, entry] of Object.entries(servers)) {
      if (entry === null || typeof entry !== "object" || entry.headersHelper === undefined) continue;
      if (name !== "startup-suite" || typeof entry.headersHelper !== "string" || !SUITE_HELPER.test(entry.headersHelper)) {
        return false;
      }
      seen++;
    }
  }
  return seen > 0;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Template → anchored regex with one named lazy group per `{placeholder}`. */
function templateRegex(template: string): RegExp {
  const parts = template.split(/(\{[a-z]+\})/);
  const body = parts
    .map((p) => {
      const m = /^\{([a-z]+)\}$/.exec(p);
      return m ? `(?<${m[1]}>.+?)` : escapeRe(p);
    })
    .join("");
  return new RegExp(`^${body}$`);
}

const COMPILED = DIALOGS.map((d) => ({ spec: d, re: templateRegex(d.template) }));

const RULE = /^─{10,}$/;

export type DialogStep =
  | { kind: "answer"; dialog: DialogName; keys: string[] }
  /** A known dialog in a state we will not act on (cursor elsewhere, or a placeholder that did not check out). */
  | { kind: "hold"; dialog: DialogName; reason: string }
  /** Something with the dialog footer that is not one of ours. */
  | { kind: "unknown"; title: string }
  /** Claude wants a person: a sign-in, or an onboarding screen the seed should have removed. Never answered. */
  | { kind: "person"; screen: PersonScreen }
  /** Claude's input box is up: there is nothing left to answer. */
  | { kind: "ready" }
  /** No dialog, no input box — still drawing, or something else entirely. */
  | { kind: "none" };

/**
 * The input box: a line starting with the cursor at column 0, between two
 * horizontal rules. Dialogs indent their cursor, so none of them looks like
 * this. If a future Claude Code draws it differently, the only cost is that
 * the poll runs to its deadline instead of stopping early.
 */
export function isReady(lines: string[]): boolean {
  for (let i = 1; i < lines.length - 1; i++) {
    if (lines[i]!.startsWith(`${CURSOR}`) && RULE.test(lines[i - 1]!.trim()) && RULE.test(lines[i + 1]!.trim())) {
      return true;
    }
  }
  return false;
}

/**
 * (captured pane) → what to do about it. Pure: every decision this module
 * makes is asserted against the recorded screens without a terminal.
 */
export function classifyPane(pane: string, ctx: DialogContext = {}): DialogStep {
  const lines = pane.split("\n").map((l) => l.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return { kind: "none" };

  const person = personScreen(lines);
  if (person !== null) return { kind: "person", screen: person };

  const last = lines[lines.length - 1]!.trim();
  if (last !== DIALOG_FOOTER) {
    if (!isReady(lines)) return { kind: "none" };
    // The input box is up, but Claude has no credentials: a person signs in.
    return lines.some((l) => l.includes(NOT_LOGGED_IN_MARK)) ? { kind: "person", screen: "not-logged-in" } : { kind: "ready" };
  }

  let top = -1;
  for (let i = lines.length - 2; i >= 0; i--) {
    if (RULE.test(lines[i]!.trim())) {
      top = i;
      break;
    }
  }
  const block = lines.slice(top + 1).filter((l) => l.trim() !== "");
  const title = (block[0] ?? "").trim();
  if (top === -1) return { kind: "unknown", title };

  const cursorLines = block.filter((l) => l.trim().startsWith(`${CURSOR} `));
  const cursor = cursorLines.length === 1 ? cursorLines[0]!.trim().slice(CURSOR.length).trim() : null;
  const text = block
    .map((l) => l.replace(CURSOR, " "))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  for (const { spec, re } of COMPILED) {
    const m = re.exec(text);
    if (m === null) continue;
    if (cursor === null || !spec.options.includes(cursor)) {
      return { kind: "hold", dialog: spec.name, reason: "no cursor on a known option" };
    }
    if (!spec.check({ ...m.groups }, ctx)) {
      return { kind: "hold", dialog: spec.name, reason: "names something other than this launch" };
    }
    const keys = spec.keys(cursor);
    if (keys === null) return { kind: "hold", dialog: spec.name, reason: `cursor is on "${cursor}"` };
    return { kind: "answer", dialog: spec.name, keys };
  }
  return { kind: "unknown", title };
}

/* ------------------------------------------------------------------------- */
/* Driving a real pane                                                        */
/* ------------------------------------------------------------------------- */

/**
 * How long to keep looking after a launch. Milliseconds.
 *
 * MEASURED on hive (Linux, load ~1.5, Claude Code 2.1.288): from
 * `tmux new-session` to Claude's input box took 2.7 s and 3.1 s for a fresh
 * folder with `--continue` — trust prompt, dev-channels warning, the
 * "No conversation found" exit, the fallback relaunch, and the dev-channels
 * warning a SECOND time. The first dialog was on screen 0.3–0.5 s in.
 *
 * 60 s is ~20× that. The slow case is a boot, when `suite restore` starts
 * every agent at once on a cold cache, each loading its MCP servers. Erring
 * long costs nothing: the poll stops as soon as the input box is up, and it
 * only ever answers exact matches. Erring short is the failure this exists to
 * remove — an agent parked at a dialog until someone ssh-es in.
 */
export const DIALOG_WINDOW_MS = 60_000;

/** Between captures. Each one is a `tmux capture-pane`; cheap. */
export const DIALOG_POLL_MS = 400;

/**
 * After sending keys, how long to wait for the screen to change before the
 * same screen may be answered again. Measured: a capture 400 ms after a Down
 * could still show the old cursor, and acting on it sent a second Down.
 */
export const DIALOG_RESEND_MS = 3_000;

export interface DialogIo {
  tmux: TmuxDeps;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** One line about this session: written to its session log. */
  log(session: string, line: string): void;
  /**
   * Reads the Claude config, to check whose headersHelper a trust dialog is
   * about. Absent (most tests): that dialog is held, never answered.
   */
  readFile?(path: string): string | null;
  /** The canonical path of a folder, as Claude records it. Absent: the path as given. */
  realpath?(path: string): string;
}

/**
 * After the input box first appears, how many more captures in a row must
 * show it before the poll stops. A count, not a duration, so a frozen test
 * clock cannot spin it. 15 × 400 ms ≈ 6 s: long enough for a dialog that
 * Claude draws once it goes idle (2.1.289's renderer upsell replaces the input
 * box). One that comes later still is the watchdog's `answerOnce`.
 */
export const READY_SETTLE_POLLS = 15;

export interface AnswerOptions {
  session: string;
  cwd: string;
  home?: string;
  /** The Claude config path. Default `<home>/.claude.json`. */
  claudeJson?: string;
  windowMs?: number;
  pollMs?: number;
  settlePolls?: number;
}

export interface Answer {
  dialog: DialogName;
  keys: string[];
}

export interface AnswerResult {
  /**
   * `login_required`: Claude asked for a sign-in (the login-method screen, or
   * an input box marked "Not logged in"). Nothing was typed; a person signs in.
   */
  outcome: "ready" | "timeout" | "gone" | "login_required";
  answered: Answer[];
  /** The last screen that was held or not recognised, for a caller's error text. */
  waitingOn?: string;
}

/** What a person runs when Claude needs a sign-in. Claude Code's own verb; suite never handles the credential. */
export const CLAUDE_SIGN_IN_COMMAND = "claude auth login --claudeai";

/** The DialogContext for one session: folder, home, and whose headersHelper the config declares. */
export function dialogContext(io: Pick<DialogIo, "readFile" | "realpath">, opts: Pick<AnswerOptions, "cwd" | "home" | "claudeJson">): DialogContext {
  const claudeJson = opts.claudeJson ?? (opts.home !== undefined && opts.home !== "" ? `${opts.home}/.claude.json` : undefined);
  const ctx: DialogContext = { cwd: opts.cwd, home: opts.home };
  if (claudeJson !== undefined) ctx.claudeJson = claudeJson;
  if (claudeJson !== undefined && io.readFile !== undefined) {
    let real = opts.cwd;
    try {
      real = io.realpath?.(opts.cwd) ?? opts.cwd;
    } catch {
      /* the folder as given */
    }
    ctx.headersHelpersAreSuites = localHeadersHelpersAreSuites(io.readFile(claudeJson), [opts.cwd, real]);
  }
  return ctx;
}

/** tmux's exact-match target for a session's active pane. See rule 3. */
export function exactTarget(session: string): string {
  return `=${session}:`;
}

export function dialogCaptureArgv(session: string, tmux: string = TMUX): string[] {
  return [tmux, "capture-pane", "-p", "-t", exactTarget(session)];
}

/** Key NAMES, deliberately without `-l`: "Down" and "Enter" are keys, not words. */
export function dialogKeysArgv(session: string, keys: string[], tmux: string = TMUX): string[] {
  return [tmux, "send-keys", "-t", exactTarget(session), ...keys];
}

/**
 * Watch one freshly launched session and answer the dialogs we know, until
 * Claude's input box is up, the session is gone, or the window closes.
 *
 * Never throws for a tmux failure: a capture that fails means the session is
 * gone, which is an outcome, not an error.
 */
export async function answerLaunchDialogs(io: DialogIo, opts: AnswerOptions): Promise<AnswerResult> {
  const tmux = resolveTmux(io.tmux.which);
  const windowMs = opts.windowMs ?? DIALOG_WINDOW_MS;
  const pollMs = opts.pollMs ?? DIALOG_POLL_MS;
  const settlePolls = opts.settlePolls ?? READY_SETTLE_POLLS;
  const ctx = dialogContext(io, opts);
  const deadline = io.now() + windowMs;
  const answered: Answer[] = [];
  let lastSent: { pane: string; at: number } | null = null;
  const reported = new Set<string>();
  let waitingOn: string | undefined;
  let readyStreak = 0;
  let notLoggedInStreak = 0;

  for (;;) {
    const cap = await io.tmux.run(dialogCaptureArgv(opts.session, tmux));
    if (cap.exitCode !== 0) {
      io.log(opts.session, `launch dialogs: session ended (${answered.length} answered)`);
      return { outcome: "gone", answered };
    }
    // Any change since our last send means the send landed (or something else
    // happened); either way the next identical screen is a NEW screen. This is
    // what lets the dev-channels warning be answered a second time after the
    // --continue fallback relaunches Claude.
    if (lastSent !== null && cap.stdout !== lastSent.pane) lastSent = null;
    const step = classifyPane(cap.stdout, ctx);
    // An input box marked "Not logged in" is held to the same settle as a
    // ready one: an early frame drawn before Claude has read its credentials
    // must not be reported as a missing sign-in.
    if (step.kind === "person" && step.screen === "not-logged-in" && notLoggedInStreak++ < settlePolls) {
      readyStreak = 0;
    } else if (step.kind === "person") {
      const what =
        step.screen === "login-method" || step.screen === "not-logged-in"
          ? `Claude Code needs a sign-in (${step.screen}); suite never enters or relays a Claude credential — ` +
            `a person signs in with \`${CLAUDE_SIGN_IN_COMMAND}\``
          : `Claude Code's first-run screen ${step.screen} (onboarding was not seeded); not answering it`;
      io.log(opts.session, `launch dialogs: ${what} (${answered.length} answered)`);
      if (step.screen === "login-method" || step.screen === "not-logged-in") {
        return { outcome: "login_required", answered, waitingOn: step.screen };
      }
      return { outcome: "timeout", answered, waitingOn: step.screen };
    }
    if (step.kind === "ready") {
      readyStreak++;
      if (readyStreak > settlePolls) return { outcome: "ready", answered };
    } else {
      readyStreak = 0;
    }
    if (!(step.kind === "person" && step.screen === "not-logged-in")) notLoggedInStreak = 0;

    if (step.kind === "answer") {
      const fresh = lastSent === null || io.now() - lastSent.at >= DIALOG_RESEND_MS;
      if (fresh) {
        await io.tmux.run(dialogKeysArgv(opts.session, step.keys, tmux));
        answered.push({ dialog: step.dialog, keys: step.keys });
        io.log(opts.session, `launch dialogs: answered ${step.dialog} with ${step.keys.join(" ")}`);
        lastSent = { pane: cap.stdout, at: io.now() };
      }
    } else if (step.kind === "unknown" || step.kind === "hold") {
      const what = step.kind === "unknown" ? `unrecognised dialog "${step.title}"` : `${step.dialog}: ${step.reason}`;
      waitingOn = what;
      if (!reported.has(what)) {
        reported.add(what);
        io.log(opts.session, `launch dialogs: NOT answering ${what}`);
      }
    }

    if (io.now() >= deadline) {
      // The input box was up when the window closed: that is ready, unsettled.
      if (readyStreak > 0) return { outcome: "ready", answered };
      if (notLoggedInStreak > 0) {
        io.log(opts.session, `launch dialogs: Claude Code needs a sign-in (not-logged-in); suite never enters or relays a Claude credential — a person signs in with \`${CLAUDE_SIGN_IN_COMMAND}\` (${answered.length} answered)`);
        return { outcome: "login_required", answered, waitingOn: "not-logged-in" };
      }
      io.log(
        opts.session,
        `launch dialogs: gave up after ${Math.round(windowMs / 1000)}s without seeing Claude's input box ` +
          `(${answered.length} answered); the pane is left as it is`,
      );
      return waitingOn === undefined ? { outcome: "timeout", answered } : { outcome: "timeout", answered, waitingOn };
    }
    await io.sleep(pollMs);
  }
}

/**
 * One look, one answer at most. For the watchdog's sweep, which comes round
 * again a minute later anyway — so it never needs to wait for a redraw.
 */
export async function answerOnce(io: DialogIo, opts: AnswerOptions): Promise<Answer | null> {
  const tmux = resolveTmux(io.tmux.which);
  const cap = await io.tmux.run(dialogCaptureArgv(opts.session, tmux));
  if (cap.exitCode !== 0) return null;
  const step = classifyPane(cap.stdout, dialogContext(io, opts));
  if (step.kind !== "answer") return null;
  await io.tmux.run(dialogKeysArgv(opts.session, step.keys, tmux));
  io.log(opts.session, `launch dialogs: answered ${step.dialog} with ${step.keys.join(" ")} (watchdog)`);
  return { dialog: step.dialog, keys: step.keys };
}

/* ------------------------------------------------------------------------- */
/* The session log                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Per-session log, next to the restore roster. Every key this module sends is
 * written here, so "why did my agent trust that folder" has an answer on disk.
 */
export function sessionLogPath(home: string, session: string): string {
  return `${home}/.local/state/suite/sessions/${session}.log`;
}

/**
 * Append a timestamped line to the session log, and mirror it to `echo`
 * (stderr for the CLI). A log that cannot be written must not stop an agent,
 * so a write failure is reported through `echo` and swallowed.
 */
export function sessionLogger(
  home: string,
  echo: (line: string) => void,
  now: () => Date = () => new Date(),
): (session: string, line: string) => void {
  return (session, line) => {
    echo(`${session}: ${line}`);
    const path = sessionLogPath(home, session);
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${now().toISOString()} ${line}\n`);
    } catch (error) {
      echo(`${session}: could not write ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/** Live wiring for the poll. */
export function liveDialogIo(tmux: TmuxDeps, home: string, echo: (line: string) => void): DialogIo {
  return {
    tmux,
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    realpath: (path) => realpathSync(path),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: sessionLogger(home, echo),
  };
}
