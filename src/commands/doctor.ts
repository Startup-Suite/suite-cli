/**
 * `suite doctor` — diagnose the failures that actually happen.
 *
 * Every check in this file exists because its failure produces a CONFUSING
 * SYMPTOM rather than an error naming its cause: a channel that connects and
 * delivers nothing, a plugin path that resolves on the machine it was written
 * on and nowhere else, a tmux session whose shell is alive and whose agent is
 * not. A tool that only reports what already reports itself would be redundant.
 *
 * THE REPORT IS THE PRODUCT (design canvas 019ffe19 revision 1, binding). Four
 * rules, each enforced here rather than left to the caller's discipline:
 *
 *  (a) FAILURES KEEP THEIR POSITION. {@link runChecks} emits checks in
 *      dependency order and {@link renderReport} never sorts. Reading top-down
 *      tells you what to fix first, which is the only ordering that is also
 *      advice.
 *  (b) EVERY `✘` OWES TWO THINGS — faint consequence lines, and exactly one
 *      `→` line that is a runnable command. This is enforced by the TYPE:
 *      {@link Failure} cannot be constructed without both, so a future check
 *      that forgets does not compile.
 *  (c) A CHECK THAT COULD NOT RUN IS `⋯ skipped — <reason>`, neither green nor
 *      red. One broken thing upstream must not paint the whole report red;
 *      that is as uninformative as a doctor that is always green.
 *  (d) THE CLOSING LINE IS A COUNT AND AN INSTRUCTION. See {@link summaryLine}.
 *
 * COLOUR is from the terminal's semantic slots, never brand hex, never the sole
 * carrier of meaning: every coloured line leads with a glyph saying the same
 * thing, which is also what makes the output survive a pipe. `NO_COLOR` is
 * honoured and zero SGR bytes are emitted off a TTY.
 *
 * THE `suite init --repair` DECISION. The canvas's failure wireframe points an
 * unresolvable plugin path at `→ suite init --repair`. That flag is scoped
 * nowhere, and rule (b) says a `→` must be runnable, so it is NOT shipped:
 * the remedy is `suite init`, which already re-clones or updates the checkout
 * and rewrites BOTH MCP entries with freshly resolved absolute paths — i.e. it
 * IS the repair. A non-interactive `--repair` that skips the credential
 * prompts is a real convenience and is deliberately deferred rather than
 * invented here; what must not ship is a remedy line naming a flag the CLI
 * does not have.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { emptyConfig, readConfig, type SuiteConfig } from "../config.ts";
import { configPath } from "../paths.ts";
import {
  CHANNEL_SERVER,
  TOOLS_SERVER,
  parseServerStatus,
  whichBin,
  type ServerStatus,
} from "./init.ts";
import {
  LABEL_WIDTH,
  SGR,
  colorEnabled,
  glyphFor,
  paint,
  utf8Enabled,
  type CheckStatus,
} from "../ui.ts";
import {
  TMUX,
  detectState,
  liveTmuxDeps,
  sessionNameFromConfig,
  type RunResult,
  type SessionState,
  type TmuxDeps,
} from "../tmux.ts";

/* ------------------------------------------------------------------------- */
/* The shape of a check result                                                */
/* ------------------------------------------------------------------------- */

interface Base {
  /** Stable identifier, for tests and for `suite status` to reuse. */
  id: string;
  /** Left column. */
  label: string;
}

export interface Pass extends Base {
  status: "pass";
  value: string;
  /** Faint trailing column: a path, a version, a bound. */
  detail?: string;
}

export interface Failure extends Base {
  status: "fail";
  value: string;
  /**
   * One or two faint lines naming the CONSEQUENCE — what goes wrong for the
   * user — not the error text. Required by rule (b), and required by the type
   * so it cannot be forgotten.
   */
  consequence: string[];
  /** Exactly one runnable command. Rule (b). A failure is never a dead end. */
  remedy: string;
  detail?: string;
}

export interface Skipped extends Base {
  status: "skip";
  /** Why it could not run — an upstream check, named. Rule (c). */
  reason: string;
}

export type CheckResult = Pass | Failure | Skipped;

export const CHECK_IDS = [
  "claude",
  "auth",
  "bun",
  "tmux",
  "plugin",
  "credentials",
  "channel",
  "session",
] as const;

export type CheckId = (typeof CHECK_IDS)[number];

/* ------------------------------------------------------------------------- */
/* Pure parsing — every one of these is asserted directly                     */
/* ------------------------------------------------------------------------- */

