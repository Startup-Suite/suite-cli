/**
 * The cold-machine path through the rendered `bin/suite.template`.
 *
 * `suite init` exists to set up a machine that has nothing on it, and
 * install.sh prints it as the next command. A launcher that refuses to run it
 * because bun is missing makes init's own bun-detect-and-offer unreachable on
 * exactly the machine state it was written for, so the launcher special-cases
 * `init` with a POSIX bootstrap.
 *
 * Every run here has bun absent from PATH -- that is the whole point, and it
 * is why a stub `curl` and a stub `bun` stand in for the real ones. All values
 * are invented; nothing here is a real host, id or token.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLeanBin, leanPath, LEAN_TOOLS, EXCLUDED_TOOLS, MissingHostToolError } from "./tool-free-path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(REPO_ROOT, "bin", "suite.template");

let workRoot: string;

beforeAll(() => {
  workRoot = mkdtempSync(join(tmpdir(), "suite-bootstrap."));
});

afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

interface Sandbox {
  home: string;
  suite: string;
  bunInstall: string;
  stubBin: string;
  /** A curated dir of only the tools the launcher needs -- see tool-free-path.ts. */
  leanBin: string;
  installedBun: string;
}

/** Render the launcher the way install.sh does, into a scratch HOME. */
function makeSandbox(): Sandbox {
  const home = mkdtempSync(join(workRoot, "home."));
  const libDir = join(home, ".local", "share", "suite", "cli");
  const binDir = join(home, ".local", "bin");
  const stubBin = join(home, "stub-bin");
  mkdirSync(libDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stubBin, { recursive: true });
  const leanBin = buildLeanBin(join(home, "lean-bin"));

  const rendered = readFileSync(TEMPLATE, "utf8")
    .replaceAll("@SUITE_LIB_DIR@", libDir)
    .replaceAll("@SUITE_VERSION@", "0.1.0");
  const suite = join(binDir, "suite");
  writeFileSync(suite, rendered);
  chmodSync(suite, 0o755);

  const bunInstall = join(home, "bun-home");
  return { home, suite, bunInstall, stubBin, leanBin, installedBun: join(bunInstall, "bin", "bun") };
}

/**
 * A `curl` that serves a fake bun installer into the `-o` path it is given.
 * The launcher then runs that file with bash, and what it installs is a `bun`
 * that only echoes the argv it was handed.
 */
function installCurlStub(sandbox: Sandbox, { succeed = true } = {}): void {
  // The installer body the stub "downloads": it writes a bun that only echoes
  // the argv it was handed, so a successful re-exec is visible in stdout.
  const installerBody = [
    "#!/bin/sh",
    'target="${BUN_INSTALL:-$HOME/.bun}/bin"',
    'mkdir -p "$target"',
    // %% and \\$ keep the format and the argv reference literal in the file.
    'printf \'#!/bin/sh\\nprintf "stub-bun %%s\\\\n" "$*"\\n\' >"$target/bun"',
    'chmod 0755 "$target/bun"',
  ].join("\n");
  const bodyPath = join(sandbox.stubBin, "bun-installer-body.sh");
  writeFileSync(bodyPath, `${installerBody}\n`);

  const script = succeed
    ? [
        "#!/bin/sh",
        "# Stands in for `curl -fsSL https://bun.sh/install -o <file>`.",
        'out=""',
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "-o" ]; then out="$2"; shift; fi',
        "  shift",
        "done",
        `[ -n "$out" ] || exit 3`,
        // `cat >` rather than `cp`: the lean PATH carries cat and not cp, and
        // a stub that reaches for a tool the fixture excludes would fail the
        // test for a reason that has nothing to do with the launcher.
        `cat ${JSON.stringify(bodyPath)} >"$out"`,
      ].join("\n")
    : ["#!/bin/sh", "exit 22"].join("\n");
  const curl = join(sandbox.stubBin, "curl");
  writeFileSync(curl, `${script}\n`);
  chmodSync(curl, 0o755);
}

/**
 * An `unzip` that need do nothing: the launcher only asks whether it is on
 * PATH, because the bun.sh installer -- not the launcher -- is what actually
 * unzips. Its presence is the only thing under test.
 */
