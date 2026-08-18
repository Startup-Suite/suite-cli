/**
 * install.sh behaviour tests.
 *
 * Every run is against a scratch HOME with XDG_BIN_HOME / XDG_DATA_HOME
 * pointed inside it, so nothing touches the developer's machine. The
 * "download" is a real curl fetch of a file:// URL pointing at a tarball built
 * from this working tree, which exercises the same fetch/extract/stage/move
 * path the network install takes.
 *
 * All fixture values are invented. Nothing here is a real host, id or token.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_SH = join(REPO_ROOT, "install.sh");

/*
 * The version is read from the manifest rather than pinned as a literal.
 *
 * Not circularity: the property under test is that all THREE surfaces — the
 * installer's banner, the POSIX launcher it renders, and the copy it stages —
 * agree with package.json, which is the single source of truth install.sh
 * itself reads. A literal here would assert nothing extra and would red every
 * one of these tests on an ordinary version bump, which is how a pin teaches
 * people to edit tests as a matter of routine.
 */
const VERSION: string = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;

let workRoot: string;
let tarball: string;

/** Build a tarball of the working tree, laid out like a GitHub archive. */
beforeAll(() => {
  workRoot = mkdtempSync(join(tmpdir(), "suite-cli-test."));
  const stage = join(workRoot, "stage");
  const pkgDir = join(stage, "suite-cli-main");
  mkdirSync(pkgDir, { recursive: true });
  for (const entry of ["install.sh", "package.json", "src", "bin"]) {
    const cp = spawnSync("cp", ["-R", join(REPO_ROOT, entry), join(pkgDir, entry)]);
    expect(cp.status).toBe(0);
  }
  tarball = join(workRoot, "suite-cli.tar.gz");
  const tar = spawnSync("tar", ["-czf", tarball, "-C", stage, "suite-cli-main"]);
  expect(tar.status).toBe(0);
});

afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  home: string;
  dest: string;
}

function makeHome(): string {
  const home = mkdtempSync(join(workRoot, "home."));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  return home;
}

function runInstaller(
  home: string,
  opts: { url?: string; stdin?: string } = {},
): RunResult {
  const url = opts.url ?? `file://${tarball}`;
  const result = spawnSync("sh", [INSTALL_SH], {
    input: opts.stdin ?? "",
    encoding: "utf8",
    env: {
      // A deliberately minimal environment: no inherited XDG_* or PATH
      // surprises from the developer's shell.
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      XDG_BIN_HOME: join(home, ".local", "bin"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      SUITE_CLI_TARBALL_URL: url,
    },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    home,
    dest: join(home, ".local", "bin", "suite"),
  };
}

describe("install.sh", () => {
  test("installs the entrypoint into a scratch HOME and exits 0", () => {
    const r = runInstaller(makeHome());
    expect(r.status).toBe(0);
    expect(existsSync(r.dest)).toBe(true);
    expect(r.stdout).toContain(`suite ${VERSION}`);
    // The library was staged too, not just the launcher.
    expect(existsSync(join(r.home, ".local", "share", "suite", "cli", "src", "cli.ts"))).toBe(true);
    // The installed entrypoint answers --version without needing bun.
    const v = spawnSync(r.dest, ["--version"], { encoding: "utf8" });
    expect(v.status).toBe(0);
    expect(v.stdout.trim()).toBe(VERSION);
  });

  test("a second run is idempotent", () => {
    const home = makeHome();
    const first = runInstaller(home);
    expect(first.status).toBe(0);
    const second = runInstaller(home);
    expect(second.status).toBe(0);
    expect(existsSync(second.dest)).toBe(true);
    // Same version present: announced as already installed, no prompt, and the
    // result is identical.
    expect(second.stdout).toContain("already installed");
    expect(second.stdout).not.toContain("replace it");
    const a = spawnSync(first.dest, ["--version"], { encoding: "utf8" }).stdout;
    const b = spawnSync(second.dest, ["--version"], { encoding: "utf8" }).stdout;
    expect(b).toBe(a);
  });

  test("names the existing version and prompts before replacing a different suite", () => {
    const home = makeHome();
    const dest = join(home, ".local", "bin", "suite");
    // A pre-existing, different `suite` on the destination.
    writeFileSync(dest, '#!/bin/sh\nprintf "0.0.9\\n"\n');
    chmodSync(dest, 0o755);

    const declined = runInstaller(home, { stdin: "n\n" });
    expect(declined.status).toBe(0);
    expect(declined.stdout).toContain("suite 0.0.9 is already installed");
    expect(declined.stdout).toContain("replace it");
    // Declining leaves the original in place, untouched.
    expect(spawnSync(dest, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe("0.0.9");

    const accepted = runInstaller(home, { stdin: "y\n" });
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain("suite 0.0.9 is already installed");
    expect(spawnSync(dest, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe(VERSION);
  });

  test("a failed fetch leaves NO file at the destination and exits non-zero", () => {
    const home = makeHome();
    const r = runInstaller(home, {
      url: `file://${join(workRoot, "does-not-exist.tar.gz")}`,
    });
    expect(r.status).not.toBe(0);
    // The assertion that matters: absence, not merely a non-zero exit. A
    // partial file must never reach the destination.
    expect(existsSync(r.dest)).toBe(false);
    expect(existsSync(join(home, ".local", "share", "suite", "cli"))).toBe(false);
    expect(r.stderr).toContain("install failed");
  });

  test("a truncated archive also leaves NO file at the destination", () => {
    const home = makeHome();
    const partial = join(workRoot, "partial.tar.gz");
    writeFileSync(partial, " not really a tarball");
    const r = runInstaller(home, { url: `file://${partial}` });
    expect(r.status).not.toBe(0);
    expect(existsSync(r.dest)).toBe(false);
  });

  test("the final line of successful output has zero leading whitespace", () => {
    const r = runInstaller(makeHome());
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
    const last = lines[lines.length - 1] ?? "";
    expect(last).toBe("suite init");
    expect(last).toBe(last.trimStart());
  });

  test("refuses Windows by name", () => {
    // The refusal is driven through uname: a stub uname first on PATH reports
    // a Windows kernel, which is the only signal install.sh has.
    const home = makeHome();
    const stubDir = join(home, "stub-bin");
    mkdirSync(stubDir, { recursive: true });
    const stub = join(stubDir, "uname");
    writeFileSync(stub, '#!/bin/sh\nprintf "MINGW64_NT-10.0\\n"\n');
    chmodSync(stub, 0o755);
    const result = spawnSync("sh", [INSTALL_SH], {
      encoding: "utf8",
      env: {
        PATH: `${stubDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: home,
        XDG_BIN_HOME: join(home, ".local", "bin"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        SUITE_CLI_TARBALL_URL: `file://${tarball}`,
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Windows is not supported");
    expect(existsSync(join(home, ".local", "bin", "suite"))).toBe(false);
  });

  test("never invokes sudo", async () => {
    const source = await Bun.file(INSTALL_SH).text();
    // sudo appearing as a command, rather than inside the message that
    // explains we never use it.
    expect(source).not.toMatch(/(?:^|[;&|]\s*|\bthen\s+|\bdo\s+|\bexec\s+)sudo\s/m);
  });

  test("warns and prints the exact export line when the dir is not on PATH", () => {
    const r = runInstaller(makeHome());
    expect(r.stdout).toContain("is not on PATH");
    expect(r.stdout).toContain(`export PATH="${join(r.home, ".local", "bin")}:$PATH"`);
    // Even in the warning path, the next command is still the last line.
    const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
    expect(lines[lines.length - 1]).toBe("suite init");
  });
});
