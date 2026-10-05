/**
 * `suite login claude|codex [--root DIR] [--json] [--no-browser]` — drive a
 * harness's OWN login and report it as NDJSON events on stdout:
 *
 *   {"event":"open_url","url":...}                      open this in the user's default browser
 *   {"event":"device_code","code":...,"url":...,"expires_at":...}   show this code
 *   {"event":"human_step","kind":"complete_login_in_terminal","command":...,"reason":...}
 *   {"event":"error","code":...,"message":...}
 *   {"event":"done","logged_in":true|false|"unknown"}  always last (except a usage refusal)
 *
 * Exit: 0 logged in, 1 failed or timed out, 2 refused (usage), 3 blocked on a
 * human (finish in a terminal), 4 the harness is not installed.
 *
 * NO CREDENTIAL PASSES THROUGH SUITE. That is a rule from the vendor, not only
 * from us: Anthropic's Claude Code legal page
 * (code.claude.com/docs/en/legal-and-compliance) says developers "may not
 * collect, store, or intermediate Claude.ai credentials or session tokens —
 * sign-in to a Claude account must complete through Anthropic's own flow."
 *
 *  - CLAUDE. Measured on 2.1.289 (src/login.ts): `claude auth login --claudeai`
 *    completes by a LOCALHOST CALLBACK — it listens on 127.0.0.1 and hands
 *    `$BROWSER` an authorize URL whose redirect_uri is
 *    http://localhost:<port>/callback. With --no-browser, `$BROWSER` is a shim
 *    that only records that URL; suite emits it as `open_url`, the caller opens
 *    it in the user's default browser, and the browser talks to Anthropic and
 *    back to Claude Code directly. Claude ALSO prints a paste-code fallback
 *    ("Paste code here if prompted >"). suite NEVER relays a pasted code: the
 *    harness's stdin is /dev/null, this verb never reads its own stdin, and
 *    `paste_code_needed` is never emitted. When the localhost flow cannot
 *    finish, the event is `human_step` complete_login_in_terminal, and the
 *    person pastes into Claude Code itself, in a terminal.
 *    (DEVIATION from task 01a0d6b9's stage text, which asked for the paste code
 *    to be read from this verb's stdin and forwarded: that is intermediating a
 *    Claude.ai sign-in, which the legal line above forbids.)
 *  - CODEX. `codex login --device-auth`, with CODEX_HOME=<root>/.codex (the
 *    agent's own home, as `suite codex` uses). The user types the one-time
 *    code on OpenAI's own page; suite only displays what Codex printed.
 *
 * Never logged, never in argv, never in a file: the device code goes to stdout
 * in its one event and nowhere else; URLs are not written to stderr. With
 * --no-browser this verb never opens a browser (Codex's device flow does not
 * open one either).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { harnessChildEnv } from "../harness_env.ts";
import {
  browserUrlFromShim,
  classifyClaudeAuthStatus,
  classifyCodexLoginStatus,
  parseCodexDeviceAuth,
  type LoggedIn,
} from "../login.ts";
import { HARNESS_PROBE_TIMEOUT_MS, LOGIN_BROWSER_WAIT_MS, LOGIN_TIMEOUT_MS } from "../tuning.ts";
import { liveIsExecutable, liveRun, whichOn, type RunOutcome } from "./harness.ts";

type Env = Record<string, string | undefined>;

export type LoginKind = "claude" | "codex";

export const CLAUDE_LOGIN_COMMAND = "claude auth login --claudeai";

export type LoginEvent =
  | { event: "open_url"; url: string }
  | { event: "device_code"; code: string; url: string; expires_at: string | null }
  | { event: "human_step"; kind: "complete_login_in_terminal"; command: string; reason: string }
  | { event: "error"; code: string; message: string }
  | { event: "done"; logged_in: LoggedIn };

export interface LoginProcess {
  /** Called with each stdout chunk. The harness's stdout is never forwarded. */
  onStdout(cb: (chunk: string) => void): void;
  exited: Promise<number>;
  kill(): void;
}

export interface BrowserShim {
  /** Absolute path of the executable the harness gets as `$BROWSER`. */
  path: string;
  /** What the shim has recorded so far (one argv word per line). */
  read(): string;
  cleanup(): void;
}

export interface LoginDeps {
  env: Env;
  cwd: string;
  /** Spawn the harness login with stdin /dev/null. */
  spawn(argv: string[], opts: { env: Record<string, string> }): LoginProcess;
  /** Status probes. */
  run(argv: string[], opts: { env: Record<string, string>; timeoutMs: number }): Promise<RunOutcome>;
  isExecutable(path: string): boolean;
  ensureDir(path: string): void;
  browserShim(): BrowserShim;
  now(): number;
  sleep(ms: number): Promise<void>;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Register a function the CLI calls on SIGTERM/SIGINT, so a cancelled login leaves no harness behind. */
  onCancel?(fn: () => void): void;
  timeouts?: { loginMs?: number; browserWaitMs?: number; pollMs?: number };
}

