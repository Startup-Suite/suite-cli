/**
 * `suite harness` — which agent harnesses this machine has, whether each is
 * logged in, and how to install one. A machine verb: the Mac app reads it.
 *
 *   suite harness --json [--root DIR]
 *   suite harness install claude --yes [--json]
 *   suite harness install codex|openclaw|hermes|deepseek [--json]   (human step)
 *
 * THE PATH IS THE CALLER'S. Binaries are resolved on the PATH this process was
 * given and nowhere else, because the Mac app runs under launchd, whose PATH
 * is empty, and passes the user's LOGIN-shell PATH down. A binary that exists
 * at its official install location but is not on that PATH is reported as
 * `found_off_path` with the exact line to add — never silently used, because
 * `suite claude` would then fail to find the very binary we called present.
 *
 * NO PACKAGE MANAGER RUNS HERE. `install claude --yes` runs the official
 * Claude Code installer through the same plan `suite claude` offers
 * (claudeInstallPlan: user-owned, no sudo). Every other harness gets a
 * human step naming its official command and page; suite-cli does not run
 * npm, brew or pip for anyone.
 *
 * Login state comes from src/login.ts, the one classifier. No credential is
 * read here: Claude's `auth status --json` and Codex's `login status` report
 * a state, not a token, and the children run with the allowlisted env.
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { harnessChildEnv } from "../harness_env.ts";
import { classifyClaudeAuthStatus, classifyCodexLoginStatus, type LoggedIn } from "../login.ts";
import { HARNESS_PROBE_TIMEOUT_MS } from "../tuning.ts";
import { claudeInstallPlan, CLAUDE_INSTALL_REQUIRED_TOOLS } from "./claude.ts";
import { managedOpenclawBin } from "./openclaw.ts";

type Env = Record<string, string | undefined>;

export const HARNESS_CONTRACT_VERSION = 1 as const;

export const HARNESS_KINDS = ["claude", "codex", "openclaw", "hermes", "deepseek"] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

export type InstallMode = "auto" | "command" | "link";

export interface InstallInfo {
  mode: InstallMode;
  command?: string;
  url: string;
}

export interface HarnessRow {
  kind: HarnessKind;
  /** On the PATH this process was given. */
  found: boolean;
  /** Not on that PATH, but present at an official install location. */
  found_off_path: boolean;
  /** The binary: on PATH, or the off-PATH location when found_off_path. */
  path: string | null;
  /** The exact shell line that puts an off-PATH binary on PATH; null otherwise. */
  path_line: string | null;
  version: string | null;
  logged_in: LoggedIn;
  /** Found on PATH and (for claude/codex) logged in: `suite <verb>` can start it now. */
  suite_ready: boolean;
  install: InstallInfo;
  notes: string[];
}

export interface HarnessDocument {
  contract_version: typeof HARNESS_CONTRACT_VERSION;
  harnesses: HarnessRow[];
}

export interface HumanStep {
  kind: "install_harness";
  harness: HarnessKind;
  command: string;
  url: string;
}

export interface InstallDocument {
  contract_version: typeof HARNESS_CONTRACT_VERSION;
  ok: boolean;
  kind: HarnessKind | null;
  ran_installer: boolean;
  harness: HarnessRow | null;
  human_steps: HumanStep[];
  error: { code: string; message: string } | null;
}

