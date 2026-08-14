/**
 * A curated, tool-free PATH fixture.
 *
 * Guards for missing tools cannot be tested on a machine that has the tools:
 * every dev box and both CI runners carry `/usr/bin/unzip` and often a
 * `claude`, so a test that merely runs the guarded code on the host passes
 * without ever exercising the guard. This builds *constructed absence* -- a
 * directory containing only the interpreters and utilities the launcher
 * genuinely needs, and nothing else -- so a test can assert that the guard
 * fires.
 *
 * The dir is populated by resolving each tool from the real system at
 * fixture-build time, so it works on macOS (where coreutils live in /bin and
 * /usr/bin) and on Debian alike. If a required tool is missing from the host
 * the fixture throws `MissingHostToolError` rather than producing a
 * half-populated dir: a fixture that quietly degrades makes every guard test
 * that depends on it vacuous, which is the exact failure it exists to prevent.
 *
 * Nothing here is a real host, id or token.
 */
import { mkdirSync, symlinkSync, existsSync, statSync, accessSync, constants } from "node:fs";
import { join, delimiter } from "node:path";

/**
 * The tools the rendered launcher and the test harness genuinely need: a shell
 * to run, and the utilities a POSIX bootstrap script reaches for. `printf` is
 * a shell builtin in both `sh` and `bash`, so it is not linked separately.
 */
export const LEAN_TOOLS = [
  "sh",
  "bash",
  "mktemp",
  "rm",
  "env",
  "cat",
  "chmod",
  "mkdir",
  "ln",
  "uname",
  "sed",
  "grep",
  "tr",
  "id",
] as const;

/**
 * Tools that must NOT be reachable through a lean PATH. Stubs for these are
 * installed per-test into the sandbox's stub dir when a test wants them
 * present; their absence is the thing the fixture manufactures.
 */
export const EXCLUDED_TOOLS = ["unzip", "curl", "bun", "claude"] as const;

/** Thrown when the host is missing a tool the lean dir cannot do without. */
export class MissingHostToolError extends Error {
  readonly tool: string;
  readonly searched: string[];

  constructor(tool: string, searched: string[]) {
    super(
      `MissingHostToolError: cannot build a lean PATH fixture -- required tool ${JSON.stringify(tool)} ` +
        `was not found on this host. Searched: ${searched.join(", ")}. ` +
        `Refusing to produce a half-populated lean dir, which would make guard tests pass vacuously.`,
    );
    this.name = "MissingHostToolError";
    this.tool = tool;
    this.searched = searched;
  }
}

/** Directories searched for a real system tool, in order. */
function searchDirs(): string[] {
  const fromEnv = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const wellKnown = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/sbin", "/usr/sbin"];
  const seen = new Set<string>();
  return [...wellKnown, ...fromEnv].filter((d) => !seen.has(d) && (seen.add(d), true));
}

function resolveTool(tool: string, dirs: string[]): string | null {
  for (const dir of dirs) {
    const candidate = join(dir, tool);
    try {
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not executable, or raced away between the stat and the access.
    }
  }
  return null;
}

/**
 * Populate `dir` with symlinks to exactly {@link LEAN_TOOLS}, resolved from the
 * real system. Throws {@link MissingHostToolError} on the first tool the host
 * does not provide.
 */
export function buildLeanBin(dir: string, { tools = LEAN_TOOLS as readonly string[] } = {}): string {
  mkdirSync(dir, { recursive: true });
  const dirs = searchDirs();
  for (const tool of tools) {
    const real = resolveTool(tool, dirs);
    if (real === null) throw new MissingHostToolError(tool, dirs);
    const link = join(dir, tool);
    if (!existsSync(link)) symlinkSync(real, link);
  }
  return dir;
}

/**
 * The PATH a test should use when the *absence* of a tool is the thing under
 * test: the sandbox's per-test stub dir first, then the lean dir. No
 * `/usr/bin`, so nothing the host happens to carry leaks in.
 */
export function leanPath(sandbox: { stubBin: string; leanBin: string }): string {
  return `${sandbox.stubBin}${delimiter}${sandbox.leanBin}`;
}
