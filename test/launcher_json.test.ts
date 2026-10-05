/**
 * The POSIX launcher for machine callers (task 01a0d6b9 stage 1).
 *
 * With bun absent and `--json` among the args, `bin/suite.template` must print
 * ONE document — the `suite init --json` shape, blocked (exit 3) on one human
 * step, install_bun — and must NEVER prompt: no read of stdin, no read of
 * /dev/tty. `--install-bun` is the explicit consent that runs the official
 * bootstrap without a prompt.
 *
 * "Never reads /dev/tty" is shown under a REAL pseudo-terminal (`script`),
 * where the prompt path WOULD read it: the positive control runs the same
 * launcher without --json on the same pty with "y" typed, and it installs.
 * The same keystroke under --json installs nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INIT_RESULT_FIELDS } from "../src/commands/init_ref.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(REPO_ROOT, "bin", "suite.template");

let workRoot: string;
beforeAll(() => {
  workRoot = mkdtempSync(join(tmpdir(), `suite-launcher-json-01a0d6b9-${process.pid}-`));
});
afterAll(() => rmSync(workRoot, { recursive: true, force: true }));

interface Sandbox {
  home: string;
  suite: string;
  stubBin: string;
  bunInstall: string;
  installedBun: string;
}

function sandbox(): Sandbox {
  const home = mkdtempSync(join(workRoot, "home."));
  const libDir = join(home, ".local", "share", "suite", "cli");
  const binDir = join(home, ".local", "bin");
  const stubBin = join(home, "stub-bin");
  for (const d of [libDir, binDir, stubBin]) mkdirSync(d, { recursive: true });
  const suite = join(binDir, "suite");
  writeFileSync(suite, readFileSync(TEMPLATE, "utf8").replaceAll("@SUITE_LIB_DIR@", libDir).replaceAll("@SUITE_VERSION@", "9.9.9-fixture"));
  chmodSync(suite, 0o755);
  const bunInstall = join(home, "bun-home");
  // curl + unzip stubs: "downloading" writes an installer that drops a bun
  // which echoes its argv. The installer also chatters on STDOUT, as the real
  // one does, so a leak into the launcher's stdout would be visible.
  const installer = join(stubBin, "bun-installer-body.sh");
  writeFileSync(
    installer,
    [
      "#!/bin/sh",
      "echo 'installer chatter on stdout'",
      'target="${BUN_INSTALL:-$HOME/.bun}/bin"',
      'mkdir -p "$target"',
      'printf \'#!/bin/sh\\nprintf "stub-bun %%s\\\\n" "$*"\\n\' >"$target/bun"',
      'chmod 0755 "$target/bun"',
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(stubBin, "curl"),
    ["#!/bin/sh", 'out=""', 'while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done', `cat ${JSON.stringify(installer)} >"$out"`].join("\n") + "\n",
  );
  writeFileSync(join(stubBin, "unzip"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(stubBin, "curl"), 0o755);
  chmodSync(join(stubBin, "unzip"), 0o755);
  return { home, suite, stubBin, bunInstall, installedBun: join(bunInstall, "bin", "bun") };
}

function envFor(s: Sandbox): Record<string, string> {
  return { PATH: `${s.stubBin}:/usr/bin:/bin`, HOME: s.home, BUN_INSTALL: s.bunInstall };
}

function run(s: Sandbox, args: string[], stdin = "y\n") {
  const r = spawnSync(s.suite, args, { input: stdin, encoding: "utf8", env: envFor(s) });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * A real pseudo-terminal: the child's stdin, stdout, stderr AND controlling
 * terminal (/dev/tty) are the pty, and `typed` is already waiting on it. This
 * is python3's pty.fork, because script(1) is not on every host (moon has none).
 */
const PTY_RUNNER = [
  "import os, pty, sys",
  "pid, fd = pty.fork()",
  "if pid == 0:",
  "    os.execv(sys.argv[1], sys.argv[1:])",
  "os.write(fd, sys.stdin.buffer.read())",
  "out = b''",
  "while True:",
  "    try:",
  "        data = os.read(fd, 4096)",
  "    except OSError:",
  "        break",
  "    if not data:",
  "        break",
  "    out += data",
  "sys.stdout.buffer.write(out)",
  "_, st = os.waitpid(pid, 0)",
  "sys.exit(os.WEXITSTATUS(st) if os.WIFEXITED(st) else 1)",
].join("\n");