function installUnzipStub(sandbox: Sandbox): void {
  const unzip = join(sandbox.stubBin, "unzip");
  writeFileSync(unzip, "#!/bin/sh\nexit 0\n");
  chmodSync(unzip, 0o755);
}

function runSuite(
  sandbox: Sandbox,
  args: string[],
  stdin = "",
  { lean = false } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(sandbox.suite, args, {
    input: stdin,
    encoding: "utf8",
    env: {
      // Deliberately minimal, and deliberately WITHOUT bun: the stub dir plus
      // the system directories bash and the coreutils live in.
      PATH: lean ? leanPath(sandbox) : `${sandbox.stubBin}:/usr/bin:/bin`,
      HOME: sandbox.home,
      BUN_INSTALL: sandbox.bunInstall,
    },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("suite launcher with bun absent", () => {
  test("the sandbox really has no bun on PATH", () => {
    const sandbox = makeSandbox();
    const probe = spawnSync("sh", ["-c", "command -v bun"], {
      encoding: "utf8",
      env: { PATH: leanPath(sandbox), HOME: sandbox.home },
    });
    expect(probe.status).not.toBe(0);
    expect((probe.stdout ?? "").trim()).toBe("");
  });

  test("suite init offers the bun install, installs on yes, and re-execs the CLI", () => {
    const sandbox = makeSandbox();
    installCurlStub(sandbox);
    const r = runSuite(sandbox, ["init"], "y\n");

    // The offer is made, not assumed.
    expect(r.stderr).toContain("bun is not installed");
    expect(r.stderr.toLowerCase()).toContain("install bun now");
    // It installed into a user-writable dir, with no sudo anywhere.
    expect(existsSync(sandbox.installedBun)).toBe(true);
    // And then ran the real command instead of dying at 127.
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("stub-bun");
    expect(r.stdout).toContain("init");
  });

  test("declining installs nothing and does not pretend to have run init", () => {
    const sandbox = makeSandbox();
    installCurlStub(sandbox);
    const r = runSuite(sandbox, ["init"], "n\n");
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBe(127);
    expect(r.stderr).toContain("not installing bun");
    expect(existsSync(sandbox.installedBun)).toBe(false);
    expect(r.stdout).not.toContain("stub-bun");
  });

  test("a failing bun install is reported, not swallowed", () => {
    const sandbox = makeSandbox();
    installCurlStub(sandbox, { succeed: false });
    const r = runSuite(sandbox, ["init"], "y\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("installing bun failed");
    expect(existsSync(sandbox.installedBun)).toBe(false);
  });

  test("an already-bootstrapped bun is found again on a later run", () => {
    const sandbox = makeSandbox();
    mkdirSync(join(sandbox.bunInstall, "bin"), { recursive: true });
    writeFileSync(sandbox.installedBun, `#!/bin/sh\nprintf "stub-bun %s\\n" "$*"\n`);
    chmodSync(sandbox.installedBun, 0o755);
    // No curl stub at all: nothing may be downloaded on this path.
    const r = runSuite(sandbox, ["init"], "");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("stub-bun");
    expect(r.stderr).not.toContain("install bun now");
  });

  test("every other verb still refuses with 127 rather than bootstrapping", () => {
    const sandbox = makeSandbox();
    installCurlStub(sandbox);
    const r = runSuite(sandbox, ["doctor"], "y\n");
    expect(r.status).toBe(127);
    expect(r.stderr).toContain("bun is not installed");
    expect(existsSync(sandbox.installedBun)).toBe(false);
  });

  /**
   * One pair, deliberately: a guard that fires unconditionally would satisfy
   * the absent case on its own. Only the present case can tell "checks for
   * unzip" apart from "always refuses", so neither test means anything
   * without the other.
   */
  describe("the unzip precondition", () => {
    test("unzip absent: the tool is named, exit is 127, and nothing is half-installed", () => {
      const sandbox = makeSandbox();
      installCurlStub(sandbox);
      // No unzip stub: under the lean PATH unzip is absent by construction.
      const r = runSuite(sandbox, ["init"], "y\n", { lean: true });

      expect(r.stderr).toContain("unzip");
      expect(r.status).toBe(127);
      // Refusing after downloading, or after part-writing ~/.bun, would be a
      // worse outcome than the failure it replaces.
      expect(existsSync(sandbox.installedBun)).toBe(false);
      expect(existsSync(join(sandbox.home, ".bun"))).toBe(false);
    });

    test("unzip present: the same accepted install proceeds and re-execs", () => {
      const sandbox = makeSandbox();
      installCurlStub(sandbox);
      installUnzipStub(sandbox);
      const r = runSuite(sandbox, ["init"], "y\n", { lean: true });

      expect(r.stderr).toContain("bun installed.");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("stub-bun");
      expect(existsSync(sandbox.installedBun)).toBe(true);
    });

    test("the check stays after the offer: declining still exits 1, not 127", () => {
      const sandbox = makeSandbox();
      installCurlStub(sandbox);
      const r = runSuite(sandbox, ["init"], "n\n", { lean: true });

      expect(r.stderr).toContain("not installing bun");
      expect(r.status).toBe(1);
      expect(r.stderr).not.toContain("unzip");
      expect(existsSync(join(sandbox.home, ".bun"))).toBe(false);
    });
  });

  test("--version still answers without bun and without prompting", () => {
    const sandbox = makeSandbox();
    const r = runSuite(sandbox, ["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("0.1.0");
    expect(r.stderr).toBe("");
  });

  test("the launcher is ASCII only and never invokes sudo", () => {
    const source = readFileSync(TEMPLATE, "utf8");
    // eslint-disable-next-line no-control-regex
    expect(source).toMatch(/^[\x00-\x7F]*$/);
    expect(source).not.toMatch(/(?:^|[;&|]\s*|\bthen\s+|\bdo\s+|\bexec\s+)sudo\s/m);
  });
});

/**
 * The fixture's own anti-vacuity check. Every guard test built on top of the
 * lean PATH is only as good as this: if the dir silently lost a tool, or
 * silently kept one it was meant to exclude, those tests would pass without
 * testing anything.
 */
describe("the lean PATH fixture", () => {
  const underLeanPath = (script: string, sandbox: Sandbox) =>
    spawnSync("/bin/sh", ["-c", script], {
      encoding: "utf8",
      env: { PATH: leanPath(sandbox), HOME: sandbox.home },
    });

  test("the tools whose absence is under test are genuinely unreachable", () => {
    const sandbox = makeSandbox();
    for (const tool of EXCLUDED_TOOLS) {
      const probe = underLeanPath(`command -v ${tool}`, sandbox);
      expect({ tool, status: probe.status, stdout: (probe.stdout ?? "").trim() }).toEqual({
        tool,
        status: 1,
        stdout: "",
      });
    }
  });

  test("but the dir is lean, not broken: the needed tools all resolve and run", () => {
    const sandbox = makeSandbox();
    for (const tool of LEAN_TOOLS) {
      const probe = underLeanPath(`command -v ${tool}`, sandbox);
      expect({ tool, status: probe.status }).toEqual({ tool, status: 0 });
      expect((probe.stdout ?? "").trim()).toBe(join(sandbox.leanBin, tool));
    }
    const work = underLeanPath('d=$(mktemp -d) && printf ok >"$d/f" && cat "$d/f" && rm -rf "$d"', sandbox);
    expect(work.status).toBe(0);
    expect((work.stdout ?? "").trim()).toBe("ok");
  });

  test("a host missing a required tool throws a named error, not a half-populated dir", () => {
    const dir = join(workRoot, "lean-impossible");
    const absent = "suite-cli-tool-no-host-has-xyz";
    // `sh` resolves and is linked first, so the dir is provably mid-build when
    // the missing tool is reached -- exactly the half-populated state that must
    // surface as a throw rather than as a usable-looking dir.
    let thrown: unknown;
    try {
      buildLeanBin(dir, { tools: ["sh", absent, "cat"] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MissingHostToolError);
    expect((thrown as MissingHostToolError).tool).toBe(absent);
    expect((thrown as Error).message).toContain(absent);
    expect(existsSync(join(dir, "sh"))).toBe(true);
    expect(existsSync(join(dir, absent))).toBe(false);
    expect(existsSync(join(dir, "cat"))).toBe(false);
  });
});
