/**
 * A FIRST RUN THAT OUTLIVES THE SETTLE WINDOW STILL HAS NOTHING TO CONTINUE.
 *
 * Measured on a real host (claude 2.1.281, tmux on macOS): with
 * `--dangerously-load-development-channels`, Claude first shows an interactive
 * "Loading development channels" dialog, and the process is alive while it is
 * up. The settle check at SETTLE_MS therefore read the session as LIVE and the
 * no-`--continue` retry never fired. Once the dialog was accepted, Claude
 * printed "No conversation found to continue" and exited 1, taking the session
 * with it — after `suite claude` had already printed "started …".
 *
 * This test runs the real `runClaude` against a REAL tmux (on a private socket
 * directory, so no other session on the box is visible or touchable) with a
 * fake `claude` on PATH that models exactly that shape: alive for longer than
 * SETTLE_MS, then exit 1 when it was given `--continue`; alive indefinitely
 * when it was not.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createStore } from "../src/secrets.ts";
import { emptyConfig } from "../src/config.ts";
import { detectState, killSessionArgv, liveTmuxDeps, sessionNameFromConfig } from "../src/tmux.ts";
import { runClaude, SETTLE_MS, SESSION_DIED_EXIT, type ClaudeDeps } from "../src/commands/claude.ts";

const ROOT = mkdtempSync(resolve(tmpdir(), "suite-cli-dialog-"));
const SOCKET_DIR = resolve(ROOT, "sock");
const BIN = resolve(ROOT, "bin");
mkdirSync(SOCKET_DIR);
mkdirSync(BIN);

const ENV: Record<string, string | undefined> = {
  ...process.env,
  PATH: `${BIN}:${process.env.PATH ?? ""}`,
  TMUX_TMPDIR: SOCKET_DIR,
  TMUX: "",
};
const tmux = liveTmuxDeps(ENV);
const HAVE_TMUX = tmux.which("tmux") !== null;
const sessions = new Set<string>();

afterAll(async () => {
  for (const s of sessions) await tmux.run(killSessionArgv(s));
  rmSync(ROOT, { recursive: true, force: true });
});

/** Seconds the fake "dialog" stays up — comfortably past SETTLE_MS. */
const DIALOG_SECONDS = Math.ceil((SETTLE_MS * 2) / 1000);

/**
 * The fake claude. Records each launch's argv (one line per launch) so the
 * test can see which attempts happened, and writes `fresh` once a launch
 * without --continue is up.
 */
function writeFakeClaude(log: string, fresh: string): void {
  const path = resolve(BIN, "claude");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${log}'`,
      'for a in "$@"; do',
      '  if [ "$a" = --continue ]; then',
      `    sleep ${DIALOG_SECONDS}`,
      "    echo 'No conversation found to continue'",
      "    exit 1",
      "  fi",
      "done",
      `: > '${fresh}'`,
      // NOT exec: the process must keep the name `claude` in ps, as the real one does.
      "sleep 900",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

function depsFor(cwd: string): ClaudeDeps {
  return {
    tmux,
    env: ENV,
    cwd,
    store: createStore(),
    config: emptyConfig(),
    statePath: resolve(ROOT, "state.json"),
    color: false,
    platform: "linux",
    prompter: { ask: async () => "n", askSecret: async () => "", say: () => {} },
    out: () => {},
    err: () => {},
    // The attach is the only exec on this path; there is no terminal to give it.
    exec: async () => 0,
  };
}

test("the real-tmux dialog test below is not silently skipped", () => {
  expect(HAVE_TMUX || process.env.SUITE_CLI_ALLOW_NO_TMUX === "1").toBe(true);
});

describe.if(HAVE_TMUX)("a first run whose --continue fails AFTER the settle window", () => {
  test(
    "stays up: the pane falls back to a fresh session instead of dying",
    async () => {
      const cwd = resolve(ROOT, "agent");
      mkdirSync(cwd);
      const log = resolve(ROOT, "launches.log");
      const fresh = resolve(ROOT, "fresh");
      writeFakeClaude(log, fresh);

      const session = sessionNameFromConfig(emptyConfig(), cwd);
      sessions.add(session);

      const code = await runClaude(depsFor(cwd), { userArgs: [], force: false });
      // Alive through the settle window, so runClaude reports it started —
      // that part was never the defect.
      expect(code).not.toBe(SESSION_DIED_EXIT);

      // Past the point where the --continue attempt exits 1.
      await Bun.sleep(DIALOG_SECONDS * 1000 + 2500);

      expect(await detectState(session, tmux)).toBe("live");
      expect(existsSync(fresh)).toBe(true);
    },
    30_000,
  );
});
