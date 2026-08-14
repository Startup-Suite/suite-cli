#!/usr/bin/env bun
/**
 * suite — command-line tool for wiring a Claude Code runtime to Startup Suite.
 *
 * Argument passthrough for `suite claude` is deliberately total: the wrapper
 * parses nothing beyond the verb, so a user flag can never be eaten by us.
 */
import { VERSION } from "./version.ts";
import { row, nextCommand } from "./ui.ts";
import { liveDeps, runInit } from "./commands/init.ts";
import { liveClaudeDeps, runClaude } from "./commands/claude.ts";
import { liveDoctorDeps, runDoctor } from "./commands/doctor.ts";
import { runStatus } from "./commands/status.ts";
import { ttyPrompter } from "./secrets.ts";

export type Verb = "init" | "claude" | "claude new" | "doctor" | "status";

export interface Dispatch {
  verb: Verb | null;
  /** Arguments after the verb, verbatim and in order. */
  args: string[];
}

const VERBS = new Set(["init", "claude", "doctor", "status"]);

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
 * The only options `suite init` parses. Everything else the CLI takes is a
 * verb, deliberately: an option surface is a thing to keep compatible forever.
 */
export function parseInitOptions(args: string[]): { checkout?: string; tokenFromEnv?: string } {
  const out: { checkout?: string; tokenFromEnv?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1];
    if (args[i] === "--checkout" && next !== undefined) out.checkout = next;
    if (args[i] === "--token-from-env" && next !== undefined) out.tokenFromEnv = next;
  }
  return out;
}

export function usage(): string {
  return [
    "",
    row("suite", VERSION),
    "",
    row("init", "wire this machine to Suite"),
    row("claude", "run Claude Code in a persistent session"),
    row("claude new", "force a new session"),
    row("doctor", "diagnose a broken setup"),
    row("status", "show federation and session state"),
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
    // Everything after the verb is Claude's, verbatim: the wrapper reads no
    // options of its own here, so a user flag can never be eaten by us.
    const { args } = parse(argv);
    return runClaude(await liveClaudeDeps(), { userArgs: args, force: verb === "claude new" });
  }
  if (verb === "doctor") return runDoctor(await liveDoctorDeps());
  return runStatus(await liveDoctorDeps());
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}