export interface LoginOptions {
  kind: LoginKind;
  root?: string;
  json: boolean;
  noBrowser: boolean;
}

export function parseLoginArgs(args: string[]): LoginOptions | { error: string } {
  const [kind, ...rest] = args;
  if (kind !== "claude" && kind !== "codex") return { error: "usage: suite login claude|codex [--root DIR] [--json] [--no-browser]" };
  const out: LoginOptions = { kind, json: false, noBrowser: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--json") out.json = true;
    else if (a === "--no-browser") out.noBrowser = true;
    else if (a === "--root") {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) return { error: "--root needs a value" };
      out.root = resolve(v);
    } else return { error: `unknown option ${a}` };
  }
  return out;
}

/** The writer: NDJSON under --json, a plain line otherwise. */
function emitter(deps: LoginDeps, json: boolean): (e: LoginEvent) => void {
  return (e) => {
    if (json) {
      deps.stdout(`${JSON.stringify(e)}\n`);
      return;
    }
    switch (e.event) {
      case "open_url":
        deps.stdout(`Open this page to sign in: ${e.url}\n`);
        break;
      case "device_code":
        deps.stdout(`Go to ${e.url} and enter the code ${e.code}\n`);
        break;
      case "human_step":
        deps.stdout(`Finish the login in a terminal: ${e.command}\n`);
        break;
      case "error":
        deps.stdout(`login failed: ${e.message}\n`);
        break;
      case "done":
        deps.stdout(e.logged_in === true ? "Logged in.\n" : "Not logged in.\n");
        break;
    }
  };
}

async function claudeStatus(deps: LoginDeps, bin: string, env: Record<string, string>): Promise<LoggedIn> {
  const r = await deps.run([bin, "auth", "status", "--json"], { env, timeoutMs: HARNESS_PROBE_TIMEOUT_MS });
  return r.timedOut ? "unknown" : classifyClaudeAuthStatus(r.stdout, r.exitCode).logged_in;
}

async function codexStatus(deps: LoginDeps, bin: string, env: Record<string, string>): Promise<LoggedIn> {
  const r = await deps.run([bin, "login", "status"], { env, timeoutMs: HARNESS_PROBE_TIMEOUT_MS });
  return r.timedOut ? "unknown" : classifyCodexLoginStatus(r.exitCode, r.stdout, r.stderr);
}

/** Wait for `proc` to exit, or for `until()` to be true, or for the deadline. */
async function waitFor(
  deps: LoginDeps,
  proc: LoginProcess,
  deadline: number,
  tick: () => "continue" | "stop",
): Promise<{ exited: boolean; code: number | null }> {
  let exitCode: number | null = null;
  void proc.exited.then((c) => {
    exitCode = c;
  });
  const poll = deps.timeouts?.pollMs ?? 250;
  for (;;) {
    if (exitCode !== null) return { exited: true, code: exitCode };
    if (tick() === "stop") return { exited: false, code: null };
    if (deps.now() >= deadline) return { exited: false, code: null };
    await deps.sleep(poll);
  }
}

export async function runLogin(args: string[], deps: LoginDeps): Promise<number> {
  const opts = parseLoginArgs(args);
  if ("error" in opts) {
    deps.stderr(`suite login: ${opts.error}\n`);
    return 2;
  }
  const emit = emitter(deps, opts.json);
  const bin = whichOn(opts.kind, deps.env.PATH, deps.isExecutable);
  if (bin === null) {
    emit({ event: "error", code: "harness_not_found", message: `${opts.kind} is not on PATH; see suite harness --json for how to install it` });
    emit({ event: "done", logged_in: false });
    return 4;
  }
  return opts.kind === "claude" ? await loginClaude(deps, opts, bin, emit) : await loginCodex(deps, opts, bin, emit);
}

