/**
 * THE PERSISTENCE PROOF — the load-bearing test of this repository.
 *
 * The claim `suite claude` makes is not "a tmux session exists". It is: WHEN
 * THE TERMINAL THAT STARTED THE AGENT GOES AWAY, THE AGENT KEEPS RUNNING. A
 * test that starts a session and re-attaches from the same shell proves
 * nothing about that — the parent was alive the whole time. Neither does
 * `Ctrl-b d`: a detach is a cooperative gesture from a process that is still
 * running, which is the opposite of the event being claimed.
 *
 * So this harness actually severs the parent:
 *
 *   1. Start the agent by running the SHIPPED cli from a CHILD SHELL.
 *   2. Record the pid of the process running inside the tmux pane.
 *   3. KILL THAT PARENT SHELL — SIGHUP, as closing a terminal delivers, then
 *      SIGKILL if it is somehow still there. Not a detach.
 *   4. From a NEW shell, prove THE SAME PID is still running, and that
 *      `suite claude` re-attaches to that same session rather than starting a
 *      second agent.
 *
 * HYGIENE, and it is not optional on a shared box:
 *   * A PRIVATE `$TMUX_TMPDIR`, so nothing here can list, touch or kill another
 *     agent's session. Cleanup is `kill-session -t <name>` for names this file
 *     created — NEVER `kill-server`, never a pattern kill.
 *   * Every signal is sent to a NUMERIC PID THIS HARNESS SPAWNED and recorded.
 *     Nothing is killed by name, by pattern, or by `pkill`. Killing a parent
 *     shell is inherently the risky part of this test, so the target pid is
 *     re-checked with `ps -p` before the signal.
 *
 * HONEST LIMIT: the agent is a long-lived stub named `claude`, not Claude Code
 * — the test needs no credentials and finishes in seconds. What is under test
 * is the PROCESS TOPOLOGY (does the pane process outlive the shell that
 * launched it), which does not depend on what the pane process is.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { emptyConfig } from "../../src/config.ts";
import { detectState, killSessionArgv, liveTmuxDeps, sessionNameFromConfig, TMUX } from "../../src/tmux.ts";

const CLI = resolve(import.meta.dir, "..", "..", "src", "cli.ts");
const SOCKET_DIR = mkdtempSync(resolve(tmpdir(), "suite-persist-sock-"));
/**
 * REAL path, deliberately. The session name is a hash of the working
 * directory, and a child process reports `process.cwd()` fully resolved — on
 * macOS `/var/folders/…` is a symlink to `/private/var/folders/…`, so a
 * fixture that kept the unresolved form would compute a different name than
 * the cli does and the test would look for a session that exists under
 * another name.
 */
const ROOT = realpathSync(mkdtempSync(resolve(tmpdir(), "suite-persist-")));

/** A PATH that finds tmux and /bin/sh, with our stub `claude` shadowing any real one. */
const STUB_BIN = resolve(ROOT, "bin");
const SYSTEM_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

mkdirSync(STUB_BIN, { recursive: true });

const ENV: Record<string, string> = {
  PATH: `${STUB_BIN}:${SYSTEM_PATH}`,
  HOME: resolve(ROOT, "home"),
  XDG_CONFIG_HOME: resolve(ROOT, "home/.config"),
  XDG_DATA_HOME: resolve(ROOT, "home/.local/share"),
  // A private server socket: this harness cannot see, and cannot kill, any
  // session belonging to anyone else on this machine.
  TMUX_TMPDIR: SOCKET_DIR,
  // Explicitly NOT inside tmux, so the nesting branch is not taken.
  TMUX: "",
  TERM: "xterm-256color",
  NO_COLOR: "1",
};
mkdirSync(ENV.HOME as string, { recursive: true });

const tmuxDeps = liveTmuxDeps(ENV);
const HAVE_TMUX = tmuxDeps.which(TMUX) !== null;

/** Session names this file created, and therefore the only ones it may kill. */
const created = new Set<string>();
/** Pids this harness spawned, and therefore the only ones it may signal. */
const spawned = new Set<number>();

/**
 * The stand-in agent: an executable literally named `claude` that ignores every
 * argument and stays alive. It records its own pid so the harness never has to
 * guess which process it is looking at.
 */