/** The floor the plugin README states. Bumping it is a one-line change here. */
export const CLAUDE_VERSION_FLOOR = "2.1.80";

/**
 * The leading semver of `claude --version`.
 *
 * This box prints `2.1.228 (Claude Code)`; the suffix is Anthropic's to change,
 * so only the leading version is read and anything after it is ignored. Null
 * when there is no version in the output at all, which is a louder condition
 * than an old version and is reported as such.
 */
export function parseClaudeVersion(output: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output.trim());
  return m?.[0] ?? null;
}

/** Numeric semver comparison. Missing components read as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function meetsFloor(version: string, floor: string = CLAUDE_VERSION_FLOOR): boolean {
  return compareVersions(version, floor) >= 0;
}

export interface AuthStatus {
  loggedIn: boolean;
  authMethod: string;
  apiProvider: string;
}

/**
 * Read `claude auth status --json`.
 *
 * ONLY the three fields that decide the verdict are lifted out. The real
 * payload also carries an email, an org id and an org name; this function
 * drops them on the floor deliberately, so no caller can print one and no
 * fixture in this public repository needs to contain one.
 */
export function parseAuthStatus(output: string): AuthStatus | null {
  try {
    const raw = JSON.parse(output) as Record<string, unknown>;
    if (typeof raw.loggedIn !== "boolean") return null;
    return {
      loggedIn: raw.loggedIn,
      authMethod: typeof raw.authMethod === "string" ? raw.authMethod : "",
      apiProvider: typeof raw.apiProvider === "string" ? raw.apiProvider : "",
    };
  } catch {
    return null;
  }
}

/** The auth mode Suite channels require. Anything else is a failure. */
export const SUPPORTED_AUTH_METHOD = "claude.ai";

export function authSupported(status: AuthStatus): boolean {
  if (!status.loggedIn) return false;
  if (status.apiProvider !== "" && status.apiProvider !== "firstParty") return false;
  return status.authMethod === SUPPORTED_AUTH_METHOD;
}

/**
 * Environment variables that override the stored login AT LAUNCH.
 *
 * Checked SEPARATELY from the stored credential because they win regardless of
 * it: a box with a perfectly good claude.ai login and `ANTHROPIC_API_KEY`
 * exported in a shell profile runs every agent on the API key, and the channel
 * that results connects and then delivers nothing. `claude auth status` cannot
 * see that; only the environment can.
 */
export const OVERRIDE_ENV_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

export function apiKeyOverride(env: Record<string, string | undefined>): string | null {
  for (const name of OVERRIDE_ENV_VARS) {
    const v = env[name];
    if (v !== undefined && v !== "") return name;
  }
  return null;
}

/**
 * The absolute path recorded in an MCP entry, out of `claude mcp get <name>`.
 *
 * Read tolerantly — the exact labels are Claude Code's to change — but never
 * guessed: the first absolute path on a Command/Args line wins, and null means
 * we could not read one, which the caller renders as a failure rather than as
 * a pass. Environment lines are skipped so a `SUITE_URL=file:///…` can never be
 * mistaken for the entrypoint.
 */
export function parseMcpEntryPath(output: string): string | null {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!/^(command|args?)\s*:/i.test(trimmed)) continue;
    const m = /(\/[^\s"']+)/.exec(trimmed);
    if (m?.[1] !== undefined) return m[1];
  }
  return null;
}

/**
 * Does the entry carry a non-empty token?
 *
 * PRESENCE ONLY. The value is never returned, never rendered and never logged;
 * the boolean is the entire answer the user needs, and a function that cannot
 * return the secret cannot leak it through a careless caller.
 */