export interface RunOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface HarnessDeps {
  /** The caller's environment. PATH here is the only PATH searched. */
  env: Env;
  platform: string;
  cwd: string;
  /** Run a child to completion, capturing output, killed at `timeoutMs`. */
  run(argv: string[], opts: { env: Record<string, string>; timeoutMs: number }): Promise<RunOutcome>;
  isExecutable(path: string): boolean;
  isDirectory(path: string): boolean;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** The binary name each kind runs. */
export const BINARY: Record<HarnessKind, string> = {
  claude: "claude",
  codex: "codex",
  openclaw: "openclaw",
  hermes: "hermes",
  deepseek: "dsh",
};

/**
 * Official install locations a binary may sit in without being on PATH.
 * claude: the native installer's launcher (code.claude.com/docs/en/setup).
 * codex: Homebrew's prefixes (`brew install --cask codex`) and the
 * chatgpt.com install script's user bin.
 */
export function offPathCandidates(kind: HarnessKind, home: string): string[] {
  switch (kind) {
    case "claude":
      return [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude")];
    case "codex":
      return ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", join(home, ".local", "bin", "codex")];
    default:
      return [];
  }
}

/**
 * How to install each kind. Commands are the vendors' own, checked on
 * 2026-10-05: Claude Code at code.claude.com/docs/en/setup (the native
 * installer `suite claude` already uses), Codex at github.com/openai/codex
 * (`npm install -g @openai/codex`; `brew install --cask codex` and
 * `curl -fsSL https://chatgpt.com/codex/install.sh | sh` are its alternatives).
 * OpenClaw, Hermes and DeepSeek are installed BY their `suite` verb, which
 * pins and isolates them per agent root — that verb is the command.
 */
export function installInfo(kind: HarnessKind, platform: string): InstallInfo {
  switch (kind) {
    case "claude": {
      const plan = claudeInstallPlan({ platform });
      return plan === null
        ? { mode: "link", url: "https://code.claude.com/docs/en/setup" }
        : { mode: "auto", command: "curl -fsSL https://claude.ai/install.sh | bash", url: "https://code.claude.com/docs/en/setup" };
    }
    case "codex":
      return { mode: "command", command: "npm install -g @openai/codex", url: "https://github.com/openai/codex" };
    case "openclaw":
      return { mode: "command", command: "suite openclaw --root DIR", url: "https://www.npmjs.com/package/openclaw" };
    case "hermes":
      return { mode: "command", command: "suite hermes --root DIR", url: "https://github.com/NousResearch/hermes-agent" };
    case "deepseek":
      return { mode: "command", command: "suite deepseek", url: "https://www.npmjs.com/package/@deepseek-ai/dsh" };
  }
}

/** `which`, on exactly the PATH given. Pure apart from `isExecutable`. */
export function whichOn(bin: string, path: string | undefined, isExecutable: (p: string) => boolean): string | null {
  if (path === undefined || path === "") return null;
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, bin);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** The line that puts `binPath`'s directory on PATH. */
export function pathLine(binPath: string): string {
  const dir = binPath.slice(0, binPath.lastIndexOf("/"));
  return `export PATH="${dir}:$PATH"`;
}

/** First version-looking token of `--version` output, else its first line. */
export function parseVersion(stdout: string): string | null {
  const line = stdout.split("\n").map((l) => l.trim()).find((l) => l !== "");
  if (line === undefined) return null;
  return /\d+\.\d+\.\d+[^\s]*/.exec(line)?.[0] ?? line;
}

export function codexHomeForRoot(root: string): string {
  return join(root, ".codex");
}

export function parseHarnessArgs(args: string[]): {
  json: boolean;
  root?: string;
  install?: string;
  yes: boolean;
  error?: string;
} {
  const out: { json: boolean; root?: string; install?: string; yes: boolean; error?: string } = { json: false, yes: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") out.json = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--root") {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) out.error = "--root needs a value";
      else out.root = resolve(v);
    } else if (a === "install" && i === 0) {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) out.error = "install needs a harness: claude, codex, openclaw, hermes or deepseek";
      else out.install = v;
    } else out.error = `unknown option ${a}`;
  }
  return out;
}

