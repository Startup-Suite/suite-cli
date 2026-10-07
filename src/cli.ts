#!/usr/bin/env bun
/**
 * suite — connects a machine to a Startup Suite install, then sets up and runs
 * whichever agent harness you use there (Claude Code, DeepSeek, Hermes, OpenClaw).
 *
 * Argument passthrough for `suite claude` is deliberately total: the wrapper
 * parses nothing beyond the verb, so a user flag can never be eaten by us.
 */
import { VERSION } from "./version.ts";
import { row, nextCommand } from "./ui.ts";
import { liveDeps, runInit } from "./commands/init.ts";
import { liveClaudeDeps, restoreWirer, runClaude } from "./commands/claude.ts";
import { liveDoctorDeps, runDoctor } from "./commands/doctor.ts";
import { hostname } from "node:os";
import {
  legacyLine,
  liveStatusDeps,
  liveStatusJsonInput,
  parseStatusArgs,
  renderStatusDocument,
  runStatus,
  statusDocument,
} from "./commands/status.ts";
import { divertStdout } from "./stamp_result.ts";
import { liveTmuxDeps } from "./tmux.ts";
import { resolve as resolvePath } from "node:path";
import {
  forceRecover,
  liveWatchDeps,
  overCeiling,
  parseWatchArgs,
  runWatch,
  shouldSelfInstall,
} from "./commands/watch.ts";
import { liveRestoreDeps, runRestore } from "./commands/restore.ts";
import {
  installSupervisor,
  liveSupervisorIo,
  readTelemetryAuth,
  resolveSelfBinary,
  supervisorPlan,
} from "./supervisor.ts";
import { readFileSync as readFileForAuth } from "node:fs";

/** Telemetry auth from env or the 0600 env file; absent is a valid answer. */
function telemetryAuth(): string | null {
  return readTelemetryAuth(process.env, (p) => {
    try {
      return readFileForAuth(p, "utf8");
    } catch {
      return null;
    }
  });
}
import { emptyConfig, readConfig } from "./config.ts";
import { liveDeepseekDeps, runDeepseek } from "./commands/deepseek.ts";
import { liveHermesDeps, runHermes } from "./commands/hermes.ts";
import { liveOpenclawDeps, runOpenclaw } from "./commands/openclaw.ts";
import { liveUpdateDeps, runUpdate } from "./commands/update.ts";
import { liveCodexDeps, runCodex } from "./commands/codex.ts";
import { ttyPrompter } from "./secrets.ts";

export type Verb =
  | "init"
  | "claude"
  | "claude new"
  | "deepseek"
  | "hermes"
  | "openclaw"
  | "codex"
  | "doctor"
  | "status"
  | "update"
  | "watch"
  | "restore";

export interface Dispatch {
  verb: Verb | null;
  /** Arguments after the verb, verbatim and in order. */
  args: string[];
}

const VERBS = new Set(["init", "claude", "deepseek", "hermes", "openclaw", "codex", "doctor", "status", "update", "watch", "restore"]);

/**
 * Pure: map argv to a verb plus untouched passthrough arguments.
 * `claude new` is the single explicit force-new form.
 */
export function parse(argv: string[]): Dispatch {
  const [head, ...rest] = argv;
  if (head === undefined || !VERBS.has(head)) return { verb: null, args: argv };
  if (head === "claude" && rest[0] === "new") {
    return { verb: "claude new", args: rest.slice(1) };
  }
  return { verb: head as Verb, args: rest };
}

/**
 * The ONE option `suite claude` owns: `--session NAME`.
 *
 * Passthrough is otherwise still total. This is the case the `--` terminator
 * was written for in advance — "a user who writes `suite claude -- --resume`
 * must get the same result once the wrapper grows an option". So the scan
 * STOPS at the first `--`: after it, `--session` is Claude's argument and is
 * left alone, exactly as it was before the wrapper owned the name.
 *
 * WHY IT IS A FLAG AND NOT A CONFIG KEY: asking for a second agent HERE, now,
 * is a different request from changing the naming rule for every future run —
 * see `sessionNameFromConfig`. It was already honoured all the way down; it
 * had simply never been parsed, so `suite claude --session x` sent the flag to
 * Claude, which has no such option. The README documented it regardless.
 *
 * Returns the name plus the arguments with the pair removed, because a flag we
 * consumed must not ALSO reach Claude.
 */