export function mcpEntryHasToken(output: string): boolean {
  for (const line of output.split("\n")) {
    const m = /SUITE_TOKEN\s*[=:]\s*(.*)$/.exec(line.trim());
    if (m === null) continue;
    const value = (m[1] ?? "").trim().replace(/^["']|["']$/g, "");
    if (value !== "" && value !== "${}") return true;
  }
  return false;
}

export function pathResolves(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* ------------------------------------------------------------------------- */

export const VALUE_WIDTH = 19;

export interface RenderOptions {
  color: boolean;
  utf8: boolean;
}

const STATUS_COLOR: Record<CheckStatus, string> = {
  pass: SGR.green,
  fail: SGR.red,
  skip: SGR.yellow,
};

/** One check as the lines it prints. A failure block ends with a blank line. */
export function renderCheck(check: CheckResult, options: RenderOptions): string[] {
  const glyph = paint(glyphFor(check.status, options.utf8), STATUS_COLOR[check.status], options.color);
  const label = check.label.padEnd(LABEL_WIDTH, " ");

  // The arrow and the dash degrade for the same reason the glyphs do: outside
  // a UTF-8 locale they render as mojibake of unpredictable width.
  const dash = options.utf8 ? "—" : "--";
  const arrow = options.utf8 ? "→" : "->";

  if (check.status === "skip") {
    return [`  ${glyph}  ${label}${paint(`skipped ${dash} ${check.reason}`, SGR.faint, options.color)}`.trimEnd()];
  }

  const detail = check.detail ?? "";
  const pad = check.value.length >= VALUE_WIDTH ? `${check.value}  ` : check.value.padEnd(VALUE_WIDTH, " ");
  const value = detail === "" ? check.value : pad;
  const head = `  ${glyph}  ${label}${value}${paint(detail, SGR.faint, options.color)}`.trimEnd();
  if (check.status === "pass") return [head];

  const lines = [head];
  for (const line of check.consequence) lines.push(`     ${paint(line, SGR.faint, options.color)}`);
  lines.push(`     ${paint(`${arrow} ${check.remedy}`, SGR.faint, options.color)}`);
  lines.push("");
  return lines;
}

/**
 * The closing line: a COUNT and an INSTRUCTION, never a paragraph (rule (d)).
 * The instruction points at the FIRST failure because the list is in dependency
 * order — fixing anything else first may not stick.
 */
export function summaryLine(checks: CheckResult[], options: RenderOptions): string {
  const failed = checks.filter((c) => c.status === "fail").length;
  const bold = (s: string) => paint(s, SGR.bold, options.color);
  if (failed === 0) return `  ${bold(`${checks.length} checks passed.`)}`;
  return `  ${bold(`${failed} of ${checks.length} failed.`)}  Fix the first one, run suite doctor again.`;
}

export function renderReport(checks: CheckResult[], options: RenderOptions): string[] {
  // No sort. Rule (a): the order they were produced in IS the dependency order.
  const lines: string[] = [""];
  for (const check of checks) lines.push(...renderCheck(check, options));
  if (lines[lines.length - 1] !== "") lines.push("");
  lines.push(summaryLine(checks, options));
  return lines;
}

export function exitCodeFor(checks: CheckResult[]): number {
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}

/* ------------------------------------------------------------------------- */
/* Dependencies                                                               */
/* ------------------------------------------------------------------------- */

export interface DoctorDeps {
  env: Record<string, string | undefined>;
  cwd: string;
  /** Run a child process and collect its output. */
  run(argv: string[]): Promise<RunResult>;
  which(name: string): string | null;
  /** Does this absolute path exist? Injected so a test needs no real checkout. */
  exists(path: string): boolean;
  config: SuiteConfig | null;
  configFile: string;
  tmux: TmuxDeps;
  color: boolean;
  utf8: boolean;
  out(line: string): void;
}

/* ------------------------------------------------------------------------- */
/* The checks, in dependency order                                            */
/* ------------------------------------------------------------------------- */

const CLAUDE = "claude";

export async function runChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  // 1. Claude Code itself, and its version floor ------------------------
  const claudePath = deps.which(CLAUDE);
  if (claudePath === null) {
    checks.push({
      id: "claude",
      label: "claude code",
      status: "fail",
      value: "not on PATH",
      consequence: [
        "Nothing else in this tool can run: the channel, the MCP entries and",
        "every session are all things Claude Code owns.",
      ],
      remedy: "https://claude.com/product/claude-code",
    });
  } else {
    const r = await deps.run([claudePath, "--version"]);
    const version = parseClaudeVersion(`${r.stdout}\n${r.stderr}`);
    if (version === null) {
      checks.push({
        id: "claude",
        label: "claude code",
        status: "fail",
        value: "version unreadable",
        detail: `${r.stdout}${r.stderr}`.trim().split("\n")[0] ?? "",
        consequence: [
          "We cannot tell whether this build is new enough for the channel, so a",
          "version-related failure would surface later as a silent one.",
        ],
        remedy: "claude update",
      });
    } else if (!meetsFloor(version)) {
      checks.push({
        id: "claude",
        label: "claude code",
        status: "fail",
        value: version,
        detail: `needs ≥ ${CLAUDE_VERSION_FLOOR}`,
        consequence: [
          "The suite-channel plugin needs a newer Claude Code; on this build the",
          "channel loads and then never receives a message.",
        ],
        remedy: "claude update",
      });
    } else {
      checks.push({
        id: "claude",
        label: "claude code",
        status: "pass",
        value: version,
        detail: `≥ ${CLAUDE_VERSION_FLOOR}`,
      });
    }
  }

  // 2. Auth mode — the highest-value check in the tool -------------------
  checks.push(await authCheck(deps, claudePath));

  // 3. bun ---------------------------------------------------------------
  const bunPath = deps.which("bun");
  checks.push(
    bunPath === null
      ? {
          id: "bun",
          label: "bun",
          status: "fail",
          value: "not on PATH",
          consequence: [
            "The channel plugin is run by bun, so the suite-channel MCP entry",
            "fails to start and Suite sees this runtime as offline.",
          ],
          remedy: "curl -fsSL https://bun.sh/install | bash",
        }
      : {
          id: "bun",
          label: "bun",
          status: "pass",
          value: (await version(deps, bunPath, ["--version"])) ?? "present",
          detail: bunPath,
        },
  );

  // 4. tmux --------------------------------------------------------------
  const tmuxPath = deps.which(TMUX);
  checks.push(
    tmuxPath === null
      ? {
          id: "tmux",
          label: "tmux",
          status: "fail",
          value: "not on PATH",
          consequence: [
            "Agents die with the terminal that started them, mid-task, and Suite",
            "keeps waiting on a runtime that no longer exists.",
          ],
          remedy: "brew install tmux",
        }
      : {
          id: "tmux",
          label: "tmux",
          status: "pass",
          value: (await version(deps, tmuxPath, ["-V"])) ?? "present",
          detail: tmuxPath,
        },
  );

  // 5. The plugin checkout, AND the path the MCP entry actually records ---
  const entry = claudePath === null ? null : await deps.run([claudePath, "mcp", "get", CHANNEL_SERVER]);
  checks.push(pluginCheck(deps, claudePath, entry));

  // 6-7. Credentials and the channel's health ----------------------------
  const pluginOk = checks[checks.length - 1]?.status === "pass";
  checks.push(credentialsCheck(deps, claudePath, entry, pluginOk));
  checks.push(await channelCheck(deps, claudePath, pluginOk));

  // 8. Session health, via stage 4's three-way detection ------------------
  checks.push(await sessionCheck(deps, tmuxPath));

  return checks;
}

/** First version-looking token of a `--version` style probe. */
async function version(deps: DoctorDeps, path: string, args: string[]): Promise<string | null> {
  const r = await deps.run([path, ...args]);
  const first = `${r.stdout}${r.stderr}`.trim().split("\n")[0] ?? "";
  return /\d+\.\d+[\w.-]*/.exec(first)?.[0] ?? (first === "" ? null : first);
}

async function authCheck(deps: DoctorDeps, claudePath: string | null): Promise<CheckResult> {
  const override = apiKeyOverride(deps.env);
  if (override !== null) {
    // Reported even when the stored login is fine: the variable WINS at launch,
    // so a green "claude.ai login" here would be a true statement about the
    // wrong thing.
    return {
      id: "auth",
      label: "auth mode",
      status: "fail",
      value: "API key in env",
      detail: `${override} is set`,
      consequence: [
        `${override} overrides your stored login for every agent launched from`,
        "this shell. The channel then connects and silently delivers nothing.",
      ],
      remedy: `unset ${override}`,
    };
  }
  if (claudePath === null) {
    return { id: "auth", label: "auth mode", status: "skip", reason: "needs the claude cli" };
  }
  const r = await deps.run([claudePath, "auth", "status", "--json"]);
  const status = parseAuthStatus(r.stdout.trim() === "" ? r.stderr : r.stdout);
  if (status === null) {
    return {
      id: "auth",
      label: "auth mode",
      status: "fail",
      value: "unreadable",
      consequence: [
        "We could not read how this machine is authenticated, and an API-key",
        "login yields a channel that connects and delivers nothing.",
      ],
      remedy: "claude auth status",
    };
  }
  if (!status.loggedIn) {
    return {
      id: "auth",
      label: "auth mode",
      status: "fail",
      value: "not logged in",
      consequence: [
        "Nothing authenticates: agents cannot start and the channel cannot open.",
      ],
      remedy: "claude /login",
    };
  }
  if (!authSupported(status)) {
    return {
      id: "auth",
      label: "auth mode",
      status: "fail",
      value: describeAuth(status),
      consequence: [
        "Channels need a claude.ai login. On an API key the channel connects and",
        "then delivers nothing, naming no cause.",
      ],
      remedy: "claude /login",
    };
  }
  return { id: "auth", label: "auth mode", status: "pass", value: "claude.ai login" };
}

/** A human phrase for an unsupported auth mode. Carries no account identity. */
export function describeAuth(status: AuthStatus): string {
  if (status.authMethod === "" && status.apiProvider === "") return "unknown";
  if (/api ?key/i.test(status.authMethod)) return "API key";
  return status.authMethod || status.apiProvider;
}

function pluginCheck(deps: DoctorDeps, claudePath: string | null, entry: RunResult | null): CheckResult {
  if (claudePath === null || entry === null) {
    return { id: "plugin", label: "plugin", status: "skip", reason: "needs the claude cli" };
  }
  const output = `${entry.stdout}\n${entry.stderr}`;
  if (entry.exitCode !== 0) {
    return {
      id: "plugin",
      label: "plugin",
      status: "fail",
      value: "not registered",
      consequence: [
        `No ${CHANNEL_SERVER} MCP entry exists, so this runtime never joins the`,
        "channel and Suite shows it as offline.",
      ],
      remedy: "suite init",
    };
  }
  const path = parseMcpEntryPath(output);
  if (path === null) {
    // Unparseable is a LOUD failure printing the raw line, never a quiet pass:
    // "assume it is fine" would turn every future format change into a green
    // run against a broken setup.
    return {
      id: "plugin",
      label: "plugin",
      status: "fail",
      value: "entry unreadable",
      detail: compact(output),
      consequence: [
        "We could not find the plugin path in the MCP entry, so we cannot tell",
        "whether the channel will start at all.",
      ],
      remedy: "suite init",
    };
  }
  if (!deps.exists(path)) {
    return {
      id: "plugin",
      label: "plugin",
      status: "fail",
      value: "path does not resolve",
      detail: path,
      consequence: [
        "The MCP entry points at a checkout that has moved or been deleted, so",
        "the channel fails to start and no error names the path.",
      ],
      // The canvas said `suite init --repair`; that flag does not exist. `suite
      // init` re-resolves the checkout and rewrites both entries — see the
      // module docstring.
      remedy: "suite init",
    };
  }
  return { id: "plugin", label: "plugin", status: "pass", value: "checkout resolves", detail: path };
}

function credentialsCheck(
  deps: DoctorDeps,
  claudePath: string | null,
  entry: RunResult | null,
  pluginOk: boolean,
): CheckResult {
  if (claudePath === null || entry === null) {
    return { id: "credentials", label: "credentials", status: "skip", reason: "needs the claude cli" };
  }
  if (!pluginOk) {
    return { id: "credentials", label: "credentials", status: "skip", reason: "needs a working plugin path" };
  }
  // Presence only. The value is never read out of the parser, so it cannot be
  // printed by accident here or by any future caller.
  if (!mcpEntryHasToken(`${entry.stdout}\n${entry.stderr}`)) {
    return {
      id: "credentials",
      label: "credentials",
      status: "fail",
      value: "no token in the entry",
      consequence: [
        "The channel authenticates with nothing and is rejected by Suite, which",
        "looks exactly like a network problem from this side.",
      ],
      remedy: "suite init",
    };
  }
  const runtimeId = deps.config?.runtimeId ?? "";
  return {
    id: "credentials",
    label: "credentials",
    status: "pass",
    value: "set",
    detail: runtimeId === "" ? "" : `runtime ${runtimeId}`,
  };
}

async function channelCheck(
  deps: DoctorDeps,
  claudePath: string | null,
  pluginOk: boolean,
): Promise<CheckResult> {
  if (claudePath === null) {
    return { id: "channel", label: "channel", status: "skip", reason: "needs the claude cli" };
  }
  if (!pluginOk) {
    return { id: "channel", label: "channel", status: "skip", reason: "needs a working plugin path" };
  }
  const status = await channelStatus(deps, claudePath);
  if (status.state === "connected") {
    return { id: "channel", label: "channel", status: "pass", value: "connected" };
  }
  if (status.state === "missing") {
    return {
      id: "channel",
      label: "channel",
      status: "fail",
      value: "not registered",
      consequence: [
        `claude mcp list does not list ${CHANNEL_SERVER}, so nothing carries`,
        "Suite's messages to this machine.",
      ],
      remedy: "suite init",
    };
  }
  if (status.state === "unparseable") {
    return {
      id: "channel",
      label: "channel",
      status: "fail",
      value: "status unreadable",
      detail: status.raw,
      consequence: [
        "We cannot tell whether the channel is connected, and reading an",
        "unfamiliar status as healthy is how a broken setup reports green.",
      ],
      remedy: "claude mcp list",
    };
  }
  return {
    id: "channel",
    label: "channel",
    status: "fail",
    value: "not connected",
    detail: status.raw,
    consequence: [
      "Suite cannot reach this runtime: tasks routed here are never delivered",
      "and the router keeps waiting.",
    ],
    remedy: "claude mcp list",
  };
}

/**
 * The channel's health out of `claude mcp list`, via stage 3's parser.
 *
 * That parser is reused rather than re-derived because it already encodes the
 * trap: an unapproved user-scope server prints `⏸ Pending approval`, and a
 * parser looking only for `✘` reads that as green. Anything not positively
 * readable AS CONNECTED is not-connected or unparseable.
 */
export async function channelStatus(deps: DoctorDeps, claudePath: string): Promise<ServerStatus> {
  const r = await deps.run([claudePath, "mcp", "list"]);
  return parseServerStatus(`${r.stdout}\n${r.stderr}`, CHANNEL_SERVER);
}

export async function toolsStatus(deps: DoctorDeps, claudePath: string): Promise<ServerStatus> {
  const r = await deps.run([claudePath, "mcp", "list"]);
  return parseServerStatus(`${r.stdout}\n${r.stderr}`, TOOLS_SERVER);
}

async function sessionCheck(deps: DoctorDeps, tmuxPath: string | null): Promise<CheckResult> {
  if (tmuxPath === null) {
    return { id: "session", label: "session", status: "skip", reason: "needs tmux" };
  }
  const config = deps.config ?? emptyConfig();
  const name = sessionNameFromConfig(config, deps.cwd);
  const state: SessionState = await detectState(name, deps.tmux);
  if (state === "live") {
    return { id: "session", label: "session", status: "pass", value: "agent running", detail: name };
  }
  if (state === "none") {
    // Not a failure: no session for this directory is the ordinary state of a
    // healthy machine you have not started an agent on yet.
    return { id: "session", label: "session", status: "pass", value: "none for this directory", detail: name };
  }
  // STALE renders as ✘, never as ⋯: `⋯` means could-not-run, and a stale
  // session ran and died. Reporting it as healthy is the failure that matters —
  // the shell answers `has-session` yes while the agent is gone.
  return {
    id: "session",
    label: "session",
    status: "fail",
    value: "stale",
    detail: name,
    consequence: [
      "The tmux session is alive but Claude inside it is not, so attaching shows",
      "a shell prompt while Suite waits on an agent that already died.",
    ],
    remedy: "suite claude",
  };
}

/**
 * The raw output on ONE faint line, so an unreadable entry shows exactly what
 * we could not read. Truncated, because a remedy the user has to scroll past a
 * screen of output to reach is a remedy they do not see.
 */
function compact(text: string, limit = 160): string {
  const joined = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join(" · ");
  return joined.length <= limit ? joined : `${joined.slice(0, limit - 1)}…`;
}

/* ------------------------------------------------------------------------- */
/* Entry points                                                               */
/* ------------------------------------------------------------------------- */

export async function runDoctor(deps: DoctorDeps): Promise<number> {
  const checks = await runChecks(deps);
  for (const line of renderReport(checks, { color: deps.color, utf8: deps.utf8 })) deps.out(line);
  return exitCodeFor(checks);
}

export async function liveDoctorDeps(
  env: Record<string, string | undefined> = process.env,
): Promise<DoctorDeps> {
  const tmux = liveTmuxDeps(env);
  return {
    env,
    cwd: process.cwd(),
    which: (name) => whichBin(name, env),
    exists: pathResolves,
    config: await readConfig({ env }),
    configFile: configPath(env),
    tmux,
    color: colorEnabled(env),
    utf8: utf8Enabled(env),
    out: (line) => console.log(line),
    run: (argv) => tmux.run(argv),
  };
}

/** Exported for `suite status`, which resolves the same paths. */
export function checkoutIndexPath(dir: string): string {
  return resolve(dir, "src", "index.ts");
}