/** One row. Probes run with the allowlisted env (no Suite credential). */
export async function harnessRow(deps: HarnessDeps, kind: HarnessKind, root: string): Promise<HarnessRow> {
  const home = deps.env.HOME ?? "";
  const bin = BINARY[kind];
  const install = installInfo(kind, deps.platform);
  const notes: string[] = [];
  let path = whichOn(bin, deps.env.PATH, deps.isExecutable);
  const found = path !== null;
  let foundOffPath = false;
  if (!found) {
    const off = offPathCandidates(kind, home).find((p) => deps.isExecutable(p));
    if (off !== undefined) {
      path = off;
      foundOffPath = true;
      notes.push(`${bin} is installed at ${off} but that directory is not on PATH`);
    }
    if (kind === "openclaw" && !foundOffPath) {
      const managed = managedOpenclawBin(deps.env);
      if (deps.isExecutable(managed)) notes.push(`suite openclaw has its own managed install at ${managed}`);
    }
  }

  const env = harnessChildEnv(deps.env);
  let version: string | null = null;
  let loggedIn: LoggedIn = "unknown";
  if (path !== null) {
    const v = await deps.run([path, "--version"], { env, timeoutMs: HARNESS_PROBE_TIMEOUT_MS });
    version = v.timedOut ? null : parseVersion(v.stdout);
    if (kind === "claude") {
      const s = await deps.run([path, "auth", "status", "--json"], { env, timeoutMs: HARNESS_PROBE_TIMEOUT_MS });
      loggedIn = s.timedOut ? "unknown" : classifyClaudeAuthStatus(s.stdout, s.exitCode).logged_in;
    } else if (kind === "codex") {
      const codexHome = codexHomeForRoot(root);
      // Measured (codex-cli 0.157.0): a CODEX_HOME that does not exist is a
      // configuration ERROR, not "logged out" — but nothing can be logged in
      // inside a directory that is not there, so it is answered without asking.
      if (!deps.isDirectory(codexHome)) {
        loggedIn = false;
        notes.push(`no Codex login for this agent yet (CODEX_HOME ${codexHome} does not exist)`);
      } else {
        const s = await deps.run([path, "login", "status"], {
          env: harnessChildEnv(deps.env, { CODEX_HOME: codexHome }),
          timeoutMs: HARNESS_PROBE_TIMEOUT_MS,
        });
        loggedIn = s.timedOut ? "unknown" : classifyCodexLoginStatus(s.exitCode, s.stdout, s.stderr);
      }
    }
  }
  if (kind === "openclaw" || kind === "hermes" || kind === "deepseek") {
    notes.push(`set up from Terminal with \`${install.command}\``);
  }
  const needsLogin = kind === "claude" || kind === "codex";
  return {
    kind,
    found,
    found_off_path: foundOffPath,
    path,
    path_line: foundOffPath && path !== null ? pathLine(path) : null,
    version,
    logged_in: loggedIn,
    suite_ready: found && (!needsLogin || loggedIn === true),
    install,
    notes,
  };
}

export async function harnessDocument(deps: HarnessDeps, root: string): Promise<HarnessDocument> {
  const harnesses: HarnessRow[] = [];
  for (const kind of HARNESS_KINDS) harnesses.push(await harnessRow(deps, kind, root));
  return { contract_version: HARNESS_CONTRACT_VERSION, harnesses };
}

const isKind = (k: string): k is HarnessKind => (HARNESS_KINDS as readonly string[]).includes(k);

/** The Claude installer may run this long before it is killed. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

function installDoc(partial: Partial<InstallDocument>): InstallDocument {
  return {
    contract_version: HARNESS_CONTRACT_VERSION,
    ok: false,
    kind: null,
    ran_installer: false,
    harness: null,
    human_steps: [],
    error: null,
    ...partial,
  };
}

/**
 * `suite harness install KIND`. Exit codes follow the init contract: 0 ok,
 * 1 failed, 2 refused, 3 blocked on a human.
 */