export function parseClaudeOptions(args: string[]): { session?: string; rest: string[] } {
  const rest: string[] = [];
  let session: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      // Everything from here is Claude's, terminator included.
      rest.push(...args.slice(i));
      break;
    }
    const next = args[i + 1];
    if (arg === "--session" && next !== undefined) {
      session = next;
      i++;
      continue;
    }
    if (arg !== undefined) rest.push(arg);
  }
  return session === undefined ? { rest } : { session, rest };
}

/**
 * The only options `suite init` parses. Everything else the CLI takes is a
 * verb, deliberately: an option surface is a thing to keep compatible forever.
 */
export function parseInitOptions(args: string[]): {
  checkout?: string;
  tokenFromEnv?: string;
  noSupervisor?: boolean;
  dir?: string;
  fromMcpJson?: boolean;
} {
  const out: { checkout?: string; tokenFromEnv?: string; noSupervisor?: boolean; dir?: string; fromMcpJson?: boolean } = {};
  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1];
    if (args[i] === "--checkout" && next !== undefined) out.checkout = next;
    if (args[i] === "--token-from-env" && next !== undefined) out.tokenFromEnv = next;
    // Opting OUT. Installing the watchdog is the default; see InitOptions.
    if (args[i] === "--no-supervisor") out.noSupervisor = true;
    // The agent folder this connection is for. Default: the working directory.
    if (args[i] === "--dir" && next !== undefined) out.dir = next;
    // Adopt <dir>/.mcp.json: the token never passes through argv or a terminal.
    if (args[i] === "--from-mcp-json") out.fromMcpJson = true;
  }
  return out;
}

export function usage(): string {
  return [
    "",
    row("suite", VERSION),
    "",
    row("init", "connect THIS agent folder to a Suite install (url, runtime id, token, watchdog)"),
    row("", "--dir PATH: the agent folder (default: here); --from-mcp-json: adopt PATH/.mcp.json"),
    row("claude", "set up Claude Code for Suite in this folder if needed, then run it in a persistent session"),
    row("claude new", "force a new session"),
    row("deepseek", "run a DeepSeek Harness agent federated into Suite"),
    row("hermes", "stamp a Hermes agent root and run its gateway (--stamp-only: JSON contract)"),
    row("openclaw", "stamp an OpenClaw agent root and run its gateway (--stamp-only: JSON contract)"),
    row("codex", "run a Codex agent through codex app-server, federated into Suite, in a persistent session"),
    row("doctor", "diagnose a broken setup"),
    row("status", "show every agent folder, session state and stamped agents (kind, root, live/stale, last verdict)"),
    row("", "--json [--dir PATH]: one JSON document on stdout (see README, Status contract)"),
    row("watch", "recover halted agent sessions (--dry-run, --once, --interval N, --force SESSION)"),
    row("restore", "bring recorded agents back up (--adopt, --dry-run, --forget NAME)"),
    row("update", "install the latest suite CLI"),
    "",
    nextCommand("suite init"),
  ].join("\n");
}