async function loginClaude(deps: LoginDeps, opts: LoginOptions, bin: string, emit: (e: LoginEvent) => void): Promise<number> {
  const baseEnv = harnessChildEnv(deps.env);
  if ((await claudeStatus(deps, bin, baseEnv)) === true) {
    emit({ event: "done", logged_in: true });
    return 0;
  }
  const shim = opts.noBrowser ? deps.browserShim() : null;
  try {
    const env = shim === null ? baseEnv : harnessChildEnv(deps.env, { BROWSER: shim.path });
    deps.stderr("suite login: starting Claude Code's own sign-in (claude auth login --claudeai)\n");
    const proc = deps.spawn([bin, "auth", "login", "--claudeai"], { env });
    // Read for shape only, never forwarded: it holds the paste-code fallback URL.
    proc.onStdout(() => {});
    deps.onCancel?.(() => proc.kill());
    const started = deps.now();
    const deadline = started + (deps.timeouts?.loginMs ?? LOGIN_TIMEOUT_MS);
    const browserDeadline = started + (deps.timeouts?.browserWaitMs ?? LOGIN_BROWSER_WAIT_MS);
    let opened = shim === null;
    let noCallback = false;
    const r = await waitFor(deps, proc, deadline, () => {
      if (opened || shim === null) return "continue";
      const url = browserUrlFromShim(shim.read());
      if (url !== null) {
        emit({ event: "open_url", url });
        opened = true;
        return "continue";
      }
      if (deps.now() >= browserDeadline) {
        noCallback = true;
        return "stop";
      }
      return "continue";
    });
    if (!r.exited) proc.kill();
    const state = await claudeStatus(deps, bin, baseEnv);
    if (state === true) {
      emit({ event: "done", logged_in: true });
      return 0;
    }
    if (noCallback || (r.exited && !opened)) {
      emit({ event: "human_step", kind: "complete_login_in_terminal", command: CLAUDE_LOGIN_COMMAND, reason: "no_localhost_callback" });
      emit({ event: "done", logged_in: state });
      return 3;
    }
    if (!r.exited) {
      emit({ event: "error", code: "login_timeout", message: "the sign-in was not finished in time" });
      emit({ event: "done", logged_in: state });
      return 1;
    }
    // Claude exited without a login: the browser leg did not complete. The
    // paste-code route stays in Claude Code's own terminal, never ours.
    emit({ event: "human_step", kind: "complete_login_in_terminal", command: CLAUDE_LOGIN_COMMAND, reason: "login_exited" });
    emit({ event: "done", logged_in: state });
    return 3;
  } finally {
    shim?.cleanup();
  }
}

async function loginCodex(deps: LoginDeps, opts: LoginOptions, bin: string, emit: (e: LoginEvent) => void): Promise<number> {
  const root = opts.root ?? deps.cwd;
  const codexHome = join(root, ".codex");
  deps.ensureDir(codexHome);
  const env = harnessChildEnv(deps.env, { CODEX_HOME: codexHome });
  if ((await codexStatus(deps, bin, env)) === true) {
    emit({ event: "done", logged_in: true });
    return 0;
  }
  deps.stderr(`suite login: starting Codex's own device-code sign-in (CODEX_HOME=${codexHome})\n`);
  const proc = deps.spawn([bin, "login", "--device-auth"], { env });
  let output = "";
  proc.onStdout((chunk) => {
    output += chunk;
  });
  deps.onCancel?.(() => proc.kill());
  const started = deps.now();
  const deadline = started + (deps.timeouts?.loginMs ?? LOGIN_TIMEOUT_MS);
  let shown = false;
  const r = await waitFor(deps, proc, deadline, () => {
    if (shown) return "continue";
    const dc = parseCodexDeviceAuth(output);
    if (dc !== null) {
      const expires = dc.expiresInMinutes === null ? null : new Date(started + dc.expiresInMinutes * 60_000).toISOString();
      emit({ event: "device_code", code: dc.code, url: dc.url, expires_at: expires });
      emit({ event: "open_url", url: dc.url });
      shown = true;
      output = "";
    }
    return "continue";
  });
  if (!r.exited) proc.kill();
  output = "";
  const state = await codexStatus(deps, bin, env);
  if (state !== true && !r.exited) emit({ event: "error", code: "login_timeout", message: "the device code was not entered in time" });
  else if (state !== true && !shown) emit({ event: "error", code: "no_device_code", message: "Codex did not print a device code" });
  emit({ event: "done", logged_in: state });
  return state === true ? 0 : 1;
}

/* ------------------------------------------------------------------------- */
/* Live dependencies                                                          */
/* ------------------------------------------------------------------------- */

/**
 * The `$BROWSER` shim: a two-line sh script in a fresh 0700 directory that
 * appends its arguments to a file beside it and exits 0. It opens nothing.
 */
export function liveBrowserShim(): BrowserShim {
  const dir = mkdtempSync(join(tmpdir(), "suite-login-"));
  chmodSync(dir, 0o700);
  const record = join(dir, "browser-argv");
  const path = join(dir, "browser");
  writeFileSync(path, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${record}'; done\nexit 0\n`, { mode: 0o700 });
  return {
    path,
    read: () => {
      try {
        return readFileSync(record, "utf8");
      } catch {
        return "";
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function liveLoginDeps(env: Env = process.env): LoginDeps {
  return {
    env,
    cwd: process.cwd(),
    spawn(argv, opts) {
      const proc = Bun.spawn(argv, { env: opts.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const listeners: ((c: string) => void)[] = [];
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
          const text = decoder.decode(chunk, { stream: true });
          for (const l of listeners) l(text);
        }
      })().catch(() => {});
      return { onStdout: (cb) => void listeners.push(cb), exited: proc.exited, kill: () => proc.kill() };
    },
    run: liveRun,
    isExecutable: liveIsExecutable,
    ensureDir: (p) => {
      if (!existsSync(p)) mkdirSync(p, { recursive: true, mode: 0o700 });
      else if (!statSync(p).isDirectory()) throw new Error(`${p} exists and is not a directory`);
    },
    browserShim: liveBrowserShim,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
    onCancel: (fn) => {
      for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => {
        fn();
        process.exit(130);
      });
    },
  };
}