function installAgentStub(): void {
  const path = resolve(STUB_BIN, "claude");
  writeFileSync(
    path,
    // NOT `exec sleep`: the process that stays in the pane must still be
    // named `claude` on its command line, because that is what detection
    // matches — replacing itself with `sleep` would make a live agent read as
    // STALE and the test would be measuring the stub, not the feature.
    ["#!/bin/sh", `echo $$ > "${resolve(ROOT, "agent.pid")}"`, "sleep 900", ""].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
}
installAgentStub();

function running(pid: number): boolean {
  // `kill -0` asks the kernel whether the pid exists and is signalable. It
  // sends no signal.
  return Bun.spawnSync(["kill", "-0", String(pid)], { stderr: "ignore" }).exitCode === 0;
}

/** `ps` identity of a pid, or null. Used to CHECK a target before signalling it. */
function identify(pid: number): { ppid: number; comm: string } | null {
  const p = Bun.spawnSync(["ps", "-o", "ppid=,comm=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const line = new TextDecoder().decode(p.stdout).trim();
  if (p.exitCode !== 0 || line === "") return null;
  const [ppid, ...rest] = line.split(/\s+/);
  return { ppid: Number(ppid), comm: rest.join(" ") };
}

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > deadline) return v;
    await Bun.sleep(100);
  }
}

/** The pid of the process running inside the pane of `session`. */
async function panePid(session: string): Promise<number | null> {
  const r = await tmuxDeps.run([TMUX, "list-panes", "-t", session, "-F", "#{pane_pid}"]);
  if (r.exitCode !== 0) return null;
  const first = r.stdout.trim().split("\n")[0]?.trim() ?? "";
  return /^\d+$/.test(first) ? Number(first) : null;
}

/**
 * Signal one pid this harness spawned, having first confirmed with `ps` that
 * the pid is the shell we started. Never a name, never a pattern.
 */