export async function run(argv: string[]): Promise<number> {
  if (argv[0] === "--version" || argv[0] === "-V") {
    console.log(VERSION);
    return 0;
  }
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(usage());
    return 0;
  }
  const { verb } = parse(argv);
  if (verb === null) {
    console.error(`suite: unknown command "${argv[0]}"`);
    console.error("run: suite --help");
    return 2;
  }
  if (verb === "init") {
    const { exitCode } = await runInit(liveDeps(ttyPrompter()), parseInitOptions(argv.slice(1)));
    return exitCode;
  }
  if (verb === "claude" || verb === "claude new") {
    // Everything after the verb is Claude's, verbatim, EXCEPT `--session NAME`
    // before a `--`. That one flag is ours; see parseClaudeOptions.
    const { args } = parse(argv);
    const { session, rest } = parseClaudeOptions(args);
    return runClaude(await liveClaudeDeps(), {
      userArgs: rest,
      force: verb === "claude new",
      explicitSession: session,
    });
  }
  if (verb === "deepseek") {
    // Ours: `--root DIR` before a `--`. Everything else reaches dsh verbatim.
    const { args } = parse(argv);
    return runDeepseek(args, liveDeepseekDeps());
  }
  if (verb === "hermes") {
    // Ours up to `--`; everything after it reaches `hermes gateway run`.
    const { args } = parse(argv);
    return runHermes(args, liveHermesDeps());
  }
  if (verb === "openclaw") {
    // Ours up to `--`; everything after it reaches `openclaw gateway run`.
    const { args } = parse(argv);
    return runOpenclaw(args, liveOpenclawDeps());
  }
  if (verb === "codex") {
    // Ours entirely: --root, --no-session, --approvals, --sandbox, --codex-home, --codex.
    const { args } = parse(argv);
    return runCodex(args, liveCodexDeps());
  }
  if (verb === "watch") {
    const { args } = parse(argv);
    const opts = parseWatchArgs(args);
    const deps = liveWatchDeps();

    // Forced recovery: prove the clear + reorient path on demand.
    if (opts.force) {
      const base = {
        apply: opts.apply,
        config: (await readConfig()) ?? emptyConfig(),
        auth: telemetryAuth(),
        host: hostname(),
        home: process.env.HOME ?? "",
      };
      const res = await forceRecover(deps, base, opts.force);
      console.log(`suite watch: ${opts.force}: ${res.reason}`);
      if (res.prompt) console.log(`--- reorientation sent ---\n${res.prompt}`);
      return res.recovered || !opts.apply ? 0 : 1;
    }

    // Self-installing: typing `suite watch` leaves behind a service that
    // outlives the terminal, rather than a loop that dies with it. The daemon
    // it installs is marked so it does not reinstall itself on every restart.
    if (shouldSelfInstall(opts, process.env)) {
      const home = process.env.HOME ?? "";
      const plan = supervisorPlan({
        platform: process.platform,
        home,
        binary: resolveSelfBinary(process.env, process.argv),
        inheritedPath: process.env.PATH,
        inheritedLocale: process.env.LANG ?? process.env.LC_ALL,
        intervalSeconds: opts.intervalSeconds,
      });
      const res = await installSupervisor(liveSupervisorIo(), plan);
      console.log(
        res.installed
          ? `suite watch: running as ${res.summary} — nothing further to set up`
          : `suite watch: ${res.summary}`,
      );
      // One sweep now, so the operator sees the current state immediately
      // rather than waiting a full interval to learn it works.
      await runWatch(deps, {
        apply: opts.apply,
        config: (await readConfig()) ?? emptyConfig(),
        auth: telemetryAuth(),
        host: hostname(),
        home,
      });
      return res.installed ? 0 : 1;
    }
    const config = (await readConfig()) ?? emptyConfig();
    const base = {
      apply: opts.apply,
      config,
      auth: telemetryAuth(),
      host: hostname(),
      home: process.env.HOME ?? "",
    };
    if (opts.once) {
      await runWatch(deps, base);
      return 0;
    }
    // Long-running: a halt is permanent until something acts, so a missed pass
    // costs latency rather than correctness. Errors are logged and the loop
    // continues; exiting would leave every later halt unattended.
    for (;;) {
      try {
        await runWatch(deps, base);
      } catch (err) {
        console.error(`suite watch: pass failed: ${(err as Error).message}`);
      }
      // Bounded by construction. On macOS this is the ONLY memory bound, since
      // launchd has no MemoryMax; the supervisor restarts us clean.
      const over = overCeiling(process.memoryUsage().rss);
      if (over) {
        console.error(`suite watch: exiting for a clean restart — ${over}`);
        return 1;
      }
      await deps.sleep(opts.intervalSeconds * 1000);
    }
  }
  if (verb === "restore") {
    const { args } = parse(argv);
    const i = args.indexOf("--forget");
    const forget = i === -1 ? undefined : args[i + 1];
    const res = await runRestore(
      { ...liveRestoreDeps(), wire: restoreWirer(process.env, (line) => console.error(`suite restore: ${line}`)) },
      process.env.HOME ?? "",
      {
        apply: !args.includes("--dry-run"),
        forget,
        adopt: args.includes("--adopt"),
      },
    );
    // Failing to restore an agent is a real failure; a fully-skipped run on a
    // healthy box is a success, which is what makes this safe to run at boot.
    return res.failed.length > 0 ? 1 : 0;
  }
  if (verb === "update") return runUpdate(liveUpdateDeps());
  if (verb === "doctor") return runDoctor(await liveDoctorDeps());
  const statusArgs = parseStatusArgs(argv.slice(1));
  if (statusArgs.json) {
    // ONE document on stdout; every other write is diverted to stderr.
    return divertStdout(async (io) => {
      const dir = resolvePath(process.cwd(), statusArgs.dir ?? ".");
      const input = liveStatusJsonInput(process.env, dir, liveTmuxDeps(process.env));
      const doc = await statusDocument(input);
      io.stdout(renderStatusDocument(doc));
      io.stderr(`suite status: ${doc.agents.length} agents\n`);
      if (input.legacy !== null) io.stderr(`${legacyLine(input.legacy)}\n`);
      return 0;
    });
  }
  return runStatus(await liveStatusDeps());
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}