export async function runHarnessInstall(deps: HarnessDeps, kind: string, opts: { yes: boolean; root: string }): Promise<{ code: number; doc: InstallDocument }> {
  if (!isKind(kind)) {
    return { code: 2, doc: installDoc({ error: { code: "unknown_harness", message: `unknown harness ${kind}` } }) };
  }
  const info = installInfo(kind, deps.platform);
  if (kind !== "claude" || info.mode !== "auto") {
    // No package manager, by rule: the human runs the vendor's own command.
    const step: HumanStep = { kind: "install_harness", harness: kind, command: info.command ?? info.url, url: info.url };
    return { code: 3, doc: installDoc({ kind, harness: await harnessRow(deps, kind, opts.root), human_steps: [step] }) };
  }
  if (!opts.yes) {
    return {
      code: 2,
      doc: installDoc({ kind, error: { code: "confirmation_required", message: "suite harness install claude runs the official installer only with --yes" } }),
    };
  }
  const missing = CLAUDE_INSTALL_REQUIRED_TOOLS.filter((t) => whichOn(t, deps.env.PATH, deps.isExecutable) === null);
  if (missing.length > 0) {
    return {
      code: 1,
      doc: installDoc({ kind, error: { code: "installer_tools_missing", message: `the Claude Code installer needs ${missing.join(" and ")}, not on PATH` } }),
    };
  }
  const plan = claudeInstallPlan({ platform: deps.platform })!;
  const r = await deps.run(plan.argv, { env: harnessChildEnv(deps.env), timeoutMs: INSTALL_TIMEOUT_MS });
  // The installer's own output is for a person: stderr, so stdout stays ONE document.
  if (r.stdout !== "") deps.stderr(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
  if (r.stderr !== "") deps.stderr(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
  const row = await harnessRow(deps, kind, opts.root);
  if (r.timedOut || r.exitCode !== 0) {
    return {
      code: 1,
      doc: installDoc({
        kind,
        ran_installer: true,
        harness: row,
        error: { code: "installer_failed", message: r.timedOut ? "the Claude Code installer timed out" : `the Claude Code installer exited ${r.exitCode}` },
      }),
    };
  }
  if (!row.found && !row.found_off_path) {
    return {
      code: 1,
      doc: installDoc({ kind, ran_installer: true, harness: row, error: { code: "not_found_after_install", message: "the installer reported success but claude was not found" } }),
    };
  }
  return { code: 0, doc: installDoc({ ok: true, kind, ran_installer: true, harness: row }) };
}

export async function runHarness(args: string[], deps: HarnessDeps): Promise<number> {
  const opts = parseHarnessArgs(args);
  if (opts.error !== undefined) {
    deps.stderr(`suite harness: ${opts.error}\n`);
    return 2;
  }
  const root = opts.root ?? deps.cwd;
  if (opts.install !== undefined) {
    const { code, doc } = await runHarnessInstall(deps, opts.install, { yes: opts.yes, root });
    if (opts.json) deps.stdout(`${JSON.stringify(doc, null, 2)}\n`);
    else {
      for (const s of doc.human_steps) deps.stdout(`install ${s.harness}: ${s.command}  (${s.url})\n`);
      if (doc.error !== null) deps.stderr(`suite harness: ${doc.error.message}\n`);
      else if (doc.ok) deps.stdout(`installed ${doc.kind} at ${doc.harness?.path ?? "?"}\n`);
    }
    return code;
  }
  const doc = await harnessDocument(deps, root);
  if (opts.json) {
    deps.stdout(`${JSON.stringify(doc, null, 2)}\n`);
    return 0;
  }
  for (const r of doc.harnesses) {
    const where = r.found ? r.path : r.found_off_path ? `${r.path} (not on PATH: ${r.path_line})` : "not installed";
    deps.stdout(`${r.kind.padEnd(9)} ${where}${r.version ? `  ${r.version}` : ""}  logged in: ${String(r.logged_in)}\n`);
  }
  return 0;
}

/* ------------------------------------------------------------------------- */
/* Live dependencies                                                          */
/* ------------------------------------------------------------------------- */

export function liveIsExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Run with a hard timeout; stdin is /dev/null so no probe can wait on a person. */
export async function liveRun(argv: string[], opts: { env: Record<string, string>; timeoutMs: number }): Promise<RunOutcome> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { env: opts.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    return { exitCode: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, opts.timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut };
}

export function liveHarnessDeps(env: Env = process.env): HarnessDeps {
  return {
    env,
    platform: process.platform,
    cwd: process.cwd(),
    run: liveRun,
    isExecutable: liveIsExecutable,
    isDirectory: (p) => existsSync(p) && statSync(p).isDirectory(),
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
  };
}