function severParent(pid: number): void {
  expect(spawned.has(pid)).toBe(true);
  const id = identify(pid);
  expect(id).not.toBeNull();
  // The shell we started, not a recycled pid belonging to something else.
  expect(["sh", "-sh", "dash", "bash"]).toContain((id as { comm: string }).comm.replace(/^.*\//, ""));
  // SIGHUP is what a closing terminal delivers; SIGKILL is the backstop so the
  // test cannot pass merely because the parent was still alive.
  Bun.spawnSync(["kill", "-HUP", String(pid)], { stderr: "ignore" });
}

afterAll(async () => {
  for (const name of created) await tmuxDeps.run(killSessionArgv(name));
  for (const pid of spawned) if (running(pid)) Bun.spawnSync(["kill", "-9", String(pid)], { stderr: "ignore" });
  rmSync(SOCKET_DIR, { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * A skipped persistence suite is a green run that proves nothing about the one
 * claim this whole repository exists to make. `describe.if` would hide that, so
 * a missing tmux FAILS here unless a reader deliberately opts out — and CI
 * installs a real tmux precisely so it never has to.
 */
test("the persistence tests below are not silently skipped", () => {
  expect(HAVE_TMUX || process.env.SUITE_CLI_ALLOW_NO_TMUX === "1").toBe(true);
});

describe.if(HAVE_TMUX)("the agent outlives the shell that started it", () => {
  test(
    "kill the parent shell, and from a new shell the SAME pid is still running",
    async () => {
      const project = resolve(ROOT, "ledger");
      mkdirSync(project, { recursive: true });
      const session = sessionNameFromConfig(emptyConfig(), project);
      created.add(session);
      rmSync(resolve(ROOT, "agent.pid"), { force: true });

      /* 1. START FROM A CHILD SHELL -------------------------------------- */
      // The shell is NOT `exec`d away: it stays alive as a real parent, so
      // killing it later is killing a live terminal rather than reaping a
      // corpse. The cli's attach exits immediately here (no TTY on a pipe),
      // which is fine — the session is created before the attach is tried.
      const parent = Bun.spawn(
        ["/bin/sh", "-c", `"${process.execPath}" "${CLI}" claude; sleep 600`],
        { cwd: project, env: ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      spawned.add(parent.pid);

      /* 2. RECORD THE PID INSIDE THE PANE -------------------------------- */
      const state = await until(() => detectState(session, tmuxDeps), (s) => s === "live", 30_000);
      expect(state).toBe("live");

      const pid = await until(() => panePid(session), (p) => p !== null);
      expect(pid).not.toBeNull();
      const agent = pid as number;
      expect(running(agent)).toBe(true);

      // The pane process is NOT a child of our shell: tmux daemonised the
      // server, and that reparenting is the mechanism the feature relies on.
      // Asserting it here means a regression that made the agent a plain child
      // of the caller fails at the cause rather than in the timing below.
      const before = identify(agent);
      expect(before).not.toBeNull();
      expect((before as { ppid: number }).ppid).not.toBe(parent.pid);

      /* 3. SEVER THE PARENT ---------------------------------------------- */
      severParent(parent.pid);
      const gone = await until(() => !running(parent.pid), (v) => v, 15_000);
      if (!gone) {
        Bun.spawnSync(["kill", "-9", String(parent.pid)], { stderr: "ignore" });
        await until(() => !running(parent.pid), (v) => v, 10_000);
      }
      // Anti-vacuity: if the parent were still alive this test would prove
      // nothing at all, so its death is asserted rather than assumed.
      expect(running(parent.pid)).toBe(false);

      /* 4. FROM A NEW SHELL --------------------------------------------- */
      // A genuinely separate process, with no relationship to the dead one.
      const probe = Bun.spawnSync(
        ["/bin/sh", "-c", `kill -0 ${agent} && ps -o pid= -p ${agent}`],
        { env: ENV, stdout: "pipe", stderr: "ignore" },
      );
      expect(probe.exitCode).toBe(0);
      expect(new TextDecoder().decode(probe.stdout).trim()).toBe(String(agent));

      // THE CLAIM, stated as one assertion: same pid, still alive, parent dead.
      expect(await detectState(session, tmuxDeps)).toBe("live");
      expect(await panePid(session)).toBe(agent);

      // ...and `suite claude` from a NEW shell re-attaches to that session
      // rather than starting a second agent.
      const reattach = Bun.spawnSync(
        ["/bin/sh", "-c", `"${process.execPath}" "${CLI}" claude`],
        { cwd: project, env: ENV, stdout: "pipe", stderr: "pipe" },
      );
      const said = new TextDecoder().decode(reattach.stdout);
      expect(said).toContain(`attaching to ${session}`);
      expect(said).not.toContain("started ");
      expect(await panePid(session)).toBe(agent);

      /* 5. DIRECTION CONTROL --------------------------------------------- */
      // The probe above must be capable of reporting death, or "still running"
      // is a result it would give for anything. Kill the agent — by the pid we
      // recorded, nothing else — and watch the same probe flip.
      expect(Bun.spawnSync(["kill", "-9", String(agent)]).exitCode).toBe(0);
      const died = await until(() => !running(agent), (v) => v, 10_000);
      expect(died).toBe(true);
      expect(Bun.spawnSync(["/bin/sh", "-c", `kill -0 ${agent}`], { stderr: "ignore" }).exitCode).not.toBe(0);

      await tmuxDeps.run(killSessionArgv(session));
      created.delete(session);
    },
    120_000,
  );

  test(
    "a detach is NOT what is being tested — the pane pid survives a signal-free parent exit too",
    async () => {
      // The weaker shape, kept only to show the harness distinguishes them: a
      // parent that exits on its own (no signal, no detach keystroke) also
      // leaves the agent running. It is asserted second, and it is not the
      // proof — the test above is, because it kills a LIVE parent.
      const project = resolve(ROOT, "invoices");
      mkdirSync(project, { recursive: true });
      const session = sessionNameFromConfig(emptyConfig(), project);
      created.add(session);

      const parent = Bun.spawn(["/bin/sh", "-c", `"${process.execPath}" "${CLI}" claude`], {
        cwd: project,
        env: ENV,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      spawned.add(parent.pid);
      await parent.exited;
      expect(running(parent.pid)).toBe(false);

      const pid = await until(() => panePid(session), (p) => p !== null, 30_000);
      expect(pid).not.toBeNull();
      expect(running(pid as number)).toBe(true);
      expect(await detectState(session, tmuxDeps)).toBe("live");

      await tmuxDeps.run(killSessionArgv(session));
      created.delete(session);
    },
    120_000,
  );
});
