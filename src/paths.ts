/**
 * Where things live on disk, and the guard that decides whether we are allowed
 * to write there at all.
 *
 * Two rules drive this module:
 *
 *  1. USER SCOPE IS THE DEFAULT. Anything we write goes under the user's
 *     config/data directories unless the caller explicitly asks otherwise.
 *  2. WE REFUSE TO WRITE INSIDE A GIT REPO unless the target is ignored.
 *     Refusal, not a warning — a warned-then-written file is a file that gets
 *     committed. `git check-ignore` is the authority: it honours nested
 *     `.gitignore` files, `.git/info/exclude` and the global excludes file,
 *     none of which hand-parsing gets right.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export type Scope = "user" | "project";

/** The default scope for every write this CLI performs. Never "project". */
export const DEFAULT_SCOPE: Scope = "user";

type Env = Record<string, string | undefined>;

function home(env: Env): string {
  const h = env.HOME;
  if (h === undefined || h === "") {
    throw new Error("HOME is not set; cannot resolve the user config directory");
  }
  return h;
}

export function configDir(env: Env = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg !== "" && isAbsolute(xdg) ? xdg : resolve(home(env), ".config");
  return resolve(base, "suite");
}

export function dataDir(env: Env = process.env): string {
  const xdg = env.XDG_DATA_HOME;
  const base = xdg !== undefined && xdg !== "" && isAbsolute(xdg) ? xdg : resolve(home(env), ".local", "share");
  return resolve(base, "suite");
}

export function configPath(env: Env = process.env): string {
  return resolve(configDir(env), "config.json");
}

export function statePath(env: Env = process.env): string {
  return resolve(configDir(env), "state.json");
}

/**
 * Raised when a write would land on a tracked path inside a git repository.
 * Carries the offending path so callers can name it without reconstructing it.
 */
export class WriteRefused extends Error {
  readonly path: string;
  /** Process exit code a caller should use. Non-zero, always. */
  readonly exitCode = 3;

  constructor(path: string, repoRoot: string) {
    super(
      [
        `refusing to write inside a git repository: ${path}`,
        `  the repository at ${repoRoot} does not ignore that path,`,
        `  so the file would be committed.`,
        `  add it to .gitignore, or write at user scope (the default).`,
      ].join("\n"),
    );
    this.name = "WriteRefused";
    this.path = path;
  }
}

export interface GitProbe {
  /** Absolute path to the work tree containing `path`, or null when there is none. */
  repoRoot(path: string): string | null;
  /** True when `git check-ignore -q <path>` succeeds, i.e. the path is ignored. */
  isIgnored(path: string): boolean;
}

/**
 * Nearest existing ancestor of `dir`. The target of a write usually does not
 * exist yet, and neither does its parent; git has to be run somewhere real, and
 * the ignore rules that matter are inherited from above regardless.
 */
function existingAncestor(dir: string): string {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function runGit(args: string[], cwd: string): { code: number; out: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: new TextDecoder().decode(p.stdout).trim() };
}

/** The real probe: shells out to git itself rather than reinterpreting its rules. */
export const gitProbe: GitProbe = {
  repoRoot(path: string): string | null {
    const cwd = existingAncestor(dirname(resolve(path)));
    const r = runGit(["rev-parse", "--show-toplevel"], cwd);
    return r.code === 0 && r.out !== "" ? r.out : null;
  },
  isIgnored(path: string): boolean {
    const abs = resolve(path);
    const r = runGit(["check-ignore", "-q", "--no-index", abs], existingAncestor(dirname(abs)));
    return r.code === 0;
  },
};

/**
 * Throw {@link WriteRefused} unless `path` is safe to write.
 *
 * Safe means: outside any git work tree, or inside one but ignored by it.
 */
export function assertWritable(path: string, probe: GitProbe = gitProbe): void {
  const abs = resolve(path);
  const root = probe.repoRoot(abs);
  if (root === null) return;
  if (probe.isIgnored(abs)) return;
  throw new WriteRefused(abs, root);
}
