/**
 * `suite update` — replace this install with the latest published CLI.
 *
 * ONE INSTALL PATH, NOT TWO. Update re-runs `install.sh`, the same script the
 * cold-start `curl … | sh` runs. It does not fetch a tarball, stage a lib dir
 * or render the launcher itself. A second install mechanism is a second thing
 * to keep true — and the half that drifts is always the one nobody runs on a
 * fresh machine. Everything install.sh already guarantees (staged then moved
 * into place, never a partial file at the destination, no sudo, the previous
 * version named before it is replaced) is inherited rather than reimplemented.
 *
 * THE REF IS PASSED, NOT ASSUMED. `install.sh` resolves what to install from
 * `SUITE_CLI_REF`, which DEFAULTS TO `main` — it does not infer anything from
 * the URL it was itself downloaded from. So fetching the installer from a tag
 * and failing to export the ref installs `main` while appearing to honour the
 * tag: a wrong result that looks exactly like a right one. Both halves are set
 * from the same value here, deliberately, and {@link updateArgv} is exported so
 * that pairing can be asserted directly.
 */
import { VERSION } from "../version.ts";

export const REPO = "Startup-Suite/suite-cli";

/** What `install.sh` itself defaults to when SUITE_CLI_REF is unset. */
export const DEFAULT_REF = "main";

/** Exit code when we refuse to run: preconditions missing, or a bad ref. */
export const UPDATE_REFUSED_EXIT = 5;

/**
 * The installer needs one of these to fetch, and `tar` to unpack. Named here
 * so a missing tool is reported as the missing tool, rather than as whatever
 * obscure noise a broken pipe makes three commands later.
 */
export const FETCHERS = ["curl", "wget"] as const;
export type Fetcher = (typeof FETCHERS)[number];
export const REQUIRED_TOOLS = ["tar", "sh"] as const;

/**
 * Refs we are willing to interpolate into a shell command.
 *
 * The ref reaches `sh -c`, so it is the one attacker-shaped input on this path.
 * Git's own rules are wider than this; the narrow set is the point. A ref
 * outside it is REFUSED and named, never quoted-and-hoped — quoting is a thing
 * you get subtly wrong once and never notice.
 */
const SAFE_REF = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

export function refIsSafe(ref: string): boolean {
  // `..` would let a ref climb out of the URL path it is pasted into.
  return ref.length > 0 && ref.length <= 200 && SAFE_REF.test(ref) && !ref.includes("..");
}

/** Where the installer for `ref` lives. */
export function installerUrl(ref: string): string {
  return `https://raw.githubusercontent.com/${REPO}/${ref}/install.sh`;
}

/**
 * The exact argv that performs the update.
 *
 * `SUITE_CLI_REF` is exported into the installer's environment AND used to
 * build its URL, from the same argument — see the module note. Pure and
 * exported so a test can pin both halves without running an install.
 */
export function updateArgv(ref: string, fetcher: Fetcher = "curl"): string[] {
  const download = fetcher === "curl" ? `curl -fsSL '${installerUrl(ref)}'` : `wget -qO- '${installerUrl(ref)}'`;
  return ["sh", "-c", `${download} | SUITE_CLI_REF='${ref}' sh`];
}

/** The ref to install: explicit override, else the published default. */
export function resolveRef(env: Record<string, string | undefined>): string {
  const ref = env.SUITE_CLI_REF;
  return ref === undefined || ref === "" ? DEFAULT_REF : ref;
}

export interface UpdateDeps {
  out(line: string): void;
  err(line: string): void;
  /** Absolute path of a tool on PATH, or null. */
  which(name: string): string | null;
  /** Runs argv attached to the caller's terminal; resolves with its exit code. */
  exec(argv: string[]): Promise<number>;
  env: Record<string, string | undefined>;
}

/**
 * The lines printed before anything runs.
 *
 * NOTHING SILENT, the same rule `suite claude` carries: a command that is about
 * to fetch a remote script and pipe it into a shell says so, and names the URL,
 * BEFORE it does it. A non-default ref is called out too — updating to a branch
 * and not being told is how you end up debugging the wrong build.
 */
export function announceLines(ref: string): string[] {
  const suffix = ref === DEFAULT_REF ? "" : ` (ref ${ref})`;
  return [`updating suite ${VERSION}${suffix} — running the installer from ${installerUrl(ref)}`, ""];
}

export async function runUpdate(deps: UpdateDeps): Promise<number> {
  const ref = resolveRef(deps.env);

  if (!refIsSafe(ref)) {
    deps.err(`suite: refusing to update from SUITE_CLI_REF="${ref}" — not a plain branch, tag or commit.`);
    return UPDATE_REFUSED_EXIT;
  }

  // Preconditions BEFORE the announcement: telling somebody what you are about
  // to do and then not doing it is worse than refusing up front.
  const fetcher = FETCHERS.find((tool) => deps.which(tool) !== null);
  if (fetcher === undefined) {
    deps.err(`suite: update needs ${FETCHERS.join(" or ")} to download the installer, and neither is on PATH.`);
    return UPDATE_REFUSED_EXIT;
  }
  const missing = REQUIRED_TOOLS.filter((tool) => deps.which(tool) === null);
  if (missing.length > 0) {
    deps.err(`suite: update needs ${missing.join(" and ")}, not on PATH.`);
    return UPDATE_REFUSED_EXIT;
  }

  for (const line of announceLines(ref)) deps.out(line);

  // The installer owns the outcome from here, including its own "replace
  // 0.1.0 with 0.2.0? [y/N]" prompt. It is NOT auto-answered: an update that
  // silently overwrites is the thing the prompt exists to prevent, and it
  // inherits the terminal, so the user answers it directly.
  return deps.exec(updateArgv(ref, fetcher));
}

export function liveUpdateDeps(): UpdateDeps {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    which: (name) => Bun.which(name),
    exec: async (argv) => {
      const proc = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      return proc.exited;
    },
    env: process.env,
  };
}
