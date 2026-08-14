/**
 * A CLEAN ENVIRONMENT — one scratch machine per test.
 *
 * WHY THIS EXISTS. On any box a developer or CI runner actually uses, `bun`,
 * `tmux`, the channel plugin checkout and both MCP entries usually already
 * exist. An `init` or `doctor` run there passes without executing a single
 * install path and without ever seeing a missing dependency: a green result
 * that proves only that the code can do nothing. So the behavioural tests run
 * against a fixture that gives them their own `HOME`, `XDG_CONFIG_HOME`,
 * `XDG_DATA_HOME` and a `PATH` containing NOTHING but the stubs the test asks
 * for. Anything the test does not name is absent for real.
 *
 * WHAT THIS CANNOT PROVE — read this before treating a green suite as a
 * cold-start proof. Stage 3 flagged it and it is carried here rather than
 * quietly dropped:
 *
 *   * A scratch `HOME` CANNOT prove a real `bun` install on a machine that
 *     never had bun. The `bun` on `PATH` here is a shell script that prints a
 *     version; nothing downloads, unpacks or links anything.
 *   * A scratch `HOME` CANNOT prove a real network clone of the plugin. The
 *     `git` stub creates the directory layout a clone would leave behind; no
 *     socket is opened, no ref is negotiated, no `bun install` resolves a
 *     registry.
 *
 * What the fixture DOES prove is that the code TAKES those paths, in the right
 * order, with the right arguments, cwd and scope, on a machine where the tool
 * is genuinely not installed — which is the part that regresses. A real cold
 * start needs a container or a genuinely fresh machine, and is out of scope for
 * a unit suite. Tests that rely on a stub for something real are marked with
 * {@link STUBBED_NOT_PROVEN} so nobody reads them as more than they are.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * Marker for a test whose green result depends on a stub standing in for
 * something real (a network clone, a package install, an OS package manager).
 * Grep for it before citing the suite as evidence of a cold start.
 */
export const STUBBED_NOT_PROVEN = "STUBBED — not proof of a real install/clone";

export interface CleanEnvOptions {
  /** Executable name → `sh` body. Anything not listed is not on PATH at all. */
  bodies?: Record<string, string>;
  /** Extra environment entries. Merged after the scratch HOME/XDG/PATH. */
  env?: Record<string, string | undefined>;
  /** Prefix for the scratch directory name, to make failures readable. */
  label?: string;
}

export interface CleanEnv {
  /** The scratch root. Everything the test writes lives under it. */
  root: string;
  /** The ONLY directory on the fixture's PATH. */
  bin: string;
  /** The scratch HOME. */
  home: string;
  /** A complete environment: PATH of stubs only, scratch HOME and XDG dirs. */
  env: Record<string, string | undefined>;
  /** Add another stub after construction. */
  stub(name: string, body: string): void;
  /** Every stub invocation, tab-separated: `name\targ\targ…`. */
  log(): string[];
  /** Where a clone would land under this HOME, by the CLI's own default. */
  checkout: string;
}

const roots: string[] = [];

function writeStub(bin: string, name: string, body: string): void {
  const path = resolve(bin, name);
  writeFileSync(
    path,
    `#!/bin/sh\n` +
      // The fixture's PATH is scrubbed on purpose; a stub still needs coreutils
      // to impersonate the tool it stands in for. This line restores them for
      // the STUB ONLY — the code under test still sees the scrubbed PATH.
      `PATH=/bin:/usr/bin:$PATH\n` +
      `if [ -n "$STUB_LOG" ]; then\n` +
      `  { printf '%s' "${name}"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "$STUB_LOG"\n` +
      `fi\n` +
      `${body}\n`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
}

/**
 * Build one scratch machine. Call {@link cleanupCleanEnvs} from `afterEach`.
 */
export function createCleanEnv(options: CleanEnvOptions = {}): CleanEnv {
  const root = mkdtempSync(resolve(tmpdir(), `suite-${options.label ?? "clean"}-`));
  roots.push(root);
  const bin = resolve(root, "bin");
  const home = resolve(root, "home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  const logFile = resolve(root, "invocations.log");
  writeFileSync(logFile, "");

  for (const [name, body] of Object.entries(options.bodies ?? {})) writeStub(bin, name, body);

  const env: Record<string, string | undefined> = {
    // PATH is the stub directory and NOTHING else: a tool the test did not ask
    // for is not merely shadowed, it is unfindable.
    PATH: bin,
    HOME: home,
    XDG_CONFIG_HOME: resolve(home, ".config"),
    XDG_DATA_HOME: resolve(home, ".local/share"),
    STUB_LOG: logFile,
    ...(options.env ?? {}),
  };

  return {
    root,
    bin,
    home,
    env,
    checkout: resolve(home, ".local/share/suite/claude-code-suite-channel"),
    stub: (name, body) => writeStub(bin, name, body),
    log: () =>
      readFileSync(logFile, "utf8")
        .split("\n")
        .filter((l) => l !== ""),
  };
}

/** Remove every scratch machine built so far. Safe to call repeatedly. */
export function cleanupCleanEnvs(): void {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

/* ------------------------------------------------------------------------- */
/* Stub bodies shared by the init and doctor suites                           */
/* ------------------------------------------------------------------------- */

/**
 * The default impersonations.
 *
 * `git` and `bun` here are exactly the two {@link STUBBED_NOT_PROVEN} cases:
 * `git clone` creates the directory a clone would have left, and `bun install`
 * prints the line a real install would have printed. Neither touches a network.
 */
export const DEFAULT_STUBS: Record<string, string> = {
  git:
    `if [ "$1" = "clone" ]; then mkdir -p "$3/.git" "$3/src"; : > "$3/src/index.ts"; exit 0; fi\n` +
    `if [ "$1" = "pull" ]; then\n` +
    `  if [ -n "$STUB_PULL_FAILS" ]; then echo "fatal: Not possible to fast-forward, aborting." >&2; exit 128; fi\n` +
    `  exit 0\nfi\nexit 0`,
  bun:
    `if [ "$1" = "--version" ]; then echo "1.2.4"; exit 0; fi\n` +
    `if [ "$1" = "install" ]; then echo "4 packages installed [12.00ms]"; exit 0; fi\nexit 0`,
  claude: `if [ "$1" = "mcp" ] && [ "$2" = "list" ]; then cat "$STUB_MCP_LIST"; fi\nexit 0`,
  tmux: `if [ "$1" = "-V" ]; then echo "tmux 3.5a"; exit 0; fi\nexit 0`,
  brew: `exit 0`,
  "apt-get": `exit 0`,
};

/** Pick a subset of {@link DEFAULT_STUBS} by name. Unknown names are no-ops. */
export function stubsFor(tools: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tools) out[t] = DEFAULT_STUBS[t] ?? "exit 0";
  return out;
}
