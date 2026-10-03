/**
 * END TO END: a real tmux, the real `runClaude`, and a fake `claude` that draws
 * Claude Code 2.1.288's recorded dialogs and does not move until it gets the
 * right key — exactly as the real one sits at its warning until someone answers.
 *
 * The fake models the measured first-run sequence in a new folder:
 *
 *   trust-folder (cursor on "No, exit") → dev-channels → with --continue,
 *   "No conversation found to continue" and exit 1 → the pane's fallback
 *   relaunches without --continue → dev-channels AGAIN → the input box.
 *
 * Any key it does not expect, or Enter on "No, exit"/"Exit", ends it — so a
 * wrong answer is a dead session here, as it would be for real.
 *
 * On 0.6.0 nothing answers, the fake waits at the trust prompt, and this fails.
 *
 * tmux runs on a private socket directory, so no other session on the box is
 * visible or touchable.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createStore } from "../src/secrets.ts";
import { emptyConfig } from "../src/config.ts";
import { detectState, killSessionArgv, liveTmuxDeps, sessionNameFromConfig } from "../src/tmux.ts";
import { runClaude, type ClaudeDeps } from "../src/commands/claude.ts";
import { liveDialogIo, sessionLogPath } from "../src/claude_dialogs.ts";

const ROOT = mkdtempSync(resolve(tmpdir(), "suite-cli-dlg-e2e-"));
const SOCKET_DIR = resolve(ROOT, "sock");
const BIN = resolve(ROOT, "bin");
const HOME = resolve(ROOT, "home");
mkdirSync(SOCKET_DIR);
mkdirSync(BIN);
mkdirSync(HOME);

const FIXTURES = resolve(import.meta.dir, "fixtures/claude-code-2.1.288-dialogs");

const ENV: Record<string, string | undefined> = {
  ...process.env,
  HOME,
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

/**
 * Plain JS (no types) so bun runs it from an extensionless file named
 * `claude` — `looksLikeAgent` then sees `.../bin/claude` in its argv, as it
 * sees the real one.
 */
function writeFakeClaude(keysLog: string, readyFile: string): void {
  const src = `#!${process.execPath}
const fs = require("node:fs");
const FIX = ${JSON.stringify(FIXTURES)};
const cwd = process.cwd();
const trusted = cwd + "/.fake-trusted";
const cont = process.argv.includes("--continue");
// Trailing blank rows dropped: the fixtures were captured in a taller pane, and
// drawing all of them into a 24-row one scrolls the dialog's top off-screen.
const read = (n) => fs.readFileSync(FIX + "/" + n + ".txt", "utf8").replaceAll("/srv/agents/work", cwd).trimEnd();
const draw = (text) => process.stdout.write("\\x1b[2J\\x1b[H" + text.replace(/\\n/g, "\\r\\n"));
const note = (s) => fs.appendFileSync(${JSON.stringify(keysLog)}, s + "\\n");
let state = fs.existsSync(trusted) ? "devch" : "trust";
let cursor = 0;
const render = () => {
  if (state === "trust") draw(read(cursor === 0 ? "trust-folder.80" : "trust-folder.80.cursor-yes"));
  else if (state === "devch") draw(read(cursor === 0 ? "dev-channels.80" : "dev-channels.80.cursor-exit"));
};
const quit = (code, why) => { note("exit:" + why); process.stdout.write("\\r\\n" + why + "\\r\\n"); process.exit(code); };
const proceed = () => {
  if (cont) quit(1, "No conversation found to continue");
  state = "ready";
  const rule = "─".repeat(78);
  draw(["", " Claude Code (fake)", "", rule, "❯ ", rule, "  ⏵⏵ bypass permissions on"].join("\\n"));
  fs.writeFileSync(${JSON.stringify(readyFile)}, "ready\\n");
};
const name = (s) => (s === "\\x1b[B" ? "Down" : s === "\\x1b[A" ? "Up" : s === "\\r" ? "Enter" : JSON.stringify(s));
process.stdin.setRawMode(true);
process.stdin.on("data", (buf) => {
  const k = name(buf.toString());
  note(state + ":" + k);
  if (state === "trust") {
    if (k === "Down") { cursor = 1; return render(); }
    if (k === "Up") { cursor = 0; return render(); }
    if (k === "Enter") { if (cursor === 0) return quit(1, "declined trust"); fs.writeFileSync(trusted, ""); state = "devch"; cursor = 0; return render(); }
    return quit(3, "unexpected key at trust");
  }
  if (state === "devch") {
    if (k === '"1"') return proceed();
    if (k === "Down") { cursor = 1; return render(); }
    if (k === "Enter") return cursor === 0 ? proceed() : quit(1, "chose Exit");
    return quit(3, "unexpected key at dev-channels");
  }
});
render();
setInterval(() => {}, 1 << 30);
`;
  const path = resolve(BIN, "claude");
  writeFileSync(path, src);
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
    dialogs: liveDialogIo(tmux, HOME, () => {}),
    // No terminal to attach in a test; the dialogs are answered regardless.
    exec: async () => 0,
  };
}

test("the real-tmux dialog test below is not silently skipped", () => {
  expect(HAVE_TMUX || process.env.SUITE_CLI_ALLOW_NO_TMUX === "1").toBe(true);
});

describe.if(HAVE_TMUX)("suite claude answers the pre-launch dialogs in its own session", () => {
  test(
    "trust, dev-channels, the --continue fallback, dev-channels again: up with nobody at the keyboard",
    async () => {
      const cwd = resolve(ROOT, "agent");
      mkdirSync(cwd);
      const keysLog = resolve(ROOT, "keys.log");
      const ready = resolve(ROOT, "ready");
      writeFakeClaude(keysLog, ready);

      const session = sessionNameFromConfig(emptyConfig(), cwd);
      sessions.add(session);

      await runClaude(depsFor(cwd), { userArgs: [], force: false });

      // runClaude waits for the poll; allow a little slack for 0.6.0, which
      // does not, so that its failure is "never got past the dialog" rather
      // than a race.
      for (let i = 0; i < 40 && !existsSync(ready); i++) await Bun.sleep(250);

      const keys = existsSync(keysLog) ? readFileSync(keysLog, "utf8").trim().split("\n") : [];
      expect(keys).toEqual([
        "trust:Down",
        "trust:Enter",
        'devch:"1"',
        "exit:No conversation found to continue",
        'devch:"1"',
      ]);
      expect(existsSync(ready)).toBe(true);
      expect(await detectState(session, tmux)).toBe("live");

      const log = readFileSync(sessionLogPath(HOME, session), "utf8");
      expect(log).toMatch(/answered trust-folder with Down\n.*answered trust-folder with Enter\n.*answered dev-channels with 1\n.*answered dev-channels with 1\n$/);
    },
    45_000,
  );
});