function runUnderPty(s: Sandbox, args: string[], typed: string) {
  const r = spawnSync("python3", ["-c", PTY_RUNNER, s.suite, ...args], {
    input: typed,
    encoding: "utf8",
    env: envFor(s),
    timeout: 20_000,
  });
  if (r.error !== undefined) throw new Error(`python3 pty runner could not run here: ${r.error.message}`);
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.replaceAll("\r", "") };
}

describe("bun absent, --json", () => {
  test("the sandbox has no bun", () => {
    const s = sandbox();
    expect(spawnSync("sh", ["-c", "command -v bun"], { env: envFor(s) }).status).not.toBe(0);
  });

  test("init --json prints ONE init-shaped document, exit 3, install_bun with the official command and URL", () => {
    const s = sandbox();
    const r = run(s, ["init", "--json", "--suite-url", "https://suite.example.invalid", "--runtime-id", "r", "--token-ref", "keychain:x"]);
    expect(r.status).toBe(3);
    const doc = JSON.parse(r.stdout);
    expect(Object.keys(doc)).toEqual([...INIT_RESULT_FIELDS]);
    expect(doc.ok).toBe(false);
    expect(doc.error.code).toBe("bun_missing");
    expect(doc.deps.bun).toEqual({ present: false, version: null, path: null });
    expect(doc.human_steps).toEqual([
      {
        kind: "install_bun",
        text: expect.any(String),
        command: "curl -fsSL https://bun.sh/install | bash",
        url: "https://bun.sh/docs/installation",
      },
    ]);
    // Nothing was installed, and the "y" waiting on stdin was not taken as consent.
    expect(existsSync(s.installedBun)).toBe(false);
    expect(r.stderr).not.toContain("[y/N]");
  });

  test("`suite secret` is a machine verb: the same document without --json", () => {
    const s = sandbox();
    const r = run(s, ["secret", "put", "--keychain-service", "svc", "--item", "i"]);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout).human_steps[0].kind).toBe("install_bun");
  });

  test("never reads /dev/tty: under a real pty with 'y' typed, --json installs nothing", () => {
    const s = sandbox();
    const r = runUnderPty(s, ["init", "--json"], "y\n");
    expect(r.out).toContain('"install_bun"');
    expect(r.out).not.toContain("[y/N]");
    expect(existsSync(s.installedBun)).toBe(false);
  });

  test("positive control: the same pty and keystroke WITHOUT --json does reach the prompt and install", () => {
    const s = sandbox();
    const r = runUnderPty(s, ["init"], "y\n");
    expect(r.out).toContain("[y/N]");
    expect(existsSync(s.installedBun)).toBe(true);
  });
});

describe("--install-bun", () => {
  test("runs the official bootstrap with no prompt, keeps stdout for the CLI, then execs it", () => {
    const s = sandbox();
    const r = run(s, ["init", "--install-bun", "--json"], "");
    expect(r.status).toBe(0);
    expect(existsSync(s.installedBun)).toBe(true);
    expect(r.stderr).not.toContain("[y/N]");
    // The installer's chatter went to stderr; stdout is only what the CLI printed.
    expect(r.stdout.trim()).toBe("stub-bun " + [join(s.home, ".local", "share", "suite", "cli", "src", "cli.ts"), "init", "--install-bun", "--json"].join(" "));
    expect(r.stderr).toContain("installer chatter on stdout");
  });

  test("with --json, a bootstrap that cannot run still answers with the document (exit 3)", () => {
    const s = sandbox();
    rmSync(join(s.stubBin, "unzip"));
    // unzip absent on a lean PATH: only the stub dir and a few system dirs that lack it.
    const lean = mkdtempSync(join(workRoot, "lean."));
    for (const tool of ["sh", "bash", "cat", "mkdir", "chmod", "rm", "mktemp", "uname"]) {
      const p = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      if (p !== "") spawnSync("ln", ["-s", p, join(lean, tool)]);
    }
    const r = spawnSync(s.suite, ["init", "--install-bun", "--json"], {
      input: "",
      encoding: "utf8",
      env: { PATH: `${s.stubBin}:${lean}`, HOME: s.home, BUN_INSTALL: s.bunInstall },
    });
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout ?? "").error.code).toBe("bun_missing");
    expect(r.stderr).toContain("unzip");
    expect(existsSync(s.installedBun)).toBe(false);
  });
});
