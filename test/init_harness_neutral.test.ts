/**
 * `suite init` is HARNESS-NEUTRAL: it connects this machine to an install and
 * nothing else. The bug this pins: on a fresh Mac without Claude Code, init died
 * at `claude mcp add` with `ENOENT: claude` — and a DeepSeek-only machine would
 * have hit the same crash.
 *
 * Every value here is invented.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runInit, type InitDeps } from "../src/commands/init.ts";
import { createStore, spawnWithSecrets, type Prompter } from "../src/secrets.ts";
import { cleanupCleanEnvs, createCleanEnv, stubsFor } from "./clean-env/fixture.ts";

const SUITE_URL = "https://suite.example.invalid";
const RUNTIME_ID = "runtime_00000000-0000-0000-0000-000000000000";
const TOKEN = "tok_fixture_0000000000000000000000000000";

afterEach(cleanupCleanEnvs);

function prompter(answers: string[]): Prompter {
  const q = [...answers];
  return { ask: async () => q.shift() ?? "", askSecret: async () => q.shift() ?? "", say: () => {} };
}

test("init succeeds on a machine with NO claude on PATH, and never invokes one", async () => {
  const fx = createCleanEnv({ label: "neutral", bodies: stubsFor(["git", "bun", "tmux"]) });
  const store = createStore();
  const lines: string[] = [];
  const deps: InitDeps = {
    env: fx.env,
    prompter: prompter([SUITE_URL, RUNTIME_ID, TOKEN, ""]),
    store,
    platform: "linux",
    isTTY: false,
    cwd: fx.root,
    out: (l) => void lines.push(l),
    run: (argv, opts) => spawnWithSecrets(argv, store, { ...opts, env: fx.env }),
  };

  // Precondition, asserted rather than assumed: claude really is unfindable.
  expect(existsSync(resolve(fx.bin, "claude"))).toBe(false);

  const result = await runInit(deps);

  expect(result.exitCode).toBe(0);
  // No Claude-only step ran: no clone of the channel plugin, no CLAUDE.md.
  expect(fx.log().some((l) => l.startsWith("git\tclone"))).toBe(false);
  expect(existsSync(resolve(fx.root, "CLAUDE.md"))).toBe(false);
  // The install connection WAS saved.
  expect(existsSync(result.configPath)).toBe(true);
});
