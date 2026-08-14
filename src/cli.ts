#!/usr/bin/env bun
/**
 * suite — command-line tool for wiring a Claude Code runtime to Startup Suite.
 *
 * Stage 1 wires the verb dispatch only; each verb is a stub that names the
 * stage which implements it. Argument passthrough for `suite claude` is
 * deliberately total: the wrapper parses nothing beyond the verb.
 */
import { VERSION } from "./version.ts";
import { row, nextCommand } from "./ui.ts";

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

const STUBS: Record<Verb, string> = {
  init: "suite init is implemented in stage 3.",
  claude: "suite claude is implemented in stage 5.",
  "claude new": "suite claude new is implemented in stage 5.",
  doctor: "suite doctor is implemented in stage 6.",
  status: "suite status is implemented in stage 6.",
};

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

export function run(argv: string[]): number {
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
  console.log(STUBS[verb]);
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
